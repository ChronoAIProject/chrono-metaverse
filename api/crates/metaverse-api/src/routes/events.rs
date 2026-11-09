//! 现实事件的写入和给 AI 的读取（设计 5.3–5.5、8.3、11）。
//!
//! ```text
//! POST /api/v1/spaces/{space_id}/sources/{source}/events        批量写，每批 ≤ 1000 条
//! POST /api/v1/spaces/{space_id}/sources/{source}/corrections   替换或撤回
//! GET  /api/v1/spaces/{space_id}/events                         查询（含内部级）
//! GET  /api/v1/spaces/{space_id}/event-types                    已登记的事件类型
//! ```
//!
//! - 数据源来自路径，请求体里不能填 `source`；`(spaceId, source, sourceEventId)` 去重，
//!   重试安全（重复的那条返回 `duplicate`，不覆盖）；
//! - `at` 晚于服务端记录时间 5 分钟以上的拒收；`data` 按事件类型登记的 JSON Schema 校验，
//!   规范化后不超过 4KB；不填 `visibility` 时取事件类型的默认值；
//! - `correlationId` = `<发起空间编号>:<编号>`，显示为路线起点（pathRole = origin）的事件
//!   只能写在前缀对应的空间里；
//! - 锚点必须是本空间现有的锚点（或空间级锚点 `_space`）；
//! - 任何一条不合法，整批拒收（422，detail 里写明第几条），一条也不写。

use std::collections::{BTreeMap, BTreeSet, HashMap};

use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use metaverse_core::events::{
    validate_correction, validate_correlation_id, validate_event_data, validate_event_time,
    MAX_EVENTS_PER_BATCH,
};
use metaverse_core::ids::{is_object_id, SPACE_ANCHOR_ID};
use metaverse_core::model::{event_id, ActorKind, DataVisibility, Event, EventType};
use metaverse_core::scope::{check_event_body_has_no_source, PathScope};
use metaverse_core::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::{IntoParams, ToSchema};

use super::event_query::{
    internal_items, since_page, type_map, window_page, EventRecordView, EventView, Filters,
    TypeMap, MAX_WINDOW_MS,
};
use super::ingest_common::{
    decode_cursor, encode_cursor, invalid_with, no_store, parse_time, path_actor,
    scope_violation, too_large,
};
use super::ApiJson;
use crate::auth::permissions::Capability;
use crate::auth::{Caller, Grant, Purpose};
use crate::error::{ApiError, ProblemDocument};
use crate::ingest::schema::CompiledSchema;
use crate::repo::EventInsert;
use crate::AppState;

/// `/api/v1` 查询每页默认几条、最多几条。
const DEFAULT_PAGE: i64 = 200;
const MAX_PAGE: i64 = 1000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/spaces/{space_id}/sources/{source}/events",
            post(write_events),
        )
        .route(
            "/api/v1/spaces/{space_id}/sources/{source}/corrections",
            post(write_corrections),
        )
        .route("/api/v1/spaces/{space_id}/events", get(list_events))
        .route("/api/v1/spaces/{space_id}/event-types", get(list_event_types))
}

// ---------------------------------------------------------------------------
// 请求与视图
// ---------------------------------------------------------------------------

