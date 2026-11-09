//! 公开读接口（设计 8.2）：快照、提交列表、区块、资源。不经过 NyxID。
//!
//! - 凭链接查看的空间要在 `Authorization: Share <令牌>` 里带分享令牌，没带或无效一律 404；
//! - 成功响应：凭令牌访问 `private`，公开空间 `public`；拒绝一律 `no-store`；
//! - 快照按 seq 长缓存（进程内缓存在校验令牌之后才查），`?at=` 换算成 seq 后 302 跳转、不缓存；
//! - `.bin`（区块、资源）按内容寻址：`public, max-age=31536000, immutable`。区块只返回已发布的，
//!   资源只返回登记在 `assetRefs` 里的，支持分段下载。

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use utoipa::IntoParams;

use super::blob_response::{
    asset_response, bytes_asset_response, cached_asset, chunk_response, parse_seq, parse_time,
    path_hash,
};
use super::public_access::{
    public_space_grant, public_space_grant_during, public_space_grant_for_seq, UniverseParam,
};
use super::timeline::{timeline_page, TimelineQuery};
use crate::error::{ApiError, ProblemDocument};
use crate::public::headers::{cache_control, share_token, IMMUTABLE};
use crate::public::CacheKey;
use crate::timeline::snapshot::{public_summaries, snapshot_at, Audience};
use crate::timeline::views::{CommitSummaryPage, SnapshotView};
use crate::AppState;

/// 公开快照的缓存时间（秒）：同一个 seq 的内容只会因锚点改成内部级而变化。
pub const SNAPSHOT_MAX_AGE: u32 = 600;
/// 提交列表的缓存时间（秒）。
pub const TIMELINE_MAX_AGE: u32 = 5;

