//! 写一次提交的公共步骤：关键帧、第一次提交（`_space` 锚点 + 通用方块表）、资源引用。
//!
//! 关键帧（设计 5.2）：每 50 次提交存一份完整状态清单（`stateBlobs`，内容哈希写在提交的
//! `keyframe` 里）。处理服务写的提交不带关键帧，所以除了 `seq % 50 == 0`，离上一个关键帧
//! 已有 50 次提交时也补存一份，读取时从最近的关键帧（或从头）叠加。

use std::collections::BTreeSet;

use metaverse_core::chunk::ChunkKey;
use metaverse_core::ids::SPACE_ANCHOR_ID;
use metaverse_core::model::{Actor, ActorKind, IdChange, KEYFRAME_INTERVAL};
use metaverse_core::record::{record_hash, AnchorBody, AnchorKind, EntityBody, RecordKind};
use metaverse_core::replay::StateManifest;
use metaverse_core::scope::PathScope;
use metaverse_core::Timestamp;
use serde_json::Value;

use super::palette::{builtin_palette, palette_value};
use crate::auth::{Caller, Grant};
use crate::error::ApiError;
use crate::repo::{
    AssetRole, BlobKind, CommitError, CommitOutcome, CommitPlan, Layout, Repo, RepoError,
};

/// 本次提交之后的完整状态清单。
pub fn manifest_after(head: &StateManifest, plan: &CommitPlan) -> StateManifest {
    let mut next = head.clone();
    for change in &plan.changed_chunks {
        let key = ChunkKey {
            layer: change.layer,
            cx: change.cx,
            cy: change.cy,
            cz: change.cz,
        };
        match &change.hash {
            Some(hash) => next.chunks.insert(key, hash.clone()),
            None => next.chunks.remove(&key),
        };
    }
    for (map, changes) in [
        (&mut next.entities, &plan.changed_entities),
        (&mut next.anchors, &plan.changed_anchors),
    ] {
        for change in changes {
            match &change.hash {
                Some(hash) => map.insert(change.id.clone(), hash.clone()),
                None => map.remove(&change.id),
            };
        }
    }
    if let Some((hash, _, _)) = &plan.layout {
        next.regions_hash = Some(hash.clone());
    }
    if let Some(hash) = &plan.palette_hash {
        next.palette_hash = Some(hash.clone());
    }
    next
}

/// 需要时写关键帧，并把哈希填进计划。`head` 是 `plan.base_seq` 时的完整状态清单。
pub async fn attach_keyframe(
    repo: &Repo,
    grant: &Grant,
    plan: &mut CommitPlan,
    head: &StateManifest,
) -> Result<(), RepoError> {
    let seq = plan.base_seq + 1;
    let last = repo
        .latest_keyframe(grant, plan.base_seq)
        .await?
        .map_or(0, |(seq, _)| seq);
    if !seq.is_multiple_of(KEYFRAME_INTERVAL) && seq - last < KEYFRAME_INTERVAL {
        return Ok(());
    }
    let manifest = manifest_after(head, plan);
    let body = serde_json::to_value(manifest.to_stored())
        .map_err(|error| RepoError::Corrupt(error.to_string()))?;
    plan.keyframe = Some(
        repo.put_state_blob(grant, BlobKind::Manifest, &body)
            .await?,
    );
    Ok(())
}

/// 写提交，并在事务后给新引用的区块打上 `publishedAt`。
pub async fn commit(
    repo: &Repo,
    grant: &Grant,
    plan: &CommitPlan,
    now: Timestamp,
) -> Result<CommitOutcome, CommitError> {
    let outcome = repo.write_commit(grant, plan, now).await?;
    let hashes: Vec<String> = plan
        .changed_chunks
        .iter()
        .filter_map(|change| change.hash.clone())
        .collect();
    if let Err(error) = repo.publish_chunks(grant, &hashes, outcome.at).await {
        // 幂等，可以补做：提交已经生效，只是区块暂时不能经公开接口读取。
        tracing::warn!(error = %error, space = %grant.space_id(), seq = outcome.seq, "给区块打 publishedAt 失败");
    }
    Ok(outcome)
}

/// 由路径决定的发布者。
pub fn actor(caller: &Caller, scope: PathScope, kind: ActorKind) -> Actor {
    Actor {
        sub: caller.subject.clone(),
        nyx_service_id: caller.service_id.clone(),
        scope,
        kind,
    }
}

