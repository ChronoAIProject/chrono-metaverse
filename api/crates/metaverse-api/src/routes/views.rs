//! 接口返回的视图。公开视图按设计 8.2 的数据投影规则：不返回用户编号、归属证据、
//! 分享令牌和配额信息，锚点只给公开级。

use metaverse_core::model::{OwnerEvidence, OwnerKind, Plot, Region, Space, Visibility};
use metaverse_core::record::AnchorBody;
use metaverse_core::Timestamp;
use serde::Serialize;
use utoipa::ToSchema;

/// 空间主人。
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct OwnerView {
    /// `person` 或 `org`。
    #[schema(value_type = String, example = "org")]
    pub kind: OwnerKind,
    /// NyxID 主体编号。
    pub id: String,
}

/// 时间线最新位置。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HeadView {
    /// 最新提交序号；新空间是 0。
    pub seq: u64,
    /// 最新提交时间（服务端赋值）。
    #[schema(value_type = String, format = DateTime)]
    pub at: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_id: Option<String>,
}

/// 空间信息（`/api/v1`，含内部级锚点）。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpaceView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub owner: OwnerView,
    /// 组织空间创建时的核验记录。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Object>)]
    pub owner_evidence: Option<OwnerEvidence>,
    /// `unlisted`（凭分享令牌）或 `public`。
    #[schema(value_type = String, example = "unlisted")]
    pub visibility: Visibility,
    pub head: HeadView,
    /// 区域：`{ id, kind: physical|virtual, boxes: [[x0,y0,z0,x1,y1,z1]], name? }`，单位是格。
    #[schema(value_type = Vec<Object>)]
    pub regions: Vec<Region>,
    /// 地块：`{ id, regionId, boxes, name? }`。
    #[schema(value_type = Vec<Object>)]
    pub plots: Vec<Plot>,
    /// 锚点当前状态（含内部级）。
    #[schema(value_type = Vec<Object>)]
    pub anchors: Vec<AnchorBody>,
    pub storage_limit_bytes: u64,
    pub storage_used_bytes: u64,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
}

impl SpaceView {
    pub fn new(space: Space, anchors: Vec<AnchorBody>) -> Self {
        Self {
            id: space.id,
            name: space.name,
            description: space.description,
            owner: OwnerView {
                kind: space.owner.kind,
                id: space.owner.id,
            },
            owner_evidence: space.owner_evidence,
            visibility: space.visibility,
            head: HeadView {
                seq: space.head.seq,
                at: space.head.at,
                commit_id: space.head.commit_id,
            },
            regions: space.regions,
            plots: space.plots,
            anchors,
            storage_limit_bytes: space.storage_limit_bytes,
            storage_used_bytes: space.storage_used_bytes,
            created_at: space.created_at,
            updated_at: space.updated_at,
        }
    }
}

/// 公开读接口的空间视图：名称、区域、地块、公开锚点。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicSpaceView {
    pub id: String,
    pub name: String,
    pub description: String,
    #[schema(value_type = String, example = "unlisted")]
    pub visibility: Visibility,
    pub head: HeadView,
    /// 区域（公开形状：`{id, kind, label?, boxes}`）。
    pub regions: Vec<crate::timeline::views::RegionView>,
    /// 地块（公开形状：`{id, regionId, label?, boxes}`）。
    pub plots: Vec<crate::timeline::views::PlotView>,
    /// 只含公开级锚点。
    #[schema(value_type = Vec<Object>)]
    pub anchors: Vec<AnchorBody>,
}

impl PublicSpaceView {
    pub fn new(space: Space, anchors: Vec<AnchorBody>) -> Self {
        Self {
            id: space.id,
            name: space.name,
            description: space.description,
            visibility: space.visibility,
            head: HeadView {
                seq: space.head.seq,
                at: space.head.at,
                commit_id: None,
            },
            regions: space.regions.into_iter().map(Into::into).collect(),
            plots: space.plots.into_iter().map(Into::into).collect(),
            anchors,
        }
    }
}
