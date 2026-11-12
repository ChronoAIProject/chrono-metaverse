//! 用户 OAuth 托管组织查询；经浏览器明确同意后，可调用固定 CMA 操作。
//! metaverse 业务接口仍只接受 NyxID 签名身份，worker 凭据由 CMA 管理。
mod agent_key;
pub(crate) mod catalog;
mod config;
mod creation;
mod crypto;
mod owner;
mod provider;
mod routes;
mod worker;

use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    auth::organizations::ForwardedCredential,
    repo::{OAuthGrantRecord, Repo, RepoError},
};
pub use config::OAuthConfig;
use crypto::{digest, Vault};
pub use routes::router;

pub(crate) struct StoreAuthority(());
const STORE: StoreAuthority = StoreAuthority(());

#[derive(Debug, thiserror::Error)]
pub enum OAuthError {
    #[error("NyxID 授权不可用，请重新连接")]
    Reconnect,
    #[error("NyxID 授权服务暂时不可用")]
    Unavailable,
}

impl From<RepoError> for OAuthError {
    fn from(_: RepoError) -> Self {
        Self::Unavailable
    }
}

#[derive(Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    subject_verified: bool,
    #[serde(default)]
    scope: Option<String>,
}

impl Drop for Tokens {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

/// 同一次组织查询持有的版本；查询结束还需确认未被断开或重新授权替换。
pub(crate) struct HeldCredential {
    pub credential: ForwardedCredential,
    record: OAuthGrantRecord,
    cma_granted: bool,
}

pub struct OAuthService {
    config: OAuthConfig,
    base_url: url::Url,
    namespace: String,
    repo: Repo,
    vault: Vault,
    http: reqwest::Client,
}

impl OAuthService {
    pub fn new(
        config: OAuthConfig,
        base_url: &str,
        issuer: &str,
        repo: Repo,
    ) -> Result<Arc<Self>, String> {
        let namespace = digest(
            &serde_json::to_string(&(
                "chrono-metaverse-oauth-v1",
                &config.origin,
                base_url.trim_end_matches('/'),
                issuer,
                &config.client_id,
            ))
            .map_err(|_| "OAuth 配置不可用")?,
        );
        let vault = Vault::new(&config.encryption_key.0).map_err(|_| "OAuth 加密配置不可用")?;
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(12))
            .connect_timeout(Duration::from_secs(2))
            .build()
            .map_err(|_| "OAuth HTTP 客户端配置不可用")?;
        Ok(Arc::new(Self {
            config,
            base_url: url::Url::parse(base_url).map_err(|_| "OAuth 地址不可用")?,
            namespace,
            repo,
            vault,
            http,
        }))
    }

    fn endpoint(&self, path: &str) -> url::Url {
        let mut url = self.base_url.clone();
        url.set_path(path);
        url
    }

    fn grant_id(&self, subject: &str) -> String {
        digest(&format!("{}/{}", self.namespace, subject))
    }
    fn aad(&self, record: &OAuthGrantRecord) -> String {
        format!(
            "{}/{}/{}/{}/{}",
            self.namespace, record.id, record.subject, record.incarnation, record.version
        )
    }

    fn tokens(&self, record: &OAuthGrantRecord) -> Result<Tokens, OAuthError> {
        let bytes = self.vault.open(&record.ciphertext, &self.aad(record))?;
        serde_json::from_slice(&bytes).map_err(|_| OAuthError::Unavailable)
    }

    fn sealed(
        &self,
        subject: &str,
        incarnation: &str,
        tokens: &Tokens,
    ) -> Result<OAuthGrantRecord, OAuthError> {
        let mut record = OAuthGrantRecord {
            id: self.grant_id(subject),
            subject: subject.into(),
            incarnation: incarnation.into(),
            version: crypto::random()?,
            ciphertext: String::new(),
        };
        let bytes =
            Zeroizing::new(serde_json::to_vec(tokens).map_err(|_| OAuthError::Unavailable)?);
        record.ciphertext = self.vault.seal(&bytes, &self.aad(&record))?;
        Ok(record)
    }

    pub(crate) async fn credential(
        self: &Arc<Self>,
        subject: &str,
    ) -> Result<Option<HeldCredential>, OAuthError> {
        let id = self.grant_id(subject);
        for _ in 0..30 {
            let Some(record) = self.repo.oauth_grant_get(&STORE, &id).await? else {
                return Ok(None);
            };
            if record.subject != subject {
                return Err(OAuthError::Unavailable);
            }
            let tokens = self.tokens(&record)?;
            if tokens.expires_at > seconds()? + 30 && tokens.subject_verified {
                return Ok(Some(HeldCredential {
                    credential: ForwardedCredential::retained(tokens.access_token.clone()),
                    cma_granted: tokens
                        .scope
                        .as_deref()
                        .is_some_and(|s| s.split_whitespace().any(|s| s == "proxy")),
                    record,
                }));
            }
            let lease = crypto::random()?;
            if !self
                .repo
                .oauth_refresh_claim(&STORE, &record, &lease, seconds()?)
                .await?
            {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
            // 调用者超时/断开连接时任务继续完成，避免 provider 已轮换、数据库却丢失新令牌。
            let service = self.clone();
            tokio::spawn(async move {
                let result = service.renew(&record, tokens, &lease).await;
                if result.is_err() {
                    let _ = service
                        .repo
                        .oauth_refresh_release(&STORE, &record, &lease)
                        .await;
                }
                result
            })
            .await
            .map_err(|_| OAuthError::Unavailable)??;
        }
        Err(OAuthError::Unavailable)
    }

    async fn renew(
        &self,
        record: &OAuthGrantRecord,
        tokens: Tokens,
        lease: &str,
    ) -> Result<(), OAuthError> {
        let mut next = if tokens.expires_at <= seconds()? + 30 {
            match self.refresh(&tokens).await {
                Ok(next) => next,
                Err(OAuthError::Reconnect) => {
                    self.repo.oauth_grant_disable(&STORE, record).await?;
                    return Err(OAuthError::Reconnect);
                }
                Err(error) => return Err(error),
            }
        } else {
            tokens
        };
        let verified = match self.subject(&next.access_token).await {
            Ok(actual) if actual == record.subject => {
                next.subject_verified = true;
                Ok(())
            }
            Ok(_) | Err(OAuthError::Reconnect) => {
                self.repo.oauth_grant_disable(&STORE, record).await?;
                return Err(OAuthError::Reconnect);
            }
            Err(error) => Err(error),
        };
        // 即使 userinfo 暂时失败，也保存可能已轮换的令牌；下次使用前仍须核对主体。
        let next_record = self.sealed(&record.subject, &record.incarnation, &next)?;
        if !self
            .repo
            .oauth_refresh_finish(&STORE, record, lease, &next_record)
            .await?
        {
            return Err(OAuthError::Reconnect);
        }
        verified
    }

    pub(crate) async fn current(&self, held: &HeldCredential) -> Result<bool, OAuthError> {
        Ok(self.repo.oauth_grant_current(&STORE, &held.record).await?)
    }
}

fn seconds() -> Result<i64, OAuthError> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| OAuthError::Unavailable)?
            .as_secs(),
    )
    .map_err(|_| OAuthError::Unavailable)
}
