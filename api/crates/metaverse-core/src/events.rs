//! 现实事件的语义（设计 5.3–5.5）。
//!
//! - **更正**：替换（完整的新记录，`at` 与原事件相同）或撤回（`retracted: true`，
//!   不带内容）。`corrects` 一律指向最初那条事件；同一事件有多条更正时，以
//!   `recordedAt` 最新的一条为准（相同时按编号大者为准，保证确定性）。
//! - **公开过滤顺序**：先应用更正，再按可见级别过滤，所以被替换掉的原版本永远
//!   不会出现在公开结果里。
//! - **状态事件**：事件类型带 `state` 时，对每个 (锚点, state.key) 取 `at ≤ T` 的
//!   最后一条有效事件，不受时间窗限制；`clears` 表示状态结束；超过 `maxAgeSec`
//!   没更新就失效。
//! - **瞬时事件**：没有 `state` 的事件，在 `[at, at + durationSec)` 内显示。

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::ids::{is_object_id, is_space_id};
use crate::model::{DataVisibility, Event, EventType, PathRole};
use crate::Timestamp;

/// `at` 最多比服务端记录时间晚这么多（毫秒），超过就拒收。
pub const MAX_FUTURE_SKEW_MS: i64 = 5 * 60 * 1000;
/// 事件 `data` 规范化后的最大字节数。
pub const MAX_EVENT_DATA_BYTES: usize = 4 * 1024;
/// 每批事件的上限。
pub const MAX_EVENTS_PER_BATCH: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EventError {
    #[error("事件时间晚于记录时间 5 分钟以上")]
    TooFarInFuture,
    #[error("更正不合法：{0}")]
    Correction(&'static str),
    #[error("correlationId 格式不对，应为 <空间编号>:<编号>")]
    CorrelationFormat,
    #[error("起点事件的 correlationId 必须以本空间编号开头")]
    CorrelationOrigin,
    #[error("data 超过 4KB")]
    DataTooLarge,
}

/// 拒收"未来"的事件：`at > recordedAt + 5 分钟`。
pub fn validate_event_time(at: Timestamp, recorded_at: Timestamp) -> Result<(), EventError> {
    if at.millis_since(recorded_at) > MAX_FUTURE_SKEW_MS {
        Err(EventError::TooFarInFuture)
    } else {
        Ok(())
    }
}

/// `data` 的大小上限。
pub fn validate_event_data(data: &Value) -> Result<(), EventError> {
    match crate::canonical::canonical_json(data) {
        Ok(text) if text.len() <= MAX_EVENT_DATA_BYTES => Ok(()),
        _ => Err(EventError::DataTooLarge),
    }
}

/// 一条更正是否合法地指向它的原事件。
pub fn validate_correction(original: &Event, correction: &Event) -> Result<(), EventError> {
    use EventError::Correction;
    if correction.corrects.as_deref() != Some(original.id.as_str()) {
        return Err(Correction("corrects 必须指向原事件"));
    }
    if original.corrects.is_some() {
        return Err(Correction(
            "corrects 必须指向最初那条事件，不能指向另一条更正",
        ));
    }
    if correction.space_id != original.space_id || correction.source != original.source {
        return Err(Correction("更正必须在同一空间、同一数据源"));
    }
    if correction.retracted {
        if correction.event_type.is_some()
            || correction.data.is_some()
            || correction.anchor_id.is_some()
        {
            return Err(Correction("撤回不带内容"));
        }
    } else {
        if correction.at != original.at {
            return Err(Correction(
                "替换的 at 必须与原事件相同；时间录错了请先撤回再新写",
            ));
        }
        if correction.event_type.is_none() || correction.anchor_id.is_none() {
            return Err(Correction("替换必须是完整的新记录"));
        }
    }
    Ok(())
}

/// `correlationId` = `<发起空间编号>:<编号>`；起点事件只能写在前缀对应的空间里。
pub fn validate_correlation_id(
    space_id: &str,
    correlation_id: &str,
    role: Option<PathRole>,
) -> Result<(), EventError> {
    let (prefix, id) = correlation_id
        .split_once(':')
        .ok_or(EventError::CorrelationFormat)?;
    if !is_space_id(prefix) || !is_object_id(id) {
        return Err(EventError::CorrelationFormat);
    }
    if role == Some(PathRole::Origin) && prefix != space_id {
        return Err(EventError::CorrelationOrigin);
    }
    Ok(())
}

/// 应用更正之后的事件。`id` 是最初那条事件的编号。
#[derive(Debug, Clone, PartialEq)]
pub struct EffectiveEvent {
    pub id: String,
    pub at: Timestamp,
    /// 生效版本的记录时间（增量拉取的游标按它走）。
    pub recorded_at: Timestamp,
    pub source: String,
    pub event_type: String,
    pub type_version: u32,
    pub anchor_id: String,
    /// 被抹除时为空。
    pub data: Option<Value>,
    pub visibility: Option<DataVisibility>,
    pub correlation_id: Option<String>,
    /// 是否被替换过。
    pub corrected: bool,
}

fn content_of(original: &Event, version: &Event, corrected: bool) -> Option<EffectiveEvent> {
    Some(EffectiveEvent {
        id: original.id.clone(),
        at: original.at,
        recorded_at: version.recorded_at,
        source: original.source.clone(),
        event_type: version.event_type.clone()?,
        type_version: version.type_version.unwrap_or(1),
        anchor_id: version.anchor_id.clone()?,
        data: if version.redacted {
            None
        } else {
            version.data.clone()
        },
        visibility: version.visibility,
        correlation_id: version.correlation_id.clone(),
        corrected,
    })
}

/// 应用更正：每条原事件取 `recordedAt` 最新的更正；撤回的事件去掉。
/// 不合法的更正（见 [`validate_correction`]）和找不到原事件的更正都忽略。
/// 结果按 (at, recordedAt, 编号) 排序。
pub fn apply_corrections(events: &[Event]) -> Vec<EffectiveEvent> {
    let originals: BTreeMap<&str, &Event> = events
        .iter()
        .filter(|event| event.corrects.is_none())
        .map(|event| (event.id.as_str(), event))
        .collect();
    let mut winners: BTreeMap<&str, &Event> = BTreeMap::new();
    for correction in events.iter().filter(|event| event.corrects.is_some()) {
        let target = correction.corrects.as_deref().expect("已过滤");
        let Some(original) = originals.get(target) else {
            continue;
        };
        if validate_correction(original, correction).is_err() {
            continue;
        }
        let replace = winners.get(target).is_none_or(|current| {
            (correction.recorded_at, correction.id.as_str())
                > (current.recorded_at, current.id.as_str())
        });
        if replace {
            winners.insert(target, correction);
        }
    }
    let mut result: Vec<_> = originals
        .values()
        .filter_map(|original| match winners.get(original.id.as_str()) {
            Some(winner) if winner.retracted => None,
            Some(winner) => content_of(original, winner, true),
            None => content_of(original, original, false),
        })
        .collect();
    result.sort_by(|a, b| {
        (a.at, a.recorded_at, a.id.as_str()).cmp(&(b.at, b.recorded_at, b.id.as_str()))
    });
    result
}

/// 按 (类型名, 版本) 查事件类型。回放用 T 时生效的版本，也就是事件记录的版本。
pub trait TypeLookup {
    fn event_type(&self, name: &str, version: u32) -> Option<&EventType>;
}

impl TypeLookup for BTreeMap<(String, u32), EventType> {
    fn event_type(&self, name: &str, version: u32) -> Option<&EventType> {
        self.get(&(name.to_owned(), version))
    }
}

/// 生效的可见级别：事件自己写的，否则取类型默认值；类型找不到时按内部级处理。
pub fn effective_visibility(event: &EffectiveEvent, types: &dyn TypeLookup) -> DataVisibility {
    event.visibility.unwrap_or_else(|| {
        types
            .event_type(&event.event_type, event.type_version)
            .map_or(DataVisibility::Internal, |t| t.default_visibility)
    })
}

/// 按点分路径取值，例如 `guests` 或 `party.size`。
pub fn value_at_path<'a>(data: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(data, |current, segment| current.as_object()?.get(segment))
}

