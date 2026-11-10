//! 交包任务（docs/design/server-slim.md 2.6）：种类沿用 `ops_from_upload`，参数
//! `{draftId, source: "bundle", manifestHash}`，范围 `rebuild`，占重任务名额。
//!
//! 1. 读草稿：必须是 `open`、范围 `rebuild`。`opsRefs` 里已有本任务的编号 → 已经做过，直接标记完成；
//!    草稿已经有 `bundleRef`、但不是本任务写的（两个交包请求并发时可能出现）→ 失败
//!    （`content`，`bundle_already_applied`）；
//! 2. 展开、校验、作用（`timeline::bundle_apply`）；
//! 3. 写回：一个多文档事务里按 `{_id, rev, status: open}` 更新草稿，同时按租约栅栏把任务标记完成。
//!    中止后重读草稿：已经有本任务的编号 → 按完成处理；草稿已发布或已丢弃 → 失败（`content`）；
//!    其他情况 → 退回队列（`transient`）。

use std::sync::Arc;

use metaverse_core::scope::PathScope;

use super::{JobFailure, Lease, Runner};
use crate::repo::{JobDraftSave, JobStep};
use crate::timeline::bundle_apply::apply_bundle;
use crate::timeline::state::ApplyError;

fn apply_failure(error: ApplyError) -> JobFailure {
    match error {
        ApplyError::Op(error) => JobFailure::Content(error.to_string()),
        ApplyError::Api(error) => error.into(),
    }
}

pub async fn run(
    runner: &Arc<Runner>,
    lease: &Lease,
    draft_id: &str,
    manifest_hash: &str,
) -> Result<(), JobFailure> {
    let job = &lease.job;
    let fence = &lease.fence;
    if job.scope.as_ref() != Some(&PathScope::Rebuild) {
        return Err(JobFailure::Content("交包任务只能由重建路径发起".to_owned()));
    }
    let grant = runner.space_grant(job, "bundle_apply").await?;
    let repo = &runner.state.repo;
    if !repo.space_instance_exists(&grant, job.created_at).await? {
        return Err(JobFailure::Content("任务所在的空间已经删除".to_owned()));
    }
    let Some(draft) = super::ops_job::load_draft(runner, &grant, draft_id, fence).await? else {
        // 已经做过（草稿的 opsRefs 里有本任务）。
        return Ok(());
    };
    if draft.scope != PathScope::Rebuild {
        return Err(JobFailure::Content("草稿不是重建草稿".to_owned()));
    }
    if draft.bundle_ref.is_some() || !draft.ops_refs.is_empty() {
        return Err(JobFailure::Content(
            "bundle_already_applied：这个重建草稿已经交过一个重建包".to_owned(),
        ));
    }
    let limits = runner.state.ingest.config.upload_limits();
    let now = crate::now().map_err(|_| JobFailure::Transient("取不到当前时间".to_owned()))?;
    let applied = apply_bundle(repo, &grant, draft, manifest_hash, &job.id, &limits, now)
        .await
        .map_err(apply_failure)?;
    match repo
        .save_draft_for_job(
            &grant,
            &applied.prepared.draft,
            applied.prepared.expected_rev,
            fence,
            JobStep::Done(&applied.result),
            now,
        )
        .await?
    {
        JobDraftSave::Saved => {
            tracing::info!(
                space = %job.space_id, draft = %draft_id, job = %job.id,
                manifest = %manifest_hash, ops = applied.prepared.draft.op_count(),
                "重建包已展开进草稿"
            );
            Ok(())
        }
        JobDraftSave::LeaseLost => Err(JobFailure::LeaseLost),
        JobDraftSave::DraftChanged => {
            match super::ops_job::load_draft(runner, &grant, draft_id, fence).await? {
                None => Ok(()),
                Some(_) => Err(JobFailure::Transient(
                    "草稿在处理期间被修改，退回队列在新的草稿上重做".to_owned(),
                )),
            }
        }
    }
}
