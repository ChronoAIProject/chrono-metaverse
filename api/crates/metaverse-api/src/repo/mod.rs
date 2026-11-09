//! 数据访问层：只有这里访问 MongoDB（设计 9.4、建设计划第 4 节）。
//!
//! - 集合名和索引按设计 13.2；启动时幂等地建索引，建完才让 `/api/healthz` 返回 200；
//! - 所有读写都要求传入授权凭据（[`crate::auth::Grant`]、[`crate::auth::CreateGrant`]），
//!   查询条件自动带上空间编号和主人，写入条件带上主人；
//! - 唯一不带授权的读取是"只读主人、可见性和分享令牌哈希"（[`Repo::space_policy`]），
//!   要求传入只有授权层能构造的 [`crate::auth::AuthorizerKey`]；
//! - 令牌防重放（[`Repo::claim_jti`]）属于身份层，不涉及任何空间数据。
//!
//! 单元测试 `only_repo_touches_the_database` 检查 `repo/` 以外的代码没有直接使用数据库。

use std::time::{Duration, SystemTime};

use mongodb::{
    bson::{doc, DateTime, Document},
    error::{ErrorKind, WriteFailure},
    options::{ClientOptions, IndexOptions},
    Client, Collection, Database, IndexModel,
};

mod spaces;

pub use spaces::SpacePolicy;

// 上传、任务、事件、组合（各自的文件里有说明）。
mod events;
mod jobs;
mod transactions;
mod universes;
mod uploads;

pub use events::{Cursor, EventInsert, Lower};
pub use jobs::{JobInsert, MAX_JOB_LIST};
pub use universes::{UniverseFieldsUpdate, UniversePolicy, UniverseWrite};
pub use uploads::{AssetAvailability, CompleteWrite, PartWrite, PendingUploads};
// 时间线、草稿、内容寻址数据、管理写入（时间线与公开读分工）。
mod blobs;
mod commits;
mod drafts;
mod space_admin;

pub use blobs::{AssetMeta, AssetRejection, AssetRole, AssetStream, UnusableAsset};
pub use commits::{
    palette_hash, state_blob_hash, BlobKind, CommitError, CommitOutcome, CommitPlan, Layout,
    StoredChunk,
};
pub use drafts::{
    DraftDoc, DraftStatus, NewPreview, OpsAsset, OpsRef, OpsUpload, PreviewRecord, ProvisionalBlock,
};
pub use space_admin::{SpaceSettings, MAX_SHARE_TOKEN_RECORDS};

/// 集合名（设计 13.2）。
pub mod collections {
    pub const SPACES: &str = "spaces";
    pub const COMMITS: &str = "commits";
    pub const CHUNKS: &str = "chunks";
    pub const DRAFT_CHUNKS: &str = "draftChunks";
    pub const RECORDS: &str = "records";
    pub const STATE_BLOBS: &str = "stateBlobs";
    pub const PALETTES: &str = "palettes";
    pub const ENTITIES: &str = "entities";
    pub const ANCHORS: &str = "anchors";
    pub const ASSET_REFS: &str = "assetRefs";
    pub const EVENTS: &str = "events";
    pub const STATE_SNAPSHOTS: &str = "stateSnapshots";
    pub const EVENT_TYPES: &str = "eventTypes";
    pub const DRAFTS: &str = "drafts";
    pub const PREVIEWS: &str = "previews";
    pub const UPLOADS: &str = "uploads";
    pub const JOBS: &str = "jobs";
    pub const UNIVERSES: &str = "universes";
    pub const UNIVERSE_REVISIONS: &str = "universeRevisions";
    pub const REPLAY: &str = "replay";
    pub const MIGRATIONS: &str = "migrations";
    /// GridFS 桶 `assets` 的文件集合。
    pub const ASSET_FILES: &str = "assets.files";
    /// GridFS 桶 `assets` 的数据块集合。
    pub const ASSET_CHUNKS: &str = "assets.chunks";
}

/// 防重放记录的保留时间：令牌最长 60 秒有效期 + 30 秒时钟容差（设计 9.1）。
pub const REPLAY_RETENTION: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RepoError {
    #[error("数据库暂时不可用")]
    Unavailable,
    #[error("编号已存在")]
    Duplicate,
    #[error("授权凭据与写入内容不一致")]
    GrantMismatch,
    #[error("数据库里的记录损坏：{0}")]
    Corrupt(String),
}

