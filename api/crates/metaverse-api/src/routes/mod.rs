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
    routing::{get, patch, post, put},
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
// 时间线与公开读分工。
pub mod admin_space_settings;
pub mod blob_response;
pub mod drafts;
pub mod previews;
pub mod public_timeline;
pub mod timeline;

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
        // 时间线与公开读分工：时间线读接口、草稿、管理接口。
        .route(
            "/api/v1/spaces/{space_id}/timeline",
            get(timeline::list_timeline),
        )
        .route(
            "/api/v1/spaces/{space_id}/snapshot",
            get(timeline::get_snapshot),
        )
        .route(
            "/api/v1/spaces/{space_id}/chunks/{hash}",
            get(timeline::get_chunk),
        )
        .route(
            "/api/v1/spaces/{space_id}/regions/{region_id}/content",
            get(timeline::get_region_content),
        )
        .merge(drafts::routes())
        .route(
            "/api/v1/admin/spaces/{space_id}",
            patch(admin_space_settings::update_space).delete(admin_space_settings::delete_space),
        )
        .route(
            "/api/v1/admin/spaces/{space_id}/share-tokens",
            post(admin_space_settings::rotate_share_token),
        )
        .route(
            "/api/v1/admin/spaces/{space_id}/layout",
            put(admin_space_settings::set_layout),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::auth::require_identity,
        ));
    let public = Router::new()
        .route(
            "/api/public/spaces/{space_id}",
            get(public_spaces::get_public_space),
        )
        // 时间线与公开读分工：快照、提交列表、区块、资源、草稿预览。
        .route(
            "/api/public/spaces/{space_id}/snapshot",
            get(public_timeline::get_public_snapshot),
        )
        .route(
            "/api/public/spaces/{space_id}/timeline",
            get(public_timeline::get_public_timeline),
        )
        .route(
            "/api/public/chunks/{file}",
            get(public_timeline::get_public_chunk),
        )
        .route(
            "/api/public/assets/{file}",
            get(public_timeline::get_public_asset),
        )
        .route("/api/public/previews", get(previews::get_preview))
        .route(
            "/api/public/previews/chunks/{hash}",
            get(previews::get_preview_chunk),
        )
        .route(
            "/api/public/previews/assets/{hash}",
            get(previews::get_preview_asset),
        )
        // 全部公开接口：按来源地址限流、每空间并发上限（设计 8.2）。
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::public::guard,
        ));
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
