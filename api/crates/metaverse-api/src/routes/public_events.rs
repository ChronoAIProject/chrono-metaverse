//! 事件的公开读接口（设计 5.5、8.2），JSON 形状与网站 `web/src/core/api/types.ts` 一致。
//!
//! ```text
//! GET /api/public/spaces/{id}/head                                最新 seq + 最新公开变化的记录时间（ETag、304）
//! GET /api/public/spaces/{id}/events?from=&to=&since=&types=&after=   公开事件（≤ 24 小时，每页 ≤ 5000）
//! GET /api/public/spaces/{id}/events/density?from=&to=&bucket=        事件数量聚合（≤ 90 天）
//! GET /api/public/spaces/{id}/state?at=                               T 时刻各公开锚点的状态
//! ```
//!
//! 访问方式见 [`super::public_access`]：公开空间、空间的分享令牌，或组合的分享令牌 +
//! `?universe=`。`/head` 在进程内缓存 1.5 秒（先校验令牌再命中缓存）。

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use metaverse_core::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::{IntoParams, ToSchema};

use super::event_query::{
    public_anchor_ids, public_items, public_recorded_at, public_state_at, type_map,
    PUBLIC_PAGE_LIMIT,
};
use super::events::{EventRequest, EventsQuery};
use super::ingest_common::{encode_cursor, invalid_with, parse_time, public_cache, set_header};
use super::public_access::{public_space_grant, share_token};
use crate::auth::{Authorizer, Grant, PublicBasis};
use crate::error::{ApiError, ProblemDocument};
use crate::ingest::head_cache::HeadData;
use crate::AppState;

/// 密度查询最长 90 天，最多 10000 个桶。
const MAX_DENSITY_MS: i64 = 90 * 24 * 3600 * 1000;
const MAX_BUCKETS: i64 = 10_000;
/// 短缓存（秒）。
const SHORT_CACHE: u32 = 5;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/public/spaces/{space_id}/head", get(get_public_head))
        .route("/api/public/spaces/{space_id}/events", get(list_public_events))
        .route(
            "/api/public/spaces/{space_id}/events/density",
            get(get_public_event_density),
        )
        .route("/api/public/spaces/{space_id}/state", get(get_public_state))
}

/// 时间线最新位置（网站 `Head`）。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicHeadView {
    pub seq: u64,
    #[schema(value_type = String, format = DateTime)]
    pub at: Timestamp,
    /// 最新的公开可见变化（公开事件、晚到事件、更正和撤回）的记录时间；没有时为 null。
    #[schema(value_type = Option<String>, format = DateTime)]
    pub recorded_at: Option<Timestamp>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct UniverseParam {
    /// 凭组合的分享令牌读取时的组合编号（`Authorization: Share <组合令牌>`）。
    pub universe: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct DensityQuery {
    /// 起点（含），RFC 3339。
    pub from: String,
    /// 终点（不含），最长 90 天。
    pub to: String,
    /// 桶宽（秒）。
    pub bucket: i64,
    pub universe: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DensityBucketView {
    #[schema(value_type = String, format = DateTime)]
    pub start: Timestamp,
    pub count: u64,
}

/// 事件密度（网站 `EventDensity`）。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventDensityView {
    #[schema(value_type = String, format = DateTime)]
    pub from: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub to: Timestamp,
    pub bucket_sec: i64,
    pub buckets: Vec<DensityBucketView>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct StateQuery {
    /// 时刻（RFC 3339），默认现在。
    pub at: Option<String>,
    pub universe: Option<String>,
}

/// 某锚点某个状态 key 的状态（网站 `AnchorState`）。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AnchorStateView {
    pub anchor_id: String,
    pub key: String,
    #[schema(value_type = Object)]
    pub value: Value,
    /// 从这个时刻起处于这个状态（决定它的事件的 at）。
    #[schema(value_type = String, format = DateTime)]
    pub at: Timestamp,
    pub event_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
}

/// T 时刻的状态（网站 `StateAt`）。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StateAtView {
    #[schema(value_type = String, format = DateTime)]
    pub at: Timestamp,
    pub states: Vec<AnchorStateView>,
}

/// 公开事件的一页（网站 `Page<SpaceEvent>`）。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicEventPage {
    pub items: Vec<super::event_query::PublicEventView>,
    pub next_after: Option<String>,
}

// ---------------------------------------------------------------------------
// /head
// ---------------------------------------------------------------------------

