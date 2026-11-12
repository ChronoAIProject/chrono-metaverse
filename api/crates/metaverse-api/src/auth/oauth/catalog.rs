//! Browser-only discovery and read access. No Agent or mutation credentials are issued.
use super::{routes, HeldCredential, OAuthError, OAuthService};
use crate::{
    auth::{Authorizer, Grant},
    error::ApiError,
    routes::ApiJson,
    AppState,
};
use axum::{
    extract::{Path, Request, State},
    http::HeaderMap,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use metaverse_core::model::{OrgRole, Owner};
use serde::Deserialize;
use serde_json::json;

pub(crate) struct BrowserIdentity {
    subject: String,
    credential: crate::auth::ForwardedCredential,
}
impl BrowserIdentity {
    pub(crate) fn subject(&self) -> &str {
        &self.subject
    }
    pub(crate) fn credential(&self) -> &crate::auth::ForwardedCredential {
        &self.credential
    }
}
/// Only the verified browser read middleware inserts this extension.
#[derive(Clone)]
pub(crate) struct BrowserViewerGrant(pub(crate) Grant);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListRequest {
    after: Option<String>,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<ListRequest>,
) -> Result<Response, ApiError> {
    if input
        .after
        .as_deref()
        .is_some_and(|id| !metaverse_core::ids::is_space_id(id))
    {
        return Err(ApiError::invalid("空间分页标记不正确"));
    }
    let oauth = routes::service(&state)?;
    let (session, held) = routes::verified_browser(&oauth, &headers).await?;
    let tokens = oauth.tokens(&held.record)?;
    let orgs = oauth.organizations(&tokens.access_token).await?;
    if orgs.len() > 100 {
        return Err(ApiError::invalid("组织数量超出当前空间列表上限"));
    }
    let identity = BrowserIdentity {
        subject: session.subject.clone(),
        credential: held.credential.clone(),
    };
    let owners = std::iter::once((Owner::person(session.subject.clone()), OrgRole::Admin))
        .chain(orgs.iter().map(|o| (Owner::org(o.id.clone()), o.role)))
        .collect();
    let scope = Authorizer::browser_catalog(&identity, owners);
    let mut items = state
        .repo
        .browser_spaces(&scope, input.after.as_deref(), 41)
        .await?;
    let next = if items.len() > 40 {
        items.truncate(40);
        items.last().map(|s| s.id.clone())
    } else {
        None
    };
    ensure_current(&oauth, &held).await?;
    Ok(Json(json!({"items":items,"next":next,"organizations":orgs})).into_response())
}
async fn ensure_current(oauth: &OAuthService, held: &HeldCredential) -> Result<(), ApiError> {
    if !oauth.current(held).await? {
        return Err(OAuthError::Reconnect.into());
    }
    Ok(())
}

pub(crate) async fn read(
    State(state): State<AppState>,
    Path(space_id): Path<String>,
    mut request: Request,
    next: Next,
) -> Response {
    async fn run(
        state: AppState,
        space_id: String,
        request: &mut Request,
        next: Next,
    ) -> Result<Response, ApiError> {
        let oauth = routes::service(&state)?;
        let (session, held) = routes::verified_browser(&oauth, request.headers()).await?;
        let identity = BrowserIdentity {
            subject: session.subject,
            credential: held.credential.clone(),
        };
        let grant = state.authorizer.browser_space(&identity, &space_id).await?;
        ensure_current(&oauth, &held).await?;
        request.extensions_mut().insert(BrowserViewerGrant(grant));
        let owned = std::mem::replace(request, Request::new(axum::body::Body::empty()));
        let response = next.run(owned).await;
        ensure_current(&oauth, &held).await?;
        Ok(response)
    }
    run(state, space_id, &mut request, next)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}
