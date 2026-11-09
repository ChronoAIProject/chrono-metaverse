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

use metaverse_core::model::{Job, Upload, UploadPart, ASSET_CHUNK_SIZE};
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
    match purpose {
        UploadPurpose::Scan => "scan",
        UploadPurpose::Model => "model",
        UploadPurpose::Texture => "texture",
        UploadPurpose::Ops => "ops",
        UploadPurpose::Script => "script",
    }
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

impl Repo {
    /// 本空间可以"直接复用、不收数据"的资源的长度：资源必须**已经属于本空间**（见
    /// [`Repo::owned_assets`]），并且种类与这次上传的用途相同。只凭知道哈希和大小不能把别的主人的
    /// 资源变成自己的（设计 8.2：原始扫描、ops、脚本只能由有权限的调用者读到）；不属于本空间时
    /// 返回空，调用方照常要求上传完整数据、由处理服务核对整体哈希。
    pub async fn reusable_asset_length(
        &self,
        grant: &Grant,
        hash: &str,
        purpose: UploadPurpose,
    ) -> Result<Option<u64>, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let Some(meta) = self.space_owned_asset(grant, hash).await? else {
            return Ok(None);
        };
        Ok((meta.kind.as_deref() == Some(purpose_name(purpose))).then_some(meta.length))
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

    /// 标记资源刚被复用（处理服务清理时按 max(上传时间, touchedAt) 计算 7 天宽限）。
    pub async fn touch_asset(&self, grant: &Grant, hash: &str) -> Result<(), RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        self.collection(collections::ASSET_FILES)
            .update_one(
                doc! {"filename": hash},
                doc! {"$set": {"metadata.touchedAt": DateTime::now()}},
            )
            .await?;
        Ok(())
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
