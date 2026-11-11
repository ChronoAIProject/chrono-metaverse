//! Browser-held NyxID login credentials; secrets are never persisted.
use super::{routes, seconds, HeldCredential, OAuthError, OAuthService, STORE};
use crate::{error::ApiError, repo::OAuthSessionRecord, routes::ApiJson, AppState};
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use zeroize::{Zeroize, Zeroizing};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/nyxid/worker/key/request", post(request))
        .route("/api/auth/nyxid/worker/key/poll", post(poll))
        .route("/api/auth/nyxid/worker/key/check", post(check))
        .route("/api/auth/nyxid/worker/key/revoke", post(revoke))
}

pub(super) struct Credential(Zeroizing<String>);
impl Credential {
    pub(super) fn value(&self) -> &str {
        &self.0
    }
    fn from_headers(headers: &HeaderMap) -> Result<Self, ApiError> {
        let mut values = headers.get_all(header::AUTHORIZATION).iter();
        let token = values
            .next()
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|v| valid(v));
        match (token, values.next()) {
            (Some(token), None) => Ok(Self(Zeroizing::new(token.into()))),
            _ => Err(required()),
        }
    }
}
fn valid(value: &str) -> bool {
    (value.starts_with("nyx_") || value.starts_with("nyxid_ag_"))
        && (16..=4096).contains(&value.len())
        && value.bytes().all(|b| b.is_ascii_graphic())
}
fn required() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "cma_key_required",
        "请先授权此浏览器使用 CMA Agent Key；原任务和请求编号已保留",
    )
}
fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "cma_key_unavailable",
        "暂时无法核验浏览器的 Agent Key，请保留原请求后重试",
    )
}
fn scope_required() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "cma_key_scope_required",
        "请选择属于当前空间归属、仅允许其 CMA 服务且 scope 为 proxy 的 Agent Key",
    )
}

#[derive(Deserialize)]
struct Service {
    id: String,
    slug: String,
    catalog_service_slug: Option<String>,
    is_active: bool,
    #[serde(default)]
    owner_id: Option<String>,
}
#[derive(Deserialize)]
struct Key {
    id: String,
    name: String,
    owner_type: String,
    owner_id: String,
    scopes: String,
    allow_all_services: bool,
    #[serde(default)]
    allow_auto_connected_services: bool,
    allowed_service_ids: Vec<String>,
    effective_services: Vec<Service>,
    expires_at: Option<String>,
}
#[derive(Deserialize)]
struct Identity {
    api_key: Key,
    credential_id: String,
    credential_expires_at: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    owner_id: String,
    key_id: String,
    name: String,
    credential_id: String,
    credential_expires_at: Option<String>,
    key_expires_at: Option<String>,
}
impl Identity {
    fn same_owner(&self, owner: &Owner) -> Result<(), ApiError> {
        if self.api_key.owner_id != owner.id
            || self.api_key.owner_type != if owner.org { "org" } else { "personal" }
        {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "cma_key_account_mismatch",
                "Agent Key 与当前连接账号不一致，请用同一账号重新授权",
            ));
        }
        Ok(())
    }
    fn summary(self, owner: &Owner) -> Result<Summary, ApiError> {
        self.same_owner(owner)?;
        let key = self.api_key;
        if key.scopes.split_whitespace().collect::<Vec<_>>() != ["proxy"]
            || key.allow_all_services
            || key.allow_auto_connected_services
            || key.allowed_service_ids.is_empty()
            || key.effective_services.is_empty()
            || key.allowed_service_ids.iter().any(|id| {
                !key.effective_services.iter().any(|s| {
                    &s.id == id
                        && s.slug == "cma"
                        && s.catalog_service_slug.as_deref() == Some("cma")
                        && s.is_active
                })
            })
            || key.effective_services.iter().any(|s| {
                s.slug != "cma"
                    || s.catalog_service_slug.as_deref() != Some("cma")
                    || !s.is_active
                    || s.owner_id.as_deref().is_some_and(|id| id != owner.id)
                    || (owner.org && s.owner_id.as_deref() != Some(owner.id.as_str()))
            })
        {
            return Err(scope_required());
        }
        Ok(Summary {
            owner_id: owner.id.clone(),
            key_id: key.id,
            name: key.name,
            credential_id: self.credential_id,
            credential_expires_at: self.credential_expires_at,
            key_expires_at: key.expires_at,
        })
    }
}

