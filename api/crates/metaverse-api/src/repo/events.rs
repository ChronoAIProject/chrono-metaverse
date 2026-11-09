//! 现实事件、事件类型、状态快照（设计 5.3–5.5、13.2）。
//!
//! - 事件只追加：原事件和更正都是独立的记录，`(spaceId, source, sourceEventId)` 唯一，
//!   编号由这三项算出（[`metaverse_core::model::event_id`]），重试安全；
//! - 唯一的修改是管理接口的"抹除"：去掉内容、标记 `redacted`；
//! - 事件类型只追加版本，`(spaceId, type, version)` 唯一，文档上冗余主人；
//! - 读写都要求空间的授权凭据，条件带上空间编号和主人；状态快照由系统范围写入。

use std::collections::{BTreeMap, BTreeSet};

use metaverse_core::model::{Event, EventType, Owner, StateSnapshot};
use metaverse_core::Timestamp;
use mongodb::bson::{doc, Bson, Document};
use mongodb::error::ErrorKind;
use serde::Serialize;

use super::uploads::{from_document, owner_kind, space_children, to_document};
use super::{collections, Repo, RepoError};
use crate::auth::{Grant, SystemGrant};

/// 一次最多读多少条事件类型版本。
const MAX_EVENT_TYPES: i64 = 2000;

#[derive(Serialize)]
struct EventTypeDocument<'a> {
    #[serde(flatten)]
    event_type: &'a EventType,
    owner: &'a Owner,
}

/// 批量写入时每条事件的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventInsert {
    Created,
    /// `(spaceId, source, sourceEventId)` 已存在。
    Duplicate,
}

/// 分页游标：上一页最后一条的 (时间, 编号)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub at: Timestamp,
    pub id: String,
}

/// 范围下界。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lower {
    None,
    Exclusive(Timestamp),
    Inclusive(Timestamp),
}

async fn collect<T: serde::de::DeserializeOwned>(
    mut cursor: mongodb::Cursor<Document>,
) -> Result<Vec<T>, RepoError> {
    let mut items = Vec::new();
    while cursor.advance().await? {
        let document: Document = cursor
            .deserialize_current()
            .map_err(|error| RepoError::Corrupt(error.to_string()))?;
        items.push(from_document(document)?);
    }
    Ok(items)
}

fn after_filter(field: &str, cursor: &Cursor) -> Document {
    doc! {"$or": [
        {field: {"$gt": cursor.at.to_rfc3339()}},
        {field: cursor.at.to_rfc3339(), "_id": {"$gt": &cursor.id}},
    ]}
}

fn system_children(grant: &SystemGrant) -> Document {
    doc! {
        "spaceId": grant.space_id(),
        "owner.kind": owner_kind(grant.owner()),
        "owner.id": &grant.owner().id,
    }
}

impl Repo {
    // ----------------------------------------------------------------- 事件类型

    /// 本空间全部事件类型版本。
    pub async fn event_types(&self, grant: &Grant) -> Result<Vec<EventType>, RepoError> {
        let cursor = self
            .collection(collections::EVENT_TYPES)
            .find(space_children(grant))
            .sort(doc! {"type": 1, "version": 1})
            .limit(MAX_EVENT_TYPES)
            .await?;
        collect(cursor).await
    }

    /// 登记事件类型的新版本。版本号冲突时返回 `Duplicate`，调用方重读最新版本后重试。
    pub async fn insert_event_type(
        &self,
        grant: &Grant,
        event_type: &EventType,
    ) -> Result<(), RepoError> {
        if !grant.can_manage() || event_type.space_id != grant.space_id() {
            return Err(RepoError::GrantMismatch);
        }
        let document = to_document(&EventTypeDocument {
            event_type,
            owner: grant.owner(),
        })?;
        self.collection(collections::EVENT_TYPES)
            .insert_one(document)
            .await?;
        Ok(())
    }

    // ----------------------------------------------------------------- 写事件

