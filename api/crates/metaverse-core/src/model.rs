//! 数据模型（设计第 4、5 节和 6.4）。
//!
//! 字段名与 MongoDB 文档、接口 JSON 一致（小驼峰，`_id` 为主键）。时间一律是
//! [`Timestamp`]（RFC 3339 字符串）。这里只描述形状，不涉及存取；存取在接口服务
//! 的 `repo/` 里，并且必须带授权凭据。
//!
//! 这里的类型都是**存储文档**，反序列化时容忍未知字段：滚动更新时新旧副本同时运行，
//! 迁移按"先扩后收"进行（设计 13.1），旧副本必须能读新副本写入的文档。
//! 调用方提交的内容（形状、操作、物件和锚点记录）则拒绝未知字段，见各自的模块。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::grid::GridBox;
use crate::ids::{is_object_id, is_subject_id};
use crate::scope::PathScope;
use crate::Timestamp;

// ---------------------------------------------------------------------------
// 主人（设计 9.2）
// ---------------------------------------------------------------------------

/// 主人类型：显式记录，不能从编号去猜它是不是组织。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OwnerKind {
    Person,
    Org,
}

/// 资源归哪个 NyxID 主体。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Owner {
    pub kind: OwnerKind,
    pub id: String,
}

impl Owner {
    pub fn person(id: impl Into<String>) -> Self {
        Self {
            kind: OwnerKind::Person,
            id: id.into(),
        }
    }

    pub fn org(id: impl Into<String>) -> Self {
        Self {
            kind: OwnerKind::Org,
            id: id.into(),
        }
    }

    pub fn is_valid(&self) -> bool {
        is_subject_id(&self.id)
    }
}

/// 组织空间创建时的核验依据。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceBasis {
    /// 调用者就是组织本身（组织的 agent key，令牌 sub 等于组织编号）。
    OrgSubject,
    /// 调用者经 NyxID 组织授权接口确认是该组织的 admin。
    OrgAdmin,
}

/// 组织归属证据（与 CMA `OrganizationOwnershipEvidence` 对应），创建后只读。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerEvidence {
    /// NyxID 签发方。
    pub issuer: String,
    pub org_id: String,
    /// 核验时的调用者 sub。
    pub verified_by: String,
    pub verified_at: Timestamp,
    pub basis: EvidenceBasis,
    /// 核验时查到的角色；`basis = org_subject` 时为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_at_verification: Option<OrgRole>,
}

/// NyxID 组织角色。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrgRole {
    Admin,
    Member,
    Viewer,
}

// ---------------------------------------------------------------------------
// 空间（设计 4.1）
// ---------------------------------------------------------------------------

/// 空间和组合的可见性。第一步只用 `unlisted`（凭分享令牌）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
    #[default]
    Unlisted,
    Public,
}

/// 分享令牌记录：库里只存哈希。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareTokenRecord {
    pub id: String,
    /// `sha256(令牌原文)` 的小写十六进制。
    pub hash: String,
    pub created_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<Timestamp>,
}

/// 坐标系：首次导入扫描时固定，之后不变。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub fixed_at: Timestamp,
    pub reference_scan: String,
}

/// 时间线最新位置。新空间的 `seq` 是 0，第一次提交是 1。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    pub seq: u64,
    pub at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_id: Option<String>,
}

/// 区域类型：实体区（扫描生成）或虚拟区（扩展）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RegionKind {
    Physical,
    Virtual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub id: String,
    pub kind: RegionKind,
    pub boxes: Vec<GridBox>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// 虚拟区内划出的一块范围，可以单独授权（经 NyxID 操作范围按 `plot_id` 限制）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plot {
    pub id: String,
    pub region_id: String,
    pub boxes: Vec<GridBox>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// 区域和地块的整体校验：编号唯一、地块落在所属的虚拟区内。
