//! 上传会话与分片（设计 6.1）。
//!
//! 数据块布局与处理服务 `assets.py` 的 `write_upload_part` 完全一致：GridFS 桶 `assets` 的
//! `assets.chunks`，`files_id` = 上传编号（字符串），每块固定 256KiB，第 n 片（从 0 开始）的
//! 第 i 块序号 = `n × (partSize / 256KiB) + i`；同一片重传时先删掉这片原有的数据块，所以
//! 重传是幂等的。动数据块之前先按 `status: open` 条件给会话记"正在写入"，"完成上传"要求没有
//! 正在写入的分片，所以会话完成之后数据块再也改不动（处理服务登记资源时直接用这些块）；
//! 写完后按 `status: open` 条件登记这一片，登记失败（会话已过期、被清理）时删掉刚写的数据块，
//! 不留下无人认领的数据。
//!
//! 每个方法都要求空间的授权凭据（写入要求"管理"），条件自动带上空间编号和主人。

use metaverse_core::check::{fits, AssetCheck, AssetRole, CheckBody, CHECK_VERSION};
use metaverse_core::limits::UploadLimits;
use metaverse_core::model::{Job, Upload, UploadFormat, UploadPart, ASSET_CHUNK_SIZE};
use metaverse_core::scope::{PathScope, UploadPurpose};
use metaverse_core::Timestamp;
use mongodb::bson::{self, doc, spec::BinarySubtype, Binary, Bson, DateTime, Document};

use super::transactions::{TxnOp, TxnOutcome};
use super::{collections, Repo, RepoError};
use crate::auth::Grant;

/// 一次 `insert_many` 最多写多少块（32 × 256KiB = 8MiB，与处理服务相同）。
const INSERT_BATCH: usize = 32;

/// 写一片时占用会话的租期（毫秒）：比整个请求的超时（90 秒）长。写到一半进程退出、来不及
/// 释放时，租期过了"完成上传"才不再被它挡住。
const PART_WRITE_LEASE_MS: i64 = 120 * 1000;

pub(super) fn owner_kind(owner: &metaverse_core::model::Owner) -> &'static str {
    match owner.kind {
        metaverse_core::model::OwnerKind::Person => "person",
        metaverse_core::model::OwnerKind::Org => "org",
    }
}

/// 子集合条件：`{spaceId, owner.kind, owner.id}`。
pub(super) fn space_children(grant: &Grant) -> Document {
    doc! {
        "spaceId": grant.space_id(),
        "owner.kind": owner_kind(grant.owner()),
        "owner.id": &grant.owner().id,
    }
}

pub(super) fn to_document<T: serde::Serialize>(value: &T) -> Result<Document, RepoError> {
    bson::serialize_to_document(value).map_err(|error| RepoError::Corrupt(error.to_string()))
}

pub(super) fn from_document<T: serde::de::DeserializeOwned>(
    document: Document,
) -> Result<T, RepoError> {
    bson::deserialize_from_document(document).map_err(|error| RepoError::Corrupt(error.to_string()))
}

pub(super) fn to_bson<T: serde::Serialize>(value: &T) -> Result<Bson, RepoError> {
    bson::serialize_to_bson(value).map_err(|error| RepoError::Corrupt(error.to_string()))
}

fn purpose_name(purpose: UploadPurpose) -> &'static str {
    purpose.name()
}

/// 进行中的上传（`open`、`complete`）的数量和声明的总字节数。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PendingUploads {
    pub count: u64,
    pub bytes: u64,
}

/// 写一片的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PartWrite {
    Stored,
    /// 会话已经不是 `open`（已完成、已过期或已被清理）。
    NotOpen,
}

/// "完成上传"的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompleteWrite {
    Completed,
    /// 会话已经不是 `open`，或者还有分片正在写入（调用方重新读会话区分）。
    NotOpen,
}

/// 某个资源对这个空间是否可用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetAvailability {
    /// 本空间有校验通过的上传，资源也还在。
    Ready,
    /// 本空间有已完成、正在校验的上传。
    Pending,
    Missing,
}

/// 核对通过的上传登记成资源的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Registered {
    /// 本次新登记（`files._id` = 上传编号）。
    New,
    /// 之前已经登记过就是这一份（重做的任务）。
    AlreadyThis,
    /// 同一内容已经登记过：删掉了本次的数据块，复用已有资源。
    Reused,
}

