//! Resolve an owned CMA connection; NyxID enforces the OAuth service grant.
use super::OAuthService;
use crate::{error::ApiError, AppState};
use axum::http::{HeaderMap, StatusCode};
use serde::Deserialize;

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
                    "cma_owner_forbidden",
                    "当前账号没有使用该组织 CMA 的权限",
                ))
            }
        }
    }
    Ok(owner)
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Source {
    Personal,
    Org { org_id: String, allowed: bool },
}
#[derive(Deserialize)]
struct Connection {
    id: String,
    slug: String,
    catalog_service_id: Option<String>,
    is_active: bool,
    credential_source: Source,
}
#[derive(Deserialize)]
struct Connections {
    services: Vec<Connection>,
}

pub(super) fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "cma_proxy_unavailable",
        "暂时无法核对 CMA 连接，请保留原请求后重试",
    )
}
pub(super) fn authorization_required() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "cma_oauth_required",
        "请在 NyxID 授权此网页使用 CMA；原消息和请求编号已保留",
    )
}
pub(super) async fn connection(
    oauth: &OAuthService,
    token: &str,
    owner: &Owner,
) -> Result<String, ApiError> {
    let mut response = oauth
        .http
        .get(oauth.endpoint("/api/v1/user-services"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| unavailable())?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(authorization_required());
    }
    if !response.status().is_success() {
        return Err(unavailable());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(unavailable());
        }
        bytes.extend_from_slice(&chunk);
    }
    let connections: Connections = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    let mut matches = connections.services.into_iter().filter(|c| {
        c.slug == "cma"
            && c.catalog_service_id.is_some()
            && c.is_active
            && super::worker::identifier(&c.id)
            && match &c.credential_source {
                Source::Personal => !owner.org,
                Source::Org { org_id, allowed } => owner.org && *allowed && org_id == &owner.id,
            }
    });
    let found = matches.next().ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            "cma_connection_required",
            "当前空间归属尚未连接 CMA，请先在 NyxID 连接该个人或组织的 CMA 服务",
        )
    })?;
    if matches.next().is_some() {
        return Err(unavailable());
    }
    Ok(found.id)
}