    /// 批量写入（不按顺序，重复的跳过）。返回值与输入一一对应。
    pub async fn insert_events(
        &self,
        grant: &Grant,
        events: &[Event],
    ) -> Result<Vec<EventInsert>, RepoError> {
        if !grant.can_manage()
            || events
                .iter()
                .any(|event| event.space_id != grant.space_id() || &event.owner != grant.owner())
        {
            return Err(RepoError::GrantMismatch);
        }
        let mut results = vec![EventInsert::Created; events.len()];
        if events.is_empty() {
            return Ok(results);
        }
        let documents = events
            .iter()
            .map(to_document)
            .collect::<Result<Vec<_>, _>>()?;
        match self
            .collection(collections::EVENTS)
            .insert_many(documents)
            .ordered(false)
            .await
        {
            Ok(_) => Ok(results),
            Err(error) => {
                let ErrorKind::InsertMany(failure) = error.kind.as_ref() else {
                    return Err(error.into());
                };
                if failure.write_concern_error.is_some() {
                    return Err(RepoError::Unavailable);
                }
                for write in failure.write_errors.iter().flatten() {
                    if write.code != 11000 {
                        tracing::warn!(code = write.code, "写事件失败");
                        return Err(RepoError::Unavailable);
                    }
                    if let Some(slot) = results.get_mut(write.index) {
                        *slot = EventInsert::Duplicate;
                    }
                }
                Ok(results)
            }
        }
    }

    // ----------------------------------------------------------------- 读事件

    /// 按编号读一条记录（原事件或更正）。
    pub async fn event(&self, grant: &Grant, event_id: &str) -> Result<Option<Event>, RepoError> {
        let mut filter = space_children(grant);
        filter.insert("_id", event_id);
        self.collection(collections::EVENTS)
            .find_one(filter)
            .await?
            .map(from_document)
            .transpose()
    }

