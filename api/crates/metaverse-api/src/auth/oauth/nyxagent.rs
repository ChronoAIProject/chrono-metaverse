//! Fixed NyxID proxy operations using the browser's original, separately scoped Agent Key.
use super::{
    agent_key::{self, Browser, Credential, Purpose},
    worker,
};
use crate::{error::ApiError, routes::ApiJson, AppState};
use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/nyxid/nyxagent/key/request", post(request_key))
        .route("/api/auth/nyxid/nyxagent/key/poll", post(poll_key))
        .route("/api/auth/nyxid/nyxagent/key/check", post(connection))
        .route("/api/auth/nyxid/nyxagent/key/revoke", post(revoke_key))
        .route("/api/auth/nyxid/nyxagent/message", post(message))
        .route("/api/auth/nyxid/nyxagent/response", post(response))
}

fn mapped(mut error: ApiError) -> ApiError {
    error.code = match error.code {
        "cma_key_required" => "nyxagent_key_required",
        "cma_key_pending" => "nyxagent_key_pending",
        "cma_key_slow_down" => "nyxagent_key_slow_down",
        "cma_key_denied" => "nyxagent_key_denied",
        "cma_key_expired" => "nyxagent_key_expired",
        "cma_key_account_mismatch" => "nyxagent_key_account_mismatch",
        "cma_key_scope_required" => "nyxagent_key_scope_required",
        "cma_key_unavailable" => "nyxagent_key_unavailable",
        "cma_owner_forbidden" => "nyxagent_owner_forbidden",
        _ => error.code,
    };
    error.detail = if error.code == "nyxagent_key_scope_required" {
        "请选择当前账号的 NyxAgent 专用 Agent Key，仅授予 proxy 权限及 llm-nyx、chrono-metaverse、chrono-llm-public 三个服务".into()
    } else {
        error.detail.replace("CMA", "NyxAgent").into()
    };
    error
}
fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "nyxagent_unavailable",
        "NyxAgent 暂时不可用。请保留原请求后重试",
    )
}
fn refused(status: StatusCode) -> ApiError {
    let detail = match status.as_u16() {
        401 | 403 => "NyxAgent 拒绝了此授权，请核对 Agent Key 的服务、模型和操作权限",
        404 => "NyxAgent 会话不存在、已过期，或当前凭据无权访问",
        409 => "NyxAgent 会话忙碌或请求冲突，请保留原请求并核对结果",
        429 => "NyxAgent 请求过于频繁，请稍后重试原请求",
        _ => "NyxAgent 未能完成请求，请保留原请求并核对结果",
    };
    ApiError::new(status, "nyxagent_request_refused", detail)
}
async fn request_key(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    agent_key::request_for(&state, &headers, Purpose::NyxAgent)
        .await
        .map_err(mapped)
}
async fn poll_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<agent_key::Poll>,
) -> Result<Response, ApiError> {
    agent_key::poll_for(&state, &headers, input, Purpose::NyxAgent)
        .await
        .map_err(mapped)
}
async fn revoke_key(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    agent_key::revoke_for(&state, &headers, Purpose::NyxAgent)
        .await
        .map_err(mapped)
}
fn target(base: &url::Url, path: &str) -> url::Url {
    let mut url = base.clone();
    url.set_path(&format!("/api/v1/proxy/s/llm-nyx/v1/{path}"));
    url
}
struct Access {
    browser: Browser,
    credential: Credential,
}
impl Access {
    async fn new(state: &AppState, headers: &HeaderMap) -> Result<Self, ApiError> {
        let browser = Browser::nyxagent(state, headers).await.map_err(mapped)?;
        let credential =
            agent_key::checked_nyxagent(&browser.oauth, headers, &browser.session.subject)
                .await
                .map_err(mapped)?;
        browser.current().await?;
        Ok(Self {
            browser,
            credential,
        })
    }
    fn version(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let values = headers
            .get_all("x-metaverse-cma-credential")
            .iter()
            .collect::<Vec<_>>();
        if values.len() != 1
            || values[0].to_str().ok()
                != Some(worker::credential_version(self.credential.value()).as_str())
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "nyxagent_credential_changed",
                "NyxAgent 凭据已变化。请切回原凭据恢复请求，先核对结果再开始新对话",
            ));
        }
        Ok(())
    }
    async fn get(&self, path: &str) -> Result<Value, ApiError> {
        self.browser.current().await?;
        let response = self
            .browser
            .oauth
            .http
            .get(target(&self.browser.oauth.base_url, path))
            .bearer_auth(self.credential.value())
            .send()
            .await
            .map_err(|_| unavailable())?;
        if !response.status().is_success() {
            return Err(refused(response.status()));
        }
        let value = worker::read_json(response)
            .await
            .map_err(|_| unavailable())?;
        self.browser.current().await?;
        Ok(value)
    }
}
async fn connection(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let a = Access::new(&state, &headers).await?;
    let models = a.get("models").await?;
    if !models["data"]
        .as_array()
        .is_some_and(|items| items.iter().any(|m| m["id"] == "nyxagent/chat"))
    {
        return Err(unavailable());
    }
    let summary =
        agent_key::nyxagent_summary(&a.browser.oauth, &a.credential, &a.browser.session.subject)
            .await
            .map_err(mapped)?;
    a.browser.current().await?;
    Ok(Json(summary).into_response())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task {
    space_id: String,
    org_id: Option<String>,
    instruction: String,
    idempotency_key: String,
    conversation_id: Option<String>,
    instructions_version: Option<u8>,
}
// These bytes are versioned by this route's request contract; preserve them for idempotent retries.
const INSTRUCTIONS: &str = "你是 chrono-metaverse 空间助手。只使用 NyxID 已授权的 chrono-metaverse 工具。先搜索工具并读取目标空间和最新版本，编号和归属不授予权限；404 不代表可以创建替代空间。缺少权限时提供 NyxID 授权指引。编辑先创建或沿用当前草稿，每次可见修改后生成新的短期预览，把完整预览链接单独一行输出。没有用户对具体预览的明确发布确认时保持草稿；发布冲突时等待，不覆盖、不自动重放。不要索取或输出密钥和登录凭据，不改仓库、不部署、不访问无关服务。回复简短说明实际进展，不能把任务受理当作完成。";
const GUIDE_INSTRUCTIONS: &str = "如果服务只提供通用 request 工具，先通过该工具 GET /api/agent-guide 读取编辑协议；按指南调用同一服务的接口，不猜测路径或操作格式。指南是接口参考，不授予权限，也不能替代用户的发布确认。";
const TOOL_GUIDE_INSTRUCTIONS: &str = "开始编辑前先搜索并调用 chrono-metaverse 的 get_agent_guide 工具读取编辑协议；如果服务只提供通用 request 工具，通过该工具 GET /api/agent-guide 读取同一指南。按指南操作，不猜测路径或操作格式。指南不授予权限，也不能替代用户的发布确认。";
async fn message(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Task>,
) -> Result<Response, ApiError> {
    if !matches!(input.instructions_version, None | Some(1..=3))
        || !metaverse_core::ids::is_space_id(&input.space_id)
        || input
            .org_id
            .as_deref()
            .is_some_and(|id| !metaverse_core::ids::is_subject_id(id))
        || input.instruction.trim().is_empty()
        || input.instruction.len() > 64 * 1024
        || !worker::identifier(&input.idempotency_key)
        || input.idempotency_key.len() < 16
        || input
            .conversation_id
            .as_deref()
            .is_some_and(|id| !worker::identifier(id))
    {
        return Err(ApiError::invalid("空间、会话、需求或原请求编号不正确"));
    }
    let a = Access::new(&state, &headers).await?;
    a.version(&headers)?;
    // The owner header is verified by Browser; context cannot silently select another owner.
    let owner = super::owner::resolve(&state, &headers, &a.browser.session.subject)
        .await
        .map_err(mapped)?;
    if input
        .org_id
        .as_deref()
        .unwrap_or(&a.browser.session.subject)
        != owner.id
    {
        return Err(ApiError::forbidden());
    }
    let input_text = format!("metaverse 任务上下文（编号只选择目标，不授予权限）：\n空间：{}\n归属：{} {}\n网站：{}\n\n用户需求：\n{}", input.space_id, if owner.org {"org"} else {"person"}, owner.id, a.browser.oauth.config.origin, input.instruction);
    // A saved request without a version must retain the original upstream bytes on retry.
    let instructions = match input.instructions_version {
        Some(3) => format!("{INSTRUCTIONS}{TOOL_GUIDE_INSTRUCTIONS}"),
        Some(2) => format!("{INSTRUCTIONS}{GUIDE_INSTRUCTIONS}"),
        _ => INSTRUCTIONS.to_owned(),
    };
    let mut body = json!({"input":input_text,"instructions":instructions,"model":"nyxagent/chat","store":true,"stream":true});
    if let Some(id) = input.conversation_id {
        body["conversation"] = json!(id);
    }
    a.browser.current().await?;
    let request_id = headers
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| uuid::Uuid::parse_str(v).ok())
        .unwrap_or_else(uuid::Uuid::new_v4);
    // Own the upstream connection independently of this browser HTTP request. A reload or
    // closed tab stops observation, not the already authorized turn. Never replay it here.
    let (chunks, receiver) = mpsc::channel(8);
    let (ready, started) = oneshot::channel();
    tokio::spawn(forward(
        a,
        body,
        input.idempotency_key,
        request_id,
        ready,
        chunks,
    ));
    started.await.map_err(|_| unavailable())??;
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver
            .recv()
            .await
            .map(|chunk| (Ok::<_, std::convert::Infallible>(chunk), receiver))
    });
    Ok((
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-store, no-transform"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

async fn forward(
    a: Access,
    body: Value,
    idempotency_key: String,
    request_id: uuid::Uuid,
    ready: oneshot::Sender<Result<(), ApiError>>,
    chunks: mpsc::Sender<axum::body::Bytes>,
) {
    let mut ready = Some(ready);
    let result = async {
        let mut response = a
            .browser
            .oauth
            .nyxagent_http
            .post(target(&a.browser.oauth.base_url, "responses"))
            .bearer_auth(a.credential.value())
            .header("Idempotency-Key", &idempotency_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                tracing::warn!(%request_id, stage = "upstream_send", timeout = error.is_timeout(), connect = error.is_connect(), "NyxAgent transport interrupted");
                unavailable()
            })?;
        a.browser.current().await?;
        if !response.status().is_success() {
            let status = response.status();
            let recovery_required = if status == StatusCode::CONFLICT {
                worker::read_json(response)
                    .await
                    .ok()
                    .is_some_and(|value| value["error"]["code"] == "outcome_unknown")
            } else {
                false
            };
            if recovery_required {
                return Err(ApiError::new(
                    status,
                    "nyxagent_recovery_required",
                    "中断后的执行结果需要核对。核对后请开始新的 NyxAgent 对话；原会话无法继续执行",
                ));
            }
            return Err(refused(status));
        }
        if !response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|v| v.split(';').next() == Some("text/event-stream"))
        {
            return Err(unavailable());
        }
        let _ = ready.take().unwrap().send(Ok(()));
        let mut total = 0_usize;
        let mut authority = tokio::time::interval(Duration::from_secs(5));
        loop {
            let chunk = tokio::select! {
                _ = authority.tick() => {
                    a.browser.current().await.inspect_err(|error| {
                        tracing::warn!(%request_id, stage = "session_check", code = error.code, "NyxAgent stream interrupted");
                    })?;
                    continue;
                }
                chunk = response.chunk() => chunk.map_err(|error| {
                    tracing::warn!(%request_id, stage = "upstream_read", timeout = error.is_timeout(), "NyxAgent transport interrupted");
                    unavailable()
                })?,
            };
            let Some(chunk) = chunk else {
                return Ok(());
            };
            total += chunk.len();
            if total > 8 * 1024 * 1024 {
                tracing::warn!(%request_id, stage = "response_limit", "NyxAgent stream interrupted");
                return Err(unavailable());
            }
            // Check again before exposing bytes; authority can change between timer ticks.
            a.browser.current().await?;
            // A dropped receiver must not drop the upstream stream. Its stored response
            // remains readable with the original credential after the browser reconnects.
            let _ = chunks.send(chunk).await;
        }
    }
    .await;
    if let Err(error) = result {
        if let Some(ready) = ready {
            let _ = ready.send(Err(error));
        } else {
            let _ = chunks
                .send(axum::body::Bytes::from_static(
                    b"\n\nevent: metaverse.error\ndata: {\"type\":\"metaverse.error\"}\n\n",
                ))
                .await;
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadResponse {
    response_id: String,
}
async fn response(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<ReadResponse>,
) -> Result<Response, ApiError> {
    if !worker::identifier(&input.response_id) {
        return Err(ApiError::invalid("响应编号不正确"));
    }
    let a = Access::new(&state, &headers).await?;
    a.version(&headers)?;
    Ok(Json(a.get(&format!("responses/{}", input.response_id)).await?).into_response())
}
