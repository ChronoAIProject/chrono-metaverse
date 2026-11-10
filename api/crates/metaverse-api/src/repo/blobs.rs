//! 内容寻址数据的读取：已发布的区块、GridFS 桶 `assets` 里的资源（设计 8.2、13.2）。
//!
//! - 公开区块只返回带 `publishedAt` 的；
//! - 公开资源只返回登记在 `assetRefs` 里的（网页用模型、方块表贴图、处理后的物件模型）；
//! - 资源是标准 GridFS 文件：`assets.files {_id, length, chunkSize, filename = 内容哈希, metadata}`
//!   + `assets.chunks {files_id, n, data}`（与处理服务 `assets.py` 相同）。分段读取只取用到的数据块。

use std::collections::{BTreeMap, BTreeSet};
use std::pin::Pin;

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use mongodb::bson::{doc, Bson, Document};

use metaverse_core::check::{fits, AssetCheck};
use metaverse_core::limits::UploadLimits;

use super::commits::{corrupt, granted_children, stored_chunk, StoredChunk};
use super::{collections, Repo, RepoError};
use crate::auth::{BlobGrant, Grant};

/// GridFS 数据块大小（与处理服务 `ASSET_CHUNK_SIZE` 相同）。
pub const ASSET_CHUNK_SIZE: usize = 256 * 1024;
/// 登记资源时同名资源恰好被清理删掉、重新插入的次数（与处理服务 `_REGISTER_ATTEMPTS` 相同）。
const REGISTER_ATTEMPTS: usize = 3;

/// 资源的元数据。
#[derive(Debug, Clone)]
pub struct AssetMeta {
    pub hash: String,
    pub(super) files_id: Bson,
    pub length: u64,
    pub chunk_size: u64,
    /// 登记时写入的 `metadata.contentType`（只作参考，响应的 Content-Type 由服务端按白名单固定）。
    pub content_type: Option<String>,
    pub kind: Option<String>,
    /// 第一个登记它的空间（`metadata.spaceId`）。资源按内容全局去重，别的空间上传或导入了
    /// 同一份内容时这里不变，所以"属于哪些空间"要看 [`Repo::owned_assets`]。
    pub space_id: Option<String>,
    /// 服务端从内容实测的核对记录（`metadata.check`，docs/design/server-slim.md 4.6）；旧资源没有，
    /// 由后台迁移补上；读不懂（更新的版本写的不认识的格式）时也为空。
    pub check: Option<metaverse_core::check::AssetCheck>,
    /// 后台迁移补核对记录时检查不过（`metadata.checkError`）：不能再被新引用。
    pub check_failed: bool,
}

impl AssetMeta {
    /// GridFS 文件编号是不是这个上传编号（这份资源就是这次上传登记的）。
    pub fn files_id_is(&self, upload_id: &str) -> bool {
        matches!(&self.files_id, Bson::String(id) if id == upload_id)
    }

    /// 核对记录是当前版本（不是旧版本写的）。
    pub fn current_check(&self) -> Option<&metaverse_core::check::AssetCheck> {
        self.check
            .as_ref()
            .filter(|check| check.v >= metaverse_core::check::CHECK_VERSION)
    }
}

/// `metadata.check` → 核对记录。
pub(super) fn parse_check(
    metadata: Option<&Document>,
) -> Option<metaverse_core::check::AssetCheck> {
    let check = metadata?.get_document("check").ok()?;
    mongodb::bson::deserialize_from_document(check.clone()).ok()
}

/// 资源被引用时的角色（docs/design/server-slim.md 4.6）：核心库的 [`metaverse_core::check::AssetRole`]。
/// 能不能按某个角色引用，看服务端实测的核对记录（`metadata.check`）是否满足这个角色的条件
/// （[`metaverse_core::check::fits`]，上限按当前配置），不看第一次登记的人写的 `metadata.kind`。
pub use metaverse_core::check::AssetRole;

/// [`Repo::put_asset_bytes_with`] 的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PutAsset {
    /// 内容哈希（也是 GridFS 文件名）。
    pub hash: String,
    /// 已有同一内容的资源，复用了它（没有写新数据块）。
    pub reused: bool,
}

/// 资源不能按某个用途引用的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetRejection {
    /// 没有这个资源。
    Missing,
    /// 不属于本空间：本空间没有登记、上传、导入或在提交里引用过它。
    Foreign,
    /// 没有当前版本的核对记录（旧资源还没补上，或补核对时检查不过）。
    Unchecked,
    /// 核对记录不合这个角色（格式不对，或超出当前配置的上限）。
    Unfit(String),
}

