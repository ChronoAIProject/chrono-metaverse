//! 定期清理和后台迁移的数据访问（docs/design/server-slim.md 第 5 节、11.4）。都是跨空间的查询，
//! 只接受授权层签发的 [`BackgroundGrant`]。步骤照搬处理服务的 `jobs/cleanup.py`、`uploads.py`：
//!
//! - 删除都带条件：资源按"`metadata.touchedAt` 早于截止时间"条件删除（清理的栅栏，见
//!   [`Repo::touch_asset`]）；上传先按条件改成 `expired` 再删数据块和会话；
//! - 用量成对减回：上传、`model_import` 计过的字节按 `storageReleasedAt` 条件在事务里减回，
//!   减到 0 为止，只减记录所在的那个空间实例；
//! - 锁：`migrations` 集合里带租约的文档（`lock:cleanup`、各迁移的记录），插入时撞唯一键就是没抢到。

use std::collections::BTreeSet;

use metaverse_core::model::{Job, JobKind, Owner, Upload};
use metaverse_core::Timestamp;
use mongodb::bson::{doc, Bson, DateTime, Document};

use super::blobs::AssetMeta;
use super::commits::{corrupt, from_document, to_bson};
use super::transactions::{TxnOp, TxnOutcome};
use super::{collections, is_duplicate_key, Repo, RepoError};
use crate::auth::BackgroundGrant;

/// 每步每轮处理的数量上限。
pub const CLEANUP_BATCH: i64 = 200;
/// 资源每轮最多删多少个。
pub const ASSET_BATCH: i64 = 500;

/// 一个资源的引用检查要看的未结束任务参数（只看字符串）。
fn strings_in(value: &Bson, into: &mut BTreeSet<String>) {
    match value {
        Bson::String(text) => {
            into.insert(text.clone());
        }
        Bson::Document(document) => document.values().for_each(|v| strings_in(v, into)),
        Bson::Array(items) => items.iter().for_each(|v| strings_in(v, into)),
        _ => {}
    }
}

fn number(document: &Document, key: &str) -> Option<i64> {
    match document.get(key)? {
        Bson::Int32(value) => Some(i64::from(*value)),
        Bson::Int64(value) => Some(*value),
        Bson::Double(value) if value.is_finite() => Some(*value as i64),
        _ => None,
    }
}

fn owner_of(document: &Document) -> Option<Owner> {
    let owner = document.get_document("owner").ok()?;
    let owner: Owner = mongodb::bson::deserialize_from_document(owner.clone()).ok()?;
    owner.is_valid().then_some(owner)
}

/// 空间实例的条件（按记录的创建时间，见 `repo/runner.rs`）。
fn instance_filter(space_id: &str, owner: &Owner, created_at: Option<&str>) -> Document {
    let mut filter = doc! {
        "_id": space_id,
        "owner.kind": super::uploads::owner_kind(owner),
        "owner.id": &owner.id,
    };
    if let Some(created) = created_at.filter(|created| !created.is_empty()) {
        filter.insert("createdAt", doc! {"$not": {"$gt": created}});
    }
    filter
}

impl Repo {
    // -----------------------------------------------------------------------
    // 锁和迁移记录
    // -----------------------------------------------------------------------

