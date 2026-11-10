//! 后台迁移（docs/design/server-slim.md 11.4）。
//!
//! **`backfill-asset-check-v1`**：给没有当前版本核对记录的旧资源补上 `metadata.check`。范围是
//! `metadata.kind` 为 `scan`、`web_model`、`model`、`texture` 的资源；用与上传核对相同的检查器流式读
//! 一遍（也核对 sha256），按条件写核对记录；检查不过就写 `metadata.checkError = {v, reason}` 并记日志
//! （这些资源不能再被新引用，已有提交不受影响）。核对记录只取决于内容，所以这里不按上限判断
//! （引用时按当前配置判断）。
//!
//! `migrations` 集合里的迁移记录同时是锁（带租约），进度游标（按文件名，即内容哈希）也存在里面，
//! 可重入：中途停止后从游标继续。每批限量、批与批之间让出，不阻塞请求。完成后写 `finishedAt`，
//! 以后启动时直接跳过。

use std::time::Duration;

use metaverse_core::model::UploadFormat;
use metaverse_core::scope::UploadPurpose;
use metaverse_core::Timestamp;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::verify::{inspect, sniff_format, InspectError, Inspector, Reject};
use super::{Runner, RunnerConfig};
use crate::repo::{AssetMeta, ChunkSource, RepoError};
use crate::AppState;

/// 迁移的名字（也是迁移记录和锁的编号）。
pub const BACKFILL_CHECK: &str = "backfill-asset-check-v1";
/// 每批多少个资源。
pub const BACKFILL_BATCH: i64 = 20;
/// 锁的租约（秒）。
const LOCK_SECONDS: i64 = 15 * 60;

/// 一批的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackfillStep {
    /// 别的副本持有锁。
    Skipped,
    /// 处理了一批：补上了几个、记了几个检查失败。
    Progress {
        checked: u64,
        failed: u64,
    },
    Finished,
}

/// 旧资源的种类对应的检查用途。
fn purpose_of(kind: Option<&str>) -> Option<UploadPurpose> {
    match kind? {
        "scan" => Some(UploadPurpose::Scan),
        "web_model" => Some(UploadPurpose::WebModel),
        "model" => Some(UploadPurpose::Model),
        "texture" => Some(UploadPurpose::Texture),
        _ => None,
    }
}

/// 给一个旧资源算核对记录：`Ok(Ok(check))` 补上，`Ok(Err(reason))` 检查不过，`Err` 数据库出错。
async fn inspect_asset(
    runner: &Runner,
    meta: &AssetMeta,
) -> Result<Result<metaverse_core::check::AssetCheck, Reject>, RepoError> {
    let repo = &runner.state.repo;
    let Some(purpose) = purpose_of(meta.kind.as_deref()) else {
        return Ok(Err(Reject::new("declared", "资源的种类不在补核对的范围内")));
    };
    let source = ChunkSource::Asset(meta);
    let head = repo.read_chunks(&source, 0, 1).await?;
    let format = head
        .first()
        .and_then(|(_, data)| sniff_format(data))
        .unwrap_or(UploadFormat::Json);
    let outcome = inspect(repo, &source, meta.length, format, |tail| {
        Inspector::new(purpose, format, meta.length, tail)
    })
    .await;
    Ok(match outcome {
        Ok(inspected) if inspected.sha256 == meta.hash => Ok(inspected.check),
        Ok(_) => Err(Reject::new("hash_mismatch", "资源内容与哈希不符")),
        Err(InspectError::Rejected(reject)) => Err(reject),
        Err(InspectError::Repo(error)) => return Err(error),
    })
}

/// 做一批（`owner` 是锁的持有者）。
pub async fn backfill_batch(
    runner: &Runner,
    owner: &str,
    now: Timestamp,
) -> Result<BackfillStep, RepoError> {
    let repo = &runner.state.repo;
    let background = runner.state.authorizer.background("migration");
    let until = now.saturating_add_seconds(LOCK_SECONDS);
    if !repo
        .try_lock(&background, BACKFILL_CHECK, owner, now, until)
        .await?
    {
        return Ok(BackfillStep::Skipped);
    }
    let (cursor, finished) = repo
        .migration_state(&background, BACKFILL_CHECK)
        .await?
        .unwrap_or((None, false));
    if finished {
        return Ok(BackfillStep::Finished);
    }
    let batch = repo
        .assets_without_check(&background, cursor.as_deref(), BACKFILL_BATCH)
        .await?;
    if batch.is_empty() {
        repo.migration_progress(&background, BACKFILL_CHECK, owner, None, Some(now))
            .await?;
        tracing::info!(migration = BACKFILL_CHECK, "后台迁移完成");
        return Ok(BackfillStep::Finished);
    }
    let (mut checked, mut failed) = (0, 0);
    for meta in &batch {
        match inspect_asset(runner, meta).await? {
            Ok(check) => {
                repo.set_asset_check(&background, &meta.hash, &check)
                    .await?;
                checked += 1;
            }
            Err(reject) => {
                tracing::warn!(
                    migration = BACKFILL_CHECK,
                    asset = %meta.hash,
                    kind = ?meta.kind,
                    code = reject.code,
                    reason = %reject.message,
                    "旧资源检查不过，不能再被新引用"
                );
                repo.set_asset_check_error(&background, &meta.hash, &reject.to_string())
                    .await?;
                failed += 1;
            }
        }
        // 每个资源做完就推进游标：中途停止后从这里继续。锁丢了就停（别的副本接着做）。
        if !repo
            .migration_progress(&background, BACKFILL_CHECK, owner, Some(&meta.hash), None)
            .await?
        {
            return Ok(BackfillStep::Skipped);
        }
    }
    Ok(BackfillStep::Progress { checked, failed })
}

/// 后台迁移的常驻循环：索引建好以后开始，做完就退出。
pub fn spawn(
    state: AppState,
    config: RunnerConfig,
    shutdown: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while !state.is_ready() {
            if *shutdown.borrow() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let owner = config.instance_id.clone();
        let runner = Runner::new(state, config);
        loop {
            if *shutdown.borrow() {
                return;
            }
            let pause = match crate::now() {
                Ok(now) => match backfill_batch(&runner, &owner, now).await {
                    Ok(BackfillStep::Finished) => return,
                    Ok(BackfillStep::Progress { checked, failed }) => {
                        tracing::info!(
                            migration = BACKFILL_CHECK,
                            checked,
                            failed,
                            "后台迁移做完一批"
                        );
                        Duration::from_secs(1)
                    }
                    Ok(BackfillStep::Skipped) => Duration::from_secs(60),
                    Err(error) => {
                        tracing::warn!(migration = BACKFILL_CHECK, error = %error, "后台迁移出错，稍后再试");
                        Duration::from_secs(30)
                    }
                },
                Err(_) => Duration::from_secs(30),
            };
            let mut receiver = shutdown.clone();
            tokio::select! {
                () = tokio::time::sleep(pause) => {}
                changed = receiver.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
            }
        }
    })
}
