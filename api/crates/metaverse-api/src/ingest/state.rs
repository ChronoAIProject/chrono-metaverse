//! 公开状态的增量计算（设计 5.5 `GET .../state?at=`）。
//!
//! 规则与 `metaverse_core::events::state_at` 相同，只是分批进行，可以从状态快照接着算：
//!
//! 1. 每一批是按 `at` 排好序的原始记录（原事件和更正；更正的 `at` 与原事件相同，所以总在
//!    同一批里）；先用 [`metaverse_core::events::public_events`] 应用更正、按可见级别过滤、
//!    投影公开字段；
//! 2. 按 (at, recordedAt, 编号) 的顺序折叠：带 `state` 的事件覆盖同一 (锚点, key) 的状态，
//!    `clears` 表示状态结束；
//! 3. 查询时刻再去掉超过 `maxAgeSec` 的状态和非公开锚点上的状态。
//!
//! 公开状态只由公开事件算出，所以网站在"现在"模式下用公开事件增量算出的状态和这里一致；
//! 状态值取自投影后的数据，没登记成公开字段的值是 `null`。

use std::collections::{BTreeMap, BTreeSet};

use metaverse_core::events::{public_events, value_at_path, TypeLookup};
use metaverse_core::ids::SPACE_ANCHOR_ID;
use metaverse_core::model::{Event, SnapshotState};
use metaverse_core::Timestamp;
use serde_json::Value;

#[derive(Debug, Clone, Default)]
pub struct StateFold {
    states: BTreeMap<(String, String), SnapshotState>,
    /// 已折叠的原始记录数（决定要不要保存快照）。
    pub folded: usize,
}

impl StateFold {
    pub fn from_snapshot(states: Vec<SnapshotState>) -> Self {
        Self {
            states: states
                .into_iter()
                .map(|state| ((state.anchor_id.clone(), state.key.clone()), state))
                .collect(),
            folded: 0,
        }
    }

