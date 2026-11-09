//! 草稿、草稿区块、预览令牌，以及接口服务进程内处理的 `ops_from_upload` 任务记录（设计 5.6、6.4）。
//!
//! ```text
//! drafts { _id, spaceId, owner, scope, baseSeq, rev, createdBy, status: open | published,
//!          ops,                       // 经 /ops 追加的操作（内联）
//!          opsRefs: [{assetHash, after, count}],  // 经上传追加的操作：在第 after 条内联操作之后
//!          touched, resultChunks,     // 草稿碰过的键、结果区块（全 0 的区块不列出 = 删除）
//!          resultEntities, resultAnchors: [{id, hash|null}],   // 结果记录（body 在 records 里）
//!          provisionalBlocks: [{name, id, block}],             // 草稿新增的方块（临时编号）
//!          assets,                    // 草稿引用的资源（预览可读）
//!          commitId?, createdAt, updatedAt, expiresAt }        // 30 天过期
//! draftChunks { _id: "<草稿编号>:<区块哈希>", draftId, spaceId, owner, hash, data, expiresAt }
//! previews { _id: sha256(令牌), spaceId, owner, draftId, rev, createdBy, createdAt, expiresAt }
//! ```
//!
//! 过期清理由处理服务的循环按 `expiresAt`（RFC 3339 字符串）进行，不用 TTL 索引。

use std::collections::BTreeMap;

use metaverse_core::model::{Author, DraftChunk, IdChange, Owner, Touched};
use metaverse_core::ops::{BlockDef, Op};
use metaverse_core::scope::PathScope;
use metaverse_core::Timestamp;
use mongodb::bson::{doc, oid::ObjectId, spec::BinarySubtype, Binary, Bson, Document};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::commits::{
    corrupt, from_document, granted_children, insert_ignoring_duplicates, owner_document, to_bson,
    to_document,
};
use super::{collections, Repo, RepoError};
use crate::auth::{AuthorizerKey, Grant};

/// 草稿状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DraftStatus {
    #[default]
    Open,
    Published,
}

/// 一段经上传追加的操作。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsRef {
    pub asset_hash: String,
    /// 在第几条内联操作之后应用（重放时按这个顺序穿插）。
    pub after: u64,
    pub count: u64,
}

/// 草稿新增的方块：临时名称 → 临时编号。发布时按最新的方块表分配正式编号。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvisionalBlock {
    pub name: String,
    pub id: u16,
    pub block: BlockDef,
}

/// 草稿文档（`metaverse_core::model::Draft` 的超集）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftDoc {
    #[serde(rename = "_id")]
    pub id: String,
    pub space_id: String,
    pub owner: Owner,
    pub scope: PathScope,
    pub base_seq: u64,
    pub rev: u64,
    pub created_by: Author,
    #[serde(default)]
    pub status: DraftStatus,
    #[serde(default)]
    pub ops: Vec<Op>,
    #[serde(default)]
    pub ops_refs: Vec<OpsRef>,
    #[serde(default)]
    pub touched: Touched,
    #[serde(default)]
    pub result_chunks: Vec<DraftChunk>,
    #[serde(default)]
    pub result_entities: Vec<IdChange>,
    #[serde(default)]
    pub result_anchors: Vec<IdChange>,
    #[serde(default)]
    pub provisional_blocks: Vec<ProvisionalBlock>,
    #[serde(default)]
    pub assets: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_id: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub expires_at: Timestamp,
}

impl DraftDoc {
    /// 草稿里的操作总数（内联 + 上传）。
    pub fn op_count(&self) -> u64 {
        self.ops.len() as u64 + self.ops_refs.iter().map(|r| r.count).sum::<u64>()
    }
}

/// 预览令牌记录（授权层用）。
#[derive(Debug, Clone)]
pub struct PreviewRecord {
    pub space_id: String,
    pub owner: Owner,
    pub draft_id: String,
    pub rev: u64,
    pub expires_at: Timestamp,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewDocument {
    space_id: String,
    owner: Owner,
    draft_id: String,
    rev: u64,
    expires_at: Timestamp,
}

/// 新的预览令牌记录。
#[derive(Debug, Clone, Copy)]
pub struct NewPreview<'a> {
    /// `sha256(令牌原文)`。
    pub token_hash: &'a str,
    pub draft_id: &'a str,
    pub rev: u64,
    pub created_by: &'a str,
    pub now: Timestamp,
    pub expires_at: Timestamp,
}

/// 读 ops 文件的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpsAsset {
    Missing,
    TooLarge(u64),
    Bytes(Vec<u8>),
}

