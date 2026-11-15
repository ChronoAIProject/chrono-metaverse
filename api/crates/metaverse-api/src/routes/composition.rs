//! 空间原生组合入口；旧 Universe 路径仅保留协议兼容。

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use metaverse_core::{
    model::{AnchorRef, Rotation, UniverseLink},
    Timestamp,
};
use serde::Serialize;
use utoipa::ToSchema;

use super::{public_access::share_token, public_universes::UniverseAtQuery, universes};
use crate::{
    error::{ApiError, ProblemDocument},
    AppState,
};

pub fn write_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/spaces/{universe_id}/composition",
            get(get_composition).patch(update_composition),
        )
        .route(
            "/api/v1/spaces/{universe_id}/children/{space_id}",
            axum::routing::post(join_child).delete(leave_child),
        )
}

pub fn public_routes() -> Router<AppState> {
    Router::new().route("/api/public/spaces/{space_id}/scene", get(get_scene))
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SceneMember {
    /// 摆放实例路径；同一空间可在不同分支出现。
    pub space_id: String,
    pub source_space_id: String,
    /// 根空间为空，子空间请求通过此路径逐级验证成员期。
    pub access_path: Option<String>,
    pub name: String,
    pub seq: Option<u64>,
    pub offset: [i64; 3],
    #[schema(value_type = u16)]
    pub rotation: Rotation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_id: Option<String>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpaceScene {
    pub id: String,
    pub name: String,
    pub seq: u64,
    #[schema(value_type = String)]
    pub at: Timestamp,
    pub members: Vec<SceneMember>,
    #[schema(value_type = Vec<Object>)]
    pub links: Vec<UniverseLink>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme_id: Option<String>,
}

#[utoipa::path(get, path = "/api/public/spaces/{space_id}/scene", operation_id = "get_space_scene", tag = "public",
    params(("space_id" = String, Path, description = "根空间编号"), UniverseAtQuery),
    responses((status = 200, description = "同一时刻展开的空间实例、摆放和连接", body = SpaceScene), (status = 404, description = "空间不存在或无权查看", body = ProblemDocument)))]
pub async fn get_scene(
    State(state): State<AppState>,
    Path(root): Path<String>,
    Query(query): Query<UniverseAtQuery>,
    headers: super::public_access::ViewerHeaders,
) -> Result<Response, ApiError> {
    let at = super::ingest_common::parse_time("at", query.at.as_deref())?.unwrap_or(crate::now()?);
    let token = share_token(&headers);
    let browser = headers.browser_grant(&root, None)?;
    let root_grant =
        super::public_access::public_space_grant(&state, &root, &headers, None, at).await?;
    let space = state
        .repo
        .space(&root_grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let root_seq = state.repo.space_seq_at(&root_grant, at).await?;
    let root_composition = state.repo.composition_at(&root_grant, at).await?;
    let mut view = SpaceScene {
        id: root.clone(),
        name: space.name,
        seq: root_seq.unwrap_or(0),
        at,
        members: Vec::new(),
        links: Vec::new(),
        theme_id: root_composition.theme_id,
    };
    // 本地坐标先旋转、再平移，累计的变换始终保持整数格。
    let mut pending = vec![(
        root.clone(),
        root.clone(),
        None::<String>,
        [0_i64; 3],
        Rotation::R0,
        None::<String>,
    )];
    while let Some((id, instance, parent_path, offset, rotation, style_id)) = pending.pop() {
        if view.members.len() >= 256 {
            return Err(ApiError::invalid("展开的空间实例超过上限"));
        }
        let grant = if let Some(path) = &parent_path {
            let member = if browser.is_some() {
                state
                    .authorizer
                    .browser_composition_member(&root_grant, &id, path)
                    .await
            } else {
                state
                    .authorizer
                    .public_space_via_universe(&id, path, token, at)
                    .await
            };
            match member {
                Ok(grant) => grant,
                Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => continue,
                Err(error) => return Err(error),
            }
        } else {
            root_grant.clone()
        };
        if grant
            .membership()
            .is_some_and(|periods| !periods.contains(at))
        {
            continue;
        }
        let Some(space) = state.repo.space(&grant).await? else {
            continue;
        };
        let composition = state.repo.composition_at(&grant, at).await?;
        let seq = state.repo.space_seq_at(&grant, at).await?;
        view.members.push(SceneMember {
            space_id: instance.clone(),
            source_space_id: id.clone(),
            access_path: parent_path,
            name: space.name,
            seq,
            offset,
            rotation,
            style_id,
        });
        let local_ref = |end: AnchorRef| AnchorRef {
            space_id: if end.space_id == id {
                instance.clone()
            } else {
                format!("{instance}/{}", end.space_id)
            },
            anchor_id: end.anchor_id,
        };
        view.links
            .extend(composition.links.into_iter().map(|link| UniverseLink {
                from: local_ref(link.from),
                to: local_ref(link.to),
                kind: link.kind,
            }));
        for member in composition.members.into_iter().rev() {
            if instance.split('/').count() > 8
                || instance
                    .split('/')
                    .any(|ancestor| ancestor == member.space_id)
            {
                continue;
            }
            let placed = rotation.place(member.offset, offset);
            let rotated = (u16::from(rotation) + u16::from(member.rotation)) % 360;
            pending.push((
                member.space_id.clone(),
                format!("{instance}/{}", member.space_id),
                Some(instance.clone()),
                placed,
                Rotation::try_from(rotated).map_err(ApiError::invalid)?,
                member.style_id,
            ));
        }
    }
    let shown: std::collections::BTreeSet<_> = view
        .members
        .iter()
        .map(|member| member.space_id.as_str())
        .collect();
    view.links.retain(|link| {
        shown.contains(link.from.space_id.as_str()) && shown.contains(link.to.space_id.as_str())
    });
    let mut response = Json(view).into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

/// 普通空间的组合设置写入结果。
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompositionWriteResponse {
    pub composition: universes::UniverseView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub share_token: Option<super::admin_spaces::ShareTokenView>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChildChangeResponse {
    pub space_id: String,
    pub child_id: String,
    pub seq: u64,
    #[schema(value_type = String)]
    pub at: Timestamp,
}

/// 复用既有事务与校验，在新协议中统一使用空间和子空间的字段名。
async fn native_write_response(response: Response, membership: bool) -> Result<Response, ApiError> {
    let (mut parts, body) = response.into_parts();
    parts.headers.remove(axum::http::header::CONTENT_LENGTH);
    let bytes = axum::body::to_bytes(body, 2 * 1024 * 1024)
        .await
        .map_err(|_| ApiError::internal())?;
    let mut value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::internal())?;
    let object = value.as_object_mut().ok_or_else(ApiError::internal)?;
    if membership {
        let child = object.remove("spaceId").ok_or_else(ApiError::internal)?;
        let parent = object.remove("universeId").ok_or_else(ApiError::internal)?;
        object.insert("spaceId".into(), parent);
        object.insert("childId".into(), child);
    } else if let Some(composition) = object.remove("universe") {
        object.insert("composition".into(), composition);
    }
    let mut response = Json(value).into_response();
    *response.status_mut() = parts.status;
    *response.headers_mut() = parts.headers;
    Ok(response)
}

#[utoipa::path(get, path = "/api/v1/spaces/{space_id}/composition", operation_id = "get_space_composition", tag = "spaces", params(("space_id" = String, Path, description = "父空间编号")), security(("nyxid_identity" = [])),
    responses((status = 200, description = "空间子空间状态", body = universes::UniverseView), (status = 404, description = "空间不存在或无权访问", body = ProblemDocument), (status = 409, description = "空间版本已变化", body = ProblemDocument)))]
