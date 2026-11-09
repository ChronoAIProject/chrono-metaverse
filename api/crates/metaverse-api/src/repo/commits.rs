//! 时间线写入与读取（设计 5.2、5.7、13.3）。
//!
//! 顺序和条件与处理服务的写回（`worker/src/metaverse_worker/jobs/writeback.py`）一致，字段名一致：
//!
//! **事务外**（按内容哈希幂等写入，重复键直接忽略；失败只留下无人引用的对象）：
//! 区块 `chunks {_id: 区块哈希, data: zlib 压缩的规范字节, format: 1, createdAt}`、
//! 物件和锚点记录 `records {_id, kind, spaceId, owner, body}`、
//! 方块表 `palettes {_id: content_hash({blocks, spaceId}), spaceId, owner, blocks}`、
//! 状态清单 `stateBlobs {_id, kind: manifest | regions, spaceId, owner, body}`。
//!
//! **事务内**（[`Repo::write_commit`]）：
//! 1. 读空间（条件带主人）；`head.seq` 必须等于调用方基于的版本；
//! 2. 插入提交：`seq = head.seq + 1`，`at = max(当前时间, head.at)`（`(spaceId, seq)` 唯一）；
//! 3. 按 `head.seq == 旧值` 条件推进 `spaces.head`（区域和地块的当前状态一起更新）；
//! 4. 更新物件和锚点的当前状态 `entities` / `anchors`（`{spaceId, id, owner, hash, body, seq}`）；
//! 5. 登记资源引用 `assetRefs {hash, spaceId, owner, createdAt, commitId}`。
//!
//! **事务后**：给本次新引用的区块打上 `publishedAt`（[`Repo::publish_chunks`]，幂等，失败可以补做）。

use std::collections::BTreeMap;

