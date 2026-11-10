//! 后台执行器的任务记录（docs/design/server-slim.md 4.2）：领取、续约、带栅栏的结束，以及上传核对
//! 的收尾事务。规则照搬处理服务的 `jobs/lease.py`，并按复核意见补强：
//!
//! - **领取**：一次 `findOneAndUpdate` 原子地领取——种类在这一类里，状态是 `queued`（`notBefore`
//!   不存在或已到），或状态是 `running`、租约已过期、`attempt < maxAttempts`；按 `createdAt` 先后；
//!   同时写 `status = running`、`leaseOwner`、`leaseUntil`，第一次领取时写 `startedAt`，`attempt` 加 1；
//!   排除已有运行中、租约未过期任务的空间（每个空间同时一个）；
//! - **栅栏**：任务的任何写入都带 `{_id, attempt, leaseOwner, status: running}`
//!   （[`JobFence::filter`]），匹配不到说明租约已经丢了，什么都写不进去；
//! - 跨空间的查询只接受授权层签发的 [`BackgroundGrant`]，具体到某个空间的读写用那个空间的系统范围。
//!
//! 时间都按 RFC 3339 字符串存（固定格式，字符串比较就是时间比较），与处理服务相同。

use metaverse_core::check::AssetCheck;
use metaverse_core::model::{Job, JobError, JobKind, Upload, UploadFormat};
use metaverse_core::Timestamp;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::ReturnDocument;
use serde_json::Value;

use super::commits::{corrupt, from_document, granted_children, to_bson};
use super::transactions::{TxnOp, TxnOutcome};
use super::{collections, Repo, RepoError};
use crate::auth::{BackgroundGrant, Grant};

/// 任务写入的栅栏：领取时的任务编号、第几次尝试、租约持有者。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobFence {
    pub job_id: String,
    pub attempt: u32,
    pub owner: String,
}

impl JobFence {
    /// `{_id, attempt, leaseOwner, status: running}`。
    pub(super) fn filter(&self) -> Document {
        doc! {
            "_id": &self.job_id,
            "attempt": i64::from(self.attempt),
            "leaseOwner": &self.owner,
            "status": "running",
        }
    }

    /// 事务里"任务完成"这一步。
    pub(super) fn done_op(&self, result: &Value, now: Timestamp) -> Result<TxnOp, RepoError> {
        Ok(TxnOp::Update {
            collection: collections::JOBS,
            filter: self.filter(),
            update: doc! {
                "$set": {"status": "done", "result": to_bson(result)?, "finishedAt": now.to_rfc3339()},
                "$unset": {"leaseUntil": "", "notBefore": ""},
            },
        })
    }

    /// 事务里"只核对租约还在"这一步（顺带写进度）。
    pub(super) fn progress_op(&self, progress: &Value) -> Result<TxnOp, RepoError> {
        Ok(TxnOp::Update {
            collection: collections::JOBS,
            filter: self.filter(),
            update: doc! {"$set": {"progress": to_bson(progress)?}},
        })
    }
}

/// 数据块从哪里读。
pub enum ChunkSource<'a> {
    /// 上传会话的数据块（`files_id` = 上传编号）。
    Upload {
        grant: &'a Grant,
        upload: &'a Upload,
    },
    /// 已登记的资源（`ops_from_upload` 读操作文件、后台迁移补核对记录）。元数据只能经授权过的
    /// 数据访问方法拿到。
    Asset(&'a super::blobs::AssetMeta),
}

/// 上传核对的收尾结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyFinish {
    Done,
    /// 上传已经不是 `complete`（别人已经收尾，或已失败）。
    NotComplete,
    /// 上传所在的空间实例已经不在了（删除，或删除后用同一个编号重建）。
    SpaceGone,
    /// 租约已经丢了。
    LeaseLost,
}

fn number(document: &Document, key: &str) -> Option<u64> {
    match document.get(key)? {
        Bson::Int32(value) => u64::try_from(*value).ok(),
        Bson::Int64(value) => u64::try_from(*value).ok(),
        Bson::Double(value) if value.is_finite() && *value >= 0.0 => Some(*value as u64),
        _ => None,
    }
}

/// 空间实例的条件：主人一致，空间的 `createdAt` 不晚于记录的创建时间（照搬处理服务的
/// `store.space_filter`）。空间被删除、又用同一个编号重建的话，那是另一个空间。
pub(super) fn space_instance(grant: &Grant, record_created_at: Timestamp) -> Document {
    doc! {
        "_id": grant.space_id(),
        "owner.kind": super::uploads::owner_kind(grant.owner()),
        "owner.id": &grant.owner().id,
        "createdAt": {"$not": {"$gt": record_created_at.to_rfc3339()}},
    }
}