pub async fn get_composition(
    state: State<AppState>,
    caller: crate::auth::Caller,
    path: Path<String>,
) -> Result<Response, ApiError> {
    universes::get_universe(state, caller, path).await
}

#[utoipa::path(patch, path = "/api/v1/spaces/{space_id}/composition", operation_id = "update_space_composition", tag = "spaces", params(("space_id" = String, Path, description = "父空间编号")), request_body = universes::UpdateUniverseRequest, security(("nyxid_identity" = [])),
    responses((status = 200, description = "空间子空间状态", body = CompositionWriteResponse), (status = 404, description = "空间不存在或无权访问", body = ProblemDocument), (status = 409, description = "空间版本已变化", body = ProblemDocument)))]
pub async fn update_composition(
    state: State<AppState>,
    caller: crate::auth::Caller,
    path: Path<String>,
    headers: HeaderMap,
    body: super::StyleJson<universes::UpdateUniverseRequest>,
) -> Result<Response, ApiError> {
    native_write_response(
        universes::update_universe(state, caller, path, headers, body).await?,
        false,
    )
    .await
}

#[utoipa::path(post, path = "/api/v1/spaces/{space_id}/children/{child_id}", operation_id = "join_space_child", tag = "spaces", params(("space_id" = String, Path, description = "父空间编号"), ("child_id" = String, Path, description = "子空间编号")), request_body = universes::JoinUniverseRequest, security(("nyxid_identity" = [])),
    responses((status = 200, description = "空间子空间状态", body = ChildChangeResponse), (status = 404, description = "空间不存在或无权访问", body = ProblemDocument), (status = 409, description = "空间版本已变化", body = ProblemDocument)))]
pub async fn join_child(
    state: State<AppState>,
    caller: crate::auth::Caller,
    path: Path<(String, String)>,
    headers: HeaderMap,
    body: super::StyleJson<universes::JoinUniverseRequest>,
) -> Result<Response, ApiError> {
    native_write_response(
        universes::join_universe(state, caller, path, headers, body).await?,
        true,
    )
    .await
}

#[utoipa::path(delete, path = "/api/v1/spaces/{space_id}/children/{child_id}", operation_id = "leave_space_child", tag = "spaces", params(("space_id" = String, Path, description = "父空间编号"), ("child_id" = String, Path, description = "子空间编号")), request_body = universes::LeaveUniverseRequest, security(("nyxid_identity" = [])),
    responses((status = 200, description = "空间子空间状态", body = ChildChangeResponse), (status = 404, description = "空间不存在或无权访问", body = ProblemDocument), (status = 409, description = "空间版本已变化", body = ProblemDocument)))]
pub async fn leave_child(
    state: State<AppState>,
    caller: crate::auth::Caller,
    path: Path<(String, String)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, ApiError> {
    native_write_response(
        universes::leave_universe(state, caller, path, headers, body).await?,
        true,
    )
    .await
}
