//! `GET /api/public/spaces/{space_id}`：公开读接口（设计 8.2），不经过 NyxID。
//!
//! - 公开空间无需令牌；凭链接查看的空间要在 `Authorization: Share <令牌>` 里带分享令牌；
//! - 没带令牌或令牌无效一律 404，拒绝响应不缓存；
//! - 成功响应：凭令牌访问时 `Cache-Control: private`；只有公开空间才用 `public`。

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    Json,
};

use super::public_access::{public_space_grant, UniverseParam};
use super::views::PublicSpaceView;
use crate::error::{ApiError, ProblemDocument};
use crate::public::headers::cache_control;
use crate::AppState;

#[utoipa::path(
    get,
    path = "/api/public/spaces/{space_id}",
    operation_id = "get_public_space",
    tag = "public",
    description = "公开读：名称、区域、地块、公开锚点、最新位置（含最新公开变化的 recordedAt）和事件类型的显示规则。凭链接查看的空间需要 `Authorization: Share <分享令牌>`；也可以带组合的分享令牌和 `?universe=<组合编号>`（要求现在是组合成员）。",
    params(
        ("space_id" = String, Path, description = "空间编号", example = "front-hall"),
        ("Authorization" = Option<String>, Header, description = "`Share <空间或组合的分享令牌>`；公开空间可省略"),
        UniverseParam,
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
    Query(universe): Query<UniverseParam>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    // 凭组合令牌（`?universe=`）时要求现在是组合成员。
    let grant = public_space_grant(
        &state,
        &space_id,
        &headers,
        universe.universe.as_deref(),
        crate::now()?,
    )
    .await?;
    let space = state
        .repo
        .space(&grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let anchors = state.repo.anchors(&grant).await?;
    let mut view = PublicSpaceView::new(space, anchors);
    view.head.recorded_at = super::event_query::public_recorded_at(&state, &grant).await?;
    view.event_types = state
        .repo
        .event_types(&grant)
        .await?
        .iter()
        .map(|event_type| super::events::event_type_view(event_type, false))
        .collect();
    let mut response = Json(view).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, cache_control(&grant, 5));
    Ok(response)
}