/// 一个不能引用的资源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnusableAsset {
    pub hash: String,
    pub role: AssetRole,
    pub reason: AssetRejection,
}

/// 资源不在时给调用方看的说明：可能从没登记过，也可能已被定期清理删掉。
pub const MISSING_ASSET: &str =
    "不存在（上传后 7 天内没被引用的资源会被清理，请重新上传；内容相同，哈希也相同）";

fn role_name(role: AssetRole) -> &'static str {
    match role {
        AssetRole::Scan => "原始扫描",
        AssetRole::WebModel => "网页用模型",
        AssetRole::Model => "物件模型",
        AssetRole::Texture => "贴图",
        AssetRole::Script => "文本",
        AssetRole::Bundle => "重建包清单",
        AssetRole::Ops => "操作文件",
    }
}

impl UnusableAsset {
    /// 给调用方看的说明。
    pub fn describe(&self) -> String {
        let reason = match &self.reason {
            AssetRejection::Missing => MISSING_ASSET.to_owned(),
            AssetRejection::Foreign => "不属于本空间".to_owned(),
            AssetRejection::Unchecked => format!(
                "还没有服务端的核对记录，不能当{}引用（请按用途重新上传同一份文件，核对通过后再引用）",
                role_name(self.role)
            ),
            AssetRejection::Unfit(message) => {
                format!("不能当{}引用：{message}", role_name(self.role))
            }
        };
        format!("{}：{reason}", self.hash)
    }
}

/// 按角色检查一批引用的结果：不能用的，以及能用的资源的核对记录和长度（调用方再按需要做
/// 模型与记录一致之类的检查）。
#[derive(Debug, Clone, Default)]
pub struct AssetRoleCheck {
    pub unusable: Vec<UnusableAsset>,
    pub checks: BTreeMap<String, AssetCheck>,
    pub lengths: BTreeMap<String, u64>,
}

/// 一份资源的核对记录能不能按这个角色引用（只看 `metadata`，归属另外判断）。
fn check_fits(
    metadata: Option<&Document>,
    role: AssetRole,
    limits: &UploadLimits,
) -> Result<AssetCheck, AssetRejection> {
    if metadata.is_some_and(|m| m.contains_key("checkError")) {
        return Err(AssetRejection::Unchecked);
    }
    let check = parse_check(metadata)
        .filter(|check| check.v >= metaverse_core::check::CHECK_VERSION)
        .ok_or(AssetRejection::Unchecked)?;
    fits(role, &check, limits).map_err(|error| AssetRejection::Unfit(error.0))?;
    Ok(check)
}

/// 资源字节流。
pub type AssetStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

/// 点分路径上的字符串（值是数组时取其中的字符串）。
fn strings_at(document: &Document, path: &str, into: &mut Vec<String>) {
    let mut current = Some(Bson::Document(document.clone()));
    for segment in path.split('.') {
        current = match current {
            Some(Bson::Document(inner)) => inner.get(segment).cloned(),
            _ => None,
        };
    }
    match current {
        Some(Bson::String(value)) => into.push(value),
        Some(Bson::Array(items)) => into.extend(items.into_iter().filter_map(|item| match item {
            Bson::String(value) => Some(value),
            _ => None,
        })),
        _ => {}
    }
}

fn number(document: &Document, key: &str) -> Option<u64> {
    match document.get(key)? {
        Bson::Int32(value) => u64::try_from(*value).ok(),
        Bson::Int64(value) => u64::try_from(*value).ok(),
        Bson::Double(value) if value.is_finite() && *value >= 0.0 => Some(*value as u64),
        _ => None,
    }
}

impl Repo {
    /// 公开区块：只返回已发布的。
    pub async fn published_chunk(
        &self,
        _grant: &BlobGrant,
        hash: &str,
    ) -> Result<Option<StoredChunk>, RepoError> {
        let found = self
            .collection(collections::CHUNKS)
            .find_one(doc! {"_id": hash, "publishedAt": {"$exists": true}})
            .projection(doc! {"data": 1, "publishedAt": 1})
            .await?;
        found.map(|document| stored_chunk(&document)).transpose()
    }

