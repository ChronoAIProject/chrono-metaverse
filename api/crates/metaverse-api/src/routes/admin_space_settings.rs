//! 管理接口（设计 8.4）：修改名称和可见性、轮换分享令牌、定义区域和地块、删除空间。
//!
//! 这组接口不写进注册给 NyxID 的 OpenAPI，但这不是安全边界：服务端照样按 9.2 要求"管理"级别
//! （主人本人、组织本身或组织 admin）。
//!
//! - 凭链接查看改成公开时，全部历史会随之公开且收不回，必须显式传 `confirmPublicHistory: true`；
//! - 轮换分享令牌会吊销全部现有令牌，新令牌原文只返回这一次；
//! - 区域和地块的修改写成一次提交（`regionsHash` 指向 `stateBlobs` 里的区域清单）；
//! - 删除空间要求 `?confirm=<空间编号>`。

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use metaverse_core::model::{
    validate_layout, ActorKind, Plot, Region, ShareTokenRecord, Visibility,
};
use metaverse_core::scope::PathScope;
use metaverse_core::sha256_hex;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::admin_spaces::{check_text, new_share_token, ShareTokenView};
use super::views::SpaceView;
use super::ApiJson;
use crate::auth::permissions::Capability;
use crate::auth::{Caller, Purpose};
use crate::error::{ApiError, ProblemDocument};
use crate::repo::{BlobKind, CommitError, CommitPlan, Layout, SpaceSettings};
use crate::timeline::writer::{actor, attach_keyframe, commit, ensure_genesis};
use crate::AppState;

/// 区域数上限。
pub const MAX_REGIONS: usize = 256;
/// 地块数上限。
pub const MAX_PLOTS: usize = 1024;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateSpaceRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    /// `unlisted` 或 `public`。
    #[schema(value_type = Option<String>, example = "public")]
    pub visibility: Option<Visibility>,
    /// 凭链接查看 → 公开时必须为 `true`：全部历史（区块、资源、提交）会随之公开，且收不回。
    #[serde(default)]
    pub confirm_public_history: bool,
}

