//! 事件查询（设计 5.3–5.5、8.2）：`/api/v1` 和 `/api/public` 共用。
//!
//! - **时间窗**（`from`、`to`，按 `at`）：取窗口里的原事件，再取指向它们的全部更正，
//!   先应用更正、再按可见级别过滤（公开读）——被替换掉的原版本永远不出现；
//! - **增量**（`since`，按 `recordedAt`）：取记录时间 ≥ since 的全部记录（原事件、更正），
//!   涉及的原事件连同全部版本一起重算；公开读时，之前公开过、现在被撤回或改成内部级的
//!   事件返回一条"撤下"标记（`withdrawn: true`）；
//! - **/head 的 recordedAt**：最新一条公开可见变化的记录时间（公开级的原事件或替换，以及
//!   撤下曾经公开的事件的更正）；
//! - **状态**：从最近的有效状态快照接着按 `at` 折叠公开事件（`ingest::state`），顺带保存
//!   新的快照（系统范围）。

use std::collections::{BTreeMap, BTreeSet};

use metaverse_core::events::{apply_corrections, public_events, EffectiveEvent};
use metaverse_core::ids::SPACE_ANCHOR_ID;
use metaverse_core::model::{DataVisibility, Event, EventType, SnapshotState, StateSnapshot};
use metaverse_core::Timestamp;
use serde::Serialize;
use serde_json::Value;
use utoipa::ToSchema;

use crate::auth::{Authorizer, Grant};
use crate::error::ApiError;
use crate::ingest::state::StateFold;
use crate::repo::{Cursor, Lower};
use crate::AppState;

/// 公开读每页最多多少条（设计 8.2）。
pub const PUBLIC_PAGE_LIMIT: i64 = 5000;
/// 时间窗最长 24 小时。
pub const MAX_WINDOW_MS: i64 = 24 * 3600 * 1000;
/// 一页最多读进内存的记录数（原事件 + 指向它们的更正）。更正和同一时刻的事件都没有总量配额，
/// 读取必须有上限：超过时本页提前结束（下一页从这里接着），单条原事件的更正就超过上限时 503。
pub const MAX_PAGE_RECORDS: u64 = 20_000;
/// 状态计算每批读多少条记录。
const STATE_BATCH: i64 = 5000;
/// 状态计算时同一时刻的记录最多读多少条（同一时刻的原事件和更正要一起折叠，不能拆批）。
const STATE_SAME_AT_MAX: i64 = 20_000;
/// 一次状态请求最多折叠多少条记录；超过返回 503（期间保存的快照让下次接着算）。
const STATE_MAX_RECORDS: usize = 200_000;
/// 折叠了这么多条记录就保存一份快照。
const SNAPSHOT_EVERY: usize = 2000;
/// 只给至少这么久以前的时刻保存快照（更晚的事件大多还会陆续到达）。
const SNAPSHOT_MIN_AGE_MS: i64 = 10 * 60 * 1000;
/// 快照的 `computedAt` 比开始读取的时间再早这么多（大于单个请求的最长时间），
/// 保证 `recordedAt ≤ computedAt` 的记录在读取时都已经写进数据库。
const SNAPSHOT_SAFETY_MS: i64 = 120 * 1000;

pub type TypeMap = BTreeMap<(String, u32), EventType>;

pub async fn type_map(state: &AppState, grant: &Grant) -> Result<TypeMap, ApiError> {
    Ok(state
        .repo
        .event_types(grant)
        .await?
        .into_iter()
        .map(|event_type| ((event_type.name.clone(), event_type.version), event_type))
        .collect())
}

/// 公开锚点的编号，加上空间级锚点 `_space`——除非主人把 `_space` 改成了内部级（这时空间级
/// 事件和状态同样不公开；还没有 `_space` 锚点的空间照旧当作公开）。
pub async fn public_anchor_ids(
    state: &AppState,
    grant: &Grant,
) -> Result<BTreeSet<String>, ApiError> {
    let mut ids: BTreeSet<String> = state
        .repo
        .anchors(grant)
        .await?
        .into_iter()
        .filter(|anchor| anchor.visibility == DataVisibility::Public)
        .map(|anchor| anchor.anchor_id)
        .collect();
    if !ids.contains(SPACE_ANCHOR_ID)
        && !state
            .repo
            .internal_anchor_ids(grant)
            .await?
            .iter()
            .any(|id| id == SPACE_ANCHOR_ID)
    {
        ids.insert(SPACE_ANCHOR_ID.to_owned());
    }
    Ok(ids)
}

