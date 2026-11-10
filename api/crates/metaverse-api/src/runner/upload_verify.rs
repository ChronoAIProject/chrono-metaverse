//! `upload_verify`：上传完成后的整体核对（docs/design/server-slim.md 4.3）。参数 `{uploadId}`。
//!
//! 1. 上传已是 `done`：直接完成；不是 `complete`：失败；空间实例对不上：上传 `failed`、任务失败；
//! 2. 之前已经登记过（`files._id` = 上传编号）：补做收尾；上次已核对通过、登记时撞名删掉了本次的
//!    数据块：刷新已有资源后补做收尾；
//! 3. 只对 zip：先读文件末尾、解析中央目录；从头按序号流式读出全部数据块，核对序号连续、块大小、
//!    总长度，边读边算 sha256，同时交给这个用途的检查器（`verify/`）；
//! 4. 哈希不符或检查不通过：一个事务里上传 `failed`（写原因）、任务失败，再删数据块；
//! 5. 登记资源（`metadata.check` 记核对结果；同一内容已存在就复用、必要时补写核对记录）；
//! 6. 一个事务里：上传 `done` 并写 `assetHash`、`format`、`storageBytes`，空间 `storageUsedBytes` 加上
//!    大小，任务完成（带租约条件）。
//!
//! 每一步都可以重做：租约丢了、进程退出后重新领取的任务按上面的判断从中间接着做。任务最终失败、
//! 上传停在 `complete` 时由 [`settle_after_failure`] 收尾，定期清理第 1 步兜底。

use std::sync::Arc;

use metaverse_core::model::{ErrorClass, Job, JobError, Upload, UploadStatus};
use metaverse_core::{is_sha256_hex, Timestamp};
use serde_json::{json, Value};

use super::verify::{inspect, within_limits, InspectError, Inspector, Reject};
use super::{JobFailure, Lease, Runner};
use crate::auth::Grant;
use crate::repo::{ChunkSource, JobFence, JobStep, Registered, VerifyFinish};

fn upload_id(job: &Job) -> Result<&str, JobFailure> {
    job.params
        .get("uploadId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .ok_or_else(|| JobFailure::Content("参数 uploadId 必须是非空字符串".to_owned()))
}

fn now() -> Result<Timestamp, JobFailure> {
    crate::now().map_err(|_| JobFailure::Transient("取不到当前时间".to_owned()))
}

fn result_of(upload: &Upload, reused: bool, format: Option<&str>) -> Value {
    let mut result = json!({"assetHash": upload.sha256, "reused": reused, "bytes": upload.size});
    if let Some(format) = format {
        result["format"] = json!(format);
    }
    result
}

/// 核对完以后任务这一边做什么。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    /// `upload_verify` 任务：核对完就完成任务。
    CompleteJob,
    /// 别的任务在自己的执行过程中核对（部署种子下载的文件）：只核对租约还在，任务接着做。
    CheckLease,
}

pub async fn run(runner: &Arc<Runner>, lease: &Lease) -> Result<(), JobFailure> {
    let job = &lease.job;
    let upload_id = upload_id(job)?;
    let grant = runner.space_grant(job, "upload_verify").await?;
    let upload = runner
        .state
        .repo
        .upload(&grant, upload_id)
        .await?
        .ok_or_else(|| JobFailure::Content(format!("上传 {upload_id} 不存在，或不属于这个空间")))?;
    verify(
        runner,
        &grant,
        &upload,
        &lease.fence,
        Mode::CompleteJob,
        None,
    )
    .await
}