async fn head_data(state: &AppState, grant: &Grant) -> Result<HeadData, ApiError> {
    let space = state
        .repo
        .space(grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(HeadData {
        seq: space.head.seq,
        at: space.head.at,
        recorded_at: public_recorded_at(state, grant).await?,
    })
}

fn etag(head: &HeadData) -> String {
    format!(
        "\"{}-{}\"",
        head.seq,
        head.recorded_at.map_or(0, Timestamp::millis)
    )
}

fn matches_etag(headers: &HeaderMap, tag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .any(|candidate| candidate == "*" || candidate.trim_start_matches("W/") == tag)
}

#[utoipa::path(
    get,
    path = "/api/public/spaces/{space_id}/head",
    operation_id = "get_public_head",
    tag = "public",
    description = "时间线最新位置：最新提交的 seq 和 at，以及最新一条公开可见变化（公开事件、晚到事件、更正和撤回）的记录时间 recordedAt。带 ETag，If-None-Match 相同时返回 304。进程内缓存 1.5 秒。网站\"现在\"模式每隔几秒查一次，有变化再按 since 增量拉事件。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("Authorization" = Option<String>, Header, description = "`Share <空间或组合的分享令牌>`；公开空间可省略"),
        ("If-None-Match" = Option<String>, Header, description = "上次的 ETag"),
        UniverseParam,
    ),
    responses(
        (status = 200, description = "最新位置", body = PublicHeadView),
        (status = 304, description = "没有变化"),
        (status = 404, description = "空间不存在，或没带有效的令牌", body = ProblemDocument),
    )
)]
pub async fn get_public_head(
    State(state): State<AppState>,
    Path(space_id): Path<String>,
    Query(query): Query<UniverseParam>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (grant, head) = match query.universe.as_deref() {
        Some(universe) => {
            let now = crate::now()?;
            let grant = public_space_grant(&state, &space_id, &headers, Some(universe), now).await?;
            let head = head_data(&state, &grant).await?;
            (grant, head)
        }
        None => match state.ingest.head_cache.get(&space_id) {
            // 先用缓存的授权信息校验令牌，通过了才用缓存的数据。
            Some(cached) => {
                let grant = Authorizer::public_space_from_policy(
                    &space_id,
                    &cached.policy,
                    share_token(&headers),
                )?;
                (grant, cached.head)
            }
            None => {
                let (grant, policy) = state
                    .authorizer
                    .public_space_with_policy(&space_id, share_token(&headers))
                    .await?;
                let head = head_data(&state, &grant).await?;
                state
                    .ingest
                    .head_cache
                    .put(&space_id, policy, head.clone());
                (grant, head)
            }
        },
    };
    let tag = etag(&head);
    let cache = match grant.public_basis() {
        Some(PublicBasis::PublicVisibility) => "public, max-age=1",
        _ => "private, no-cache",
    };
    let mut response = if matches_etag(&headers, &tag) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        Json(PublicHeadView {
            seq: head.seq,
            at: head.at,
            recorded_at: head.recorded_at,
        })
        .into_response()
    };
    set_header(&mut response, header::ETAG, &tag);
    set_header(&mut response, header::CACHE_CONTROL, cache);
    Ok(response)
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/api/public/spaces/{space_id}/events",
    operation_id = "list_public_events",
    tag = "public",
    description = "公开事件。时间窗 from/to（按现实时间，≤ 24 小时）或增量 since（按记录时间，含晚到事件和更正）。先应用更正，再按可见级别过滤，data 只含公开字段，只返回公开锚点上的事件；增量结果里，之前公开过、后来被撤回或改成内部级的事件带 withdrawn: true。每页 ≤ 5000 条，after 是上一页的 nextAfter。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("Authorization" = Option<String>, Header, description = "`Share <空间或组合的分享令牌>`"),
        EventsQuery,
    ),
    responses(
        (status = 200, description = "公开事件", body = PublicEventPage),
        (status = 404, description = "空间不存在，或没带有效的令牌", body = ProblemDocument),
        (status = 422, description = "查询参数不合法", body = ProblemDocument),
    )
)]
pub async fn list_public_events(
    State(state): State<AppState>,
    Path(space_id): Path<String>,
    Query(query): Query<EventsQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if query.raw == Some(true) {
        return Err(ApiError::invalid("公开读不支持 raw"));
    }
    let request = EventRequest::parse(&query)?;
    let now = crate::now()?;
    let grant = public_space_grant(
        &state,
        &space_id,
        &headers,
        query.universe.as_deref(),
        request.membership_time(now),
    )
    .await?;
    let limit = query
        .limit
        .unwrap_or(PUBLIC_PAGE_LIMIT)
        .clamp(1, PUBLIC_PAGE_LIMIT);
    let page = request.page(&state, &grant, limit).await?;
    let types = type_map(&state, &grant).await?;
    let anchors = public_anchor_ids(&state, &grant).await?;
    let items = public_items(
        grant.space_id(),
        &page,
        &types,
        &anchors,
        &request.filters,
        request.is_incremental(),
    );
    let response = Json(PublicEventPage {
        items,
        next_after: page.next.as_ref().map(encode_cursor),
    })
    .into_response();
    Ok(public_cache(response, grant.public_basis(), SHORT_CACHE))
}