/// 一条事件。数据源由路径决定，这里不能填 `source`。
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventInput {
    /// 数据源自己的事件编号（1–128 个字母、数字、-、_、.），用于去重和安全重试。
    #[schema(example = "order-20261109-0042")]
    pub source_event_id: String,
    /// 已登记的事件类型。
    #[serde(rename = "type")]
    #[schema(example = "table.occupancy")]
    pub event_type: String,
    /// 事件类型版本，默认最新版本。
    #[serde(default)]
    pub type_version: Option<u32>,
    /// 锚点编号（本空间现有锚点，或空间级锚点 `_space`）。
    #[schema(example = "t1")]
    pub anchor_id: String,
    /// 现实发生时间（RFC 3339），可以晚到，但不能晚于服务端时间 5 分钟以上。
    #[schema(value_type = String, format = DateTime)]
    pub at: Timestamp,
    /// 按事件类型的 JSON Schema 校验，规范化后 ≤ 4KB；不填按 `{}` 校验。
    #[serde(default)]
    #[schema(value_type = Option<Object>)]
    pub data: Option<Value>,
    /// `public` 或 `internal`；不填取事件类型的默认值。
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub visibility: Option<DataVisibility>,
    /// 跨空间关联：`<发起空间编号>:<编号>`。
    #[serde(default)]
    pub correlation_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct WriteEventsRequest {
    /// 1–1000 条事件。
    pub events: Vec<Value>,
}

/// 一条更正：替换（完整的新记录）或撤回（`retracted: true`，不带内容）。
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CorrectionInput {
    /// 这条更正自己的数据源事件编号（同样参与去重）。
    pub source_event_id: String,
    /// 被更正的最初那条事件的编号（`ev_...`）。和 `correctsSourceEventId` 二选一。
    #[serde(default)]
    pub corrects: Option<String>,
    /// 被更正的事件的数据源事件编号（同一数据源）。
    #[serde(default)]
    pub corrects_source_event_id: Option<String>,
    /// 撤回：不带任何内容。
    #[serde(default)]
    pub retracted: bool,
    #[serde(rename = "type", default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub type_version: Option<u32>,
    #[serde(default)]
    pub anchor_id: Option<String>,
    /// 替换的 at 必须与原事件相同（可省略）；时间录错了请先撤回再新写。
    #[serde(default)]
    #[schema(value_type = Option<String>, format = DateTime)]
    pub at: Option<Timestamp>,
    #[serde(default)]
    #[schema(value_type = Option<Object>)]
    pub data: Option<Value>,
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub visibility: Option<DataVisibility>,
    #[serde(default)]
    pub correlation_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct WriteCorrectionsRequest {
    /// 1–1000 条更正。
    pub corrections: Vec<Value>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventWriteResult {
    pub source_event_id: String,
    /// 事件编号（由空间、数据源、数据源事件编号算出，重试时不变）。
    pub id: String,
    /// `created` 或 `duplicate`（已存在，没有覆盖）。
    pub status: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WriteEventsResponse {
    /// 这一批的服务端记录时间。
    #[schema(value_type = String, format = DateTime)]
    pub recorded_at: Timestamp,
    pub created: usize,
    pub duplicates: usize,
    pub results: Vec<EventWriteResult>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct EventsQuery {
    /// 时间窗起点（按 at，含）。不给 since 时必填，窗口 ≤ 24 小时。
    pub from: Option<String>,
    /// 时间窗终点（按 at，不含）。
    pub to: Option<String>,
    /// 增量：记录时间 ≥ since 的变化（含晚到事件和更正）。
    pub since: Option<String>,
    /// 只要这些事件类型，逗号分隔。
    pub types: Option<String>,
    /// 上一页返回的 nextAfter。
    pub after: Option<String>,
    /// 每页条数（`/api/v1` 默认 200、最多 1000；公开读最多 5000）。
    pub limit: Option<i64>,
    /// `true` 时返回原始记录（原事件和更正各一条），不应用更正（只限 `/api/v1`）。
    pub raw: Option<bool>,
    /// 凭组合的分享令牌读取时的组合编号（只限公开读）。
    pub universe: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventPageView {
    #[schema(value_type = Vec<Object>)]
    pub items: Vec<Value>,
    /// 下一页的游标；没有更多时为 null。
    pub next_after: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct EventTypeList {
    /// 全部版本（type、version、schema、publicFields、defaultVisibility、state、maxAgeSec、display）。
    #[schema(value_type = Vec<Object>)]
    pub items: Vec<Value>,
}

/// 事件类型的接口视图（去掉存储用的 spaceId、owner）。
pub fn event_type_view(event_type: &EventType, with_schema: bool) -> Value {
    let mut value = serde_json::to_value(event_type).unwrap_or(Value::Null);
    if let Value::Object(map) = &mut value {
        map.remove("spaceId");
        if !with_schema {
            map.remove("schema");
        }
    }
    value
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

fn at_index(index: usize, error: ApiError) -> ApiError {
    ApiError::new(
        error.status,
        error.code,
        format!("第 {index} 条：{}", error.detail),
    )
}

/// 每个事件类型的最新版本。
fn latest_versions(types: &TypeMap) -> BTreeMap<&str, u32> {
    let mut latest = BTreeMap::new();
    for (name, version) in types.keys() {
        let entry = latest.entry(name.as_str()).or_insert(*version);
        *entry = (*entry).max(*version);
    }
    latest
}

/// 校验一条事件的内容（类型、锚点、数据、关联编号），返回 (类型, 规范化的数据, 可见性)。
/// `schemas` 是本次请求内的编译缓存。
#[allow(clippy::too_many_arguments)]
fn check_content<'t>(
    space_id: &str,
    types: &'t TypeMap,
    latest: &BTreeMap<&str, u32>,
    anchors: &BTreeSet<String>,
    schemas: &mut HashMap<(String, u32), CompiledSchema>,
    event_type: &str,
    type_version: Option<u32>,
    anchor_id: &str,
    data: Option<Value>,
    visibility: Option<DataVisibility>,
    correlation_id: Option<&str>,
) -> Result<(&'t EventType, Value, DataVisibility), ApiError> {
    let version = match type_version {
        Some(version) => version,
        None => *latest.get(event_type).ok_or_else(|| {
            invalid_with("unknown_event_type", format!("事件类型 {event_type} 没有登记"))
        })?,
    };
    let definition = types
        .get(&(event_type.to_owned(), version))
        .ok_or_else(|| {
            invalid_with(
                "unknown_event_type",
                format!("事件类型 {event_type} 没有版本 {version}"),
            )
        })?;
    if !is_object_id(anchor_id) || (anchor_id != SPACE_ANCHOR_ID && !anchors.contains(anchor_id)) {
        return Err(invalid_with(
            "unknown_anchor",
            format!("锚点 {anchor_id} 不存在"),
        ));
    }
    let data = data.unwrap_or_else(|| json!({}));
    validate_event_data(&data).map_err(|error| invalid_with("data_too_large", error.to_string()))?;
    let key = (event_type.to_owned(), version);
    if !schemas.contains_key(&key) {
        let compiled = CompiledSchema::compile(&definition.schema).map_err(|error| {
            invalid_with(
                "schema_unavailable",
                format!("事件类型 {event_type} v{version} 的 schema 不可用：{error}"),
            )
        })?;
        schemas.insert(key.clone(), compiled);
    }
    schemas[&key]
        .validate(&data)
        .map_err(|error| invalid_with("schema_violation", format!("data 不符合 schema：{error}")))?;
    if let Some(correlation_id) = correlation_id {
        validate_correlation_id(space_id, correlation_id, definition.display.path_role)
            .map_err(|error| invalid_with("invalid_correlation_id", error.to_string()))?;
    }
    Ok((
        definition,
        data,
        visibility.unwrap_or(definition.default_visibility),
    ))
}

fn check_batch_size(len: usize, what: &str) -> Result<(), ApiError> {
    if len == 0 {
        return Err(ApiError::invalid(format!("{what} 不能为空")));
    }
    if len > MAX_EVENTS_PER_BATCH {
        return Err(too_large(
            "batch_too_large",
            format!("每批最多 {MAX_EVENTS_PER_BATCH} 条"),
        ));
    }
    Ok(())
}

fn parse_item<T: serde::de::DeserializeOwned>(index: usize, item: Value) -> Result<T, ApiError> {
    check_event_body_has_no_source(&item).map_err(|error| {
        at_index(index, scope_violation(error.to_string()))
    })?;
    serde_json::from_value(item).map_err(|error| {
        at_index(index, ApiError::invalid(format!("字段不合法：{error}")))
    })
}

/// 构造要写入的事件（同步：编译好的 schema 不跨 await）。
fn build_events(
    grant: &Grant,
    source: &str,
    caller: &Caller,
    types: &TypeMap,
    anchors: &BTreeSet<String>,
    items: Vec<Value>,
    now: Timestamp,
) -> Result<Vec<Event>, ApiError> {
    let latest = latest_versions(types);
    let mut schemas = HashMap::new();
    let mut seen = BTreeSet::new();
    let mut events = Vec::with_capacity(items.len());
    for (index, item) in items.into_iter().enumerate() {
        let input: EventInput = parse_item(index, item)?;
        let fail = |error: ApiError| at_index(index, error);
        if !is_object_id(&input.source_event_id) {
            return Err(fail(ApiError::invalid("sourceEventId 格式不对")));
        }
        if !seen.insert(input.source_event_id.clone()) {
            return Err(fail(ApiError::invalid("同一批里 sourceEventId 重复")));
        }
        validate_event_time(input.at, now)
            .map_err(|error| fail(invalid_with("event_in_future", error.to_string())))?;
        let (definition, data, visibility) = check_content(
            grant.space_id(),
            types,
            &latest,
            anchors,
            &mut schemas,
            &input.event_type,
            input.type_version,
            &input.anchor_id,
            input.data,
            input.visibility,
            input.correlation_id.as_deref(),
        )
        .map_err(fail)?;
        events.push(Event {
            id: event_id(grant.space_id(), source, &input.source_event_id),
            space_id: grant.space_id().to_owned(),
            owner: grant.owner().clone(),
            at: input.at,
            recorded_at: now,
            source: source.to_owned(),
            source_event_id: input.source_event_id,
            event_type: Some(definition.name.clone()),
            type_version: Some(definition.version),
            anchor_id: Some(input.anchor_id),
            data: Some(data),
            visibility: Some(visibility),
            correlation_id: input.correlation_id,
            corrects: None,
            retracted: false,
            redacted: false,
            actor: Some(path_actor(
                caller,
                PathScope::Source(source.to_owned()),
                ActorKind::Source,
            )),
        });
    }
    Ok(events)
}

/// 构造更正记录。`originals` 是按编号查到的原事件。
#[allow(clippy::too_many_arguments)]
fn build_corrections(
    grant: &Grant,
    source: &str,
    caller: &Caller,
    types: &TypeMap,
    anchors: &BTreeSet<String>,
    inputs: Vec<(usize, CorrectionInput, String)>,
    originals: &BTreeMap<String, Event>,
    now: Timestamp,
) -> Result<Vec<Event>, ApiError> {
    let latest = latest_versions(types);
    let mut schemas = HashMap::new();
    let mut corrections = Vec::with_capacity(inputs.len());
    for (index, input, target) in inputs {
        let fail = |error: ApiError| at_index(index, error);
        let original = originals.get(&target).ok_or_else(|| {
            fail(invalid_with("unknown_original", "被更正的事件不存在"))
        })?;
        if original.corrects.is_some() {
            return Err(fail(invalid_with(
                "invalid_correction",
                "corrects 必须指向最初那条事件，不能指向另一条更正",
            )));
        }
        if original.source != source {
            return Err(fail(scope_violation(
                "更正必须走原事件数据源的路径 /sources/{source}/corrections",
            )));
        }
        let mut correction = Event {
            id: event_id(grant.space_id(), source, &input.source_event_id),
            space_id: grant.space_id().to_owned(),
            owner: grant.owner().clone(),
            at: original.at,
            recorded_at: now,
            source: source.to_owned(),
            source_event_id: input.source_event_id.clone(),
            event_type: None,
            type_version: None,
            anchor_id: None,
            data: None,
            visibility: None,
            correlation_id: None,
            corrects: Some(original.id.clone()),
            retracted: input.retracted,
            redacted: false,
            actor: Some(path_actor(
                caller,
                PathScope::Source(source.to_owned()),
                ActorKind::Source,
            )),
        };
        if input.at.is_some_and(|at| at != original.at) {
            return Err(fail(invalid_with(
                "invalid_correction",
                "替换的 at 必须与原事件相同；时间录错了请先撤回再新写一条",
            )));
        }
        if input.retracted {
            if input.event_type.is_some()
                || input.anchor_id.is_some()
                || input.data.is_some()
                || input.visibility.is_some()
                || input.correlation_id.is_some()
                || input.type_version.is_some()
            {
                return Err(fail(invalid_with("invalid_correction", "撤回不带内容")));
            }
        } else {
            let event_type = input.event_type.as_deref().ok_or_else(|| {
                fail(invalid_with("invalid_correction", "替换必须是完整的新记录（缺 type）"))
            })?;
            let anchor_id = input.anchor_id.as_deref().ok_or_else(|| {
                fail(invalid_with("invalid_correction", "替换必须是完整的新记录（缺 anchorId）"))
            })?;
            let (definition, data, visibility) = check_content(
                grant.space_id(),
                types,
                &latest,
                anchors,
                &mut schemas,
                event_type,
                input.type_version,
                anchor_id,
                input.data,
                input.visibility,
                input.correlation_id.as_deref(),
            )
            .map_err(fail)?;
            correction.event_type = Some(definition.name.clone());
            correction.type_version = Some(definition.version);
            correction.anchor_id = Some(anchor_id.to_owned());
            correction.data = Some(data);
            correction.visibility = Some(visibility);
            correction.correlation_id = input.correlation_id;
        }
        validate_correction(original, &correction)
            .map_err(|error| fail(invalid_with("invalid_correction", error.to_string())))?;
        corrections.push(correction);
    }
    Ok(corrections)
}

async fn source_grant(
    state: &AppState,
    caller: &Caller,
    space_id: &str,
    source: &str,
) -> Result<Grant, ApiError> {
    state
        .authorizer
        .require_capability(caller, Capability::WriteEvents)?;
    let grant = state
        .authorizer
        .space(caller, space_id, Purpose::Manage)
        .await?;
    if !is_object_id(source) {
        return Err(ApiError::not_found());
    }
    Ok(grant)
}

async fn known_anchors(state: &AppState, grant: &Grant) -> Result<BTreeSet<String>, ApiError> {
    Ok(state
        .repo
        .anchors(grant)
        .await?
        .into_iter()
        .map(|anchor| anchor.anchor_id)
        .collect())
}

fn write_response(events: &[Event], results: Vec<EventInsert>, now: Timestamp) -> Response {
    let mut created = 0;
    let mut duplicates = 0;
    let results = events
        .iter()
        .zip(results)
        .map(|(event, result)| {
            let status = match result {
                EventInsert::Created => {
                    created += 1;
                    "created"
                }
                EventInsert::Duplicate => {
                    duplicates += 1;
                    "duplicate"
                }
            };
            EventWriteResult {
                source_event_id: event.source_event_id.clone(),
                id: event.id.clone(),
                status: status.to_owned(),
            }
        })
        .collect();
    no_store(
        Json(WriteEventsResponse {
            recorded_at: now,
            created,
            duplicates,
            results,
        })
        .into_response(),
    )
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/sources/{source}/events",
    operation_id = "write_events",
    tag = "events",
    description = "批量写现实事件（每批 1–1000 条）。数据源由路径决定，请求体里不能填 source。按 (空间, 数据源, sourceEventId) 去重，可以安全重试：已存在的返回 duplicate、不覆盖（要改请用更正接口）。at 晚于服务端时间 5 分钟以上拒收；data 按事件类型的 JSON Schema 校验且 ≤ 4KB；锚点必须存在；correlationId 写成 <发起空间编号>:<编号>，路线起点事件只能写在前缀对应的空间。任何一条不合法整批拒收（422）。",
    params(
        ("space_id" = String, Path, description = "空间编号", example = "restaurant"),
        ("source" = String, Path, description = "数据源名称", example = "pos"),
    ),
    request_body(content = WriteEventsRequest, description = "`{events: [EventInput, ...]}`"),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "已写入（含重复的）", body = WriteEventsResponse),
        (status = 403, description = "没有写权限，或请求体里填了 source", body = ProblemDocument),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
        (status = 413, description = "一批超过 1000 条", body = ProblemDocument),
        (status = 422, description = "事件不合法（第几条、原因）", body = ProblemDocument),
    )
)]
pub async fn write_events(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, source)): Path<(String, String)>,
    ApiJson(request): ApiJson<WriteEventsRequest>,
) -> Result<Response, ApiError> {
    let grant = source_grant(&state, &caller, &space_id, &source).await?;
    check_batch_size(request.events.len(), "events")?;
    let types = type_map(&state, &grant).await?;
    let anchors = known_anchors(&state, &grant).await?;
    let now = crate::now()?;
    let events = build_events(&grant, &source, &caller, &types, &anchors, request.events, now)?;
    let results = state.repo.insert_events(&grant, &events).await?;
    state.ingest.head_cache.invalidate(grant.space_id());
    tracing::info!(space = %space_id, source = %source, count = events.len(), by = %caller.subject, "写入事件");
    Ok(write_response(&events, results, now))
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/sources/{source}/corrections",
    operation_id = "write_corrections",
    tag = "events",
    description = "更正事件（每批 1–1000 条）：替换（完整的新记录，at 与原事件相同）或撤回（retracted: true，不带内容）。corrects 指向最初那条事件的编号（或用 correctsSourceEventId 指定同一数据源的事件编号）；只能更正同一数据源的事件。同一事件有多条更正时以记录时间最新的为准。把公开事件改成内部级，它就从公开接口消失。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("source" = String, Path, description = "数据源名称（必须是原事件的数据源）"),
    ),
    request_body(content = WriteCorrectionsRequest, description = "`{corrections: [CorrectionInput, ...]}`"),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "已写入（含重复的）", body = WriteEventsResponse),
        (status = 403, description = "没有写权限，或更正别的数据源的事件", body = ProblemDocument),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
        (status = 413, description = "一批超过 1000 条", body = ProblemDocument),
        (status = 422, description = "更正不合法", body = ProblemDocument),
    )
)]
pub async fn write_corrections(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, source)): Path<(String, String)>,
    ApiJson(request): ApiJson<WriteCorrectionsRequest>,
) -> Result<Response, ApiError> {
    let grant = source_grant(&state, &caller, &space_id, &source).await?;
    check_batch_size(request.corrections.len(), "corrections")?;
    let mut inputs = Vec::with_capacity(request.corrections.len());
    let mut seen = BTreeSet::new();
    for (index, item) in request.corrections.into_iter().enumerate() {
        let input: CorrectionInput = parse_item(index, item)?;
        if !is_object_id(&input.source_event_id) || !seen.insert(input.source_event_id.clone())
        {
            return Err(at_index(
                index,
                ApiError::invalid("sourceEventId 格式不对或同一批里重复"),
            ));
        }
        let target = match (&input.corrects, &input.corrects_source_event_id) {
            (Some(id), None) if is_object_id(id) => id.clone(),
            (None, Some(source_event_id)) if is_object_id(source_event_id) => {
                event_id(grant.space_id(), &source, source_event_id)
            }
            _ => {
                return Err(at_index(
                    index,
                    ApiError::invalid("corrects 和 correctsSourceEventId 必须且只能给一个"),
                ))
            }
        };
        inputs.push((index, input, target));
    }
    let targets: Vec<String> = inputs
        .iter()
        .map(|(_, _, target)| target.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut originals: BTreeMap<String, Event> = BTreeMap::new();
    for event in state.repo.originals(&grant, &targets).await? {
        originals.insert(event.id.clone(), event);
    }
    // 指向更正的 corrects：读出来给出明确的错误。
    for target in &targets {
        if !originals.contains_key(target) {
            if let Some(event) = state.repo.event(&grant, target).await? {
                originals.insert(event.id.clone(), event);
            }
        }
    }
    let types = type_map(&state, &grant).await?;
    let anchors = known_anchors(&state, &grant).await?;
    let now = crate::now()?;
    let corrections = build_corrections(
        &grant, &source, &caller, &types, &anchors, inputs, &originals, now,
    )?;
    let results = state.repo.insert_events(&grant, &corrections).await?;
    state.ingest.head_cache.invalidate(grant.space_id());
    tracing::info!(space = %space_id, source = %source, count = corrections.len(), by = %caller.subject, "写入更正");
    Ok(write_response(&corrections, results, now))
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/events",
    operation_id = "list_events",
    tag = "events",
    description = "查询事件（含内部级，更正已应用；被抹除的没有 data）。两种方式：时间窗 from/to（按现实时间 at，≤ 24 小时）；或增量 since（按服务端记录时间，含晚到事件和更正）。types 按类型过滤（逗号分隔），after 是上一页的 nextAfter。raw=true 返回原始记录（原事件和更正各一条）。每页默认 200、最多 1000 条。",
    params(("space_id" = String, Path, description = "空间编号"), EventsQuery),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "事件", body = EventPageView),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
        (status = 422, description = "查询参数不合法", body = ProblemDocument),
    )
)]
pub async fn list_events(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .space(&caller, &space_id, Purpose::Read)
        .await?;
    let limit = query.limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
    let request = EventRequest::parse(&query)?;
    let page = request.page(&state, &grant, limit).await?;
    let items: Vec<Value> = if query.raw == Some(true) {
        let mut records = page.records.clone();
        records.sort_by(|a, b| (a.at, a.recorded_at, &a.id).cmp(&(b.at, b.recorded_at, &b.id)));
        records
            .into_iter()
            .filter(|record| {
                request
                    .filters
                    .types
                    .is_empty()
                    || record
                        .event_type
                        .as_ref()
                        .is_some_and(|t| request.filters.types.contains(t))
                    || record.retracted
            })
            .map(|record| serde_json::to_value(EventRecordView::new(record)).unwrap_or_default())
            .collect()
    } else {
        internal_items(grant.space_id(), &page, &request.filters)
            .into_iter()
            .map(|item: EventView| serde_json::to_value(item).unwrap_or_default())
            .collect()
    };
    Ok(no_store(
        Json(EventPageView {
            items,
            next_after: page.next.as_ref().map(encode_cursor),
        })
        .into_response(),
    ))
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/event-types",
    operation_id = "list_event_types",
    tag = "events",
    description = "已登记的事件类型（全部版本，含 JSON Schema、公开字段、默认可见级别、状态规则和显示规则）。写事件前用它确认 data 的格式。登记新类型走管理接口。",
    params(("space_id" = String, Path, description = "空间编号")),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "事件类型", body = EventTypeList),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
    )
)]
pub async fn list_event_types(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
) -> Result<Response, ApiError> {
    let grant = state
        .authorizer
        .space(&caller, &space_id, Purpose::Read)
        .await?;
    let items = state
        .repo
        .event_types(&grant)
        .await?
        .iter()
        .map(|event_type| event_type_view(event_type, true))
        .collect();
    Ok(no_store(Json(EventTypeList { items }).into_response()))
}

