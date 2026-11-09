//! 高层操作（设计 8.3）、作用到工作状态、影响范围。
//!
//! 批量操作只用高层操作：填充、空心盒、替换、复制区域、新增方块、放物件、
//! 新建/移动/修改锚点。每批不超过 200 条。
//!
//! 操作只能写扩展层：重建层由处理服务的任务写入（设计 6）。方块操作里 `0` 表示
//! "不覆盖"（清掉扩展层在这一格的内容），`1` 表示"空气覆盖"（删掉下层的方块）。
//!
//! 每个操作先算影响范围（[`Footprint`]），由 [`crate::scope::AllowedArea`] 判断是否
//! 落在路径范围内，再作用到 [`WorkingState`]。[`WorkingState::apply_in_scope`] 把这两步
//! 合在一起，任何一条失败时状态保持不变。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::chunk::{locate_cell, Chunk, ChunkKey, BLOCK_AIR, BLOCK_EMPTY, CHUNK_SIZE};
use crate::grid::GridBox;
use crate::ids::{is_object_id, SPACE_ANCHOR_ID};
use crate::is_sha256_hex;
use crate::model::{ChunkChange, DataVisibility, Layer, Touched};
use crate::record::{AnchorBody, AnchorFootprint, AnchorKind, EntityBody, EntityKind, RecordError};
use crate::scope::{AllowedArea, ScopeError};
use crate::shape::Shape;

/// 每批操作的条数上限。
pub const MAX_OPS_PER_BATCH: usize = 200;
/// 单个方块操作涉及的格子数上限（约 128 个区块）。
pub const MAX_OP_CELLS: u128 = 1 << 22;
/// 空心盒壁厚上限（格）。
pub const MAX_HOLLOW_THICKNESS: u32 = 64;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpError {
    #[error("第 {index} 条操作：{message}")]
    Invalid { index: usize, message: String },
    #[error("第 {index} 条操作：{source}")]
    Scope { index: usize, source: ScopeError },
    #[error("一批最多 200 条操作")]
    TooManyOps,
}

fn invalid(message: impl Into<String>) -> OpError {
    OpError::Invalid {
        index: 0,
        message: message.into(),
    }
}

