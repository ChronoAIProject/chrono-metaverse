//! 任务（设计 6.4）。接口服务只负责创建和查询；领取、续约、写回由处理服务做
//! （`worker/src/metaverse_worker/jobs/lease.py`）。
//!
//! 任务文档就是 `metaverse_core::model::Job`：`status = queued`、`attempt = 0`、
//! `maxAttempts = 3`、`createdAt`（RFC 3339，处理服务按它的先后领取），另有发起者 `actor`、
//! 路径范围 `scope`。带 `Idempotency-Key` 时任务编号由键算出，重复请求返回同一个任务。

use metaverse_core::model::{Job, JobStatus, JOB_HISTORY_MAX};
use metaverse_core::scope::PathScope;
use mongodb::bson::{doc, Document};

use super::uploads::{from_document, space_children, to_document};
use super::{collections, Repo, RepoError};
use crate::auth::Grant;

/// 一次最多列出的任务数。
pub const MAX_JOB_LIST: i64 = 100;

/// 插入任务的结果。
#[derive(Debug, Clone, PartialEq)]
pub enum JobInsert {
    Inserted,
    /// 同一个编号的任务已经存在（幂等键重复）。
    Existing(Box<Job>),
}

impl Repo {
    /// 本空间排队中和运行中的任务数。
    pub async fn pending_jobs(&self, grant: &Grant) -> Result<u64, RepoError> {
        let mut filter = space_children(grant);
        filter.insert("status", doc! {"$in": ["queued", "running"]});
        Ok(self
            .collection(collections::JOBS)
            .count_documents(filter)
            .await?)
    }

    /// 这个草稿有没有排队中或运行中的 `ops_from_upload` 任务（交包时，一个重建草稿只收一个包）。
    pub async fn draft_has_pending_job(
        &self,
        grant: &Grant,
        draft_id: &str,
    ) -> Result<bool, RepoError> {
        let mut filter = space_children(grant);
        filter.insert("kind", "ops_from_upload");
        filter.insert("params.draftId", draft_id);
        filter.insert("status", doc! {"$in": ["queued", "running"]});
        Ok(self
            .collection(collections::JOBS)
            .find_one(filter)
            .projection(doc! {"_id": 1})
            .await?
            .is_some())
    }

    pub async fn insert_job(&self, grant: &Grant, job: &Job) -> Result<JobInsert, RepoError> {
        if !grant.can_manage() || job.space_id != grant.space_id() || &job.owner != grant.owner() {
            return Err(RepoError::GrantMismatch);
        }
        match self
            .collection(collections::JOBS)
            .insert_one(to_document(job)?)
            .await
        {
            Ok(_) => Ok(JobInsert::Inserted),
            Err(error) => match RepoError::from(error) {
                RepoError::Duplicate => match self.job(grant, &job.id).await? {
                    Some(existing) => Ok(JobInsert::Existing(Box::new(existing))),
                    // 同编号的任务属于别的空间：不暴露，按冲突处理。
                    None => Err(RepoError::Duplicate),
                },
                other => Err(other),
            },
        }
    }

    pub async fn job(&self, grant: &Grant, job_id: &str) -> Result<Option<Job>, RepoError> {
        let mut filter = space_children(grant);
        filter.insert("_id", job_id);
        self.collection(collections::JOBS)
            .find_one(filter)
            .await?
            .map(from_document)
            .transpose()
    }

    /// 最近的任务，按创建时间倒序。给了 `scope` 时只列这个路径范围发起的任务。
    pub async fn recent_jobs(
        &self,
        grant: &Grant,
        scope: Option<&PathScope>,
        status: Option<JobStatus>,
        limit: i64,
    ) -> Result<Vec<Job>, RepoError> {
        let mut filter = space_children(grant);
        if let Some(scope) = scope {
            filter.insert("scope", scope.to_string());
        }
        if let Some(status) = status {
            filter.insert("status", super::uploads::to_bson(&status)?);
        }
        let mut cursor = self
            .collection(collections::JOBS)
            .find(filter)
            .sort(doc! {"createdAt": -1, "_id": -1})
            .limit(limit.clamp(1, MAX_JOB_LIST))
            .await?;
        let mut jobs = Vec::new();
        while cursor.advance().await? {
            let document: Document = cursor
                .deserialize_current()
                .map_err(|error| RepoError::Corrupt(error.to_string()))?;
            jobs.push(from_document(document)?);
        }
        Ok(jobs)
    }

    /// 部署种子重新排队（docs/design/server-slim.md 7.2 第 2 步）：上一次因为下载失败而最终失败的
    /// 任务改回 `queued`、`attempt` 归零、去掉 `notBefore`，上一次的错误追加进 `history`（最多留
    /// [`JOB_HISTORY_MAX`] 条）。按读到的状态和尝试次数做条件更新，别的副本同时重新排队时只有一个
    /// 成功。返回是否改成了。
    pub async fn requeue_failed_job(&self, grant: &Grant, job: &Job) -> Result<bool, RepoError> {
        if !grant.can_manage() || job.space_id != grant.space_id() || &job.owner != grant.owner() {
            return Err(RepoError::GrantMismatch);
        }
        let mut history = job.history.clone();
        history.extend(job.last_error.iter().cloned());
        let keep = history.len().saturating_sub(JOB_HISTORY_MAX);
        history.drain(..keep);
        let mut filter = space_children(grant);
        filter.insert("_id", &job.id);
        filter.insert("status", "failed");
        filter.insert("attempt", i64::from(job.attempt));
        let result = self
            .collection(collections::JOBS)
            .update_one(
                filter,
                doc! {
                    "$set": {"status": "queued", "attempt": 0_i64, "history": super::uploads::to_bson(&history)?},
                    "$unset": {"notBefore": "", "finishedAt": "", "leaseOwner": "", "leaseUntil": ""},
                },
            )
            .await?;
        Ok(result.modified_count == 1)
    }

    /// 这个扫描（资源哈希）是否已经导入过本空间（有提交引用了它）。
    pub async fn scan_committed(&self, grant: &Grant, scan_hash: &str) -> Result<bool, RepoError> {
        let mut filter = space_children(grant);
        filter.insert("scan.assetHash", scan_hash);
        Ok(self
            .collection(collections::COMMITS)
            .find_one(filter)
            .projection(doc! {"_id": 1})
            .await?
            .is_some())
    }
}