pub fn validate_layout(regions: &[Region], plots: &[Plot]) -> Result<(), String> {
    let mut region_ids = BTreeMap::new();
    for region in regions {
        if !is_object_id(&region.id) || region.boxes.is_empty() || region.boxes.len() > 64 {
            return Err(format!("区域 {} 的编号或盒子数不合法", region.id));
        }
        if region_ids.insert(region.id.as_str(), region).is_some() {
            return Err(format!("区域编号重复：{}", region.id));
        }
    }
    let mut plot_ids = BTreeMap::new();
    for plot in plots {
        if !is_object_id(&plot.id) || plot.boxes.is_empty() || plot.boxes.len() > 64 {
            return Err(format!("地块 {} 的编号或盒子数不合法", plot.id));
        }
        if plot_ids.insert(plot.id.as_str(), ()).is_some() {
            return Err(format!("地块编号重复：{}", plot.id));
        }
        let region = region_ids
            .get(plot.region_id.as_str())
            .ok_or_else(|| format!("地块 {} 所属的区域不存在", plot.id))?;
        if region.kind != RegionKind::Virtual {
            return Err(format!("地块 {} 必须划在虚拟区内", plot.id));
        }
        if !plot
            .boxes
            .iter()
            .all(|b| crate::grid::covered_by(b, &region.boxes))
        {
            return Err(format!("地块 {} 超出了所属区域", plot.id));
        }
    }
    Ok(())
}

/// 空间文档（`spaces` 集合）。`regions`、`plots` 只是 head 的读缓存，历史在提交里。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    #[serde(rename = "_id")]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub owner: Owner,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_evidence: Option<OwnerEvidence>,
    pub visibility: Visibility,
    #[serde(default)]
    pub share_tokens: Vec<ShareTokenRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<Frame>,
    pub head: Head,
    #[serde(default)]
    pub regions: Vec<Region>,
    #[serde(default)]
    pub plots: Vec<Plot>,
    pub storage_limit_bytes: u64,
    #[serde(default)]
    pub storage_used_bytes: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Space {
    /// 主人与证据的一致性（CMA `ResourcePolicyRecord::validate` 的规则）：
    /// 组织空间必须带同一组织的证据；个人空间不能带证据。
    pub fn ownership_is_consistent(&self) -> bool {
        match (&self.owner.kind, &self.owner_evidence) {
            (OwnerKind::Person, None) => self.owner.is_valid(),
            (OwnerKind::Org, Some(evidence)) => {
                self.owner.is_valid()
                    && evidence.org_id == self.owner.id
                    && !evidence.issuer.trim().is_empty()
                    && is_subject_id(&evidence.verified_by)
                    && match evidence.basis {
                        EvidenceBasis::OrgSubject => {
                            evidence.verified_by == evidence.org_id
                                && evidence.role_at_verification.is_none()
                        }
                        EvidenceBasis::OrgAdmin => {
                            evidence.role_at_verification == Some(OrgRole::Admin)
                        }
                    }
            }
            _ => false,
        }
    }
}

// ---------------------------------------------------------------------------
// 图层与变化记录（设计 4.2、4.4、5.2）
// ---------------------------------------------------------------------------

/// 图层。扫描层只有资源和对齐变换，没有区块和物件，所以这里只有两个值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Layer {
    /// 重建层：AI 按扫描轮廓重建，只由任务写入。
    Rebuilt,
    /// 扩展层：人和 AI 的修改，优先于重建层。
    Ext,
}

/// 区块变化；`hash = null` 表示删除这个区块。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ChunkChange {
    pub layer: Layer,
    pub cx: i32,
    pub cy: i32,
    pub cz: i32,
    pub hash: Option<String>,
}

/// 物件或锚点的变化；`hash = null` 表示删除。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct IdChange {
    pub id: String,
    pub hash: Option<String>,
}

/// 由路径推断出的操作人类别（公开接口只返回这一项）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    /// 管理接口（建空间、定义区域等）。
    Admin,
    /// 实体区路径。
    Physical,
    /// 地块路径。
    Plot,
    /// 数据源路径。
    Source,
    /// 处理服务的任务。
    Job,
}

/// 发布者（设计 5.2、9.5）。NyxID 在令牌里补上 agent key 编号后增加 `agentKeyId`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub sub: String,
    pub nyx_service_id: String,
    pub scope: PathScope,
    pub kind: ActorKind,
}

/// 草稿创建者（与发布者不同时记录）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Author {
    pub sub: String,
}

/// 提交里的扫描信息。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRef {
    pub asset_hash: String,
    #[serde(default)]
    pub web_model_hashes: Vec<String>,
    /// 4×4 列主序变换矩阵（扫描坐标 → 空间坐标）。
    pub transform: [f64; 16],
}

