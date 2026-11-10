//! 高层操作（设计 8.3）、作用到工作状态、影响范围。
//!
//! 批量操作只用高层操作：填充、空心盒、替换、复制区域、新增方块、放物件、删物件、
//! 新建/移动/修改锚点。每批不超过 200 条。方块操作里 `0` 表示"不覆盖"（清掉扩展层在这一格的
//! 内容），`1` 表示"空气覆盖"（删掉下层的方块）。
//!
//! 工作状态带**范围种类**（[`ScopeKind`]），决定能用哪些操作、写哪一层
//! （docs/design/server-slim.md 2.4）：
//!
//! - **扩展**（实体区、地块草稿）：方块操作、放和删扩展层的物件、锚点的全部操作；
//!   扩展层新放的物件编号不能以 `rb.` 开头；不能用 `setScan`、`clearRebuilt`。
//! - **重建**（重建草稿，只由重建包展开产生）：`setScan`、`clearRebuilt`、放和删重建层的物件
//!   （新放的编号必须以 `rb.` 开头，旧编号只能删）、带 `ifNew` 的 `createAnchor`；
//!   方块操作、新增方块、移动 / 修改 / 删除锚点一律拒绝。
//!
//! 所有草稿通用（2.5）：模板只能被同一层的物件引用；`removeEntity` 可带 `ifPresent`（不存在就
//! 什么都不做）；`createAnchor` 可带 `ifNew`（编号在本空间时间线上出现过就什么都不做，出现过的
//! 编号由调用方放进 [`WorkingState::anchor_history`]）。
//!
//! 每个操作先算影响范围（[`Footprint`]），由 [`crate::scope::AllowedArea`] 判断是否
//! 落在路径范围内，再作用到 [`WorkingState`]。[`WorkingState::apply_in_scope`] 把这两步
//! 合在一起，任何一条失败时状态保持不变。一次追加作用完以后，调用方再用
//! [`WorkingState::broken_template_refs`] 查模板引用的完整性。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::chunk::{locate_cell, Chunk, ChunkKey, BLOCK_AIR, BLOCK_EMPTY, CHUNK_SIZE};
use crate::grid::GridBox;
use crate::ids::{is_object_id, SPACE_ANCHOR_ID};
use crate::is_sha256_hex;
use crate::model::{
    check_alignment, check_transform, ChunkChange, DataVisibility, Layer, ScanRef, Touched,
};
use crate::record::{
    is_rebuilt_id, AnchorBody, AnchorFootprint, AnchorKind, EntityBody, EntityKind, RecordError,
    REBUILT_ID_PREFIX,
};
use crate::scope::{AllowedArea, PathScope, ScopeError};
use crate::shape::Shape;
use crate::Timestamp;

/// 每批操作的条数上限。
pub const MAX_OPS_PER_BATCH: usize = 200;
/// 单个方块操作涉及的格子数上限（约 128 个区块）。
pub const MAX_OP_CELLS: u128 = 1 << 22;
/// 空心盒壁厚上限（格）。
pub const MAX_HOLLOW_THICKNESS: u32 = 64;
/// `setScan` 的网页用模型最多几档。
pub const MAX_WEB_MODELS: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpError {
    #[error("第 {index} 条操作：{message}")]
    Invalid { index: usize, message: String },
    #[error("第 {index} 条操作：{source}")]
    Scope { index: usize, source: ScopeError },
    /// 这种草稿不能用这个操作（例如实体区草稿里的 `setScan`），接口返回 422 `op_not_allowed`。
    #[error("第 {index} 条操作：{message}")]
    NotAllowed { index: usize, message: String },
    #[error("一批最多 200 条操作")]
    TooManyOps,
}

impl OpError {
    /// 把错误的下标换成 `index`（`TooManyOps` 不变）。
    pub fn at(self, index: usize) -> OpError {
        match self {
            OpError::Invalid { message, .. } => OpError::Invalid { index, message },
            OpError::Scope { source, .. } => OpError::Scope { index, source },
            OpError::NotAllowed { message, .. } => OpError::NotAllowed { index, message },
            other => other,
        }
    }
}

fn invalid(message: impl Into<String>) -> OpError {
    OpError::Invalid {
        index: 0,
        message: message.into(),
    }
}

fn not_allowed(message: impl Into<String>) -> OpError {
    OpError::NotAllowed {
        index: 0,
        message: message.into(),
    }
}

impl From<RecordError> for OpError {
    fn from(error: RecordError) -> Self {
        invalid(error.to_string())
    }
}

/// 方块引用：方块表里的正式编号，或草稿里新增方块的临时名称。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BlockRef {
    Id(u16),
    Temp(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    Solid,
    Glass,
    Emissive,
    Liquid,
    Foliage,
}

/// 方块的分面贴图（资源哈希）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlockTexture {
    pub top: String,
    pub side: String,
    pub bottom: String,
}

/// 方块定义（不含编号）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlockDef {
    pub name: String,
    pub kind: BlockKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<[u8; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture: Option<BlockTexture>,
    #[serde(default)]
    pub tags: Vec<String>,
}

impl BlockDef {
    pub fn validate(&self) -> Result<(), OpError> {
        if !is_object_id(&self.name) {
            return Err(invalid("方块名称格式不对"));
        }
        match (&self.color, &self.texture) {
            (Some(_), None) => {}
            (None, Some(texture)) => {
                if ![&texture.top, &texture.side, &texture.bottom]
                    .iter()
                    .all(|hash| is_sha256_hex(hash))
                {
                    return Err(invalid("方块贴图必须是资源哈希"));
                }
            }
            _ => return Err(invalid("方块必须且只能给出 color 或 texture")),
        }
        if self.tags.len() > 16 || self.tags.iter().any(|tag| !is_object_id(tag)) {
            return Err(invalid("方块标签至多 16 个且格式要合法"));
        }
        Ok(())
    }
}

/// 方块表里的一项（`palettes.blocks[]`）。编号只增不改。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaletteBlock {
    pub id: u16,
    pub name: String,
    pub kind: BlockKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<[u8; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture: Option<BlockTexture>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// `setScan` 的扫描层：扫描资源、网页用模型、变换和可选的对齐信息。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanSpec {
    /// 原始扫描（按角色 `Scan` 检查）。
    pub asset_hash: String,
    /// 1 到 2 个、不重复的网页用模型（按角色 `WebModel` 检查），[0] 是网站加载的那一档。
    pub web_model_hashes: Vec<String>,
    /// 4×4 列主序变换（扫描坐标 → 空间坐标），规则见 [`check_transform`]。
    pub transform: [f64; 16],
    /// 任意 JSON 对象，规范化后 ≤ 4 KiB，服务端原样保存、不解释。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alignment: Option<Map<String, Value>>,
}