// ---------------------------------------------------------------------------
// 查询参数（与公开读共用）
// ---------------------------------------------------------------------------

/// 解析好的查询：时间窗或增量。
pub struct EventRequest {
    pub mode: EventMode,
    pub after: Option<crate::repo::Cursor>,
    pub filters: Filters,
}

pub enum EventMode {
    Window { from: Timestamp, to: Timestamp },
    Since(Timestamp),
}

impl EventRequest {
    pub fn parse(query: &EventsQuery) -> Result<Self, ApiError> {
        let from = parse_time("from", query.from.as_deref())?;
        let to = parse_time("to", query.to.as_deref())?;
        let since = parse_time("since", query.since.as_deref())?;
        let after = query.after.as_deref().map(decode_cursor).transpose()?;
        let mut types = BTreeSet::new();
        if let Some(list) = &query.types {
            for name in list.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                if name.len() > 64 {
                    return Err(ApiError::invalid("types 里的类型名太长"));
                }
                types.insert(name.to_owned());
            }
            if types.len() > 50 {
                return Err(ApiError::invalid("types 最多 50 个"));
            }
        }
        let mode = match (since, from, to) {
            (Some(since), _, _) => EventMode::Since(since),
            (None, Some(from), Some(to)) => {
                if to <= from {
                    return Err(ApiError::invalid("to 必须晚于 from"));
                }
                if to.millis_since(from) > MAX_WINDOW_MS {
                    return Err(invalid_with("window_too_large", "时间窗最长 24 小时"));
                }
                EventMode::Window { from, to }
            }
            _ => {
                return Err(ApiError::invalid(
                    "必须给出 since，或者同时给出 from 和 to",
                ))
            }
        };
        let filters = Filters {
            types,
            from: matches!(mode, EventMode::Since(_)).then_some(from).flatten(),
            to: matches!(mode, EventMode::Since(_)).then_some(to).flatten(),
        };
        Ok(Self {
            mode,
            after,
            filters,
        })
    }

    pub async fn page(
        &self,
        state: &AppState,
        grant: &Grant,
        limit: i64,
    ) -> Result<super::event_query::EventPage, ApiError> {
        match self.mode {
            EventMode::Window { from, to } => {
                window_page(state, grant, from, to, self.after.as_ref(), limit).await
            }
            EventMode::Since(since) => {
                since_page(state, grant, since, self.after.as_ref(), limit).await
            }
        }
    }

    pub fn is_incremental(&self) -> bool {
        matches!(self.mode, EventMode::Since(_))
    }

    /// 判断组合成员身份用的时刻：时间窗用 `min(to, 现在)`，增量用现在（或给出的 to）。
    pub fn membership_time(&self, now: Timestamp) -> Timestamp {
        match self.mode {
            EventMode::Window { to, .. } => to.min(now),
            EventMode::Since(_) => self.filters.to.map_or(now, |to| to.min(now)),
        }
    }
}