/// 提交（设计 5.2）。`at` 由服务端赋值 = max(当前时间, head.at)，随 seq 单调不减。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    #[serde(rename = "_id")]
    pub id: String,
    pub space_id: String,
    /// 空间主人的副本，写入时校验与空间一致（CMA lineage 规则）。
    pub owner: Owner,
    pub seq: u64,
    pub at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<Timestamp>,
    pub actor: Actor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<Author>,
    pub message: String,
    /// 内联的操作（约 1MB 以内）；超出时存成资源，只放 `opsRef`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ops: Option<Vec<crate::ops::Op>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ops_ref: Option<String>,
    #[serde(default)]
    pub changed_chunks: Vec<ChunkChange>,
    #[serde(default)]
    pub changed_entities: Vec<IdChange>,
    #[serde(default)]
    pub changed_anchors: Vec<IdChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regions_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scan: Option<ScanRef>,
    /// 每 50 次提交存一份完整状态清单的哈希。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyframe: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script_ref: Option<String>,
}

/// 每隔多少次提交存一个关键帧。
pub const KEYFRAME_INTERVAL: u64 = 50;

/// 新提交的 `at`：max(当前时间, head.at)。调用方不能指定。
pub fn next_commit_at(now: Timestamp, head_at: Timestamp) -> Timestamp {
    now.max(head_at)
}

// ---------------------------------------------------------------------------
// 现实事件（设计 5.3、5.4）
// ---------------------------------------------------------------------------

/// 事件和锚点的可见级别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataVisibility {
    Public,
    Internal,
}

/// 事件（`events` 集合）。更正也是一条事件，`corrects` 指向最初那条事件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    #[serde(rename = "_id")]
    pub id: String,
    pub space_id: String,
    pub owner: Owner,
    /// 现实发生时间（可以晚到）。
    pub at: Timestamp,
    /// 服务端记录时间。
    pub recorded_at: Timestamp,
    /// 来自路径 `/sources/{source}`，请求体里不能另填。
    pub source: String,
    pub source_event_id: String,
    /// 撤回时为空。
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<DataVisibility>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corrects: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub retracted: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub redacted: bool,
    /// 写入者（设计 9.5）：调用者 sub、服务编号、路径范围 `source:<名称>`。公开接口不返回。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<Actor>,
}

/// 事件编号：由 `(spaceId, source, sourceEventId)` 确定，同一条事件重试时编号不变。
/// `ev_` + `sha256(spaceId ‖ 0x00 ‖ source ‖ 0x00 ‖ sourceEventId)` 的前 32 位十六进制。
pub fn event_id(space_id: &str, source: &str, source_event_id: &str) -> String {
    let digest = crate::sha256_hex(format!("{space_id}\0{source}\0{source_event_id}").as_bytes());
    format!("ev_{}", &digest[..32])
}

/// 状态类事件的定期快照（`stateSnapshots` 集合，设计 5.5）：某时刻各 (锚点, 状态 key) 的
/// **公开**状态（只由公开事件算出，值已按公开字段投影）。
///
/// `computedAt` 之后记录的、`at ≤ 快照时刻` 的事件（晚到事件、更正）会让快照失效，
/// 读取时检查；抹除事件内容时删除受影响的快照。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    #[serde(rename = "_id")]
    pub id: String,
    pub space_id: String,
    pub owner: Owner,
    /// 快照时刻：包含全部 `at ≤ 这个时刻` 的事件。
    pub at: Timestamp,
    /// 计算时考虑到的最晚记录时间。
    pub computed_at: Timestamp,
    #[serde(default)]
    pub states: Vec<SnapshotState>,
}

/// 快照里的一项状态。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotState {
    pub anchor_id: String,
    pub key: String,
    pub value: Value,
    /// 决定这个状态的事件的 `at`。
    pub since: Timestamp,
    pub event_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub type_version: u32,
    /// 决定这个状态的事件的公开字段（按 publicFields 投影；被抹除时为空），网站的标签模板用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// 状态类事件的规则：从此刻起该锚点处于某状态，直到同一 key 的下一条。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateRule {
    pub key: String,
    /// 状态值取自事件 `data` 的哪个字段（点分路径）；不填就用事件类型名。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// 这类事件表示状态结束（例如"离座"）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub clears: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DisplayKind {
    Highlight,
    Icon,
    Label,
    Path,
    SpawnEntity,
    Heat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PathRole {
    Origin,
    Destination,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatSpec {
    pub window_sec: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
}

/// 显示规则：网站只实现这几种显示方式。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub kind: DisplayKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<[u8; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<u32>,
    /// 只能引用公开字段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity_asset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_role: Option<PathRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heat: Option<HeatSpec>,
}

