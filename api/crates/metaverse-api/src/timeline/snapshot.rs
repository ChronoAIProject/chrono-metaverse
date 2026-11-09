//! 快照与提交列表的组装和公开投影（设计 5.2、8.2）。
//!
//! - 快照：某个 seq 的区块清单、方块表、物件、锚点、区域和地块、扫描。公开接口只返回
//!   在该版本和当前都是公开级的锚点（当前是内部级的锚点在任何历史版本里都不出现），
//!   扫描只给网页用模型的哈希；
//! - 提交列表：公开接口只给 `{seq, at, observedAt, message, actor.kind, changed*}`，
//!   `changedAnchors` 按公开投影改写——内部锚点不出现，锚点由公开改为内部时记为删除。

use std::collections::{BTreeMap, BTreeSet};

use metaverse_core::model::{ActorKind, Commit, IdChange};
use metaverse_core::ops::PaletteBlock;
use metaverse_core::replay::StateManifest;
use metaverse_core::Timestamp;
use serde_json::Value;

use super::views::{
    ActorKindView, ChunkRefView, CommitSummaryView, EntityRecordView, PaletteView, PlotView,
    RegionView, ScanView, SnapshotView,
};
use crate::auth::Grant;
use crate::error::ApiError;
use crate::repo::{Layout, Repo};

/// 快照的读取范围。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Audience {
    /// 公开读和预览：只给公开级锚点，扫描只给网页用模型。
    Public,
    /// `/api/v1`：含内部级锚点和原始扫描。
    Internal,
}

fn is_public_anchor(body: &Value) -> bool {
    body.get("visibility").and_then(Value::as_str) == Some("public")
}

/// 按清单组装快照（`extra_blocks` 是预览时草稿新增的方块）。
pub async fn assemble(
    repo: &Repo,
    grant: &Grant,
    seq: u64,
    at: Timestamp,
    manifest: &StateManifest,
    extra_blocks: &[PaletteBlock],
    audience: Audience,
) -> Result<SnapshotView, ApiError> {
    let space_id = grant.space_id();
    let mut blocks = repo
        .palette_blocks(grant, manifest.palette_hash.as_deref())
        .await?;
    if !extra_blocks.is_empty() {
        if let Value::Array(items) = &mut blocks {
            for block in extra_blocks {
                items.push(serde_json::to_value(block).map_err(|_| ApiError::internal())?);
            }
        }
    }
    let layout: Layout = repo.layout(grant, manifest.regions_hash.as_deref()).await?;
    let record_hashes: Vec<&str> = manifest
        .entities
        .values()
        .chain(manifest.anchors.values())
        .map(String::as_str)
        .collect();
    let bodies = repo.record_bodies(grant, &record_hashes).await?;
    let missing = |hash: &str| {
        tracing::error!(space = %space_id, record = %hash, "快照引用的记录不存在");
        ApiError::internal()
    };
    let mut entities = Vec::with_capacity(manifest.entities.len());
    for (id, hash) in &manifest.entities {
        let body = bodies.get(hash).ok_or_else(|| missing(hash))?;
        entities.push(EntityRecordView {
            id: id.clone(),
            hash: hash.clone(),
            body: body.clone(),
        });
    }
    let internal_now: BTreeSet<String> = match audience {
        Audience::Public => repo.internal_anchor_ids(grant).await?.into_iter().collect(),
        Audience::Internal => BTreeSet::new(),
    };
    let mut anchors = Vec::with_capacity(manifest.anchors.len());
    for (id, hash) in &manifest.anchors {
        let body = bodies.get(hash).ok_or_else(|| missing(hash))?;
        if audience == Audience::Public && (!is_public_anchor(body) || internal_now.contains(id)) {
            continue;
        }
        anchors.push(body.clone());
    }
    let scan = match &manifest.scan {
        None => None,
        Some(scan) => {
            let observed_at = repo
                .latest_scan_commit(grant, seq)
                .await?
                .and_then(|commit| commit.observed_at);
            Some(ScanView {
                web_model_hashes: scan.web_model_hashes.clone(),
                transform: scan.transform.to_vec(),
                observed_at,
                asset_hash: (audience == Audience::Internal).then(|| scan.asset_hash.clone()),
            })
        }
    };
    Ok(SnapshotView {
        space_id: space_id.to_owned(),
        seq,
        at,
        palette_hash: manifest.palette_hash.clone(),
        palette: PaletteView {
            hash: manifest.palette_hash.clone(),
            blocks,
        },
        chunks: manifest
            .chunks
            .iter()
            .map(|(key, hash)| ChunkRefView {
                layer: key.layer,
                cx: key.cx,
                cy: key.cy,
                cz: key.cz,
                hash: hash.clone(),
            })
            .collect(),
        entities,
        anchors,
        regions: layout.regions.into_iter().map(RegionView::from).collect(),
        plots: layout.plots.into_iter().map(PlotView::from).collect(),
        scan,
    })
}