impl From<mongodb::error::Error> for RepoError {
    fn from(error: mongodb::error::Error) -> Self {
        if is_duplicate_key(&error) {
            RepoError::Duplicate
        } else {
            tracing::warn!(error = %error, "MongoDB 操作失败");
            RepoError::Unavailable
        }
    }
}

fn is_duplicate_key(error: &mongodb::error::Error) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(write)) => write.code == 11000,
        ErrorKind::InsertMany(many) => many
            .write_errors
            .iter()
            .flatten()
            .any(|write| write.code == 11000),
        ErrorKind::Command(command) => command.code == 11000,
        _ => false,
    }
}

/// 身份令牌编号的登记结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JtiClaim {
    /// 第一次见到，已登记。
    Fresh,
    /// 已经用过：重放。
    Replayed,
}

/// MongoDB 连接和全部集合。
#[derive(Clone)]
pub struct Repo {
    /// 数据库句柄；事务需要的客户端可以经 `database.client()` 取得。
    database: Database,
}

impl Repo {
    /// 解析连接串并建立客户端（驱动按需连接）。服务器选择超时设为 5 秒，
    /// 数据库不可用时请求很快返回 503，而不是一直挂着。
    pub async fn connect(uri: &str, database: &str) -> Result<Self, String> {
        let mut options = ClientOptions::parse(uri)
            .await
            .map_err(|error| format!("MongoDB 连接串不可用：{error}"))?;
        options.app_name = Some("chrono-metaverse-api".into());
        options.server_selection_timeout = Some(Duration::from_secs(5));
        let client =
            Client::with_options(options).map_err(|error| format!("MongoDB 客户端：{error}"))?;
        Ok(Self {
            database: client.database(database),
        })
    }

    pub fn database_name(&self) -> &str {
        self.database.name()
    }

    fn collection(&self, name: &str) -> Collection<Document> {
        self.database.collection(name)
    }

    pub async fn ping(&self) -> Result<(), RepoError> {
        self.database.run_command(doc! {"ping": 1}).await?;
        Ok(())
    }

    /// 删除整个数据库。只给测试用。
    pub async fn drop_database(&self) -> Result<(), RepoError> {
        self.database.drop().await?;
        Ok(())
    }