impl Repo {
    /// 运行中、租约未过期的任务数已达上限的空间。
    pub async fn saturated_spaces(
        &self,
        _background: &BackgroundGrant,
        now: Timestamp,
        limit: u64,
    ) -> Result<Vec<String>, RepoError> {
        let mut cursor = self
            .collection(collections::JOBS)
            .aggregate([
                doc! {"$match": {"status": "running", "leaseUntil": {"$gte": now.to_rfc3339()}}},
                doc! {"$group": {"_id": "$spaceId", "n": {"$sum": 1}}},
                doc! {"$match": {"n": {"$gte": limit as i64}}},
            ])
            .await?;
        let mut spaces = Vec::new();
        while cursor.advance().await? {
            let row: Document = cursor.deserialize_current().map_err(corrupt)?;
            if let Ok(space) = row.get_str("_id") {
                spaces.push(space.to_owned());
            }
        }
        Ok(spaces)
    }

    /// 原子地领取一个任务（见模块说明）。没有可领的任务时为空。
    pub async fn claim_job(
        &self,
        _background: &BackgroundGrant,
        kinds: &[JobKind],
        owner: &str,
        now: Timestamp,
        lease_until: Timestamp,
        busy_spaces: &[String],
    ) -> Result<Option<Job>, RepoError> {
        let now_text = now.to_rfc3339();
        let names: Vec<&str> = kinds.iter().map(|kind| kind.name()).collect();
        let mut filter = doc! {
            "kind": {"$in": names},
            "$or": [
                {"status": "queued", "$or": [
                    {"notBefore": {"$exists": false}},
                    {"notBefore": {"$lte": &now_text}},
                ]},
                {"status": "running", "leaseUntil": {"$lt": &now_text}},
            ],
            "$expr": {"$lt": [
                {"$ifNull": ["$attempt", 0]},
                {"$ifNull": ["$maxAttempts", i64::from(metaverse_core::model::JOB_MAX_ATTEMPTS)]},
            ]},
        };
        if !busy_spaces.is_empty() {
            filter.insert("spaceId", doc! {"$nin": busy_spaces});
        }
        let update = vec![
            doc! {"$set": {
                "status": "running",
                "leaseOwner": owner,
                "leaseUntil": lease_until.to_rfc3339(),
                "attempt": {"$add": [{"$ifNull": ["$attempt", 0]}, 1]},
                "startedAt": {"$ifNull": ["$startedAt", &now_text]},
            }},
            doc! {"$unset": ["notBefore"]},
        ];
        let found = self
            .collection(collections::JOBS)
            .find_one_and_update(filter, update)
            .sort(doc! {"createdAt": 1, "_id": 1})
            .return_document(ReturnDocument::After)
            .await?;
        let Some(document) = found else {
            return Ok(None);
        };
        let id = document.get("_id").cloned().unwrap_or(Bson::Null);
        match from_document::<Job>(document) {
            Ok(job) => Ok(Some(job)),
            Err(error) => {
                // 记录本身不合法：确定不了空间和主人，直接标记失败，不做任何处理。
                tracing::error!(job = %id, error = %error, "任务记录不合法，标记失败");
                self.collection(collections::JOBS)
                    .update_one(
                        doc! {"_id": id, "leaseOwner": owner, "status": "running"},
                        doc! {
                            "$set": {"status": "failed", "finishedAt": &now_text, "lastError": {
                                "class": "content", "message": format!("任务记录不合法：{error}"), "at": &now_text,
                            }},
                            "$unset": {"leaseUntil": ""},
                        },
                    )
                    .await?;
                Ok(None)
            }
        }
    }

    /// 续约。匹配不到（租约丢了）返回 `false`。
    pub async fn renew_job(
        &self,
        _background: &BackgroundGrant,
        fence: &JobFence,
        until: Timestamp,
    ) -> Result<bool, RepoError> {
        let result = self
            .collection(collections::JOBS)
            .update_one(
                fence.filter(),
                doc! {"$set": {"leaseUntil": until.to_rfc3339()}},
            )
            .await?;
        Ok(result.matched_count == 1)
    }

    /// 写进度（带栅栏）。匹配不到返回 `false`。
    pub async fn job_progress(
        &self,
        _background: &BackgroundGrant,
        fence: &JobFence,
        progress: &Value,
    ) -> Result<bool, RepoError> {
        let result = self
            .collection(collections::JOBS)
            .update_one(
                fence.filter(),
                doc! {"$set": {"progress": to_bson(progress)?}},
            )
            .await?;
        Ok(result.matched_count == 1)
    }

    /// 任务完成（带栅栏）。
    pub async fn complete_job(
        &self,
        _background: &BackgroundGrant,
        fence: &JobFence,
        result: &Value,
        now: Timestamp,
    ) -> Result<bool, RepoError> {
        let TxnOp::Update { filter, update, .. } = fence.done_op(result, now)? else {
            unreachable!("done_op 总是条件更新");
        };
        let outcome = self
            .collection(collections::JOBS)
            .update_one(filter, update)
            .await?;
        Ok(outcome.matched_count == 1)
    }

