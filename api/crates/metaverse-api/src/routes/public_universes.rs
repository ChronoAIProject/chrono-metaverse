//! 组合宇宙的公开读接口（设计 5.5、8.2），JSON 形状与网站 `UniverseView`、`UniverseRevision` 一致。
//!
//! ```text
//! GET /api/public/universes/{id}?at=            T 时刻生效的修订 + 各成员在 T 时刻的 seq（不缓存）
//! GET /api/public/universes/{id}/revisions/{seq}  某一次修订（长缓存）
//! ```
//!
//! 组合实际公开（组合和全部成员都公开）时无需令牌；否则要 `Authorization: Share <组合令牌>`，
//! 没带或无效一律 404。查看器拿到各成员的 seq 后，带同一个令牌和 `?universe=<组合编号>`
//! 调用各成员空间的公开接口。

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use metaverse_core::model::{Rotation, UniverseLink};
use metaverse_core::Timestamp;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::ingest_common::{parse_time, public_cache};
use super::public_access::share_token;
use crate::error::{ApiError, ProblemDocument};
use crate::AppState;

/// 修订不可变，可以长缓存（一天）。
const REVISION_CACHE: u32 = 24 * 3600;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/public/universes/{universe_id}", get(get_public_universe))
        .route(
            "/api/public/universes/{universe_id}/revisions/{seq}",
            get(get_public_universe_revision),
        )
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct UniverseAtQuery {
    /// 时刻（RFC 3339），默认现在。
    pub at: Option<String>,
}

/// 成员与摆放（网站 `UniverseMember`）。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicMemberView {
    pub space_id: String,
    /// 以格为单位。
    pub offset: [i64; 3],
    #[schema(value_type = u16)]
    pub rotation: Rotation,
    /// 该成员在 T 时刻的 seq（只在按时刻查询时给出）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

/// T 时刻的组合（网站 `UniverseView`）。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicUniverseView {
    pub id: String,
    pub name: String,
    /// 生效修订的 seq；T 之前没有修订时是 0。
    pub seq: u64,
    /// 生效修订的时间；没有修订时是组合的创建时间。
    #[schema(value_type = String, format = DateTime)]
    pub at: Timestamp,
    pub members: Vec<PublicMemberView>,
    #[schema(value_type = Vec<Object>)]
    pub links: Vec<UniverseLink>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PublicRevisionState {
    pub members: Vec<PublicMemberView>,
    #[schema(value_type = Vec<Object>)]
    pub links: Vec<UniverseLink>,
}

/// 一次组合修订（网站 `UniverseRevision`）。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicRevisionView {
    pub universe_id: String,
    pub seq: u64,
    #[schema(value_type = String, format = DateTime)]
    pub at: Timestamp,
    pub message: String,
    pub state: PublicRevisionState,
}

#[utoipa::path(
    get,
    path = "/api/public/universes/{universe_id}",
    operation_id = "get_public_universe",
    tag = "public",
    description = "T 时刻生效的组合修订（成员、摆放、连接）和各成员在 T 时刻的 seq；查看器再按这些 seq 调用各成员的 snapshot?seq=（带同一个组合令牌和 ?universe=）。组合实际公开时无需令牌，否则要 `Authorization: Share <组合的分享令牌>`。不缓存。",
    params(
        ("universe_id" = String, Path, description = "组合编号"),
        ("Authorization" = Option<String>, Header, description = "`Share <组合的分享令牌>`"),
        UniverseAtQuery,
    ),
    responses(
        (status = 200, description = "组合", body = PublicUniverseView),
        (status = 404, description = "组合不存在，或没带有效的令牌", body = ProblemDocument),
    )
)]
pub async fn get_public_universe(
    State(state): State<AppState>,
    Path(universe_id): Path<String>,
    Query(query): Query<UniverseAtQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let at = parse_time("at", query.at.as_deref())?.unwrap_or(crate::now()?);
    let grant = state
        .authorizer
        .public_universe(&universe_id, share_token(&headers))
        .await?;
    let universe = state
        .repo
        .universe(&grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let (revision, member_grants) = state
        .authorizer
        .universe_member_grants_at(&grant, at)
        .await?;
    let view = match revision {
        None => PublicUniverseView {
            id: universe.id,
            name: universe.name,
            seq: 0,
            at: universe.created_at,
            members: Vec::new(),
            links: Vec::new(),
        },
        Some(revision) => {
            let mut members = Vec::with_capacity(revision.state.members.len());
            for (member, member_grant) in revision.state.members.iter().zip(&member_grants) {
                members.push(PublicMemberView {
                    space_id: member.space_id.clone(),
                    offset: member.offset,
                    rotation: member.rotation,
                    seq: Some(state.repo.space_seq_at(member_grant, at).await?),
                });
            }
            PublicUniverseView {
                id: universe.id,
                name: universe.name,
                seq: revision.seq,
                at: revision.at,
                members,
                links: revision.state.links,
            }
        }
    };
    let mut response = Json(view).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/api/public/universes/{universe_id}/revisions/{seq}",
    operation_id = "get_public_universe_revision",
    tag = "public",
    description = "某一次组合修订的内容（成员、摆放、连接、说明）。修订不可变，可以长缓存；凭令牌访问时是 private 缓存。",
    params(
        ("universe_id" = String, Path, description = "组合编号"),
        ("seq" = u64, Path, description = "修订序号（从 1 开始）"),
        ("Authorization" = Option<String>, Header, description = "`Share <组合的分享令牌>`"),
    ),
    responses(
        (status = 200, description = "修订", body = PublicRevisionView),
        (status = 404, description = "修订不存在，或没带有效的令牌", body = ProblemDocument),
    )
)]
pub async fn get_public_universe_revision(
    State(state): State<AppState>,
    Path((universe_id, seq)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .public_universe(&universe_id, share_token(&headers))
        .await?;
    let seq: u64 = seq.parse().map_err(|_| ApiError::not_found())?;
    let revision = state
        .repo
        .universe_revision(&grant, seq)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let view = PublicRevisionView {
        universe_id: revision.universe_id,
        seq: revision.seq,
        at: revision.at,
        message: revision.message,
        state: PublicRevisionState {
            members: revision
                .state
                .members
                .into_iter()
                .map(|member| PublicMemberView {
                    space_id: member.space_id,
                    offset: member.offset,
                    rotation: member.rotation,
                    seq: None,
                })
                .collect(),
            links: revision.state.links,
        },
    };
    Ok(public_cache(
        Json(view).into_response(),
        grant.public_basis(),
        REVISION_CACHE,
    ))
}