#[utoipa::path(
    patch,
    path = "/api/v1/admin/spaces/{space_id}",
    operation_id = "admin_update_space",
    tag = "admin",
    request_body = UpdateSpaceRequest,
    params(("space_id" = String, Path, description = "空间编号")),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "修改后的空间", body = SpaceView),
        (status = 403, description = "只有只读权限", body = ProblemDocument),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
        (status = 409, description = "改成公开但没有确认公开全部历史", body = ProblemDocument),
        (status = 422, description = "请求内容不合法", body = ProblemDocument),
    )
)]
pub async fn update_space(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
    ApiJson(request): ApiJson<UpdateSpaceRequest>,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .space(&caller, &space_id, Purpose::Manage)
        .await?;
    if let Some(name) = &request.name {
        check_text("name", name, 200, false)?;
    }
    if let Some(description) = &request.description {
        check_text("description", description, 2000, true)?;
    }
    let space = state
        .repo
        .space(&grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if space.visibility == Visibility::Unlisted
        && request.visibility == Some(Visibility::Public)
        && !request.confirm_public_history
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "confirmation_required",
            "改成公开后，全部历史（区块、资源、提交和公开锚点）都会公开，已发出的内容收不回；确认后请带 confirmPublicHistory: true 重试",
        ));
    }
    let settings = SpaceSettings {
        name: request.name.map(|n| n.trim().to_owned()),
        description: request.description,
        visibility: request.visibility,
    };
    let now = crate::now()?;
    if !state
        .repo
        .update_space_settings(&grant, &settings, now)
        .await?
    {
        return Err(ApiError::not_found());
    }
    state.public.cache.invalidate_space(&space_id);
    tracing::info!(target: "audit", space = %space_id, by = %caller.subject, visibility = ?settings.visibility, "空间设置已修改");
    let space = state
        .repo
        .space(&grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let anchors = state.repo.anchors(&grant).await?;
    let mut response = Json(SpaceView::new(space, anchors)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/api/v1/admin/spaces/{space_id}/share-tokens",
    operation_id = "admin_rotate_share_token",
    tag = "admin",
    params(("space_id" = String, Path, description = "空间编号")),
    security(("nyxid_identity" = [])),
    responses(
        (status = 201, description = "新令牌；原文只返回这一次，旧令牌全部吊销", body = ShareTokenView),
        (status = 403, description = "只有只读权限", body = ProblemDocument),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
    )
)]
pub async fn rotate_share_token(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .space(&caller, &space_id, Purpose::Manage)
        .await?;
    let (id, token) = new_share_token()?;
    let now = crate::now()?;
    let record = ShareTokenRecord {
        id: id.clone(),
        hash: sha256_hex(token.as_bytes()),
        created_at: now,
        revoked_at: None,
    };
    if !state.repo.rotate_share_tokens(&grant, &record, now).await? {
        return Err(ApiError::not_found());
    }
    tracing::info!(target: "audit", space = %space_id, by = %caller.subject, token = %id, "分享令牌已轮换");
    let mut response = (StatusCode::CREATED, Json(ShareTokenView { id, token })).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetLayoutRequest {
    /// 全部区域：`{id, kind: physical|virtual, boxes: [[x0,y0,z0,x1,y1,z1]], name?}`（格，半开区间）。
    #[schema(value_type = Vec<Object>)]
    pub regions: Vec<Region>,
    /// 全部地块：`{id, regionId, boxes, name?}`，必须落在所属的虚拟区内。
    #[serde(default)]
    #[schema(value_type = Vec<Object>)]
    pub plots: Vec<Plot>,
    /// 提交说明。
    #[serde(default)]
    pub message: Option<String>,
    /// 基于哪个版本；给了而时间线已经前进就返回 409。
    #[serde(default)]
    pub base_seq: Option<u64>,
}

/// 写入的提交。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommitResultView {
    pub commit_id: String,
    pub seq: u64,
    pub at: String,
}