impl ScanSpec {
    pub fn validate(&self) -> Result<(), OpError> {
        if !is_sha256_hex(&self.asset_hash) {
            return Err(invalid("scan.assetHash 必须是 64 位小写十六进制"));
        }
        let count = self.web_model_hashes.len();
        if count == 0 || count > MAX_WEB_MODELS {
            return Err(invalid("scan.webModelHashes 必须是 1 到 2 个资源哈希"));
        }
        if !self.web_model_hashes.iter().all(|hash| is_sha256_hex(hash)) {
            return Err(invalid("scan.webModelHashes 必须是资源哈希"));
        }
        if count == 2 && self.web_model_hashes[0] == self.web_model_hashes[1] {
            return Err(invalid("scan.webModelHashes 不能重复"));
        }
        check_transform(&self.transform).map_err(|error| invalid(format!("scan.{error}")))?;
        if let Some(alignment) = &self.alignment {
            check_alignment(alignment).map_err(|message| invalid(format!("scan.{message}")))?;
        }
        Ok(())
    }

    /// 提交里的扫描信息。
    pub fn to_scan_ref(&self) -> ScanRef {
        ScanRef {
            asset_hash: self.asset_hash.clone(),
            web_model_hashes: self.web_model_hashes.clone(),
            transform: self.transform,
            alignment: self.alignment.clone(),
        }
    }
}

/// 一条高层操作。JSON 里用 `op` 区分类型。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Op {
    /// 填充：盒子里的每一格写成 `block`。
    Fill {
        #[serde(rename = "box")]
        region: GridBox,
        block: BlockRef,
    },
    /// 空心盒：只写外壳，壁厚默认 1 格。
    HollowBox {
        #[serde(rename = "box")]
        region: GridBox,
        block: BlockRef,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thickness: Option<u32>,
    },
    /// 替换：盒子里当前看得到的方块是 `from` 的格子，在扩展层写成 `to`。
    Replace {
        #[serde(rename = "box")]
        region: GridBox,
        from: BlockRef,
        to: BlockRef,
    },
    /// 复制区域：把 `source` 的扩展层内容原样复制到以 `to` 为最小角的位置。
    CopyRegion {
        source: GridBox,
        to: [i64; 3],
    },
    /// 新增方块：用临时名称引用，发布时由服务端分配正式编号。
    AddBlock {
        block: BlockDef,
    },
    /// 放物件（新建或替换同编号、同一层的物件）。
    PlaceEntity {
        entity: Box<EntityBody>,
    },
    /// 删物件。`ifPresent: true` 时物件不存在就什么都不做。
    RemoveEntity {
        entity_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        if_present: Option<bool>,
    },
    /// 新建锚点。`ifNew: true` 时编号在本空间时间线上出现过（不论现在还在不在）就什么都不做。
    CreateAnchor {
        anchor: AnchorBody,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        if_new: Option<bool>,
    },
    /// 移动锚点：给出新的 `box` 或 `position`。
    MoveAnchor {
        anchor_id: String,
        #[serde(rename = "box", default, skip_serializing_if = "Option::is_none")]
        grid_box: Option<GridBox>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        position: Option<[f64; 3]>,
    },
    /// 修改锚点的标签、可见级别或类型。
    UpdateAnchor {
        anchor_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        visibility: Option<DataVisibility>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<AnchorKind>,
    },
    RemoveAnchor {
        anchor_id: String,
    },
    /// 设置这次提交的扫描层（只在重建草稿里，一个草稿最多一次）。
    SetScan {
        scan: ScanSpec,
        /// 拍摄时间（可选）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observed_at: Option<Timestamp>,
    },
    /// 把重建层的全部物件（结构、物体、模板）删掉（只在重建草稿里）；扩展层、锚点、区块都不动。
    ClearRebuilt {},
}

impl Op {
    /// JSON 里的操作名。
    pub fn name(&self) -> &'static str {
        match self {
            Op::Fill { .. } => "fill",
            Op::HollowBox { .. } => "hollowBox",
            Op::Replace { .. } => "replace",
            Op::CopyRegion { .. } => "copyRegion",
            Op::AddBlock { .. } => "addBlock",
            Op::PlaceEntity { .. } => "placeEntity",
            Op::RemoveEntity { .. } => "removeEntity",
            Op::CreateAnchor { .. } => "createAnchor",
            Op::MoveAnchor { .. } => "moveAnchor",
            Op::UpdateAnchor { .. } => "updateAnchor",
            Op::RemoveAnchor { .. } => "removeAnchor",
            Op::SetScan { .. } => "setScan",
            Op::ClearRebuilt {} => "clearRebuilt",
        }
    }
}

/// 一个操作的影响范围：涉及的格子盒子，以及是否涉及整个空间。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Footprint {
    pub cells: Vec<GridBox>,
    pub space_wide: bool,
}

impl Footprint {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn cells(cells: Vec<GridBox>) -> Self {
        Self {
            cells,
            space_wide: false,
        }
    }

    pub fn space_wide() -> Self {
        Self {
            cells: Vec::new(),
            space_wide: true,
        }
    }

    fn add_anchor(&mut self, footprint: AnchorFootprint) {
        match footprint {
            AnchorFootprint::SpaceWide => self.space_wide = true,
            AnchorFootprint::Cells(cells) => self.cells.push(cells),
        }
    }
}

/// `createAnchor` 带 `ifNew` 时为什么跳过。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnchorSkip {
    /// 现在就有这个锚点。
    Exists,
    /// 现在没有，但本空间的时间线上出现过（被删掉的锚点不复活）。
    Existed,
}

/// 一批操作碰过的键。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TouchedSet {
    pub chunks: BTreeSet<ChunkKey>,
    pub entities: BTreeSet<String>,
    pub anchors: BTreeSet<String>,
    pub palette: bool,
    /// 有 `setScan`。
    pub scan: bool,
    /// 有 `clearRebuilt`。
    pub rebuilt_layer: bool,
    /// 带 `ifNew` 而跳过的锚点（不算碰过，只用来报告：重建包的展开结果列出它们）。
    pub skipped_anchors: BTreeMap<String, AnchorSkip>,
}

impl TouchedSet {
    pub fn merge(&mut self, other: TouchedSet) {
        self.chunks.extend(other.chunks);
        self.entities.extend(other.entities);
        self.anchors.extend(other.anchors);
        self.palette |= other.palette;
        self.scan |= other.scan;
        self.rebuilt_layer |= other.rebuilt_layer;
        self.skipped_anchors.extend(other.skipped_anchors);
    }

    pub fn to_model(&self) -> Touched {
        Touched {
            chunks: self.chunks.iter().copied().collect(),
            entities: self.entities.iter().cloned().collect(),
            anchors: self.anchors.iter().cloned().collect(),
            regions: false,
            plots: false,
            palette: self.palette,
            scan: self.scan,
            rebuilt_layer: self.rebuilt_layer,
        }
    }
}

/// 工作状态的范围种类：决定能用哪些操作、写哪一层（docs/design/server-slim.md 2.4）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ScopeKind {
    /// 实体区、地块草稿：写扩展层。
    #[default]
    Ext,
    /// 重建草稿：写重建层和扫描。
    Rebuild,
}

impl ScopeKind {
    /// 路径范围对应的种类：重建路径是重建，其余都是扩展。
    pub fn of(scope: &PathScope) -> Self {
        match scope {
            PathScope::Rebuild => ScopeKind::Rebuild,
            _ => ScopeKind::Ext,
        }
    }