use metaverse_core::model::{
    Actor, Author, ChunkChange, Commit, Head, IdChange, Plot, Region, Space,
};
use metaverse_core::ops::Op;
use metaverse_core::replay::{replay, StateManifest, StoredManifest};
use metaverse_core::Timestamp;
use mongodb::{
    bson::{self, doc, Binary, Bson, Document},
    error::{
        ErrorKind, WriteFailure, TRANSIENT_TRANSACTION_ERROR, UNKNOWN_TRANSACTION_COMMIT_RESULT,
    },
    options::{ReadConcern, WriteConcern},
    ClientSession, Collection,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{collections, Repo, RepoError};
use crate::auth::Grant;

/// 一次提交要写的内容（事务外的对象已经写好）。
#[derive(Debug, Clone)]
pub struct CommitPlan {
    /// 要求 `head.seq` 等于这个值，否则放弃（直接写入返回 409，草稿发布重新计算）。
    pub base_seq: u64,
    pub message: String,
    pub observed_at: Option<Timestamp>,
    pub actor: Actor,
    pub author: Option<Author>,
    pub ops: Option<Vec<Op>>,
    pub ops_ref: Option<String>,
    pub changed_chunks: Vec<ChunkChange>,
    pub changed_entities: Vec<IdChange>,
    pub changed_anchors: Vec<IdChange>,
    /// `changed_entities` 里非 null 项的 body（写当前状态）。
    pub entity_bodies: BTreeMap<String, Value>,
    pub anchor_bodies: BTreeMap<String, Value>,
    /// 区域和地块变了：`(regionsHash, regions, plots)`。
    pub layout: Option<(String, Vec<Region>, Vec<Plot>)>,
    pub palette_hash: Option<String>,
    /// 完整状态清单的哈希（每 50 次提交一份）。
    pub keyframe: Option<String>,
    pub asset_refs: Vec<String>,
    pub draft_id: Option<String>,
    pub script_ref: Option<String>,
}

impl CommitPlan {
    /// 空计划：调用方再填变化。
    pub fn new(base_seq: u64, actor: Actor, message: impl Into<String>) -> Self {
        Self {
            base_seq,
            message: message.into(),
            observed_at: None,
            actor,
            author: None,
            ops: None,
            ops_ref: None,
            changed_chunks: Vec::new(),
            changed_entities: Vec::new(),
            changed_anchors: Vec::new(),
            entity_bodies: BTreeMap::new(),
            anchor_bodies: BTreeMap::new(),
            layout: None,
            palette_hash: None,
            keyframe: None,
            asset_refs: Vec::new(),
            draft_id: None,
            script_ref: None,
        }
    }
}

/// 写入成功的提交。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitOutcome {
    pub commit_id: String,
    pub seq: u64,
    pub at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CommitError {
    /// 空间的 head 已经不是调用方基于的版本。
    #[error("空间的时间线已经前进")]
    HeadMoved,
    /// 空间不存在，或主人与凭据不一致。
    #[error("空间不存在")]
    Missing,
    #[error(transparent)]
    Repo(#[from] RepoError),
}

impl From<mongodb::error::Error> for CommitError {
    fn from(error: mongodb::error::Error) -> Self {
        CommitError::Repo(error.into())
    }
}

/// 事务里出的错：驱动错误保留原样，以便判断能不能整体重试。
enum TxError {
    Mongo(mongodb::error::Error),
    Commit(CommitError),
}

impl From<mongodb::error::Error> for TxError {
    fn from(error: mongodb::error::Error) -> Self {
        TxError::Mongo(error)
    }
}

impl From<CommitError> for TxError {
    fn from(error: CommitError) -> Self {
        TxError::Commit(error)
    }
}

pub(super) fn corrupt(error: impl std::fmt::Display) -> RepoError {
    RepoError::Corrupt(error.to_string())
}

pub(super) fn to_bson<T: serde::Serialize + ?Sized>(value: &T) -> Result<Bson, RepoError> {
    bson::serialize_to_bson(value).map_err(corrupt)
}

pub(super) fn to_document<T: serde::Serialize + ?Sized>(value: &T) -> Result<Document, RepoError> {
    bson::serialize_to_document(value).map_err(corrupt)
}

pub(super) fn from_document<T: DeserializeOwned>(document: Document) -> Result<T, RepoError> {
    bson::deserialize_from_document(document).map_err(corrupt)
}

pub(super) fn owner_document(grant: &Grant) -> Result<Bson, RepoError> {
    to_bson(grant.owner())
}

/// `{spaceId, owner.kind, owner.id}`。
pub(super) fn granted_children(grant: &Grant) -> Document {
    doc! {
        "spaceId": grant.space_id(),
        "owner.kind": owner_kind(grant),
        "owner.id": &grant.owner().id,
    }
}

pub(super) fn granted_space(grant: &Grant) -> Document {
    doc! {
        "_id": grant.space_id(),
        "owner.kind": owner_kind(grant),
        "owner.id": &grant.owner().id,
    }
}

fn owner_kind(grant: &Grant) -> &'static str {
    match grant.owner().kind {
        metaverse_core::model::OwnerKind::Person => "person",
        metaverse_core::model::OwnerKind::Org => "org",
    }
}

/// 按内容寻址的批量插入：重复键直接忽略，其他错误照常返回。
pub(super) async fn insert_ignoring_duplicates(
    collection: Collection<Document>,
    documents: Vec<Document>,
) -> Result<(), RepoError> {
    if documents.is_empty() {
        return Ok(());
    }
    for batch in documents.chunks(256) {
        match collection.insert_many(batch.to_vec()).ordered(false).await {
            Ok(_) => {}
            Err(error) => {
                let only_duplicates = match error.kind.as_ref() {
                    ErrorKind::InsertMany(many) => {
                        many.write_concern_error.is_none()
                            && many
                                .write_errors
                                .iter()
                                .flatten()
                                .all(|write| write.code == 11000)
                    }
                    ErrorKind::Write(WriteFailure::WriteError(write)) => write.code == 11000,
                    _ => false,
                };
                if !only_duplicates {
                    return Err(error.into());
                }
            }
        }
    }
    Ok(())
}

/// 状态清单在 `stateBlobs` 里的种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlobKind {
    /// 关键帧：完整状态清单（[`StoredManifest`]）。
    Manifest,
    /// 区域清单：`{regions, plots}`。
    Regions,
}