    /// 抢（或续）一把带租约的锁：`updateOne({_id, $or: [{until < 现在}, {owner: 本进程}]}, {$set: {owner, until}}, upsert)`，
    /// 插入时撞唯一键说明别人持有。返回是否抢到。
    pub async fn try_lock(
        &self,
        _background: &BackgroundGrant,
        name: &str,
        owner: &str,
        now: Timestamp,
        until: Timestamp,
    ) -> Result<bool, RepoError> {
        let result = self
            .collection(collections::MIGRATIONS)
            .update_one(
                doc! {"_id": name, "$or": [
                    {"until": {"$lt": now.to_rfc3339()}},
                    {"until": {"$exists": false}},
                    {"owner": owner},
                ]},
                doc! {"$set": {"owner": owner, "until": until.to_rfc3339()}},
            )
            .upsert(true)
            .await;
        match result {
            Ok(_) => Ok(true),
            Err(error) if is_duplicate_key(&error) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    /// 迁移记录：`(游标, 是否已完成)`；还没有记录时为空。
    pub async fn migration_state(
        &self,
        _background: &BackgroundGrant,
        name: &str,
    ) -> Result<Option<(Option<String>, bool)>, RepoError> {
        let found = self
            .collection(collections::MIGRATIONS)
            .find_one(doc! {"_id": name})
            .await?;
        Ok(found.map(|document| {
            (
                document.get_str("cursor").ok().map(str::to_owned),
                document.contains_key("finishedAt"),
            )
        }))
    }

    /// 推进迁移的游标（只在本进程仍持有锁时）；`finished` 时写 `finishedAt`。返回是否写成。
    pub async fn migration_progress(
        &self,
        _background: &BackgroundGrant,
        name: &str,
        owner: &str,
        cursor: Option<&str>,
        finished: Option<Timestamp>,
    ) -> Result<bool, RepoError> {
        let mut set = Document::new();
        if let Some(cursor) = cursor {
            set.insert("cursor", cursor);
        }
        if let Some(at) = finished {
            set.insert("finishedAt", at.to_rfc3339());
        }
        if set.is_empty() {
            return Ok(true);
        }
        let result = self
            .collection(collections::MIGRATIONS)
            .update_one(doc! {"_id": name, "owner": owner}, doc! {"$set": set})
            .await?;
        Ok(result.matched_count == 1)
    }

    // -----------------------------------------------------------------------
    // 第 0 步：任务
    // -----------------------------------------------------------------------

    /// 租约过期（或还在排队）且尝试次数已用完的任务标记 `failed`，`lastError.class` 保留最后一次的。
    /// 返回被标记的任务（`upload_verify` 接着收尾上传）。
    pub async fn reap_exhausted_jobs(
        &self,
        _background: &BackgroundGrant,
        now: Timestamp,
    ) -> Result<Vec<Job>, RepoError> {
        let now_text = now.to_rfc3339();
        let exhausted = doc! {
            "$or": [
                {"status": "running", "leaseUntil": {"$lt": &now_text}},
                {"status": "queued"},
            ],
            "$expr": {"$gte": [
                {"$ifNull": ["$attempt", 0]},
                {"$ifNull": ["$maxAttempts", i64::from(metaverse_core::model::JOB_MAX_ATTEMPTS)]},
            ]},
        };
        let mut cursor = self
            .collection(collections::JOBS)
            .find(exhausted.clone())
            .limit(CLEANUP_BATCH)
            .await?;
        let mut candidates = Vec::new();
        while cursor.advance().await? {
            candidates.push(cursor.deserialize_current().map_err(corrupt)?);
        }
        let mut reaped = Vec::new();
        for document in candidates {
            let Some(id) = document.get("_id").cloned() else {
                continue;
            };
            let mut filter = exhausted.clone();
            filter.insert("_id", id.clone());
            let pipeline = vec![
                doc! {"$set": {
                    "status": "failed",
                    "finishedAt": &now_text,
                    "lastError": {
                        "class": {"$ifNull": ["$lastError.class", "transient"]},
                        "message": "重试次数已用完（最后一次租约过期）",
                        "at": &now_text,
                    },
                }},
                doc! {"$unset": ["leaseUntil", "notBefore"]},
            ];
            let result = self
                .collection(collections::JOBS)
                .update_one(filter, pipeline)
                .await?;
            if result.modified_count == 1 {
                match from_document::<Job>(document) {
                    Ok(job) => reaped.push(job),
                    Err(error) => tracing::warn!(job = %id, error = %error, "回收的任务记录读不懂"),
                }
            }
        }
        Ok(reaped)
    }

    /// 已下线种类（`scan_import`、`align`、`rebuild`、`voxelize`、`web_model`、`model_import`）中还在
    /// 排队或运行的，标记失败。每轮都做、幂等。
    pub async fn retire_jobs(
        &self,
        _background: &BackgroundGrant,
        message: &str,
        now: Timestamp,
    ) -> Result<u64, RepoError> {
        let kinds: Vec<&str> = JobKind::RETIRED.iter().map(|kind| kind.name()).collect();
        let result = self
            .collection(collections::JOBS)
            .update_many(
                doc! {"kind": {"$in": kinds}, "status": {"$in": ["queued", "running"]}},
                doc! {
                    "$set": {
                        "status": "failed",
                        "finishedAt": now.to_rfc3339(),
                        "lastError": {"class": "content", "message": message, "at": now.to_rfc3339()},
                    },
                    "$unset": {"leaseUntil": "", "notBefore": ""},
                },
            )
            .await?;
        Ok(result.modified_count)
    }

    // -----------------------------------------------------------------------
    // 第 1 步：上传会话
    // -----------------------------------------------------------------------

    /// 停在 `complete`、校验任务已失败（或任务记录不存在且完成超过 `cutoff`）的上传。
    pub async fn stuck_uploads(
        &self,
        _background: &BackgroundGrant,
        cutoff: Timestamp,
    ) -> Result<Vec<Upload>, RepoError> {
        let mut cursor = self
            .collection(collections::UPLOADS)
            .find(doc! {"status": "complete"})
            .limit(CLEANUP_BATCH * 5)
            .await?;
        let mut uploads: Vec<Upload> = Vec::new();
        while cursor.advance().await? {
            let document: Document = cursor.deserialize_current().map_err(corrupt)?;
            match from_document::<Upload>(document) {
                Ok(upload) => uploads.push(upload),
                Err(error) => tracing::warn!(error = %error, "上传记录读不懂，跳过"),
            }
        }
        let mut stuck = Vec::new();
        for upload in uploads {
            let job = match &upload.job_id {
                Some(job_id) => {
                    self.collection(collections::JOBS)
                        .find_one(doc! {"_id": job_id})
                        .projection(doc! {"status": 1})
                        .await?
                }
                None => None,
            };
            let settled = match job {
                Some(job) => job.get_str("status").ok() == Some("failed"),
                None => upload.completed_at.unwrap_or(upload.created_at) < cutoff,
            };
            if settled {
                stuck.push(upload);
            }
        }
        Ok(stuck)
    }

    /// 所在空间已经不在了（删除，或主人变了）的 `complete` 上传：标记 `failed`，删掉没登记的数据块。
    pub async fn fail_orphan_upload(
        &self,
        _background: &BackgroundGrant,
        upload_id: &str,
        now: Timestamp,
    ) -> Result<bool, RepoError> {
        let moved = self
            .collection(collections::UPLOADS)
            .update_one(
                doc! {"_id": upload_id, "status": "complete"},
                doc! {"$set": {
                    "status": "failed",
                    "error": "上传所在的空间已经删除",
                    "failedAt": now.to_rfc3339(),
                    "updatedAt": now.to_rfc3339(),
                }},
            )
            .await?;
        let registered = self
            .collection(collections::ASSET_FILES)
            .find_one(doc! {"_id": upload_id})
            .projection(doc! {"_id": 1})
            .await?
            .is_some();
        if !registered {
            self.collection(collections::ASSET_CHUNKS)
                .delete_many(doc! {"files_id": upload_id})
                .await?;
        }
        Ok(moved.modified_count == 1)
    }

    /// `authored` 用途（AI 物件集，已不再处理）还没完成的上传标记 `failed`。返回改了几个。
    pub async fn fail_retired_uploads(
        &self,
        _background: &BackgroundGrant,
        now: Timestamp,
    ) -> Result<u64, RepoError> {
        let result = self
            .collection(collections::UPLOADS)
            .update_many(
                doc! {"purpose": "authored", "status": {"$in": ["open", "complete"]}},
                doc! {"$set": {
                    "status": "failed",
                    "error": "AI 物件集不再上传到服务端（改在本地打成重建包）",
                    "failedAt": now.to_rfc3339(),
                    "updatedAt": now.to_rfc3339(),
                }},
            )
            .await?;
        Ok(result.modified_count)
    }

    /// 超过 `cutoff` 仍 `open` 的上传先改成 `expired`，再和 `failed`、`expired` 的一起删数据块和会话。
    /// 返回删了几个会话。
    pub async fn remove_dead_uploads(
        &self,
        _background: &BackgroundGrant,
        cutoff: Timestamp,
    ) -> Result<u64, RepoError> {
        let cutoff_text = cutoff.to_rfc3339();
        let uploads = self.collection(collections::UPLOADS);
        let mut cursor = uploads
            .find(doc! {
                "status": {"$in": ["open", "failed", "expired"]},
                "createdAt": {"$lt": &cutoff_text},
            })
            .projection(doc! {"_id": 1, "status": 1})
            .limit(CLEANUP_BATCH)
            .await?;
        let mut stale = Vec::new();
        while cursor.advance().await? {
            stale.push(cursor.deserialize_current().map_err(corrupt)?);
        }
        let mut removed = 0;
        for document in stale {
            let Ok(id) = document.get_str("_id").map(str::to_owned) else {
                continue;
            };
            if document.get_str("status").ok() == Some("open") {
                // 先按条件改成 expired：之后"完成上传"按 status: open 条件更新就会失败，不会和清理赛跑。
                let flipped = uploads
                    .update_one(
                        doc! {"_id": &id, "status": "open", "createdAt": {"$lt": &cutoff_text}},
                        doc! {"$set": {"status": "expired"}},
                    )
                    .await?;
                if flipped.matched_count != 1 {
                    continue;
                }
            }
            // 已登记成资源的 files 文档（_id = 上传编号）不能删：只有核对通过才会登记，这里不该遇到。
            if self
                .collection(collections::ASSET_FILES)
                .find_one(doc! {"_id": &id})
                .projection(doc! {"_id": 1})
                .await?
                .is_some()
            {
                tracing::error!(upload = %id, "上传不是 done 却已登记成资源，跳过");
                continue;
            }
            self.collection(collections::ASSET_CHUNKS)
                .delete_many(doc! {"files_id": &id})
                .await?;
            uploads
                .delete_one(doc! {"_id": &id, "status": {"$in": ["expired", "failed"]}})
                .await?;
            removed += 1;
        }
        Ok(removed)
    }

    // -----------------------------------------------------------------------
    // 第 2 步：草稿、草稿区块、预览令牌
    // -----------------------------------------------------------------------

    /// 删除过期的草稿（每轮最多 [`CLEANUP_BATCH`] 个，连同它们的预览令牌和草稿区块），再各自按
    /// `expiresAt` 扫一遍预览令牌和草稿区块。返回 `(草稿, 预览令牌, 草稿区块)` 各删了多少。
    pub async fn remove_expired_drafts(
        &self,
        _background: &BackgroundGrant,
        now: Timestamp,
    ) -> Result<(u64, u64, u64), RepoError> {
        let expired = doc! {"expiresAt": {"$lt": now.to_rfc3339()}};
        let drafts = self.collection(collections::DRAFTS);
        let mut cursor = drafts
            .find(expired.clone())
            .projection(doc! {"_id": 1, "spaceId": 1})
            .limit(CLEANUP_BATCH)
            .await?;
        let mut stale = Vec::new();
        while cursor.advance().await? {
            stale.push(cursor.deserialize_current().map_err(corrupt)?);
        }
        let (mut removed, mut previews, mut chunks) = (0, 0, 0);
        for document in stale {
            let Some(id) = document.get("_id").cloned() else {
                continue;
            };
            let mut filter = expired.clone();
            filter.insert("_id", id.clone());
            if drafts.delete_one(filter).await?.deleted_count != 1 {
                continue;
            }
            removed += 1;
            let children = doc! {"draftId": id, "spaceId": document.get("spaceId").cloned().unwrap_or(Bson::Null)};
            previews += self
                .collection(collections::PREVIEWS)
                .delete_many(children.clone())
                .await?
                .deleted_count;
            chunks += self
                .collection(collections::DRAFT_CHUNKS)
                .delete_many(children)
                .await?
                .deleted_count;
        }
        previews += self
            .collection(collections::PREVIEWS)
            .delete_many(expired.clone())
            .await?
            .deleted_count;
        chunks += self
            .collection(collections::DRAFT_CHUNKS)
            .delete_many(expired)
            .await?
            .deleted_count;
        Ok((removed, previews, chunks))
    }

    // -----------------------------------------------------------------------
    // 第 3 步：没人引用的资源
    // -----------------------------------------------------------------------

    /// 上传或最近复用早于 `cutoff` 的资源（候选，还要逐个查引用）。
    pub async fn stale_assets(
        &self,
        _background: &BackgroundGrant,
        cutoff: Timestamp,
    ) -> Result<Vec<String>, RepoError> {
        let cutoff = DateTime::from_millis(cutoff.millis());
        let mut cursor = self
            .collection(collections::ASSET_FILES)
            .find(doc! {
                "uploadDate": {"$lt": cutoff},
                "$or": [{"metadata.touchedAt": {"$exists": false}}, {"metadata.touchedAt": {"$lt": cutoff}}],
            })
            .projection(doc! {"filename": 1})
            .limit(ASSET_BATCH)
            .await?;
        let mut hashes = Vec::new();
        while cursor.advance().await? {
            let document: Document = cursor.deserialize_current().map_err(corrupt)?;
            if let Ok(name) = document.get_str("filename") {
                hashes.push(name.to_owned());
            }
        }
        Ok(hashes)
    }

    /// 未结束任务的参数里出现的全部字符串（引用检查用，每轮取一次）。
    pub async fn pending_job_strings(
        &self,
        _background: &BackgroundGrant,
    ) -> Result<BTreeSet<String>, RepoError> {
        let mut cursor = self
            .collection(collections::JOBS)
            .find(doc! {"status": {"$in": ["queued", "running"]}})
            .projection(doc! {"params": 1})
            .await?;
        let mut strings = BTreeSet::new();
        while cursor.advance().await? {
            let document: Document = cursor.deserialize_current().map_err(corrupt)?;
            if let Some(params) = document.get("params") {
                strings_in(params, &mut strings);
            }
        }
        Ok(strings)
    }

    /// 资源是否仍被引用（docs/design/server-slim.md 第 5 节第 3 步）：`assetRefs`；提交的扫描、
    /// 网页用模型、操作文件、脚本、重建包清单；记录的模型和贴图；方块表的贴图；草稿的操作文件、
    /// 可预览资源、持有的资源和重建包清单；未结束任务的参数（调用方传 `pending`）；等人工对齐的
    /// 旧 `scan_import` 结果（保留一个版本）。
    pub async fn asset_referenced(
        &self,
        _background: &BackgroundGrant,
        hash: &str,
        pending: &BTreeSet<String>,
        now: Timestamp,
    ) -> Result<bool, RepoError> {
        if pending.contains(hash) {
            return Ok(true);
        }
        let checks: [(&str, Document); 5] = [
            (collections::ASSET_REFS, doc! {"hash": hash}),
            (
                collections::COMMITS,
                doc! {"$or": [
                    {"scan.assetHash": hash},
                    {"scan.textureHash": hash},
                    {"scan.webModelHashes": hash},
                    {"opsRef": hash},
                    {"scriptRef": hash},
                    {"bundleRef": hash},
                ]},
            ),
            (
                collections::RECORDS,
                doc! {"$or": [{"body.assetHash": hash}, {"body.textures": hash}]},
            ),
            (
                collections::PALETTES,
                doc! {"$or": [
                    {"blocks.texture.top": hash},
                    {"blocks.texture.side": hash},
                    {"blocks.texture.bottom": hash},
                ]},
            ),
            (
                collections::DRAFTS,
                doc! {"$or": [
                    {"opsRefs.assetHash": hash},
                    {"assets": hash},
                    {"heldAssets": hash},
                    {"bundleRef": hash},
                ]},
            ),
        ];
        for (collection, filter) in checks {
            if self
                .collection(collection)
                .find_one(filter)
                .projection(doc! {"_id": 1})
                .await?
                .is_some()
            {
                return Ok(true);
            }
        }
        // 重扫配准误差过大、等人工对齐的扫描（旧的 scan_import 结果）在保留期内也算被引用。
        Ok(self
            .collection(collections::JOBS)
            .find_one(doc! {
                "kind": "scan_import",
                "status": "done",
                "result.needsAlignment": true,
                "result.scanAssetHash": hash,
                "result.retainUntil": {"$gt": now.to_rfc3339()},
            })
            .projection(doc! {"_id": 1})
            .await?
            .is_some())
    }

    /// 按条件删除一个资源（`touchedAt` 仍早于截止时间才删）：先删 `files` 文档，再删数据块。
    /// 返回是否删了。
    pub async fn delete_stale_asset(
        &self,
        _background: &BackgroundGrant,
        hash: &str,
        cutoff: Timestamp,
    ) -> Result<bool, RepoError> {
        let cutoff = DateTime::from_millis(cutoff.millis());
        let files = self.collection(collections::ASSET_FILES);
        let stale = doc! {
            "filename": hash,
            "uploadDate": {"$lt": cutoff},
            "$or": [{"metadata.touchedAt": {"$exists": false}}, {"metadata.touchedAt": {"$lt": cutoff}}],
        };
        let Some(found) = files.find_one_and_delete(stale).await? else {
            return Ok(false);
        };
        if let Some(files_id) = found.get("_id") {
            self.collection(collections::ASSET_CHUNKS)
                .delete_many(doc! {"files_id": files_id.clone()})
                .await?;
        }
        Ok(true)
    }

    /// 资源被删掉以后，把计过用量的上传和 `model_import` 从各自空间的 `storageUsedBytes` 里减回去
    /// （每条记录一个事务：先写 `storageReleasedAt`，再减用量，所以不会减两次）。返回减回了几条。
    pub async fn release_asset_storage(
        &self,
        _background: &BackgroundGrant,
        hash: &str,
        now: Timestamp,
    ) -> Result<u64, RepoError> {
        let mut released = 0;
        for (collection, filter) in [
            (
                collections::UPLOADS,
                doc! {"assetHash": hash, "status": "done", "storageBytes": {"$gt": 0},
                "storageReleasedAt": {"$exists": false}},
            ),
            (
                collections::JOBS,
                doc! {"kind": "model_import", "status": "done", "result.modelHash": hash,
                "storageBytes": {"$gt": 0}, "storageReleasedAt": {"$exists": false}},
            ),
        ] {
            let mut cursor = self
                .collection(collection)
                .find(filter)
                .projection(
                    doc! {"_id": 1, "spaceId": 1, "owner": 1, "storageBytes": 1, "createdAt": 1},
                )
                .await?;
            let mut counted = Vec::new();
            while cursor.advance().await? {
                counted.push(cursor.deserialize_current().map_err(corrupt)?);
            }
            for record in counted {
                let (Some(id), Ok(space_id), Some(owner), Some(size)) = (
                    record.get("_id").cloned(),
                    record.get_str("spaceId"),
                    owner_of(&record),
                    number(&record, "storageBytes"),
                ) else {
                    tracing::error!(record = ?record.get("_id"), "计过用量的记录不合法，不减回");
                    continue;
                };
                let space = instance_filter(space_id, &owner, record.get_str("createdAt").ok());
                let used = doc! {"$ifNull": ["$storageUsedBytes", 0_i64]};
                let outcome = self
                    .run_transaction(&[
                        TxnOp::Update {
                            collection,
                            filter: doc! {"_id": id, "storageReleasedAt": {"$exists": false}},
                            update: doc! {"$set": {"storageReleasedAt": now.to_rfc3339()}},
                        },
                        TxnOp::UpdatePipeline {
                            collection: collections::SPACES,
                            filter: space,
                            pipeline: vec![doc! {"$set": {"storageUsedBytes": {"$max": [
                                0_i64, {"$add": [used, -size]},
                            ]}}}],
                        },
                    ])
                    .await?;
                match outcome {
                    TxnOutcome::Committed => released += 1,
                    // 空间实例已经不在了：那次计入随空间一起消失，只把记录标记为已减回。
                    TxnOutcome::NotMatched(1) => {
                        self.collection(collection)
                            .update_one(
                                doc! {"_id": record.get("_id").cloned().unwrap_or(Bson::Null),
                                "storageReleasedAt": {"$exists": false}},
                                doc! {"$set": {"storageReleasedAt": now.to_rfc3339()}},
                            )
                            .await?;
                    }
                    TxnOutcome::NotMatched(_) => {}
                }
            }
        }
        Ok(released)
    }

    // -----------------------------------------------------------------------
    // 第 4 步：补打区块的 publishedAt
    // -----------------------------------------------------------------------

    /// 最近 `since` 以来的提交引用、还没打上 `publishedAt` 的区块按提交的 `at` 补上。返回补打了多少个。
    pub async fn backfill_published_chunks(
        &self,
        _background: &BackgroundGrant,
        since: Timestamp,
    ) -> Result<u64, RepoError> {
        let mut cursor = self
            .collection(collections::COMMITS)
            .find(doc! {"at": {"$gte": since.to_rfc3339()}, "changedChunks.hash": {"$type": "string"}})
            .projection(doc! {"at": 1, "changedChunks": 1})
            .sort(doc! {"at": 1})
            .await?;
        let mut commits = Vec::new();
        while cursor.advance().await? {
            commits.push(cursor.deserialize_current().map_err(corrupt)?);
        }
        let mut fixed = 0;
        for commit in commits {
            let Ok(at) = commit.get_str("at") else {
                continue;
            };
            let hashes: Vec<String> = commit
                .get_array("changedChunks")
                .map(|changes| {
                    changes
                        .iter()
                        .filter_map(|change| change.as_document()?.get_str("hash").ok())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            if hashes.is_empty() {
                continue;
            }
            fixed += self
                .collection(collections::CHUNKS)
                .update_many(
                    doc! {"_id": {"$in": hashes}, "publishedAt": {"$exists": false}},
                    doc! {"$set": {"publishedAt": at}},
                )
                .await?
                .modified_count;
        }
        Ok(fixed)
    }

    // -----------------------------------------------------------------------
    // 后台迁移 backfill-asset-check-v1
    // -----------------------------------------------------------------------

    /// 还没有当前版本核对记录、也没有记过检查失败的旧资源（`metadata.kind` 是 `scan`、`web_model`、
    /// `model`、`texture`），按文件名（内容哈希）升序，从 `after` 之后取最多 `limit` 个。
    pub async fn assets_without_check(
        &self,
        _background: &BackgroundGrant,
        after: Option<&str>,
        limit: i64,
    ) -> Result<Vec<AssetMeta>, RepoError> {
        let mut filter = doc! {
            "metadata.kind": {"$in": ["scan", "web_model", "model", "texture"]},
            "$or": [
                {"metadata.check": {"$exists": false}},
                {"metadata.check.v": {"$lt": i64::from(metaverse_core::check::CHECK_VERSION)}},
            ],
            "metadata.checkError": {"$exists": false},
        };
        if let Some(after) = after {
            filter.insert("filename", doc! {"$gt": after});
        }
        let mut cursor = self
            .collection(collections::ASSET_FILES)
            .find(filter)
            .projection(doc! {"filename": 1})
            .sort(doc! {"filename": 1})
            .limit(limit)
            .await?;
        let mut names = Vec::new();
        while cursor.advance().await? {
            let document: Document = cursor.deserialize_current().map_err(corrupt)?;
            if let Ok(name) = document.get_str("filename") {
                names.push(name.to_owned());
            }
        }
        let mut metas = Vec::with_capacity(names.len());
        for name in names {
            if let Some(meta) = self.asset_meta_unchecked(&name).await? {
                metas.push(meta);
            }
        }
        Ok(metas)
    }

    /// 写核对记录（只在还没有当前版本的记录时）。
    pub async fn set_asset_check(
        &self,
        _background: &BackgroundGrant,
        hash: &str,
        check: &metaverse_core::check::AssetCheck,
    ) -> Result<bool, RepoError> {
        self.upgrade_asset_check(hash, check).await
    }

    /// 记下检查不过的原因（这些资源不能再被新引用，已有提交不受影响）。
    pub async fn set_asset_check_error(
        &self,
        _background: &BackgroundGrant,
        hash: &str,
        reason: &str,
    ) -> Result<(), RepoError> {
        let reason: String = reason.chars().take(500).collect();
        self.collection(collections::ASSET_FILES)
            .update_one(
                doc! {"filename": hash, "metadata.check": {"$exists": false}},
                doc! {"$set": {"metadata.checkError": {
                    "v": i64::from(metaverse_core::check::CHECK_VERSION),
                    "reason": to_bson(&reason)?,
                }}},
            )
            .await?;
        Ok(())
    }
}
