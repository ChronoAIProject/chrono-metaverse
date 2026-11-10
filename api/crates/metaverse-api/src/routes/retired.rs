//! 已下线的接口（docs/design/server-slim.md 2.1）：处理服务下线以后，扫描导入、按给定变换重新导入、
//! 重跑重建、体素化、物件模型重新导出都改在本地完成，打成重建包后经重建路径（`/rebuild/`）上传和发布。
//!
//! ```text
//! POST /api/v1/spaces/{space_id}/scans
//! POST /api/v1/spaces/{space_id}/scans/{scan_id}/alignment
//! POST /api/v1/spaces/{space_id}/scans/{scan_id}/rebuild
//! POST /api/v1/spaces/{space_id}/scans/{scan_id}/voxelize
//! POST /api/v1/spaces/{space_id}/models
//! POST /api/v1/spaces/{space_id}/plots/{plot_id}/models
//! ```
//!
//! 这些路由在 R2 里统一返回 410 `endpoint_retired`，不写进 OpenAPI，不看请求体；保留一个版本后删掉
//! 路由本身。AI 物件集的上传用途 `authored` 同样返回 410（在 `routes/uploads.rs` 按用途判断，实体区、
//! 地块、重建三组路径的创建、传片、完成、查询都是）。

use axum::{http::StatusCode, response::Response, routing::post, Router};

use crate::error::ApiError;
use crate::AppState;

/// 410 `endpoint_retired`。
pub fn retired(what: &str) -> ApiError {
    ApiError::new(
        StatusCode::GONE,
        "endpoint_retired",
        format!(
            "{what}已下线：重建改在本地完成，打成重建包后经 /api/v1/spaces/{{space_id}}/rebuild/ 上传、交包、发布（见 docs/design/server-slim.md）"
        ),
    )
}

async fn scans() -> Result<Response, ApiError> {
    Err(retired("扫描导入（POST /scans）"))
}

async fn alignment() -> Result<Response, ApiError> {
    Err(retired(
        "按给定变换重新导入扫描（POST /scans/{scan_id}/alignment）",
    ))
}

async fn rebuild() -> Result<Response, ApiError> {
    Err(retired("服务端重建（POST /scans/{scan_id}/rebuild）"))
}

async fn voxelize() -> Result<Response, ApiError> {
    Err(retired("体素化（POST /scans/{scan_id}/voxelize）"))
}

async fn models() -> Result<Response, ApiError> {
    Err(retired(
        "物件模型重新导出（POST /models；本地导出 glb，经 model 用途上传、核对后直接引用）",
    ))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/spaces/{space_id}/scans", post(scans))
        .route(
            "/api/v1/spaces/{space_id}/scans/{scan_id}/alignment",
            post(alignment),
        )
        .route(
            "/api/v1/spaces/{space_id}/scans/{scan_id}/rebuild",
            post(rebuild),
        )
        .route(
            "/api/v1/spaces/{space_id}/scans/{scan_id}/voxelize",
            post(voxelize),
        )
        .route("/api/v1/spaces/{space_id}/models", post(models))
        .route(
            "/api/v1/spaces/{space_id}/plots/{plot_id}/models",
            post(models),
        )
}