/// `ops_from_upload` 要读的资源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpsUpload {
    pub asset_hash: String,
    pub upload_id: Option<String>,
}

fn draft_filter(grant: &Grant, draft_id: &str) -> Document {
    let mut filter = granted_children(grant);
    filter.insert("_id", draft_id);
    filter
}

fn upload_id_values(upload_id: &str) -> Bson {
    let mut values = vec![Bson::String(upload_id.to_owned())];
    if let Ok(oid) = ObjectId::parse_str(upload_id) {
        values.push(Bson::ObjectId(oid));
    }
    Bson::Document(doc! {"$in": values})
}

impl Repo {
    pub async fn insert_draft(&self, grant: &Grant, draft: &DraftDoc) -> Result<(), RepoError> {
        if !grant.can_manage()
            || draft.space_id != grant.space_id()
            || &draft.owner != grant.owner()
        {
            return Err(RepoError::GrantMismatch);
        }
        self.collection(collections::DRAFTS)
            .insert_one(to_document(draft)?)
            .await?;
        Ok(())
    }

    pub async fn draft(
        &self,
        grant: &Grant,
        draft_id: &str,
    ) -> Result<Option<DraftDoc>, RepoError> {
        let found = self
            .collection(collections::DRAFTS)
            .find_one(draft_filter(grant, draft_id))
            .await?;
        found.map(from_document).transpose()
    }

    /// 按 `rev` 条件保存草稿（`rev` 由调用方加一）。草稿已被别人改过或已发布时返回 `false`。
    pub async fn save_draft(
        &self,
        grant: &Grant,
        draft: &DraftDoc,
        expected_rev: u64,
    ) -> Result<bool, RepoError> {
        if !grant.can_manage()
            || draft.space_id != grant.space_id()
            || &draft.owner != grant.owner()
        {
            return Err(RepoError::GrantMismatch);
        }
        let mut filter = draft_filter(grant, &draft.id);
        filter.insert("rev", expected_rev as i64);
        filter.insert("status", "open");
        let result = self
            .collection(collections::DRAFTS)
            .replace_one(filter, to_document(draft)?)
            .await?;
        Ok(result.matched_count == 1)
    }