    /// 按编号批量读原事件（不含更正）。
    pub async fn originals(&self, grant: &Grant, ids: &[String]) -> Result<Vec<Event>, RepoError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut filter = space_children(grant);
        filter.insert("_id", doc! {"$in": ids});
        filter.insert("corrects", doc! {"$exists": false});
        let cursor = self.collection(collections::EVENTS).find(filter).await?;
        collect(cursor).await
    }

    /// 指向这些原事件的更正，最多 `limit` 条（取记录时间最新的；调用方事先按
    /// [`Repo::correction_counts`] 控制总量，这里只防计数之后又写入的）。
    pub async fn corrections_for(
        &self,
        grant: &Grant,
        ids: &[String],
        limit: i64,
    ) -> Result<Vec<Event>, RepoError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut filter = space_children(grant);
        filter.insert("corrects", doc! {"$in": ids});
        let cursor = self
            .collection(collections::EVENTS)
            .find(filter)
            .sort(doc! {"recordedAt": -1, "_id": -1})
            .limit(limit)
            .await?;
        collect(cursor).await
    }

    /// 每条原事件已有的更正条数（不算 `exclude` 里的编号：同一批重试时不重复计数）。
    pub async fn correction_counts(
        &self,
        grant: &Grant,
        ids: &[String],
        exclude: &[String],
    ) -> Result<BTreeMap<String, u64>, RepoError> {
        let mut counts = BTreeMap::new();
        if ids.is_empty() {
            return Ok(counts);
        }
        let mut filter = space_children(grant);
        filter.insert("corrects", doc! {"$in": ids});
        if !exclude.is_empty() {
            filter.insert("_id", doc! {"$nin": exclude});
        }
        let mut cursor = self
            .collection(collections::EVENTS)
            .aggregate([
                doc! {"$match": filter},
                doc! {"$group": {"_id": "$corrects", "count": {"$sum": 1}}},
            ])
            .await?;
        while cursor.advance().await? {
            let row: Document = cursor
                .deserialize_current()
                .map_err(|error| RepoError::Corrupt(error.to_string()))?;
            let count = match row.get("count") {
                Some(Bson::Int32(n)) => u64::try_from(*n).unwrap_or(0),
                Some(Bson::Int64(n)) => u64::try_from(*n).unwrap_or(0),
                _ => 0,
            };
            if let Ok(id) = row.get_str("_id") {
                counts.insert(id.to_owned(), count);
            }
        }
        Ok(counts)
    }

    /// 时间窗 `[from, to)` 里的原事件，按 (at, 编号) 排序分页。
    pub async fn originals_in_window(
        &self,
        grant: &Grant,
        from: Timestamp,
        to: Timestamp,
        after: Option<&Cursor>,
        limit: i64,
    ) -> Result<Vec<Event>, RepoError> {
        let mut filter = space_children(grant);
        filter.insert("corrects", doc! {"$exists": false});
        filter.insert(
            "at",
            doc! {"$gte": from.to_rfc3339(), "$lt": to.to_rfc3339()},
        );
        if let Some(after) = after {
            filter.insert("$and", vec![after_filter("at", after)]);
        }
        super::restrict_to_membership(&mut filter, grant, "at");
        let cursor = self
            .collection(collections::EVENTS)
            .find(filter)
            .sort(doc! {"at": 1, "_id": 1})
            .limit(limit)
            .await?;
        collect(cursor).await
    }

    /// `recordedAt ≥ since` 的全部记录（原事件和更正），按 (recordedAt, 编号) 排序分页。
    pub async fn records_since(
        &self,
        grant: &Grant,
        since: Timestamp,
        after: Option<&Cursor>,
        limit: i64,
    ) -> Result<Vec<Event>, RepoError> {
        let mut filter = space_children(grant);
        filter.insert("recordedAt", doc! {"$gte": since.to_rfc3339()});
        if let Some(after) = after {
            filter.insert("$and", vec![after_filter("recordedAt", after)]);
        }
        // 更正的 at 与原事件相同，所以按 at 裁剪时原事件和它的更正一起留下或去掉。
        super::restrict_to_membership(&mut filter, grant, "at");
        let cursor = self
            .collection(collections::EVENTS)
            .find(filter)
            .sort(doc! {"recordedAt": 1, "_id": 1})
            .limit(limit)
            .await?;
        collect(cursor).await
    }

    /// 按 `at` 排序的全部记录（原事件和更正），`lower < at ≤ upper`（或 `≥ lower`）。
    /// 状态计算用：更正的 `at` 与原事件相同，所以总和原事件一起出现。
    pub async fn records_by_at(
        &self,
        grant: &Grant,
        lower: Lower,
        upper: Timestamp,
        limit: Option<i64>,
    ) -> Result<Vec<Event>, RepoError> {
        let mut range = doc! {"$lte": upper.to_rfc3339()};
        match lower {
            Lower::None => {}
            Lower::Exclusive(at) => {
                range.insert("$gt", at.to_rfc3339());
            }
            Lower::Inclusive(at) => {
                range.insert("$gte", at.to_rfc3339());
            }
        }
        let mut filter = space_children(grant);
        filter.insert("at", range);
        let events = self.collection(collections::EVENTS);
        let mut find = events.find(filter).sort(doc! {"at": 1, "_id": 1});
        if let Some(limit) = limit {
            find = find.limit(limit);
        }
        collect(find.await?).await
    }

    /// 最新一条公开级记录（原事件或替换）的记录时间，只算 `public_anchors` 上的。
    pub async fn latest_public_recorded_at(
        &self,
        grant: &Grant,
        public_anchors: &BTreeSet<String>,
    ) -> Result<Option<Timestamp>, RepoError> {
        let mut filter = space_children(grant);
        filter.insert("visibility", "public");
        filter.insert("retracted", doc! {"$ne": true});
        filter.insert(
            "anchorId",
            doc! {"$in": public_anchors.iter().collect::<Vec<_>>()},
        );
        super::restrict_to_membership(&mut filter, grant, "at");
        let found = self
            .collection(collections::EVENTS)
            .find_one(filter)
            .sort(doc! {"recordedAt": -1})
            .projection(doc! {"recordedAt": 1})
            .await?;
        Ok(found.and_then(|document| {
            document
                .get_str("recordedAt")
                .ok()
                .and_then(|text| Timestamp::parse_rfc3339(text).ok())
        }))
    }

    /// `recordedAt > after` 的撤回和改成内部级的更正（最新的在前）。
    pub async fn hiding_corrections_after(
        &self,
        grant: &Grant,
        after: Option<Timestamp>,
        limit: i64,
    ) -> Result<Vec<Event>, RepoError> {
        let mut filter = space_children(grant);
        filter.insert("corrects", doc! {"$exists": true});
        filter.insert(
            "$or",
            vec![doc! {"retracted": true}, doc! {"visibility": "internal"}],
        );
        if let Some(after) = after {
            filter.insert("recordedAt", doc! {"$gt": after.to_rfc3339()});
        }
        super::restrict_to_membership(&mut filter, grant, "at");
        let cursor = self
            .collection(collections::EVENTS)
            .find(filter)
            .sort(doc! {"recordedAt": -1})
            .limit(limit)
            .await?;
        collect(cursor).await
    }

    /// 这些原事件里，哪些在 `public_anchors` 上有过公开级的版本（原事件或某条替换）。
    pub async fn ever_public(
        &self,
        grant: &Grant,
        ids: &[String],
        public_anchors: &BTreeSet<String>,
    ) -> Result<BTreeSet<String>, RepoError> {
        if ids.is_empty() {
            return Ok(BTreeSet::new());
        }
        let mut filter = space_children(grant);
        filter.insert("visibility", "public");
        filter.insert(
            "anchorId",
            doc! {"$in": public_anchors.iter().collect::<Vec<_>>()},
        );
        filter.insert(
            "$or",
            vec![doc! {"_id": {"$in": ids}}, doc! {"corrects": {"$in": ids}}],
        );
        let mut cursor = self
            .collection(collections::EVENTS)
            .find(filter)
            .projection(doc! {"_id": 1, "corrects": 1})
            .await?;
        let mut found = BTreeSet::new();
        while cursor.advance().await? {
            let document: Document = cursor
                .deserialize_current()
                .map_err(|error| RepoError::Corrupt(error.to_string()))?;
            let id = document
                .get_str("corrects")
                .or_else(|_| document.get_str("_id"))
                .unwrap_or_default();
            found.insert(id.to_owned());
        }
        Ok(found)
    }

    /// 事件密度：`[from, to)` 里每个桶的公开事件数（先按原事件取 `recordedAt` 最新的版本，
    /// 去掉撤回和非公开的，只数公开锚点上的）。返回 (桶序号, 数量)。
    pub async fn public_event_density(
        &self,
        grant: &Grant,
        from: Timestamp,
        to: Timestamp,
        bucket_ms: i64,
        public_anchors: &BTreeSet<String>,
    ) -> Result<Vec<(i64, u64)>, RepoError> {
        let mut filter = space_children(grant);
        filter.insert(
            "at",
            doc! {"$gte": from.to_rfc3339(), "$lt": to.to_rfc3339()},
        );
        super::restrict_to_membership(&mut filter, grant, "at");
        let anchors: Vec<&String> = public_anchors.iter().collect();
        let pipeline = vec![
            doc! {"$match": filter},
            doc! {"$sort": {"recordedAt": 1, "_id": 1}},
            doc! {"$group": {
                "_id": {"$ifNull": ["$corrects", "$_id"]},
                "at": {"$last": "$at"},
                "retracted": {"$last": "$retracted"},
                "visibility": {"$last": "$visibility"},
                "anchorId": {"$last": "$anchorId"},
            }},
            doc! {"$match": {
                "retracted": {"$ne": true},
                "visibility": "public",
                "anchorId": {"$in": anchors},
            }},
            doc! {"$group": {
                "_id": {"$floor": {"$divide": [
                    {"$subtract": [
                        {"$toLong": {"$dateFromString": {"dateString": "$at"}}},
                        from.millis(),
                    ]},
                    bucket_ms,
                ]}},
                "count": {"$sum": 1},
            }},
            doc! {"$sort": {"_id": 1}},
        ];
        let mut cursor = self
            .collection(collections::EVENTS)
            .aggregate(pipeline)
            .allow_disk_use(true)
            .await?;
        let mut buckets = Vec::new();
        while cursor.advance().await? {
            let row: Document = cursor
                .deserialize_current()
                .map_err(|error| RepoError::Corrupt(error.to_string()))?;
            let number = |value: Option<&Bson>| match value {
                Some(Bson::Int64(n)) => Some(*n),
                Some(Bson::Int32(n)) => Some(i64::from(*n)),
                Some(Bson::Double(n)) => Some(*n as i64),
                _ => None,
            };
            if let (Some(index), Some(count)) = (number(row.get("_id")), number(row.get("count"))) {
                buckets.push((index, u64::try_from(count).unwrap_or(0)));
            }
        }
        Ok(buckets)
    }

    // ----------------------------------------------------------------- 抹除

    /// 抹除内容（管理接口，设计 5.3、8.4）：去掉 `data`，标记 `redacted`。原事件被抹除时，
    /// 指向它的全部更正一起抹除。返回涉及的记录数。
    pub async fn redact_event(
        &self,
        grant: &Grant,
        event: &Event,
        by: &str,
        now: Timestamp,
    ) -> Result<u64, RepoError> {
        if !grant.can_manage() || event.space_id != grant.space_id() {
            return Err(RepoError::GrantMismatch);
        }
        let mut filter = space_children(grant);
        if event.corrects.is_none() {
            filter.insert(
                "$or",
                vec![doc! {"_id": &event.id}, doc! {"corrects": &event.id}],
            );
        } else {
            filter.insert("_id", &event.id);
        }
        let result = self
            .collection(collections::EVENTS)
            .update_many(
                filter,
                doc! {
                    "$set": {"redacted": true, "redactedAt": now.to_rfc3339(), "redactedBy": by},
                    "$unset": {"data": ""},
                },
            )
            .await?;
        Ok(result.matched_count)
    }

    // ----------------------------------------------------------------- 状态快照

    /// `at ≤ upper` 的最近几份快照（最新的在前）。
    pub async fn state_snapshots_before(
        &self,
        grant: &Grant,
        upper: Timestamp,
        limit: i64,
    ) -> Result<Vec<StateSnapshot>, RepoError> {
        let mut filter = space_children(grant);
        filter.insert("at", doc! {"$lte": upper.to_rfc3339()});
        let cursor = self
            .collection(collections::STATE_SNAPSHOTS)
            .find(filter)
            .sort(doc! {"at": -1})
            .limit(limit)
            .await?;
        collect(cursor).await
    }

    /// 快照是否失效：有 `at ≤ 快照时刻`、但在 `computedAt` 之后才记录（晚到或更正）或被抹除的
    /// 事件。抹除不改 `recordedAt`；抹除时会删掉已有的快照，但与抹除同时进行的状态计算可能在
    /// 抹除之后才保存它读到的旧内容，所以抹除时间也要比较。
    pub async fn state_snapshot_is_stale(
        &self,
        grant: &Grant,
        snapshot: &StateSnapshot,
    ) -> Result<bool, RepoError> {
        let mut filter = space_children(grant);
        filter.insert("at", doc! {"$lte": snapshot.at.to_rfc3339()});
        let computed_at = snapshot.computed_at.to_rfc3339();
        filter.insert(
            "$or",
            vec![
                doc! {"recordedAt": {"$gt": &computed_at}},
                doc! {"redactedAt": {"$gt": &computed_at}},
            ],
        );
        Ok(self
            .collection(collections::EVENTS)
            .find_one(filter)
            .projection(doc! {"_id": 1})
            .await?
            .is_some())
    }

    /// 保存快照（系统范围）。
    pub async fn insert_state_snapshot(
        &self,
        grant: &SystemGrant,
        snapshot: &StateSnapshot,
    ) -> Result<(), RepoError> {
        if snapshot.space_id != grant.space_id() || &snapshot.owner != grant.owner() {
            return Err(RepoError::GrantMismatch);
        }
        match self
            .collection(collections::STATE_SNAPSHOTS)
            .insert_one(to_document(snapshot)?)
            .await
        {
            Ok(_) => Ok(()),
            Err(error) => match RepoError::from(error) {
                RepoError::Duplicate => Ok(()),
                other => Err(other),
            },
        }
    }

    /// 删掉失效的快照（系统范围）。
    pub async fn delete_state_snapshots(
        &self,
        grant: &SystemGrant,
        from: Timestamp,
    ) -> Result<u64, RepoError> {
        let mut filter = system_children(grant);
        filter.insert("at", doc! {"$gte": from.to_rfc3339()});
        let result = self
            .collection(collections::STATE_SNAPSHOTS)
            .delete_many(filter)
            .await?;
        Ok(result.deleted_count)
    }
}