    /// 任务出错（带栅栏）：`retry_at` 有值时退回队列、到这个时间以后再领取；否则标记失败。
    pub async fn settle_job_error(
        &self,
        _background: &BackgroundGrant,
        fence: &JobFence,
        error: &JobError,
        retry_at: Option<Timestamp>,
        now: Timestamp,
    ) -> Result<bool, RepoError> {
        let update = match retry_at {
            Some(at) => doc! {
                "$set": {"status": "queued", "lastError": to_bson(error)?, "notBefore": at.to_rfc3339()},
                "$unset": {"leaseOwner": "", "leaseUntil": ""},
            },
            None => doc! {
                "$set": {"status": "failed", "lastError": to_bson(error)?, "finishedAt": now.to_rfc3339()},
                "$unset": {"leaseUntil": "", "notBefore": ""},
            },
        };
        let outcome = self
            .collection(collections::JOBS)
            .update_one(fence.filter(), update)
            .await?;
        Ok(outcome.matched_count == 1)
    }

    /// 收到停止信号、来不及做完：退回队列，退还这一次的尝试次数（不是任务本身的问题）。
    pub async fn requeue_stopped_job(
        &self,
        _background: &BackgroundGrant,
        fence: &JobFence,
    ) -> Result<bool, RepoError> {
        let outcome = self
            .collection(collections::JOBS)
            .update_one(
                fence.filter(),
                doc! {
                    "$set": {"status": "queued"},
                    "$unset": {"leaseOwner": "", "leaseUntil": ""},
                    "$inc": {"attempt": -1},
                },
            )
            .await?;
        Ok(outcome.matched_count == 1)
    }

    /// 读数据块：序号在 `[from, from + limit)` 里的，按序号升序。
    pub async fn read_chunks(
        &self,
        source: &ChunkSource<'_>,
        from: u64,
        limit: u64,
    ) -> Result<Vec<(u64, Vec<u8>)>, RepoError> {
        let files_id = match source {
            ChunkSource::Upload { grant, upload } => {
                if upload.space_id != grant.space_id() || &upload.owner != grant.owner() {
                    return Err(RepoError::GrantMismatch);
                }
                Bson::String(upload.id.clone())
            }
            ChunkSource::Asset(meta) => meta.files_id.clone(),
        };
        let mut cursor = self
            .collection(collections::ASSET_CHUNKS)
            .find(doc! {
                "files_id": files_id,
                "n": {"$gte": from as i64, "$lt": (from + limit) as i64},
            })
            .sort(doc! {"n": 1})
            .projection(doc! {"_id": 0, "n": 1, "data": 1})
            .batch_size(limit.min(64) as u32)
            .await?;
        let mut chunks = Vec::new();
        while cursor.advance().await? {
            let document: Document = cursor.deserialize_current().map_err(corrupt)?;
            let n = number(&document, "n").ok_or_else(|| corrupt("数据块序号不对"))?;
            let data = document
                .get_binary_generic("data")
                .map_err(corrupt)?
                .clone();
            chunks.push((n, data));
        }
        Ok(chunks)
    }

    /// 记录（任务、上传）所在的空间实例还在。
    pub async fn space_instance_exists(
        &self,
        grant: &Grant,
        record_created_at: Timestamp,
    ) -> Result<bool, RepoError> {
        Ok(self
            .collection(collections::SPACES)
            .find_one(space_instance(grant, record_created_at))
            .projection(doc! {"_id": 1})
            .await?
            .is_some())
    }

