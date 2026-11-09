//! `GET /api/public/spaces/{space_id}`：公开读接口（设计 8.2），不经过 NyxID。
//!
//! - 公开空间无需令牌；凭链接查看的空间要在 `Authorization: Share <令牌>` 里带分享令牌；
//! - 没带令牌或令牌无效一律 404，拒绝响应不缓存；
//! - 成功响应：凭令牌访问时 `Cache-Control: private`；只有公开空间才用 `public`。

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    Json,
};

use super::views::PublicSpaceView;
use crate::error::{ApiError, ProblemDocument};
use crate::public::headers::{cache_control, share_token};
use crate::AppState;

#[utoipa::path(
    get,
    path = "/api/public/spaces/{space_id}",
    operation_id = "get_public_space",
    tag = "public",
    description = "公开读：名称、区域、地块和公开锚点。凭链接查看的空间需要 `Authorization: Share <分享令牌>`。",
    params(
        ("space_id" = String, Path, description = "空间编号", example = "front-hall"),
        ("Authorization" = Option<String>, Header, description = "`Share <分享令牌>`；公开空间可省略"),
    ),
    responses(
        (status = 200, description = "空间的公开信息", body = PublicSpaceView),
        (status = 404, description = "空间不存在，或没带有效的分享令牌", body = ProblemDocument),
        (status = 503, description = "数据库暂时不可用", body = ProblemDocument),
    )
)]
pub async fn get_public_space(
    State(state): State<AppState>,
    Path(space_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .public_space(&space_id, share_token(&headers))
        .await?;
    let space = state
        .repo
        .space(&grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let anchors = state.repo.anchors(&grant).await?;
    let mut response = Json(PublicSpaceView::new(space, anchors)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, cache_control(&grant, 5));
    Ok(response)
}
