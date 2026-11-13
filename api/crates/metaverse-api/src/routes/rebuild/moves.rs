//! Small JSON moves become an ordinary merge bundle; layer and publication rules stay shared.
use std::collections::BTreeSet;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Response,
};
use metaverse_core::{
    bundle::{Bundle, SpaceTemplates, BUNDLE_FORMAT, BUNDLE_VERSION},
    ids::is_object_id,
    is_sha256_hex,
    model::Layer,
    record::EntityKind,
    scope::PathScope,
};
use serde::Deserialize;
use serde_json::json;
use utoipa::ToSchema;

use super::{bundle_already_applied, queue_bundle, scoped_draft, writable, BundleJobView};
use crate::{
    auth::Caller,
    error::{ApiError, ProblemDocument},
    repo::{AssetRole, DraftStatus, UnusableAsset},
    routes::ApiJson,
    timeline::{state::Workspace, writer::entity_asset_roles},
    AppState,
};

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityMove {
    /// Existing rebuilt object or structure; templates cannot be moved through this operation.
    pub entity_id: String,
    /// The object's hash from the snapshot at the draft's baseSeq.
    pub expected_hash: String,
    /// World-coordinate translation in metres, [x, y, z], with y upwards.
    pub offset: [f64; 3],
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveEntitiesRequest {
    pub rev: u64,
    /// One batch of 1–100 unique existing entities. The draft must not already contain a bundle.
    pub moves: Vec<EntityMove>,
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/rebuild/drafts/{draft_id}/moves",
    operation_id = "move_rebuild_entities",
    tag = "rebuild",
    description = "在重建草稿里平移已有重建层物件（要求本空间管理权，无需额外平台角色）。传当前 rev，以及 moves:[{entityId,expectedHash,offset:[x,y,z]}]；expectedHash 来自草稿 baseSeq 的快照，offset 是世界坐标米数。服务端保留原编号、模型、来源及其他字段，同步移动形状和 bounds，生成一个 merge 重建包并返回 202 展开任务。不得传完整物件或修改其他字段；不能移动扩展层、模板、扫描或锚点。一次 1–100 个不重复物件，一个草稿只收一批移动或一个重建包。用 get_rebuild_job 等到 done 后读取草稿 rev、调用 create_rebuild_draft_preview；没有用户对该预览和 rev 的明确确认不得发布。重试先查草稿和任务，第二次提交返回 409，避免重复移动。",
    params(("space_id" = String, Path, description = "空间编号"), ("draft_id" = String, Path, description = "空的重建草稿编号")),
    request_body = MoveEntitiesRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 202, description = "已排队；查询任务完成后生成预览", body = BundleJobView),
        (status = 403, description = "缺少本空间管理权", body = ProblemDocument),
        (status = 404, description = "空间、重建草稿或物件不存在或无权访问", body = ProblemDocument),
        (status = 409, description = "rev/expectedHash 不匹配，或草稿已有包/正在处理", body = ProblemDocument),
        (status = 413, description = "生成的清单超过限制", body = ProblemDocument),
        (status = 422, description = "移动参数、物件图层、编号或资源不合法", body = ProblemDocument),
        (status = 429, description = "排队任务达到上限", body = ProblemDocument)
    )
)]
pub async fn move_rebuild_entities(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, draft_id)): Path<(String, String)>,
    ApiJson(request): ApiJson<MoveEntitiesRequest>,
) -> Result<Response, ApiError> {
    let scope = PathScope::Rebuild;
    let grant = writable(&state, &caller, &space_id, &scope).await?;
    let draft = scoped_draft(&state, &grant, &scope, &draft_id).await?;
    if draft.status != DraftStatus::Open || request.rev != draft.rev {
        return Err(ApiError::conflict("草稿状态或 rev 已变化，请重新读取"));
    }
    if draft.bundle_ref.is_some()
        || !draft.ops_refs.is_empty()
        || state.repo.draft_has_pending_job(&grant, &draft.id).await?
    {
        return Err(bundle_already_applied());
    }
    if request.moves.is_empty() || request.moves.len() > 100 {
        return Err(ApiError::invalid("moves 必须包含 1 到 100 个已有物件"));
    }
    let mut ids = BTreeSet::new();
    for movement in &request.moves {
        if !is_object_id(&movement.entity_id)
            || !ids.insert(&movement.entity_id)
            || !is_sha256_hex(&movement.expected_hash)
            || !movement
                .offset
                .iter()
                .all(|v| v.is_finite() && v.abs() <= 100_000.0)
            || movement.offset == [0.0; 3]
        {
            return Err(ApiError::invalid(
                "物件编号须唯一，expectedHash 须有效，offset 须为非零有限米数",
            ));
        }
    }
    let mut workspace = Workspace::for_draft(&state.repo, &grant, &draft).await?;
    let mut entities = Vec::new();
    let mut wanted = BTreeSet::new();
    for movement in &request.moves {
        let Some(original) = workspace.state.entities.get(&movement.entity_id) else {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "草稿基础版本中没有这个物件",
            ));
        };
        if workspace.manifest.entities.get(&movement.entity_id) != Some(&movement.expected_hash) {
            return Err(ApiError::conflict(
                "物件 expectedHash 与草稿基础版本不同，请重新读取快照",
            ));
        }
        if original.layer != Layer::Rebuilt
            || original.kind == EntityKind::Template
            || !original.entity_id.starts_with("rb.")
        {
            return Err(ApiError::invalid(
                "只支持已有 rb. 重建物件或结构；扩展层用普通草稿，模板和旧编号使用重建包",
            ));
        }
        let mut entity = original.clone();
        for (axis, delta) in movement.offset.iter().enumerate() {
            entity.bounds.min[axis] += delta;
            entity.bounds.max[axis] += delta;
        }
        if let Some(shape) = &mut entity.shape {
            let transform = shape.transform.get_or_insert_with(Default::default);
            let position = transform.position.get_or_insert([0.0; 3]);
            for (axis, delta) in movement.offset.iter().enumerate() {
                position[axis] += delta;
            }
        }
        entity_asset_roles(&entity, &mut wanted);
        entities.push(entity);
    }
    let limits = state.ingest.config.upload_limits();
    let wanted: Vec<_> = wanted.into_iter().collect();
    let checked = state
        .repo
        .check_asset_roles(&grant, &wanted, &limits)
        .await?;
    if let Some(problem) = checked.unusable.first() {
        return Err(ApiError::invalid(UnusableAsset::describe(problem)));
    }
    let files: Vec<_> = wanted
        .iter()
        .map(|(hash, role)| {
            json!({
                "path": format!("assets/{hash}"),
                "purpose": match role { AssetRole::Model => "model", _ => "texture" },
                "sha256": hash, "size": checked.lengths[hash],
            })
        })
        .collect();
    let manifest = json!({
        "format": BUNDLE_FORMAT, "version": BUNDLE_VERSION,
        "tool": {"name":"chrono-metaverse-move", "version":"1"},
        "note":"调整重建层物件位置", "createdAt":draft.created_at,
        "base":{"spaceId":space_id,"seq":draft.base_seq},
        "rebuilt":{"mode":"merge","entities":entities}, "files":files,
    });
    let text = serde_json::to_string(&manifest).map_err(|_| ApiError::internal())?;
    let templates = workspace.state.templates_of(Layer::Rebuilt);
    Bundle::parse(&text, &limits, Some(SpaceTemplates(&templates)))
        .map_err(|e| ApiError::invalid(e.to_string()))?;
    // Apply the same scope checks before persisting even the generated manifest.
    let ops = entities
        .into_iter()
        .map(|entity| metaverse_core::ops::Op::PlaceEntity {
            entity: Box::new(entity),
        })
        .collect::<Vec<_>>();
    let space = state
        .repo
        .space(&grant)
        .await?
        .ok_or_else(ApiError::internal)?;
    let area = metaverse_core::scope::AllowedArea::for_scope(&scope, &space.regions, &space.plots)
        .map_err(|e| ApiError::invalid(e.to_string()))?;
    crate::timeline::state::check_scope_only(&mut workspace.state, &ops, &area)
        .map_err(|e| ApiError::invalid(e.to_string()))?;
    let hash = state
        .repo
        .put_asset_bytes(&grant, text.as_bytes(), "application/json", "bundle")
        .await?;
    queue_bundle(&state, &caller, &grant, draft, hash).await
}