    /// 核对通过（内容已登记成资源）以后的收尾，一个事务里：上传 `complete → done` 并写 `assetHash`、
    /// `format`、`storageBytes`；空间（同一个实例）的 `storageUsedBytes` 加上大小；给了任务时按栅栏
    /// 把任务标记完成（`upload_verify`）或只核对租约（部署种子在自己的任务里核对下载的文件）。
    pub async fn finish_verified_upload(
        &self,
        grant: &Grant,
        upload: &Upload,
        check: Option<&AssetCheck>,
        size: u64,
        job: Option<(&JobFence, super::JobStep<'_>)>,
        now: Timestamp,
    ) -> Result<VerifyFinish, RepoError> {
        if !grant.can_manage() || upload.space_id != grant.space_id() {
            return Err(RepoError::GrantMismatch);
        }
        let mut filter = granted_children(grant);
        filter.insert("_id", &upload.id);
        filter.insert("status", "complete");
        let mut set = doc! {
            "status": "done",
            "assetHash": &upload.sha256,
            "storageBytes": size as i64,
            "verifiedAt": now.to_rfc3339(),
            "verifiedSha256": &upload.sha256,
            "updatedAt": now.to_rfc3339(),
        };
        if let Some(format) = check.and_then(|check| UploadFormat::from_name(check.body.format())) {
            set.insert("format", format.name());
            set.insert("contentType", format.content_type());
        }
        let mut ops = vec![
            TxnOp::Update {
                collection: collections::UPLOADS,
                filter,
                update: doc! {"$set": set},
            },
            TxnOp::Update {
                collection: collections::SPACES,
                filter: space_instance(grant, upload.created_at),
                update: doc! {"$inc": {"storageUsedBytes": size as i64}},
            },
        ];
        match job {
            None => {}
            Some((fence, super::JobStep::Done(result))) => ops.push(fence.done_op(result, now)?),
            Some((fence, super::JobStep::Progress(progress))) => {
                ops.push(fence.progress_op(progress)?)
            }
        }
        Ok(match self.run_transaction(&ops).await? {
            TxnOutcome::Committed => VerifyFinish::Done,
            TxnOutcome::NotMatched(0) => VerifyFinish::NotComplete,
            TxnOutcome::NotMatched(1) => VerifyFinish::SpaceGone,
            TxnOutcome::NotMatched(_) => VerifyFinish::LeaseLost,
        })
    }

    /// 记下"内容已核对通过"（`verifiedSha256`），给了栅栏时在同一个事务里核对租约。任务最终失败时的
    /// 收尾按它判断能不能补做完成。返回是否写成（上传已不是 `complete` 或租约丢了是 `false`）。
    pub async fn mark_upload_verified(
        &self,
        grant: &Grant,
        upload: &Upload,
        fence: &JobFence,
        now: Timestamp,
    ) -> Result<bool, RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("_id", &upload.id);
        filter.insert("status", "complete");
        let outcome = self
            .run_transaction(&[
                TxnOp::Update {
                    collection: collections::UPLOADS,
                    filter,
                    update: doc! {"$set": {"verifiedSha256": &upload.sha256, "updatedAt": now.to_rfc3339()}},
                },
                fence.progress_op(&serde_json::json!({"stage": "verified"}))?,
            ])
            .await?;
        Ok(outcome == TxnOutcome::Committed)
    }

    /// 上传 `complete → failed`（写 `error`）；给了栅栏和错误时，在同一个事务里把任务标记失败。
    /// 返回是否写成。之后由调用方删数据块（[`Repo::delete_upload_chunks`]）。
    pub async fn fail_verified_upload(
        &self,
        grant: &Grant,
        upload_id: &str,
        reason: &str,
        job: Option<(&JobFence, &JobError)>,
        now: Timestamp,
    ) -> Result<bool, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let mut filter = granted_children(grant);
        filter.insert("_id", upload_id);
        filter.insert("status", "complete");
        let reason: String = reason.chars().take(500).collect();
        let mut ops = vec![TxnOp::Update {
            collection: collections::UPLOADS,
            filter,
            update: doc! {"$set": {
                "status": "failed",
                "error": reason,
                "failedAt": now.to_rfc3339(),
                "updatedAt": now.to_rfc3339(),
            }},
        }];
        if let Some((fence, error)) = job {
            ops.push(TxnOp::Update {
                collection: collections::JOBS,
                filter: fence.filter(),
                update: doc! {
                    "$set": {"status": "failed", "lastError": to_bson(error)?, "finishedAt": now.to_rfc3339()},
                    "$unset": {"leaseUntil": "", "notBefore": ""},
                },
            });
        }
        Ok(self.run_transaction(&ops).await? == TxnOutcome::Committed)
    }

    /// 删掉上传会话的数据块。已经登记成资源（`files._id` = 上传编号）的不删。返回删了多少块。
    pub async fn delete_upload_chunks(
        &self,
        grant: &Grant,
        upload_id: &str,
    ) -> Result<u64, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let registered = self
            .collection(collections::ASSET_FILES)
            .find_one(doc! {"_id": upload_id})
            .projection(doc! {"_id": 1})
            .await?
            .is_some();
        if registered {
            tracing::error!(upload = %upload_id, "上传已登记成资源，不删数据块");
            return Ok(0);
        }
        Ok(self
            .collection(collections::ASSET_CHUNKS)
            .delete_many(doc! {"files_id": upload_id})
            .await?
            .deleted_count)
    }

    /// 上传会话还有没有数据块。
    pub async fn upload_has_chunks(
        &self,
        grant: &Grant,
        upload_id: &str,
    ) -> Result<bool, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        Ok(self
            .collection(collections::ASSET_CHUNKS)
            .find_one(doc! {"files_id": upload_id})
            .projection(doc! {"_id": 1})
            .await?
            .is_some())
    }
}