/// 一页记录：涉及的原事件（按出现顺序）和它们的全部版本。
pub struct EventPage {
    pub records: Vec<Event>,
    pub touched: Vec<String>,
    pub next: Option<Cursor>,
}

/// 时间窗 `[from, to)`。
pub async fn window_page(
    state: &AppState,
    grant: &Grant,
    from: Timestamp,
    to: Timestamp,
    after: Option<&Cursor>,
    limit: i64,
) -> Result<EventPage, ApiError> {
    let mut originals = state
        .repo
        .originals_in_window(grant, from, to, after, limit + 1)
        .await?;
    let mut more = originals.len() as i64 > limit;
    originals.truncate(limit as usize);
    let ids: Vec<String> = originals.iter().map(|event| event.id.clone()).collect();
    let (keep, budget) = within_budget(state, grant, &ids).await?;
    if keep < originals.len() {
        originals.truncate(keep);
        more = true;
    }
    let next = more.then(|| {
        let last = originals.last().expect("有下一页时本页不为空");
        Cursor {
            at: last.at,
            id: last.id.clone(),
        }
    });
    let touched: Vec<String> = originals.iter().map(|event| event.id.clone()).collect();
    let mut records = originals;
    records.extend(
        state
            .repo
            .corrections_for(grant, &touched, budget as i64 + 1)
            .await?,
    );
    Ok(EventPage {
        records,
        touched,
        next,
    })
}

/// 按顺序取原事件，直到"原事件 + 它们的更正"超过 [`MAX_PAGE_RECORDS`]：返回能放进本页的
/// 原事件个数和其中更正的总数。第一条原事件自己就超过上限时 503（单条原事件的更正有写入上限，
/// 只有旧数据会这样）。
async fn within_budget(
    state: &AppState,
    grant: &Grant,
    ids: &[String],
) -> Result<(usize, u64), ApiError> {
    let counts = state.repo.correction_counts(grant, ids, &[]).await?;
    let mut used = 0u64;
    let mut corrections = 0u64;
    for (index, id) in ids.iter().enumerate() {
        let extra = counts.get(id).copied().unwrap_or(0);
        let cost = 1 + extra;
        if used + cost > MAX_PAGE_RECORDS {
            if index == 0 {
                return Err(ApiError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "too_many_corrections",
                    "这条事件的更正太多，无法读取",
                ));
            }
            return Ok((index, corrections));
        }
        used += cost;
        corrections += extra;
    }
    Ok((ids.len(), corrections))
}

/// 增量：`recordedAt ≥ since`。
pub async fn since_page(
    state: &AppState,
    grant: &Grant,
    since: Timestamp,
    after: Option<&Cursor>,
    limit: i64,
) -> Result<EventPage, ApiError> {
    let mut changed = state
        .repo
        .records_since(grant, since, after, limit + 1)
        .await?;
    let mut more = changed.len() as i64 > limit;
    changed.truncate(limit as usize);
    let mut touched = Vec::new();
    let mut first_seen = Vec::new();
    let mut seen = BTreeSet::new();
    for (position, record) in changed.iter().enumerate() {
        let original = record.corrects.clone().unwrap_or_else(|| record.id.clone());
        if seen.insert(original.clone()) {
            touched.push(original);
            first_seen.push(position);
        }
    }
    // 涉及的原事件连同全部更正一起重算：总量超过上限时，本页在第一次出现放不下的原事件之前结束。
    let (keep, budget) = within_budget(state, grant, &touched).await?;
    if keep < touched.len() {
        changed.truncate(first_seen[keep]);
        touched.truncate(keep);
        more = true;
    }
    let next = more.then(|| {
        let last = changed.last().expect("有下一页时本页不为空");
        Cursor {
            at: last.recorded_at,
            id: last.id.clone(),
        }
    });
    let mut records = state.repo.originals(grant, &touched).await?;
    records.extend(
        state
            .repo
            .corrections_for(grant, &touched, budget as i64 + 1)
            .await?,
    );
    Ok(EventPage {
        records,
        touched,
        next,
    })
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// 公开事件（字段与网站 `SpaceEvent` 相同）。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicEventView {
    /// 最初那条事件的编号（更正已应用）。
    pub id: String,
    pub space_id: String,
    /// 现实发生时间。
    #[schema(value_type = String, format = DateTime)]
    pub at: Timestamp,
    /// 生效版本的服务端记录时间（增量游标按它走）。
    #[schema(value_type = String, format = DateTime)]
    pub recorded_at: Timestamp,
    pub source: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub type_version: u32,
    pub anchor_id: String,
    /// 只含事件类型登记的公开字段；被抹除时没有。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Object>)]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub redacted: bool,
    /// "撤下"标记：之前公开过、后来被撤回或改成内部级（只出现在增量结果里）。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub withdrawn: bool,
}