/// 事件类型（`eventTypes` 集合），只追加的版本记录。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventType {
    pub space_id: String,
    #[serde(rename = "type")]
    pub name: String,
    pub version: u32,
    /// JSON Schema。
    pub schema: Value,
    /// 公开接口只返回这些字段（点分路径）。
    #[serde(default)]
    pub public_fields: Vec<String>,
    pub default_visibility: DataVisibility,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<StateRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_age_sec: Option<u32>,
    pub display: Display,
}

// ---------------------------------------------------------------------------
// 草稿（设计 5.6）
// ---------------------------------------------------------------------------

/// 草稿碰过的键，发布时和 (baseSeq, head] 的变化求交集判断冲突。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Touched {
    #[serde(default)]
    pub chunks: Vec<crate::chunk::ChunkKey>,
    #[serde(default)]
    pub entities: Vec<String>,
    #[serde(default)]
    pub anchors: Vec<String>,
    #[serde(default)]
    pub regions: bool,
    #[serde(default)]
    pub plots: bool,
    #[serde(default)]
    pub palette: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftChunk {
    pub layer: Layer,
    pub cx: i32,
    pub cy: i32,
    pub cz: i32,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    #[serde(rename = "_id")]
    pub id: String,
    pub space_id: String,
    pub owner: Owner,
    pub scope: PathScope,
    pub base_seq: u64,
    pub rev: u64,
    pub created_by: Author,
    #[serde(default)]
    pub ops: Vec<crate::ops::Op>,
    #[serde(default)]
    pub touched: Touched,
    #[serde(default)]
    pub result_chunks: Vec<DraftChunk>,
    /// 30 天过期。
    pub expires_at: Timestamp,
}

/// 草稿保留时间。
pub const DRAFT_TTL_SECONDS: i64 = 30 * 24 * 3600;

// ---------------------------------------------------------------------------
// 组合宇宙（设计 4.5）
// ---------------------------------------------------------------------------

/// 成员空间绕 y 轴的旋转，只能是 0/90/180/270。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u16", into = "u16")]
pub enum Rotation {
    R0,
    R90,
    R180,
    R270,
}

impl TryFrom<u16> for Rotation {
    type Error = String;
    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Rotation::R0),
            90 => Ok(Rotation::R90),
            180 => Ok(Rotation::R180),
            270 => Ok(Rotation::R270),
            other => Err(format!("旋转只能是 0、90、180、270，收到 {other}")),
        }
    }
}

impl From<Rotation> for u16 {
    fn from(value: Rotation) -> Self {
        match value {
            Rotation::R0 => 0,
            Rotation::R90 => 90,
            Rotation::R180 => 180,
            Rotation::R270 => 270,
        }
    }
}

