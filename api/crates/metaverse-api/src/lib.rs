//! chrono-metaverse 接口服务。
//!
//! 结构参照 CMA（`api/crates/cma`）：配置、健康检查、错误格式、OpenAPI、NyxID 鉴权、
//! 组织角色、权限映射都沿用 CMA 的写法；数据访问集中在 [`repo`]，并强制带授权凭据。

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, SystemTime};

use axum::Router;
use metaverse_core::Timestamp;

pub mod auth;
pub mod config;
pub mod demo_seed;
pub mod error;
pub mod health;
pub mod ingest;
pub mod openapi;
pub mod repo;
pub mod routes;
pub mod runner;
// 时间线与公开读分工：公开接口基础设施、时间线领域逻辑。
pub mod public;
pub mod timeline;

use auth::{jwt, organizations::OrganizationClient, Authenticator, Authorizer};
use config::Config;
use error::ApiError;
use repo::{Repo, RepoError};

/// 请求处理共享的状态。
#[derive(Clone)]
pub struct AppState {
    pub repo: Repo,
    pub authenticator: Arc<Authenticator>,
    pub authorizer: Arc<Authorizer>,
    /// 上传、任务的上限和进程内状态（分片并发、`/head` 短缓存）。
    pub ingest: Arc<ingest::IngestRuntime>,
    /// 公开接口的限流、并发计数和进程内缓存。
    pub public: Arc<public::PublicServices>,
    /// 叫醒本进程的后台执行器（完成上传、建好任务以后，不等轮询）。
    pub job_signal: Arc<runner::JobSignal>,
    /// 用户授权的凭据托管；不为业务接口提供浏览器身份认证。
    pub oauth: Option<Arc<auth::oauth::OAuthService>>,
    ready: Arc<AtomicBool>,
}

impl AppState {
    /// 按配置建立数据库客户端、身份令牌校验器和组织角色查询客户端。
    pub async fn from_config(config: &Config) -> Result<Self, String> {
        let repo = Repo::connect(&config.mongodb_uri, &config.mongodb_database).await?;
        let verifier = Arc::new(
            jwt::Verifier::new(config.verifier_config())
                .map_err(|error| format!("NyxID 身份令牌校验配置不可用：{error}"))?,
        );
        let oauth = config
            .oauth
            .clone()
            .map(|oauth| {
                auth::oauth::OAuthService::new(
                    oauth,
                    &config.nyxid.base_url,
                    &config.nyxid.issuer,
                    repo.clone(),
                )
            })
            .transpose()?;
        let organizations = OrganizationClient::new(&config.nyxid.base_url, verifier.clone())?
            .with_oauth(oauth.clone());
        Ok(Self {
            oauth,
            authenticator: Arc::new(Authenticator::new(verifier, repo.clone())),
            authorizer: Arc::new(Authorizer::new(
                repo.clone(),
                organizations,
                config.nyxid.issuer.clone(),
                config.require_permissions,
            )),
            public: public::PublicServices::new(config.public.clone()),
            repo,
            ingest: Arc::new(ingest::IngestRuntime::new(config.ingest.clone())),
            job_signal: Arc::new(runner::JobSignal::default()),
            ready: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    /// 建索引；成功后才对外提供服务。
    pub async fn prepare(&self) -> Result<(), RepoError> {
        self.repo.ensure_indexes().await?;
        self.ready.store(true, Ordering::Release);
        Ok(())
    }

    /// 后台建索引，失败就隔一会儿重试（数据库可能还没就绪）。
    pub fn spawn_preparation(&self) -> tokio::task::JoinHandle<()> {
        let state = self.clone();
        tokio::spawn(async move {
            let mut delay = Duration::from_secs(1);
            loop {
                match state.prepare().await {
                    Ok(()) => {
                        tracing::info!("索引已就绪，开始接收请求");
                        return;
                    }
                    Err(error) => {
                        tracing::warn!(error = %error, retry_in = ?delay, "建立索引失败");
                        tokio::time::sleep(delay).await;
                        delay = (delay * 2).min(Duration::from_secs(30));
                    }
                }
            }
        })
    }
}

/// 完整的路由。
pub fn app(state: AppState) -> Router {
    routes::router(state)
}

/// 服务端当前时间。
pub fn now() -> Result<Timestamp, ApiError> {
    Timestamp::from_system_time(SystemTime::now()).map_err(|_| ApiError::internal())
}