    pub(super) async fn asset_meta_unchecked(
        &self,
        hash: &str,
    ) -> Result<Option<AssetMeta>, RepoError> {
        let found = self
            .collection(collections::ASSET_FILES)
            .find_one(doc! {"filename": hash})
            .projection(doc! {"_id": 1, "length": 1, "chunkSize": 1, "metadata": 1})
            .await?;
        let Some(document) = found else {
            return Ok(None);
        };
        let files_id = document
            .get("_id")
            .cloned()
            .ok_or_else(|| RepoError::Corrupt("资源缺少 _id".into()))?;
        let length = number(&document, "length")
            .ok_or_else(|| RepoError::Corrupt(format!("资源 {hash} 的长度不对")))?;
        let chunk_size = number(&document, "chunkSize")
            .filter(|size| *size > 0)
            .ok_or_else(|| RepoError::Corrupt(format!("资源 {hash} 的数据块大小不对")))?;
        let metadata = document.get_document("metadata").ok();
        Ok(Some(AssetMeta {
            hash: hash.to_owned(),
            files_id,
            length,
            chunk_size,
            content_type: metadata
                .and_then(|m| m.get_str("contentType").ok())
                .map(str::to_owned),
            kind: metadata
                .and_then(|m| m.get_str("kind").ok())
                .map(str::to_owned),
            space_id: metadata
                .and_then(|m| m.get_str("spaceId").ok())
                .map(str::to_owned),
            check: parse_check(metadata),
            check_failed: metadata.is_some_and(|m| m.contains_key("checkError")),
        }))
    }