/// 某个 seq 的快照。`seq` 不能超过 `head_seq`（调用方检查）；seq 0 是空状态，时间取空间创建时间。
pub async fn snapshot_at(
    repo: &Repo,
    grant: &Grant,
    seq: u64,
    created_at: Timestamp,
    audience: Audience,
) -> Result<SnapshotView, ApiError> {
    let at = if seq == 0 {
        created_at
    } else {
        repo.commit_at(grant, seq)
            .await?
            .ok_or_else(|| {
                tracing::error!(space = %grant.space_id(), seq, "提交不存在");
                ApiError::internal()
            })?
            .at
    };
    let manifest = repo.manifest_at(grant, seq).await?;
    assemble(repo, grant, seq, at, &manifest, &[], audience).await
}

fn actor_kind_name(kind: ActorKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// 提交列表的公开投影。`commits` 按 seq 升序。
pub async fn public_summaries(
    repo: &Repo,
    grant: &Grant,
    commits: Vec<Commit>,
) -> Result<Vec<CommitSummaryView>, ApiError> {
    let Some(first) = commits.first() else {
        return Ok(Vec::new());
    };
    let anchor_ids: BTreeSet<&String> = commits
        .iter()
        .flat_map(|commit| commit.changed_anchors.iter().map(|change| &change.id))
        .collect();
    // 每个锚点在这一页之前的版本，用来判断"由公开改为内部"。
    let mut tracked: BTreeMap<String, Option<String>> = BTreeMap::new();
    let mut visibility: BTreeMap<String, bool> = BTreeMap::new();
    let mut internal_now = BTreeSet::new();
    if !anchor_ids.is_empty() {
        internal_now = repo.internal_anchor_ids(grant).await?.into_iter().collect();
        let prior = repo.manifest_at(grant, first.seq.saturating_sub(1)).await?;
        for id in &anchor_ids {
            tracked.insert((*id).clone(), prior.anchors.get(*id).cloned());
        }
        let mut hashes: BTreeSet<&str> = tracked.values().flatten().map(String::as_str).collect();
        for commit in &commits {
            for change in &commit.changed_anchors {
                if let Some(hash) = &change.hash {
                    hashes.insert(hash);
                }
            }
        }
        let hashes: Vec<&str> = hashes.into_iter().collect();
        for (hash, body) in repo.record_bodies(grant, &hashes).await? {
            visibility.insert(hash, is_public_anchor(&body));
        }
    }
    let was_public = |hash: &Option<String>, visibility: &BTreeMap<String, bool>| {
        hash.as_ref()
            .is_some_and(|hash| visibility.get(hash).copied().unwrap_or(false))
    };
    let mut items = Vec::with_capacity(commits.len());
    for commit in commits {
        let mut changed_anchors = Vec::new();
        for change in &commit.changed_anchors {
            let previous = tracked.get(&change.id).cloned().flatten();
            let before = was_public(&previous, &visibility);
            if !internal_now.contains(&change.id) {
                match &change.hash {
                    None if before => changed_anchors.push(change.clone()),
                    None => {}
                    Some(hash) if visibility.get(hash).copied().unwrap_or(false) => {
                        changed_anchors.push(change.clone())
                    }
                    Some(_) if before => changed_anchors.push(IdChange {
                        id: change.id.clone(),
                        hash: None,
                    }),
                    Some(_) => {}
                }
            }
            tracked.insert(change.id.clone(), change.hash.clone());
        }
        items.push(CommitSummaryView {
            seq: commit.seq,
            at: commit.at,
            observed_at: commit.observed_at,
            message: commit.message,
            actor: ActorKindView {
                kind: actor_kind_name(commit.actor.kind),
            },
            changed_chunks: commit.changed_chunks,
            changed_entities: commit.changed_entities,
            changed_anchors,
        });
    }
    Ok(items)
}