    /// 这种草稿写的那一层。
    pub fn layer(self) -> Layer {
        match self {
            ScopeKind::Ext => Layer::Ext,
            ScopeKind::Rebuild => Layer::Rebuilt,
        }
    }
}

/// 草稿里的 `setScan`。
#[derive(Debug, Clone, PartialEq)]
pub struct DraftScan {
    pub scan: ScanSpec,
    pub observed_at: Option<Timestamp>,
}

/// 操作作用的对象：区块、物件、锚点、方块表的当前内容，以及范围种类、锚点历史、草稿的扫描。
#[derive(Debug, Clone, Default)]
pub struct WorkingState {
    pub chunks: BTreeMap<ChunkKey, Chunk>,
    pub entities: BTreeMap<String, EntityBody>,
    pub anchors: BTreeMap<String, AnchorBody>,
    pub palette: Vec<PaletteBlock>,
    /// 草稿里新增的方块：临时名称 → (临时编号, 定义)。
    pub provisional_blocks: BTreeMap<String, (u16, BlockDef)>,
    /// 范围种类（默认扩展）。
    pub kind: ScopeKind,
    /// 本空间时间线上出现过的锚点编号（草稿基础版本及更早，重放时是最新版本及更早）。
    /// 只在这一批操作里有 `ifNew` 时才需要，由调用方加载。
    pub anchor_history: BTreeSet<String>,
    /// 草稿的 `setScan`（一个草稿最多一次）。
    pub scan: Option<DraftScan>,
}

/// 盒子按区块切开：(区块坐标, 落在这个区块里的格子盒子)。
fn chunk_spans(region: &GridBox) -> Vec<([i32; 3], GridBox)> {
    let size = CHUNK_SIZE as i64;
    let low = locate_cell(region.min).0;
    let high = locate_cell(region.max.map(|v| v - 1)).0;
    let mut spans = Vec::new();
    for cy in low[1]..=high[1] {
        for cz in low[2]..=high[2] {
            for cx in low[0]..=high[0] {
                let base = [
                    i64::from(cx) * size,
                    i64::from(cy) * size,
                    i64::from(cz) * size,
                ];
                let chunk_box = GridBox {
                    min: base,
                    max: base.map(|v| v + size),
                };
                if let Some(part) = chunk_box.intersection(region) {
                    spans.push(([cx, cy, cz], part));
                }
            }
        }
    }
    spans
}

fn local_index(cell: [i64; 3]) -> usize {
    let (_, [x, y, z]) = locate_cell(cell);
    x + CHUNK_SIZE * (z + CHUNK_SIZE * y)
}

fn cells_of(region: &GridBox) -> impl Iterator<Item = [i64; 3]> + '_ {
    (region.min[1]..region.max[1]).flat_map(move |y| {
        (region.min[2]..region.max[2])
            .flat_map(move |z| (region.min[0]..region.max[0]).map(move |x| [x, y, z]))
    })
}

fn check_cell_count(region: &GridBox) -> Result<(), OpError> {
    if region.volume() > MAX_OP_CELLS {
        Err(invalid("单个操作最多涉及 4194304 格"))
    } else {
        Ok(())
    }
}

impl WorkingState {
    /// 空的工作状态，带范围种类。
    pub fn with_kind(kind: ScopeKind) -> Self {
        Self {
            kind,
            ..Self::default()
        }
    }

    /// 某图层某一格的方块编号。
    pub fn block_at(&self, layer: Layer, cell: [i64; 3]) -> u16 {
        let (chunk, _) = locate_cell(cell);
        let key = ChunkKey {
            layer,
            cx: chunk[0],
            cy: chunk[1],
            cz: chunk[2],
        };
        self.chunks
            .get(&key)
            .map_or(BLOCK_EMPTY, |chunk| chunk.cells()[local_index(cell)])
    }

    /// 看得到的方块：扩展层优先；空气覆盖算作空。
    pub fn effective_block(&self, cell: [i64; 3]) -> u16 {
        match self.block_at(Layer::Ext, cell) {
            BLOCK_EMPTY => self.block_at(Layer::Rebuilt, cell),
            BLOCK_AIR => BLOCK_EMPTY,
            block => block,
        }
    }

    /// 把方块引用解析成编号。0、1 是保留编号，其余必须在方块表或草稿新增的方块里。
    pub fn resolve_block(&self, reference: &BlockRef) -> Result<u16, OpError> {
        match reference {
            BlockRef::Id(id @ (BLOCK_EMPTY | BLOCK_AIR)) => Ok(*id),
            BlockRef::Id(id) => {
                if self.palette.iter().any(|block| block.id == *id)
                    || self.provisional_blocks.values().any(|(pid, _)| pid == id)
                {
                    Ok(*id)
                } else {
                    Err(invalid(format!("方块表里没有编号 {id}")))
                }
            }
            BlockRef::Temp(name) => self
                .provisional_blocks
                .get(name)
                .map(|(id, _)| *id)
                .ok_or_else(|| invalid(format!("草稿里没有新增名为 {name} 的方块"))),
        }
    }

    /// 某一层的模板（`kind: "template"` 的物件）。物件只能引用同一层的模板。
    pub fn templates_of(&self, layer: Layer) -> BTreeMap<String, Shape> {
        self.entities
            .values()
            .filter(|entity| entity.kind == EntityKind::Template && entity.layer == layer)
            .filter_map(|entity| {
                entity
                    .shape
                    .clone()
                    .map(|shape| (entity.entity_id.clone(), shape))
            })
            .collect()
    }

    /// 同一层里直接或间接引用了某个模板的物件（不含模板，也不含其他模板）。
    fn users_of_template(&self, template: &str, layer: Layer) -> Vec<&EntityBody> {
        let mut affected: BTreeSet<String> = BTreeSet::from([template.to_owned()]);
        loop {
            let before = affected.len();
            for entity in self.entities.values().filter(|e| e.layer == layer) {
                if let Some(shape) = &entity.shape {
                    if shape.template_refs().iter().any(|r| affected.contains(r)) {
                        affected.insert(entity.entity_id.clone());
                    }
                }
            }
            if affected.len() == before {
                break;
            }
        }
        self.entities
            .values()
            .filter(|entity| {
                entity.layer == layer
                    && entity.entity_id != template
                    && affected.contains(&entity.entity_id)
                    && entity.kind != EntityKind::Template
            })
            .collect()
    }

    fn entity_footprint(&self, entity: &EntityBody) -> Result<Vec<GridBox>, OpError> {
        if entity.kind == EntityKind::Template {
            // 模板没有世界坐标；改模板等于改同一层里所有用到它的物件。
            return self
                .users_of_template(&entity.entity_id, entity.layer)
                .into_iter()
                .map(|user| user.footprint().map_err(OpError::from))
                .collect();
        }
        Ok(vec![entity.footprint()?])
    }