    /// 幂等地建立全部索引（设计 13.2）。多副本同时执行也安全。
    pub async fn ensure_indexes(&self) -> Result<(), RepoError> {
        use collections::*;
        let named = |name: &str| IndexOptions::builder().name(name.to_owned()).build();
        let unique = |name: &str| {
            IndexOptions::builder()
                .name(name.to_owned())
                .unique(true)
                .build()
        };
        let index = |keys: Document, options: IndexOptions| {
            IndexModel::builder().keys(keys).options(options).build()
        };
        let plan: Vec<(&str, Vec<IndexModel>)> = vec![
            (
                SPACES,
                vec![index(
                    doc! {"owner.kind": 1, "owner.id": 1, "updatedAt": 1},
                    named("owner_updated"),
                )],
            ),
            (
                COMMITS,
                vec![
                    index(doc! {"spaceId": 1, "seq": 1}, unique("space_seq")),
                    index(doc! {"spaceId": 1, "at": 1}, named("space_at")),
                    index(
                        doc! {"jobId": 1},
                        IndexOptions::builder()
                            .name("job_unique".to_owned())
                            .unique(true)
                            .partial_filter_expression(doc! {"jobId": {"$type": "string"}})
                            .build(),
                    ),
                ],
            ),
            (
                CHUNKS,
                vec![index(doc! {"publishedAt": 1}, named("published_at"))],
            ),
            (
                DRAFT_CHUNKS,
                vec![
                    index(doc! {"draftId": 1}, named("draft")),
                    index(doc! {"expiresAt": 1}, named("expires_at")),
                ],
            ),
            (
                RECORDS,
                vec![index(doc! {"spaceId": 1, "kind": 1}, named("space_kind"))],
            ),
            (
                ENTITIES,
                vec![index(doc! {"spaceId": 1, "id": 1}, unique("space_id"))],
            ),
            (
                ANCHORS,
                vec![index(doc! {"spaceId": 1, "id": 1}, unique("space_id"))],
            ),
            (
                ASSET_REFS,
                vec![index(doc! {"hash": 1, "spaceId": 1}, unique("hash_space"))],
            ),
            (
                EVENTS,
                vec![
                    index(doc! {"spaceId": 1, "at": 1}, named("space_at")),
                    index(
                        doc! {"spaceId": 1, "recordedAt": 1},
                        named("space_recorded"),
                    ),
                    index(
                        doc! {"spaceId": 1, "corrects": 1},
                        IndexOptions::builder()
                            .name("space_corrects".to_owned())
                            .sparse(true)
                            .build(),
                    ),
                    index(
                        doc! {"spaceId": 1, "source": 1, "sourceEventId": 1},
                        unique("space_source_event"),
                    ),
                ],
            ),
            (
                STATE_SNAPSHOTS,
                vec![index(doc! {"spaceId": 1, "at": 1}, named("space_at"))],
            ),
            (
                EVENT_TYPES,
                vec![index(
                    doc! {"spaceId": 1, "type": 1, "version": 1},
                    unique("space_type_version"),
                )],
            ),
            (
                DRAFTS,
                vec![
                    index(doc! {"spaceId": 1}, named("space")),
                    index(doc! {"expiresAt": 1}, named("expires_at")),
                ],
            ),
            (
                PREVIEWS,
                vec![
                    index(doc! {"spaceId": 1}, named("space")),
                    index(doc! {"expiresAt": 1}, named("expires_at")),
                ],
            ),
            (
                UPLOADS,
                vec![
                    index(doc! {"spaceId": 1}, named("space")),
                    index(doc! {"createdAt": 1}, named("created_at")),
                ],
            ),
            (
                JOBS,
                vec![
                    index(doc! {"status": 1, "createdAt": 1}, named("status_created")),
                    index(doc! {"status": 1, "leaseUntil": 1}, named("status_lease")),
                    index(doc! {"spaceId": 1, "status": 1}, named("space_status")),
                ],
            ),
            (
                UNIVERSES,
                vec![index(doc! {"owner.kind": 1, "owner.id": 1}, named("owner"))],
            ),
            (
                UNIVERSE_REVISIONS,
                vec![
                    index(doc! {"universeId": 1, "seq": 1}, unique("universe_seq")),
                    index(doc! {"universeId": 1, "at": 1}, named("universe_at")),
                ],
            ),
            (
                REPLAY,
                vec![index(
                    doc! {"expiresAt": 1},
                    IndexOptions::builder()
                        .name("expires_at_ttl".to_owned())
                        .expire_after(Duration::ZERO)
                        .build(),
                )],
            ),
            (
                ASSET_FILES,
                vec![index(doc! {"filename": 1}, unique("filename"))],
            ),
            (
                ASSET_CHUNKS,
                vec![index(doc! {"files_id": 1, "n": 1}, unique("files_id_n"))],
            ),
        ];
        for (collection, indexes) in plan {
            self.collection(collection).create_indexes(indexes).await?;
        }
        Ok(())
    }

    /// 登记身份令牌编号：以 jti 为主键直接插入，重复就是重放（不能先查后写）。
    pub async fn claim_jti(
        &self,
        jti: &str,
        token_expires_at: SystemTime,
    ) -> Result<JtiClaim, RepoError> {
        let keep_until = token_expires_at
            .max(SystemTime::now())
            .checked_add(REPLAY_RETENTION)
            .ok_or(RepoError::Unavailable)?;
        let result = self
            .collection(collections::REPLAY)
            .insert_one(doc! {
                "_id": jti,
                "expiresAt": DateTime::from_system_time(keep_until),
            })
            .await;
        match result {
            Ok(_) => Ok(JtiClaim::Fresh),
            Err(error) if is_duplicate_key(&error) => Ok(JtiClaim::Replayed),
            Err(error) => Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// 设计 9.4："数据访问层以外的代码不能直接访问数据库集合。"
    #[test]
    fn only_repo_touches_the_database() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        visit(&src, &mut |path, text| {
            let relative = path
                .strip_prefix(&src)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            if relative.starts_with("repo/") {
                return;
            }
            for needle in ["mongodb::", ".collection(", "Collection<", "run_command"] {
                if text.contains(needle) {
                    offenders.push(format!("{relative}: {needle}"));
                }
            }
        });
        assert!(
            offenders.is_empty(),
            "repo/ 以外直接访问了数据库：{offenders:?}"
        );
    }

    fn visit(dir: &Path, check: &mut dyn FnMut(&Path, &str)) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(&path, check);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                check(&path, &std::fs::read_to_string(&path).unwrap());
            }
        }
    }
}