/// `/api/v1` 的事件（含内部级，更正已应用）。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    pub id: String,
    pub space_id: String,
    #[schema(value_type = String, format = DateTime)]
    pub at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub recorded_at: Timestamp,
    pub source: String,
    pub source_event_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub type_version: u32,
    pub anchor_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Object>)]
    pub data: Option<Value>,
    /// `public` 或 `internal`。
    #[schema(value_type = String)]
    pub visibility: DataVisibility,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    /// 被替换过。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub corrected: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub redacted: bool,
}

/// `raw=true` 时返回的原始记录（原事件和更正各一条）。
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventRecordView {
    pub id: String,
    pub source: String,
    pub source_event_id: String,
    #[schema(value_type = String, format = DateTime)]
    pub at: Timestamp,
    #[schema(value_type = String, format = DateTime)]
    pub recorded_at: Timestamp,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Object>)]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<String>)]
    pub visibility: Option<DataVisibility>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    /// 更正：指向最初那条事件。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corrects: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub retracted: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub redacted: bool,
    /// 写入者的 sub。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_sub: Option<String>,
}

impl EventRecordView {
    pub fn new(event: Event) -> Self {
        Self {
            data: if event.redacted { None } else { event.data },
            id: event.id,
            source: event.source,
            source_event_id: event.source_event_id,
            at: event.at,
            recorded_at: event.recorded_at,
            event_type: event.event_type,
            type_version: event.type_version,
            anchor_id: event.anchor_id,
            visibility: event.visibility,
            correlation_id: event.correlation_id,
            corrects: event.corrects,
            retracted: event.retracted,
            redacted: event.redacted,
            actor_sub: event.actor.map(|actor| actor.sub),
        }
    }
}

/// 筛选条件。
#[derive(Debug, Clone, Default)]
pub struct Filters {
    /// 只要这些事件类型（空表示不限）。
    pub types: BTreeSet<String>,
    /// 按 `at` 再筛一遍（增量查询同时给了 from/to 时）。
    pub from: Option<Timestamp>,
    pub to: Option<Timestamp>,
}

impl Filters {
    fn keeps(&self, event_type: &str, at: Timestamp) -> bool {
        (self.types.is_empty() || self.types.contains(event_type))
            && self.from.is_none_or(|from| at >= from)
            && self.to.is_none_or(|to| at < to)
    }
}

fn redacted_ids(records: &[Event]) -> BTreeSet<&str> {
    records
        .iter()
        .filter(|record| record.redacted)
        .map(|record| record.corrects.as_deref().unwrap_or(&record.id))
        .collect()
}