    /// 这种草稿能不能用这个操作。
    fn check_allowed(&self, op: &Op) -> Result<(), OpError> {
        match (self.kind, op) {
            (ScopeKind::Ext, Op::SetScan { .. } | Op::ClearRebuilt {}) => Err(not_allowed(
                format!("{} 只能出现在重建草稿里（由重建包展开产生）", op.name()),
            )),
            (
                ScopeKind::Rebuild,
                Op::Fill { .. }
                | Op::HollowBox { .. }
                | Op::Replace { .. }
                | Op::CopyRegion { .. }
                | Op::AddBlock { .. }
                | Op::MoveAnchor { .. }
                | Op::UpdateAnchor { .. }
                | Op::RemoveAnchor { .. },
            ) => Err(not_allowed(format!(
                "重建草稿里不能有 {}（重建包不写方块，锚点只能新建）",
                op.name()
            ))),
            (ScopeKind::Rebuild, Op::CreateAnchor { if_new, .. }) if *if_new != Some(true) => {
                Err(not_allowed("重建草稿里新建锚点必须带 ifNew"))
            }
            _ => Ok(()),
        }
    }

    /// 同编号的现有物件；属于另一层时报错（两层共用一个编号空间）。
    fn existing_entity(&self, id: &str) -> Result<Option<&EntityBody>, OpError> {
        let layer = self.kind.layer();
        match self.entities.get(id) {
            Some(entity) if entity.layer != layer => Err(invalid(match self.kind {
                ScopeKind::Ext => format!("物件 {id} 属于重建层，只能经重建路径修改"),
                ScopeKind::Rebuild => format!("物件 {id} 属于扩展层，重建草稿不能修改"),
            })),
            other => Ok(other),
        }
    }

    fn existing_anchor(&self, id: &str) -> Result<&AnchorBody, OpError> {
        self.anchors
            .get(id)
            .ok_or_else(|| invalid(format!("锚点 {id} 不存在")))
    }

    /// 带 `ifNew` 的锚点要不要跳过；跳过时给出原因。
    fn anchor_skip(&self, anchor_id: &str, if_new: Option<bool>) -> Option<AnchorSkip> {
        if if_new != Some(true) {
            return None;
        }
        if self.anchors.contains_key(anchor_id) {
            Some(AnchorSkip::Exists)
        } else if self.anchor_history.contains(anchor_id) {
            Some(AnchorSkip::Existed)
        } else {
            None
        }
    }

    /// 操作的影响范围（按操作之前的状态计算）。
    pub fn footprint(&self, op: &Op) -> Result<Footprint, OpError> {
        self.check_allowed(op)?;
        let mut footprint = Footprint::none();
        match op {
            Op::Fill { region, .. } | Op::HollowBox { region, .. } | Op::Replace { region, .. } => {
                footprint.cells.push(*region)
            }
            Op::CopyRegion { source, to } => {
                let offset = [0, 1, 2].map(|axis| to[axis] - source.min[axis]);
                footprint.cells.push(
                    source
                        .translated(offset)
                        .map_err(|error| invalid(error.to_string()))?,
                );
            }
            Op::AddBlock { .. } | Op::SetScan { .. } => {}
            Op::PlaceEntity { entity } => {
                footprint.cells.extend(self.entity_footprint(entity)?);
                if let Some(old) = self.existing_entity(&entity.entity_id)? {
                    footprint.cells.extend(self.entity_footprint(old)?);
                }
            }
            Op::RemoveEntity {
                entity_id,
                if_present,
            } => match self.existing_entity(entity_id)? {
                Some(old) => footprint.cells.extend(self.entity_footprint(old)?),
                None if *if_present == Some(true) => {}
                None => return Err(invalid(format!("物件 {entity_id} 不存在"))),
            },
            Op::ClearRebuilt {} => {
                for entity in self
                    .entities
                    .values()
                    .filter(|e| e.layer == Layer::Rebuilt && e.kind != EntityKind::Template)
                {
                    footprint.cells.push(entity.footprint()?);
                }
            }
            Op::CreateAnchor { anchor, if_new } => {
                if self.anchor_skip(&anchor.anchor_id, *if_new).is_none() {
                    footprint.add_anchor(anchor.footprint()?);
                }
            }
            Op::MoveAnchor {
                anchor_id,
                grid_box,
                position,
            } => {
                let old = self.existing_anchor(anchor_id)?;
                footprint.add_anchor(old.footprint()?);
                let moved = AnchorBody {
                    grid_box: *grid_box,
                    position: *position,
                    ..old.clone()
                };
                footprint.add_anchor(moved.footprint()?);
            }
            Op::UpdateAnchor { anchor_id, .. } | Op::RemoveAnchor { anchor_id } => {
                footprint.add_anchor(self.existing_anchor(anchor_id)?.footprint()?)
            }
        }
        Ok(footprint)
    }

    fn write_cells(&mut self, region: &GridBox, block: u16, touched: &mut TouchedSet) {
        for (chunk, part) in chunk_spans(region) {
            let key = ChunkKey {
                layer: Layer::Ext,
                cx: chunk[0],
                cy: chunk[1],
                cz: chunk[2],
            };
            let cells = self.chunks.entry(key).or_default().cells_mut();
            for cell in cells_of(&part) {
                cells[local_index(cell)] = block;
            }
            touched.chunks.insert(key);
        }
    }

    fn write_cell(&mut self, cell: [i64; 3], block: u16, touched: &mut TouchedSet) {
        let (chunk, _) = locate_cell(cell);
        let key = ChunkKey {
            layer: Layer::Ext,
            cx: chunk[0],
            cy: chunk[1],
            cz: chunk[2],
        };
        self.chunks.entry(key).or_default().cells_mut()[local_index(cell)] = block;
        touched.chunks.insert(key);
    }

    /// 物件编号分区：重建层新放的必须以 `rb.` 开头；扩展层新放的不能以 `rb.` 开头
    /// （已有的扩展层旧编号照常可以改）。
    fn check_entity_id(&self, entity: &EntityBody) -> Result<(), OpError> {
        let id = &entity.entity_id;
        match self.kind {
            ScopeKind::Rebuild if !is_rebuilt_id(id) => Err(invalid(format!(
                "重建层新放的物件编号必须以 {REBUILT_ID_PREFIX} 开头（旧编号 {id} 只能删）"
            ))),
            ScopeKind::Ext if is_rebuilt_id(id) && !self.entities.contains_key(id) => Err(invalid(
                format!("{REBUILT_ID_PREFIX} 开头的编号留给重建层，扩展层不能新放 {id}"),
            )),
            _ => Ok(()),
        }
    }

