//! `/api/v1` 的时间线读接口（设计 8.3 的"查看"）：提交列表、快照（给 AI 和命令行拉取，含内部
//! 锚点）、区块（命令行 `pull` 用，含未公开的）、资源（原始扫描、网页用模型、ops 文件、脚本等，
//! 设计 8.2：只能由有权限的调用者经 `/api/v1` 下载）、区域内容（分层文字）。主人和组织成员可读。

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use metaverse_core::ids::is_object_id;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::blob_response::{asset_response, chunk_response, parse_seq, parse_time, path_hash};
use crate::auth::{Caller, Grant, Purpose};
use crate::error::{ApiError, ProblemDocument};
use crate::repo::Repo;
use crate::timeline::region_text::region_content;
use crate::timeline::snapshot::{snapshot_at, Audience};
use crate::timeline::views::{CommitPage, CommitView, SnapshotView};
use crate::AppState;

/// 每页最多的提交数。
pub const MAX_TIMELINE_PAGE: i64 = 500;

/// 提交列表的查询参数。
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TimelineQuery {
    /// 起始时间（含），RFC 3339，按提交的服务端时间 `at`。
    pub from: Option<String>,
    /// 结束时间（含）。
    pub to: Option<String>,
    /// 游标：上一页的 `nextAfter`（seq），只返回更大的 seq。
    pub after: Option<String>,
    /// 每页条数，1–500，默认 500。
    pub limit: Option<String>,
}

/// 查一页提交：多取一条判断还有没有下一页。
pub async fn timeline_page(
    repo: &Repo,
    grant: &Grant,
    query: &TimelineQuery,
) -> Result<(Vec<metaverse_core::model::Commit>, Option<String>), ApiError> {
    let from = parse_time("from", query.from.as_deref())?;
    let to = parse_time("to", query.to.as_deref())?;
    let after = parse_seq("after", query.after.as_deref())?;
    let limit = match parse_seq("limit", query.limit.as_deref())? {
        None => MAX_TIMELINE_PAGE,
        Some(limit) if (1..=MAX_TIMELINE_PAGE as u64).contains(&limit) => limit as i64,
        Some(_) => return Err(ApiError::invalid("limit 必须在 1 到 500 之间")),
    };
    let mut commits = repo.timeline(grant, from, to, after, limit + 1).await?;
    let next = if commits.len() as i64 > limit {
        commits.truncate(limit as usize);
        commits.last().map(|commit| commit.seq.to_string())
    } else {
        None
    };
    Ok((commits, next))
}

fn private_json<T: Serialize>(body: &T) -> Response {
    let mut response = Json(body).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/timeline",
    operation_id = "list_timeline",
    tag = "timeline",
    description = "列出空间的提交（时间线），按 seq 升序分页，每页最多 500 条。每条含服务端时间 at、发布者（sub、NyxID 服务编号、路径范围、类别）、说明、区块/物件/锚点的变化（hash 为 null 表示删除）、方块表和区域清单的哈希、扫描和追溯信息；不含操作内容（opsRef 指向存成资源的操作）。用 from/to 按时间筛选，用上一页的 nextAfter 作 after 翻页。",
    params(
        ("space_id" = String, Path, description = "空间编号", example = "front-hall"),
        TimelineQuery,
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "一页提交", body = CommitPage),
        (status = 401, description = "身份令牌无效", body = ProblemDocument),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
        (status = 422, description = "查询参数不合法", body = ProblemDocument),
    )
)]
pub async fn list_timeline(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
    Query(query): Query<TimelineQuery>,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .space(&caller, &space_id, Purpose::Read)
        .await?;
    let (commits, next_after) = timeline_page(&state.repo, &grant, &query).await?;
    Ok(private_json(&CommitPage {
        items: commits.into_iter().map(CommitView::from).collect(),
        next_after,
    }))
}

/// 快照的查询参数。
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct SeqQuery {
    /// 版本号；不填就是最新版本。
    pub seq: Option<String>,
}