/// 只保留事件类型登记的公开字段。
pub fn project_public_fields(data: &Value, public_fields: &[String]) -> Value {
    let mut projected = Map::new();
    for path in public_fields {
        if let Some(value) = value_at_path(data, path) {
            let segments: Vec<_> = path.split('.').collect();
            insert_path(&mut projected, &segments, value.clone());
        }
    }
    Value::Object(projected)
}

fn insert_path(target: &mut Map<String, Value>, segments: &[&str], value: Value) {
    match segments {
        [] => {}
        [last] => {
            target.insert((*last).to_owned(), value);
        }
        [first, rest @ ..] => {
            let child = target
                .entry((*first).to_owned())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Value::Object(map) = child {
                insert_path(map, rest, value);
            }
        }
    }
}

/// 公开接口看到的事件：先应用更正，再按可见级别过滤，`data` 只保留公开字段。
pub fn public_events(events: &[Event], types: &dyn TypeLookup) -> Vec<EffectiveEvent> {
    apply_corrections(events)
        .into_iter()
        .filter(|event| effective_visibility(event, types) == DataVisibility::Public)
        .filter_map(|mut event| {
            let event_type = types.event_type(&event.event_type, event.type_version)?;
            event.data = event
                .data
                .as_ref()
                .map(|data| project_public_fields(data, &event_type.public_fields));
            Some(event)
        })
        .collect()
}

