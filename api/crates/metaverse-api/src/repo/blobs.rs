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

use super::commits::{corrupt, granted_children, stored_chunk, StoredChunk};
use super::{collections, Repo, RepoError};
use crate::auth::{BlobGrant, Grant};

/// GridFS 数据块大小（与处理服务 `ASSET_CHUNK_SIZE` 相同）。
pub const ASSET_CHUNK_SIZE: usize = 256 * 1024;

/// 资源的元数据。
#[derive(Debug, Clone)]
pub struct AssetMeta {
    pub hash: String,
    files_id: Bson,
    pub length: u64,
    pub chunk_size: u64,
    /// 登记时写入的 `metadata.contentType`（只作参考，响应的 Content-Type 由服务端按白名单固定）。
    pub content_type: Option<String>,
    pub kind: Option<String>,
    /// 第一个登记它的空间（`metadata.spaceId`）。资源按内容全局去重，别的空间上传或导入了
    /// 同一份内容时这里不变，所以"属于哪些空间"要看 [`Repo::owned_assets`]。
    pub space_id: Option<String>,
}

/// 资源在草稿、事件类型里被引用的用途（设计 4.4、6.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AssetRole {
    /// 物件的 `assetHash`、spawnEntity 显示方式的 `entityAsset`：只接受处理服务 `model_import`
    /// 校验并重新导出的受限 glb（`metadata.kind = model`、带 `metadata.sourceHash`、
    /// `metadata.contentType = model/gltf-binary`）。原始的 model 用途上传（`metadata.kind = model`、
    /// 带 `uploadId`、没有 `sourceHash`）不行。
    Model,
    /// 贴图（物件的 `textures`、形状材质的 `texture`、新增方块的贴图）：`metadata.kind = texture`
    /// （texture 用途上传并经处理服务校验的图片，或处理服务生成的贴图）。
    Texture,
}

/// [`Repo::put_asset_bytes_with`] 的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PutAsset {
    /// 内容哈希（也是 GridFS 文件名）。
    pub hash: String,
    /// 已有同一内容的资源，复用了它（没有写新数据块）。
    pub reused: bool,
}

/// 资源不能按某个用途引用的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetRejection {
    /// 没有这个资源。
    Missing,
    /// 不属于本空间：本空间没有登记、上传、导入或在提交里引用过它。
    Foreign,
    /// 物件模型引用了原始上传：要先经 `model_import` 校验并重新导出，再引用任务结果的 `modelHash`。
    UnprocessedModel,
    /// 种类与用途不符（原始扫描、操作文件、脚本、网页用模型，或把模型当贴图、贴图当模型）。
    WrongKind,
}

/// 一个不能引用的资源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnusableAsset {
    pub hash: String,
    pub role: AssetRole,
    pub reason: AssetRejection,
}

impl UnusableAsset {
    /// 给调用方看的说明。
    pub fn describe(&self) -> String {
        let reason = match (self.reason, self.role) {
            (AssetRejection::Missing, _) => "不存在",
            (AssetRejection::Foreign, _) => "不属于本空间",
            (AssetRejection::UnprocessedModel, _) => {
                "是原始模型上传；物件只能引用处理后的模型，请先调用 import_model，再引用任务结果里的 modelHash"
            }
            (AssetRejection::WrongKind, AssetRole::Model) => {
                "不是处理后的物件模型（原始扫描、网页用模型、贴图、操作文件、脚本都不行）"
            }
            (AssetRejection::WrongKind, AssetRole::Texture) => {
                "不是贴图（只能引用 texture 用途上传的图片或处理服务生成的贴图）"
            }
        };
        format!("{}：{reason}", self.hash)
    }
}