/// 解析 `seq`：不填取最新，超过最新版本 404。返回 `(seq, 空间创建时间, 最新 seq)`。
async fn resolve_seq(
    repo: &Repo,
    grant: &Grant,
    seq: Option<&str>,
) -> Result<(u64, metaverse_core::Timestamp, u64), ApiError> {
    let space = repo.space(grant).await?.ok_or_else(ApiError::not_found)?;
    let head = space.head.seq;
    let seq = parse_seq("seq", seq)?.unwrap_or(head);
    if seq > head {
        return Err(ApiError::not_found());
    }
    Ok((seq, space.created_at, head))
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/snapshot",
    operation_id = "get_snapshot",
    tag = "timeline",
    description = "读取空间在某个版本（seq，默认最新）的完整状态：区块清单（图层、区块坐标、哈希，用 get_chunk 下载）、方块表、全部物件记录、全部锚点（含内部级）、区域和地块、扫描（含原始扫描资源哈希）。给 AI 和命令行 `metaverse pull` 用；物件很多时响应可能较大。",
    params(
        ("space_id" = String, Path, description = "空间编号", example = "front-hall"),
        SeqQuery,
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "快照", body = SnapshotView),
        (status = 401, description = "身份令牌无效", body = ProblemDocument),
        (status = 404, description = "空间或版本不存在，或无权查看", body = ProblemDocument),
        (status = 422, description = "seq 不合法", body = ProblemDocument),
    )
)]
pub async fn get_snapshot(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
    Query(query): Query<SeqQuery>,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .space(&caller, &space_id, Purpose::Read)
        .await?;
    let (seq, created_at, head) = resolve_seq(&state.repo, &grant, query.seq.as_deref()).await?;
    let snapshot = snapshot_at(&state.repo, &grant, seq, created_at, Audience::Internal).await?;
    let mut response = private_json(&snapshot);
    if let Ok(value) = HeaderValue::from_str(&format!("\"{head}\"")) {
        response.headers_mut().insert(header::ETAG, value);
    }
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/assets/{hash}",
    operation_id = "get_asset",
    tag = "timeline",
    description = "下载空间的一个资源（原始字节，按内容哈希）：原始扫描、网页用模型（快照 scan.webModelHashes）、处理后的物件模型、贴图、ops 文件、建造脚本等。给命令行 pull 和本地处理用；文件可能很大（扫描最大 1GiB），支持单段 Range: bytes=a-b。只返回属于这个空间的资源（本空间登记、上传、导入或在提交里引用过的），否则 404。Content-Type 按白名单固定（model/gltf-binary、image/jpeg|png|webp，其余 application/octet-stream），不缓存。",
    params(
        ("space_id" = String, Path, description = "空间编号", example = "front-hall"),
        ("hash" = String, Path, description = "资源的内容哈希（64 位小写十六进制）"),
        ("Range" = Option<String>, Header, description = "单段 `bytes=a-b`"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "资源内容", content_type = "application/octet-stream"),
        (status = 206, description = "分段内容", content_type = "application/octet-stream"),
        (status = 401, description = "身份令牌无效", body = ProblemDocument),
        (status = 404, description = "资源不存在、不属于这个空间，或无权查看", body = ProblemDocument),
        (status = 416, description = "Range 不合法", body = ProblemDocument),
    )
)]
pub async fn get_asset(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, hash)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .space(&caller, &space_id, Purpose::Read)
        .await?;
    let hash = path_hash(&hash, "")?;
    let meta = state
        .repo
        .space_owned_asset(&grant, hash)
        .await?
        .ok_or_else(ApiError::not_found)?;
    asset_response(
        &state,
        &meta,
        &headers,
        HeaderValue::from_static("private, no-store"),
        false,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/chunks/{hash}",
    operation_id = "get_chunk",
    tag = "timeline",
    description = "下载空间里的一个区块（命令行 pull 用，含还没打上发布标记的区块）。响应是 zlib 压缩的规范字节：32×32×32 个小端 uint16 方块编号，下标 x + 32·(z + 32·y)；哈希 = sha256(0x01 ‖ 规范字节)。哈希必须出现在这个空间的某次提交里。",
    params(
        ("space_id" = String, Path, description = "空间编号", example = "front-hall"),
        ("hash" = String, Path, description = "区块哈希（64 位小写十六进制）"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "zlib 压缩的区块", content_type = "application/octet-stream"),
        (status = 401, description = "身份令牌无效", body = ProblemDocument),
        (status = 404, description = "区块不属于这个空间，或无权查看", body = ProblemDocument),
    )
)]
pub async fn get_chunk(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, hash)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .space(&caller, &space_id, Purpose::Read)
        .await?;
    let hash = path_hash(&hash, "")?;
    let chunk = state
        .repo
        .space_chunk(&grant, hash)
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(chunk_response(
        Bytes::from(chunk.data),
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    ))
}

/// 区域内容。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegionContentView {
    pub space_id: String,
    pub region_id: String,
    /// `physical` 或 `virtual`。
    pub kind: String,
    pub seq: u64,
    /// 分层文字：区域范围、地块、重建层和扩展层的物件与方块用量、锚点、方块表。
    pub text: String,
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/regions/{region_id}/content",
    operation_id = "get_region_content",
    tag = "timeline",
    description = "用分层文字描述一个区域在某个版本（seq，默认最新）的内容：区域范围（格和米）、地块、重建层和扩展层的物件（类型、标签、形状、范围、锚点）和方块区块（区块不多时统计各方块的格子数）、区域内的锚点（含内部级）、方块表。适合 AI 在修改前了解现状；每类最多列 300 条。",
    params(
        ("space_id" = String, Path, description = "空间编号", example = "front-hall"),
        ("region_id" = String, Path, description = "区域编号", example = "hall"),
        SeqQuery,
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "区域内容", body = RegionContentView),
        (status = 401, description = "身份令牌无效", body = ProblemDocument),
        (status = 404, description = "空间、区域或版本不存在，或无权查看", body = ProblemDocument),
    )
)]
pub async fn get_region_content(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, region_id)): Path<(String, String)>,
    Query(query): Query<SeqQuery>,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .space(&caller, &space_id, Purpose::Read)
        .await?;
    if !is_object_id(&region_id) {
        return Err(ApiError::not_found());
    }
    let (seq, created_at, _) = resolve_seq(&state.repo, &grant, query.seq.as_deref()).await?;
    let at = if seq == 0 {
        created_at
    } else {
        state
            .repo
            .commit_at(&grant, seq)
            .await?
            .map_or(created_at, |commit| commit.at)
    };
    let content = region_content(&state.repo, &grant, &region_id, seq, at).await?;
    Ok(private_json(&RegionContentView {
        space_id,
        region_id,
        kind: serde_json::to_value(content.kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default(),
        seq,
        text: content.text,
    }))
}
