//! 内容寻址数据的读取：已发布的区块、GridFS 桶 `assets` 里的资源（设计 8.2、13.2）。
//!
//! - 公开区块只返回带 `publishedAt` 的；
//! - 公开资源只返回登记在 `assetRefs` 里的（网页用模型、方块表贴图、处理后的物件模型）；
//! - 资源是标准 GridFS 文件：`assets.files {_id, length, chunkSize, filename = 内容哈希, metadata}`
//!   + `assets.chunks {files_id, n, data}`（与处理服务 `assets.py` 相同）。分段读取只取用到的数据块。

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
}

/// 资源字节流。
pub type AssetStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

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

    /// 草稿里的物件模型、贴图能不能引用这些资源。返回不能用的哈希。
    ///
    /// 发布时这些资源会登记到 `assetRefs`、经公开接口可读，所以必须：已登记（GridFS 里有）；
    /// 属于本空间（登记时 `metadata.spaceId` 是本空间，或本空间已经引用过）；不是原始扫描、
    /// 操作文件或脚本（`metadata.kind` 为 `scan`、`ops`、`script` 的一律不行）。
    pub async fn unusable_assets(
        &self,
        grant: &Grant,
        hashes: &[String],
    ) -> Result<Vec<String>, RepoError> {
        const PRIVATE_KINDS: [&str; 3] = ["scan", "ops", "script"];
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        if hashes.is_empty() {
            return Ok(Vec::new());
        }
        let mut cursor = self
            .collection(collections::ASSET_FILES)
            .find(doc! {"filename": {"$in": hashes}})
            .projection(doc! {"filename": 1, "metadata": 1})
            .await?;
        let mut usable_here = std::collections::BTreeSet::new();
        let mut public_kind = std::collections::BTreeSet::new();
        while cursor.advance().await? {
            let document: Document = cursor.deserialize_current().map_err(corrupt)?;
            let Ok(name) = document.get_str("filename") else {
                continue;
            };
            let metadata = document.get_document("metadata").ok();
            let kind = metadata.and_then(|m| m.get_str("kind").ok());
            if kind.is_some_and(|kind| PRIVATE_KINDS.contains(&kind)) {
                continue;
            }
            public_kind.insert(name.to_owned());
            if metadata.and_then(|m| m.get_str("spaceId").ok()) == Some(grant.space_id()) {
                usable_here.insert(name.to_owned());
            }
        }
        let mut cursor = self
            .collection(collections::ASSET_REFS)
            .find(doc! {"hash": {"$in": hashes}, "spaceId": grant.space_id()})
            .projection(doc! {"hash": 1})
            .await?;
        while cursor.advance().await? {
            let document: Document = cursor.deserialize_current().map_err(corrupt)?;
            if let Ok(hash) = document.get_str("hash") {
                usable_here.insert(hash.to_owned());
            }
        }
        Ok(hashes
            .iter()
            .filter(|hash| !(public_kind.contains(*hash) && usable_here.contains(*hash)))
            .cloned()
            .collect())
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
            return Ok(hash);
        }
        let files_id = mongodb::bson::oid::ObjectId::new();
        let chunks: Vec<Document> = bytes
            .chunks(ASSET_CHUNK_SIZE)
            .enumerate()
            .map(|(n, block)| {
                doc! {
                    "files_id": files_id,
                    "n": n as i32,
                    "data": mongodb::bson::Binary {
                        subtype: mongodb::bson::spec::BinarySubtype::Generic,
                        bytes: block.to_vec(),
                    },
                }
            })
            .collect();
        let chunk_collection = self.collection(collections::ASSET_CHUNKS);
        for batch in chunks.chunks(32) {
            chunk_collection.insert_many(batch.to_vec()).await?;
        }
        let inserted = files
            .insert_one(doc! {
                "_id": files_id,
                "length": bytes.len() as i64,
                "chunkSize": ASSET_CHUNK_SIZE as i32,
                "uploadDate": mongodb::bson::DateTime::now(),
                "filename": &hash,
                "metadata": {
                    "sha256": &hash,
                    "contentType": content_type,
                    "kind": kind,
                    "spaceId": grant.space_id(),
                },
            })
            .await;
        match inserted {
            Ok(_) => Ok(hash),
            Err(error) if super::is_duplicate_key(&error) => {
                chunk_collection
                    .delete_many(doc! {"files_id": files_id})
                    .await?;
                files.update_one(doc! {"filename": &hash}, touched).await?;
                Ok(hash)
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
