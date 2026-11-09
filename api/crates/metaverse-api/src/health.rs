//! 健康检查 `/api/healthz`（设计 13.1、14）：启动时先幂等地建索引，建完才返回 200。
//! chrono-cd 的存活探针每 15 秒检查一次、超时 5 秒，所以这里不做任何 IO。

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;
use utoipa::ToSchema;

use crate::AppState;

#[derive(Debug, Serialize, ToSchema)]
pub struct HealthView {
    /// `ok`，或启动中的 `starting`。
    pub status: String,
}

#[utoipa::path(
    get,
    path = "/api/healthz",
    operation_id = "healthz",
    tag = "health",
    responses(
        (status = 200, description = "可以接收请求", body = HealthView),
        (status = 503, description = "索引还没建好", body = HealthView),
    )
)]
pub async fn healthz(State(state): State<AppState>) -> impl IntoResponse {
    if state.is_ready() {
        (
            StatusCode::OK,
            Json(HealthView {
                status: "ok".into(),
            }),
        )
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthView {
                status: "starting".into(),
            }),
        )
    }
}