/// 一条物件里引用的资源：模型、贴图（含形状材质里的贴图）。
pub fn entity_assets(body: &EntityBody, into: &mut BTreeSet<String>) {
    let mut roles = BTreeSet::new();
    entity_asset_roles(body, &mut roles);
    into.extend(roles.into_iter().map(|(hash, _)| hash));
}

/// 一条物件里引用的资源和它们的用途：`assetHash` 是物件模型；`textures` 和形状（含全部子形状）
/// 材质里的 `texture`、`normalMap`、`roughnessMap` 是贴图（SHAPES 2"资源引用"）。
///
/// 草稿追加时按这里的结果检查用途和归属（`Repo::unusable_assets`）、过清理的栅栏
/// （`Repo::touch_assets`），发布时登记进提交的 `assetRefs`，所以新加引用贴图的字段只需要改
/// [`metaverse_core::shape::Material::texture_refs`]。
pub fn entity_asset_roles(body: &EntityBody, into: &mut BTreeSet<(String, AssetRole)>) {
    if let Some(hash) = &body.asset_hash {
        into.insert((hash.clone(), AssetRole::Model));
    }
    let mut textures: BTreeSet<String> = body.textures.iter().flatten().cloned().collect();
    if let Some(shape) = &body.shape {
        textures.extend(shape.texture_refs());
    }
    into.extend(textures.into_iter().map(|hash| (hash, AssetRole::Texture)));
}

/// 记录的存储形式与内容哈希。
pub fn record_of<T: serde::Serialize>(
    kind: RecordKind,
    space_id: &str,
    body: &T,
) -> Result<(String, Value), ApiError> {
    let hash = record_hash(kind, space_id, body).map_err(|error| {
        tracing::error!(error = %error, "记录无法计算哈希");
        ApiError::invalid(format!("记录无法规范化：{error}"))
    })?;
    let value = serde_json::to_value(body).map_err(|_| ApiError::internal())?;
    Ok((hash, value))
}

/// 新空间的第一次提交：`_space` 锚点、通用方块表、当前的区域清单（设计 4.3、4.4）。
/// 只在 `head.seq == 0` 时写；别人已经写过就什么也不做。
pub async fn ensure_genesis(
    repo: &Repo,
    grant: &Grant,
    caller: &Caller,
    now: Timestamp,
) -> Result<Option<CommitOutcome>, ApiError> {
    ensure_genesis_as(repo, grant, &caller.subject, &caller.service_id, now).await
}

