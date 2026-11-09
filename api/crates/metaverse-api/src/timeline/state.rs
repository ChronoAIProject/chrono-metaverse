//! 工作状态：某个版本（可再叠加草稿的结果）的物件、锚点、方块表，区块按需加载。
//!
//! 操作只会碰它的影响范围内的区块，所以只加载用得到的区块：填充、空心盒、替换、复制区域
//! 先算出涉及哪些区块（替换还要看重建层），一次取齐，再逐条检查范围并作用。一份工作状态
//! 最多加载 [`MAX_WORKSPACE_CHUNKS`] 个区块（每个 64KiB），超出就拒绝，提示拆成多个草稿。
//!
//! 出错时整份工作状态直接丢弃，从不保存一半的结果，所以这里不需要逐批复制状态。

use std::collections::{BTreeMap, BTreeSet};

use metaverse_core::chunk::{locate_cell, Chunk, ChunkKey};
use metaverse_core::grid::GridBox;
use metaverse_core::model::Layer;
use metaverse_core::ops::{Op, OpError, TouchedSet, WorkingState};
use metaverse_core::record::{AnchorBody, EntityBody};
use metaverse_core::replay::StateManifest;
use metaverse_core::scope::AllowedArea;

use super::palette::parse_palette;
use crate::auth::Grant;
use crate::error::ApiError;
use crate::repo::{DraftDoc, Repo, RepoError};

/// 一份工作状态最多加载的区块数（64 MiB）。
pub const MAX_WORKSPACE_CHUNKS: usize = 1024;

/// 作用操作时的错误：操作本身的问题，或者存取出错。
#[derive(Debug)]
pub enum ApplyError {
    Op(OpError),
    Api(ApiError),
}

impl From<ApiError> for ApplyError {
    fn from(error: ApiError) -> Self {
        ApplyError::Api(error)
    }
}

impl From<RepoError> for ApplyError {
    fn from(error: RepoError) -> Self {
        ApplyError::Api(error.into())
    }
}

fn too_many_chunks() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::PAYLOAD_TOO_LARGE,
        "too_many_chunks",
        format!("一个草稿最多涉及 {MAX_WORKSPACE_CHUNKS} 个区块（32³ 格），请拆成多个草稿"),
    )
}

/// 区块从哪里来。
#[derive(Debug, Clone, Default)]
struct ChunkSource {
    /// 基础版本的区块（已发布，在 `chunks` 里）。
    base: BTreeMap<ChunkKey, String>,
    /// 草稿的结果区块（在 `draftChunks` 里）。
    draft: BTreeMap<ChunkKey, String>,
    /// 草稿碰过的键：不在 `draft` 里就是全空（删除）。
    draft_touched: BTreeSet<ChunkKey>,
    draft_id: Option<String>,
}

/// 带按需加载区块的工作状态。
pub struct Workspace {
    pub state: WorkingState,
    pub manifest: StateManifest,
    loaded: BTreeSet<ChunkKey>,
    source: ChunkSource,
}

/// 盒子横跨多少个区块。
fn chunk_span(region: &GridBox) -> ([i32; 3], [i32; 3], u128) {
    let low = locate_cell(region.min).0;
    let high = locate_cell(region.max.map(|v| v - 1)).0;
    let count = (0..3)
        .map(|axis| (i64::from(high[axis]) - i64::from(low[axis]) + 1) as u128)
        .product();
    (low, high, count)
}

fn add_keys(region: &GridBox, layer: Layer, keys: &mut BTreeSet<ChunkKey>) -> Result<(), ApiError> {
    let (low, high, count) = chunk_span(region);
    if count > MAX_WORKSPACE_CHUNKS as u128 {
        return Err(too_many_chunks());
    }
    for cy in low[1]..=high[1] {
        for cz in low[2]..=high[2] {
            for cx in low[0]..=high[0] {
                keys.insert(ChunkKey { layer, cx, cy, cz });
                if keys.len() > MAX_WORKSPACE_CHUNKS {
                    return Err(too_many_chunks());
                }
            }
        }
    }
    Ok(())
}

