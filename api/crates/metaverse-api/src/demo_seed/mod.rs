//! 部署配置种子（设计 9.2"部署配置种子是运维行为"，docs/design/server-slim.md 第 7 节）：接口服务按
//! 部署配置建一个演示空间，导入按哈希固定的重建包。线上不跑任何重建。
//!
//! 写接口 `/api/v1` 只认 NyxID 身份令牌，而把本服务注册成 NyxID 服务要组织管理员手工操作；在那之前
//! 网站上也要能看到演示空间，所以由部署配置（`METAVERSE_DEMO_SEED`，见 [`config`]）驱动，**不经过任何
//! 网络接口**。接口服务启动、索引建好之后在后台执行一次（失败按退避重试几次，记错误日志，不影响就绪）：
//!
//! 1. 空间已存在、不是种子为同一组织建的 → 什么都不做；
//! 2. 任务编号 = [`seed_job_id`]（空间编号、空间创建时间、版本，公式不变：线上第 1–3 版的
//!    `scan_import` 任务用的就是它，换格式、版本不变时不会重做）。这个编号的任务已经存在时：
//!    `done`、`queued`、`running` → 什么都不做；`failed` 且错误类别是 `fetch` → **重新排队**（`attempt`
//!    归零、去掉 `notBefore`，上一次的错误追加进 `history`，最多留 10 条）；`failed` 的其他类别 → 什么都
//!    不做（内容或配置有问题，改好后把 `revision` 加一）；
//! 3. 配置里没有 `bundle`：空间存在就什么都不做，不存在就只做第 5 步；
//! 4. 下载清单和来源表，核对大小和 sha256，按清单规则（SHAPES 7）和来源表规则（[`sources`]）校验
//!    结构。不合格或下载失败 → 记错误日志，不建空间、不插任务（下次启动再试）；
//! 5. 空间不存在就用与 `admin_create_space` 相同的代码路径建（`routes::admin_spaces::create_space_with`：
//!    主人取配置里的组织，归属证据的依据是 `operator_seed`、核验人 `system:demo-seed`；凭链接查看时
//!    分享令牌取 `METAVERSE_DEMO_SHARE_TOKEN`，只存哈希），并补写第一次提交；
//! 6. 插入 `bundle_import` 任务（参数 `{manifest, sources, revision}`，范围 `rebuild`，最多试 5 次），
//!    叫醒本进程的后台执行器。任务编号是唯一键，多副本同时启动也只有一个。
//!
//! 下载文件、登记资源、展开、发布都由后台执行器做（`runner/bundle_import.rs`），所有写入带租约栅栏。
//!
//! 全程用授权层签发的显式系统范围（`Authorizer::seed_create_grant`、`Authorizer::seed_space`，都写审计
//! 日志），数据访问只在 `repo/` 里。分享令牌原文不写日志。
//!
//! **重新导入**：把 `revision` 加一（换一个包），重启接口服务，就会在同一个空间里再导入一次（空间和
//! 分享链接不变）。空间被删掉以后重启，会按配置重新建（任务编号随空间创建时间变）。

pub mod config;
pub mod fetch;
pub mod hosts;
pub mod pack;
pub mod sources;

use std::time::Duration;

use metaverse_core::bundle::Bundle;
use metaverse_core::model::{
    ErrorClass, Job, JobKind, JobStatus, RequestActor, ShareTokenRecord, Space,
    OPERATOR_SEED_SUBJECT,
};
use metaverse_core::scope::PathScope;
use metaverse_core::sha256_hex;
use serde_json::json;

pub use config::{DemoSeedConfig, Pinned, SeedBundle, SeedShareToken};
use fetch::{FetchError, Fetcher};
pub use hosts::HostList;
use sources::Sources;

use crate::auth::{Grant, SeedSpace};
use crate::error::ApiError;
use crate::repo::{JobInsert, RepoError};
use crate::routes::admin_spaces::{create_space_with, new_share_token, SpaceCreation};
use crate::AppState;

/// 种子失败的原因。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SeedError {
    /// 不会自己变好（内容与配置不符、空间状态不对），不重试。
    #[error("{0}")]
    Permanent(String),
    /// 网络、数据库暂时不可用，可以重试。
    #[error("{0}")]
    Transient(String),
}

