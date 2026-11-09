//! 时间线相关的接口视图。公开视图的 JSON 形状按 `web/src/core/api/types.ts`
//! （`Snapshot`、`CommitSummary`、`Page`），`/api/v1` 的视图在此基础上多给内部信息。

use metaverse_core::grid::GridBox;
use metaverse_core::model::{
    Actor, Author, ChunkChange, IdChange, Layer, Plot, Region, RegionKind,
};
use metaverse_core::Timestamp;
use serde::Serialize;
use serde_json::Value;
use utoipa::ToSchema;

/// 区域（公开形状：`{id, kind, label?, boxes}`，盒子单位是格、半开区间）。
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RegionView {
    pub id: String,
    /// `physical`（实体区）或 `virtual`（虚拟区）。
    #[schema(value_type = String, example = "physical")]
    pub kind: RegionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `[[x0,y0,z0,x1,y1,z1], ...]`
    #[schema(value_type = Vec<Vec<i64>>)]
    pub boxes: Vec<GridBox>,
}

impl From<Region> for RegionView {
    fn from(region: Region) -> Self {
        Self {
            id: region.id,
            kind: region.kind,
            label: region.name,
            boxes: region.boxes,
        }
    }
}

/// 地块（公开形状：`{id, regionId, label?, boxes}`）。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlotView {
    pub id: String,
    pub region_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[schema(value_type = Vec<Vec<i64>>)]
    pub boxes: Vec<GridBox>,
}

impl From<Plot> for PlotView {
    fn from(plot: Plot) -> Self {
        Self {
            id: plot.id,
            region_id: plot.region_id,
            label: plot.name,
            boxes: plot.boxes,
        }
    }
}

/// 区块清单里的一项。
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ChunkRefView {
    /// `rebuilt`（重建层）或 `ext`（扩展层）。
    #[schema(value_type = String, example = "ext")]
    pub layer: Layer,
    pub cx: i32,
    pub cy: i32,
    pub cz: i32,
    /// 区块哈希：`GET /api/public/chunks/{hash}.bin`。
    pub hash: String,
}

/// 物件记录：`{id, hash, body}`，body 见 docs/SHAPES.md 第 3 节。
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EntityRecordView {
    pub id: String,
    pub hash: String,
    #[schema(value_type = Object)]
    pub body: Value,
}

/// 方块表。
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaletteView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// `[{id, name, kind, color?, texture?, tags}]`，编号从 2 开始。
    #[schema(value_type = Vec<Object>)]
    pub blocks: Value,
}

/// 扫描层：网页用模型的哈希和对齐变换（列主序 4×4，扫描坐标 → 空间坐标）。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScanView {
    /// `[0]` 默认版本，`[1]` 低细节版本。
    pub web_model_hashes: Vec<String>,
    pub transform: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<String>)]
    pub observed_at: Option<Timestamp>,
    /// 原始扫描资源（只在 `/api/v1` 返回）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_hash: Option<String>,
}

/// 某个版本的完整状态（快照）。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotView {
    pub space_id: String,
    pub seq: u64,
    #[schema(value_type = String)]
    pub at: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub palette_hash: Option<String>,
    pub palette: PaletteView,
    pub chunks: Vec<ChunkRefView>,
    pub entities: Vec<EntityRecordView>,
    /// 锚点：公开接口只含在该版本和当前都是公开级的锚点；`/api/v1` 含内部级。
    #[schema(value_type = Vec<Object>)]
    pub anchors: Vec<Value>,
    pub regions: Vec<RegionView>,
    pub plots: Vec<PlotView>,
    pub scan: Option<ScanView>,
}

/// 公开接口的操作人：只给类别。
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ActorKindView {
    /// `admin`、`physical`、`plot`、`source`、`job`。
    pub kind: String,
}

/// 提交列表的公开投影（设计 8.2）：不返回用户编号、操作内容和脚本。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummaryView {
    pub seq: u64,
    #[schema(value_type = String)]
    pub at: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<String>)]
    pub observed_at: Option<Timestamp>,
    pub message: String,
    pub actor: ActorKindView,
    /// `[{layer, cx, cy, cz, hash|null}]`，null 表示删除。
    #[schema(value_type = Vec<Object>)]
    pub changed_chunks: Vec<ChunkChange>,
    /// `[{id, hash|null}]`
    #[schema(value_type = Vec<Object>)]
    pub changed_entities: Vec<IdChange>,
    /// 按公开投影改写：内部锚点不出现，锚点由公开改为内部时记为删除。
    #[schema(value_type = Vec<Object>)]
    pub changed_anchors: Vec<IdChange>,
}

/// 提交（`/api/v1`，含发布者和追溯信息；不含内联的操作内容）。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommitView {
    pub id: String,
    pub seq: u64,
    #[schema(value_type = String)]
    pub at: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<String>)]
    pub observed_at: Option<Timestamp>,
    pub message: String,
    /// `{sub, nyxServiceId, scope, kind}`
    #[schema(value_type = Object)]
    pub actor: Actor,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Object>)]
    pub author: Option<Author>,
    #[schema(value_type = Vec<Object>)]
    pub changed_chunks: Vec<ChunkChange>,
    #[schema(value_type = Vec<Object>)]
    pub changed_entities: Vec<IdChange>,
    #[schema(value_type = Vec<Object>)]
    pub changed_anchors: Vec<IdChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regions_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub palette_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Object>)]
    pub scan: Option<metaverse_core::model::ScanRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyframe: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft_id: Option<String>,
    /// 操作存成资源时的哈希（内联的操作不在列表里返回）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ops_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script_ref: Option<String>,
}

impl From<metaverse_core::model::Commit> for CommitView {
    fn from(commit: metaverse_core::model::Commit) -> Self {
        Self {
            id: commit.id,
            seq: commit.seq,
            at: commit.at,
            observed_at: commit.observed_at,
            message: commit.message,
            actor: commit.actor,
            author: commit.author,
            changed_chunks: commit.changed_chunks,
            changed_entities: commit.changed_entities,
            changed_anchors: commit.changed_anchors,
            regions_hash: commit.regions_hash,
            palette_hash: commit.palette_hash,
            scan: commit.scan,
            keyframe: commit.keyframe,
            job_id: commit.job_id,
            draft_id: commit.draft_id,
            ops_ref: commit.ops_ref,
            script_ref: commit.script_ref,
        }
    }
}

/// 一页结果：`nextAfter` 是下一页的游标（最后一项的 seq），没有更多时为 null。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummaryPage {
    pub items: Vec<CommitSummaryView>,
    pub next_after: Option<String>,
}

/// 一页提交（`/api/v1`）。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommitPage {
    pub items: Vec<CommitView>,
    pub next_after: Option<String>,
}
