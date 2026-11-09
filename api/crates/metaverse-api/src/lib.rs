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
pub mod error;
pub mod health;
pub mod ingest;
pub mod openapi;
pub mod repo;
pub mod routes;

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
        let organizations = OrganizationClient::new(&config.nyxid.base_url, verifier.clone())?;
        Ok(Self {
            authenticator: Arc::new(Authenticator::new(verifier, repo.clone())),
            authorizer: Arc::new(Authorizer::new(
                repo.clone(),
                organizations,
                config.nyxid.issuer.clone(),
                config.require_permissions,
            )),
            repo,
            ingest: Arc::new(ingest::IngestRuntime::new(config.ingest.clone())),
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