/// 一条操作需要先加载的区块（与状态无关，只看几何）。
pub fn needed_chunks(op: &Op, keys: &mut BTreeSet<ChunkKey>) -> Result<(), ApiError> {
    match op {
        Op::Fill { region, .. } | Op::HollowBox { region, .. } => {
            add_keys(region, Layer::Ext, keys)
        }
        Op::Replace { region, .. } => {
            add_keys(region, Layer::Ext, keys)?;
            add_keys(region, Layer::Rebuilt, keys)
        }
        Op::CopyRegion { source, to } => {
            add_keys(source, Layer::Ext, keys)?;
            let offset = [0, 1, 2].map(|axis| to[axis] - source.min[axis]);
            if let Ok(target) = source.translated(offset) {
                add_keys(&target, Layer::Ext, keys)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn with_index(error: OpError, index: usize) -> OpError {
    error.at(index)
}

/// 读出 `hashes` 对应的记录 body，解析成具体类型。
async fn load_bodies<T: serde::de::DeserializeOwned>(
    repo: &Repo,
    grant: &Grant,
    ids: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, T>, ApiError> {
    let hashes: Vec<&str> = ids.values().map(String::as_str).collect();
    let bodies = repo.record_bodies(grant, &hashes).await?;
    let mut parsed = BTreeMap::new();
    for (id, hash) in ids {
        let body = bodies.get(hash).ok_or_else(|| {
            tracing::error!(record = %hash, "记录不存在");
            ApiError::internal()
        })?;
        let value: T = serde_json::from_value(body.clone()).map_err(|error| {
            tracing::error!(record = %hash, error = %error, "记录格式不对");
            ApiError::internal()
        })?;
        parsed.insert(id.clone(), value);
    }
    Ok(parsed)
}

impl Workspace {
    /// 某个版本的工作状态。
    pub async fn at_seq(repo: &Repo, grant: &Grant, seq: u64) -> Result<Self, ApiError> {
        let manifest = repo.manifest_at(grant, seq).await?;
        Self::from_manifest(repo, grant, manifest, None).await
    }

    /// 草稿的工作状态：基础版本叠加草稿已有的结果。
    pub async fn for_draft(repo: &Repo, grant: &Grant, draft: &DraftDoc) -> Result<Self, ApiError> {
        let manifest = repo.manifest_at(grant, draft.base_seq).await?;
        Self::from_manifest(repo, grant, manifest, Some(draft)).await
    }

    async fn from_manifest(
        repo: &Repo,
        grant: &Grant,
        manifest: StateManifest,
        draft: Option<&DraftDoc>,
    ) -> Result<Self, ApiError> {
        let blocks = repo
            .palette_blocks(grant, manifest.palette_hash.as_deref())
            .await?;
        let palette = parse_palette(&blocks).map_err(|error| {
            tracing::error!(error = %error, "方块表格式不对");
            ApiError::internal()
        })?;
        let mut entity_ids = manifest.entities.clone();
        let mut anchor_ids = manifest.anchors.clone();
        let mut source = ChunkSource {
            base: manifest.chunks.clone(),
            ..ChunkSource::default()
        };
        let mut provisional = BTreeMap::new();
        if let Some(draft) = draft {
            for change in &draft.result_entities {
                match &change.hash {
                    Some(hash) => entity_ids.insert(change.id.clone(), hash.clone()),
                    None => entity_ids.remove(&change.id),
                };
            }
            for change in &draft.result_anchors {
                match &change.hash {
                    Some(hash) => anchor_ids.insert(change.id.clone(), hash.clone()),
                    None => anchor_ids.remove(&change.id),
                };
            }
            source.draft = draft
                .result_chunks
                .iter()
                .map(|c| {
                    (
                        ChunkKey {
                            layer: c.layer,
                            cx: c.cx,
                            cy: c.cy,
                            cz: c.cz,
                        },
                        c.hash.clone(),
                    )
                })
                .collect();
            source.draft_touched = draft.touched.chunks.iter().copied().collect();
            source.draft_id = Some(draft.id.clone());
            for block in &draft.provisional_blocks {
                provisional.insert(block.name.clone(), (block.id, block.block.clone()));
            }
        }
        let entities: BTreeMap<String, EntityBody> = load_bodies(repo, grant, &entity_ids).await?;
        let anchors: BTreeMap<String, AnchorBody> = load_bodies(repo, grant, &anchor_ids).await?;
        Ok(Self {
            state: WorkingState {
                chunks: BTreeMap::new(),
                entities,
                anchors,
                palette,
                provisional_blocks: provisional,
                // 范围种类、锚点历史、草稿的扫描：接上重建路径时按草稿填（现在都是扩展草稿）。
                ..WorkingState::default()
            },
            manifest,
            loaded: BTreeSet::new(),
            source,
        })
    }

    /// 加载这些区块（已加载的跳过）。
    pub async fn ensure_chunks(
        &mut self,
        repo: &Repo,
        grant: &Grant,
        keys: &BTreeSet<ChunkKey>,
    ) -> Result<(), ApiError> {
        let missing: Vec<ChunkKey> = keys
            .iter()
            .filter(|key| !self.loaded.contains(key))
            .copied()
            .collect();
        if missing.is_empty() {
            return Ok(());
        }
        if self.loaded.len() + missing.len() > MAX_WORKSPACE_CHUNKS {
            return Err(too_many_chunks());
        }
        let mut from_draft = Vec::new();
        let mut from_base = Vec::new();
        for key in &missing {
            if let Some(hash) = self.source.draft.get(key) {
                from_draft.push((*key, hash.clone()));
            } else if self.source.draft_touched.contains(key) {
                // 草稿把它清空了。
            } else if let Some(hash) = self.source.base.get(key) {
                from_base.push((*key, hash.clone()));
            }
        }
        if !from_base.is_empty() {
            let hashes: Vec<&str> = from_base.iter().map(|(_, h)| h.as_str()).collect();
            let stored = repo.chunk_data(grant, &hashes).await?;
            for (key, hash) in &from_base {
                let chunk = stored.get(hash).ok_or_else(|| {
                    tracing::error!(chunk = %hash, "区块不存在");
                    ApiError::internal()
                })?;
                self.insert_chunk(*key, &chunk.data, hash)?;
            }
        }
        if !from_draft.is_empty() {
            let draft_id = self.source.draft_id.clone().unwrap_or_default();
            let hashes: Vec<&str> = from_draft.iter().map(|(_, h)| h.as_str()).collect();
            let stored = repo.draft_chunk_data(grant, &draft_id, &hashes).await?;
            for (key, hash) in &from_draft {
                let data = stored.get(hash).ok_or_else(|| {
                    tracing::error!(chunk = %hash, draft = %draft_id, "草稿区块不存在");
                    ApiError::internal()
                })?;
                self.insert_chunk(*key, data, hash)?;
            }
        }
        self.loaded.extend(missing);
        Ok(())
    }

    fn insert_chunk(&mut self, key: ChunkKey, data: &[u8], hash: &str) -> Result<(), ApiError> {
        let chunk = Chunk::decompress(data).map_err(|_| {
            tracing::error!(chunk = %hash, "区块无法解压");
            ApiError::internal()
        })?;
        if chunk.hash() != hash {
            tracing::error!(chunk = %hash, "区块内容与哈希不符");
            return Err(ApiError::internal());
        }
        self.state.chunks.insert(key, chunk);
        Ok(())
    }

    /// 逐条检查影响范围并作用。`offset` 是这批操作在整个请求里的起始下标（错误信息用）。
    /// 出错时工作状态已经部分改动，调用方必须丢弃它。
    ///
    /// 方块操作是纯计算：先占一个进程级的计算名额（同时最多 [`MAX_CONCURRENT_COMPUTE`] 个），
    /// 每处理 [`YIELD_EVERY_CELLS`] 格让出一次线程，长时间的计算不会让同一工作线程上的其他请求
    /// （公开读、健康检查）一直等着；调用方另外按 [`ops_cells`] 限制总计算量。
    pub async fn apply_ops(
        &mut self,
        repo: &Repo,
        grant: &Grant,
        ops: &[Op],
        area: &AllowedArea,
        offset: usize,
    ) -> Result<TouchedSet, ApplyError> {
        let _slot = compute_slot().await?;
        let mut touched = TouchedSet::default();
        let mut since_yield = 0u64;
        for (batch_index, batch) in ops.chunks(64).enumerate() {
            let mut keys = BTreeSet::new();
            for op in batch {
                needed_chunks(op, &mut keys)?;
            }
            self.ensure_chunks(repo, grant, &keys).await?;
            for (i, op) in batch.iter().enumerate() {
                let index = offset + batch_index * 64 + i;
                let footprint = self
                    .state
                    .footprint(op)
                    .map_err(|e| ApplyError::Op(with_index(e, index)))?;
                area.check(&footprint)
                    .map_err(|source| ApplyError::Op(OpError::Scope { index, source }))?;
                touched.merge(
                    self.state
                        .apply(op)
                        .map_err(|e| ApplyError::Op(with_index(e, index)))?,
                );
                since_yield = since_yield.saturating_add(op_cells(op));
                if since_yield >= YIELD_EVERY_CELLS {
                    since_yield = 0;
                    tokio::task::yield_now().await;
                }
            }
            // 放物件、模板这类 0 格的操作不按格数让出：每 64 条至少让出一次
            // （docs/design/server-slim.md 4.2）。
            tokio::task::yield_now().await;
        }
        Ok(touched)
    }

    /// 某个区块当前的内容：非空时给出（哈希, 压缩字节），全空时 `None`。
    pub fn chunk_result(&self, key: &ChunkKey) -> Option<(String, Vec<u8>)> {
        self.state
            .chunks
            .get(key)
            .filter(|chunk| !chunk.is_empty())
            .map(|chunk| (chunk.hash(), chunk.compress()))
    }
}

/// 同时进行的方块计算（追加操作、ops-from-upload、发布时重放）最多几个（进程级）。
pub const MAX_CONCURRENT_COMPUTE: usize = 2;
/// 等计算名额的最长时间，超过返回 503。
const COMPUTE_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
/// 计算期间每处理这么多格让出一次线程。
pub const YIELD_EVERY_CELLS: u64 = 1 << 20;

fn compute_slots() -> &'static tokio::sync::Semaphore {
    static SLOTS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    SLOTS.get_or_init(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_COMPUTE))
}

async fn compute_slot() -> Result<tokio::sync::SemaphorePermit<'static>, ApiError> {
    match tokio::time::timeout(COMPUTE_WAIT, compute_slots().acquire()).await {
        Ok(Ok(permit)) => Ok(permit),
        _ => Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "compute_busy",
            "正在处理的方块操作太多，请稍后重试",
        )),
    }
}