async fn private_body(mut response: reqwest::Response) -> Result<Zeroizing<Vec<u8>>, ApiError> {
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
        if bytes.len() + chunk.len() > 256 * 1024 {
            return Err(unavailable());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn failure(status: StatusCode, body: &[u8]) -> ApiError {
    let code = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("error_code").and_then(Value::as_u64));
    let (local, detail) = match code {
        Some(11902) => ("cma_key_pending", "等待你在 NyxID 确认授权"),
        Some(11903) => ("cma_key_slow_down", "请稍候再检查授权结果"),
        Some(11904) => ("cma_key_denied", "此次 Agent Key 授权已取消"),
        Some(11900 | 11901 | 11905 | 11907 | 11909) => {
            ("cma_key_expired", "此次授权已失效，请重新发起授权")
        }
        _ if matches!(status.as_u16(), 401 | 403) => (
            "cma_key_required",
            "Agent Key 已失效或权限已变化，请重新授权",
        ),
        _ => return unavailable(),
    };
    ApiError::new(StatusCode::FORBIDDEN, local, detail)
}
async fn identity(oauth: &OAuthService, credential: &Credential) -> Result<Identity, ApiError> {
    let response = oauth
        .http
        .get(oauth.endpoint("/api/v1/auth/agent-key/self"))
        .bearer_auth(credential.value())
        .send()
        .await
        .map_err(|_| unavailable())?;
    let status = response.status();
    let body = private_body(response).await?;
    if !status.is_success() {
        return Err(failure(status, &body));
    }
    serde_json::from_slice::<Identity>(&body).map_err(|_| unavailable())
}
async fn verify(
    oauth: &OAuthService,
    credential: &Credential,
    owner: &Owner,
) -> Result<Summary, ApiError> {
    identity(oauth, credential).await?.summary(owner)
}
pub(super) async fn checked(
    oauth: &OAuthService,
    headers: &HeaderMap,
    owner: &Owner,
) -> Result<Credential, ApiError> {
    let credential = Credential::from_headers(headers)?;
    verify(oauth, &credential, owner).await?;
    Ok(credential)
}

pub(super) struct Owner {
    pub(super) id: String,
    pub(super) org: bool,
}
fn requested_owner(headers: &HeaderMap, subject: &str) -> Result<Owner, ApiError> {
    let values = headers
        .get_all("x-metaverse-cma-owner")
        .iter()
        .collect::<Vec<_>>();
    let id = match values.as_slice() {
        [] => subject,
        [value] => value
            .to_str()
            .ok()
            .filter(|id| metaverse_core::ids::is_subject_id(id))
            .ok_or_else(|| ApiError::invalid("CMA 归属编号不正确"))?,
        _ => return Err(ApiError::invalid("CMA 归属编号重复")),
    };
    let org = id != subject;
    Ok(Owner { id: id.into(), org })
}
pub(super) async fn owner(
    state: &AppState,
    headers: &HeaderMap,
    subject: &str,
) -> Result<Owner, ApiError> {
    let owner = requested_owner(headers, subject)?;
    if owner.org {
        use crate::auth::organizations::MembershipLookup;
        match state
            .authorizer
            .connection_membership(subject, &owner.id)
            .await
        {
            MembershipLookup::Member(member)
                if member.role != metaverse_core::model::OrgRole::Viewer => {}
            MembershipLookup::Unavailable => return Err(ApiError::org_membership_unavailable()),
            _ => {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "cma_key_account_mismatch",
                    "当前账号没有使用该组织 CMA 的权限",
                ))
            }
        }
    }
    Ok(owner)
}

