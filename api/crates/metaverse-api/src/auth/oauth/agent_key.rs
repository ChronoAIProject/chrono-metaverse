//! 浏览器持有 NyxID 登录子凭据；服务端不持久保存。
use super::{owner, routes, seconds, HeldCredential, OAuthError, OAuthService, STORE};
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
    pub(super) fn from_headers(headers: &HeaderMap) -> Result<Self, ApiError> {
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
pub(super) fn not_accepted() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "cma_key_not_accepted",
        "CMA 尚未接受此授权，请重新检查连接；原授权、任务和请求编号已保留",
    )
}
fn scope_required() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "cma_key_scope_required",
        "请选择当前账号的 CMA 专用 Agent Key，仅授予 CMA 服务和 proxy 权限",
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
    credential_version: String,
}
impl Identity {
    fn same_owner(&self, subject: &str) -> Result<(), ApiError> {
        if self.api_key.owner_id != subject || self.api_key.owner_type != "personal" {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "cma_key_account_mismatch",
                "Agent Key 不属于当前登录账号，请使用当前账号的 CMA 授权",
            ));
        }
        Ok(())
    }
    fn summary(self, subject: &str) -> Result<Summary, ApiError> {
        self.same_owner(subject)?;
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
            })
            // 同一服务可以有多个连接；直连使用已核验的 Key 主体。
            // 必须包含当前账号的连接，允许同时存在其他 CMA 连接。
            || !key.effective_services.iter().any(|s| {
                key.allowed_service_ids.contains(&s.id)
                    && (s.owner_id.as_deref() == Some(subject)
                        || s.owner_id.is_none())
            })
        {
            return Err(scope_required());
        }
        Ok(Summary {
            owner_id: subject.into(),
            key_id: key.id,
            name: key.name,
            credential_id: self.credential_id,
            credential_expires_at: self.credential_expires_at,
            key_expires_at: key.expires_at,
            credential_version: String::new(),
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
    subject: &str,
) -> Result<Summary, ApiError> {
    identity(oauth, credential).await?.summary(subject)
}

/// NyxID 批准不能证明 CMA 已接受；这里只转发浏览器 Key。
async fn check_cma(
    oauth: &OAuthService,
    credential: &Credential,
    subject: &str,
) -> Result<(), ApiError> {
    let base = oauth
        .config
        .cma_base_url
        .as_deref()
        .ok_or_else(unavailable)?;
    let response = oauth
        .http
        .get(format!("{}/auth/session", base.trim_end_matches('/')))
        .bearer_auth(credential.value())
        .send()
        .await
        .map_err(|_| unavailable())?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(not_accepted());
    }
    if !response.status().is_success() {
        return Err(unavailable());
    }
    #[derive(Deserialize)]
    struct Session {
        authenticated: bool,
        subject: String,
        #[serde(default)]
        api_commands: bool,
    }
    let session: Session =
        serde_json::from_slice(&private_body(response).await?).map_err(|_| unavailable())?;
    if !session.authenticated || session.subject != subject {
        return Err(not_accepted());
    }
    if !session.api_commands {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "cma_command_authority_required",
            "CMA 尚未提供此 Agent Key 的聊天能力，请保留原授权与请求，等待服务配置完成",
        ));
    }
    Ok(())
}
pub(super) async fn checked(
    oauth: &OAuthService,
    headers: &HeaderMap,
    subject: &str,
) -> Result<Credential, ApiError> {
    let credential = Credential::from_headers(headers)?;
    verify(oauth, &credential, subject).await?;
    Ok(credential)
}

struct Browser {
    oauth: Arc<OAuthService>,
    session: OAuthSessionRecord,
    held: HeldCredential,
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
        if require_owner_access {
            owner::resolve(state, headers, &session.subject).await?;
        }
        Ok(Self {
            oauth,
            session,
            held,
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
    // 仅预填选项，最终选择与审批由 NyxID 确认。
    url.query_pairs_mut().extend_pairs([
        ("user_code", request.user_code.as_str()),
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
    let summary = delivery.identity.summary(&b.session.subject);
    let current = b.current().await;
    if summary.is_err() || current.is_err() {
        // 交付给错误账号的子凭据不能保持有效；不能撤销父 Key。
        let _ = b
            .oauth
            .http
            .delete(b.oauth.endpoint("/api/v1/auth/agent-key/self"))
            .bearer_auth(credential.value())
            .send()
            .await;
    }
    current?;
    let mut summary = summary?;
    summary.credential_version = super::worker::credential_version(credential.value());
    Ok(Json(json!({"credential":credential.value(),"identity":summary})).into_response())
}
async fn check(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    let b = Browser::new(&state, &headers).await?;
    let credential = Credential::from_headers(&headers)?;
    let mut summary = verify(&b.oauth, &credential, &b.session.subject).await?;
    summary.credential_version = super::worker::credential_version(credential.value());
    check_cma(&b.oauth, &credential, &b.session.subject).await?;
    b.current().await?;
    Ok(Json(summary).into_response())
}
async fn revoke(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    // 退出组织后仍可撤销当前账号的子凭据，不因此授予 CMA 操作权限。
    let b = Browser::open(&state, &headers, false).await?;
    let credential = Credential::from_headers(&headers)?;
    // 父 Key 的服务授权变化后仍允许撤销子凭据。
    identity(&b.oauth, &credential)
        .await?
        .same_owner(&b.session.subject)?;
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
