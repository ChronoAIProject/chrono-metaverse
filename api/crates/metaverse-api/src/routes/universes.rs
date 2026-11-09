//! 组合宇宙的写接口（设计 4.5、8.3、12）。
//!
//! ```text
//! POST   /api/v1/universes                                   建组合（创建者是主人）
//! GET    /api/v1/universes/{universe_id}                     查看（主人和主人组织成员）
//! PATCH  /api/v1/universes/{universe_id}                     名称、可见性、摆放、连接、邀请、分享令牌（只有组合主人）
//! POST   /api/v1/universes/{universe_id}/members/{space_id}  加入（该空间的管理者调用）
//! DELETE /api/v1/universes/{universe_id}/members/{space_id}  退出（组合主人或该空间的管理者）
//! ```
//!
//! - 成员、摆放、连接每次变化都记一条修订（`universeRevisions`，存完整的新状态），修订的 `at`
//!   由服务端赋值 = max(现在, head.at)；名称、可见性、邀请、令牌只改组合文档，不产生修订；
//! - 调用方可以用 `baseSeq` 或 `If-Match` 说明基于哪个修订，组合已变返回 409；
//! - 组合不能比任何成员更公开：设为公开要求全部成员公开；公开组合不能加入凭链接查看的空间；
//! - 连接两端必须是成员空间的公开锚点；
//! - 加入：调用者要能管理该空间（空间主人、组织本身或组织 admin），并且能管理组合，或该空间
//!   在组合的邀请列表里（组合主人用 PATCH 的 `invitations` 邀请）。

use std::collections::BTreeSet;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use metaverse_core::ids::is_space_id;
use metaverse_core::model::{
    ActorKind, Owner, OwnerKind, Rotation, ShareTokenRecord, Universe, UniverseHead,
    UniverseLink, UniverseMember, UniverseRevision, UniverseState, Visibility,
};
use metaverse_core::scope::PathScope;
use metaverse_core::{sha256_hex, Timestamp};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::admin_spaces::{OwnerInput, ShareTokenView};
use super::ingest_common::{
    conflict_with, if_match_seq, invalid_with, no_store, path_actor, set_header,
};
use super::views::OwnerView;
use super::ApiJson;
use crate::auth::{Caller, MembershipBasis, MembershipChange, Purpose, UniverseGrant};
use crate::error::{ApiError, ProblemDocument};
use crate::repo::{RepoError, UniverseFieldsUpdate, UniverseWrite};
use crate::AppState;

/// 每个组合最多几个成员、几条连接。
pub const MAX_MEMBERS: usize = 64;
pub const MAX_LINKS: usize = 256;
/// 摆放的偏移（格）最大绝对值：5 厘米一格时约 500 公里。
pub const MAX_OFFSET: i64 = 10_000_000;
const MAX_NAME_CHARS: usize = 200;
const MAX_MESSAGE_CHARS: usize = 500;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/universes", post(create_universe))
        .route(
            "/api/v1/universes/{universe_id}",
            get(get_universe).patch(update_universe),
        )
        .route(
            "/api/v1/universes/{universe_id}/members/{space_id}",
            post(join_universe).delete(leave_universe),
        )
}

// ---------------------------------------------------------------------------
// 请求与视图
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateUniverseRequest {
    /// 组合编号：3–64 个字符，小写字母、数字和 `-`。
    #[schema(example = "street-demo")]
    pub id: String,
    pub name: String,
    /// 主人：默认是调用者本人；组织组合要求调用者是组织本身或组织 admin。
    #[serde(default)]
    pub owner: Option<OwnerInput>,
    /// 默认 `unlisted`（凭分享令牌）。
    #[serde(default)]
    #[schema(value_type = Option<String>, example = "unlisted")]
    pub visibility: Visibility,
}

/// 成员摆放：`offset` 以格为单位，`rotation` 绕 y 轴（0/90/180/270），先旋转再平移。
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemberPlacement {
    pub space_id: String,
    pub offset: [i64; 3],
    #[schema(value_type = u16, example = 90)]
    pub rotation: Rotation,
}

