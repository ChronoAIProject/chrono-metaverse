//! 路由装配（设计 8.1 的三组接口）。
//!
//! - `/api/public/*`：公开读，不经过 NyxID；
//! - `/api/v1/*`：写和给 AI 的读，经 NyxID 代理，先过身份中间件；
//! - `/api/v1/admin/*`：管理接口，同样先过身份中间件，资源级要求"管理"。
//!
//! 索引建好之前，除健康检查和 OpenAPI 外一律返回 503。

use std::time::Duration;

use axum::{
    extract::{DefaultBodyLimit, FromRequest, Request, State},
    http::HeaderName,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use tower_http::{
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

pub mod admin_spaces;
pub mod public_spaces;
pub mod spaces;
pub mod views;

use crate::error::{self, ApiError};
use crate::AppState;

/// JSON 请求体上限（设计 8.5：JSON ≤ 8MB）。
pub const JSON_BODY_LIMIT: usize = 8 * 1024 * 1024;
/// 单个请求的处理时限：平台网络层约 100 秒无响应就断开，长操作一律做成任务。
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

const X_REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

/// JSON 请求体提取器：解析失败时返回统一的错误格式。
#[derive(FromRequest)]
#[from_request(via(axum::Json), rejection(ApiError))]
pub struct ApiJson<T>(pub T);

async fn require_ready(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if state.is_ready() {
        next.run(request).await
    } else {
        ApiError::starting().into_response()
    }
}

pub fn router(state: AppState) -> Router {
    let v1 = Router::new()
        .route("/api/v1/spaces/{space_id}", get(spaces::get_space))
        .route("/api/v1/admin/spaces", post(admin_spaces::create_space))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::auth::require_identity,
        ));
    let public = Router::new().route(
        "/api/public/spaces/{space_id}",
        get(public_spaces::get_public_space),
    );
    let gated = v1
        .merge(public)
        .route_layer(middleware::from_fn_with_state(state.clone(), require_ready));
    Router::new()
        .route("/api/healthz", get(crate::health::healthz))
        .route("/api/openapi.json", get(crate::openapi::serve))
        .merge(gated)
        .fallback(error::not_found)
        .with_state(state)
        .layer(DefaultBodyLimit::max(JSON_BODY_LIMIT))
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::GATEWAY_TIMEOUT,
            REQUEST_TIMEOUT,
        ))
        // 与 CMA 相同：每个请求带 x-request-id，日志里只记方法、路径和状态，不记请求头。
        .layer(TraceLayer::new_for_http())
        .layer(PropagateRequestIdLayer::new(X_REQUEST_ID))
        .layer(SetRequestIdLayer::new(X_REQUEST_ID, MakeRequestUuid))
}