/// 某锚点某个状态 key 在 T 时刻的值。
#[derive(Debug, Clone, PartialEq)]
pub struct AnchorState {
    pub anchor_id: String,
    pub key: String,
    pub value: Value,
    pub since: Timestamp,
    pub event_id: String,
    pub event_type: String,
}

/// T 时刻各 (锚点, 状态 key) 的状态。`events` 是已应用更正的事件。
pub fn state_at(
    events: &[EffectiveEvent],
    types: &dyn TypeLookup,
    t: Timestamp,
) -> BTreeMap<(String, String), AnchorState> {
    let mut latest: BTreeMap<(String, String), (&EffectiveEvent, &EventType)> = BTreeMap::new();
    for event in events.iter().filter(|event| event.at <= t) {
        let Some(event_type) = types.event_type(&event.event_type, event.type_version) else {
            continue;
        };
        let Some(rule) = &event_type.state else {
            continue;
        };
        let key = (event.anchor_id.clone(), rule.key.clone());
        let newer = latest.get(&key).is_none_or(|(current, _)| {
            (event.at, event.recorded_at, event.id.as_str())
                > (current.at, current.recorded_at, current.id.as_str())
        });
        if newer {
            latest.insert(key, (event, event_type));
        }
    }
    latest
        .into_iter()
        .filter_map(|((anchor_id, key), (event, event_type))| {
            let rule = event_type.state.as_ref().expect("已过滤");
            if rule.clears {
                return None;
            }
            if let Some(max_age) = event_type.max_age_sec {
                if t.millis_since(event.at) > i64::from(max_age) * 1000 {
                    return None;
                }
            }
            let value = match &rule.value {
                Some(path) => event
                    .data
                    .as_ref()
                    .and_then(|data| value_at_path(data, path))
                    .cloned()
                    .unwrap_or(Value::Null),
                None => Value::String(event.event_type.clone()),
            };
            Some((
                (anchor_id.clone(), key.clone()),
                AnchorState {
                    anchor_id,
                    key,
                    value,
                    since: event.at,
                    event_id: event.id.clone(),
                    event_type: event.event_type.clone(),
                },
            ))
        })
        .collect()
}