struct Browser {
    oauth: Arc<OAuthService>,
    session: OAuthSessionRecord,
    held: HeldCredential,
    owner: Owner,
}
impl Browser {
    async fn new(state: &AppState, headers: &HeaderMap) -> Result<Self, ApiError> {
        Self::open(state, headers, true).await
    }
    async fn open(
        state: &AppState,
        headers: &HeaderMap,
        require_owner_access: bool,
    ) -> Result<Self, ApiError> {
        let oauth = routes::service(state)?;
        if oauth.config.cma_base_url.is_none() {
            return Err(unavailable());
        }
        let (session, held) = routes::verified_browser(&oauth, headers).await?;
        let owner = if require_owner_access {
            owner(state, headers, &session.subject).await?
        } else {
            requested_owner(headers, &session.subject)?
        };
        Ok(Self {
            oauth,
            session,
            held,
            owner,
        })
    }
    async fn current(&self) -> Result<(), ApiError> {
        if !self.oauth.current(&self.held).await?
            || self
                .oauth
                .repo
                .oauth_session_get(&STORE, &self.session.id, seconds()?)
                .await?
                .is_none_or(|s| {
                    s.incarnation != self.session.incarnation || s.subject != self.session.subject
                })
        {
            return Err(OAuthError::Reconnect.into());
        }
        Ok(())
    }
}
async fn request(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    let b = Browser::new(&state, &headers).await?;
    let response = b.oauth.http.post(b.oauth.endpoint("/api/v1/auth/agent-key/request"))
        .header(header::ORIGIN, &b.oauth.config.origin)
        .json(&json!({"requested_profile":"metaverse-web","client_label":"Metaverse 网页","client_app":"chrono-metaverse","client_form_factor":"browser"}))
        .send().await.map_err(|_| unavailable())?;
    let status = response.status();
    let body = private_body(response).await?;
    if !status.is_success() {
        return Err(failure(status, &body));
    }
    #[derive(Deserialize, Serialize)]
    struct Request {
        device_code: String,
        user_code: String,
        expires_in: u32,
        interval: u32,
        verification_uri: String,
    }
    let mut request: Request = serde_json::from_slice(&body).map_err(|_| unavailable())?;
    let mut url = url::Url::parse(&request.verification_uri).map_err(|_| unavailable())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/login/agent-key"
        || url.query().is_some()
        || url.fragment().is_some()
        || !(1..=600).contains(&request.expires_in)
        || !(1..=60).contains(&request.interval)
        || request.device_code.is_empty()
        || request.device_code.len() > 4096
        || !(4..=32).contains(&request.user_code.len())
        || !request
            .user_code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(unavailable());
    }
    // Preferences only. NyxID's human review owns selection and approval.
    url.query_pairs_mut().extend_pairs([
        ("user_code", request.user_code.as_str()),
        ("owner_id", b.owner.id.as_str()),
        ("login_type", "agent"),
        ("key_source", "existing"),
        ("permissions", "proxy"),
        ("services", "cma"),
        ("key_name", "Metaverse 网页"),
        ("expiry_days", "7"),
    ]);
    request.verification_uri = url.into();
    b.current().await?;
    Ok(Json(request).into_response())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Poll {
    device_code: String,
}
impl Drop for Poll {
    fn drop(&mut self) {
        self.device_code.zeroize();
    }
}
async fn poll(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Poll>,
) -> Result<Response, ApiError> {
    if input.device_code.is_empty()
        || input.device_code.len() > 4096
        || !input.device_code.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(ApiError::invalid("授权请求已失效"));
    }
    let b = Browser::new(&state, &headers).await?;
    let response = b
        .oauth
        .http
        .post(b.oauth.endpoint("/api/v1/auth/agent-key/poll"))
        .json(&json!({"device_code":input.device_code}))
        .send()
        .await
        .map_err(|_| unavailable())?;
    let status = response.status();
    let body = private_body(response).await?;
    if !status.is_success() {
        return Err(failure(status, &body));
    }
    #[derive(Deserialize)]
    struct Delivery {
        credential: String,
        #[serde(flatten)]
        identity: Identity,
    }
    let mut delivery: Delivery = serde_json::from_slice(&body).map_err(|_| unavailable())?;
    let credential = Credential(Zeroizing::new(std::mem::take(&mut delivery.credential)));
    if !valid(credential.value()) {
        return Err(unavailable());
    }
    let summary = delivery.identity.summary(&b.owner);
    let current = b.current().await;
    if summary.is_err() || current.is_err() {
        // An unusable delivered child must not remain active. Never revoke its parent.
        let _ = b
            .oauth
            .http
            .delete(b.oauth.endpoint("/api/v1/auth/agent-key/self"))
            .bearer_auth(credential.value())
            .send()
            .await;
    }
    current?;
    let summary = summary?;
    Ok(Json(json!({"credential":credential.value(),"identity":summary})).into_response())
}
async fn check(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    let b = Browser::new(&state, &headers).await?;
    let credential = Credential::from_headers(&headers)?;
    let summary = verify(&b.oauth, &credential, &b.owner).await?;
    b.current().await?;
    Ok(Json(summary).into_response())
}
async fn revoke(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    // A holder may revoke its own child after leaving the organization. This never
    // grants CMA access or permission to revoke the parent or another credential.
    let b = Browser::open(&state, &headers, false).await?;
    let credential = Credential::from_headers(&headers)?;
    // Revocation remains available if the parent Key's service grant changed.
    identity(&b.oauth, &credential)
        .await?
        .same_owner(&b.owner)?;
    b.current().await?;
    let response = b
        .oauth
        .http
        .delete(b.oauth.endpoint("/api/v1/auth/agent-key/self"))
        .bearer_auth(credential.value())
        .send()
        .await
        .map_err(|_| unavailable())?;
    if !response.status().is_success() {
        let s = response.status();
        return Err(failure(s, &private_body(response).await?));
    }
    b.current().await?;
    Ok(Json(json!({"revoked":true})).into_response())
}