#[utoipa::path(
    put,
    path = "/api/v1/admin/spaces/{space_id}/layout",
    operation_id = "admin_set_layout",
    tag = "admin",
    request_body = SetLayoutRequest,
    params(("space_id" = String, Path, description = "空间编号")),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "已写成一次提交", body = CommitResultView),
        (status = 403, description = "只有只读权限", body = ProblemDocument),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
        (status = 409, description = "时间线已经前进（baseSeq 不一致）", body = ProblemDocument),
        (status = 422, description = "区域或地块不合法", body = ProblemDocument),
    )
)]
pub async fn set_layout(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
    ApiJson(request): ApiJson<SetLayoutRequest>,
) -> Result<Response, ApiError> {
    // 区域和地块写成一次提交，属于内容写入：功能级开关打开时要求 `metaverse:content:write`。
    state
        .authorizer
        .require_capability(&caller, Capability::WriteContent)?;
    let grant = state
        .authorizer
        .space(&caller, &space_id, Purpose::Manage)
        .await?;
    if request.regions.len() > MAX_REGIONS || request.plots.len() > MAX_PLOTS {
        return Err(ApiError::invalid(format!(
            "区域最多 {MAX_REGIONS} 个，地块最多 {MAX_PLOTS} 个"
        )));
    }
    validate_layout(&request.regions, &request.plots).map_err(ApiError::invalid)?;
    for name in request
        .regions
        .iter()
        .filter_map(|region| region.name.as_deref())
        .chain(request.plots.iter().filter_map(|plot| plot.name.as_deref()))
    {
        check_text("name", name, 200, false)?;
    }
    let message = request
        .message
        .unwrap_or_else(|| "修改区域和地块".to_owned());
    check_text("message", &message, 2000, false)?;
    let now = crate::now()?;
    ensure_genesis(&state.repo, &grant, &caller, now).await?;
    let space = state
        .repo
        .space(&grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let head = space.head.seq;
    if request.base_seq.is_some_and(|base| base != head) {
        return Err(ApiError::conflict(format!(
            "时间线已经前进到 seq {head}，请基于最新版本重试"
        )));
    }
    let layout = Layout {
        regions: request.regions,
        plots: request.plots,
    };
    let body = serde_json::to_value(&layout).map_err(|_| ApiError::internal())?;
    let regions_hash = state
        .repo
        .put_state_blob(&grant, BlobKind::Regions, &body)
        .await?;
    let mut plan = CommitPlan::new(
        head,
        actor(&caller, PathScope::Physical, ActorKind::Admin),
        message,
    );
    plan.layout = Some((regions_hash, layout.regions, layout.plots));
    let manifest = state.repo.manifest_at(&grant, head).await?;
    attach_keyframe(&state.repo, &grant, &mut plan, &manifest).await?;
    let outcome = match commit(&state.repo, &grant, &plan, now).await {
        Ok(outcome) => outcome,
        Err(CommitError::HeadMoved) => {
            return Err(ApiError::conflict("时间线在写入期间前进了，请重试"))
        }
        Err(CommitError::Missing) => return Err(ApiError::not_found()),
        Err(CommitError::DraftChanged) => return Err(ApiError::internal()),
        Err(CommitError::Repo(error)) => return Err(error.into()),
    };
    state.public.cache.invalidate_space(&space_id);
    tracing::info!(target: "audit", space = %space_id, by = %caller.subject, seq = outcome.seq, "区域和地块已修改");
    let mut response = Json(CommitResultView {
        commit_id: outcome.commit_id,
        seq: outcome.seq,
        at: outcome.at.to_rfc3339(),
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

/// 删除空间的确认参数。
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct DeleteQuery {
    /// 必须等于空间编号。
    pub confirm: Option<String>,
}

#[utoipa::path(
    delete,
    path = "/api/v1/admin/spaces/{space_id}",
    operation_id = "admin_delete_space",
    tag = "admin",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        DeleteQuery,
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 204, description = "已删除空间及其时间线、草稿、事件"),
        (status = 403, description = "只有只读权限", body = ProblemDocument),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
        (status = 422, description = "没有带 confirm=<空间编号>", body = ProblemDocument),
        (status = 503, description = "清理没做完（数据库暂时不可用）；再调用一次会接着清理", body = ProblemDocument),
    )
)]
pub async fn delete_space(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
    Query(query): Query<DeleteQuery>,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .space_for_deletion(&caller, &space_id)
        .await?;
    if query.confirm.as_deref() != Some(space_id.as_str()) {
        return Err(ApiError::invalid(
            "删除空间不可恢复，请带 ?confirm=<空间编号> 确认",
        ));
    }
    let now = crate::now()?;
    // 1. 墓碑：之后谁都拿不到这个空间，编号仍被占着，清理完之前别人不能用它新建空间。
    if !state.repo.mark_space_deleting(&grant, now).await? {
        return Err(ApiError::not_found());
    }
    state.public.cache.invalidate_space(&space_id);
    // 2. 移出所有组合（写退出修订）：空间编号删除后可以被别人重新注册，留在组合里的旧编号
    //    不能让新空间被凭别人的组合令牌读取（设计 12）。
    let actor = super::ingest_common::path_actor(
        &caller,
        metaverse_core::scope::PathScope::Physical,
        metaverse_core::model::ActorKind::Admin,
    );
    state
        .repo
        .remove_space_from_universes(&grant, &actor, now)
        .await?;
    // 3. 清理子集合，最后删掉空间文档。中途失败时墓碑还在，再次调用本接口会接着清理。
    if !state.repo.purge_deleting_space(&grant).await? {
        return Err(ApiError::not_found());
    }
    state.public.cache.invalidate_space(&space_id);
    tracing::warn!(target: "audit", space = %space_id, by = %caller.subject, "空间已删除");
    Ok(StatusCode::NO_CONTENT.into_response())
}