impl Rotation {
    /// 先绕成员空间原点旋转，再平移 `offset`（格）。
    pub fn place(self, cell: [i64; 3], offset: [i64; 3]) -> [i64; 3] {
        let [x, y, z] = cell;
        // 与形状变换的偏航方向一致：x' = x cos + z sin，z' = −x sin + z cos。
        let (x, z) = match self {
            Rotation::R0 => (x, z),
            Rotation::R90 => (z, -x),
            Rotation::R180 => (-x, -z),
            Rotation::R270 => (-z, x),
        };
        [x + offset[0], y + offset[1], z + offset[2]]
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniverseMember {
    pub space_id: String,
    pub offset: [i64; 3],
    pub rotation: Rotation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorRef {
    pub space_id: String,
    pub anchor_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Door,
    Portal,
    Street,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UniverseLink {
    pub from: AnchorRef,
    pub to: AnchorRef,
    pub kind: LinkKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct UniverseState {
    #[serde(default)]
    pub members: Vec<UniverseMember>,
    #[serde(default)]
    pub links: Vec<UniverseLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniverseHead {
    pub seq: u64,
    pub at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Universe {
    #[serde(rename = "_id")]
    pub id: String,
    pub name: String,
    pub owner: Owner,
    pub visibility: Visibility,
    #[serde(default)]
    pub share_tokens: Vec<ShareTokenRecord>,
    pub head: UniverseHead,
    #[serde(default)]
    pub members: Vec<UniverseMember>,
    #[serde(default)]
    pub links: Vec<UniverseLink>,
    pub created_at: Timestamp,
    /// 组织主人的归属证据（规则与空间相同，设计 9.2）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_evidence: Option<OwnerEvidence>,
    /// 组合主人邀请加入的空间：被邀请空间的主人调用加入接口时不需要组合的管理权限。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub invitations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<Timestamp>,
}

/// 每次修订都存完整的新状态。`_id` = `<组合编号>:<seq>`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniverseRevision {
    pub universe_id: String,
    pub seq: u64,
    pub at: Timestamp,
    pub actor: Actor,
    pub message: String,
    pub state: UniverseState,
    /// 组合主人的副本（子集合冗余主人字段，设计 9.4）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<Owner>,
}

// ---------------------------------------------------------------------------
// 任务（设计 6.4）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    UploadVerify,
    ScanImport,
    Align,
    Rebuild,
    Voxelize,
    WebModel,
    ModelImport,
    OpsFromUpload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    #[serde(rename = "_id")]
    pub id: String,
    pub space_id: String,
    pub owner: Owner,
    pub kind: JobKind,
    #[serde(default)]
    pub params: Value,
    pub status: JobStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_until: Option<Timestamp>,
    pub attempt: u32,
    pub max_attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_commit_id: Option<String>,
    pub created_at: Timestamp,
    /// 发起者（处理服务写提交时用作提交的 sub 和服务编号）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<RequestActor>,
    /// 发起任务的路径范围（`physical` 或 `plot:<编号>`），经地块路径只能查到本地块的任务。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<PathScope>,
    /// 任务的非提交结果（任意 JSON），例如 `{needsAlignment, proposedTransform, errorCm}`、`{modelHash}`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// 运行中的进度（任意 JSON，由执行任务的一方写入），例如 `ops_from_upload` 的
    /// `{opsApplied, opsTotal}`。接口原样返回（设计 6.4：任务进度可以经接口查询）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<Value>,
    /// 处理服务领取时写入。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Timestamp>,
    /// 完成或最终失败时写入。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<Timestamp>,
}

/// 发起请求的调用者（任务、上传会话记录这一项）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestActor {
    pub sub: String,
    pub nyx_service_id: String,
}

/// 默认重试次数。
pub const JOB_MAX_ATTEMPTS: u32 = 3;
/// 任务租约时长。
pub const JOB_LEASE_SECONDS: i64 = 180;

// ---------------------------------------------------------------------------
// 上传会话（设计 6.1）
// ---------------------------------------------------------------------------

/// 上传会话的状态（与处理服务 `store.py` 的 `UploadStatus` 相同）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UploadStatus {
    /// 接收分片中。
    Open,
    /// 调用方已"完成上传"，`upload_verify` 任务排队中。
    Complete,
    /// 校验通过，已登记成资源（`assetHash`）；哈希已存在时创建即为此状态（`reused`）。
    Done,
    /// 校验失败，分片已删除。
    Failed,
    /// 超过 24 小时没完成，清理中。
    Expired,
}

/// 上传时声明的文件格式（`declaredFormat`）。接口服务在收到第 0 片时按它核对文件头；
/// 处理服务校验时再嗅探一遍，把实际格式写进 `format`（`glb | draco | obj | zip | png | jpeg |
/// webp | ndjson | ndjson+gzip | text`）和 `contentType`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UploadFormat {
    Glb,
    /// Draco 网格（也接受名称 `draco`）。
    Drc,
    Obj,
    /// zip：里面一个 glb / drc / obj + 贴图（例如 Scaniverse 导出）。
    Zip,
    Png,
    Jpeg,
    Webp,
    /// 每行一个 JSON 对象（ops 用途）。
    Ndjson,
    /// gzip 压缩的 NDJSON（ops 用途）。
    Gzip,
    /// UTF-8 纯文本（script 用途）。
    Text,
}

impl UploadFormat {
    pub const ALL: [UploadFormat; 10] = [
        UploadFormat::Glb,
        UploadFormat::Drc,
        UploadFormat::Obj,
        UploadFormat::Zip,
        UploadFormat::Png,
        UploadFormat::Jpeg,
        UploadFormat::Webp,
        UploadFormat::Ndjson,
        UploadFormat::Gzip,
        UploadFormat::Text,
    ];

    pub fn name(self) -> &'static str {
        match self {
            UploadFormat::Glb => "glb",
            UploadFormat::Drc => "drc",
            UploadFormat::Obj => "obj",
            UploadFormat::Zip => "zip",
            UploadFormat::Png => "png",
            UploadFormat::Jpeg => "jpeg",
            UploadFormat::Webp => "webp",
            UploadFormat::Ndjson => "ndjson",
            UploadFormat::Gzip => "gzip",
            UploadFormat::Text => "text",
        }
    }

    /// 按名称找格式；也接受处理服务的叫法 `draco`、`ndjson+gzip`。
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "draco" => Some(UploadFormat::Drc),
            "ndjson+gzip" => Some(UploadFormat::Gzip),
            _ => Self::ALL.into_iter().find(|format| format.name() == name),
        }
    }

    /// 这种格式的 Content-Type（与处理服务 `processing/sniff.py` 的 `CONTENT_TYPES` 相同）。
    pub fn content_type(self) -> &'static str {
        match self {
            UploadFormat::Glb => "model/gltf-binary",
            UploadFormat::Drc => "application/x-draco",
            UploadFormat::Obj => "model/obj",
            UploadFormat::Zip => "application/zip",
            UploadFormat::Png => "image/png",
            UploadFormat::Jpeg => "image/jpeg",
            UploadFormat::Webp => "image/webp",
            UploadFormat::Ndjson => "application/x-ndjson",
            UploadFormat::Gzip => "application/gzip",
            UploadFormat::Text => "text/plain; charset=utf-8",
        }
    }
}