    /// 折叠一批记录。调用方保证批与批之间按 `at` 递增、同一 `at` 的记录不跨批。
    pub fn apply(&mut self, records: &[Event], types: &dyn TypeLookup) {
        self.folded += records.len();
        for event in public_events(records, types) {
            let Some(event_type) = types.event_type(&event.event_type, event.type_version) else {
                continue;
            };
            let Some(rule) = &event_type.state else {
                continue;
            };
            let key = (event.anchor_id.clone(), rule.key.clone());
            if rule.clears {
                self.states.remove(&key);
                continue;
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
            self.states.insert(
                key.clone(),
                SnapshotState {
                    anchor_id: key.0,
                    key: key.1,
                    value,
                    since: event.at,
                    event_id: event.id,
                    event_type: event.event_type,
                    type_version: event.type_version,
                    // public_events 已经按公开字段投影过。
                    data: event.data,
                },
            );
        }
    }

    /// 存进快照的内容（不按时刻过滤：过期是单调的，到时候再判断）。
    pub fn snapshot_states(&self) -> Vec<SnapshotState> {
        self.states.values().cloned().collect()
    }

    /// T 时刻的公开状态：去掉过期的和非公开锚点上的。
    pub fn states_at(
        &self,
        t: Timestamp,
        types: &dyn TypeLookup,
        public_anchors: &BTreeSet<String>,
    ) -> Vec<SnapshotState> {
        self.states
            .values()
            .filter(|state| {
                state.anchor_id == SPACE_ANCHOR_ID || public_anchors.contains(&state.anchor_id)
            })
            .filter(|state| {
                let max_age = types
                    .event_type(&state.event_type, state.type_version)
                    .and_then(|event_type| event_type.max_age_sec);
                max_age.is_none_or(|max| t.millis_since(state.since) <= i64::from(max) * 1000)
            })
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use metaverse_core::events::{apply_corrections, state_at};
    use metaverse_core::model::{
        DataVisibility, Display, DisplayKind, EventType, Owner, StateRule,
    };
    use serde_json::json;

    fn ts(seconds: i64) -> Timestamp {
        Timestamp::from_millis(seconds * 1000).unwrap()
    }

    fn event(id: &str, at: i64, kind: &str, anchor: &str, data: Value) -> Event {
        Event {
            id: id.into(),
            space_id: "restaurant".into(),
            owner: Owner::org("org-1"),
            at: ts(at),
            recorded_at: ts(at),
            source: "pos".into(),
            source_event_id: id.into(),
            event_type: Some(kind.into()),
            type_version: Some(1),
            anchor_id: Some(anchor.into()),
            data: Some(data),
            visibility: Some(DataVisibility::Public),
            correlation_id: None,
            corrects: None,
            retracted: false,
            redacted: false,
            actor: None,
        }
    }

    fn types() -> BTreeMap<(String, u32), EventType> {
        let display = Display {
            kind: DisplayKind::Highlight,
            icon: None,
            color: None,
            duration_sec: None,
            label_template: None,
            entity_asset: None,
            path_role: None,
            heat: None,
        };
        let mut map = BTreeMap::new();
        for (name, clears) in [("seated", false), ("left", true)] {
            map.insert(
                (name.to_owned(), 1),
                EventType {
                    space_id: "restaurant".into(),
                    name: name.into(),
                    version: 1,
                    schema: json!({}),
                    public_fields: vec!["guests".into()],
                    default_visibility: DataVisibility::Public,
                    state: Some(StateRule {
                        key: "occupancy".into(),
                        value: (!clears).then(|| "guests".to_owned()),
                        clears,
                    }),
                    max_age_sec: Some(100),
                    display: display.clone(),
                },
            );
        }
        map
    }

    #[test]
    fn batched_fold_matches_the_core_rule() {
        let types = types();
        let records = [
            event("a", 10, "seated", "t1", json!({"guests": 2, "amount": 9})),
            event("b", 20, "seated", "t2", json!({"guests": 3})),
            event("c", 30, "left", "t1", json!({})),
            event("d", 40, "seated", "t1", json!({"guests": 5})),
        ];
        let anchors: BTreeSet<String> = ["t1", "t2"].iter().map(|s| (*s).to_owned()).collect();
        for t in [5, 15, 25, 35, 45, 125, 200] {
            let upto: Vec<_> = records.iter().filter(|e| e.at <= ts(t)).cloned().collect();
            // 分两批折叠，与一次算出的结果相同。
            let (first, second) = upto.split_at(upto.len() / 2);
            let mut fold = StateFold::default();
            fold.apply(first, &types);
            let resumed = StateFold::from_snapshot(fold.snapshot_states());
            let mut fold = resumed;
            fold.apply(second, &types);
            let ours: Vec<_> = fold
                .states_at(ts(t), &types, &anchors)
                .into_iter()
                .map(|s| (s.anchor_id, s.value, s.since))
                .collect();
            let reference = state_at(&apply_corrections(&upto), &types, ts(t));
            let core: Vec<_> = reference
                .into_values()
                .map(|s| (s.anchor_id, s.value, s.since))
                .collect();
            assert_eq!(ours, core, "t = {t}");
        }
    }

    #[test]
    fn internal_events_and_anchors_do_not_leak() {
        let types = types();
        let mut hidden = event("a", 10, "seated", "t1", json!({"guests": 2}));
        hidden.visibility = Some(DataVisibility::Internal);
        let mut fold = StateFold::default();
        fold.apply(
            &[
                hidden,
                event("b", 10, "seated", "safe", json!({"guests": 1})),
            ],
            &types,
        );
        let anchors: BTreeSet<String> = ["t1"].iter().map(|s| (*s).to_owned()).collect();
        assert!(fold.states_at(ts(11), &types, &anchors).is_empty());
        assert_eq!(fold.snapshot_states().len(), 1);
    }
}