/// 核对一个上传并登记成资源（4.3 第 1–6 步）。`context` 加在失败说明前面（例如清单里的文件路径）。
/// 内容不合格时上传标记 `failed`、任务标记失败（同一个事务），返回 [`JobFailure::Recorded`]。
pub(crate) async fn verify(
    runner: &Arc<Runner>,
    grant: &Grant,
    upload: &Upload,
    fence: &JobFence,
    mode: Mode,
    context: Option<&str>,
) -> Result<(), JobFailure> {
    let repo = &runner.state.repo;
    let upload_id = upload.id.as_str();
    let step = Step {
        fence,
        mode,
        context,
    };
    match upload.status {
        UploadStatus::Done => {
            let result = result_of(upload, true, upload.format.as_deref());
            return acknowledge(runner, &step, &result).await;
        }
        UploadStatus::Complete => {}
        other => {
            return Err(JobFailure::Content(format!(
                "上传 {upload_id} 的状态是 {other:?}，不能核对"
            )))
        }
    }
    // 上传所在的空间实例不在了（被删除，或删除后用同一个编号重建）：不登记、不计用量。
    if !repo.space_instance_exists(grant, upload.created_at).await? {
        return reject(
            runner,
            grant,
            upload,
            &step,
            &Reject::new("space_gone", "上传所在的空间已经删除"),
        )
        .await;
    }
    // 之前已经登记过这一份（重做的任务）：补做收尾。
    if let Some(meta) = repo.asset_registered_by_upload(grant, &upload.id).await? {
        let check = meta.check.clone();
        return finish(runner, grant, upload, &step, check.as_ref(), false).await;
    }
    // 上次已核对通过、登记时发现重名并删掉了本次的数据块：刷新已有资源后补做收尾。刷新不到说明它
    // 刚被清理删掉，本次的数据块也没了，只能让调用方重新上传。
    if upload.verified_sha256.as_deref() == Some(upload.sha256.as_str())
        && !repo.upload_has_chunks(grant, &upload.id).await?
    {
        if !repo.touch_asset(grant, &upload.sha256).await? {
            return reject(
                runner,
                grant,
                upload,
                &step,
                &Reject::new(
                    "asset_gone",
                    "内容相同的已有资源刚被清理，本次的数据也已删除，请重新上传",
                ),
            )
            .await;
        }
        let meta = repo.asset_meta_for_runner(grant, &upload.sha256).await?;
        let check = meta.and_then(|meta| meta.check);
        return finish(runner, grant, upload, &step, check.as_ref(), true).await;
    }

    // 声明的哈希、大小、用途。
    let limits = runner.state.ingest.config.upload_limits();
    let max = runner.state.ingest.config.max_bytes(upload.purpose);
    if !is_sha256_hex(&upload.sha256) || upload.size == 0 || upload.size > max {
        return reject(
            runner,
            grant,
            upload,
            &step,
            &Reject::new(
                "declared",
                format!(
                    "上传记录里声明的哈希或大小不合法（{} 用途最大 {max} 字节）",
                    upload.purpose.name()
                ),
            ),
        )
        .await;
    }

    // 流式读出、核对。
    let source = ChunkSource::Upload { grant, upload };
    let inspected = inspect(repo, &source, upload.size, upload.declared_format, |tail| {
        Inspector::new(upload.purpose, upload.declared_format, upload.size, tail)
    })
    .await;
    let inspected = match inspected {
        Ok(inspected) => inspected,
        Err(InspectError::Rejected(rejected)) => {
            return reject(runner, grant, upload, &step, &rejected).await
        }
        Err(InspectError::Repo(error)) => return Err(error.into()),
    };
    if inspected.sha256 != upload.sha256 {
        let rejected = Reject::new(
            "hash_mismatch",
            format!(
                "整体哈希不符：声明 {}，实际 {}",
                upload.sha256, inspected.sha256
            ),
        );
        return reject(runner, grant, upload, &step, &rejected).await;
    }
    if let Err(rejected) = within_limits(upload.purpose, &inspected.check, &limits) {
        return reject(runner, grant, upload, &step, &rejected).await;
    }

    // 记下"内容已核对通过"，再登记资源。
    if !repo
        .mark_upload_verified(grant, upload, fence, now()?)
        .await?
    {
        return Err(JobFailure::LeaseLost);
    }
    let registered = repo
        .register_upload_asset(grant, upload, &inspected.check)
        .await?;
    finish(
        runner,
        grant,
        upload,
        &step,
        Some(&inspected.check),
        registered == Registered::Reused,
    )
    .await
}

/// 核对时任务这一边的上下文：栅栏、核对完做什么、失败说明的前缀。
struct Step<'a> {
    fence: &'a JobFence,
    mode: Mode,
    context: Option<&'a str>,
}

impl Step<'_> {
    /// 任务这一边写什么：完成任务，或只核对租约（顺带写进度）。
    fn job<'v>(&self, result: &'v Value, progress: &'v Value) -> JobStep<'v> {
        match self.mode {
            Mode::CompleteJob => JobStep::Done(result),
            Mode::CheckLease => JobStep::Progress(progress),
        }
    }

    fn describe(&self, rejected: &Reject) -> String {
        match self.context {
            Some(context) => format!("{context}：{rejected}"),
            None => rejected.to_string(),
        }
    }
}

fn progress_of(upload: &Upload) -> Value {
    json!({"stage": "verified", "uploadId": upload.id, "assetHash": upload.sha256})
}

/// 事务收尾：上传 `done`、计入用量、任务完成（或只核对租约）。
async fn finish(
    runner: &Arc<Runner>,
    grant: &Grant,
    upload: &Upload,
    step: &Step<'_>,
    check: Option<&metaverse_core::check::AssetCheck>,
    reused: bool,
) -> Result<(), JobFailure> {
    let repo = &runner.state.repo;
    let format = check.map(|check| check.body.format());
    let result = result_of(upload, reused, format);
    let progress = progress_of(upload);
    let outcome = repo
        .finish_verified_upload(
            grant,
            upload,
            check,
            upload.size,
            Some((step.fence, step.job(&result, &progress))),
            now()?,
        )
        .await?;
    match outcome {
        VerifyFinish::Done => {
            tracing::info!(
                space = %upload.space_id,
                upload = %upload.id,
                asset = %upload.sha256,
                reused,
                "上传核对通过"
            );
            Ok(())
        }
        VerifyFinish::LeaseLost => Err(JobFailure::LeaseLost),
        VerifyFinish::SpaceGone => {
            reject(
                runner,
                grant,
                upload,
                step,
                &Reject::new("space_gone", "上传所在的空间已经删除"),
            )
            .await
        }
        VerifyFinish::NotComplete => {
            // 别人已经收尾（重做时）：上传已是 done 就按完成处理。
            match repo.upload(grant, &upload.id).await? {
                Some(current) if current.status == UploadStatus::Done => {
                    acknowledge(runner, step, &result).await
                }
                _ => Err(JobFailure::Content("上传已经不是待核对的状态".to_owned())),
            }
        }
    }
}

