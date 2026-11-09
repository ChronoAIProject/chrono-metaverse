//! 鉴权与权限（设计第 9 节），三层顺序固定：
//!
//! 1. **身份**（全部 `/api/v1/*`）：[`require_identity`] 中间件按 9.1 验签
//!    （[`jwt`]，改编自 CMA），再以 jti 为主键登记防重放。完全不读
//!    `X-NyxID-User-*` 明文头。失败返回 401；拿不到 NyxID 公钥返回 503。
//! 2. **功能级权限**（可选）：[`permissions`]，精确匹配 `metaverse:*` 权限字符串。
//! 3. **资源级**：[`Authorizer`] 读出主人，按 9.2（[`access`]）算出访问级别，
//!    必要时用调用者转发来的凭据查组织角色（[`organizations`]，改编自 CMA），
//!    通过后签发只有它能构造的授权凭据 [`Grant`] / [`CreateGrant`]，数据访问层只认这些凭据。

use std::{sync::Arc, time::SystemTime};

use axum::{
    extract::{FromRequestParts, Request, State},
    http::{request::Parts, HeaderMap},
    middleware::Next,
    response::{IntoResponse, Response},
};

pub mod access;
pub mod authorizer;
pub mod jwt;
pub mod organizations;
pub mod permissions;

pub use authorizer::{
    Authorizer, AuthorizerKey, CreateGrant, Grant, GrantAccess, PublicBasis, Purpose,
};
pub use authorizer::{BlobGrant, PreviewTarget};
pub use organizations::ForwardedCredential;

use crate::error::ApiError;
use crate::repo::{JtiClaim, Repo};
use crate::AppState;
use permissions::{capabilities_from_permissions, Capabilities};

/// 验签通过、未重放的调用者。由 [`require_identity`] 放进请求扩展。
#[derive(Clone)]
pub struct Caller {
    pub subject: String,
    pub issuer: String,
    pub service_id: String,
    pub jti: String,
    pub capabilities: Capabilities,
    pub expires_at: SystemTime,
    credential: Option<ForwardedCredential>,
}

impl std::fmt::Debug for Caller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Caller")
            .field("subject", &self.subject)
            .field("service_id", &self.service_id)
            .field("jti", &self.jti)
            .field("forwarded_credential", &self.credential.is_some())
            .finish()
    }
}

impl Caller {
    /// NyxID 转发来的调用者凭据（查组织角色时用）。
    pub fn credential(&self) -> Option<&ForwardedCredential> {
        self.credential.as_ref()
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<Caller>()
            .cloned()
            .ok_or_else(|| ApiError::unauthenticated("missing_identity_token"))
    }
}

/// 身份层：验签 + 防重放。
pub struct Authenticator {
    verifier: Arc<jwt::Verifier>,
    repo: Repo,
}

impl Authenticator {
    pub fn new(verifier: Arc<jwt::Verifier>, repo: Repo) -> Self {
        Self { verifier, repo }
    }

    pub async fn authenticate(&self, headers: &HeaderMap) -> Result<Caller, ApiError> {
        let raw = match jwt::identity_token(headers) {
            Ok(Some(raw)) => raw,
            Ok(None) => return Err(ApiError::unauthenticated("missing_identity_token")),
            Err(jwt::VerifyError::Rejected(reason)) => {
                return Err(ApiError::unauthenticated(reason))
            }
            Err(jwt::VerifyError::Unavailable(_)) => return Err(ApiError::identity_unavailable()),
        };
        let identity = match self.verifier.verify(raw).await {
            Ok(identity) => identity,
            Err(jwt::VerifyError::Rejected(reason)) => {
                tracing::debug!(reason, "身份令牌被拒绝");
                return Err(ApiError::unauthenticated(reason));
            }
            Err(jwt::VerifyError::Unavailable(reason)) => {
                tracing::warn!(reason, "无法校验身份令牌");
                return Err(ApiError::identity_unavailable());
            }
        };
        // 验签全部通过后才登记 jti：无效令牌不占用防重放记录。
        match self
            .repo
            .claim_jti(&identity.jti, identity.expires_at)
            .await?
        {
            JtiClaim::Fresh => {}
            JtiClaim::Replayed => {
                tracing::warn!(subject = %identity.subject, "身份令牌重放");
                return Err(ApiError::unauthenticated("token_replayed"));
            }
        }
        Ok(Caller {
            capabilities: capabilities_from_permissions(&identity.permissions),
            subject: identity.subject,
            issuer: identity.issuer,
            service_id: identity.service_id,
            jti: identity.jti,
            expires_at: identity.expires_at,
            credential: ForwardedCredential::from_headers(headers),
        })
    }
}

/// `/api/v1/*` 的身份中间件。在读请求体之前执行（设计 8.5："先校验身份令牌，再读请求体"）。
pub async fn require_identity(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    match state.authenticator.authenticate(request.headers()).await {
        Ok(caller) => {
            request.extensions_mut().insert(caller);
            next.run(request).await
        }
        Err(error) => error.into_response(),
    }
}
