//! `GET /api/v1/spaces/{space_id}`：给 AI 和命令行的空间信息（设计 8.3 的"查看"），
//! 含最新 seq（也作为 ETag）、区域、地块、锚点（含内部级）。主人和组织成员可读。

use axum::{
    extract::{Path, State},
    http::{header, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};

use super::views::SpaceView;
use crate::auth::{Caller, Purpose};
use crate::error::{ApiError, ProblemDocument};
use crate::AppState;

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}",
    operation_id = "get_space",
    tag = "spaces",
    description = "读取空间信息：名称、主人、可见性、最新 seq（同时作为 ETag）、区域、地块和全部锚点（含内部级）。空间主人和主人组织的成员可读；其他人一律 404。",
    params(("space_id" = String, Path, description = "空间编号", example = "front-hall")),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "空间信息", body = SpaceView),
        (status = 401, description = "身份令牌无效", body = ProblemDocument),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
        (status = 503, description = "数据库或 NyxID 暂时不可用", body = ProblemDocument),
    )
)]
pub async fn get_space(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .space(&caller, &space_id, Purpose::Read)
        .await?;
    let space = state
        .repo
        .space(&grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let anchors = state.repo.anchors(&grant).await?;
    let etag = format!("\"{}\"", space.head.seq);
    let mut response = Json(SpaceView::new(space, anchors)).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    if let Ok(value) = HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, value);
    }
    Ok(response)
}