    /// 后台执行器读资源的元数据（调用方已经核对过资源属于这个空间：上传核对时就是本空间刚上传的
    /// 内容，`ops_from_upload` 在建任务时核对过操作文件属于本空间）。
    pub async fn asset_meta_for_runner(
        &self,
        grant: &Grant,
        hash: &str,
    ) -> Result<Option<AssetMeta>, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        self.asset_meta_unchecked(hash).await
    }

    /// 这次上传之前已经登记成资源（`files._id` = 上传编号）时的元数据。
    pub async fn asset_registered_by_upload(
        &self,
        grant: &Grant,
        upload_id: &str,
    ) -> Result<Option<AssetMeta>, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let found = self
            .collection(collections::ASSET_FILES)
            .find_one(doc! {"_id": upload_id})
            .projection(doc! {"filename": 1})
            .await?;
        match found
            .as_ref()
            .and_then(|document| document.get_str("filename").ok())
        {
            Some(hash) => self.asset_meta_unchecked(hash).await,
            None => Ok(None),
        }
    }

    /// 公开资源：只返回登记在 `assetRefs` 里的。
    pub async fn published_asset(
        &self,
        _grant: &BlobGrant,
        hash: &str,
    ) -> Result<Option<AssetMeta>, RepoError> {
        let registered = self
            .collection(collections::ASSET_REFS)
            .find_one(doc! {"hash": hash})
            .projection(doc! {"_id": 1})
            .await?
            .is_some();
        if !registered {
            return Ok(None);
        }
        self.asset_meta_unchecked(hash).await
    }

    /// 本空间第 `upto` 版及以前的提交登记过的资源（预览读基础版本的资源，设计 2.8）。
    ///
    /// `assetRefs` 的 `seq` 是最早引用它的提交的版本号；瘦身前写的只有 `commitId`（第一次引用它的
    /// 提交），按它查版本号。只由事件类型登记过、没有被提交引用过的不算（预览不显示事件）。
    pub async fn space_asset_upto(
        &self,
        grant: &Grant,
        hash: &str,
        upto: u64,
    ) -> Result<Option<AssetMeta>, RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("hash", hash);
        let Some(found) = self
            .collection(collections::ASSET_REFS)
            .find_one(filter)
            .projection(doc! {"seq": 1, "commitId": 1})
            .await?
        else {
            return Ok(None);
        };
        let seq = match found.get("seq") {
            Some(Bson::Int64(value)) => Some(*value),
            Some(Bson::Int32(value)) => Some(i64::from(*value)),
            _ => None,
        };
        let within = match (seq, found.get_str("commitId")) {
            (Some(seq), _) => u64::try_from(seq).is_ok_and(|seq| seq <= upto),
            (None, Ok(commit_id)) => {
                let mut filter = granted_children(grant);
                filter.insert("_id", commit_id);
                filter.insert("seq", doc! {"$lte": upto as i64});
                self.collection(collections::COMMITS)
                    .find_one(filter)
                    .projection(doc! {"_id": 1})
                    .await?
                    .is_some()
            }
            (None, Err(_)) => false,
        };
        if !within {
            return Ok(None);
        }
        self.asset_meta_unchecked(hash).await
    }

    /// 本空间拥有 `hashes` 里的哪些资源。资源按内容全局去重，`metadata.spaceId` 只记第一个登记
    /// 的空间，所以按下面任何一条都算本空间的（依次查，查到的不再往下查）：
    ///
    /// 1. `metadata.spaceId` 是本空间（调用方已经从 `assets.files` 读出，传在 `registered_here`），
    ///    并且是本空间**这一次创建之后**登记的（空间编号删除后可以被别人重新注册，旧空间登记的
    ///    资源不归新空间）；
    /// 2. 本空间（同一主人）的 `assetRefs` 登记过（提交或事件类型引用过）；
    /// 3. 本空间有 `status: done`、`assetHash` 是它、**真正传过数据**的上传。哈希已存在时
    ///    "直接复用、不收数据"的上传（`reused: true`）不算：只凭哈希不能确立所有权；
    ///    复用本来也只对本空间已经拥有的资源开放；
    /// 4. 本空间有 `status: done` 的 `model_import` 任务，结果 `modelHash` 是它；
    /// 5. 本空间的提交引用过它（`scan.assetHash`、`scan.webModelHashes`、`opsRef`）。
    pub async fn owned_assets(
        &self,
        grant: &Grant,
        hashes: &[String],
        registered_here: BTreeSet<String>,
    ) -> Result<BTreeSet<String>, RepoError> {
        if !grant.can_read_internal() {
            return Err(RepoError::GrantMismatch);
        }
        let mut owned: BTreeSet<String> = BTreeSet::new();
        // 1. metadata.spaceId，且登记时间不早于本空间这一次创建
        let candidates: Vec<String> = registered_here
            .into_iter()
            .filter(|hash| hashes.contains(hash))
            .collect();
        if !candidates.is_empty() {
            if let Some(created) = self.space_created_at(grant).await? {
                self.collect_strings(
                    collections::ASSET_FILES,
                    doc! {
                        "filename": {"$in": &candidates},
                        "metadata.spaceId": grant.space_id(),
                        "uploadDate": {"$gte": mongodb::bson::DateTime::from_millis(created.millis())},
                    },
                    &["filename"],
                    &candidates,
                    &mut owned,
                )
                .await?;
            }
        }
        let remaining = |owned: &BTreeSet<String>| -> Vec<String> {
            let mut left: Vec<String> = hashes
                .iter()
                .filter(|hash| !owned.contains(*hash))
                .cloned()
                .collect();
            left.sort();
            left.dedup();
            left
        };
        // 2. assetRefs
        let left = remaining(&owned);
        if left.is_empty() {
            return Ok(owned);
        }
        let mut filter = granted_children(grant);
        filter.insert("hash", doc! {"$in": &left});
        self.collect_strings(
            collections::ASSET_REFS,
            filter,
            &["hash"],
            &left,
            &mut owned,
        )
        .await?;
        // 3. 本空间完成的上传
        let left = remaining(&owned);
        if left.is_empty() {
            return Ok(owned);
        }
        let mut filter = granted_children(grant);
        filter.insert("status", "done");
        filter.insert("reused", doc! {"$ne": true});
        filter.insert("assetHash", doc! {"$in": &left});
        self.collect_strings(
            collections::UPLOADS,
            filter,
            &["assetHash"],
            &left,
            &mut owned,
        )
        .await?;
        // 4. 本空间完成的 model_import
        let left = remaining(&owned);
        if left.is_empty() {
            return Ok(owned);
        }
        let mut filter = granted_children(grant);
        filter.insert("kind", "model_import");
        filter.insert("status", "done");
        filter.insert("result.modelHash", doc! {"$in": &left});
        self.collect_strings(
            collections::JOBS,
            filter,
            &["result.modelHash"],
            &left,
            &mut owned,
        )
        .await?;
        // 5. 本空间的提交
        let left = remaining(&owned);
        if left.is_empty() {
            return Ok(owned);
        }
        let mut filter = granted_children(grant);
        filter.insert(
            "$or",
            vec![
                doc! {"scan.assetHash": {"$in": &left}},
                doc! {"scan.webModelHashes": {"$in": &left}},
                doc! {"opsRef": {"$in": &left}},
            ],
        );
        self.collect_strings(
            collections::COMMITS,
            filter,
            &["scan.assetHash", "scan.webModelHashes", "opsRef"],
            &left,
            &mut owned,
        )
        .await?;
        Ok(owned)
    }

    /// 查 `filter` 匹配的文档，把 `paths`（点分路径，值是字符串或字符串数组）里出现在 `wanted`
    /// 中的值加进 `into`。
    async fn collect_strings(
        &self,
        collection: &str,
        filter: Document,
        paths: &[&str],
        wanted: &[String],
        into: &mut BTreeSet<String>,
    ) -> Result<(), RepoError> {
        let mut projection = doc! {"_id": 0};
        for path in paths {
            projection.insert(*path, 1);
        }
        let mut cursor = self
            .collection(collection)
            .find(filter)
            .projection(projection)
            .limit(1000)
            .await?;
        while cursor.advance().await? {
            let document: Document = cursor.deserialize_current().map_err(corrupt)?;
            for path in paths {
                let mut values = Vec::new();
                strings_at(&document, path, &mut values);
                into.extend(values.into_iter().filter(|value| wanted.contains(value)));
            }
        }
        Ok(())
    }

    /// 草稿、事件类型里能不能按各自的用途引用这些资源。返回不能用的（每个哈希和用途一条）。
    pub async fn unusable_assets(
        &self,
        grant: &Grant,
        wanted: &[(String, AssetRole)],
        limits: &UploadLimits,
    ) -> Result<Vec<UnusableAsset>, RepoError> {
        Ok(self
            .check_asset_roles(grant, wanted, limits)
            .await?
            .unusable)
    }

    /// 按角色检查一批引用（docs/design/server-slim.md 2.5 第 4 条、4.6）。被引用的资源发布后可能
    /// 登记到 `assetRefs`、经公开接口可读，所以必须：已登记（GridFS 里有）；属于本空间（见
    /// [`Repo::owned_assets`]）；有当前版本的核对记录，并且满足这个角色的条件（上限按当前配置）。
    /// 别的空间抢先以别的用途登记同一份字节不影响本空间按核对结果引用。
    pub async fn check_asset_roles(
        &self,
        grant: &Grant,
        wanted: &[(String, AssetRole)],
        limits: &UploadLimits,
    ) -> Result<AssetRoleCheck, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let mut result = AssetRoleCheck::default();
        if wanted.is_empty() {
            return Ok(result);
        }
        let mut hashes: Vec<String> = wanted.iter().map(|(hash, _)| hash.clone()).collect();
        hashes.sort();
        hashes.dedup();
        let mut metadata: BTreeMap<String, Option<Document>> = BTreeMap::new();
        let mut registered_here = BTreeSet::new();
        for batch in hashes.chunks(1000) {
            let mut cursor = self
                .collection(collections::ASSET_FILES)
                .find(doc! {"filename": {"$in": batch}})
                .projection(doc! {"filename": 1, "metadata": 1, "length": 1})
                .await?;
            while cursor.advance().await? {
                let document: Document = cursor.deserialize_current().map_err(corrupt)?;
                let Ok(name) = document.get_str("filename") else {
                    continue;
                };
                let meta = document.get_document("metadata").ok().cloned();
                if meta.as_ref().and_then(|m| m.get_str("spaceId").ok()) == Some(grant.space_id()) {
                    registered_here.insert(name.to_owned());
                }
                if let Some(length) = number(&document, "length") {
                    result.lengths.insert(name.to_owned(), length);
                }
                metadata.insert(name.to_owned(), meta);
            }
        }
        let existing: Vec<String> = metadata.keys().cloned().collect();
        let owned = self.owned_assets(grant, &existing, registered_here).await?;
        for (hash, role) in wanted {
            let reason = match metadata.get(hash) {
                None => Some(AssetRejection::Missing),
                Some(_) if !owned.contains(hash) => Some(AssetRejection::Foreign),
                Some(meta) => match check_fits(meta.as_ref(), *role, limits) {
                    Ok(check) => {
                        result.checks.insert(hash.clone(), check);
                        None
                    }
                    Err(reason) => Some(reason),
                },
            };
            if let Some(reason) = reason {
                result.unusable.push(UnusableAsset {
                    hash: hash.clone(),
                    role: *role,
                    reason,
                });
            }
        }
        Ok(result)
    }

    /// `/api/v1` 下载资源（设计 8.2：原始扫描、大块操作文件和脚本只能由有权限的调用者经
    /// `/api/v1` 下载）：资源必须属于本空间（见 [`Repo::owned_assets`]），否则当作不存在。
    pub async fn space_owned_asset(
        &self,
        grant: &Grant,
        hash: &str,
    ) -> Result<Option<AssetMeta>, RepoError> {
        if !grant.can_read_internal() {
            return Err(RepoError::GrantMismatch);
        }
        let Some(meta) = self.asset_meta_unchecked(hash).await? else {
            return Ok(None);
        };
        let mut registered_here = BTreeSet::new();
        if meta.space_id.as_deref() == Some(grant.space_id()) {
            registered_here.insert(hash.to_owned());
        }
        let owned = self
            .owned_assets(grant, &[hash.to_owned()], registered_here)
            .await?;
        Ok(owned.contains(hash).then_some(meta))
    }

    /// 把事件类型 spawnEntity 显示方式的模型（`entityAsset`）登记到本空间的 `assetRefs`：网页按
    /// 公开资源接口 `/api/public/assets/{hash}.bin` 加载它。已登记就不变（`$setOnInsert`，
    /// `eventType` 记第一次登记它的事件类型）。调用方先用 [`Repo::unusable_assets`] 确认能引用。
    pub async fn register_event_type_asset(
        &self,
        grant: &Grant,
        hash: &str,
        event_type: &str,
        now: metaverse_core::Timestamp,
    ) -> Result<(), RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let owner = mongodb::bson::serialize_to_bson(grant.owner())
            .map_err(|error| RepoError::Corrupt(error.to_string()))?;
        let on_insert = doc! {
            "owner": owner,
            "createdAt": now.to_rfc3339(),
            "eventType": event_type,
        };
        self.collection(collections::ASSET_REFS)
            .update_one(
                doc! {"hash": hash, "spaceId": grant.space_id()},
                doc! {"$setOnInsert": on_insert},
            )
            .upsert(true)
            .await?;
        Ok(())
    }

    /// 把一段字节登记成资源（按内容哈希去重），与处理服务 `assets.put_asset` 的布局相同：
    /// 先写 256 KiB 的数据块，最后插入 `files` 文档；同一内容被并发登记时删掉本次的数据块。
    /// 用于草稿发布时把超过 1MB 的操作存成资源（不登记到 `assetRefs`，公开接口读不到）。
    pub async fn put_asset_bytes(
        &self,
        grant: &Grant,
        bytes: &[u8],
        content_type: &str,
        kind: &str,
    ) -> Result<String, RepoError> {
        Ok(self
            .put_asset_bytes_with(grant, bytes, content_type, kind, &[])
            .await?
            .hash)
    }

    /// 同 [`Repo::put_asset_bytes`]，`metadata` 里另加 `extra` 的字符串字段（例如处理服务
    /// `put_asset(..., extra={"format": ...})` 写的 `format`），并告诉调用方是不是复用了已有资源。
    ///
    /// 布局与处理服务完全一致：`assets.files {_id: ObjectId, length, chunkSize: 262144, uploadDate,
    /// filename: 内容哈希, metadata: {sha256, contentType, kind, spaceId, ...extra}}`，数据块
    /// `assets.chunks {files_id, n, data}`；已存在时只写 `metadata.touchedAt`（清理按它计算宽限），
    /// 并且要求匹配到（清理的栅栏，见 [`Repo::touch_asset`]），匹配不到就当作不存在、重新登记。
    pub async fn put_asset_bytes_with(
        &self,
        grant: &Grant,
        bytes: &[u8],
        content_type: &str,
        kind: &str,
        extra: &[(&str, &str)],
    ) -> Result<PutAsset, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let hash = metaverse_core::sha256_hex(bytes);
        let files = self.collection(collections::ASSET_FILES);
        let touched = doc! {"$set": {"metadata.touchedAt": mongodb::bson::DateTime::now()}};
        if files
            .update_one(doc! {"filename": &hash}, touched.clone())
            .await?
            .matched_count
            == 1
        {
            return Ok(PutAsset { hash, reused: true });
        }
        let files_id = mongodb::bson::oid::ObjectId::new();
        let chunk_collection = self.collection(collections::ASSET_CHUNKS);
        // 每次最多 32 块（8 MiB）：不先把整份数据复制成文档列表。
        let written: Result<(), RepoError> = async {
            let blocks: Vec<&[u8]> = bytes.chunks(ASSET_CHUNK_SIZE).collect();
            for (batch_no, batch) in blocks.chunks(32).enumerate() {
                let documents: Vec<Document> = batch
                    .iter()
                    .enumerate()
                    .map(|(i, block)| {
                        doc! {
                            "files_id": files_id,
                            "n": (batch_no * 32 + i) as i32,
                            "data": mongodb::bson::Binary {
                                subtype: mongodb::bson::spec::BinarySubtype::Generic,
                                bytes: block.to_vec(),
                            },
                        }
                    })
                    .collect();
                chunk_collection.insert_many(documents).await?;
            }
            Ok(())
        }
        .await;
        if let Err(error) = written {
            let _ = chunk_collection
                .delete_many(doc! {"files_id": files_id})
                .await;
            return Err(error);
        }
        let mut metadata = doc! {
            "sha256": &hash,
            "contentType": content_type,
            "kind": kind,
            "spaceId": grant.space_id(),
        };
        for (key, value) in extra {
            metadata.insert(*key, *value);
        }
        // 与处理服务（pymongo）写出的类型相同：放得进 32 位就是 Int32，否则 Int64。
        let length = i32::try_from(bytes.len())
            .map(Bson::Int32)
            .unwrap_or(Bson::Int64(bytes.len() as i64));
        // 同一内容已经登记过（并发登记）：先刷新它，刷新成功才删掉本次的数据块、复用它；刷新不到
        // 说明那一份在这期间被清理删掉了，本次的数据块还在，重新插入（与处理服务
        // `assets._insert_files_doc` 相同，不能返回一个已经不在的资源）。
        let files_doc = doc! {
            "_id": files_id,
            "length": length,
            "chunkSize": ASSET_CHUNK_SIZE as i32,
            "uploadDate": mongodb::bson::DateTime::now(),
            "filename": &hash,
            "metadata": metadata,
        };
        for _ in 0..REGISTER_ATTEMPTS {
            match files.insert_one(files_doc.clone()).await {
                Ok(_) => {
                    return Ok(PutAsset {
                        hash,
                        reused: false,
                    })
                }
                Err(error) if super::is_duplicate_key(&error) => {
                    if files
                        .update_one(doc! {"filename": &hash}, touched.clone())
                        .await?
                        .matched_count
                        == 1
                    {
                        chunk_collection
                            .delete_many(doc! {"files_id": files_id})
                            .await?;
                        return Ok(PutAsset { hash, reused: true });
                    }
                }
                Err(error) => {
                    let _ = chunk_collection
                        .delete_many(doc! {"files_id": files_id})
                        .await;
                    return Err(error.into());
                }
            }
        }
        let _ = chunk_collection
            .delete_many(doc! {"files_id": files_id})
            .await;
        tracing::warn!(asset = %hash, "登记资源时反复遇到正在被清理的同名资源");
        Err(RepoError::Unavailable)
    }

    /// 读整份资源（不超过 `max_bytes`），并核对内容哈希。
    pub(crate) async fn read_asset_bytes(
        &self,
        meta: &AssetMeta,
        max_bytes: u64,
    ) -> Result<Vec<u8>, RepoError> {
        if meta.length > max_bytes {
            return Err(RepoError::Corrupt(format!(
                "资源超过 {max_bytes} 字节，不能整份读入"
            )));
        }
        let mut stream = self.asset_stream(meta, 0, meta.length).await?;
        let mut bytes = Vec::with_capacity(meta.length as usize);
        while let Some(part) = stream.next().await {
            bytes.extend_from_slice(&part.map_err(corrupt)?);
        }
        if metaverse_core::sha256_hex(&bytes) != meta.hash {
            return Err(RepoError::Corrupt(format!(
                "资源 {} 的内容与哈希不符",
                meta.hash
            )));
        }
        Ok(bytes)
    }

    /// 资源的 `[start, end)` 字节，按数据块流式读出。
    pub async fn asset_stream(
        &self,
        meta: &AssetMeta,
        start: u64,
        end: u64,
    ) -> Result<AssetStream, RepoError> {
        let end = end.min(meta.length);
        if start >= end {
            return Ok(Box::pin(futures_util::stream::empty()));
        }
        let size = meta.chunk_size;
        let first = start / size;
        let last = (end - 1) / size;
        let cursor = self
            .collection(collections::ASSET_CHUNKS)
            .find(doc! {
                "files_id": meta.files_id.clone(),
                "n": {"$gte": first as i64, "$lte": last as i64},
            })
            .sort(doc! {"n": 1})
            .projection(doc! {"_id": 0, "n": 1, "data": 1})
            .batch_size(8)
            .await?;
        let mut expected = first;
        let stream = cursor.map(move |item| {
            let document = item.map_err(std::io::Error::other)?;
            let n =
                number(&document, "n").ok_or_else(|| std::io::Error::other("数据块序号不对"))?;
            if n != expected {
                return Err(std::io::Error::other(format!(
                    "数据块序号不连续：期望 {expected}，实际 {n}"
                )));
            }
            expected += 1;
            let data = document
                .get_binary_generic("data")
                .map_err(std::io::Error::other)?;
            let block_start = n * size;
            let from = start.saturating_sub(block_start) as usize;
            let to = ((end - block_start).min(data.len() as u64)) as usize;
            if from > to {
                return Err(std::io::Error::other("数据块长度与声明不符"));
            }
            Ok(Bytes::copy_from_slice(&data[from..to]))
        });
        Ok(Box::pin(stream))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(pairs: &[(&str, &str)]) -> Document {
        let mut document = Document::new();
        for (key, value) in pairs {
            document.insert(*key, *value);
        }
        document
    }

    /// 角色只看核对记录，不看 `kind`、`sourceHash`（docs/design/server-slim.md 4.6）。
    #[test]
    fn roles_follow_the_check_not_the_kind() {
        let limits = UploadLimits::default();
        let glb = mongodb::bson::doc! {"kind": "texture", "check": {
        "v": 1, "format": "glb", "triangles": 1200, "nodes": 1, "meshes": 1, "materials": 1,
        "images": [], "maxTextureSide": 0, "texturePixels": 0, "extensions": [],
        "bounds": {"min": [-0.5, 0.0, -0.5], "max": [0.5, 1.0, 0.5]}}};
        let png = mongodb::bson::doc! {"kind": "model", "sourceHash": "a",
        "check": {"v": 1, "format": "png", "width": 64, "height": 64}};
        // 第一次登记的人写的 kind 不算数。
        assert!(check_fits(Some(&glb), AssetRole::Model, &limits).is_ok());
        assert!(check_fits(Some(&glb), AssetRole::WebModel, &limits).is_ok());
        assert!(matches!(
            check_fits(Some(&glb), AssetRole::Texture, &limits),
            Err(AssetRejection::Unfit(_))
        ));
        assert!(check_fits(Some(&png), AssetRole::Texture, &limits).is_ok());
        assert!(matches!(
            check_fits(Some(&png), AssetRole::Model, &limits),
            Err(AssetRejection::Unfit(_))
        ));
        // 没有核对记录、旧版本的记录、补核对时检查不过：都不能引用。
        let old = metadata(&[("kind", "model"), ("sourceHash", "a")]);
        assert_eq!(
            check_fits(Some(&old), AssetRole::Model, &limits).unwrap_err(),
            AssetRejection::Unchecked
        );
        assert_eq!(
            check_fits(None, AssetRole::Texture, &limits).unwrap_err(),
            AssetRejection::Unchecked
        );
        let mut failed = png.clone();
        failed.insert("checkError", mongodb::bson::doc! {"v": 1, "reason": "x"});
        assert_eq!(
            check_fits(Some(&failed), AssetRole::Texture, &limits).unwrap_err(),
            AssetRejection::Unchecked
        );
        let mut older = png;
        older.insert(
            "check",
            mongodb::bson::doc! {"v": 0, "format": "png", "width": 64, "height": 64},
        );
        assert_eq!(
            check_fits(Some(&older), AssetRole::Texture, &limits).unwrap_err(),
            AssetRejection::Unchecked
        );
    }

    #[test]
    fn strings_are_read_from_dotted_paths_and_arrays() {
        let document = mongodb::bson::doc! {
            "scan": {"assetHash": "s", "webModelHashes": ["w1", 3, "w2"]},
            "opsRef": "o",
        };
        let mut found = Vec::new();
        for path in [
            "scan.assetHash",
            "scan.webModelHashes",
            "opsRef",
            "missing.path",
        ] {
            strings_at(&document, path, &mut found);
        }
        assert_eq!(found, ["s", "w1", "w2", "o"]);
    }

    #[test]
    fn rejections_explain_what_to_do() {
        let unusable = UnusableAsset {
            hash: "h".into(),
            role: AssetRole::Model,
            reason: AssetRejection::Unchecked,
        };
        assert!(unusable.describe().contains("重新上传"));
        let unusable = UnusableAsset {
            hash: "h".into(),
            role: AssetRole::Texture,
            reason: AssetRejection::Unfit("glb 不能当贴图".into()),
        };
        assert!(unusable.describe().contains("不能当贴图引用：glb"));
    }
}