    /// 发布后（草稿已在提交事务里标记为已发布）：预览令牌和草稿区块随即作废。只在草稿确实
    /// 已发布时才删，避免误删仍在使用的草稿的区块。
    pub async fn clear_published_draft(
        &self,
        grant: &Grant,
        draft_id: &str,
    ) -> Result<(), RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let mut filter = draft_filter(grant, draft_id);
        filter.insert("status", "published");
        let published = self
            .collection(collections::DRAFTS)
            .find_one(filter)
            .projection(doc! {"_id": 1})
            .await?
            .is_some();
        if !published {
            return Ok(());
        }
        self.delete_draft_children(grant, draft_id).await
    }

    async fn delete_draft_children(&self, grant: &Grant, draft_id: &str) -> Result<(), RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("draftId", draft_id);
        self.collection(collections::PREVIEWS)
            .delete_many(filter.clone())
            .await?;
        self.collection(collections::DRAFT_CHUNKS)
            .delete_many(filter)
            .await?;
        Ok(())
    }

    /// 丢弃草稿：草稿、预览令牌、草稿区块一起删除。返回草稿是否存在。
    pub async fn delete_draft(&self, grant: &Grant, draft_id: &str) -> Result<bool, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let deleted = self
            .collection(collections::DRAFTS)
            .delete_one(draft_filter(grant, draft_id))
            .await?;
        self.delete_draft_children(grant, draft_id).await?;
        Ok(deleted.deleted_count == 1)
    }

    /// 草稿区块：按 `草稿编号:哈希` 幂等写入。
    pub async fn put_draft_chunks(
        &self,
        grant: &Grant,
        draft_id: &str,
        chunks: &[(String, Vec<u8>)],
        expires_at: Timestamp,
    ) -> Result<(), RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let owner = owner_document(grant)?;
        let documents = chunks
            .iter()
            .map(|(hash, data)| {
                doc! {
                    "_id": format!("{draft_id}:{hash}"),
                    "draftId": draft_id,
                    "spaceId": grant.space_id(),
                    "owner": owner.clone(),
                    "hash": hash,
                    "data": Binary { subtype: BinarySubtype::Generic, bytes: data.clone() },
                    "expiresAt": expires_at.to_rfc3339(),
                }
            })
            .collect();
        insert_ignoring_duplicates(self.collection(collections::DRAFT_CHUNKS), documents).await
    }

    /// 草稿区块的存储字节（zlib 压缩），按哈希。
    pub async fn draft_chunk_data(
        &self,
        grant: &Grant,
        draft_id: &str,
        hashes: &[&str],
    ) -> Result<BTreeMap<String, Vec<u8>>, RepoError> {
        let mut found = BTreeMap::new();
        for batch in hashes.chunks(256) {
            let ids: Vec<String> = batch.iter().map(|h| format!("{draft_id}:{h}")).collect();
            let mut filter = granted_children(grant);
            filter.insert("_id", doc! {"$in": ids});
            let mut cursor = self
                .collection(collections::DRAFT_CHUNKS)
                .find(filter)
                .projection(doc! {"hash": 1, "data": 1})
                .await?;
            while cursor.advance().await? {
                let document: Document = cursor.deserialize_current().map_err(corrupt)?;
                found.insert(
                    document.get_str("hash").map_err(corrupt)?.to_owned(),
                    document
                        .get_binary_generic("data")
                        .map_err(corrupt)?
                        .clone(),
                );
            }
        }
        Ok(found)
    }

    /// 预览读基础版本的区块：哈希必须出现在本空间 `seq ≤ upto` 的提交里，并且已发布。
    pub async fn space_chunk_upto(
        &self,
        grant: &Grant,
        hash: &str,
        upto: u64,
    ) -> Result<Option<Vec<u8>>, RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("changedChunks.hash", hash);
        filter.insert("seq", doc! {"$lte": upto as i64});
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
            .find_one(doc! {"_id": hash, "publishedAt": {"$exists": true}})
            .projection(doc! {"data": 1})
            .await?;
        found
            .map(|document| {
                document
                    .get_binary_generic("data")
                    .cloned()
                    .map_err(corrupt)
            })
            .transpose()
    }

    pub async fn insert_preview(
        &self,
        grant: &Grant,
        preview: &NewPreview<'_>,
    ) -> Result<(), RepoError> {
        let NewPreview {
            token_hash,
            draft_id,
            rev,
            created_by,
            now,
            expires_at,
        } = *preview;
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        self.collection(collections::PREVIEWS)
            .insert_one(doc! {
                "_id": token_hash,
                "spaceId": grant.space_id(),
                "owner": owner_document(grant)?,
                "draftId": draft_id,
                "rev": rev as i64,
                "createdBy": created_by,
                "createdAt": now.to_rfc3339(),
                "expiresAt": expires_at.to_rfc3339(),
            })
            .await?;
        Ok(())
    }

    /// 授权层按令牌哈希找预览记录（不带空间凭据：令牌本身就是凭据）。
    pub async fn preview_by_hash(
        &self,
        _key: &AuthorizerKey,
        token_hash: &str,
    ) -> Result<Option<PreviewRecord>, RepoError> {
        let found = self
            .collection(collections::PREVIEWS)
            .find_one(doc! {"_id": token_hash})
            .await?;
        found
            .map(|document| {
                let record: PreviewDocument = from_document(document)?;
                Ok(PreviewRecord {
                    space_id: record.space_id,
                    owner: record.owner,
                    draft_id: record.draft_id,
                    rev: record.rev,
                    expires_at: record.expires_at,
                })
            })
            .transpose()
    }

    /// `ops-from-upload` 的资源：必须是本空间 `ops` 用途、已校验完成（`status: done`）的上传。
    /// 按上传编号或资源哈希找，二选一。
    pub async fn ops_upload(
        &self,
        grant: &Grant,
        upload_id: Option<&str>,
        asset_hash: Option<&str>,
    ) -> Result<Option<OpsUpload>, RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("purpose", "ops");
        filter.insert("status", "done");
        match (upload_id, asset_hash) {
            (Some(id), None) => {
                filter.insert("_id", upload_id_values(id));
            }
            (None, Some(hash)) => {
                filter.insert("assetHash", hash);
            }
            _ => return Ok(None),
        }
        let found = self
            .collection(collections::UPLOADS)
            .find_one(filter)
            .projection(doc! {"_id": 1, "assetHash": 1, "reused": 1})
            .await?;
        // "直接复用"的上传没有传过数据，资源还要按所有权规则属于本空间（旧版本按哈希就允许复用）。
        if let Some(document) = &found {
            if document.get_bool("reused").unwrap_or(false) {
                let hash = document.get_str("assetHash").unwrap_or_default();
                if self.space_owned_asset(grant, hash).await?.is_none() {
                    return Ok(None);
                }
            }
        }
        Ok(found.and_then(|document| {
            let hash = document.get_str("assetHash").ok()?.to_owned();
            let id = match document.get("_id") {
                Some(Bson::String(id)) => Some(id.clone()),
                Some(Bson::ObjectId(oid)) => Some(oid.to_hex()),
                _ => None,
            };
            Some(OpsUpload {
                asset_hash: hash,
                upload_id: id,
            })
        }))
    }

    /// 读 `ops` 用途的资源（整份，核对哈希）。
    pub async fn read_ops_asset(
        &self,
        grant: &Grant,
        hash: &str,
        max_bytes: u64,
    ) -> Result<OpsAsset, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        // ops 文件本来就不登记在 assetRefs 里，调用方已经核对过它属于本空间的上传。
        let Some(meta) = self.asset_meta_unchecked(hash).await? else {
            return Ok(OpsAsset::Missing);
        };
        if meta.length > max_bytes {
            return Ok(OpsAsset::TooLarge(meta.length));
        }
        self.read_asset_bytes(&meta, max_bytes)
            .await
            .map(OpsAsset::Bytes)
    }

    /// 草稿引用的资源（预览读草稿新上传的资源）：哈希必须在草稿的 `assets` 里。
    pub async fn draft_asset(
        &self,
        grant: &Grant,
        draft: &DraftDoc,
        hash: &str,
    ) -> Result<Option<super::blobs::AssetMeta>, RepoError> {
        if draft.space_id != grant.space_id() || !draft.assets.iter().any(|h| h == hash) {
            return Ok(None);
        }
        self.asset_meta_unchecked(hash).await
    }

    // -----------------------------------------------------------------------
    // ops_from_upload 任务记录（接口服务进程内处理，处理服务不领取）
    // -----------------------------------------------------------------------

    /// 新建 `ops_from_upload` 任务记录：状态直接是 `running`，`attempt = maxAttempts = 1`，
    /// 处理服务的领取条件（`attempt < maxAttempts`、种类列表）不会选中它；租约过期后由
    /// 处理服务的回收逻辑标记为失败（接口服务进程在处理中途退出时）。
    ///
    /// `scope` 是草稿的路径范围（与 `create_job` 存的格式相同：`physical` 或 `plot:<编号>`），
    /// 经地块路径只能查到本地块的任务，所以必须写上。
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_ops_job(
        &self,
        grant: &Grant,
        job_id: &str,
        scope: &PathScope,
        params: &Value,
        actor_sub: &str,
        actor_service: &str,
        now: Timestamp,
        lease_until: Timestamp,
    ) -> Result<(), RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        self.collection(collections::JOBS)
            .insert_one(doc! {
                "_id": job_id,
                "spaceId": grant.space_id(),
                "owner": owner_document(grant)?,
                "kind": "ops_from_upload",
                "params": to_bson(params)?,
                "status": "running",
                "leaseOwner": "api",
                "leaseUntil": lease_until.to_rfc3339(),
                "attempt": 1,
                "maxAttempts": 1,
                "actor": {"sub": actor_sub, "nyxServiceId": actor_service},
                "scope": scope.to_string(),
                "progress": {"opsApplied": 0},
                "createdAt": now.to_rfc3339(),
                "startedAt": now.to_rfc3339(),
            })
            .await?;
        Ok(())
    }

    /// 更新进度（只在任务仍由接口服务持有时）。
    pub async fn ops_job_progress(
        &self,
        grant: &Grant,
        job_id: &str,
        ops_applied: u64,
        ops_total: u64,
    ) -> Result<(), RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("_id", job_id);
        filter.insert("status", "running");
        self.collection(collections::JOBS)
            .update_one(
                filter,
                doc! {"$set": {"progress": {"opsApplied": ops_applied as i64, "opsTotal": ops_total as i64}}},
            )
            .await?;
        Ok(())
    }

    /// 结束任务：成功写 `result`，失败写 `lastError`。
    pub async fn finish_ops_job(
        &self,
        grant: &Grant,
        job_id: &str,
        outcome: Result<&Value, &str>,
        now: Timestamp,
    ) -> Result<(), RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("_id", job_id);
        filter.insert("status", "running");
        let set = match outcome {
            Ok(result) => doc! {
                "status": "done",
                "result": to_bson(result)?,
                "finishedAt": now.to_rfc3339(),
            },
            Err(error) => doc! {
                "status": "failed",
                "lastError": error.chars().take(2000).collect::<String>(),
                "lastErrorAt": now.to_rfc3339(),
                "finishedAt": now.to_rfc3339(),
            },
        };
        self.collection(collections::JOBS)
            .update_one(filter, doc! {"$set": set, "$unset": {"leaseUntil": ""}})
            .await?;
        Ok(())
    }
}
