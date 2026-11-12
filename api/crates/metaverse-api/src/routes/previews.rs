//! 草稿预览的公开读接口（设计 5.6、8.2）：凭 `Authorization: Preview <令牌>` 读取，响应一律不缓存。
//!
//! - 令牌只存哈希，绑定 {空间, 草稿, rev}；过期、草稿已发布或丢弃、草稿又追加过操作（rev 变了）
//!   时一律 404；
//! - 预览和公开接口一样只显示公开锚点；
//! - 草稿区块和草稿引用的资源走预览专用地址：服务端确认哈希属于该草稿（草稿结果，或草稿基础版本
//!   的已发布内容）才返回。

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use metaverse_core::Timestamp;
use serde::Serialize;
use utoipa::ToSchema;

use super::blob_response::{asset_response, chunk_response, path_hash};
use crate::auth::{Grant, PreviewTarget};
use crate::error::{ApiError, ProblemDocument};
use crate::public::headers::{preview_token, NO_STORE};
use crate::repo::{DraftDoc, DraftStatus};
use crate::timeline::drafts::preview_snapshot;
use crate::timeline::views::SnapshotView;
use crate::AppState;

/// 预览的是哪个草稿修订（设计 5.6：预览令牌绑定 {空间, 草稿, rev}，给看预览的人确认）。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInfoView {
    pub draft_id: String,
    /// 令牌绑定的草稿修订。
    pub rev: u64,
    /// 草稿基于的版本（与快照的 `seq` 相同）。
    pub base_seq: u64,
    /// 草稿的路径范围：`physical` 或 `plot:<编号>`。
    pub scope: String,
    /// 这个预览令牌的过期时间。
    #[schema(value_type = String, format = DateTime)]
    pub expires_at: Timestamp,
}

/// 预览响应：快照（形状同公开快照）加空间名称和草稿信息（网站 `PreviewView`）。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapshotView {
    #[serde(flatten)]
    pub snapshot: SnapshotView,
    /// 空间名称（预览页标题用）。
    pub space_name: String,
    pub preview: PreviewInfoView,
}

/// 校验预览令牌，读出它绑定的草稿版本。
async fn previewed(state: &AppState, headers: &HeaderMap) -> Result<(Grant, DraftDoc), ApiError> {
    previewed_with_target(state, headers)
        .await
        .map(|(grant, draft, _)| (grant, draft))
}

pub(super) async fn previewed_with_target(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(Grant, DraftDoc, PreviewTarget), ApiError> {
    let now = crate::now()?;
    let (grant, target) = state
        .authorizer
        .preview(preview_token(headers), now)
        .await?;
    let draft = state
        .repo
        .draft(&grant, &target.draft_id)
        .await?
        .filter(|draft| draft.status == DraftStatus::Open && draft.rev == target.rev)
        .ok_or_else(ApiError::not_found)?;
    Ok((grant, draft, target))
}

#[utoipa::path(
    get,
    path = "/api/public/previews",
    operation_id = "get_preview",
    tag = "public",
    description = "草稿预览：基础版本叠加草稿结果后的快照（形状同公开快照，只含公开锚点；seq 是草稿的基础版本），另带空间名称 spaceName 和草稿信息 preview: {draftId, rev, baseSeq, scope, expiresAt}。令牌放在 `Authorization: Preview <令牌>` 里；响应不缓存。",
    params(("Authorization" = String, Header, description = "`Preview <预览令牌>`")),
    responses(
        (status = 200, description = "预览快照", body = PreviewSnapshotView),
        (status = 404, description = "令牌无效、过期，或草稿已变化", body = ProblemDocument),
    )
)]
pub async fn get_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (grant, draft, target) = previewed_with_target(&state, &headers).await?;
    let space = state
        .repo
        .space(&grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let snapshot = preview_snapshot(&state.repo, &grant, &draft).await?;
    let view = PreviewSnapshotView {
        snapshot,
        space_name: space.name,
        preview: PreviewInfoView {
            draft_id: draft.id.clone(),
            rev: draft.rev,
            base_seq: draft.base_seq,
            scope: draft.scope.to_string(),
            expires_at: target.expires_at,
        },
    };
    let mut response = Json(view).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(NO_STORE));
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/api/public/previews/chunks/{hash}",
    operation_id = "get_preview_chunk",
    tag = "public",
    description = "预览用的区块（zlib 压缩的规范字节）：草稿生成的区块，或草稿基础版本里已发布的区块。响应不缓存。",
    params(
        ("hash" = String, Path, description = "区块哈希"),
        ("Authorization" = String, Header, description = "`Preview <预览令牌>`"),
    ),
    responses(
        (status = 200, description = "zlib 压缩的区块", content_type = "application/octet-stream"),
        (status = 404, description = "令牌无效，或区块不属于这个草稿", body = ProblemDocument),
    )
)]
pub async fn get_preview_chunk(
    State(state): State<AppState>,
    Path(hash): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let hash = path_hash(&hash, "")?;
    let (grant, draft) = previewed(&state, &headers).await?;
    let data = if draft.result_chunks.iter().any(|chunk| chunk.hash == hash) {
        state
            .repo
            .draft_chunk_data(&grant, &draft.id, &[hash])
            .await?
            .remove(hash)
    } else {
        state
            .repo
            .space_chunk_upto(&grant, hash, draft.base_seq)
            .await?
    };
    let data = data.ok_or_else(ApiError::not_found)?;
    Ok(chunk_response(
        Bytes::from(data),
        HeaderValue::from_static(NO_STORE),
    ))
}

#[utoipa::path(
    get,
    path = "/api/public/previews/assets/{hash}",
    operation_id = "get_preview_asset",
    tag = "public",
    description = "预览用的资源：草稿引用的资源（新上传的模型、贴图），或本空间基础版本及以前的提交登记过的资源。支持 `Range`；响应不缓存。",
    params(
        ("hash" = String, Path, description = "资源哈希"),
        ("Authorization" = String, Header, description = "`Preview <预览令牌>`"),
        ("Range" = Option<String>, Header, description = "单段 `bytes=a-b`"),
    ),
    responses(
        (status = 200, description = "资源内容", content_type = "application/octet-stream"),
        (status = 206, description = "分段内容", content_type = "application/octet-stream"),
        (status = 404, description = "令牌无效，或资源不属于这个草稿", body = ProblemDocument),
    )
)]
pub async fn get_preview_asset(
    State(state): State<AppState>,
    Path(hash): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let hash = path_hash(&hash, "")?;
    let (grant, draft) = previewed(&state, &headers).await?;
    let meta = match state.repo.draft_asset(&grant, &draft, hash).await? {
        Some(meta) => meta,
        None => state
            .repo
            .space_asset_upto(&grant, hash, draft.base_seq)
            .await?
            .ok_or_else(ApiError::not_found)?,
    };
    asset_response(
        &state,
        &meta,
        &headers,
        HeaderValue::from_static(NO_STORE),
        false,
    )
    .await
}