/// 上传已经核对完（重做时发现）：`upload_verify` 完成任务；别的任务只核对租约还在。
async fn acknowledge(
    runner: &Arc<Runner>,
    step: &Step<'_>,
    result: &Value,
) -> Result<(), JobFailure> {
    let repo = &runner.state.repo;
    let held = match step.mode {
        Mode::CompleteJob => {
            repo.complete_job(&runner.background, step.fence, result, now()?)
                .await?
        }
        Mode::CheckLease => {
            repo.job_progress(&runner.background, step.fence, result)
                .await?
        }
    };
    if held {
        Ok(())
    } else {
        Err(JobFailure::LeaseLost)
    }
}

/// 内容不合格：一个事务里上传 `failed`、任务失败（不重试），再删数据块。
async fn reject(
    runner: &Arc<Runner>,
    grant: &Grant,
    upload: &Upload,
    step: &Step<'_>,
    rejected: &Reject,
) -> Result<(), JobFailure> {
    let repo = &runner.state.repo;
    let now = now()?;
    let message = step.describe(rejected);
    let error = JobError::Detail {
        class: ErrorClass::Content,
        message: message.clone(),
        at: now,
    };
    if !repo
        .fail_verified_upload(grant, &upload.id, &message, Some((step.fence, &error)), now)
        .await?
    {
        return Err(JobFailure::LeaseLost);
    }
    let removed = repo.delete_upload_chunks(grant, &upload.id).await?;
    tracing::warn!(
        space = %upload.space_id,
        upload = %upload.id,
        code = rejected.code,
        removed,
        reason = %rejected.message,
        "上传核对不通过"
    );
    Err(JobFailure::Recorded)
}

/// 任务最终失败（重试用完、反复出错）以后，让还停在 `complete` 的上传离开这个状态：内容已核对通过、
/// 资源也还在就补做完成（不带任务栅栏，任务已经失败），否则标记 `failed` 并删数据块。返回上传的
/// 新状态；上传不存在或已经不是 `complete` 时为空。
pub async fn settle_upload(
    runner: &Runner,
    grant: &Grant,
    upload_id: &str,
    reason: &str,
) -> Result<Option<UploadStatus>, JobFailure> {
    let repo = &runner.state.repo;
    let Some(upload) = repo.upload(grant, upload_id).await? else {
        return Ok(None);
    };
    if upload.status != UploadStatus::Complete {
        return Ok(None);
    }
    let now = now()?;
    let verified = upload.verified_sha256.as_deref() == Some(upload.sha256.as_str());
    if verified && repo.touch_asset(grant, &upload.sha256).await? {
        let meta = repo.asset_meta_for_runner(grant, &upload.sha256).await?;
        if let Some(meta) = meta {
            // 资源不是本次登记的：删掉本次的数据块，复用已有资源。
            let ours = meta.files_id_is(&upload.id);
            if !ours {
                repo.delete_upload_chunks(grant, &upload.id).await?;
            }
            let check = meta.check.clone();
            match repo
                .finish_verified_upload(grant, &upload, check.as_ref(), meta.length, None, now)
                .await?
            {
                VerifyFinish::Done => {
                    tracing::info!(upload = %upload.id, "核对任务失败后补做收尾：内容已登记成资源");
                    return Ok(Some(UploadStatus::Done));
                }
                VerifyFinish::SpaceGone => {}
                _ => return Ok(None),
            }
        }
    }
    if repo
        .fail_verified_upload(grant, &upload.id, reason, None, now)
        .await?
    {
        let removed = repo.delete_upload_chunks(grant, &upload.id).await?;
        tracing::warn!(upload = %upload.id, removed, reason, "上传标记为失败");
        return Ok(Some(UploadStatus::Failed));
    }
    Ok(None)
}

/// 执行器标记 `upload_verify` 最终失败以后调用。
pub(super) async fn settle_after_failure(
    runner: &Runner,
    job: &Job,
    message: &str,
) -> Result<(), JobFailure> {
    let upload_id = upload_id(job)?;
    let grant = runner.space_grant(job, "upload_verify").await?;
    settle_upload(
        runner,
        &grant,
        upload_id,
        &format!("核对任务失败：{message}"),
    )
    .await?;
    Ok(())
}
