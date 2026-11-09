//! 部署配置种子（设计 9.2"部署配置种子是运维行为"）：接口服务按部署配置建一个演示空间，导入扫描。
//!
//! 写接口 `/api/v1` 只认 NyxID 身份令牌，而把本服务注册成 NyxID 服务要组织管理员手工操作；在那之前
//! 网站上也要能看到演示空间，所以由部署配置（`METAVERSE_DEMO_SEED`，见 [`config`]）驱动，**不经过任何
//! 网络接口**。接口服务启动、索引建好之后在后台执行一次（失败按退避重试几次，记错误日志，不影响就绪）：
//!
//! 1. 空间已存在：不是种子为同一组织建的就什么都不做；是的话，这个导入版本（`revision`）的任务已经
//!    建过也什么都不做。空间编号是唯一键，多副本同时启动也只有一个能建成；
//! 2. 下载全部文件、核对大小和 sha256、核对文件头；多个文件打包成 zip（[`pack`]）。任何一步失败都不建空间；
//! 3. 用与 `admin_create_space` 相同的代码路径建空间（`routes::admin_spaces::create_space_with`）：主人取
//!    配置里的组织，归属证据的依据是 `operator_seed`、核验人 `system:demo-seed`；第一次提交照常写
//!    `_space` 锚点和通用方块表；凭链接查看时分享令牌取 `METAVERSE_DEMO_SHARE_TOKEN`，只存哈希；
//! 4. 把扫描登记成资源（布局和元数据与处理服务 `assets.put_asset` 相同，`kind = scan`），已存在就复用；
//!    配置了 AI 物件集（`authored`）时，下载、核对大小和 sha256、做浅层校验
//!    （`metaverse_core::authored::check_authored`），原样登记成 `kind = authored` 的资源；
//! 5. 插入 `scan_import` 任务，字段与 `POST /scans` 建的任务完全一致，`actor = {sub: "system:demo-seed",
//!    nyxServiceId: ""}`，带物件集时参数里另有 `authoredAsset`；任务编号由（空间编号、空间创建时间、导入版本）算出，同一个空间的同一个版本
//!    只会有一个任务（唯一键）。
//!
//! 全程用授权层签发的显式系统范围（`Authorizer::seed_create_grant`、`Authorizer::seed_space`，都写审计
//! 日志），数据访问只在 `repo/` 里。分享令牌原文不写日志。
//!
//! **重新导入**：把 `revision` 加一（扫描文件、提示、物件集可以一起改），重启接口服务，就会在同一个空间里再建
//! 一个导入任务（空间和分享链接不变）。空间被删掉以后重启，会按配置重新建（任务编号随空间创建时间变）。

pub mod config;
pub mod fetch;
pub mod pack;

use std::time::Duration;

use metaverse_core::model::{
    Job, JobKind, JobStatus, RequestActor, ShareTokenRecord, Space, JOB_MAX_ATTEMPTS,
    OPERATOR_SEED_SUBJECT,
};
use metaverse_core::scope::PathScope;
use metaverse_core::sha256_hex;

pub use config::{DemoSeedConfig, SeedFile, SeedShareToken};
use fetch::Fetcher;
use pack::ScanAsset;

use crate::auth::{Grant, SeedSpace};
use crate::error::ApiError;
use crate::repo::{JobInsert, RepoError};
use crate::routes::admin_spaces::{create_space_with, new_share_token, SpaceCreation};
use crate::routes::jobs::{scan_params, AUTHORED_KIND};
use crate::AppState;

/// 种子失败的原因。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SeedError {
    /// 不会自己变好（内容与配置不符、地址不存在、空间状态不对），不重试。
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

/// 一次种子运行的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeedOutcome {
    /// 建了空间、登记了扫描、建了导入任务。
    Created { job_id: String },
    /// 空间是种子以前建的，这次补建了导入任务（新的导入版本，或上次没做完）。
    Resumed { job_id: String },
    /// 空间和这个导入版本的任务都已存在，什么都没做。
    AlreadyDone { job_id: String },
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
    tracing::info!(space = %seed.space_id, revision = seed.revision, files = seed.files.len(), "部署配置种子：开始");
    match state
        .authorizer
        .seed_space(&seed.space_id, &seed.owner, &reference)
        .await?
    {
        SeedSpace::Foreign => return Ok(SeedOutcome::Foreign),
        SeedSpace::Seeded(grant) => {
            let space = seeded_space(state, &grant).await?;
            let job_id = seed_job_id(&space, seed.revision);
            if state.repo.job(&grant, &job_id).await?.is_some() {
                return Ok(SeedOutcome::AlreadyDone { job_id });
            }
            let asset = download(state, seed).await?;
            return import(state, &grant, &space, seed, &asset, false).await;
        }
        SeedSpace::Missing => {}
    }

    // 先下载、核对：内容不对就不建空间。
    let asset = download(state, seed).await?;
    let now = crate::now()?;
    let create = state
        .authorizer
        .seed_create_grant(&seed.owner, &reference, now)?;
    let share_tokens = match &seed.share_token {
        Some(token) => vec![ShareTokenRecord {
            id: new_share_token()?.0,
            hash: token.hash(),
            created_at: now,
            revoked_at: None,
        }],
        None => Vec::new(),
    };
    let created = match create_space_with(
        state,
        &create,
        seed.new_space(),
        share_tokens,
        (OPERATOR_SEED_SUBJECT, ""),
        now,
    )
    .await?
    {
        SpaceCreation::Created { .. } => true,
        SpaceCreation::Duplicate => {
            tracing::info!(space = %seed.space_id, "部署配置种子：空间刚被别的副本建好，接着做");
            false
        }
    };
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
    import(state, &grant, &space, seed, &asset, created).await
}