#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateUniverseRequest {
    /// 基于哪个修订（也可以用 If-Match）；组合已变返回 409。
    #[serde(default)]
    pub base_seq: Option<u64>,
    /// 修订说明。
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// 设为 `public` 要求全部成员都是公开空间。
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub visibility: Option<Visibility>,
    /// 全部成员的新摆放（成员集合必须和现在完全一样；加入、退出走成员接口）。
    #[serde(default)]
    pub members: Option<Vec<MemberPlacement>>,
    /// 新的连接列表（替换全部）：`[{from: {spaceId, anchorId}, to: {...}, kind: door|portal|street}]`，
    /// 两端必须是成员空间的公开锚点。
    #[serde(default)]
    #[schema(value_type = Option<Vec<Object>>)]
    pub links: Option<Vec<UniverseLink>>,
    /// 邀请加入的空间（替换全部）。被邀请空间的主人调用加入接口时不需要组合的管理权限。
    #[serde(default)]
    pub invitations: Option<Vec<String>>,
    /// 轮换分享令牌：吊销现有的全部令牌，签发一个新的（原文只返回这一次）。
    #[serde(default)]
    pub rotate_share_token: bool,
    /// 吊销指定的分享令牌。
    #[serde(default)]
    pub revoke_share_tokens: Vec<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinUniverseRequest {
    pub offset: [i64; 3],
    #[schema(value_type = u16, example = 0)]
    pub rotation: Rotation,
    #[serde(default)]
    pub base_seq: Option<u64>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeaveUniverseRequest {
    #[serde(default)]
    pub base_seq: Option<u64>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShareTokenInfo {
    pub id: String,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<String>, format = DateTime)]
    pub revoked_at: Option<Timestamp>,
}

/// 组合（`/api/v1`）。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UniverseView {
    pub id: String,
    pub name: String,
    pub owner: OwnerView,
    #[schema(value_type = String, example = "unlisted")]
    pub visibility: Visibility,
    /// 最新修订的 seq 和 at（新组合是 0）。
    pub seq: u64,
    #[schema(value_type = String, format = DateTime)]
    pub at: Timestamp,
    #[schema(value_type = Vec<Object>)]
    pub members: Vec<UniverseMember>,
    #[schema(value_type = Vec<Object>)]
    pub links: Vec<UniverseLink>,
    pub invitations: Vec<String>,
    /// 分享令牌（只有编号和时间，原文只在创建或轮换时返回一次）。只有组合主人能看到。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub share_tokens: Option<Vec<ShareTokenInfo>>,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
}

