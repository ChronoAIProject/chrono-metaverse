//! Fixed browser-to-CMA operations; CMA owns runtime credentials and resource ACL.
use super::{routes, seconds, HeldCredential, OAuthError, OAuthService, STORE};
use crate::{error::ApiError, repo::OAuthSessionRecord, routes::ApiJson, AppState};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/nyxid/worker/consent", post(consent))
        .route("/api/auth/nyxid/worker/agents", post(agents))
        .route("/api/auth/nyxid/worker/create", post(create))
        .route("/api/auth/nyxid/worker/observe", post(observe))
        .route("/api/auth/nyxid/worker/message", post(message))
        .route("/api/auth/nyxid/worker/response", post(response))
        .route("/api/auth/nyxid/worker/cancel", post(cancel))
}
fn identifier(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 256
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn validate_id(v: &str) -> Result<(), ApiError> {
    if identifier(v) {
        Ok(())
    } else {
        Err(ApiError::invalid("任务或 worker 编号不正确"))
    }
}
fn validate_key(v: &str) -> Result<(), ApiError> {
    if identifier(v) && v.len() >= 16 {
        Ok(())
    } else {
        Err(ApiError::invalid("请保留原请求的幂等编号"))
    }
}
fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "cma_unavailable",
        "CMA 暂时无法响应，请保留当前任务后重试",
    )
}
struct Access {
    oauth: Arc<OAuthService>,
    session: OAuthSessionRecord,
    held: HeldCredential,
}
impl Access {
    async fn new(
        state: &AppState,
        headers: &HeaderMap,
        require_consent: bool,
    ) -> Result<Self, ApiError> {
        let oauth = routes::service(state)?;
        if oauth.config.cma_base_url.is_none() {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "cma_disabled",
                "此部署尚未启用在线 worker",
            ));
        }
        let (session, held) = routes::verified_browser(&oauth, headers).await?;
        let access = Self {
            oauth,
            session,
            held,
        };
        access.current(require_consent).await?;
        Ok(access)
    }
    async fn current(&self, require_consent: bool) -> Result<(), ApiError> {
        if !self.oauth.current(&self.held).await? {
            return Err(OAuthError::Reconnect.into());
        }
        let session = self
            .oauth
            .repo
            .oauth_session_get(&STORE, &self.session.id, seconds()?)
            .await?
            .filter(|s| {
                s.subject == self.session.subject && s.incarnation == self.session.incarnation
            })
            .ok_or(OAuthError::Reconnect)?;
        if require_consent
            && (!session.worker_enabled
                || session.worker_consent_version.is_none()
                || session.worker_consent_version != self.session.worker_consent_version)
        {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "cma_consent_required",
                "请先同意此浏览器调用 CMA",
            ));
        }
        Ok(())
    }
    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        key: Option<&str>,
    ) -> Result<reqwest::Response, ApiError> {
        self.current(true).await?;
        let tokens = self.oauth.tokens(&self.held.record)?;
        let url = format!("{}{path}", self.oauth.config.cma_base_url.as_ref().unwrap());
        let mut request = self
            .oauth
            .http
            .request(method.clone(), url)
            .bearer_auth(&tokens.access_token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(key) = key {
            request = request.header("Idempotency-Key", key);
        }
        let response = request.send().await.map_err(|_| {
            if method == reqwest::Method::GET {
                unavailable()
            } else {
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "cma_outcome_unknown",
                    "结果尚未确认。请核对进度或使用原编号重试；不要重复创建任务",
                )
            }
        })?;
        self.current(true).await?;
        Ok(response)
    }
    async fn json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        key: Option<&str>,
    ) -> Result<(StatusCode, Value), ApiError> {
        let response = self.send(method, path, body, key).await?;
        let status = response.status();
        let value = read_json(response).await?;
        self.current(true).await?;
        if !status.is_success() {
            return Err(refusal(status, &value));
        }
        Ok((status, value))
    }
    // Request text is part of CMA idempotency: retain these v1 bytes for retries.
    fn task(&self, c: &Context, instruction: &str) -> Result<String, ApiError> {
        if !metaverse_core::ids::is_space_id(&c.space_id)
            || c.org_id
                .as_deref()
                .is_some_and(|id| !metaverse_core::ids::is_subject_id(id))
            || instruction.trim().is_empty()
            || instruction.len() > 32 * 1024
        {
            return Err(ApiError::invalid(
                "请填写有效空间编号、组织编号和不超过 32 KiB 的需求",
            ));
        }
        let owner = c
            .org_id
            .as_deref()
            .map(|id| format!("org {id}"))
            .unwrap_or_else(|| format!("person {}", self.session.subject));
        Ok(format!("metaverse 任务上下文（编号只选择目标，不授予权限）：\n空间：{}\n归属：{}\n网站：{}\n\n用户需求：\n{}", c.space_id, owner, self.oauth.config.origin, instruction))
    }
}
async fn read_json(mut response: reqwest::Response) -> Result<Value, ApiError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err(unavailable());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| unavailable())
}
fn refusal(status: StatusCode, body: &Value) -> ApiError {
    let code = body
        .get("code")
        .and_then(Value::as_str)
        .or_else(|| body.pointer("/error/code").and_then(Value::as_str));
    if code == Some("sandbox_credential_setup_required") {
        return ApiError::new(
            StatusCode::CONFLICT,
            "cma_setup_required",
            "请先用相同 NyxID 账号登录 CMA 完成运行环境授权，再明确重试创建",
        );
    }
    let detail = match status.as_u16() {
        401 => "CMA 未接受当前登录，请重新连接 NyxID",
        403 => "当前账号没有此 CMA 操作的权限",
        404 => "CMA 资源不存在，或当前账号无权访问",
        409 => "CMA 请求发生冲突，请核对当前状态后恢复原请求",
        429 => "CMA 请求过于频繁，请稍后重试原请求",
        _ => "CMA 未能完成请求，请到 CMA 核对状态并保留原请求编号",
    };
    ApiError::new(status, "cma_request_refused", detail)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Consent {
    enabled: bool,
}
async fn consent(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Consent>,
) -> Result<Response, ApiError> {
    let a = Access::new(&state, &headers, false).await?;
    if !a
        .oauth
        .repo
        .oauth_worker_consent(&STORE, &a.session, input.enabled, seconds()?)
        .await?
    {
        return Err(OAuthError::Reconnect.into());
    }
    a.current(false).await?;
    Ok(Json(json!({"workerEnabled":input.enabled})).into_response())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct List {
    cursor: Option<String>,
}
async fn agents(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<List>,
) -> Result<Response, ApiError> {
    let a = Access::new(&state, &headers, true).await?;
    let mut path = "/api/v1/agents?limit=50".to_owned();
    if let Some(cursor) = input.cursor {
        if cursor.is_empty() || cursor.len() > 2048 || cursor.chars().any(char::is_control) {
            return Err(ApiError::invalid("分页标记不正确"));
        }
        path.push_str("&cursor=");
        path.push_str(&url::form_urlencoded::byte_serialize(cursor.as_bytes()).collect::<String>());
    }
    let (_, v) = a.json(reqwest::Method::GET, &path, None, None).await?;
    Ok(Json(v).into_response())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Context {
    space_id: String,
    org_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task {
    context: Context,
    instruction: String,
    idempotency_key: String,
    agent_id: Option<String>,
}
async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Task>,
) -> Result<Response, ApiError> {
    if input.agent_id.is_some() {
        return Err(ApiError::invalid("新建任务不能指定已有 worker"));
    }
    validate_key(&input.idempotency_key)?;
    let a = Access::new(&state, &headers, true).await?;
    let task = a.task(&input.context, &input.instruction)?;
    let prompt=format!("你是 chrono-metaverse 在线建造 worker。通过运行环境已有的 NyxID 服务工具访问 chrono-metaverse；先读取 {}/api/openapi.json 核实接口，不猜测路径或格式。先读目标空间及最新版本，404 不代表空间一定不存在，不得据此自行建空间。只有用户明确要求新建且已有相应权限时才可 POST /api/v1/admin/spaces，请求为 {{id,name,description,owner:{{kind:person或org,id}},visibility:unlisted或public}}，默认 unlisted；随后再按用户需求创建或编辑草稿，产出短期三维预览链接，说明具体修改并等待用户明确要求发布。后续修改继续当前草稿；发布冲突须说明，不自动覆盖或重放。已有空间沿用接口返回的真实归属，任务中的归属仅用于新建空间；建空间时严格使用任务指定归属；组织编号不代表权限。无服务权限时走 CMA 服务申请/用户授权流程，等待实际凭据更新；不使用用户 OAuth 令牌、不索取密钥、不绕过 NyxID。不要改仓库、部署或访问无关服务。将完整空间、组合或预览链接单独输出。已受理上传/展开任务须等实际完成，不能把 202 当作发布成功。",a.oauth.config.origin);
    let name = format!(
        "metaverse / {}",
        input.context.space_id.chars().take(40).collect::<String>()
    );
    let body = json!({"name":name,"initial_message":task,"profile":{"permissions":{"services":["chrono-metaverse"]},"system_prompt":prompt}});
    let (s, v) = a
        .json(
            reqwest::Method::POST,
            "/api/v1/agents",
            Some(body),
            Some(&input.idempotency_key),
        )
        .await?;
    Ok((s, Json(v)).into_response())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observe {
    agent_id: Option<String>,
    operation_id: Option<String>,
}
async fn observe(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Observe>,
) -> Result<Response, ApiError> {
    let a = Access::new(&state, &headers, true).await?;
    match (input.operation_id, input.agent_id) {
        (Some(id), None) => {
            validate_id(&id)?;
            let (_, v) = a
                .json(
                    reqwest::Method::GET,
                    &format!("/api/v1/agent-lifecycle/{id}"),
                    None,
                    None,
                )
                .await?;
            Ok(Json(json!({"operation":v})).into_response())
        }
        (None, Some(id)) => {
            validate_id(&id)?;
            let (_, agent) = a
                .json(
                    reqwest::Method::GET,
                    &format!("/api/v1/agents/{id}"),
                    None,
                    None,
                )
                .await?;
            let (_, transcript) = a
                .json(
                    reqwest::Method::GET,
                    &format!("/api/v1/agents/{id}/transcript"),
                    None,
                    None,
                )
                .await?;
            Ok(Json(json!({"agent":agent,"transcript":transcript})).into_response())
        }
        _ => Err(ApiError::invalid("每次请选择一个 worker 或创建任务")),
    }
}
async fn message(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Task>,
) -> Result<Response, ApiError> {
    validate_key(&input.idempotency_key)?;
    let id = input
        .agent_id
        .as_deref()
        .ok_or_else(|| ApiError::invalid("请选择 worker"))?;
    validate_id(id)?;
    let a = Access::new(&state, &headers, true).await?;
    let task = a.task(&input.context, &input.instruction)?;
    let r = a
        .send(
            reqwest::Method::POST,
            &format!("/api/v2/agents/{id}/responses"),
            Some(json!({"input":task,"stream":true})),
            Some(&input.idempotency_key),
        )
        .await?;
    if !r.status().is_success() {
        let s = r.status();
        return Err(refusal(s, &read_json(r).await?));
    }
    let get_id = |name| {
        r.headers()
            .get(name)
            .and_then(|h| h.to_str().ok())
            .filter(|id| identifier(id))
            .map(str::to_owned)
    };
    let response_id = get_id("x-cma-response-id").ok_or_else(unavailable)?;
    let command_id = get_id("x-cma-command-id").ok_or_else(unavailable)?;
    a.current(true).await?;
    // Closing observation does not cancel the durably admitted CMA command.
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"responseId":response_id,"commandId":command_id})),
    )
        .into_response())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResponseRequest {
    agent_id: String,
    response_id: String,
}
async fn response(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<ResponseRequest>,
) -> Result<Response, ApiError> {
    validate_id(&input.response_id)?;
    validate_id(&input.agent_id)?;
    let a = Access::new(&state, &headers, true).await?;
    let p = format!("/api/v2/responses/{}", input.response_id);
    let (_, response) = a.json(reqwest::Method::GET, &p, None, None).await?;
    let (_, controls) = a
        .json(
            reqwest::Method::GET,
            &format!(
                "/api/v2/agents/{}/responses/{}/controls",
                input.agent_id, input.response_id
            ),
            None,
            None,
        )
        .await?;
    Ok(Json(json!({"response":response,"controls":controls})).into_response())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cancel {
    agent_id: String,
    response_id: String,
    turn_sequence: u64,
    agent_revision: u64,
    idempotency_key: String,
}
async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Cancel>,
) -> Result<Response, ApiError> {
    validate_id(&input.response_id)?;
    validate_id(&input.agent_id)?;
    validate_key(&input.idempotency_key)?;
    let a = Access::new(&state, &headers, true).await?;
    let body = json!({"turn_sequence":input.turn_sequence,"expected_agent_revision":input.agent_revision,"command":{"type":"cancel"}});
    let (s, v) = a
        .json(
            reqwest::Method::POST,
            &format!(
                "/api/v2/agents/{}/responses/{}/controls",
                input.agent_id, input.response_id
            ),
            Some(body),
            Some(&input.idempotency_key),
        )
        .await?;
    Ok((s, Json(v)).into_response())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_cannot_switch_destinations_or_paths() {
        for id in [
            "../admin",
            "x?org=other",
            "%2f",
            "x/y",
            "x\\y",
            "https://evil.test",
            "",
            "a\n",
        ] {
            assert!(!identifier(id));
        }
        assert!(identifier("agt_01-a"));
    }
}