impl BlobKind {
    fn as_str(self) -> &'static str {
        match self {
            BlobKind::Manifest => "manifest",
            BlobKind::Regions => "regions",
        }
    }
}

/// 区域清单的内容。
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Layout {
    #[serde(default)]
    pub regions: Vec<Region>,
    #[serde(default)]
    pub plots: Vec<Plot>,
}

/// 状态清单的内容哈希：`{body, kind, spaceId}` 规范化后的 sha256（同样的内容在不同空间里是不同的对象）。
pub fn state_blob_hash(kind: BlobKind, space_id: &str, body: &Value) -> Result<String, RepoError> {
    metaverse_core::canonical::content_hash(&serde_json::json!({
        "body": body,
        "kind": kind.as_str(),
        "spaceId": space_id,
    }))
    .map_err(corrupt)
}

/// 方块表的内容哈希：与处理服务的 `palette_hash` 相同，`{blocks, spaceId}` 规范化后的 sha256。
pub fn palette_hash(space_id: &str, blocks: &Value) -> Result<String, RepoError> {
    metaverse_core::canonical::content_hash(&serde_json::json!({
        "blocks": blocks,
        "spaceId": space_id,
    }))
    .map_err(corrupt)
}

/// 已发布区块里的一项（读取用）。
#[derive(Debug, Clone)]
pub struct StoredChunk {
    pub hash: String,
    /// zlib 压缩的规范字节。
    pub data: Vec<u8>,
    pub published: bool,
}

impl Repo {
    // -----------------------------------------------------------------------
    // 事务外：按内容哈希幂等写入
    // -----------------------------------------------------------------------