/// 公开投影：先应用更正，再按可见级别过滤，只留公开字段、公开锚点上的事件。
pub fn public_items(
    space_id: &str,
    page: &EventPage,
    types: &TypeMap,
    public_anchors: &BTreeSet<String>,
    filters: &Filters,
    with_withdrawn: bool,
) -> Vec<PublicEventView> {
    let redacted = redacted_ids(&page.records);
    let visible: Vec<EffectiveEvent> = public_events(&page.records, types);
    let visible_ids: BTreeSet<&str> = visible.iter().map(|event| event.id.as_str()).collect();
    let mut items: Vec<PublicEventView> = visible
        .iter()
        .filter(|event| public_anchors.contains(&event.anchor_id))
        .filter(|event| filters.keeps(&event.event_type, event.at))
        .map(|event| PublicEventView {
            id: event.id.clone(),
            space_id: space_id.to_owned(),
            at: event.at,
            recorded_at: event.recorded_at,
            source: event.source.clone(),
            event_type: event.event_type.clone(),
            type_version: event.type_version,
            anchor_id: event.anchor_id.clone(),
            data: event.data.clone(),
            correlation_id: event.correlation_id.clone(),
            redacted: redacted.contains(event.id.as_str()),
            withdrawn: false,
        })
        .collect();
    if with_withdrawn {
        for id in &page.touched {
            if visible_ids.contains(id.as_str()) {
                continue;
            }
            let mut versions: Vec<&Event> = page
                .records
                .iter()
                .filter(|record| &record.id == id || record.corrects.as_ref() == Some(id))
                .collect();
            versions.sort_by(|a, b| (a.recorded_at, &a.id).cmp(&(b.recorded_at, &b.id)));
            let Some(latest) = versions.last() else {
                continue;
            };
            // 曾经公开过的最后一个版本（非撤回、公开级）。
            let Some(last_public) = versions.iter().rev().find(|version| {
                !version.retracted
                    && version.visibility == Some(DataVisibility::Public)
                    && version.anchor_id.is_some()
                    && version.event_type.is_some()
            }) else {
                continue;
            };
            let anchor = last_public.anchor_id.clone().unwrap_or_default();
            if !public_anchors.contains(&anchor) {
                continue;
            }
            items.push(PublicEventView {
                id: id.clone(),
                space_id: space_id.to_owned(),
                at: versions[0].at,
                recorded_at: latest.recorded_at,
                source: latest.source.clone(),
                event_type: last_public.event_type.clone().unwrap_or_default(),
                type_version: last_public.type_version.unwrap_or(1),
                anchor_id: anchor,
                data: None,
                correlation_id: None,
                redacted: false,
                withdrawn: true,
            });
        }
    }
    items.sort_by(|a, b| (a.at, a.recorded_at, &a.id).cmp(&(b.at, b.recorded_at, &b.id)));
    items
}