/// 同 [`ensure_genesis`]，发布者直接给出（部署配置种子没有调用者，用
/// [`metaverse_core::model::OPERATOR_SEED_SUBJECT`]）。
pub async fn ensure_genesis_as(
    repo: &Repo,
    grant: &Grant,
    sub: &str,
    nyx_service_id: &str,
    now: Timestamp,
) -> Result<Option<CommitOutcome>, ApiError> {
    let space = repo.space(grant).await?.ok_or_else(ApiError::not_found)?;
    if space.head.seq != 0 {
        return Ok(None);
    }
    let palette_hash = repo
        .put_palette(grant, &palette_value(&builtin_palette()))
        .await?;
    let layout = Layout {
        regions: space.regions.clone(),
        plots: space.plots.clone(),
    };
    let layout_value = serde_json::to_value(&layout).map_err(|_| ApiError::internal())?;
    let regions_hash = repo
        .put_state_blob(grant, BlobKind::Regions, &layout_value)
        .await?;
    let anchor = AnchorBody {
        anchor_id: SPACE_ANCHOR_ID.to_owned(),
        kind: AnchorKind::Space,
        grid_box: None,
        position: None,
        label: None,
        visibility: metaverse_core::model::DataVisibility::Public,
    };
    let (anchor_hash, anchor_value) = record_of(RecordKind::Anchor, grant.space_id(), &anchor)?;
    repo.put_records(
        grant,
        &[(anchor_hash.clone(), "anchor", anchor_value.clone())],
    )
    .await?;
    let mut plan = CommitPlan::new(
        0,
        Actor {
            sub: sub.to_owned(),
            nyx_service_id: nyx_service_id.to_owned(),
            scope: PathScope::Physical,
            kind: ActorKind::Admin,
        },
        "创建空间：空间级锚点与通用方块表",
    );
    plan.changed_anchors = vec![IdChange {
        id: SPACE_ANCHOR_ID.to_owned(),
        hash: Some(anchor_hash),
    }];
    plan.anchor_bodies
        .insert(SPACE_ANCHOR_ID.to_owned(), anchor_value);
    plan.palette_hash = Some(palette_hash);
    plan.layout = Some((regions_hash, layout.regions, layout.plots));
    attach_keyframe(repo, grant, &mut plan, &StateManifest::default()).await?;
    match commit(repo, grant, &plan, now).await {
        Ok(outcome) => {
            tracing::info!(space = %grant.space_id(), commit = %outcome.commit_id, "第一次提交已写入");
            Ok(Some(outcome))
        }
        Err(CommitError::HeadMoved) => Ok(None),
        Err(CommitError::Missing) => Err(ApiError::not_found()),
        // 第一次提交不引用资源，这两种都不会发生。
        Err(CommitError::DraftChanged | CommitError::AssetsGone(_)) => Err(ApiError::internal()),
        Err(CommitError::Repo(error)) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use metaverse_core::model::{ChunkChange, Layer};

    #[test]
    fn textures_are_collected_from_materials() {
        let body: EntityBody = serde_json::from_value(serde_json::json!({
            "entityId": "lamp", "layer": "ext", "kind": "object",
            "assetHash": "a".repeat(64), "textures": ["b".repeat(64)],
            "shape": {"type": "group", "children": [
                {"type": "box", "size": [1, 1, 1], "material": {"texture": "c".repeat(64), "uv": "box"}},
                {"type": "box", "size": [1, 1, 1], "material": {"color": [1, 2, 3]}}
            ]},
            "bounds": {"min": [-0.5, 0, -0.5], "max": [0.5, 1, 0.5]}
        }))
        .unwrap();
        let mut assets = BTreeSet::new();
        entity_assets(&body, &mut assets);
        assert_eq!(assets.len(), 3);
        let mut roles = BTreeSet::new();
        entity_asset_roles(&body, &mut roles);
        assert!(roles.contains(&("a".repeat(64), AssetRole::Model)));
        assert!(roles.contains(&("b".repeat(64), AssetRole::Texture)));
        assert!(roles.contains(&("c".repeat(64), AssetRole::Texture)));
        assert_eq!(roles.len(), 3);
    }

    #[test]
    fn normal_and_roughness_maps_are_textures_too() {
        let hash = |c: char| c.to_string().repeat(64);
        let body: EntityBody = serde_json::from_value(serde_json::json!({
            "entityId": "counter", "layer": "ext", "kind": "object",
            "textures": [hash('c')],
            "shape": {"type": "group", "children": [
                {"type": "box", "size": [1, 1, 1], "material": {
                    "texture": hash('c'), "uv": "box", "tile": [0.5, 0.5], "shading": "albedo",
                    "normalMap": hash('d'), "roughnessMap": hash('e')}},
                {"type": "group", "children": [
                    {"type": "box", "size": [1, 1, 1], "material": {
                        "color": [1, 2, 3], "uv": "planar", "roughnessMap": hash('f')}},
                    {"type": "instance", "template": "stool", "material": {
                        "texture": hash('7'), "uv": "mesh", "normalMap": hash('d')}}
                ]}
            ]},
            "bounds": {"min": [-0.5, 0, -0.5], "max": [0.5, 1, 0.5]}
        }))
        .unwrap();
        let mut roles = BTreeSet::new();
        entity_asset_roles(&body, &mut roles);
        let expected: BTreeSet<(String, AssetRole)> = ['c', 'd', 'e', 'f', '7']
            .map(|c| (hash(c), AssetRole::Texture))
            .into_iter()
            .collect();
        assert_eq!(roles, expected);
        let mut assets = BTreeSet::new();
        entity_assets(&body, &mut assets);
        assert_eq!(assets.len(), 5);
    }

    #[test]
    fn manifest_after_applies_changes() {
        let actor = Actor {
            sub: "a".into(),
            nyx_service_id: "s".into(),
            scope: PathScope::Physical,
            kind: ActorKind::Admin,
        };
        let mut head = StateManifest::default();
        head.entities.insert("gone".into(), "h0".into());
        let mut plan = CommitPlan::new(3, actor, "m");
        plan.changed_chunks.push(ChunkChange {
            layer: Layer::Ext,
            cx: 0,
            cy: 0,
            cz: 0,
            hash: Some("c1".into()),
        });
        plan.changed_entities.push(IdChange {
            id: "gone".into(),
            hash: None,
        });
        plan.palette_hash = Some("p".into());
        let next = manifest_after(&head, &plan);
        assert_eq!(next.chunks.len(), 1);
        assert!(next.entities.is_empty());
        assert_eq!(next.palette_hash.as_deref(), Some("p"));
    }
}