/// 快照的查询参数：`seq` 和 `at` 二选一。
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct SnapshotQuery {
    /// 版本号。
    pub seq: Option<String>,
    /// 时刻（RFC 3339）：换算成 `at ≤ 该时刻` 的最大 seq，302 跳转到 `?seq=` 地址。
    pub at: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/public/spaces/{space_id}/snapshot",
    operation_id = "get_public_snapshot",
    tag = "public",
    description = "某个版本的公开快照：区块清单、方块表、物件、公开锚点（该版本和当前都是公开级）、区域和地块、扫描（只给网页用模型）。`?seq=` 长缓存；`?at=` 换算后 302 跳到 `?seq=` 地址，不缓存。",
    params(
        ("space_id" = String, Path, description = "空间编号", example = "front-hall"),
        ("Authorization" = Option<String>, Header, description = "`Share <分享令牌>`；公开空间可省略"),
        SnapshotQuery,
        UniverseParam,
    ),
    responses(
        (status = 200, description = "快照", body = SnapshotView),
        (status = 302, description = "按时刻换算后的 `?seq=` 地址"),
        (status = 404, description = "空间或版本不存在，或没带有效的分享令牌", body = ProblemDocument),
        (status = 422, description = "seq/at 缺失或不合法", body = ProblemDocument),
    )
)]
pub async fn get_public_snapshot(
    State(state): State<AppState>,
    Path(space_id): Path<String>,
    Query(query): Query<SnapshotQuery>,
    Query(universe): Query<UniverseParam>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    // 凭组合令牌（`?universe=`）时，成员资格要按版本或时刻判断，所以先解析参数。
    let universe = universe.universe.as_deref();
    let direct = match universe {
        None => Some(
            state
                .authorizer
                .public_space(&space_id, share_token(&headers))
                .await?,
        ),
        Some(_) => None,
    };
    let seq = match (
        parse_seq("seq", query.seq.as_deref())?,
        parse_time("at", query.at.as_deref())?,
    ) {
        (Some(seq), None) => seq,
        (None, Some(at)) => {
            let grant = match direct {
                Some(grant) => grant,
                None => public_space_grant(&state, &space_id, &headers, universe, at).await?,
            };
            let seq = state.repo.seq_at(&grant, at).await?;
            let mut location = format!("/api/public/spaces/{space_id}/snapshot?seq={seq}");
            if let Some(universe) = universe {
                location.push_str(&format!("&universe={universe}"));
            }
            let mut response = StatusCode::FOUND.into_response();
            let headers = response.headers_mut();
            if let Ok(value) = HeaderValue::from_str(&location) {
                headers.insert(header::LOCATION, value);
            }
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            return Ok(response);
        }
        _ => return Err(ApiError::invalid("seq 和 at 必须且只能给出一个")),
    };
    let grant = match direct {
        Some(grant) => grant,
        None => public_space_grant_for_seq(&state, &space_id, &headers, universe, seq).await?,
    };
    let head = state
        .repo
        .head_seq(&grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if seq > head {
        return Err(ApiError::not_found());
    }
    let key = CacheKey::Snapshot {
        space_id: space_id.clone(),
        seq,
        head_seq: head,
    };
    let body = match state.public.cache.get(&key) {
        Some(body) => body,
        None => {
            let space = state
                .repo
                .space(&grant)
                .await?
                .ok_or_else(ApiError::not_found)?;
            let snapshot =
                snapshot_at(&state.repo, &grant, seq, space.created_at, Audience::Public).await?;
            let body =
                Bytes::from(serde_json::to_vec(&snapshot).map_err(|_| ApiError::internal())?);
            state.public.cache.insert(&key, body.clone());
            body
        }
    };
    let mut response = (StatusCode::OK, body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        cache_control(&grant, SNAPSHOT_MAX_AGE),
    );
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/api/public/spaces/{space_id}/timeline",
    operation_id = "get_public_timeline",
    tag = "public",
    description = "提交列表的公开投影（每页 ≤ 500）：`{seq, at, observedAt, message, actor.kind, changedChunks, changedEntities, changedAnchors}`，不含用户编号、操作内容和脚本；changedAnchors 里内部锚点不出现，由公开改为内部的记为删除。",
    params(
        ("space_id" = String, Path, description = "空间编号", example = "front-hall"),
        ("Authorization" = Option<String>, Header, description = "`Share <分享令牌>`；公开空间可省略"),
        TimelineQuery,
        UniverseParam,
    ),
    responses(
        (status = 200, description = "一页提交", body = CommitSummaryPage),
        (status = 404, description = "空间不存在，或没带有效的分享令牌", body = ProblemDocument),
        (status = 422, description = "查询参数不合法", body = ProblemDocument),
    )
)]
pub async fn get_public_timeline(
    State(state): State<AppState>,
    Path(space_id): Path<String>,
    Query(query): Query<TimelineQuery>,
    Query(universe): Query<UniverseParam>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let grant = match universe.universe.as_deref() {
        None => {
            state
                .authorizer
                .public_space(&space_id, share_token(&headers))
                .await?
        }
        // 凭组合令牌：查询的时间段里某个时刻是组合成员。
        Some(universe) => {
            let now = crate::now()?;
            let from = parse_time("from", query.from.as_deref())?
                .unwrap_or(metaverse_core::Timestamp::from_millis(0).map_err(|_| ApiError::internal())?);
            let to = parse_time("to", query.to.as_deref())?.unwrap_or(now).min(now);
            public_space_grant_during(&state, &space_id, &headers, Some(universe), from, to)
                .await?
        }
    };
    let (commits, next_after) = timeline_page(&state.repo, &grant, &query).await?;
    let items = public_summaries(&state.repo, &grant, commits).await?;
    let mut response = Json(CommitSummaryPage { items, next_after }).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        cache_control(&grant, TIMELINE_MAX_AGE),
    );
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/api/public/chunks/{hash}.bin",
    operation_id = "get_public_chunk",
    tag = "public",
    description = "已发布的区块（zlib 压缩的规范字节，按内容寻址，可以永久缓存）。没有发布标记的区块一律 404。",
    params(("hash" = String, Path, description = "区块哈希（64 位小写十六进制）")),
    responses(
        (status = 200, description = "zlib 压缩的区块", content_type = "application/octet-stream"),
        (status = 404, description = "区块不存在或还没发布", body = ProblemDocument),
    )
)]
pub async fn get_public_chunk(
    State(state): State<AppState>,
    Path(file): Path<String>,
) -> Result<Response, ApiError> {
    let hash = path_hash(&file, ".bin")?;
    let key = CacheKey::Chunk(hash.to_owned());
    let data = match state.public.cache.get(&key) {
        Some(data) => data,
        None => {
            let blobs = state.authorizer.published_blobs();
            let chunk = state
                .repo
                .published_chunk(&blobs, hash)
                .await?
                .ok_or_else(ApiError::not_found)?;
            let data = Bytes::from(chunk.data);
            state.public.cache.insert(&key, data.clone());
            data
        }
    };
    Ok(chunk_response(data, HeaderValue::from_static(IMMUTABLE)))
}

#[utoipa::path(
    get,
    path = "/api/public/assets/{hash}.bin",
    operation_id = "get_public_asset",
    tag = "public",
    description = "登记在 assetRefs 里的资源（网页用模型、方块表贴图、处理后的物件模型），按内容寻址、可以永久缓存，支持 `Range` 分段下载。Content-Type 由服务端按用途固定并带 `nosniff`。原始扫描、操作文件和脚本不登记，一律 404。",
    params(
        ("hash" = String, Path, description = "资源哈希（64 位小写十六进制）"),
        ("Range" = Option<String>, Header, description = "单段 `bytes=a-b`"),
    ),
    responses(
        (status = 200, description = "资源内容", content_type = "application/octet-stream"),
        (status = 206, description = "分段内容", content_type = "application/octet-stream"),
        (status = 404, description = "资源不存在或没有登记", body = ProblemDocument),
        (status = 416, description = "范围不合法", body = ProblemDocument),
    )
)]
pub async fn get_public_asset(
    State(state): State<AppState>,
    Path(file): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let hash = path_hash(&file, ".bin")?;
    if let Some((content_type, data)) = cached_asset(&state, hash) {
        return Ok(bytes_asset_response(
            data,
            content_type,
            &headers,
            HeaderValue::from_static(IMMUTABLE),
        ));
    }
    let blobs = state.authorizer.published_blobs();
    let meta = state
        .repo
        .published_asset(&blobs, hash)
        .await?
        .ok_or_else(ApiError::not_found)?;
    asset_response(
        &state,
        &meta,
        &headers,
        HeaderValue::from_static(IMMUTABLE),
        true,
    )
    .await
}
