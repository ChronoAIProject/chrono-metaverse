//! 过期清理（docs/design/server-slim.md 第 5 节）：接口服务进程里的另一个常驻循环，每
//! `CLEANUP_INTERVAL_SECONDS` 秒一轮，步骤照搬处理服务的 `jobs/cleanup.py`：
//!
//! 0. **任务**：(a) 租约过期且尝试次数用完的标记 `failed`，`upload_verify` 接着收尾上传；
//!    (b) 已下线种类中还在排队或运行的标记 `failed`（每轮都做、幂等，所以回滚期间旧接口新建的
//!    这类任务，升回来以后也会被收掉）；
//! 1. **上传会话**：停在 `complete`、校验任务已失败（或任务记录不存在且完成超过 24 小时）的按
//!    上传核对的规则收尾；`authored` 用途还没完成的标记 `failed`；超过 24 小时仍 `open` 的先改成
//!    `expired`，再和 `failed`、`expired` 的一起删数据块和会话；
//! 2. **草稿、草稿区块、预览令牌**：按 `expiresAt` 删除，每轮最多 200 个草稿；
//! 3. **没人引用的资源**：上传或最近复用超过 `CLEANUP_ASSET_GRACE_DAYS` 天、没被引用的，先删
//!    `files` 文档再删数据块，再把计过的用量成对减回；每轮最多 500 个；
//! 4. **补打区块的 `publishedAt`**：最近 48 小时的提交引用、还没打上的区块按提交的 `at` 补上。
//!
//! **只让一个副本跑**：每轮开始前在 `migrations` 集合里抢锁 `lock:cleanup`（租约 15 分钟），每做完
//! 一步续一次。各步本来就幂等，锁只是避免重复劳动。每轮写一条结构化日志。

use std::time::Duration;

use metaverse_core::model::UPLOAD_TTL_SECONDS;
use metaverse_core::Timestamp;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::upload_verify::settle_upload;
use super::{Runner, RunnerConfig};
use crate::repo::RepoError;
use crate::AppState;

/// 锁的名字。
pub const CLEANUP_LOCK: &str = "lock:cleanup";
/// 锁的租约（秒）。
const LOCK_SECONDS: i64 = 15 * 60;
/// 补打 `publishedAt` 看多久以内的提交（小时）。
const PUBLISH_BACKFILL_HOURS: i64 = 48;
/// 已下线种类的任务的失败说明。
pub const RETIRED_MESSAGE: &str = "处理服务已下线：重建改在本地完成，见 docs/design/server-slim.md";

/// 一轮清理做了什么。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CleanupReport {
    /// 没抢到锁（别的副本在做），这一轮什么都没做。
    pub skipped: bool,
    pub exhausted_jobs: u64,
    pub retired_jobs: u64,
    pub stuck_uploads: u64,
    pub retired_uploads: u64,
    pub uploads: u64,
    pub drafts: u64,
    pub previews: u64,
    pub draft_chunks: u64,
    pub assets: u64,
    pub released: u64,
    pub published_chunks: u64,
}