impl From<ApiError> for SeedError {
    fn from(error: ApiError) -> Self {
        let message = format!("{}（{}）", error.detail, error.code);
        if error.status.is_server_error() {
            SeedError::Transient(message)
        } else {
            SeedError::Permanent(message)
        }
    }
}

impl From<RepoError> for SeedError {
    fn from(error: RepoError) -> Self {
        match error {
            RepoError::Unavailable => SeedError::Transient("数据库暂时不可用".into()),
            other => SeedError::Permanent(format!("数据访问失败：{other}")),
        }
    }
}

impl From<FetchError> for SeedError {
    fn from(error: FetchError) -> Self {
        match error {
            FetchError::Fetch(message) => SeedError::Transient(message),
            FetchError::Content(message) => SeedError::Permanent(message),
        }
    }
}

/// 一次种子运行的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeedOutcome {
    /// 建了空间（配置里有包时同时建了导入任务）。
    Created { job_id: Option<String> },
    /// 空间是种子以前建的，这次建了这个版本的导入任务。
    Queued { job_id: String },
    /// 这个版本的导入任务上次因为下载失败而失败，这次重新排队。
    Requeued { job_id: String },
    /// 这个版本的任务已经存在（完成、排队、运行中，或因为内容问题失败），什么都没做。
    AlreadyDone { job_id: String },
    /// 空间已存在，配置里没有包，什么都没做。
    NothingToImport,
    /// 空间已存在，但不是种子为这个组织建的，什么都没做。
    Foreign,
}

/// 重试策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// 最多试几次（含第一次）。
    pub attempts: u32,
    pub first_delay: Duration,
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    /// 5 次：间隔 10 秒、30 秒、90 秒、270 秒。
    fn default() -> Self {
        Self {
            attempts: 5,
            first_delay: Duration::from_secs(10),
            max_delay: Duration::from_secs(300),
        }
    }
}

/// 同一个空间（这一次创建）、同一个导入版本的任务编号。
pub fn seed_job_id(space: &Space, revision: u32) -> String {
    let digest = sha256_hex(
        format!(
            "demo-seed\0{}\0{}\0{revision}",
            space.id,
            space.created_at.to_rfc3339()
        )
        .as_bytes(),
    );
    format!("job_{}", &digest[..32])
}

/// 索引建好以后在后台执行（`preparation` 是建索引的任务）。
pub fn spawn(
    state: AppState,
    seed: DemoSeedConfig,
    preparation: tokio::task::JoinHandle<()>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if preparation.await.is_err() {
            tracing::error!("部署配置种子：建索引的任务异常退出，不执行种子");
            return;
        }
        let _ = run(&state, &seed, RetryPolicy::default()).await;
    })
}

/// 执行种子，暂时性的失败按 `policy` 退避重试。结果和错误都写日志。
pub async fn run(
    state: &AppState,
    seed: &DemoSeedConfig,
    policy: RetryPolicy,
) -> Result<SeedOutcome, SeedError> {
    let mut delay = policy.first_delay;
    let attempts = policy.attempts.max(1);
    for attempt in 1..=attempts {
        match run_once(state, seed).await {
            Ok(outcome) => {
                tracing::info!(space = %seed.space_id, revision = seed.revision, outcome = ?outcome, "部署配置种子完成");
                return Ok(outcome);
            }
            Err(SeedError::Transient(reason)) if attempt < attempts => {
                tracing::warn!(space = %seed.space_id, attempt, retry_in = ?delay, reason = %reason, "部署配置种子暂时失败，稍后重试");
                tokio::time::sleep(delay).await;
                delay = (delay * 3).min(policy.max_delay);
            }
            Err(error) => {
                tracing::error!(space = %seed.space_id, attempt, error = %error, "部署配置种子失败，不再重试（服务照常运行）");
                return Err(error);
            }
        }
    }
    unreachable!("至少试一次")
}