    /// 作用一条操作（不检查路径范围）。
    pub fn apply(&mut self, op: &Op) -> Result<TouchedSet, OpError> {
        self.check_allowed(op)?;
        let mut touched = TouchedSet::default();
        match op {
            Op::Fill { region, block } => {
                check_cell_count(region)?;
                let block = self.resolve_block(block)?;
                self.write_cells(region, block, &mut touched);
            }
            Op::HollowBox {
                region,
                block,
                thickness,
            } => {
                check_cell_count(region)?;
                let thickness = thickness.unwrap_or(1);
                if thickness == 0 || thickness > MAX_HOLLOW_THICKNESS {
                    return Err(invalid("壁厚必须在 1 到 64 之间"));
                }
                let block = self.resolve_block(block)?;
                let t = i64::from(thickness);
                let inner = GridBox {
                    min: region.min.map(|v| v + t),
                    max: region.max.map(|v| v - t),
                };
                let shell = if inner.validate().is_ok() {
                    region.subtract(&inner)
                } else {
                    vec![*region]
                };
                for part in shell {
                    self.write_cells(&part, block, &mut touched);
                }
            }
            Op::Replace { region, from, to } => {
                check_cell_count(region)?;
                let from = self.resolve_block(from)?;
                let to = self.resolve_block(to)?;
                let matching: Vec<_> = cells_of(region)
                    .filter(|cell| self.effective_block(*cell) == from)
                    .collect();
                for cell in matching {
                    self.write_cell(cell, to, &mut touched);
                }
            }
            Op::CopyRegion { source, to } => {
                check_cell_count(source)?;
                let offset = [0, 1, 2].map(|axis| to[axis] - source.min[axis]);
                source
                    .translated(offset)
                    .map_err(|error| invalid(error.to_string()))?;
                let values: Vec<_> = cells_of(source)
                    .map(|cell| (cell, self.block_at(Layer::Ext, cell)))
                    .collect();
                for (cell, block) in values {
                    let target = [0, 1, 2].map(|axis| cell[axis] + offset[axis]);
                    self.write_cell(target, block, &mut touched);
                }
            }
            Op::AddBlock { block } => {
                block.validate()?;
                if self
                    .palette
                    .iter()
                    .any(|existing| existing.name == block.name)
                    || self.provisional_blocks.contains_key(&block.name)
                {
                    return Err(invalid(format!("方块名称 {} 已存在", block.name)));
                }
                let next = self
                    .palette
                    .iter()
                    .map(|existing| existing.id)
                    .chain(self.provisional_blocks.values().map(|(id, _)| *id))
                    .max()
                    .unwrap_or(BLOCK_AIR)
                    .max(BLOCK_AIR)
                    .checked_add(1)
                    .ok_or_else(|| invalid("方块编号已用完"))?;
                self.provisional_blocks
                    .insert(block.name.clone(), (next, block.clone()));
                touched.palette = true;
            }
            Op::PlaceEntity { entity } => {
                let layer = self.kind.layer();
                if entity.layer != layer {
                    return Err(invalid(match self.kind {
                        ScopeKind::Ext => "操作只能放扩展层的物件",
                        ScopeKind::Rebuild => "重建草稿只能放重建层的物件",
                    }));
                }
                self.check_entity_id(entity)?;
                self.existing_entity(&entity.entity_id)?;
                // 模板只能被同一层引用：只把这一层的模板交给校验。
                let mut templates = self.templates_of(layer);
                if entity.kind == EntityKind::Template {
                    if let Some(shape) = &entity.shape {
                        templates.insert(entity.entity_id.clone(), shape.clone());
                    }
                }
                entity.validate(&templates)?;
                self.entities
                    .insert(entity.entity_id.clone(), (**entity).clone());
                touched.entities.insert(entity.entity_id.clone());
            }
            Op::RemoveEntity {
                entity_id,
                if_present,
            } => {
                let Some(existing) = self.existing_entity(entity_id)? else {
                    if *if_present == Some(true) {
                        return Ok(touched);
                    }
                    return Err(invalid(format!("物件 {entity_id} 不存在")));
                };
                if !self.users_of_template(entity_id, existing.layer).is_empty() {
                    return Err(invalid(format!("模板 {entity_id} 仍被物件使用")));
                }
                self.entities.remove(entity_id);
                touched.entities.insert(entity_id.clone());
            }
            Op::ClearRebuilt {} => {
                let removed: Vec<String> = self
                    .entities
                    .values()
                    .filter(|entity| entity.layer == Layer::Rebuilt)
                    .map(|entity| entity.entity_id.clone())
                    .collect();
                for id in removed {
                    self.entities.remove(&id);
                    touched.entities.insert(id);
                }
                touched.rebuilt_layer = true;
            }
            Op::SetScan { scan, observed_at } => {
                if self.scan.is_some() {
                    return Err(invalid("一个草稿最多一次 setScan"));
                }
                scan.validate()?;
                self.scan = Some(DraftScan {
                    scan: scan.clone(),
                    observed_at: *observed_at,
                });
                touched.scan = true;
            }
            Op::CreateAnchor { anchor, if_new } => {
                anchor.validate()?;
                if let Some(skip) = self.anchor_skip(&anchor.anchor_id, *if_new) {
                    touched
                        .skipped_anchors
                        .insert(anchor.anchor_id.clone(), skip);
                    return Ok(touched);
                }
                if self.anchors.contains_key(&anchor.anchor_id) {
                    return Err(invalid(format!("锚点 {} 已存在", anchor.anchor_id)));
                }
                self.anchors
                    .insert(anchor.anchor_id.clone(), anchor.clone());
                touched.anchors.insert(anchor.anchor_id.clone());
            }
            Op::MoveAnchor {
                anchor_id,
                grid_box,
                position,
            } => {
                let moved = AnchorBody {
                    grid_box: *grid_box,
                    position: *position,
                    ..self.existing_anchor(anchor_id)?.clone()
                };
                moved.validate()?;
                if moved.kind == AnchorKind::Space {
                    return Err(invalid("空间级锚点没有位置"));
                }
                self.anchors.insert(anchor_id.clone(), moved);
                touched.anchors.insert(anchor_id.clone());
            }
            Op::UpdateAnchor {
                anchor_id,
                label,
                visibility,
                kind,
            } => {
                if label.is_none() && visibility.is_none() && kind.is_none() {
                    return Err(invalid("修改锚点至少要给出一个字段"));
                }
                let mut updated = self.existing_anchor(anchor_id)?.clone();
                if let Some(label) = label {
                    updated.label = Some(label.clone());
                }
                if let Some(visibility) = visibility {
                    updated.visibility = *visibility;
                }
                if let Some(kind) = kind {
                    updated.kind = *kind;
                }
                updated.validate()?;
                self.anchors.insert(anchor_id.clone(), updated);
                touched.anchors.insert(anchor_id.clone());
            }
            Op::RemoveAnchor { anchor_id } => {
                if anchor_id == SPACE_ANCHOR_ID {
                    return Err(invalid("空间级锚点不能删除"));
                }
                self.existing_anchor(anchor_id)?;
                self.anchors.remove(anchor_id);
                touched.anchors.insert(anchor_id.clone());
            }
        }
        Ok(touched)
    }