/// 做一轮清理（`now` 由调用方给，测试可以模拟时间）。`owner` 是锁的持有者（本进程编号）。
pub async fn run_round(
    runner: &Runner,
    owner: &str,
    now: Timestamp,
) -> Result<CleanupReport, RepoError> {
    let repo = &runner.state.repo;
    let background = runner.state.authorizer.background("cleanup");
    let lock = |now: Timestamp| {
        repo.try_lock(
            &background,
            CLEANUP_LOCK,
            owner,
            now,
            now.saturating_add_seconds(LOCK_SECONDS),
        )
    };
    let mut report = CleanupReport::default();
    if !lock(now).await? {
        report.skipped = true;
        return Ok(report);
    }

    // 第 0 步：任务。
    let reaped = repo.reap_exhausted_jobs(&background, now).await?;
    report.exhausted_jobs = reaped.len() as u64;
    for job in &reaped {
        let message = job
            .last_error
            .as_ref()
            .map_or("重试次数已用完", |error| error.message());
        runner.after_final_failure(job, message).await;
    }
    report.retired_jobs = repo.retire_jobs(&background, RETIRED_MESSAGE, now).await?;
    lock(now).await?;

    // 第 1 步：上传会话。
    let cutoff = now.saturating_add_seconds(-UPLOAD_TTL_SECONDS);
    for upload in repo.stuck_uploads(&background, cutoff).await? {
        let grant = match runner
            .state
            .authorizer
            .system_space(&upload.space_id, &upload.owner, "cleanup", &upload.id)
            .await
        {
            Ok(grant) => grant,
            Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => {
                // 空间不在了或主人变了：上传照样不能停在 complete，标记失败、删数据块。
                if repo
                    .fail_orphan_upload(&background, &upload.id, now)
                    .await?
                {
                    tracing::warn!(upload = %upload.id, space = %upload.space_id, "卡住的上传所在的空间已不在，标记失败");
                    report.stuck_uploads += 1;
                }
                continue;
            }
            Err(error) => {
                tracing::warn!(upload = %upload.id, error = %error.detail, "签发系统范围失败，下一轮再试");
                continue;
            }
        };
        let reason = "校验任务失败或不存在";
        match settle_upload(runner, &grant, &upload.id, reason).await {
            Ok(Some(_)) => report.stuck_uploads += 1,
            Ok(None) => {}
            Err(error) => tracing::warn!(upload = %upload.id, error = ?error, "收尾卡住的上传失败"),
        }
    }
    report.retired_uploads = repo.fail_retired_uploads(&background, now).await?;
    report.uploads = repo.remove_dead_uploads(&background, cutoff).await?;
    lock(now).await?;

    // 第 2 步：草稿。
    let (drafts, previews, chunks) = repo.remove_expired_drafts(&background, now).await?;
    report.drafts = drafts;
    report.previews = previews;
    report.draft_chunks = chunks;
    lock(now).await?;

    // 第 3 步：没人引用的资源。
    let grace = runner.config.asset_grace_days as i64 * 24 * 3600;
    let asset_cutoff = now.saturating_add_seconds(-grace);
    let candidates = repo.stale_assets(&background, asset_cutoff).await?;
    if !candidates.is_empty() {
        let pending = repo.pending_job_strings(&background).await?;
        for hash in candidates {
            if repo
                .asset_referenced(&background, &hash, &pending, now)
                .await?
            {
                continue;
            }
            // 条件删除：期间被复用（touchedAt 更新）就不删。查引用和删除之间没有锁，这是唯一的栅栏：
            // 引用已有资源的一方必须先刷新 touchedAt 并确认匹配到。
            if repo
                .delete_stale_asset(&background, &hash, asset_cutoff)
                .await?
            {
                report.assets += 1;
                report.released += repo.release_asset_storage(&background, &hash, now).await?;
                tracing::info!(asset = %hash, "清理了没人引用的资源");
            }
        }
    }
    lock(now).await?;

    // 第 4 步：补打 publishedAt。
    let since = now.saturating_add_seconds(-PUBLISH_BACKFILL_HOURS * 3600);
    report.published_chunks = repo.backfill_published_chunks(&background, since).await?;
    Ok(report)
}

/// 定期清理的常驻循环：索引建好以后先做一轮，之后每 `CLEANUP_INTERVAL_SECONDS` 秒一轮。
pub fn spawn(
    state: AppState,
    config: RunnerConfig,
    mut shutdown: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while !state.is_ready() {
            if *shutdown.borrow() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let interval = Duration::from_secs(config.cleanup_interval_seconds);
        let owner = config.instance_id.clone();
        let runner = Runner::new(state, config);
        loop {
            if *shutdown.borrow() {
                return;
            }
            let started = std::time::Instant::now();
            match crate::now() {
                Ok(now) => match run_round(&runner, &owner, now).await {
                    Ok(report) if report.skipped => {
                        tracing::debug!("别的副本正在清理，这一轮跳过")
                    }
                    Ok(report) => tracing::info!(
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        report = ?report,
                        "定期清理完成一轮"
                    ),
                    Err(error) => tracing::warn!(error = %error, "定期清理这一轮出错，下一轮再试"),
                },
                Err(_) => tracing::warn!("取不到当前时间，跳过这一轮清理"),
            }
            tokio::select! {
                () = tokio::time::sleep(interval) => {}
                changed = shutdown.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
            }
        }
    })
}