impl UniverseView {
    fn new(universe: Universe, manage: bool) -> Self {
        Self {
            share_tokens: manage.then(|| {
                universe
                    .share_tokens
                    .iter()
                    .map(|token| ShareTokenInfo {
                        id: token.id.clone(),
                        created_at: token.created_at,
                        revoked_at: token.revoked_at,
                    })
                    .collect()
            }),
            id: universe.id,
            name: universe.name,
            owner: OwnerView {
                kind: universe.owner.kind,
                id: universe.owner.id,
            },
            visibility: universe.visibility,
            seq: universe.head.seq,
            at: universe.head.at,
            members: universe.members,
            links: universe.links,
            invitations: universe.invitations,
            created_at: universe.created_at,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UniverseWriteResponse {
    pub universe: UniverseView,
    /// 只在创建或轮换时返回一次。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub share_token: Option<ShareTokenView>,
}

/// 加入、退出的结果。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MembershipResponse {
    pub universe_id: String,
    pub space_id: String,
    /// 新修订的 seq 和 at。
    pub seq: u64,
    #[schema(value_type = String, format = DateTime)]
    pub at: Timestamp,
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

fn check_text(name: &str, value: &str, max: usize, allow_empty: bool) -> Result<(), ApiError> {
    if (!allow_empty && value.trim().is_empty())
        || value.chars().count() > max
        || value.chars().any(|c| c.is_control() && c != '\n')
    {
        return Err(ApiError::invalid(format!("{name} 为空、太长或含控制字符")));
    }
    Ok(())
}

fn new_share_token() -> Result<(String, String), ApiError> {
    let random = SystemRandom::new();
    let mut secret = [0u8; 32];
    let mut id = [0u8; 9];
    random.fill(&mut secret).map_err(|_| ApiError::internal())?;
    random.fill(&mut id).map_err(|_| ApiError::internal())?;
    Ok((
        format!("ut_{}", URL_SAFE_NO_PAD.encode(id)),
        URL_SAFE_NO_PAD.encode(secret),
    ))
}

fn check_offset(offset: &[i64; 3]) -> Result<(), ApiError> {
    if offset.iter().all(|v| v.abs() <= MAX_OFFSET) {
        Ok(())
    } else {
        Err(ApiError::invalid(format!(
            "offset 每个分量的绝对值不能超过 {MAX_OFFSET} 格"
        )))
    }
}

/// 基准修订：请求体的 baseSeq 或 If-Match，二者都给时必须一致。
fn base_seq(body: Option<u64>, headers: &HeaderMap, current: u64) -> Result<(), ApiError> {
    let header = if_match_seq(headers)?;
    let base = match (body, header) {
        (Some(a), Some(b)) if a != b => {
            return Err(ApiError::invalid("baseSeq 与 If-Match 不一致"))
        }
        (Some(a), _) | (None, Some(a)) => Some(a),
        (None, None) => None,
    };
    match base {
        Some(base) if base != current => Err(conflict_with(
            "universe_changed",
            format!("组合已经变了：基于 seq {base}，最新是 {current}"),
        )),
        _ => Ok(()),
    }
}

fn changed() -> ApiError {
    conflict_with("universe_changed", "组合在这期间被修改了，请重新读取后再试")
}

fn revision(
    universe: &Universe,
    caller: &Caller,
    message: String,
    state: UniverseState,
    now: Timestamp,
) -> UniverseRevision {
    UniverseRevision {
        universe_id: universe.id.clone(),
        seq: universe.head.seq + 1,
        at: now.max(universe.head.at),
        // 组合修订没有对应的空间路径范围，记为管理类操作。
        actor: path_actor(caller, PathScope::Physical, ActorKind::Admin),
        message,
        state,
        owner: Some(universe.owner.clone()),
    }
}

fn universe_location(response: &mut Response, id: &str) {
    set_header(response, header::LOCATION, &format!("/api/v1/universes/{id}"));
}

// ---------------------------------------------------------------------------
// 建组合、查看
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/api/v1/universes",
    operation_id = "create_universe",
    tag = "universes",
    description = "建组合宇宙：把多个空间拼在一起展示。创建者是主人（默认本人；组织组合要求调用者是组织本身或组织 admin）。新组合没有成员；空间由各自的主人调用加入接口加入（组合主人可以先用 PATCH 的 invitations 邀请）。返回一次性的分享令牌原文。",
    request_body = CreateUniverseRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 201, description = "已创建", body = UniverseWriteResponse),
        (status = 403, description = "不能以这个主人创建", body = ProblemDocument),
        (status = 409, description = "编号已存在", body = ProblemDocument),
        (status = 422, description = "请求内容不合法", body = ProblemDocument),
        (status = 503, description = "查不到组织角色", body = ProblemDocument),
    )
)]
pub async fn create_universe(
    State(state): State<AppState>,
    caller: Caller,
    ApiJson(request): ApiJson<CreateUniverseRequest>,
) -> Result<Response, ApiError> {
    if !is_space_id(&request.id) {
        return Err(ApiError::invalid(
            "id 必须是 3–64 个字符的小写字母、数字和 -，首尾不能是 -",
        ));
    }
    check_text("name", &request.name, MAX_NAME_CHARS, false)?;
    let owner = match request.owner {
        Some(input) => Owner {
            kind: input.kind,
            id: input.id,
        },
        None => Owner {
            kind: OwnerKind::Person,
            id: caller.subject.clone(),
        },
    };
    let now = crate::now()?;
    let grant = state
        .authorizer
        .create_universe(&caller, &owner, now)
        .await?;
    let (token_id, token) = new_share_token()?;
    let universe = Universe {
        id: request.id,
        name: request.name.trim().to_owned(),
        owner,
        visibility: request.visibility,
        share_tokens: vec![ShareTokenRecord {
            id: token_id.clone(),
            hash: sha256_hex(token.as_bytes()),
            created_at: now,
            revoked_at: None,
        }],
        head: UniverseHead { seq: 0, at: now },
        members: Vec::new(),
        links: Vec::new(),
        created_at: now,
        owner_evidence: grant.evidence().cloned(),
        invitations: Vec::new(),
        updated_at: Some(now),
    };
    match state.repo.insert_universe(&grant, &universe).await {
        Ok(()) => {}
        Err(RepoError::Duplicate) => return Err(ApiError::conflict("组合编号已存在")),
        Err(error) => return Err(error.into()),
    }
    tracing::info!(universe = %universe.id, owner = %universe.owner.id, by = %caller.subject, "组合已创建");
    let id = universe.id.clone();
    let mut response = (
        StatusCode::CREATED,
        Json(UniverseWriteResponse {
            universe: UniverseView::new(universe, true),
            share_token: Some(ShareTokenView {
                id: token_id,
                token,
            }),
        }),
    )
        .into_response();
    universe_location(&mut response, &id);
    Ok(no_store(response))
}