/// `/api/v1` 投影：更正已应用，含内部级和全部数据（抹除的除外）。
pub fn internal_items(space_id: &str, page: &EventPage, filters: &Filters) -> Vec<EventView> {
    let redacted = redacted_ids(&page.records);
    let source_ids: BTreeMap<&str, &str> = page
        .records
        .iter()
        .filter(|record| record.corrects.is_none())
        .map(|record| (record.id.as_str(), record.source_event_id.as_str()))
        .collect();
    apply_corrections(&page.records)
        .into_iter()
        .filter(|event| filters.keeps(&event.event_type, event.at))
        .map(|event| EventView {
            source_event_id: source_ids
                .get(event.id.as_str())
                .map(|id| (*id).to_owned())
                .unwrap_or_default(),
            redacted: redacted.contains(event.id.as_str()),
            id: event.id,
            space_id: space_id.to_owned(),
            at: event.at,
            recorded_at: event.recorded_at,
            source: event.source,
            event_type: event.event_type,
            type_version: event.type_version,
            anchor_id: event.anchor_id,
            data: event.data,
            visibility: event.visibility.unwrap_or(DataVisibility::Internal),
            correlation_id: event.correlation_id,
            corrected: event.corrected,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// /head
// ---------------------------------------------------------------------------

/// 最新一条公开可见变化的记录时间：只算公开锚点上的事件（与公开事件接口一致），内部锚点上
/// 的活动不能从 `/head` 的 recordedAt 和 ETag 里看出来。
pub async fn public_recorded_at(
    state: &AppState,
    grant: &Grant,
) -> Result<Option<Timestamp>, ApiError> {
    let anchors = public_anchor_ids(state, grant).await?;
    let latest_public = state
        .repo
        .latest_public_recorded_at(grant, &anchors)
        .await?;
    let hiding = state
        .repo
        .hiding_corrections_after(grant, latest_public, 200)
        .await?;
    if hiding.is_empty() {
        return Ok(latest_public);
    }
    let targets: Vec<String> = hiding
        .iter()
        .filter_map(|record| record.corrects.clone())
        .collect();
    let ever = state.repo.ever_public(grant, &targets, &anchors).await?;
    let withdrawn = hiding
        .iter()
        .filter(|record| record.corrects.as_ref().is_some_and(|id| ever.contains(id)))
        .map(|record| record.recorded_at)
        .max();
    Ok(latest_public.max(withdrawn))
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/// T 时刻各公开锚点的状态（设计 5.5）。
pub async fn public_state_at(
    state: &AppState,
    grant: &Grant,
    t: Timestamp,
) -> Result<Vec<SnapshotState>, ApiError> {
    let types = type_map(state, grant).await?;
    let started = crate::now()?;
    let computed_at = started.saturating_add_millis(-SNAPSHOT_SAFETY_MS);
    let snapshot_horizon = started.saturating_add_millis(-SNAPSHOT_MIN_AGE_MS);
    // 1. 最近的有效快照；失效的（有晚到事件或更正）连同之后的快照一起删掉。
    let mut base: Option<StateSnapshot> = None;
    for candidate in state.repo.state_snapshots_before(grant, t, 4).await? {
        if state
            .repo
            .state_snapshot_is_stale(grant, &candidate)
            .await?
        {
            let system = Authorizer::system_scope(grant, "删除失效的状态快照");
            state
                .repo
                .delete_state_snapshots(&system, candidate.at)
                .await?;
            continue;
        }
        base = Some(candidate);
        break;
    }
    let mut lower = base
        .as_ref()
        .map_or(Lower::None, |snapshot| Lower::Exclusive(snapshot.at));
    let mut fold =
        StateFold::from_snapshot(base.map(|snapshot| snapshot.states).unwrap_or_default());
    let mut since_save = 0usize;
    let mut total = 0usize;
    // 2. 按 at 分批折叠；同一 at 的记录不跨批。
    loop {
        let batch = state
            .repo
            .records_by_at(grant, lower, t, Some(STATE_BATCH))
            .await?;
        if batch.is_empty() {
            break;
        }
        total += batch.len();
        if (batch.len() as i64) < STATE_BATCH {
            since_save += batch.len();
            fold.apply(&batch, &types);
            break;
        }
        let last_at = batch.last().expect("非空").at;
        let head: Vec<Event> = batch.iter().filter(|e| e.at < last_at).cloned().collect();
        if head.is_empty() {
            // 整批都是同一个时刻：把这个时刻的记录一次读完（原事件和更正要一起折叠），但有上限。
            let same = state
                .repo
                .records_by_at(
                    grant,
                    Lower::Inclusive(last_at),
                    last_at,
                    Some(STATE_SAME_AT_MAX + 1),
                )
                .await?;
            if same.len() as i64 > STATE_SAME_AT_MAX {
                tracing::warn!(space = %grant.space_id(), at = %last_at.to_rfc3339(), "同一时刻的事件太多，无法计算状态");
                return Err(ApiError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "state_computing",
                    "同一时刻的事件太多，无法计算状态",
                ));
            }
            total += same.len();
            since_save += same.len();
            fold.apply(&same, &types);
            lower = Lower::Exclusive(last_at);
        } else {
            since_save += head.len();
            fold.apply(&head, &types);
            lower = Lower::Inclusive(last_at);
            // 此时已包含全部 at < last_at 的记录：可以在 last_at - 1ms 存一份快照。
            let checkpoint = last_at.saturating_add_millis(-1);
            if since_save >= SNAPSHOT_EVERY && checkpoint <= snapshot_horizon {
                save_snapshot(state, grant, checkpoint, computed_at, &fold).await;
                since_save = 0;
            }
        }
        if total > STATE_MAX_RECORDS {
            return Err(ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "state_computing",
                "事件太多，状态还在计算中，请稍后重试",
            ));
        }
    }
    if since_save >= SNAPSHOT_EVERY && t <= snapshot_horizon {
        save_snapshot(state, grant, t, computed_at, &fold).await;
    }
    let anchors = public_anchor_ids(state, grant).await?;
    Ok(fold.states_at(t, &types, &anchors))
}

/// 保存快照失败不影响这次请求。
async fn save_snapshot(
    state: &AppState,
    grant: &Grant,
    at: Timestamp,
    computed_at: Timestamp,
    fold: &StateFold,
) {
    let system = Authorizer::system_scope(grant, "保存状态快照");
    let snapshot = StateSnapshot {
        id: format!("ss_{}_{}", grant.space_id(), at.millis()),
        space_id: grant.space_id().to_owned(),
        owner: grant.owner().clone(),
        at,
        computed_at,
        states: fold.snapshot_states(),
    };
    if let Err(error) = state.repo.insert_state_snapshot(&system, &snapshot).await {
        tracing::warn!(space = %grant.space_id(), error = %error, "保存状态快照失败");
    }
}