    /// 逐条检查影响范围并作用。任何一条失败都返回错误，状态保持不变。
    pub fn apply_in_scope(
        &mut self,
        ops: &[Op],
        area: &AllowedArea,
    ) -> Result<TouchedSet, OpError> {
        if ops.len() > MAX_OPS_PER_BATCH {
            return Err(OpError::TooManyOps);
        }
        let mut next = self.clone();
        let mut touched = TouchedSet::default();
        for (index, op) in ops.iter().enumerate() {
            let footprint = next.footprint(op).map_err(|e| e.at(index))?;
            area.check(&footprint)
                .map_err(|source| OpError::Scope { index, source })?;
            touched.merge(next.apply(op).map_err(|e| e.at(index))?);
        }
        *self = next;
        Ok(touched)
    }

    /// 模板引用的完整性（docs/design/server-slim.md 2.5 第 3 条）：每个物件（含模板）形状里引用的
    /// 模板都要在**同一层**存在。返回缺的引用 (物件编号, 模板编号)，按物件编号排好；空表示完整。
    pub fn broken_template_refs(&self) -> Vec<(String, String)> {
        let mut broken = Vec::new();
        for entity in self.entities.values() {
            let Some(shape) = &entity.shape else { continue };
            for template in shape.template_refs() {
                let found = self.entities.get(&template).is_some_and(|target| {
                    target.kind == EntityKind::Template && target.layer == entity.layer
                });
                if !found {
                    broken.push((entity.entity_id.clone(), template));
                }
            }
        }
        broken
    }