#[utoipa::path(
    get,
    path = "/api/v1/universes/{universe_id}",
    operation_id = "get_universe",
    tag = "universes",
    description = "查看组合：成员和摆放、连接、邀请、最新修订 seq（同时作为 ETag）。组合主人和主人组织的成员可读，其他人 404。",
    params(("universe_id" = String, Path, description = "组合编号")),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "组合", body = UniverseView),
        (status = 404, description = "组合不存在或无权查看", body = ProblemDocument),
    )
)]
pub async fn get_universe(
    State(state): State<AppState>,
    caller: Caller,
    Path(universe_id): Path<String>,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .universe(&caller, &universe_id, Purpose::Read)
        .await?;
    let universe = state
        .repo
        .universe(&grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let etag = format!("\"{}\"", universe.head.seq);
    let mut response = Json(UniverseView::new(universe, grant.can_manage())).into_response();
    set_header(&mut response, header::ETAG, &etag);
    Ok(no_store(response))
}

// ---------------------------------------------------------------------------
// 修改
// ---------------------------------------------------------------------------

/// 成员空间当前的公开锚点和可见性（凭组合的成员资格读取）。
async fn member_facts(
    state: &AppState,
    grant: &UniverseGrant,
) -> Result<Vec<(String, Visibility, BTreeSet<String>)>, ApiError> {
    let now = crate::now()?;
    let (_, grants) = state
        .authorizer
        .universe_member_grants_at(grant, now)
        .await?;
    let mut facts = Vec::with_capacity(grants.len());
    for member in grants {
        let space = state
            .repo
            .space(&member)
            .await?
            .ok_or_else(ApiError::internal)?;
        let anchors = super::event_query::public_anchor_ids(state, &member).await?;
        facts.push((member.space_id().to_owned(), space.visibility, anchors));
    }
    Ok(facts)
}

#[utoipa::path(
    patch,
    path = "/api/v1/universes/{universe_id}",
    operation_id = "update_universe",
    tag = "universes",
    description = "修改组合（只有组合主人）：名称、可见性（组合不能比任何成员更公开）、全部成员的摆放（成员集合不变）、连接（两端必须是成员空间的公开锚点）、邀请列表、轮换或吊销分享令牌。摆放或连接变化时记一条修订。可用 baseSeq 或 If-Match 防止覆盖别人的修改（409）。",
    params(
        ("universe_id" = String, Path, description = "组合编号"),
        ("If-Match" = Option<String>, Header, description = "基于的修订 seq，例如 \"3\""),
    ),
    request_body = UpdateUniverseRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "已修改", body = UniverseWriteResponse),
        (status = 403, description = "不是组合主人", body = ProblemDocument),
        (status = 404, description = "组合不存在或无权查看", body = ProblemDocument),
        (status = 409, description = "组合已变，或可见性比成员更公开", body = ProblemDocument),
        (status = 422, description = "请求内容不合法", body = ProblemDocument),
    )
)]
pub async fn update_universe(
    State(state): State<AppState>,
    caller: Caller,
    Path(universe_id): Path<String>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<UpdateUniverseRequest>,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .universe(&caller, &universe_id, Purpose::Manage)
        .await?;
    let universe = state
        .repo
        .universe(&grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    base_seq(request.base_seq, &headers, universe.head.seq)?;
    let now = crate::now()?;
    let mut fields = UniverseFieldsUpdate::default();
    if let Some(name) = &request.name {
        check_text("name", name, MAX_NAME_CHARS, false)?;
        fields.name = Some(name.trim().to_owned());
    }
    let message = request.message.clone().unwrap_or_default();
    check_text("message", &message, MAX_MESSAGE_CHARS, true)?;
    let current: BTreeSet<&str> = universe
        .members
        .iter()
        .map(|member| member.space_id.as_str())
        .collect();
    let needs_facts = request.links.is_some() || request.visibility == Some(Visibility::Public);
    let facts = if needs_facts {
        member_facts(&state, &grant).await?
    } else {
        Vec::new()
    };
    if let Some(visibility) = request.visibility {
        if visibility == Visibility::Public {
            if let Some((space, _, _)) = facts.iter().find(|(_, v, _)| *v != Visibility::Public)
            {
                return Err(conflict_with(
                    "visibility_conflict",
                    format!("成员 {space} 是凭链接查看的空间，组合不能设为公开"),
                ));
            }
        }
        fields.visibility = Some(visibility);
    }
    let mut state_changed = false;
    let mut members = universe.members.clone();
    if let Some(placements) = &request.members {
        let given: BTreeSet<&str> = placements.iter().map(|m| m.space_id.as_str()).collect();
        if given != current || given.len() != placements.len() {
            return Err(invalid_with(
                "members_mismatch",
                "members 必须恰好列出现有的全部成员；加入、退出请用成员接口",
            ));
        }
        for placement in placements {
            check_offset(&placement.offset)?;
        }
        members = placements
            .iter()
            .map(|placement| UniverseMember {
                space_id: placement.space_id.clone(),
                offset: placement.offset,
                rotation: placement.rotation,
            })
            .collect();
        state_changed |= members != universe.members;
    }
    let mut links = universe.links.clone();
    if let Some(new_links) = &request.links {
        if new_links.len() > MAX_LINKS {
            return Err(ApiError::invalid(format!("连接最多 {MAX_LINKS} 条")));
        }
        for link in new_links {
            for end in [&link.from, &link.to] {
                let public = facts
                    .iter()
                    .find(|(space, _, _)| space == &end.space_id)
                    .is_some_and(|(_, _, anchors)| anchors.contains(&end.anchor_id));
                if !public {
                    return Err(invalid_with(
                        "link_anchor_not_public",
                        format!(
                            "连接两端必须是成员空间的公开锚点：{}/{}",
                            end.space_id, end.anchor_id
                        ),
                    ));
                }
            }
            if link.from == link.to {
                return Err(ApiError::invalid("连接的两端不能是同一个锚点"));
            }
        }
        links = new_links.clone();
        state_changed |= links != universe.links;
    }
    if let Some(invitations) = &request.invitations {
        let unique: BTreeSet<&String> = invitations.iter().collect();
        if invitations.len() > MAX_MEMBERS
            || unique.len() != invitations.len()
            || !invitations.iter().all(|id| is_space_id(id))
        {
            return Err(ApiError::invalid(format!(
                "invitations 最多 {MAX_MEMBERS} 个不重复的空间编号"
            )));
        }
        if let Some(member) = invitations.iter().find(|id| current.contains(id.as_str())) {
            return Err(ApiError::invalid(format!("{member} 已经是成员")));
        }
        fields.invitations = Some(invitations.clone());
    }
    let mut new_token = None;
    if request.rotate_share_token || !request.revoke_share_tokens.is_empty() {
        let mut tokens = universe.share_tokens.clone();
        for token in &mut tokens {
            let revoke = request.rotate_share_token
                || request.revoke_share_tokens.iter().any(|id| id == &token.id);
            if revoke && token.revoked_at.is_none() {
                token.revoked_at = Some(now);
            }
        }
        if request.rotate_share_token {
            let (id, token) = new_share_token()?;
            tokens.push(ShareTokenRecord {
                id: id.clone(),
                hash: sha256_hex(token.as_bytes()),
                created_at: now,
                revoked_at: None,
            });
            new_token = Some(ShareTokenView { id, token });
        }
        fields.share_tokens = Some(tokens);
    }
    let revision = state_changed.then(|| {
        revision(
            &universe,
            &caller,
            message,
            UniverseState {
                members: members.clone(),
                links: links.clone(),
            },
            now,
        )
    });
    match state
        .repo
        .update_universe(&grant, universe.head.seq, &fields, revision.as_ref(), now)
        .await?
    {
        UniverseWrite::Applied => {}
        UniverseWrite::Conflict => return Err(changed()),
    }
    tracing::info!(universe = %universe_id, revision = ?revision.as_ref().map(|r| r.seq), by = %caller.subject, "组合已修改");
    let updated = state
        .repo
        .universe(&grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(no_store(
        Json(UniverseWriteResponse {
            universe: UniverseView::new(updated, true),
            share_token: new_token,
        })
        .into_response(),
    ))
}

// ---------------------------------------------------------------------------
// 加入、退出
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/api/v1/universes/{universe_id}/members/{space_id}",
    operation_id = "join_universe",
    tag = "universes",
    description = "把空间加入组合（记一条修订）。必须由该空间的管理者（空间主人、组织本身或组织 admin）调用，所以别人不能把你的空间拉进他的组合；同时调用者要能管理这个组合，或者这个空间在组合的邀请列表里。加入就等于同意凭组合的分享链接查看本空间的公开数据。公开组合不能加入凭链接查看的空间（409）。",
    params(
        ("universe_id" = String, Path, description = "组合编号"),
        ("space_id" = String, Path, description = "要加入的空间编号"),
    ),
    request_body = JoinUniverseRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "已加入", body = MembershipResponse),
        (status = 403, description = "不能管理这个空间", body = ProblemDocument),
        (status = 404, description = "组合或空间不存在，或没有被邀请", body = ProblemDocument),
        (status = 409, description = "已经是成员、组合已变或可见性冲突", body = ProblemDocument),
        (status = 422, description = "摆放不合法", body = ProblemDocument),
    )
)]
pub async fn join_universe(
    State(state): State<AppState>,
    caller: Caller,
    Path((universe_id, space_id)): Path<(String, String)>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<JoinUniverseRequest>,
) -> Result<Response, ApiError> {
    let membership = state
        .authorizer
        .universe_membership(&caller, &universe_id, &space_id, MembershipChange::Join)
        .await?;
    let universe = state
        .repo
        .universe(membership.universe())
        .await?
        .ok_or_else(ApiError::not_found)?;
    if membership.basis() == MembershipBasis::Invited
        && !universe.invitations.iter().any(|id| id == &space_id)
    {
        return Err(ApiError::not_found());
    }
    if universe.members.iter().any(|member| member.space_id == space_id) {
        return Err(conflict_with("already_member", "这个空间已经是组合成员"));
    }
    if universe.members.len() >= MAX_MEMBERS {
        return Err(conflict_with(
            "too_many_members",
            format!("组合最多 {MAX_MEMBERS} 个成员"),
        ));
    }
    base_seq(request.base_seq, &headers, universe.head.seq)?;
    check_offset(&request.offset)?;
    let message = request
        .message
        .clone()
        .unwrap_or_else(|| format!("{space_id} 加入"));
    check_text("message", &message, MAX_MESSAGE_CHARS, true)?;
    let space_grant = membership.space().ok_or_else(ApiError::internal)?;
    let space = state
        .repo
        .space(space_grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if universe.visibility == Visibility::Public && space.visibility != Visibility::Public {
        return Err(conflict_with(
            "visibility_conflict",
            "公开组合不能加入凭链接查看的空间（组合不能比任何成员更公开）",
        ));
    }
    let now = crate::now()?;
    let mut members = universe.members.clone();
    members.push(UniverseMember {
        space_id: space_id.clone(),
        offset: request.offset,
        rotation: request.rotation,
    });
    let invitations: Vec<String> = universe
        .invitations
        .iter()
        .filter(|id| *id != &space_id)
        .cloned()
        .collect();
    let revision = revision(
        &universe,
        &caller,
        message,
        UniverseState {
            members,
            links: universe.links.clone(),
        },
        now,
    );
    match state
        .repo
        .change_membership(&membership, universe.head.seq, &revision, &invitations, now)
        .await?
    {
        UniverseWrite::Applied => {}
        UniverseWrite::Conflict => return Err(changed()),
    }
    tracing::info!(universe = %universe_id, space = %space_id, seq = revision.seq, by = %caller.subject, "空间加入组合");
    Ok(no_store(
        Json(MembershipResponse {
            universe_id,
            space_id,
            seq: revision.seq,
            at: revision.at,
        })
        .into_response(),
    ))
}

#[utoipa::path(
    delete,
    path = "/api/v1/universes/{universe_id}/members/{space_id}",
    operation_id = "leave_universe",
    tag = "universes",
    description = "让空间退出组合（记一条修订，同时去掉连到这个空间的连接）。组合主人可以移除任何成员；空间的管理者随时可以让本空间退出。",
    params(
        ("universe_id" = String, Path, description = "组合编号"),
        ("space_id" = String, Path, description = "要退出的空间编号"),
        ("If-Match" = Option<String>, Header, description = "基于的修订 seq"),
    ),
    request_body(content = LeaveUniverseRequest, description = "可省略"),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "已退出", body = MembershipResponse),
        (status = 403, description = "既不能管理组合也不能管理这个空间", body = ProblemDocument),
        (status = 404, description = "组合不存在，或这个空间不是成员", body = ProblemDocument),
        (status = 409, description = "组合已变", body = ProblemDocument),
    )
)]
pub async fn leave_universe(
    State(state): State<AppState>,
    caller: Caller,
    Path((universe_id, space_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, ApiError> {
    let request: LeaveUniverseRequest = super::ingest_common::optional_json(&body)?;
    let membership = state
        .authorizer
        .universe_membership(&caller, &universe_id, &space_id, MembershipChange::Leave)
        .await?;
    let universe = state
        .repo
        .universe(membership.universe())
        .await?
        .ok_or_else(ApiError::not_found)?;
    if !universe.members.iter().any(|member| member.space_id == space_id) {
        return Err(ApiError::not_found());
    }
    base_seq(request.base_seq, &headers, universe.head.seq)?;
    let message = request
        .message
        .clone()
        .unwrap_or_else(|| format!("{space_id} 退出"));
    check_text("message", &message, MAX_MESSAGE_CHARS, true)?;
    let now = crate::now()?;
    let members = universe
        .members
        .iter()
        .filter(|member| member.space_id != space_id)
        .cloned()
        .collect();
    let links = universe
        .links
        .iter()
        .filter(|link| link.from.space_id != space_id && link.to.space_id != space_id)
        .cloned()
        .collect();
    let revision = revision(
        &universe,
        &caller,
        message,
        UniverseState { members, links },
        now,
    );
    match state
        .repo
        .change_membership(
            &membership,
            universe.head.seq,
            &revision,
            &universe.invitations,
            now,
        )
        .await?
    {
        UniverseWrite::Applied => {}
        UniverseWrite::Conflict => return Err(changed()),
    }
    tracing::info!(universe = %universe_id, space = %space_id, seq = revision.seq, by = %caller.subject, "空间退出组合");
    Ok(no_store(
        Json(MembershipResponse {
            universe_id,
            space_id,
            seq: revision.seq,
            at: revision.at,
        })
        .into_response(),
    ))
}