/// 资源的种类能不能按这个用途引用（只看 `metadata`，归属另外判断）。
fn kind_fits(metadata: Option<&Document>, role: AssetRole) -> Result<(), AssetRejection> {
    let text = |key: &str| metadata.and_then(|m| m.get_str(key).ok());
    match (role, text("kind")) {
        (AssetRole::Model, Some("model")) => {
            let processed = text("sourceHash").is_some_and(|hash| !hash.is_empty())
                && text("contentType") == Some("model/gltf-binary");
            if processed {
                Ok(())
            } else {
                Err(AssetRejection::UnprocessedModel)
            }
        }
        (AssetRole::Texture, Some("texture")) => Ok(()),
        _ => Err(AssetRejection::WrongKind),
    }
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
        }))
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

    /// 本空间登记过的资源（预览读基础版本的资源）。
    pub async fn space_asset(
        &self,
        grant: &Grant,
        hash: &str,
    ) -> Result<Option<AssetMeta>, RepoError> {
        let mut filter = granted_children(grant);
        filter.insert("hash", hash);
        let registered = self
            .collection(collections::ASSET_REFS)
            .find_one(filter)
            .projection(doc! {"_id": 1})
            .await?
            .is_some();
        if !registered {
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
    ///
    /// 被引用的资源发布后登记到 `assetRefs`、经公开接口可读，所以必须：已登记（GridFS 里有）；
    /// 属于本空间（见 [`Repo::owned_assets`]）；种类符合用途（见 [`AssetRole`]）——物件模型只能是
    /// `model_import` 处理后的 glb，贴图只能是贴图；原始扫描、操作文件、脚本、网页用模型一律不行。
    pub async fn unusable_assets(
        &self,
        grant: &Grant,
        wanted: &[(String, AssetRole)],
    ) -> Result<Vec<UnusableAsset>, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        if wanted.is_empty() {
            return Ok(Vec::new());
        }
        let mut hashes: Vec<String> = wanted.iter().map(|(hash, _)| hash.clone()).collect();
        hashes.sort();
        hashes.dedup();
        let mut cursor = self
            .collection(collections::ASSET_FILES)
            .find(doc! {"filename": {"$in": &hashes}})
            .projection(doc! {"filename": 1, "metadata": 1})
            .await?;
        let mut metadata: BTreeMap<String, Option<Document>> = BTreeMap::new();
        let mut registered_here = BTreeSet::new();
        while cursor.advance().await? {
            let document: Document = cursor.deserialize_current().map_err(corrupt)?;
            let Ok(name) = document.get_str("filename") else {
                continue;
            };
            let meta = document.get_document("metadata").ok().cloned();
            if meta.as_ref().and_then(|m| m.get_str("spaceId").ok()) == Some(grant.space_id()) {
                registered_here.insert(name.to_owned());
            }
            metadata.insert(name.to_owned(), meta);
        }
        let existing: Vec<String> = metadata.keys().cloned().collect();
        let owned = self.owned_assets(grant, &existing, registered_here).await?;
        let mut unusable = Vec::new();
        for (hash, role) in wanted {
            let reason = match metadata.get(hash) {
                None => Some(AssetRejection::Missing),
                Some(_) if !owned.contains(hash) => Some(AssetRejection::Foreign),
                Some(meta) => kind_fits(meta.as_ref(), *role).err(),
            };
            if let Some(reason) = reason {
                unusable.push(UnusableAsset {
                    hash: hash.clone(),
                    role: *role,
                    reason,
                });
            }
        }
        Ok(unusable)
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
    /// `assets.chunks {files_id, n, data}`；已存在时只写 `metadata.touchedAt`（清理按它计算宽限）。
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
        let inserted = files
            .insert_one(doc! {
                "_id": files_id,
                "length": length,
                "chunkSize": ASSET_CHUNK_SIZE as i32,
                "uploadDate": mongodb::bson::DateTime::now(),
                "filename": &hash,
                "metadata": metadata,
            })
            .await;
        match inserted {
            Ok(_) => Ok(PutAsset {
                hash,
                reused: false,
            }),
            Err(error) if super::is_duplicate_key(&error) => {
                chunk_collection
                    .delete_many(doc! {"files_id": files_id})
                    .await?;
                files.update_one(doc! {"filename": &hash}, touched).await?;
                Ok(PutAsset { hash, reused: true })
            }
            Err(error) => {
                let _ = chunk_collection
                    .delete_many(doc! {"files_id": files_id})
                    .await;
                Err(error.into())
            }
        }
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

    #[test]
    fn models_must_be_processed_and_textures_must_be_textures() {
        let processed = metadata(&[
            ("kind", "model"),
            ("sourceHash", "a"),
            ("contentType", "model/gltf-binary"),
        ]);
        let raw = metadata(&[
            ("kind", "model"),
            ("uploadId", "up_1"),
            ("contentType", "model/gltf-binary"),
        ]);
        let texture = metadata(&[("kind", "texture"), ("contentType", "image/png")]);
        assert_eq!(kind_fits(Some(&processed), AssetRole::Model), Ok(()));
        assert_eq!(
            kind_fits(Some(&raw), AssetRole::Model),
            Err(AssetRejection::UnprocessedModel)
        );
        // 带 sourceHash 但不是 glb：也不是 model_import 的输出。
        let odd = metadata(&[
            ("kind", "model"),
            ("sourceHash", "a"),
            ("contentType", "model/obj"),
        ]);
        assert_eq!(
            kind_fits(Some(&odd), AssetRole::Model),
            Err(AssetRejection::UnprocessedModel)
        );
        assert_eq!(kind_fits(Some(&texture), AssetRole::Texture), Ok(()));
        // 用途不符：贴图当模型、模型当贴图、原始扫描、网页用模型、操作文件、脚本、没有 metadata。
        assert_eq!(
            kind_fits(Some(&texture), AssetRole::Model),
            Err(AssetRejection::WrongKind)
        );
        assert_eq!(
            kind_fits(Some(&processed), AssetRole::Texture),
            Err(AssetRejection::WrongKind)
        );
        for kind in ["scan", "web_model", "ops", "script"] {
            let other = metadata(&[("kind", kind)]);
            for role in [AssetRole::Model, AssetRole::Texture] {
                assert_eq!(
                    kind_fits(Some(&other), role),
                    Err(AssetRejection::WrongKind),
                    "{kind} {role:?}"
                );
            }
        }
        assert_eq!(
            kind_fits(None, AssetRole::Texture),
            Err(AssetRejection::WrongKind)
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
            reason: AssetRejection::UnprocessedModel,
        };
        assert!(unusable.describe().contains("import_model"));
    }
}