    /// 区块：`{_id: 区块哈希, data, format: 1, createdAt}`。区块是全局内容寻址的，
    /// 凭据只用来证明调用方有权写这个空间的时间线。
    pub async fn put_chunks(
        &self,
        grant: &Grant,
        chunks: &[(String, Vec<u8>)],
        now: Timestamp,
    ) -> Result<(), RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let documents = chunks
            .iter()
            .map(|(hash, data)| {
                doc! {
                    "_id": hash,
                    "data": Binary { subtype: bson::spec::BinarySubtype::Generic, bytes: data.clone() },
                    "format": 1,
                    "createdAt": now.to_rfc3339(),
                }
            })
            .collect();
        insert_ignoring_duplicates(self.collection(collections::CHUNKS), documents).await
    }

    /// 物件或锚点记录：`records {_id: 内容哈希, kind, spaceId, owner, body}`。
    pub async fn put_records(
        &self,
        grant: &Grant,
        records: &[(String, &'static str, Value)],
    ) -> Result<(), RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let owner = owner_document(grant)?;
        let mut documents = Vec::with_capacity(records.len());
        for (hash, kind, body) in records {
            documents.push(doc! {
                "_id": hash,
                "kind": *kind,
                "spaceId": grant.space_id(),
                "owner": owner.clone(),
                "body": to_bson(body)?,
            });
        }
        insert_ignoring_duplicates(self.collection(collections::RECORDS), documents).await
    }

    /// 方块表版本：`palettes {_id, spaceId, owner, blocks}`。返回内容哈希。
    pub async fn put_palette(&self, grant: &Grant, blocks: &Value) -> Result<String, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let hash = palette_hash(grant.space_id(), blocks)?;
        insert_ignoring_duplicates(
            self.collection(collections::PALETTES),
            vec![doc! {
                "_id": &hash,
                "spaceId": grant.space_id(),
                "owner": owner_document(grant)?,
                "blocks": to_bson(blocks)?,
            }],
        )
        .await?;
        Ok(hash)
    }

    /// 状态清单（关键帧或区域清单）。返回内容哈希。
    pub async fn put_state_blob(
        &self,
        grant: &Grant,
        kind: BlobKind,
        body: &Value,
    ) -> Result<String, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let hash = state_blob_hash(kind, grant.space_id(), body)?;
        insert_ignoring_duplicates(
            self.collection(collections::STATE_BLOBS),
            vec![doc! {
                "_id": &hash,
                "kind": kind.as_str(),
                "spaceId": grant.space_id(),
                "owner": owner_document(grant)?,
                "body": to_bson(body)?,
            }],
        )
        .await?;
        Ok(hash)
    }

    // -----------------------------------------------------------------------
    // 事务
    // -----------------------------------------------------------------------

    /// 在一个事务里插入提交、推进空间指针、更新当前状态、登记资源引用（设计 5.7）。
    /// 写冲突等可重试的错误自动重试；`head` 已经前进时返回 [`CommitError::HeadMoved`]。
    pub async fn write_commit(
        &self,
        grant: &Grant,
        plan: &CommitPlan,
        now: Timestamp,
    ) -> Result<CommitOutcome, CommitError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch.into());
        }
        let commit_id = uuid::Uuid::new_v4().simple().to_string();
        let client = self.database.client();
        let mut session = client.start_session().await?;
        for _ in 0..4 {
            session
                .start_transaction()
                .read_concern(ReadConcern::snapshot())
                .write_concern(WriteConcern::majority())
                .await?;
            match self
                .commit_in_transaction(&mut session, grant, plan, &commit_id, now)
                .await
            {
                Ok(outcome) => {
                    let mut tries = 0;
                    loop {
                        match session.commit_transaction().await {
                            Ok(()) => return Ok(outcome),
                            Err(error)
                                if error.contains_label(UNKNOWN_TRANSACTION_COMMIT_RESULT)
                                    && tries < 3 =>
                            {
                                tries += 1;
                            }
                            Err(error) if error.contains_label(TRANSIENT_TRANSACTION_ERROR) => {
                                break;
                            }
                            Err(error) => return Err(error.into()),
                        }
                    }
                }
                Err(TxError::Mongo(error)) if error.contains_label(TRANSIENT_TRANSACTION_ERROR) => {
                    let _ = session.abort_transaction().await;
                }
                Err(TxError::Mongo(error)) => {
                    let _ = session.abort_transaction().await;
                    return Err(error.into());
                }
                Err(TxError::Commit(error)) => {
                    let _ = session.abort_transaction().await;
                    return Err(error);
                }
            }
        }
        // 反复写冲突：说明有人在同时推进这个空间的时间线。
        Err(CommitError::HeadMoved)
    }

    async fn commit_in_transaction(
        &self,
        session: &mut ClientSession,
        grant: &Grant,
        plan: &CommitPlan,
        commit_id: &str,
        now: Timestamp,
    ) -> Result<CommitOutcome, TxError> {
        let spaces = self.collection(collections::SPACES);
        let found = spaces
            .find_one(granted_space(grant))
            .session(&mut *session)
            .await?
            .ok_or(CommitError::Missing)?;
        let space: Space = from_document(found).map_err(CommitError::from)?;
        if space.head.seq != plan.base_seq {
            return Err(CommitError::HeadMoved.into());
        }
        let seq = plan.base_seq + 1;
        let at = metaverse_core::model::next_commit_at(now, space.head.at);
        let commit = Commit {
            id: commit_id.to_owned(),
            space_id: grant.space_id().to_owned(),
            owner: grant.owner().clone(),
            seq,
            at,
            observed_at: plan.observed_at,
            actor: plan.actor.clone(),
            author: plan.author.clone(),
            message: plan.message.clone(),
            ops: plan.ops.clone(),
            ops_ref: plan.ops_ref.clone(),
            changed_chunks: plan.changed_chunks.clone(),
            changed_entities: plan.changed_entities.clone(),
            changed_anchors: plan.changed_anchors.clone(),
            regions_hash: plan.layout.as_ref().map(|(hash, _, _)| hash.clone()),
            palette_hash: plan.palette_hash.clone(),
            scan: None,
            keyframe: plan.keyframe.clone(),
            job_id: None,
            draft_id: plan.draft_id.clone(),
            script_ref: plan.script_ref.clone(),
        };
        let commits = self.collection(collections::COMMITS);
        match commits
            .insert_one(to_document(&commit).map_err(CommitError::from)?)
            .session(&mut *session)
            .await
        {
            Ok(_) => {}
            Err(error) if super::is_duplicate_key(&error) => {
                return Err(CommitError::HeadMoved.into())
            }
            Err(error) => return Err(error.into()),
        }
        let head = Head {
            seq,
            at,
            commit_id: Some(commit_id.to_owned()),
        };
        let mut set = doc! {
            "head": to_bson(&head).map_err(CommitError::from)?,
            "updatedAt": at.to_rfc3339(),
        };
        if let Some((_, regions, plots)) = &plan.layout {
            set.insert("regions", to_bson(regions).map_err(CommitError::from)?);
            set.insert("plots", to_bson(plots).map_err(CommitError::from)?);
        }
        let mut head_filter = granted_space(grant);
        head_filter.insert("head.seq", plan.base_seq as i64);
        let moved = spaces
            .update_one(head_filter, doc! {"$set": set})
            .session(&mut *session)
            .await?;
        if moved.matched_count != 1 {
            return Err(CommitError::HeadMoved.into());
        }
        let owner = owner_document(grant).map_err(CommitError::from)?;
        for (collection, changes, bodies) in [
            (
                collections::ENTITIES,
                &plan.changed_entities,
                &plan.entity_bodies,
            ),
            (
                collections::ANCHORS,
                &plan.changed_anchors,
                &plan.anchor_bodies,
            ),
        ] {
            let current = self.collection(collection);
            for change in changes {
                let mut key = granted_children(grant);
                key.insert("id", &change.id);
                match &change.hash {
                    None => {
                        current.delete_one(key).session(&mut *session).await?;
                    }
                    Some(hash) => {
                        let body = bodies.get(&change.id).ok_or_else(|| {
                            CommitError::Repo(RepoError::Corrupt(format!(
                                "提交计划缺少 {} 的内容",
                                change.id
                            )))
                        })?;
                        let replacement = doc! {
                            "spaceId": grant.space_id(),
                            "id": &change.id,
                            "owner": owner.clone(),
                            "hash": hash,
                            "body": to_bson(body).map_err(CommitError::from)?,
                            "seq": seq as i64,
                        };
                        current
                            .replace_one(key, replacement)
                            .upsert(true)
                            .session(&mut *session)
                            .await?;
                    }
                }
            }
        }
        let refs = self.collection(collections::ASSET_REFS);
        let mut assets: Vec<&String> = plan.asset_refs.iter().collect();
        assets.sort();
        assets.dedup();
        for hash in assets {
            refs.update_one(
                doc! {"hash": hash, "spaceId": grant.space_id()},
                doc! {"$setOnInsert": {
                    "owner": owner.clone(),
                    "createdAt": at.to_rfc3339(),
                    "commitId": commit_id,
                }},
            )
            .upsert(true)
            .session(&mut *session)
            .await?;
        }
        Ok(CommitOutcome {
            commit_id: commit_id.to_owned(),
            seq,
            at,
        })
    }

    /// 事务后：给本次新引用的区块打上 `publishedAt`（幂等）。
    pub async fn publish_chunks(
        &self,
        grant: &Grant,
        hashes: &[String],
        at: Timestamp,
    ) -> Result<(), RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        if hashes.is_empty() {
            return Ok(());
        }
        self.collection(collections::CHUNKS)
            .update_many(
                doc! {"_id": {"$in": hashes}, "publishedAt": {"$exists": false}},
                doc! {"$set": {"publishedAt": at.to_rfc3339()}},
            )
            .await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // 读取
    // -----------------------------------------------------------------------

    /// `seq ≤ target` 的最近一个关键帧：`(seq, 状态清单哈希)`。
    pub async fn latest_keyframe(
        &self,
        grant: &Grant,
        target: u64,
    ) -> Result<Option<(u64, String)>, RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("seq", doc! {"$lte": target as i64});
        filter.insert("keyframe", doc! {"$type": "string"});
        let found = self
            .collection(collections::COMMITS)
            .find_one(filter)
            .sort(doc! {"seq": -1})
            .projection(doc! {"seq": 1, "keyframe": 1})
            .await?;
        Ok(found.and_then(|document| {
            let seq = document
                .get_i64("seq")
                .ok()
                .or_else(|| document.get_i32("seq").ok().map(i64::from))?;
            let hash = document.get_str("keyframe").ok()?.to_owned();
            Some((u64::try_from(seq).ok()?, hash))
        }))
    }

    /// (after, upto] 范围内的提交，按 seq 升序；不读内联的操作。
    pub async fn commits_between(
        &self,
        grant: &Grant,
        after: u64,
        upto: u64,
    ) -> Result<Vec<Commit>, RepoError> {
        if upto <= after {
            return Ok(Vec::new());
        }
        let mut filter = granted_children(grant);
        filter.insert("seq", doc! {"$gt": after as i64, "$lte": upto as i64});
        self.find_commits(filter, doc! {"seq": 1}, None).await
    }

    async fn find_commits(
        &self,
        filter: Document,
        sort: Document,
        limit: Option<i64>,
    ) -> Result<Vec<Commit>, RepoError> {
        let commits_collection = self.collection(collections::COMMITS);
        let mut find = commits_collection
            .find(filter)
            .sort(sort)
            .projection(doc! {"ops": 0});
        if let Some(limit) = limit {
            find = find.limit(limit);
        }
        let mut cursor = find.await?;
        let mut commits = Vec::new();
        while cursor.advance().await? {
            let document: Document = cursor.deserialize_current().map_err(corrupt)?;
            commits.push(from_document(document)?);
        }
        Ok(commits)
    }

    /// 某个 seq 的完整状态清单：取 `seq ≤ target` 的最近关键帧（没有就从头），叠加之后的提交。
    /// 处理服务写的提交不带关键帧，所以关键帧之间的距离可能超过 50。
    pub async fn manifest_at(
        &self,
        grant: &Grant,
        target: u64,
    ) -> Result<StateManifest, RepoError> {
        if target == 0 {
            return Ok(StateManifest::default());
        }
        let base = match self.latest_keyframe(grant, target).await? {
            Some((seq, hash)) => {
                let body = self
                    .state_blob(grant, &hash)
                    .await?
                    .ok_or_else(|| RepoError::Corrupt(format!("关键帧 {hash} 不存在")))?;
                let stored: StoredManifest = serde_json::from_value(body).map_err(corrupt)?;
                Some((seq, StateManifest::from_stored(&stored)))
            }
            None => None,
        };
        let base_seq = base.as_ref().map_or(0, |(seq, _)| *seq);
        let commits = self.commits_between(grant, base_seq, target).await?;
        replay(base, &commits, target).map_err(corrupt)
    }

    /// 状态清单的内容（`stateBlobs.body`）。
    pub async fn state_blob(&self, grant: &Grant, hash: &str) -> Result<Option<Value>, RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("_id", hash);
        let found = self
            .collection(collections::STATE_BLOBS)
            .find_one(filter)
            .projection(doc! {"body": 1})
            .await?;
        found
            .map(|mut document| {
                let body = document.remove("body").unwrap_or(Bson::Null);
                bson::deserialize_from_bson::<Value>(body).map_err(corrupt)
            })
            .transpose()
    }

    /// 区域清单。没有哈希时是空清单。
    pub async fn layout(&self, grant: &Grant, hash: Option<&str>) -> Result<Layout, RepoError> {
        let Some(hash) = hash else {
            return Ok(Layout::default());
        };
        let body = self
            .state_blob(grant, hash)
            .await?
            .ok_or_else(|| RepoError::Corrupt(format!("区域清单 {hash} 不存在")))?;
        serde_json::from_value(body).map_err(corrupt)
    }

    /// 方块表版本的方块列表（原样）。没有哈希时是空表。
    pub async fn palette_blocks(
        &self,
        grant: &Grant,
        hash: Option<&str>,
    ) -> Result<Value, RepoError> {
        let Some(hash) = hash else {
            return Ok(Value::Array(Vec::new()));
        };
        let mut filter = granted_children(grant);
        filter.insert("_id", hash);
        let mut found = self
            .collection(collections::PALETTES)
            .find_one(filter)
            .projection(doc! {"blocks": 1})
            .await?
            .ok_or_else(|| RepoError::Corrupt(format!("方块表 {hash} 不存在")))?;
        let blocks = found.remove("blocks").unwrap_or(Bson::Array(Vec::new()));
        bson::deserialize_from_bson::<Value>(blocks).map_err(corrupt)
    }

    /// 记录的 body（原样），按哈希。找不到的哈希不出现在结果里。
    pub async fn record_bodies(
        &self,
        grant: &Grant,
        hashes: &[&str],
    ) -> Result<BTreeMap<String, Value>, RepoError> {
        let mut bodies = BTreeMap::new();
        for batch in hashes.chunks(2000) {
            let mut filter = granted_children(grant);
            filter.insert("_id", doc! {"$in": batch});
            let mut cursor = self
                .collection(collections::RECORDS)
                .find(filter)
                .projection(doc! {"body": 1})
                .await?;
            while cursor.advance().await? {
                let mut document: Document = cursor.deserialize_current().map_err(corrupt)?;
                let id = document.get_str("_id").map_err(corrupt)?.to_owned();
                let body = document.remove("body").unwrap_or(Bson::Null);
                bodies.insert(
                    id,
                    bson::deserialize_from_bson::<Value>(body).map_err(corrupt)?,
                );
            }
        }
        Ok(bodies)
    }

    /// 区块的存储字节，按哈希（不论是否已发布）。区块是全局内容寻址的；
    /// 调用方只能传本空间清单里出现的哈希。
    pub async fn chunk_data(
        &self,
        _grant: &Grant,
        hashes: &[&str],
    ) -> Result<BTreeMap<String, StoredChunk>, RepoError> {
        let mut chunks = BTreeMap::new();
        for batch in hashes.chunks(256) {
            let mut cursor = self
                .collection(collections::CHUNKS)
                .find(doc! {"_id": {"$in": batch}})
                .projection(doc! {"data": 1, "publishedAt": 1})
                .await?;
            while cursor.advance().await? {
                let document: Document = cursor.deserialize_current().map_err(corrupt)?;
                let chunk = stored_chunk(&document)?;
                chunks.insert(chunk.hash.clone(), chunk);
            }
        }
        Ok(chunks)
    }

    /// 命令行 `pull` 读区块：哈希必须出现在这个空间某次提交的 `changedChunks` 里（含未发布的）。
    pub async fn space_chunk(
        &self,
        grant: &Grant,
        hash: &str,
    ) -> Result<Option<StoredChunk>, RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("changedChunks.hash", hash);
        let referenced = self
            .collection(collections::COMMITS)
            .find_one(filter)
            .projection(doc! {"_id": 1})
            .await?
            .is_some();
        if !referenced {
            return Ok(None);
        }
        let found = self
            .collection(collections::CHUNKS)
            .find_one(doc! {"_id": hash})
            .projection(doc! {"data": 1, "publishedAt": 1})
            .await?;
        found.map(|document| stored_chunk(&document)).transpose()
    }

    /// `at ≤ t` 的最大 seq（没有就是 0）。
    pub async fn seq_at(&self, grant: &Grant, t: Timestamp) -> Result<u64, RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("at", doc! {"$lte": t.to_rfc3339()});
        let found = self
            .collection(collections::COMMITS)
            .find_one(filter)
            .sort(doc! {"at": -1, "seq": -1})
            .projection(doc! {"seq": 1})
            .await?;
        Ok(found
            .and_then(|document| {
                document
                    .get_i64("seq")
                    .ok()
                    .or_else(|| document.get_i32("seq").ok().map(i64::from))
            })
            .and_then(|seq| u64::try_from(seq).ok())
            .unwrap_or(0))
    }

    /// 某个 seq 的提交（不读内联操作）。
    pub async fn commit_at(&self, grant: &Grant, seq: u64) -> Result<Option<Commit>, RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("seq", seq as i64);
        Ok(self
            .find_commits(filter, doc! {"seq": 1}, Some(1))
            .await?
            .into_iter()
            .next())
    }

    /// `seq ≤ target` 的最近一次带扫描的提交（取它的 `observedAt`）。
    pub async fn latest_scan_commit(
        &self,
        grant: &Grant,
        target: u64,
    ) -> Result<Option<Commit>, RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("seq", doc! {"$lte": target as i64});
        filter.insert("scan", doc! {"$type": "object"});
        Ok(self
            .find_commits(filter, doc! {"seq": -1}, Some(1))
            .await?
            .into_iter()
            .next())
    }

    /// 提交列表（时间线）：`at` 在 [from, to] 内、`seq > after`，按 seq 升序，最多 `limit` 条。
    pub async fn timeline(
        &self,
        grant: &Grant,
        from: Option<Timestamp>,
        to: Option<Timestamp>,
        after: Option<u64>,
        limit: i64,
    ) -> Result<Vec<Commit>, RepoError> {
        let mut filter = granted_children(grant);
        let mut at = Document::new();
        if let Some(from) = from {
            at.insert("$gte", from.to_rfc3339());
        }
        if let Some(to) = to {
            at.insert("$lte", to.to_rfc3339());
        }
        if !at.is_empty() {
            filter.insert("at", at);
        }
        if let Some(after) = after {
            filter.insert("seq", doc! {"$gt": after as i64});
        }
        self.find_commits(filter, doc! {"seq": 1}, Some(limit))
            .await
    }

    /// 某空间当前的 `head.seq`（只读这一项）。
    pub async fn head_seq(&self, grant: &Grant) -> Result<Option<u64>, RepoError> {
        let found = self
            .collection(collections::SPACES)
            .find_one(granted_space(grant))
            .projection(doc! {"head.seq": 1})
            .await?;
        Ok(found.and_then(|document| {
            let head = document.get_document("head").ok()?;
            let seq = head
                .get_i64("seq")
                .ok()
                .or_else(|| head.get_i32("seq").ok().map(i64::from))?;
            u64::try_from(seq).ok()
        }))
    }

    /// 当前内部级锚点的编号（公开投影用：当前是内部级的锚点在历史里也不出现）。
    pub async fn internal_anchor_ids(&self, grant: &Grant) -> Result<Vec<String>, RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("body.visibility", "internal");
        let mut cursor = self
            .collection(collections::ANCHORS)
            .find(filter)
            .projection(doc! {"id": 1})
            .limit(100_000)
            .await?;
        let mut ids = Vec::new();
        while cursor.advance().await? {
            let document: Document = cursor.deserialize_current().map_err(corrupt)?;
            if let Ok(id) = document.get_str("id") {
                ids.push(id.to_owned());
            }
        }
        Ok(ids)
    }
}

pub(super) fn stored_chunk(document: &Document) -> Result<StoredChunk, RepoError> {
    Ok(StoredChunk {
        hash: document.get_str("_id").map_err(corrupt)?.to_owned(),
        data: document
            .get_binary_generic("data")
            .map_err(corrupt)?
            .clone(),
        published: document.contains_key("publishedAt"),
    })
}
