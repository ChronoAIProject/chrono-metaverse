//! `ops_from_upload` 进执行器（docs/design/server-slim.md 4.10）。参数 `{draftId, assetHash, uploadId?}`。
//!
//! 请求只插入 `queued` 的任务并通知执行器；执行器按重任务名额领取后：
//!
//! 1. 读草稿：`opsRefs` 里已有本任务的编号 → 已经做过，直接标记完成；草稿已发布、已丢弃 → 失败；
//! 2. 按序号流式读出操作文件，在阻塞线程池里边解压边逐行解析成操作（不留压缩原文和解压后的全文），
//!    每批解析出的操作马上作用到草稿的工作状态上（`timeline::drafts::AppendSession`，规则与内联追加
//!    相同），不把全部操作同时留在内存里；最后核对整份文件的哈希；
//! 3. 一个事务里按 `rev` 条件保存草稿（`opsRefs` 记 `jobId`），同时按租约栅栏把任务标记完成；
//!    任何一个匹配不到就中止。中止后重读草稿：已经有本任务的编号就按完成处理；草稿已发布或已丢弃 →
//!    失败；其他情况（草稿被别人改过）→ 退回队列，在新的草稿状态上重做。

use std::sync::Arc;

use metaverse_core::ops::Op;
use serde_json::{json, Value};

use super::verify::ndjson::{LineSink, NdjsonStream};
use super::verify::{Reject, BATCH_CHUNKS};
use super::{JobFailure, Lease, Runner};
use crate::auth::Grant;
use crate::repo::{AssetMeta, ChunkSource, DraftStatus, JobDraftSave, JobFence};
use crate::timeline::drafts::{
    ops_job_result, AppendSession, OpsSource, MAX_DRAFT_OPS, MAX_OPS_FILE_BYTES,
};
use crate::timeline::state::ApplyError;

/// 把每一行解析成操作（调用方每批取走 `ops`，`parsed` 是累计的条数）。
struct OpsCollector {
    ops: Vec<Op>,
    parsed: u64,
    max: u64,
}

impl LineSink for OpsCollector {
    fn line(&mut self, number: usize, text: &str) -> Result<(), Reject> {
        if self.parsed >= self.max {
            return Err(Reject::new(
                "too_many_ops",
                format!("一个草稿最多 {} 条操作", self.max),
            ));
        }
        let op: Op = serde_json::from_str(text).map_err(|error| {
            Reject::new(
                "invalid_op",
                format!("第 {number} 行不是合法的操作：{error}"),
            )
        })?;
        self.ops.push(op);
        self.parsed += 1;
        Ok(())
    }
}

/// 作用操作时出的错：操作不合规、越界是内容问题；接口层的错误按状态码分（5xx 是暂时性的）。
fn apply_failure(error: ApplyError) -> JobFailure {
    match error {
        ApplyError::Op(error) => JobFailure::Content(error.to_string()),
        ApplyError::Api(error) => error.into(),
    }
}

/// 按序号流式读出操作文件，在阻塞线程池里边解压边逐行解析；每批（约 4 MiB 原文）解析出的操作
/// 马上作用到草稿的工作状态上，不把全部操作同时留在内存里（docs/design/server-slim.md 4.8）。
/// 最后核对整份文件的哈希。返回作用了多少条。
async fn apply_file(
    runner: &Runner,
    grant: &Grant,
    meta: &AssetMeta,
    session: &mut AppendSession,
    fence: &JobFence,
    max_ops: u64,
) -> Result<u64, JobFailure> {
    let repo = &runner.state.repo;
    let source = ChunkSource::Asset(meta);
    let count = meta.length.div_ceil(meta.chunk_size.max(1));
    let mut stream = NdjsonStream::new(
        None,
        OpsCollector {
            ops: Vec::new(),
            parsed: 0,
            max: max_ops,
        },
    );
    let mut next = 0u64;
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    // 已经读出、算过哈希、还没喂给解析器的原文（最多一批，4 MiB）。
    let mut pending: Vec<u8> = Vec::new();
    while next < count || !pending.is_empty() {
        if pending.is_empty() {
            let batch = repo.read_chunks(&source, next, BATCH_CHUNKS).await?;
            if batch.is_empty() {
                return Err(JobFailure::Content("操作文件的数据不完整".to_owned()));
            }
            for (n, data) in batch {
                if n != next {
                    return Err(JobFailure::Content("操作文件的数据块不连续".to_owned()));
                }
                next += 1;
                sha2::Digest::update(&mut hasher, &data);
                pending.extend_from_slice(&data);
            }
        }
        // 每次喂 16 KiB 原文（解压后最多约 16 MiB），攒够一批操作就停下来先作用：压缩率再高，
        // 内存里也只有一批解析出的操作。
        let (back, rest, outcome, ops) = tokio::task::spawn_blocking(move || {
            let mut stream = stream;
            let mut fed = 0;
            let mut outcome = Ok(());
            while fed < pending.len() && stream.sink_mut().ops.len() < OPS_BATCH {
                let end = (fed + FEED_BYTES).min(pending.len());
                outcome = stream.feed(&pending[fed..end]);
                fed = end;
                if outcome.is_err() {
                    break;
                }
            }
            pending.drain(..fed);
            let ops = std::mem::take(&mut stream.sink_mut().ops);
            (stream, pending, outcome, ops)
        })
        .await
        .map_err(|_| JobFailure::Transient("解析操作文件的线程异常退出".to_owned()))?;
        stream = back;
        pending = rest;
        outcome.map_err(|reject| JobFailure::Content(reject.message))?;
        if !ops.is_empty() {
            session
                .apply(repo, grant, ops)
                .await
                .map_err(apply_failure)?;
            let progress = json!({"opsApplied": session.applied()});
            if !repo
                .job_progress(&runner.background, fence, &progress)
                .await?
            {
                return Err(JobFailure::LeaseLost);
            }
        }
    }
    if metaverse_core::to_hex(&sha2::Digest::finalize(hasher)) != meta.hash {
        return Err(JobFailure::Content("操作文件的内容与哈希不符".to_owned()));
    }
    let collector = tokio::task::spawn_blocking(move || stream.finish())
        .await
        .map_err(|_| JobFailure::Transient("解析操作文件的线程异常退出".to_owned()))?
        .map_err(|reject| JobFailure::Content(reject.message))?;
    if !collector.ops.is_empty() {
        session
            .apply(repo, grant, collector.ops)
            .await
            .map_err(apply_failure)?;
    }
    Ok(session.applied())
}