/// 已收到的一片。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadPart {
    pub size: u64,
    pub sha256: String,
}

/// 上传会话（`uploads` 集合）。`_id` 同时是 GridFS 数据块的 `files_id`；
/// 第 n 片（从 0 开始）切成 256KiB 的数据块，序号 = `n × (partSize / 256KiB) + i`。
///
/// 处理服务（`handlers/upload_verify.py`）读 `{_id, spaceId, owner, purpose, size, sha256, status}`，
/// 只处理 `status: complete` 的上传，回写 `status: done|failed`、`assetHash`、`format`、
/// `contentType`、`verifiedAt`、`verifiedSha256`、`error`、`failedAt`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    #[serde(rename = "_id")]
    pub id: String,
    pub space_id: String,
    pub owner: Owner,
    /// 创建时的路径范围：`physical` 或 `plot:<编号>`；之后的分片、完成、查询必须走同一路径。
    pub scope: PathScope,
    pub purpose: crate::scope::UploadPurpose,
    /// 调用方声明的格式。
    pub declared_format: UploadFormat,
    pub status: UploadStatus,
    /// 调用方声明的总字节数。
    pub size: u64,
    /// 调用方声明的整体 SHA-256（小写十六进制）。
    pub sha256: String,
    pub part_size: u64,
    pub part_count: u64,
    /// 已收到的分片，键是片号的十进制字符串。
    #[serde(default)]
    pub parts: BTreeMap<String, UploadPart>,
    /// 第 0 片的文件头已核对通过。
    #[serde(default)]
    pub header_checked: bool,
    pub actor: RequestActor,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<Timestamp>,
    /// "完成上传"时创建的 `upload_verify` 任务。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    /// 创建时哈希已存在，直接复用了已有资源，没有接收数据。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reused: bool,
    // ---- 以下由处理服务写入（复用时由接口服务写 assetHash） ----
    /// 校验通过后的资源哈希（等于 `sha256`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_hash: Option<String>,
    /// 处理服务嗅探出的实际格式。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_sha256: Option<String>,
    /// 校验失败的原因。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_at: Option<Timestamp>,
}

