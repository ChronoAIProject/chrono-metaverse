use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

use super::{crypto, seconds, OAuthError, OAuthService, STORE};
use crate::{error::ApiError, repo::OAuthSessionRecord, AppState};

const ROOT: &str = "/api/auth/nyxid";
const FLOW_COOKIE: &str = "mv_nyx_flow";
const SESSION_COOKIE: &str = "mv_nyx_session";
const SESSION_TTL: i64 = 30 * 24 * 60 * 60;

pub fn router(state: AppState) -> Router<AppState> {
    Router::new()
        .route("/api/auth/nyxid/login", get(login))
        .route("/api/auth/nyxid/callback", get(callback))
        .route("/api/auth/nyxid/session", get(session))
        .route("/api/auth/nyxid/disconnect", post(disconnect))
        .route_layer(axum::middleware::from_fn_with_state(
            state,
            crate::public::guard,
        ))
        .layer(axum::middleware::from_fn(
            |request: axum::extract::Request, next: axum::middleware::Next| async move {
                private(next.run(request).await)
            },
        ))
}

impl From<OAuthError> for ApiError {
    fn from(error: OAuthError) -> Self {
        match error {
            OAuthError::Reconnect => Self::new(
                StatusCode::UNAUTHORIZED,
                "nyxid_reconnect_required",
                "请重新连接 NyxID",
            ),
            OAuthError::Unavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "nyxid_oauth_unavailable",
                "NyxID 授权服务暂时不可用，请稍后重试",
            ),
        }
    }
}

fn service(state: &AppState) -> Result<Arc<OAuthService>, ApiError> {
    state.oauth.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "nyxid_oauth_disabled",
            "尚未配置 NyxID 授权",
        )
    })
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<Zeroizing<String>> {
    let mut found = None;
    for value in headers.get_all(header::COOKIE) {
        for pair in value.to_str().ok()?.split(';') {
            let (key, value) = pair.trim().split_once('=')?;
            if key == name {
                if found.is_some()
                    || value.len() != 43
                    || !value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                {
                    return None;
                }
                found = Some(Zeroizing::new(value.to_owned()));
            }
        }
    }
    found
}

fn set_cookie(response: &mut Response, name: &str, value: &str, ttl: i64, secure: bool) {
    let text = format!(
        "{name}={value}; Path={ROOT}; HttpOnly; SameSite=Lax; Max-Age={ttl}{}",
        if secure { "; Secure" } else { "" }
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&text).expect("server-generated cookie"),
    );
}

fn private(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

async fn login(State(state): State<AppState>) -> Result<Response, ApiError> {
    let oauth = service(&state)?;
    let verifier = Zeroizing::new(crypto::random()?);
    let state = crypto::random()?;
    let browser = Zeroizing::new(crypto::random()?);
    let id = crypto::digest(&state);
    let browser_hash = crypto::digest(&browser);
    let aad = format!("{}/flow/{id}/{browser_hash}", oauth.namespace);
    let sealed = oauth.vault.seal(verifier.as_bytes(), &aad)?;
    oauth
        .repo
        .oauth_flow_put(&STORE, &id, &browser_hash, &sealed, seconds()? + 600)
        .await?;
    let mut url = oauth.endpoint("/oauth/authorize");
    url.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", oauth.config.client_id.as_str()),
        ("redirect_uri", oauth.config.redirect_uri.as_str()),
        ("scope", "openid offline_access"),
        ("state", state.as_str()),
        ("code_challenge", crypto::digest(&verifier).as_str()),
        ("code_challenge_method", "S256"),
    ]);
    let mut response = Redirect::to(url.as_str()).into_response();
    set_cookie(
        &mut response,
        FLOW_COOKIE,
        &browser,
        600,
        oauth.config.secure_cookie,
    );
    Ok(private(response))
}

#[derive(Deserialize)]
struct Callback {
    state: String,
    code: Option<String>,
    error: Option<String>,
}
impl Drop for Callback {
    fn drop(&mut self) {
        if let Some(code) = &mut self.code {
            code.zeroize();
        }
    }
}