    /// 与基础版本相比，碰过的区块有哪些变化；全 0 的区块记为删除（`hash = null`）。
    pub fn chunk_changes(
        &self,
        base: &BTreeMap<ChunkKey, String>,
        touched: &BTreeSet<ChunkKey>,
    ) -> Vec<ChunkChange> {
        touched
            .iter()
            .filter_map(|key| {
                let hash = self
                    .chunks
                    .get(key)
                    .filter(|chunk| !chunk.is_empty())
                    .map(Chunk::hash);
                let changed = hash.as_ref() != base.get(key);
                changed.then_some(ChunkChange {
                    layer: key.layer,
                    cx: key.cx,
                    cy: key.cy,
                    cz: key.cz,
                    hash,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Plot, Region, RegionKind};
    use serde_json::json;

    fn gb(v: [i64; 6]) -> GridBox {
        GridBox::from_array(v).unwrap()
    }

    fn op(value: serde_json::Value) -> Op {
        serde_json::from_value(value).unwrap()
    }

    fn state() -> WorkingState {
        WorkingState {
            palette: vec![PaletteBlock {
                id: 2,
                name: "stone".into(),
                kind: BlockKind::Solid,
                color: Some([128, 128, 128]),
                texture: None,
                tags: vec![],
            }],
            ..WorkingState::default()
        }
    }

    fn plot_area() -> AllowedArea {
        let regions = vec![Region {
            id: "garden".into(),
            kind: RegionKind::Virtual,
            boxes: vec![gb([0, 0, 0, 64, 64, 64])],
            name: None,
        }];
        let plots = vec![Plot {
            id: "p1".into(),
            region_id: "garden".into(),
            boxes: vec![gb([0, 0, 0, 40, 40, 40])],
            name: None,
        }];
        AllowedArea::for_scope(&PathScope::Plot("p1".into()), &regions, &plots).unwrap()
    }

    #[test]
    fn op_json_names() {
        let fill = op(json!({"op":"fill","box":[0,0,0,2,2,2],"block":2}));
        assert_eq!(
            serde_json::to_value(&fill).unwrap(),
            json!({"op":"fill","box":[0,0,0,2,2,2],"block":2})
        );
        op(json!({"op":"hollowBox","box":[0,0,0,4,4,4],"block":"brick","thickness":1}));
        op(json!({"op":"moveAnchor","anchorId":"t1","position":[1,0,1]}));
        assert!(serde_json::from_value::<Op>(
            json!({"op":"fill","box":[0,0,0,2,2,2],"block":2,"extra":1})
        )
        .is_err());
        assert!(serde_json::from_value::<Op>(json!({"op":"explode"})).is_err());
        // 新操作与新字段。
        let clear = op(json!({"op":"clearRebuilt"}));
        assert_eq!(clear.name(), "clearRebuilt");
        assert_eq!(
            serde_json::to_value(&clear).unwrap(),
            json!({"op":"clearRebuilt"})
        );
        assert!(serde_json::from_value::<Op>(json!({"op":"clearRebuilt","chunks":true})).is_err());
        let remove = op(json!({"op":"removeEntity","entityId":"x","ifPresent":true}));
        assert_eq!(
            serde_json::to_value(&remove).unwrap(),
            json!({"op":"removeEntity","entityId":"x","ifPresent":true})
        );
        // 不写 ifPresent 的旧操作原样往返。
        let old = json!({"op":"removeEntity","entityId":"x"});
        assert_eq!(serde_json::to_value(op(old.clone())).unwrap(), old);
    }

    #[test]
    fn fill_spans_chunks_and_reports_changes() {
        let mut s = state();
        let touched = s
            .apply(&op(json!({"op":"fill","box":[30,0,0,34,1,1],"block":2})))
            .unwrap();
        assert_eq!(touched.chunks.len(), 2);
        assert_eq!(s.block_at(Layer::Ext, [31, 0, 0]), 2);
        assert_eq!(s.block_at(Layer::Ext, [33, 0, 0]), 2);
        assert_eq!(s.block_at(Layer::Ext, [34, 0, 0]), 0);
        let changes = s.chunk_changes(&BTreeMap::new(), &touched.chunks);
        assert_eq!(changes.len(), 2);
        assert!(changes.iter().all(|c| c.hash.is_some()));
        // 清空后对基础版本来说是删除。
        let base: BTreeMap<_, _> = changes
            .iter()
            .map(|c| {
                (
                    ChunkKey {
                        layer: c.layer,
                        cx: c.cx,
                        cy: c.cy,
                        cz: c.cz,
                    },
                    c.hash.clone().unwrap(),
                )
            })
            .collect();
        let cleared = s
            .apply(&op(json!({"op":"fill","box":[30,0,0,34,1,1],"block":0})))
            .unwrap();
        let changes = s.chunk_changes(&base, &cleared.chunks);
        assert!(changes.iter().all(|c| c.hash.is_none()));
    }

    #[test]
    fn hollow_replace_copy_and_temp_blocks() {
        let mut s = state();
        s.apply(&op(
            json!({"op":"addBlock","block":{"name":"brick","kind":"solid","color":[180,60,40]}}),
        ))
        .unwrap();
        assert_eq!(s.resolve_block(&BlockRef::Temp("brick".into())).unwrap(), 3);
        s.apply(&op(
            json!({"op":"hollowBox","box":[0,0,0,3,3,3],"block":"brick"}),
        ))
        .unwrap();
        assert_eq!(s.block_at(Layer::Ext, [1, 1, 1]), 0);
        assert_eq!(s.block_at(Layer::Ext, [0, 1, 1]), 3);
        s.apply(&op(
            json!({"op":"replace","box":[0,0,0,3,3,3],"from":"brick","to":2}),
        ))
        .unwrap();
        assert_eq!(s.block_at(Layer::Ext, [2, 2, 2]), 2);
        assert_eq!(s.block_at(Layer::Ext, [1, 1, 1]), 0);
        s.apply(&op(
            json!({"op":"copyRegion","source":[0,0,0,3,3,3],"to":[10,0,0]}),
        ))
        .unwrap();
        assert_eq!(s.block_at(Layer::Ext, [10, 0, 0]), 2);
        assert_eq!(s.block_at(Layer::Ext, [11, 1, 1]), 0);
        assert!(s
            .apply(&op(json!({"op":"fill","box":[0,0,0,1,1,1],"block":9})))
            .is_err());
    }

    #[test]
    fn replace_sees_rebuilt_layer_and_air_override() {
        let mut s = state();
        s.chunks
            .entry(ChunkKey {
                layer: Layer::Rebuilt,
                cx: 0,
                cy: 0,
                cz: 0,
            })
            .or_default()
            .set(0, 0, 0, 2)
            .unwrap();
        assert_eq!(s.effective_block([0, 0, 0]), 2);
        s.apply(&op(
            json!({"op":"replace","box":[0,0,0,1,1,1],"from":2,"to":1}),
        ))
        .unwrap();
        assert_eq!(s.effective_block([0, 0, 0]), 0);
        assert_eq!(s.block_at(Layer::Rebuilt, [0, 0, 0]), 2);
    }

    #[test]
    fn scope_checks_are_atomic() {
        let area = plot_area();
        let mut s = state();
        let ok = [
            op(json!({"op":"fill","box":[0,0,0,4,4,4],"block":2})),
            op(
                json!({"op":"createAnchor","anchor":{"anchorId":"t1","kind":"table","box":[1,0,1,3,2,3],"visibility":"public"}}),
            ),
        ];
        let touched = s.apply_in_scope(&ok, &area).unwrap();
        assert_eq!(touched.anchors.len(), 1);
        let before = s.clone();
        let bad = [
            op(json!({"op":"fill","box":[0,0,0,1,1,1],"block":0})),
            op(json!({"op":"moveAnchor","anchorId":"t1","box":[39,0,39,41,2,41]})),
        ];
        match s.apply_in_scope(&bad, &area) {
            Err(OpError::Scope { index: 1, .. }) => {}
            other => panic!("{other:?}"),
        }
        assert_eq!(s.chunks, before.chunks);
        assert_eq!(s.anchors, before.anchors);
        let copy_out = [op(
            json!({"op":"copyRegion","source":[0,0,0,4,4,4],"to":[38,0,0]}),
        )];
        assert!(s.apply_in_scope(&copy_out, &area).is_err());
        assert_eq!(
            s.apply_in_scope(&vec![ok[0].clone(); 201], &area),
            Err(OpError::TooManyOps)
        );
    }

    #[test]
    fn entities_only_in_ext_and_templates_cover_their_users() {
        let area = plot_area();
        let mut s = state();
        let template = json!({"op":"placeEntity","entity":{"entityId":"chair-a","layer":"ext","kind":"template",
            "shape":{"type":"box","size":[0.5,0.9,0.5]},"bounds":{"min":[-0.25,0,-0.25],"max":[0.25,0.9,0.25]}}});
        let chair = json!({"op":"placeEntity","entity":{"entityId":"chair-1","layer":"ext","kind":"object",
            "shape":{"type":"instance","template":"chair-a","transform":{"position":[1,0,1]}},
            "bounds":{"min":[0.75,0,0.75],"max":[1.25,0.9,1.25]}}});
        s.apply_in_scope(&[op(template.clone()), op(chair)], &area)
            .unwrap();
        // 物件在地块外时，修改它用到的模板也超出范围。
        let far = json!({"op":"placeEntity","entity":{"entityId":"chair-2","layer":"ext","kind":"object",
            "shape":{"type":"instance","template":"chair-a","transform":{"position":[10,0,1]}},
            "bounds":{"min":[9.75,0,0.75],"max":[10.25,0.9,1.25]}}});
        s.apply(&op(far)).unwrap();
        assert!(matches!(
            s.apply_in_scope(&[op(template)], &area),
            Err(OpError::Scope { .. })
        ));
        assert!(s
            .apply(&op(json!({"op":"removeEntity","entityId":"chair-a"})))
            .is_err());
        let rebuilt = json!({"op":"placeEntity","entity":{"entityId":"wall","layer":"rebuilt","kind":"structure",
            "shape":{"type":"box","size":[1,1,1]},"bounds":{"min":[-0.5,0,-0.5],"max":[0.5,1,0.5]}}});
        assert!(s.apply(&op(rebuilt)).is_err());
        assert!(s.broken_template_refs().is_empty());
    }

    fn rebuilt_box(id: &str) -> serde_json::Value {
        json!({"entityId": id, "layer": "rebuilt", "kind": "structure",
            "shape": {"type": "box", "size": [1, 1, 1], "transform": {"position": [0, 0, 0]}},
            "bounds": {"min": [-0.5, 0, -0.5], "max": [0.5, 1, 0.5]}})
    }

    fn scan_op() -> serde_json::Value {
        json!({"op": "setScan", "scan": {
            "assetHash": "a".repeat(64), "webModelHashes": ["b".repeat(64)],
            "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 2,0,3,1],
            "alignment": {"method": "given"}},
            "observedAt": "2026-10-20T00:00:00.000Z"})
    }

    #[test]
    fn rebuild_scope_rules() {
        let mut s = WorkingState::with_kind(ScopeKind::Rebuild);
        // 旧的重建层物件（处理服务写的编号）和一个扩展层物件。
        let old: EntityBody = serde_json::from_value(rebuilt_box("wall-01")).unwrap();
        s.entities.insert(old.entity_id.clone(), old);
        let mut ext: EntityBody = serde_json::from_value(rebuilt_box("lamp")).unwrap();
        ext.layer = Layer::Ext;
        s.entities.insert(ext.entity_id.clone(), ext);

        // 方块操作、移动锚点在重建草稿里不允许。
        for bad in [
            json!({"op":"fill","box":[0,0,0,1,1,1],"block":2}),
            json!({"op":"addBlock","block":{"name":"b","kind":"solid","color":[1,2,3]}}),
            json!({"op":"removeAnchor","anchorId":"t1"}),
            json!({"op":"createAnchor","anchor":{"anchorId":"t1","kind":"table","box":[0,0,0,1,1,1],"visibility":"public"}}),
        ] {
            assert!(matches!(
                s.footprint(&op(bad.clone())),
                Err(OpError::NotAllowed { .. })
            ));
            assert!(
                matches!(s.apply(&op(bad.clone())), Err(OpError::NotAllowed { .. })),
                "{bad}"
            );
        }
        // 新放的编号必须以 rb. 开头；旧编号只能删。
        let mut wall = rebuilt_box("wall-01");
        assert!(s
            .apply(&op(json!({"op":"placeEntity","entity": wall.clone()})))
            .is_err());
        wall["entityId"] = json!("rb.wall-01");
        s.apply(&op(json!({"op":"placeEntity","entity": wall})))
            .unwrap();
        // 扩展层的物件不能动。
        assert!(s
            .apply(&op(
                json!({"op":"removeEntity","entityId":"lamp","ifPresent":true})
            ))
            .is_err());
        // setScan 只能一次。
        let touched = s.apply(&op(scan_op())).unwrap();
        assert!(touched.scan);
        assert!(s.apply(&op(scan_op())).is_err());
        // clearRebuilt 删掉重建层的全部物件，扩展层不动。
        let touched = s.apply(&op(json!({"op":"clearRebuilt"}))).unwrap();
        assert!(touched.rebuilt_layer);
        assert_eq!(
            touched.entities.iter().collect::<Vec<_>>(),
            ["rb.wall-01", "wall-01"]
        );
        assert_eq!(s.entities.keys().collect::<Vec<_>>(), ["lamp"]);
        assert!(touched.to_model().rebuilt_layer && !touched.to_model().scan);
        // 扩展草稿不能用 setScan、clearRebuilt。
        let mut ext_state = WorkingState::default();
        assert!(matches!(
            ext_state.apply(&op(json!({"op":"clearRebuilt"}))),
            Err(OpError::NotAllowed { .. })
        ));
        assert!(matches!(
            ext_state.apply(&op(scan_op())),
            Err(OpError::NotAllowed { .. })
        ));
    }

    #[test]
    fn scan_spec_rules() {
        let mut s = WorkingState::with_kind(ScopeKind::Rebuild);
        let with = |path: &str, value: serde_json::Value| {
            let mut scan = scan_op();
            let target = path.split('.').fold(&mut scan, |node, key| &mut node[key]);
            *target = value;
            scan
        };
        for bad in [
            with("scan.assetHash", json!("A".repeat(64))),
            with("scan.webModelHashes", json!([])),
            with(
                "scan.webModelHashes",
                json!(["b".repeat(64), "b".repeat(64)]),
            ),
            with(
                "scan.webModelHashes",
                json!(["b".repeat(64), "c".repeat(64), "d".repeat(64)]),
            ),
            with(
                "scan.transform",
                json!([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            ),
            with(
                "scan.alignment",
                json!({"note": "x".repeat(crate::model::MAX_ALIGNMENT_BYTES)}),
            ),
        ] {
            assert!(s.apply(&op(bad.clone())).is_err(), "{bad}");
        }
        // 解析阶段就拒绝的写法。
        for bad in [
            with("scan.alignment", json!([1])),
            with("scan.transform", json!([1, 0, 0])),
            with("observedAt", json!("昨天")),
            with("scan.extra", json!(1)),
        ] {
            assert!(serde_json::from_value::<Op>(bad.clone()).is_err(), "{bad}");
        }
        s.apply(&op(scan_op())).unwrap();
        let scan = s.scan.as_ref().unwrap();
        assert_eq!(
            scan.scan.to_scan_ref().alignment.unwrap()["method"],
            "given"
        );
        assert_eq!(
            scan.observed_at.unwrap().to_rfc3339(),
            "2026-10-20T00:00:00.000Z"
        );
    }

    #[test]
    fn if_present_and_if_new() {
        let mut s = WorkingState::default();
        s.anchor_history.insert("gone".into());
        s.anchors.insert(
            "t1".into(),
            serde_json::from_value(
                json!({"anchorId":"t1","kind":"table","box":[0,0,0,1,1,1],"visibility":"public"}),
            )
            .unwrap(),
        );
        let missing = op(json!({"op":"removeEntity","entityId":"ghost","ifPresent":true}));
        assert_eq!(s.footprint(&missing).unwrap(), Footprint::none());
        assert_eq!(s.apply(&missing).unwrap(), TouchedSet::default());
        let anchor = |id: &str| {
            op(json!({"op":"createAnchor","ifNew":true,
                "anchor":{"anchorId":id,"kind":"table","box":[5,0,5,6,1,6],"visibility":"public"}}))
        };
        // 现在就有、曾经有过：跳过，不算碰过，影响范围为空。
        for (id, reason) in [("t1", AnchorSkip::Exists), ("gone", AnchorSkip::Existed)] {
            assert_eq!(s.footprint(&anchor(id)).unwrap(), Footprint::none());
            let touched = s.apply(&anchor(id)).unwrap();
            assert!(touched.anchors.is_empty());
            assert_eq!(touched.skipped_anchors.get(id), Some(&reason));
        }
        // 从没出现过：新建。
        let touched = s.apply(&anchor("t2")).unwrap();
        assert!(touched.anchors.contains("t2"));
        // 不带 ifNew 时与原来相同。
        assert!(s
            .apply(&op(json!({"op":"createAnchor",
                "anchor":{"anchorId":"t2","kind":"table","box":[5,0,5,6,1,6],"visibility":"public"}})))
            .is_err());
    }

    #[test]
    fn id_partition_and_same_layer_templates() {
        let mut s = WorkingState::default();
        let ext_box = |id: &str| {
            let mut body = rebuilt_box(id);
            body["layer"] = json!("ext");
            body
        };
        assert!(s
            .apply(&op(
                json!({"op":"placeEntity","entity": ext_box("rb.lamp")})
            ))
            .is_err());
        // 已有的扩展层旧编号照常可以改。
        let legacy: EntityBody = serde_json::from_value(ext_box("rb.legacy")).unwrap();
        s.entities.insert(legacy.entity_id.clone(), legacy);
        s.apply(&op(
            json!({"op":"placeEntity","entity": ext_box("rb.legacy")}),
        ))
        .unwrap();
        // 扩展层的物件不能引用重建层的模板。
        let template: EntityBody = serde_json::from_value(json!({"entityId":"rb.chair","layer":"rebuilt","kind":"template",
            "shape":{"type":"box","size":[0.5,0.9,0.5]},"bounds":{"min":[-0.25,0,-0.25],"max":[0.25,0.9,0.25]}}))
        .unwrap();
        s.entities.insert(template.entity_id.clone(), template);
        let user = json!({"op":"placeEntity","entity":{"entityId":"chair-1","layer":"ext","kind":"object",
            "shape":{"type":"instance","template":"rb.chair","transform":{"position":[1,0,1]}},
            "bounds":{"min":[0.75,0,0.75],"max":[1.25,0.9,1.25]}}});
        assert!(s.apply(&op(user.clone())).is_err());
        // 重建层的模板影响范围只算重建层的使用者；跨层的旧引用由完整性检查报出来。
        let mut legacy_user: EntityBody = serde_json::from_value(user["entity"].clone()).unwrap();
        legacy_user.entity_id = "chair-legacy".into();
        s.entities
            .insert(legacy_user.entity_id.clone(), legacy_user);
        assert_eq!(
            s.broken_template_refs(),
            [("chair-legacy".to_owned(), "rb.chair".to_owned())]
        );
        let mut rebuild = WorkingState {
            kind: ScopeKind::Rebuild,
            entities: s.entities.clone(),
            ..WorkingState::default()
        };
        let removal = op(json!({"op":"removeEntity","entityId":"rb.chair"}));
        assert_eq!(rebuild.footprint(&removal).unwrap(), Footprint::none());
        rebuild.apply(&removal).unwrap();
    }
}