/// 一个操作的计算量（格数）：填充、空心盒、替换按区域体积，复制区域按源体积的两倍（读一遍、
/// 写一遍），其他操作按 1。
pub fn op_cells(op: &Op) -> u64 {
    let volume =
        |region: &metaverse_core::grid::GridBox| u64::try_from(region.volume()).unwrap_or(u64::MAX);
    match op {
        Op::Fill { region, .. } | Op::HollowBox { region, .. } | Op::Replace { region, .. } => {
            volume(region).max(1)
        }
        Op::CopyRegion { source, .. } => volume(source).saturating_mul(2).max(1),
        _ => 1,
    }
}

/// 一批操作的总计算量。
pub fn ops_cells(ops: &[Op]) -> u64 {
    ops.iter()
        .fold(0u64, |total, op| total.saturating_add(op_cells(op)))
}

/// 只检查影响范围、不碰区块的"影子"重放：发布时按最新的区域和地块重新校验全部操作
/// （设计 5.6）。方块操作的影响范围只看几何；物件、锚点、新增方块照常作用以保持状态。
pub fn check_scope_only(
    state: &mut WorkingState,
    ops: &[Op],
    area: &AllowedArea,
) -> Result<(), OpError> {
    for (index, op) in ops.iter().enumerate() {
        let footprint = state.footprint(op).map_err(|e| with_index(e, index))?;
        area.check(&footprint)
            .map_err(|source| OpError::Scope { index, source })?;
        match op {
            Op::Fill { .. } | Op::HollowBox { .. } | Op::Replace { .. } | Op::CopyRegion { .. } => {
            }
            _ => {
                state.apply(op).map_err(|e| with_index(e, index))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn op(value: serde_json::Value) -> Op {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn op_cost_counts_cells() {
        assert_eq!(
            op_cells(&op(json!({"op":"fill","box":[0,0,0,10,10,10],"block":2}))),
            1000
        );
        assert_eq!(
            op_cells(&op(
                json!({"op":"copyRegion","source":[0,0,0,128,256,128],"to":[128,0,0]})
            )),
            2 * 128 * 256 * 128
        );
        assert_eq!(
            op_cells(&op(
                json!({"op":"createAnchor","anchor":{"anchorId":"t1","kind":"table","box":[0,0,0,1,1,1],"visibility":"public"}})
            )),
            1
        );
        let many: Vec<Op> = (0..200)
            .map(|_| op(json!({"op":"replace","box":[0,0,0,256,64,256],"from":2,"to":3})))
            .collect();
        assert_eq!(ops_cells(&many), 200 * 256 * 64 * 256);
    }

    #[test]
    fn needed_chunks_follow_geometry() {
        let mut keys = BTreeSet::new();
        needed_chunks(
            &op(json!({"op":"fill","box":[30,0,0,34,1,1],"block":2})),
            &mut keys,
        )
        .unwrap();
        assert_eq!(keys.len(), 2);
        assert!(keys.iter().all(|k| k.layer == Layer::Ext));
        let mut keys = BTreeSet::new();
        needed_chunks(
            &op(json!({"op":"replace","box":[0,0,0,1,1,1],"from":2,"to":3})),
            &mut keys,
        )
        .unwrap();
        assert_eq!(keys.len(), 2);
        let mut keys = BTreeSet::new();
        needed_chunks(
            &op(json!({"op":"copyRegion","source":[0,0,0,2,2,2],"to":[64,0,0]})),
            &mut keys,
        )
        .unwrap();
        assert_eq!(keys.len(), 2);
        // 横跨太多区块的单个操作直接拒绝，不会去枚举。
        let mut keys = BTreeSet::new();
        assert!(needed_chunks(
            &op(json!({"op":"fill","box":[0,0,0,4194304,1,1],"block":2})),
            &mut keys
        )
        .is_err());
        let mut keys = BTreeSet::new();
        needed_chunks(
            &op(json!({"op":"createAnchor","anchor":{"anchorId":"t1","kind":"table","box":[0,0,0,1,1,1],"visibility":"public"}})),
            &mut keys,
        )
        .unwrap();
        assert!(keys.is_empty());
    }
}