async fn seeded_space(state: &AppState, grant: &Grant) -> Result<Space, SeedError> {
    state
        .repo
        .space(grant)
        .await?
        .ok_or_else(|| SeedError::Transient("空间刚被删除".into()))
}

/// 种子要登记的内容：扫描，和可选的 AI 物件集（原始字节，已核对和浅层校验）。
struct Download {
    scan: ScanAsset,
    authored: Option<Vec<u8>>,
}

/// 下载全部文件，核对后组成扫描资源；配置了物件集时一并下载、核对。
async fn download(state: &AppState, seed: &DemoSeedConfig) -> Result<Download, SeedError> {
    let fetcher = Fetcher::new()?;
    let max_side = state.ingest.config.max_texture_side;
    let started = std::time::Instant::now();
    let mut contents = Vec::with_capacity(seed.files.len());
    for file in &seed.files {
        let bytes = fetcher.fetch(file).await?;
        pack::check_file(file, &bytes, max_side).map_err(SeedError::Permanent)?;
        tracing::info!(space = %seed.space_id, file = %file.name, bytes = bytes.len(), "部署配置种子：已下载并核对");
        contents.push(bytes);
    }
    let asset = pack::scan_asset(&seed.files, contents, seed.max_total_bytes)
        .map_err(SeedError::Permanent)?;
    tracing::info!(
        space = %seed.space_id,
        format = asset.worker_format(),
        bytes = asset.bytes.len(),
        seconds = started.elapsed().as_secs_f32(),
        "部署配置种子：扫描已准备好"
    );
    let authored = match &seed.authored {
        None => None,
        Some(file) => {
            let bytes = fetcher.fetch(file).await?;
            let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
                SeedError::Permanent(format!("{} 不是 JSON：{error}", file.name))
            })?;
            let summary = metaverse_core::authored::check_authored(&value).map_err(|error| {
                SeedError::Permanent(format!("{} 不是合法的 AI 物件集：{error}", file.name))
            })?;
            tracing::info!(space = %seed.space_id, entities = summary.entities, models = summary.models, "部署配置种子：AI 物件集已下载并核对");
            Some(bytes)
        }
    };
    Ok(Download {
        scan: asset,
        authored,
    })
}

/// 登记扫描资源、补写第一次提交、插入 `scan_import` 任务。
async fn import(
    state: &AppState,
    grant: &Grant,
    space: &Space,
    seed: &DemoSeedConfig,
    download: &Download,
    created: bool,
) -> Result<SeedOutcome, SeedError> {
    let asset = &download.scan;
    let job_id = seed_job_id(space, seed.revision);
    let put = state
        .repo
        .put_asset_bytes_with(
            grant,
            &asset.bytes,
            asset.format.content_type(),
            "scan",
            &[("format", asset.worker_format())],
        )
        .await?;
    tracing::info!(space = %space.id, asset = %put.hash, reused = put.reused, "部署配置种子：扫描已登记成资源");
    let authored = match &download.authored {
        None => None,
        Some(bytes) => {
            let put = state
                .repo
                .put_asset_bytes_with(
                    grant,
                    bytes,
                    "application/json",
                    AUTHORED_KIND,
                    &[("format", "json")],
                )
                .await?;
            tracing::info!(space = %space.id, asset = %put.hash, reused = put.reused, "部署配置种子：AI 物件集已登记成资源");
            Some(put.hash)
        }
    };
    // 与 POST /scans 相同：会写提交的任务之前先补写第一次提交（建空间时没写成的话）。
    let now = crate::now()?;
    crate::timeline::writer::ensure_genesis_as(&state.repo, grant, OPERATOR_SEED_SUBJECT, "", now)
        .await?;
    let job = Job {
        id: job_id.clone(),
        space_id: grant.space_id().to_owned(),
        owner: grant.owner().clone(),
        kind: JobKind::ScanImport,
        params: scan_params(
            &put.hash,
            seed.observed_at,
            Some(seed.rebuild),
            Some(seed.voxelize),
            seed.hints.clone(),
            None,
            authored.as_deref(),
        ),
        status: JobStatus::Queued,
        lease_owner: None,
        lease_until: None,
        attempt: 0,
        max_attempts: JOB_MAX_ATTEMPTS,
        last_error: None,
        result_commit_id: None,
        created_at: now,
        actor: Some(RequestActor {
            sub: OPERATOR_SEED_SUBJECT.to_owned(),
            nyx_service_id: String::new(),
        }),
        scope: Some(PathScope::Physical),
        result: None,
        progress: None,
        started_at: None,
        finished_at: None,
    };
    match state.repo.insert_job(grant, &job).await? {
        JobInsert::Inserted => {
            tracing::info!(target: "audit", space = %space.id, job = %job_id, purpose = "demo_seed", "部署配置种子：已建 scan_import 任务");
            Ok(if created {
                SeedOutcome::Created { job_id }
            } else {
                SeedOutcome::Resumed { job_id }
            })
        }
        JobInsert::Existing(_) => Ok(SeedOutcome::AlreadyDone { job_id }),
    }
}