// ---------------------------------------------------------------------------
// 密度
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/api/public/spaces/{space_id}/events/density",
    operation_id = "get_public_event_density",
    tag = "public",
    description = "公开事件的数量聚合（时间轴上的密度条）：[from, to) 按 bucket 秒分桶，最长 90 天、最多 10000 个桶；更正已应用，只数公开锚点上的公开事件。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("Authorization" = Option<String>, Header, description = "`Share <空间或组合的分享令牌>`"),
        DensityQuery,
    ),
    responses(
        (status = 200, description = "密度", body = EventDensityView),
        (status = 404, description = "空间不存在，或没带有效的令牌", body = ProblemDocument),
        (status = 422, description = "查询参数不合法", body = ProblemDocument),
    )
)]
pub async fn get_public_event_density(
    State(state): State<AppState>,
    Path(space_id): Path<String>,
    Query(query): Query<DensityQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let from = parse_time("from", Some(&query.from))?.expect("已给出");
    let to = parse_time("to", Some(&query.to))?.expect("已给出");
    if to <= from {
        return Err(ApiError::invalid("to 必须晚于 from"));
    }
    let range = to.millis_since(from);
    if range > MAX_DENSITY_MS {
        return Err(invalid_with("window_too_large", "密度查询最长 90 天"));
    }
    if query.bucket < 1 {
        return Err(ApiError::invalid("bucket 必须是正整数（秒）"));
    }
    let bucket_ms = query.bucket.saturating_mul(1000);
    let count = (range + bucket_ms - 1) / bucket_ms;
    if count > MAX_BUCKETS {
        return Err(invalid_with(
            "too_many_buckets",
            format!("最多 {MAX_BUCKETS} 个桶，请加大 bucket"),
        ));
    }
    let now = crate::now()?;
    let grant = public_space_grant(
        &state,
        &space_id,
        &headers,
        query.universe.as_deref(),
        to.min(now),
    )
    .await?;
    let anchors = public_anchor_ids(&state, &grant).await?;
    let counts = state
        .repo
        .public_event_density(&grant, from, to, bucket_ms, &anchors)
        .await?;
    let mut buckets: Vec<DensityBucketView> = (0..count)
        .map(|index| DensityBucketView {
            start: from.saturating_add_millis(index * bucket_ms),
            count: 0,
        })
        .collect();
    for (index, value) in counts {
        if let Some(bucket) = usize::try_from(index).ok().and_then(|i| buckets.get_mut(i)) {
            bucket.count = value;
        }
    }
    let response = Json(EventDensityView {
        from,
        to,
        bucket_sec: query.bucket,
        buckets,
    })
    .into_response();
    Ok(public_cache(response, grant.public_basis(), SHORT_CACHE))
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/api/public/spaces/{space_id}/state",
    operation_id = "get_public_state",
    tag = "public",
    description = "T 时刻各公开锚点的状态（状态类事件：每个 (锚点, 状态 key) 取 at ≤ T 的最后一条有效公开事件，clears 表示结束，超过 maxAgeSec 失效），不受时间窗限制。网站\"现在\"模式打开时先取 state?at=<现在>。服务端定期保存状态快照。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("Authorization" = Option<String>, Header, description = "`Share <空间或组合的分享令牌>`"),
        StateQuery,
    ),
    responses(
        (status = 200, description = "状态", body = StateAtView),
        (status = 404, description = "空间不存在，或没带有效的令牌", body = ProblemDocument),
        (status = 503, description = "事件太多，状态还在计算，稍后重试", body = ProblemDocument),
    )
)]
pub async fn get_public_state(
    State(state): State<AppState>,
    Path(space_id): Path<String>,
    Query(query): Query<StateQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let now = crate::now()?;
    let at = parse_time("at", query.at.as_deref())?.unwrap_or(now);
    let grant =
        public_space_grant(&state, &space_id, &headers, query.universe.as_deref(), at).await?;
    let states = public_state_at(&state, &grant, at)
        .await?
        .into_iter()
        .map(|state| AnchorStateView {
            anchor_id: state.anchor_id,
            key: state.key,
            value: state.value,
            at: state.since,
            event_id: state.event_id,
            event_type: state.event_type,
        })
        .collect();
    let response = Json(StateAtView { at, states }).into_response();
    Ok(public_cache(response, grant.public_basis(), SHORT_CACHE))
}