/// T 时刻正在显示的瞬时事件：没有 `state` 的事件，`at ≤ T < at + 时长`。
/// 时长取显示规则的 `durationSec`，没给就用 `default_window_sec`。
pub fn instant_events_at<'a>(
    events: &'a [EffectiveEvent],
    types: &dyn TypeLookup,
    t: Timestamp,
    default_window_sec: u32,
) -> Vec<&'a EffectiveEvent> {
    events
        .iter()
        .filter(|event| {
            let Some(event_type) = types.event_type(&event.event_type, event.type_version) else {
                return false;
            };
            if event_type.state.is_some() {
                return false;
            }
            let window = event_type
                .display
                .duration_sec
                .unwrap_or(default_window_sec);
            event.at <= t && t.millis_since(event.at) < i64::from(window) * 1000
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Display, DisplayKind, Owner, StateRule};
    use serde_json::json;

    fn ts(seconds: i64) -> Timestamp {
        Timestamp::from_millis(seconds * 1000).unwrap()
    }

    fn event(id: &str, at: i64, recorded: i64, kind: &str, anchor: &str, data: Value) -> Event {
        Event {
            id: id.into(),
            space_id: "restaurant".into(),
            owner: Owner::org("org-1"),
            at: ts(at),
            recorded_at: ts(recorded),
            source: "pos".into(),
            source_event_id: id.into(),
            event_type: Some(kind.into()),
            type_version: Some(1),
            anchor_id: Some(anchor.into()),
            data: Some(data),
            visibility: None,
            correlation_id: None,
            corrects: None,
            retracted: false,
            redacted: false,
            actor: None,
        }
    }

    fn correction(id: &str, of: &Event, recorded: i64, data: Option<Value>) -> Event {
        let mut fixed = of.clone();
        fixed.id = id.into();
        fixed.source_event_id = id.into();
        fixed.recorded_at = ts(recorded);
        fixed.corrects = Some(of.id.clone());
        match data {
            Some(data) => fixed.data = Some(data),
            None => {
                fixed.retracted = true;
                fixed.event_type = None;
                fixed.anchor_id = None;
                fixed.data = None;
                fixed.type_version = None;
            }
        }
        fixed
    }

    fn types() -> BTreeMap<(String, u32), EventType> {
        let display = |kind, duration| Display {
            kind,
            icon: None,
            color: None,
            duration_sec: duration,
            label_template: None,
            entity_asset: None,
            path_role: None,
            heat: None,
        };
        let mut types = BTreeMap::new();
        types.insert(
            ("table.occupancy".to_owned(), 1),
            EventType {
                space_id: "restaurant".into(),
                name: "table.occupancy".into(),
                version: 1,
                schema: json!({}),
                public_fields: vec!["guests".into()],
                default_visibility: DataVisibility::Public,
                state: Some(StateRule {
                    key: "occupancy".into(),
                    value: Some("guests".into()),
                    clears: false,
                }),
                max_age_sec: Some(3600),
                display: display(DisplayKind::Highlight, None),
            },
        );
        types.insert(
            ("table.cleared".to_owned(), 1),
            EventType {
                space_id: "restaurant".into(),
                name: "table.cleared".into(),
                version: 1,
                schema: json!({}),
                public_fields: vec![],
                default_visibility: DataVisibility::Public,
                state: Some(StateRule {
                    key: "occupancy".into(),
                    value: None,
                    clears: true,
                }),
                max_age_sec: None,
                display: display(DisplayKind::Highlight, None),
            },
        );
        types.insert(
            ("order.served".to_owned(), 1),
            EventType {
                space_id: "restaurant".into(),
                name: "order.served".into(),
                version: 1,
                schema: json!({}),
                public_fields: vec!["dish".into()],
                default_visibility: DataVisibility::Internal,
                state: None,
                max_age_sec: None,
                display: display(DisplayKind::Icon, Some(3)),
            },
        );
        types
    }

    #[test]
    fn latest_recorded_correction_wins_and_retraction_removes() {
        let original = event(
            "e1",
            100,
            100,
            "table.occupancy",
            "t1",
            json!({"guests": 2}),
        );
        let first = correction("e2", &original, 200, Some(json!({"guests": 3})));
        let second = correction("e3", &original, 300, Some(json!({"guests": 4})));
        let effective = apply_corrections(&[second.clone(), original.clone(), first.clone()]);
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].id, "e1");
        assert_eq!(effective[0].data, Some(json!({"guests": 4})));
        assert_eq!(effective[0].recorded_at, ts(300));
        let retract = correction("e4", &original, 400, None);
        assert!(apply_corrections(&[original.clone(), first, retract.clone()]).is_empty());
        // 更正的更正不算数。
        let mut chained = correction("e5", &original, 500, Some(json!({"guests": 9})));
        chained.corrects = Some("e4".into());
        assert!(apply_corrections(&[original, retract, chained]).is_empty());
    }

    #[test]
    fn correction_rules() {
        let original = event("e1", 100, 100, "table.occupancy", "t1", json!({}));
        let mut moved = correction("e2", &original, 200, Some(json!({})));
        moved.at = ts(150);
        assert!(validate_correction(&original, &moved).is_err());
        let mut other_source = correction("e3", &original, 200, Some(json!({})));
        other_source.source = "camera".into();
        assert!(validate_correction(&original, &other_source).is_err());
        assert!(validate_correction(&original, &correction("e4", &original, 200, None)).is_ok());
        assert!(validate_event_time(ts(400), ts(100)).is_ok());
        assert!(validate_event_time(ts(401), ts(100)).is_err());
        assert!(validate_event_time(ts(0), ts(100)).is_ok());
    }

    #[test]
    fn public_filter_applies_corrections_first() {
        let types = types();
        let mut original = event(
            "e1",
            100,
            100,
            "table.occupancy",
            "t1",
            json!({"guests": 2, "amount": 80}),
        );
        original.visibility = Some(DataVisibility::Public);
        let mut hidden = correction("e2", &original, 200, Some(json!({"guests": 2})));
        hidden.visibility = Some(DataVisibility::Internal);
        assert!(public_events(&[original.clone(), hidden], &types).is_empty());
        let visible = public_events(&[original], &types);
        assert_eq!(visible[0].data, Some(json!({"guests": 2})));
        let served = event("e9", 100, 100, "order.served", "t1", json!({"dish": "面"}));
        assert!(public_events(&[served], &types).is_empty());
    }

    #[test]
    fn state_events_last_value_clears_and_expiry() {
        let types = types();
        let events = apply_corrections(&[
            event("a", 100, 100, "table.occupancy", "t1", json!({"guests": 2})),
            event("b", 200, 200, "table.occupancy", "t1", json!({"guests": 4})),
            event("c", 300, 300, "table.cleared", "t1", json!({})),
            event("d", 150, 150, "table.occupancy", "t2", json!({"guests": 1})),
        ]);
        let at_250 = state_at(&events, &types, ts(250));
        let t1 = &at_250[&("t1".to_owned(), "occupancy".to_owned())];
        assert_eq!(t1.value, json!(4));
        assert_eq!(t1.since, ts(200));
        assert_eq!(at_250.len(), 2);
        let at_350 = state_at(&events, &types, ts(350));
        assert!(!at_350.contains_key(&("t1".to_owned(), "occupancy".to_owned())));
        // t2 一小时没更新就失效。
        assert!(state_at(&events, &types, ts(150 + 3601)).is_empty());
        assert!(state_at(&events, &types, ts(50)).is_empty());
    }

    #[test]
    fn instant_events_use_display_duration() {
        let types = types();
        let events = apply_corrections(&[
            event("s", 100, 100, "order.served", "t1", json!({})),
            event("o", 100, 100, "table.occupancy", "t1", json!({"guests": 2})),
        ]);
        assert_eq!(instant_events_at(&events, &types, ts(102), 10).len(), 1);
        assert!(instant_events_at(&events, &types, ts(103), 10).is_empty());
        assert!(instant_events_at(&events, &types, ts(99), 10).is_empty());
    }

    #[test]
    fn correlation_ids() {
        assert!(validate_correlation_id("florist", "florist:d-1", Some(PathRole::Origin)).is_ok());
        assert_eq!(
            validate_correlation_id("restaurant", "florist:d-1", Some(PathRole::Origin)),
            Err(EventError::CorrelationOrigin)
        );
        assert!(
            validate_correlation_id("restaurant", "florist:d-1", Some(PathRole::Destination))
                .is_ok()
        );
        assert!(validate_correlation_id("restaurant", "d-1", None).is_err());
    }

    #[test]
    fn public_projection_keeps_nested_paths() {
        let data = json!({"party": {"size": 3, "name": "x"}, "amount": 9});
        assert_eq!(
            project_public_fields(&data, &["party.size".into(), "missing".into()]),
            json!({"party": {"size": 3}})
        );
        assert!(validate_event_data(&json!({"x": "y".repeat(5000)})).is_err());
    }
}