/// GridFS 数据块大小，固定 256KiB（与处理服务 `assets.py` 的 `ASSET_CHUNK_SIZE` 相同）。
pub const ASSET_CHUNK_SIZE: u64 = 256 * 1024;
/// 分片大小上限。
pub const MAX_UPLOAD_PART_SIZE: u64 = 32 * 1024 * 1024;
/// 没完成的上传保留时间（处理服务按 `createdAt` 清理）。
pub const UPLOAD_TTL_SECONDS: i64 = 24 * 3600;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ts(ms: i64) -> Timestamp {
        Timestamp::from_millis(ms).unwrap()
    }

    fn space(owner: Owner, evidence: Option<OwnerEvidence>) -> Space {
        Space {
            id: "front-hall".into(),
            name: "前厅".into(),
            description: String::new(),
            owner,
            owner_evidence: evidence,
            visibility: Visibility::Unlisted,
            share_tokens: vec![],
            frame: None,
            head: Head {
                seq: 0,
                at: ts(0),
                commit_id: None,
            },
            regions: vec![],
            plots: vec![],
            storage_limit_bytes: 1 << 30,
            storage_used_bytes: 0,
            created_at: ts(0),
            updated_at: ts(0),
        }
    }

    #[test]
    fn ownership_consistency_follows_cma_lineage_rules() {
        assert!(space(Owner::person("alice"), None).ownership_is_consistent());
        let evidence = OwnerEvidence {
            issuer: "https://nyx.example".into(),
            org_id: "org-1".into(),
            verified_by: "alice".into(),
            verified_at: ts(1),
            basis: EvidenceBasis::OrgAdmin,
            role_at_verification: Some(OrgRole::Admin),
        };
        assert!(space(Owner::org("org-1"), Some(evidence.clone())).ownership_is_consistent());
        assert!(!space(Owner::org("org-1"), None).ownership_is_consistent());
        assert!(!space(Owner::org("org-2"), Some(evidence.clone())).ownership_is_consistent());
        assert!(!space(Owner::person("alice"), Some(evidence.clone())).ownership_is_consistent());
        let mut member = evidence.clone();
        member.role_at_verification = Some(OrgRole::Member);
        assert!(!space(Owner::org("org-1"), Some(member)).ownership_is_consistent());
        let subject = OwnerEvidence {
            verified_by: "org-1".into(),
            basis: EvidenceBasis::OrgSubject,
            role_at_verification: None,
            ..evidence
        };
        assert!(space(Owner::org("org-1"), Some(subject)).ownership_is_consistent());
    }

    #[test]
    fn space_document_shape() {
        let value = serde_json::to_value(space(Owner::person("alice"), None)).unwrap();
        assert_eq!(value["_id"], "front-hall");
        assert_eq!(value["owner"], json!({"kind":"person","id":"alice"}));
        assert_eq!(
            value["head"],
            json!({"seq":0,"at":"1970-01-01T00:00:00.000Z"})
        );
        assert_eq!(value["visibility"], "unlisted");
        let back: Space = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(back.owner, Owner::person("alice"));
        // 新版本副本写入的字段，旧版本副本也能读（先扩后收）。
        let mut newer = value;
        newer["fieldFromNewerRelease"] = json!({"x": 1});
        newer["head"]["extra"] = json!(true);
        assert!(serde_json::from_value::<Space>(newer).is_ok());
    }

    #[test]
    fn layout_rules() {
        let region = |id: &str, kind, b: [i64; 6]| Region {
            id: id.into(),
            kind,
            boxes: vec![GridBox::from_array(b).unwrap()],
            name: None,
        };
        let regions = vec![
            region("hall", RegionKind::Physical, [0, 0, 0, 100, 60, 100]),
            region("garden", RegionKind::Virtual, [100, 0, 0, 200, 60, 100]),
        ];
        let plot = |id: &str, region_id: &str, b: [i64; 6]| Plot {
            id: id.into(),
            region_id: region_id.into(),
            boxes: vec![GridBox::from_array(b).unwrap()],
            name: None,
        };
        assert!(
            validate_layout(&regions, &[plot("p1", "garden", [100, 0, 0, 120, 20, 20])]).is_ok()
        );
        assert!(validate_layout(&regions, &[plot("p1", "hall", [0, 0, 0, 20, 20, 20])]).is_err());
        assert!(
            validate_layout(&regions, &[plot("p1", "garden", [90, 0, 0, 120, 20, 20])]).is_err()
        );
        assert!(
            validate_layout(&regions, &[plot("p1", "nope", [100, 0, 0, 120, 20, 20])]).is_err()
        );
    }

    #[test]
    fn rotation_places_cells() {
        assert_eq!(Rotation::R90.place([1, 2, 0], [10, 0, 0]), [10, 2, -1]);
        assert_eq!(Rotation::R180.place([1, 2, 3], [0, 0, 0]), [-1, 2, -3]);
        assert_eq!(serde_json::to_value(Rotation::R270).unwrap(), json!(270));
        assert!(serde_json::from_value::<Rotation>(json!(45)).is_err());
    }

    #[test]
    fn commit_at_is_monotonic() {
        assert_eq!(next_commit_at(ts(5), ts(10)), ts(10));
        assert_eq!(next_commit_at(ts(15), ts(10)), ts(15));
    }
}