/// 每批最多作用多少条操作。
const OPS_BATCH: usize = 2000;
/// 每次喂给解析器多少字节原文。
const FEED_BYTES: usize = 16 * 1024;

fn param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
}

pub async fn run(runner: &Arc<Runner>, lease: &Lease) -> Result<(), JobFailure> {
    let job = &lease.job;
    let fence = &lease.fence;
    let (Some(draft_id), Some(asset_hash)) = (
        param(&job.params, "draftId"),
        param(&job.params, "assetHash"),
    ) else {
        return Err(JobFailure::Content(
            "参数必须有 draftId 和 assetHash".to_owned(),
        ));
    };
    let grant = runner.space_grant(job, "ops_from_upload").await?;
    let repo = &runner.state.repo;
    if !repo.space_instance_exists(&grant, job.created_at).await? {
        return Err(JobFailure::Content("任务所在的空间已经删除".to_owned()));
    }
    let draft = load_draft(runner, &grant, draft_id, fence).await?;
    let Some(draft) = draft else {
        // 已经做过（草稿的 opsRefs 里有本任务）。
        return Ok(());
    };
    let meta = repo
        .asset_meta_for_runner(&grant, asset_hash)
        .await?
        .ok_or_else(|| JobFailure::Content("操作文件不存在（可能已被清理）".to_owned()))?;
    if meta.length > MAX_OPS_FILE_BYTES {
        return Err(JobFailure::Content(format!(
            "操作文件 {} 字节，超过上限 {MAX_OPS_FILE_BYTES} 字节",
            meta.length
        )));
    }
    let source = OpsSource::Upload {
        asset_hash: asset_hash.to_owned(),
        job_id: job.id.clone(),
    };
    let room = MAX_DRAFT_OPS.saturating_sub(draft.op_count());
    let mut session = AppendSession::begin(repo, &grant, draft, &source)
        .await
        .map_err(apply_failure)?;
    let total = apply_file(runner, &grant, &meta, &mut session, fence, room.max(1)).await? as usize;
    let now = crate::now().map_err(|_| JobFailure::Transient("取不到当前时间".to_owned()))?;
    let prepared = session
        .finish(repo, &grant, source, now)
        .await
        .map_err(apply_failure)?;
    let result = ops_job_result(&prepared.draft, total);
    if !repo
        .job_progress(
            &runner.background,
            fence,
            &json!({"opsApplied": total, "opsTotal": total}),
        )
        .await?
    {
        return Err(JobFailure::LeaseLost);
    }
    match repo
        .save_draft_for_job(
            &grant,
            &prepared.draft,
            prepared.expected_rev,
            fence,
            &result,
            now,
        )
        .await?
    {
        JobDraftSave::Saved => {
            tracing::info!(space = %job.space_id, draft = %draft_id, job = %job.id, ops = total, "ops_from_upload 已写进草稿");
            Ok(())
        }
        JobDraftSave::LeaseLost => Err(JobFailure::LeaseLost),
        JobDraftSave::DraftChanged => match load_draft(runner, &grant, draft_id, fence).await? {
            None => Ok(()),
            Some(_) => Err(JobFailure::Transient(
                "草稿在处理期间被修改，退回队列在新的草稿上重做".to_owned(),
            )),
        },
    }
}

/// 读草稿。`Ok(None)`：草稿的 `opsRefs` 里已经有本任务（已经做过，任务已按栅栏标记完成）。
async fn load_draft(
    runner: &Arc<Runner>,
    grant: &Grant,
    draft_id: &str,
    fence: &JobFence,
) -> Result<Option<crate::repo::DraftDoc>, JobFailure> {
    let job_id = fence.job_id.as_str();
    let repo = &runner.state.repo;
    let draft = repo
        .draft(grant, draft_id)
        .await?
        .ok_or_else(|| JobFailure::Content("草稿不存在（已丢弃或已过期）".to_owned()))?;
    if draft
        .ops_refs
        .iter()
        .any(|reference| reference.job_id.as_deref() == Some(job_id))
    {
        let count = draft
            .ops_refs
            .iter()
            .find(|reference| reference.job_id.as_deref() == Some(job_id))
            .map_or(0, |reference| reference.count as usize);
        let now = crate::now().map_err(|_| JobFailure::Transient("取不到当前时间".to_owned()))?;
        let result = ops_job_result(&draft, count);
        return if repo
            .complete_job(&runner.background, fence, &result, now)
            .await?
        {
            Ok(None)
        } else {
            Err(JobFailure::LeaseLost)
        };
    }
    if draft.status != DraftStatus::Open {
        return Err(JobFailure::Content(
            "草稿已经发布，不能再追加操作".to_owned(),
        ));
    }
    Ok(Some(draft))
}