fn at_index(error: OpError, index: usize) -> OpError {
    match error {
        OpError::Invalid { message, .. } => OpError::Invalid { index, message },
        OpError::Scope { source, .. } => OpError::Scope { index, source },
        other => other,
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
    /// 放物件（新建或替换同编号的扩展层物件）。
    PlaceEntity {
        entity: Box<EntityBody>,
    },
    RemoveEntity {
        entity_id: String,
    },
    CreateAnchor {
        anchor: AnchorBody,
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

/// 一批操作碰过的键。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TouchedSet {
    pub chunks: BTreeSet<ChunkKey>,
    pub entities: BTreeSet<String>,
    pub anchors: BTreeSet<String>,
    pub palette: bool,
}

impl TouchedSet {
    pub fn merge(&mut self, other: TouchedSet) {
        self.chunks.extend(other.chunks);
        self.entities.extend(other.entities);
        self.anchors.extend(other.anchors);
        self.palette |= other.palette;
    }

    pub fn to_model(&self) -> Touched {
        Touched {
            chunks: self.chunks.iter().copied().collect(),
            entities: self.entities.iter().cloned().collect(),
            anchors: self.anchors.iter().cloned().collect(),
            regions: false,
            plots: false,
            palette: self.palette,
        }
    }
}

/// 操作作用的对象：区块、物件、锚点、方块表的当前内容。
#[derive(Debug, Clone, Default)]
pub struct WorkingState {
    pub chunks: BTreeMap<ChunkKey, Chunk>,
    pub entities: BTreeMap<String, EntityBody>,
    pub anchors: BTreeMap<String, AnchorBody>,
    pub palette: Vec<PaletteBlock>,
    /// 草稿里新增的方块：临时名称 → (临时编号, 定义)。
    pub provisional_blocks: BTreeMap<String, (u16, BlockDef)>,
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

    /// 空间里的模板（`kind: "template"` 的物件）。
    pub fn templates(&self) -> BTreeMap<String, Shape> {
        self.entities
            .values()
            .filter(|entity| entity.kind == EntityKind::Template)
            .filter_map(|entity| {
                entity
                    .shape
                    .clone()
                    .map(|shape| (entity.entity_id.clone(), shape))
            })
            .collect()
    }

    /// 直接或间接引用了某个模板的物件（不含模板自己）。
    fn users_of_template(&self, template: &str) -> Vec<&EntityBody> {
        let mut affected: BTreeSet<String> = BTreeSet::from([template.to_owned()]);
        loop {
            let before = affected.len();
            for entity in self.entities.values() {
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
                entity.entity_id != template
                    && affected.contains(&entity.entity_id)
                    && entity.kind != EntityKind::Template
            })
            .collect()
    }

    fn entity_footprint(&self, entity: &EntityBody) -> Result<Vec<GridBox>, OpError> {
        if entity.kind == EntityKind::Template {
            // 模板没有世界坐标；改模板等于改所有用到它的物件。
            return self
                .users_of_template(&entity.entity_id)
                .into_iter()
                .map(|user| user.footprint().map_err(OpError::from))
                .collect();
        }
        Ok(vec![entity.footprint()?])
    }

    fn existing_ext_entity(&self, id: &str) -> Result<Option<&EntityBody>, OpError> {
        match self.entities.get(id) {
            Some(entity) if entity.layer != Layer::Ext => {
                Err(invalid(format!("物件 {id} 属于重建层，只能由任务修改")))
            }
            other => Ok(other),
        }
    }

    fn existing_anchor(&self, id: &str) -> Result<&AnchorBody, OpError> {
        self.anchors
            .get(id)
            .ok_or_else(|| invalid(format!("锚点 {id} 不存在")))
    }

    /// 操作的影响范围（按操作之前的状态计算）。
    pub fn footprint(&self, op: &Op) -> Result<Footprint, OpError> {
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
            Op::AddBlock { .. } => {}
            Op::PlaceEntity { entity } => {
                footprint.cells.extend(self.entity_footprint(entity)?);
                if let Some(old) = self.existing_ext_entity(&entity.entity_id)? {
                    footprint.cells.extend(self.entity_footprint(old)?);
                }
            }
            Op::RemoveEntity { entity_id } => {
                let old = self
                    .existing_ext_entity(entity_id)?
                    .ok_or_else(|| invalid(format!("物件 {entity_id} 不存在")))?;
                footprint.cells.extend(self.entity_footprint(old)?);
            }
            Op::CreateAnchor { anchor } => footprint.add_anchor(anchor.footprint()?),
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

    /// 作用一条操作（不检查路径范围）。
    pub fn apply(&mut self, op: &Op) -> Result<TouchedSet, OpError> {
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
                if entity.layer != Layer::Ext {
                    return Err(invalid("操作只能放扩展层的物件"));
                }
                self.existing_ext_entity(&entity.entity_id)?;
                let mut templates = self.templates();
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
            Op::RemoveEntity { entity_id } => {
                if self.existing_ext_entity(entity_id)?.is_none() {
                    return Err(invalid(format!("物件 {entity_id} 不存在")));
                }
                let template_users = self.users_of_template(entity_id);
                if !template_users.is_empty() {
                    return Err(invalid(format!("模板 {entity_id} 仍被物件使用")));
                }
                self.entities.remove(entity_id);
                touched.entities.insert(entity_id.clone());
            }
            Op::CreateAnchor { anchor } => {
                anchor.validate()?;
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
            let footprint = next.footprint(op).map_err(|e| at_index(e, index))?;
            area.check(&footprint)
                .map_err(|source| OpError::Scope { index, source })?;
            touched.merge(next.apply(op).map_err(|e| at_index(e, index))?);
        }
        *self = next;
        Ok(touched)
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
    use crate::scope::PathScope;
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
    }
}