/// 执行一次（见模块说明）。
pub async fn run_once(state: &AppState, seed: &DemoSeedConfig) -> Result<SeedOutcome, SeedError> {
    let reference = seed.reference();
    tracing::info!(space = %seed.space_id, revision = seed.revision, bundle = seed.bundle.is_some(), "部署配置种子：开始");
    let existing = match state
        .authorizer
        .seed_space(&seed.space_id, &seed.owner, &reference)
        .await?
    {
        SeedSpace::Foreign => return Ok(SeedOutcome::Foreign),
        SeedSpace::Seeded(grant) => {
            let space = seeded_space(state, &grant).await?;
            let job_id = seed_job_id(&space, seed.revision);
            if let Some(job) = state.repo.job(&grant, &job_id).await? {
                return existing_job(state, &grant, &job).await;
            }
            Some((grant, space))
        }
        SeedSpace::Missing => None,
    };
    let Some(bundle) = &seed.bundle else {
        if let Some((grant, _)) = &existing {
            // 第一次提交在建空间时没写成的话补上。
            let now = crate::now()?;
            crate::timeline::writer::ensure_genesis_as(
                &state.repo,
                grant,
                OPERATOR_SEED_SUBJECT,
                "",
                now,
            )
            .await?;
            return Ok(SeedOutcome::NothingToImport);
        }
        create_space(state, seed, &reference).await?;
        return Ok(SeedOutcome::Created { job_id: None });
    };
    // 先下载、核对：内容不对就不建空间、不插任务。
    check_bundle(state, seed, bundle).await?;
    let (grant, space, created) = match existing {
        Some((grant, space)) => (grant, space, false),
        None => {
            let created = create_space(state, seed, &reference).await?;
            let grant = match state
                .authorizer
                .seed_space(&seed.space_id, &seed.owner, &reference)
                .await?
            {
                SeedSpace::Seeded(grant) => grant,
                SeedSpace::Foreign => return Ok(SeedOutcome::Foreign),
                SeedSpace::Missing => {
                    return Err(SeedError::Transient(
                        "空间刚建好又不见了（被删除？）".into(),
                    ))
                }
            };
            let space = seeded_space(state, &grant).await?;
            (grant, space, created)
        }
    };
    let job_id = seed_job_id(&space, seed.revision);
    let now = crate::now()?;
    // 发布要基于第一次提交（建空间时没写成的话补上）。
    crate::timeline::writer::ensure_genesis_as(&state.repo, &grant, OPERATOR_SEED_SUBJECT, "", now)
        .await?;
    let job = Job {
        id: job_id.clone(),
        space_id: grant.space_id().to_owned(),
        owner: grant.owner().clone(),
        kind: JobKind::BundleImport,
        params: json!({
            "manifest": bundle.manifest,
            "sources": bundle.sources,
            "revision": seed.revision,
        }),
        status: JobStatus::Queued,
        lease_owner: None,
        lease_until: None,
        attempt: 0,
        max_attempts: JobKind::BundleImport.max_attempts(),
        last_error: None,
        not_before: None,
        history: Vec::new(),
        result_commit_id: None,
        created_at: now,
        actor: Some(RequestActor {
            sub: OPERATOR_SEED_SUBJECT.to_owned(),
            nyx_service_id: String::new(),
        }),
        scope: Some(PathScope::Rebuild),
        result: None,
        progress: None,
        started_at: None,
        finished_at: None,
    };
    match state.repo.insert_job(&grant, &job).await? {
        JobInsert::Inserted => {
            tracing::info!(target: "audit", space = %space.id, job = %job_id, purpose = "demo_seed", revision = seed.revision, "部署配置种子：已建 bundle_import 任务");
            state.job_signal.notify();
            Ok(if created {
                SeedOutcome::Created {
                    job_id: Some(job_id),
                }
            } else {
                SeedOutcome::Queued { job_id }
            })
        }
        JobInsert::Existing(_) => Ok(SeedOutcome::AlreadyDone { job_id }),
    }
}