async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<Callback>,
) -> Result<Response, ApiError> {
    let oauth = service(&state)?;
    if query.state.len() != 43 {
        return Err(ApiError::invalid("NyxID 授权请求已失效，请重新连接"));
    }
    let browser = cookie(&headers, FLOW_COOKIE)
        .ok_or_else(|| ApiError::invalid("NyxID 授权请求已失效，请重新连接"))?;
    let id = crypto::digest(&query.state);
    let browser_hash = crypto::digest(&browser);
    let sealed = oauth
        .repo
        .oauth_flow_take(&STORE, &id, &browser_hash, seconds()?)
        .await?
        .ok_or_else(|| ApiError::invalid("NyxID 授权请求已失效，请重新连接"))?;
    if query.error.is_some() {
        let mut response = Redirect::to("/connect?error=denied").into_response();
        set_cookie(
            &mut response,
            FLOW_COOKIE,
            "",
            0,
            oauth.config.secure_cookie,
        );
        return Ok(private(response));
    }
    let verifier = oauth.vault.open(
        &sealed,
        &format!("{}/flow/{id}/{browser_hash}", oauth.namespace),
    )?;
    let verifier = std::str::from_utf8(&verifier).map_err(|_| OAuthError::Unavailable)?;
    let code = query
        .code
        .as_deref()
        .filter(|v| !v.is_empty() && v.len() <= 4096)
        .ok_or(OAuthError::Reconnect)?;
    let mut tokens = oauth.exchange(code, verifier).await?;
    // userinfo 使用 provider 实时验证后的主体，不信任未验签 ID token 或浏览器自报 user_id。
    let subject = oauth.subject(&tokens.access_token).await?;
    tokens.subject_verified = true;
    let record = oauth.sealed(&subject, &crypto::random()?, &tokens)?;
    oauth.repo.oauth_grant_put(&STORE, &record).await?;
    let session = Zeroizing::new(crypto::random()?);
    oauth
        .repo
        .oauth_session_put(
            &STORE,
            &crypto::digest(&session),
            &record,
            seconds()? + SESSION_TTL,
        )
        .await?;
    let mut response = Redirect::to("/connect").into_response();
    set_cookie(
        &mut response,
        FLOW_COOKIE,
        "",
        0,
        oauth.config.secure_cookie,
    );
    set_cookie(
        &mut response,
        SESSION_COOKIE,
        &session,
        SESSION_TTL,
        oauth.config.secure_cookie,
    );
    Ok(private(response))
}

impl OAuthService {
    async fn browser_session(&self, raw: &str) -> Result<Option<OAuthSessionRecord>, OAuthError> {
        let Some(session) = self
            .repo
            .oauth_session_get(&STORE, &crypto::digest(raw), seconds()?)
            .await?
        else {
            return Ok(None);
        };
        let Some(record) = self.repo.oauth_grant_get(&STORE, &session.grant_id).await? else {
            return Ok(None);
        };
        if record.subject != session.subject
            || record.incarnation != session.incarnation
            || record.id != self.grant_id(&session.subject)
        {
            return Ok(None);
        }
        Ok(Some(session))
    }
}

async fn session(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    let Some(oauth) = state.oauth else {
        return Ok(private(
            Json(json!({"enabled":false,"connected":false})).into_response(),
        ));
    };
    let raw = cookie(&headers, SESSION_COOKIE);
    let session = match raw.as_ref() {
        Some(raw) => oauth.browser_session(raw).await?,
        None => None,
    };
    Ok(private(Json(match session {
        Some(session)=>json!({"enabled":true,"connected":true,"subject":session.subject,"csrfToken":crypto::digest(&format!("csrf/{}",raw.as_ref().unwrap().as_str()))}),
        None=>json!({"enabled":true,"connected":false}),
    }).into_response()))
}

async fn disconnect(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let oauth = service(&state)?;
    let raw = cookie(&headers, SESSION_COOKIE).ok_or_else(ApiError::forbidden)?;
    let expected = crypto::digest(&format!("csrf/{}", raw.as_str()));
    let csrf = headers
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
        != Some(oauth.config.origin.as_str())
        || !bool::from(csrf.as_bytes().ct_eq(expected.as_bytes()))
    {
        return Err(ApiError::forbidden());
    }
    let session = oauth
        .browser_session(&raw)
        .await?
        .ok_or_else(ApiError::forbidden)?;
    // 先本地失效：刷新和正在进行的组织查询都须通过版本围栏。不会退出用户其他应用。
    oauth.repo.oauth_disconnect(&STORE, &session).await?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    set_cookie(
        &mut response,
        SESSION_COOKIE,
        "",
        0,
        oauth.config.secure_cookie,
    );
    Ok(private(response))
}