/// 登记时同名资源恰好被清理删掉、重新插入的次数。
const REGISTER_ATTEMPTS: usize = 3;

impl Repo {
    /// 本空间可以"直接复用、不收数据"的资源的长度（docs/design/server-slim.md 4.4）：资源必须
    /// **已经属于本空间**（见 [`Repo::owned_assets`]），并且它的核对记录是当前版本、满足这个用途的
    /// 上限（与引用时按角色判断是同一个函数）。没有核对记录的旧资源不算，照常要求完整上传，登记时
    /// 撞名就补写核对记录。只凭知道哈希和大小不能把别的主人的资源变成自己的（设计 8.2）。
    pub async fn reusable_asset_length(
        &self,
        grant: &Grant,
        hash: &str,
        purpose: UploadPurpose,
        limits: &UploadLimits,
    ) -> Result<Option<u64>, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let Some(meta) = self.space_owned_asset(grant, hash).await? else {
            return Ok(None);
        };
        let (Some(check), Some(role)) = (meta.current_check(), AssetRole::for_purpose(purpose))
        else {
            return Ok(None);
        };
        if meta.check_failed {
            return Ok(None);
        }
        Ok(fits(role, check, limits).is_ok().then_some(meta.length))
    }

    /// 把核对通过的上传登记成资源（docs/design/server-slim.md 4.3 第 5 步）：插入 GridFS `files`
    /// 文档（`_id` = 上传编号，`filename` = 内容哈希，`metadata` 带核对记录）。文件名唯一键冲突
    /// 说明同一内容已存在：先刷新它的 `touchedAt`（清理的栅栏）、刷新到了才删本次的数据块、复用它，
    /// 必要时补写核对记录；刷新不到说明它刚被清理删掉，重新插入本次的。
    pub async fn register_upload_asset(
        &self,
        grant: &Grant,
        upload: &Upload,
        check: &AssetCheck,
    ) -> Result<Registered, RepoError> {
        if !grant.can_manage()
            || upload.space_id != grant.space_id()
            || &upload.owner != grant.owner()
        {
            return Err(RepoError::GrantMismatch);
        }
        let format = UploadFormat::from_name(check.body.format());
        let metadata = doc! {
            "sha256": &upload.sha256,
            "contentType": format.map_or("application/octet-stream", UploadFormat::content_type),
            "kind": purpose_name(upload.purpose),
            "spaceId": grant.space_id(),
            "uploadId": &upload.id,
            "format": check.body.format(),
            "touchedAt": DateTime::now(),
            "check": to_bson(check)?,
        };
        let length = i64::try_from(upload.size).map_err(|_| RepoError::GrantMismatch)?;
        let files = self.collection(collections::ASSET_FILES);
        for _ in 0..REGISTER_ATTEMPTS {
            let inserted = files
                .insert_one(doc! {
                    "_id": &upload.id,
                    "length": length,
                    "chunkSize": ASSET_CHUNK_SIZE as i32,
                    "uploadDate": DateTime::now(),
                    "filename": &upload.sha256,
                    "metadata": metadata.clone(),
                })
                .await;
            match inserted {
                Ok(_) => return Ok(Registered::New),
                Err(error) if super::is_duplicate_key(&error) => {}
                Err(error) => return Err(error.into()),
            }
            if files
                .find_one(doc! {"_id": &upload.id})
                .projection(doc! {"_id": 1})
                .await?
                .is_some()
            {
                return Ok(Registered::AlreadyThis);
            }
            let touched = files
                .update_one(
                    doc! {"filename": &upload.sha256},
                    doc! {"$set": {"metadata.touchedAt": DateTime::now()}},
                )
                .await?;
            if touched.matched_count == 1 {
                self.collection(collections::ASSET_CHUNKS)
                    .delete_many(doc! {"files_id": &upload.id})
                    .await?;
                self.upgrade_asset_check(&upload.sha256, check).await?;
                return Ok(Registered::Reused);
            }
            // 已有的那一份在这期间被清理删掉了：本次的数据块还在，重新插入。
        }
        tracing::warn!(asset = %upload.sha256, "登记资源时反复遇到正在被清理的同名资源");
        Err(RepoError::Unavailable)
    }

    /// 已有资源没有核对记录、记录的版本比现在低，或者只做过扫描用途的轻量检查（glb 的三角形数为空）
    /// 而这次做了完整检查时，补写这次算出的核对记录（只取决于文件内容，谁算都一样）。
    pub(super) async fn upgrade_asset_check(
        &self,
        hash: &str,
        check: &AssetCheck,
    ) -> Result<bool, RepoError> {
        let mut weaker = vec![
            doc! {"metadata.check": {"$exists": false}},
            doc! {"metadata.check.v": {"$lt": i64::from(CHECK_VERSION)}},
        ];
        if matches!(&check.body, CheckBody::Glb(glb) if glb.triangles.is_some()) {
            weaker.push(
                doc! {"metadata.check.format": "glb", "metadata.check.triangles": Bson::Null},
            );
        }
        let result = self
            .collection(collections::ASSET_FILES)
            .update_one(
                doc! {"filename": hash, "$or": weaker},
                doc! {
                    "$set": {"metadata.check": to_bson(check)?},
                    "$unset": {"metadata.checkError": ""},
                },
            )
            .await?;
        Ok(result.modified_count == 1)
    }

    /// 本空间一次已完成的上传登记的资源的核对记录（查询上传时返回，docs/design/server-slim.md 2.2）。
    /// 调用方已经按上传会话核对过资源属于本空间；资源不在或没有当前版本的核对记录时为空。
    pub async fn uploaded_asset_check(
        &self,
        grant: &Grant,
        hash: &str,
    ) -> Result<Option<AssetCheck>, RepoError> {
        if !grant.can_read_internal() {
            return Err(RepoError::GrantMismatch);
        }
        Ok(self
            .asset_meta_unchecked(hash)
            .await?
            .and_then(|meta| meta.current_check().cloned()))
    }

    /// 资源（GridFS 文件名 = 内容哈希）的长度；不存在时为空。调用方已经核对过资源属于本空间。
    pub async fn asset_length(&self, grant: &Grant, hash: &str) -> Result<Option<u64>, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let found = self
            .collection(collections::ASSET_FILES)
            .find_one(doc! {"filename": hash})
            .projection(doc! {"length": 1})
            .await?;
        Ok(found.and_then(|document| match document.get("length") {
            Some(Bson::Int64(length)) => u64::try_from(*length).ok(),
            Some(Bson::Int32(length)) => u64::try_from(*length).ok(),
            Some(Bson::Double(length)) if *length >= 0.0 => Some(*length as u64),
            _ => None,
        }))
    }

    /// 引用一个已登记的资源之前的栅栏（与处理服务 `assets.touch_asset` 相同）：按文件名刷新
    /// `metadata.touchedAt`，返回是否匹配到了资源。
    ///
    /// 处理服务的定期清理（`jobs/cleanup.py`）先查引用、再按"`touchedAt` 仍早于 7 天前"的条件删除
    /// `files` 文档，两步之间没有锁。所以写下任何新引用（草稿、记录、提交、任务、复用的上传）之前
    /// 都要先刷新并确认匹配到：刷新之后清理的条件删除就删不掉它；匹配不到说明它刚被清理删掉，
    /// 调用方按资源不存在处理（要求重新上传），不能写下一个悬空的引用。
    pub async fn touch_asset(&self, grant: &Grant, hash: &str) -> Result<bool, RepoError> {
        Ok(self
            .touch_assets(grant, &[hash.to_owned()])
            .await?
            .is_empty())
    }

    /// 同 [`Repo::touch_asset`]，一次刷新多个资源。返回没有匹配到（已经不在）的哈希，升序去重；
    /// 空表示全部都还在、都已刷新。
    pub async fn touch_assets(
        &self,
        grant: &Grant,
        hashes: &[String],
    ) -> Result<Vec<String>, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let mut wanted: Vec<&String> = hashes.iter().collect();
        wanted.sort();
        wanted.dedup();
        if wanted.is_empty() {
            return Ok(Vec::new());
        }
        let files = self.collection(collections::ASSET_FILES);
        let touched = files
            .update_many(
                doc! {"filename": {"$in": &wanted}},
                doc! {"$set": {"metadata.touchedAt": DateTime::now()}},
            )
            .await?;
        // `filename` 上有唯一索引：匹配数等于还在的资源数。
        if touched.matched_count == wanted.len() as u64 {
            return Ok(Vec::new());
        }
        // 刷新过的不会再被删掉；这时又新登记的同名资源刚上传，也不在 7 天宽限之外，都算还在。
        let present = files
            .distinct("filename", doc! {"filename": {"$in": &wanted}})
            .await?;
        Ok(wanted
            .into_iter()
            .filter(|hash| !present.contains(&Bson::String((*hash).clone())))
            .cloned()
            .collect())
    }

    pub async fn pending_uploads(&self, grant: &Grant) -> Result<PendingUploads, RepoError> {
        let mut filter = space_children(grant);
        filter.insert("status", doc! {"$in": ["open", "complete"]});
        let mut cursor = self
            .collection(collections::UPLOADS)
            .aggregate([
                doc! {"$match": filter},
                doc! {"$group": {"_id": Bson::Null, "count": {"$sum": 1}, "bytes": {"$sum": "$size"}}},
            ])
            .await?;
        if !cursor.advance().await? {
            return Ok(PendingUploads::default());
        }
        let row: Document = cursor
            .deserialize_current()
            .map_err(|error| RepoError::Corrupt(error.to_string()))?;
        let number = |key: &str| match row.get(key) {
            Some(Bson::Int64(n)) => u64::try_from(*n).unwrap_or(0),
            Some(Bson::Int32(n)) => u64::try_from(*n).unwrap_or(0),
            Some(Bson::Double(n)) if *n >= 0.0 => *n as u64,
            _ => 0,
        };
        Ok(PendingUploads {
            count: number("count"),
            bytes: number("bytes"),
        })
    }

    pub async fn insert_upload(&self, grant: &Grant, upload: &Upload) -> Result<(), RepoError> {
        if !grant.can_manage()
            || upload.space_id != grant.space_id()
            || &upload.owner != grant.owner()
        {
            return Err(RepoError::GrantMismatch);
        }
        self.collection(collections::UPLOADS)
            .insert_one(to_document(upload)?)
            .await?;
        Ok(())
    }

    /// 读上传会话。
    pub async fn upload(
        &self,
        grant: &Grant,
        upload_id: &str,
    ) -> Result<Option<Upload>, RepoError> {
        let mut filter = space_children(grant);
        filter.insert("_id", upload_id);
        self.collection(collections::UPLOADS)
            .find_one(filter)
            .await?
            .map(from_document)
            .transpose()
    }

    /// 写一片。数据块按上传编号存放，处理服务校验通过后直接把它们登记成资源（不复制），所以
    /// "改写数据块"必须和会话状态互斥：
    ///
    /// 1. 先按 `status: open` 条件给会话记一个"正在写入"（`writing` 计数 + `writeLeaseUntil`
    ///    租期）——会话已经完成、过期或被清理时什么都不写；
    /// 2. 删掉这一片原有的数据块，按 256KiB 切块写入；
    /// 3. 按 `status: open` 条件登记这一片并释放"正在写入"。
    ///
    /// "完成上传"要求没有正在写入的分片（或租期已过），所以完成之后再也改不动数据块，资源的
    /// 内容和哈希一定一致。登记失败（会话期间过期、被清理）时删掉刚写的块。
    /// 调用方已经核对过长度（和第 0 片的文件头），所以登记第 0 片时同时记下 `headerChecked`。
    pub async fn write_upload_part(
        &self,
        grant: &Grant,
        upload: &Upload,
        part_no: u64,
        data: &[u8],
        part: UploadPart,
        now: Timestamp,
    ) -> Result<PartWrite, RepoError> {
        if !grant.can_manage()
            || upload.space_id != grant.space_id()
            || &upload.owner != grant.owner()
            || !upload.part_size.is_multiple_of(ASSET_CHUNK_SIZE)
            || part_no >= upload.part_count
        {
            return Err(RepoError::GrantMismatch);
        }
        let per_part = upload.part_size / ASSET_CHUNK_SIZE;
        let first = part_no * per_part;
        let chunk_number =
            |offset: u64| i32::try_from(first + offset).map_err(|_| RepoError::GrantMismatch);
        let range = doc! {
            "files_id": &upload.id,
            "n": {"$gte": chunk_number(0)?, "$lt": chunk_number(per_part)?},
        };
        let uploads = self.collection(collections::UPLOADS);
        let mut open = space_children(grant);
        open.insert("_id", &upload.id);
        open.insert("status", "open");
        let lease = now.saturating_add_millis(PART_WRITE_LEASE_MS);
        let claimed = uploads
            .update_one(
                open.clone(),
                doc! {
                    "$inc": {"writing": 1_i32},
                    "$max": {"writeLeaseUntil": lease.to_rfc3339()},
                },
            )
            .await?;
        if claimed.matched_count != 1 {
            return Ok(PartWrite::NotOpen);
        }
        let mut by_id = space_children(grant);
        by_id.insert("_id", &upload.id);
        let release = doc! {"$inc": {"writing": -1_i32}};
        if let Err(error) = self
            .write_part_chunks(&upload.id, data, &range, first)
            .await
        {
            let _ = uploads.update_one(by_id, release).await;
            return Err(error);
        }
        let mut set = Document::new();
        set.insert(format!("parts.{part_no}"), to_bson(&part)?);
        set.insert("updatedAt", now.to_rfc3339());
        if part_no == 0 {
            set.insert("headerChecked", true);
        }
        let result = uploads
            .update_one(open, doc! {"$set": set, "$inc": {"writing": -1_i32}})
            .await?;
        if result.matched_count == 1 {
            return Ok(PartWrite::Stored);
        }
        // 会话在写入期间过期或被清理了（"完成上传"被正在写入挡着，不会是它）：释放占用，
        // 删掉刚写的块，不留下无人认领的数据。
        uploads.update_one(by_id, release).await?;
        self.collection(collections::ASSET_CHUNKS)
            .delete_many(range)
            .await?;
        Ok(PartWrite::NotOpen)
    }

    /// 删掉这一片原有的数据块，再按 256KiB 切块写入。
    async fn write_part_chunks(
        &self,
        upload_id: &str,
        data: &[u8],
        range: &Document,
        first: u64,
    ) -> Result<(), RepoError> {
        let chunk_number =
            |offset: u64| i32::try_from(first + offset).map_err(|_| RepoError::GrantMismatch);
        let chunks = self.collection(collections::ASSET_CHUNKS);
        chunks.delete_many(range.clone()).await?;
        let mut batch = Vec::with_capacity(INSERT_BATCH);
        for (offset, block) in data.chunks(ASSET_CHUNK_SIZE as usize).enumerate() {
            batch.push(doc! {
                "files_id": upload_id,
                "n": chunk_number(offset as u64)?,
                "data": Binary { subtype: BinarySubtype::Generic, bytes: block.to_vec() },
            });
            if batch.len() >= INSERT_BATCH {
                chunks.insert_many(std::mem::take(&mut batch)).await?;
            }
        }
        if !batch.is_empty() {
            chunks.insert_many(batch).await?;
        }
        Ok(())
    }

    /// 完成上传：在一个事务里把会话从 `open` 改成 `complete` 并插入 `upload_verify` 任务。
    pub async fn complete_upload(
        &self,
        grant: &Grant,
        upload: &Upload,
        job: &Job,
        now: Timestamp,
    ) -> Result<CompleteWrite, RepoError> {
        if !grant.can_manage()
            || upload.space_id != grant.space_id()
            || job.space_id != grant.space_id()
            || &job.owner != grant.owner()
        {
            return Err(RepoError::GrantMismatch);
        }
        let mut filter = space_children(grant);
        filter.insert("_id", &upload.id);
        filter.insert("status", "open");
        // 没有正在写入的分片（租期已过的占用按进程中途退出处理）。
        filter.insert(
            "$or",
            vec![
                doc! {"writing": {"$exists": false}},
                doc! {"writing": {"$lte": 0}},
                doc! {"writeLeaseUntil": {"$lt": now.to_rfc3339()}},
            ],
        );
        let outcome = self
            .run_transaction(&[
                TxnOp::Update {
                    collection: collections::UPLOADS,
                    filter,
                    update: doc! {"$set": {
                        "status": "complete",
                        "jobId": &job.id,
                        "completedAt": now.to_rfc3339(),
                        "updatedAt": now.to_rfc3339(),
                    }},
                },
                TxnOp::Insert {
                    collection: collections::JOBS,
                    document: to_document(job)?,
                },
            ])
            .await?;
        Ok(match outcome {
            TxnOutcome::Committed => CompleteWrite::Completed,
            TxnOutcome::NotMatched(_) => CompleteWrite::NotOpen,
        })
    }

    /// 后台任务自己写完的上传会话（部署种子下载的文件，docs/design/server-slim.md 7.2）改成
    /// `complete`：条件同"完成上传"（`open`、没有正在写入的分片），但不建 `upload_verify` 任务——
    /// 由这个后台任务接着核对、登记。返回是否改成了。
    pub async fn complete_upload_inline(
        &self,
        grant: &Grant,
        upload: &Upload,
        now: Timestamp,
    ) -> Result<bool, RepoError> {
        if !grant.can_manage() || upload.space_id != grant.space_id() {
            return Err(RepoError::GrantMismatch);
        }
        let mut filter = space_children(grant);
        filter.insert("_id", &upload.id);
        filter.insert("status", "open");
        filter.insert(
            "$or",
            vec![
                doc! {"writing": {"$exists": false}},
                doc! {"writing": {"$lte": 0}},
                doc! {"writeLeaseUntil": {"$lt": now.to_rfc3339()}},
            ],
        );
        let result = self
            .collection(collections::UPLOADS)
            .update_one(
                filter,
                doc! {"$set": {
                    "status": "complete",
                    "completedAt": now.to_rfc3339(),
                    "updatedAt": now.to_rfc3339(),
                }},
            )
            .await?;
        Ok(result.matched_count == 1)
    }

    /// 删掉一个已经失败或过期的上传会话和它的数据块（部署种子重做时换一个新的会话）。已登记成资源
    /// 的数据块不删。返回是否删了会话。
    pub async fn remove_dead_upload(
        &self,
        grant: &Grant,
        upload_id: &str,
    ) -> Result<bool, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let mut filter = space_children(grant);
        filter.insert("_id", upload_id);
        filter.insert("status", doc! {"$in": ["failed", "expired"]});
        let removed = self
            .collection(collections::UPLOADS)
            .delete_one(filter)
            .await?
            .deleted_count
            == 1;
        if removed
            && self
                .collection(collections::ASSET_FILES)
                .find_one(doc! {"_id": upload_id})
                .projection(doc! {"_id": 1})
                .await?
                .is_none()
        {
            self.collection(collections::ASSET_CHUNKS)
                .delete_many(doc! {"files_id": upload_id})
                .await?;
        }
        Ok(removed)
    }

    /// 某个资源对这个空间是否可用：本空间有这个哈希、用途在 `purposes` 里的上传
    /// （给了 `scope` 时还要求是同一路径范围创建的）。校验通过且资源仍在才算可用。
    pub async fn asset_availability(
        &self,
        grant: &Grant,
        hash: &str,
        purposes: &[UploadPurpose],
        scope: Option<&PathScope>,
    ) -> Result<AssetAvailability, RepoError> {
        let mut filter = space_children(grant);
        filter.insert("sha256", hash);
        filter.insert(
            "purpose",
            doc! {"$in": purposes.iter().map(|p| purpose_name(*p)).collect::<Vec<_>>()},
        );
        filter.insert("status", doc! {"$in": ["complete", "done"]});
        if let Some(scope) = scope {
            filter.insert("scope", scope.to_string());
        }
        let mut cursor = self
            .collection(collections::UPLOADS)
            .find(filter)
            .projection(doc! {"status": 1, "reused": 1})
            .limit(20)
            .await?;
        let mut pending = false;
        let mut done = false;
        let mut reused = false;
        while cursor.advance().await? {
            let document: Document = cursor
                .deserialize_current()
                .map_err(|error| RepoError::Corrupt(error.to_string()))?;
            match document.get_str("status") {
                Ok("done") if document.get_bool("reused").unwrap_or(false) => reused = true,
                Ok("done") => done = true,
                Ok("complete") => pending = true,
                _ => {}
            }
        }
        // "直接复用"的上传没有传过数据：资源还要另外按所有权规则属于本空间才算（旧版本按哈希就
        // 允许复用，留下的这类上传不能让别的主人的资源变成可用）。
        if !done && reused {
            done = self.space_owned_asset(grant, hash).await?.is_some();
        }
        if done {
            let exists = self
                .collection(collections::ASSET_FILES)
                .find_one(doc! {"filename": hash})
                .projection(doc! {"_id": 1})
                .await?
                .is_some();
            if exists {
                return Ok(AssetAvailability::Ready);
            }
        }
        Ok(if pending {
            AssetAvailability::Pending
        } else {
            AssetAvailability::Missing
        })
    }
}