/// 这个版本的任务已经存在：下载失败的重新排队，其余什么都不做（7.2 第 2 步）。
async fn existing_job(
    state: &AppState,
    grant: &Grant,
    job: &Job,
) -> Result<SeedOutcome, SeedError> {
    let job_id = job.id.clone();
    let fetch_failed = job.status == JobStatus::Failed
        && job.last_error.as_ref().and_then(|error| error.class()) == Some(ErrorClass::Fetch);
    if !fetch_failed {
        return Ok(SeedOutcome::AlreadyDone { job_id });
    }
    if state.repo.requeue_failed_job(grant, job).await? {
        tracing::warn!(
            target: "audit",
            space = %job.space_id,
            job = %job_id,
            error = %job.last_error.as_ref().map_or("", |error| error.message()),
            "部署配置种子：上次因为下载失败而失败，重新排队"
        );
        state.job_signal.notify();
        Ok(SeedOutcome::Requeued { job_id })
    } else {
        // 别的副本刚重新排过队。
        Ok(SeedOutcome::AlreadyDone { job_id })
    }
}

/// 下载清单和来源表，核对大小和 sha256，校验结构（7.2 第 4 步）。
async fn check_bundle(
    state: &AppState,
    seed: &DemoSeedConfig,
    bundle: &SeedBundle,
) -> Result<(), SeedError> {
    let fetcher = Fetcher::new(seed.hosts.clone())?;
    let manifest = fetch_pinned(&fetcher, &bundle.manifest, "清单").await?;
    let sources = fetch_pinned(&fetcher, &bundle.sources, "来源表").await?;
    let limits = state.ingest.config.upload_limits();
    let hosts = seed.hosts.clone();
    let (entities, files) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let text =
            std::str::from_utf8(&manifest).map_err(|_| "清单必须是 UTF-8 文本".to_owned())?;
        // 种子的包要在新库里也能展开，所以不能引用目标空间已有的模板（不传空间的模板表）。
        let parsed =
            Bundle::parse(text, &limits, None).map_err(|error| format!("清单不合规：{error}"))?;
        Sources::parse(&sources, &hosts, &parsed.files)?;
        let entities = parsed
            .rebuilt
            .as_ref()
            .map_or(0, |rebuilt| rebuilt.entity_count());
        Ok((entities, parsed.files.len()))
    })
    .await
    .map_err(|_| SeedError::Transient("校验清单的线程异常退出".into()))?
    .map_err(SeedError::Permanent)?;
    tracing::info!(space = %seed.space_id, revision = seed.revision, entities, files, "部署配置种子：清单和来源表已下载并核对");
    Ok(())
}

async fn fetch_pinned(
    fetcher: &Fetcher,
    pinned: &Pinned,
    label: &str,
) -> Result<Vec<u8>, SeedError> {
    let url = pinned.parsed_url().map_err(SeedError::Permanent)?;
    Ok(fetcher
        .fetch_bytes(&url, label, &pinned.sha256, pinned.size)
        .await?)
}

/// 建空间（与 `admin_create_space` 相同的代码路径），补写第一次提交。返回是不是本次建的。
async fn create_space(
    state: &AppState,
    seed: &DemoSeedConfig,
    reference: &str,
) -> Result<bool, SeedError> {
    let now = crate::now()?;
    let create = state
        .authorizer
        .seed_create_grant(&seed.owner, reference, now)?;
    let share_tokens = match &seed.share_token {
        Some(token) => vec![ShareTokenRecord {
            id: new_share_token()?.0,
            hash: token.hash(),
            created_at: now,
            revoked_at: None,
        }],
        None => Vec::new(),
    };
    match create_space_with(
        state,
        &create,
        seed.new_space(),
        share_tokens,
        (OPERATOR_SEED_SUBJECT, ""),
        now,
    )
    .await?
    {
        SpaceCreation::Created { .. } => {
            tracing::info!(target: "audit", space = %seed.space_id, purpose = "demo_seed", "部署配置种子：已建空间");
            Ok(true)
        }
        SpaceCreation::Duplicate => {
            tracing::info!(space = %seed.space_id, "部署配置种子：空间刚被别的副本建好，接着做");
            Ok(false)
        }
    }
}

async fn seeded_space(state: &AppState, grant: &Grant) -> Result<Space, SeedError> {
    state
        .repo
        .space(grant)
        .await?
        .ok_or_else(|| SeedError::Transient("空间刚被删除".into()))
}
