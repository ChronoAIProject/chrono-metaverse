//! 管理接口的空间写入（设计 8.4）：名称和可见性、分享令牌轮换、删除空间。
//! 区域和地块的修改写成一次提交，走 [`Repo::write_commit`]。

use metaverse_core::model::{ShareTokenRecord, SpaceStyleSpec, Visibility};
use metaverse_core::Timestamp;
use mongodb::{
    bson::{self, doc, Document},
    options::ReturnDocument,
};
use serde::Deserialize;

use super::commits::{granted_space, to_bson};
use super::{collections, Repo, RepoError};
use crate::auth::Grant;

/// 一个空间最多保留多少条分享令牌记录（含已吊销的，留作审计）。
pub const MAX_SHARE_TOKEN_RECORDS: usize = 20;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceShare {
    pub visibility: Visibility,
    pub workspace_share: Option<String>,
}

/// 名称、说明、可见性的修改；`None` 表示不改。
#[derive(Debug, Clone, Default)]
pub struct SpaceSettings {
    pub name: Option<String>,
    pub description: Option<String>,
    pub visibility: Option<Visibility>,
    pub styles: Option<Vec<SpaceStyleSpec>>,
    pub default_style_id: Option<Option<String>>,
}

impl Repo {
    /// 修改名称、说明、可见性。返回空间是否存在。
    pub async fn update_space_settings(
        &self,
        grant: &Grant,
        settings: &SpaceSettings,
        now: Timestamp,
    ) -> Result<bool, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let mut set = doc! {"updatedAt": now.to_rfc3339()};
        if let Some(name) = &settings.name {
            set.insert("name", name);
        }
        if let Some(description) = &settings.description {
            set.insert("description", description);
        }
        if let Some(visibility) = settings.visibility {
            set.insert("visibility", to_bson(&visibility)?);
        }
        if let Some(styles) = &settings.styles {
            set.insert("styles", to_bson(styles)?);
        }
        if let Some(default_style_id) = &settings.default_style_id {
            set.insert("defaultStyleId", to_bson(default_style_id)?);
        }
        let result = self
            .collection(collections::SPACES)
            .update_one(granted_space(grant), doc! {"$set": set})
            .await?;
        Ok(result.matched_count == 1)
    }

    /// 轮换分享令牌：吊销全部现有令牌，加一条新的；最多保留最近的若干条记录。
    pub async fn rotate_share_tokens(
        &self,
        grant: &Grant,
        record: &ShareTokenRecord,
        now: Timestamp,
    ) -> Result<bool, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let revoked = doc! {"$map": {
            "input": {"$ifNull": ["$shareTokens", []]},
            "as": "record",
            "in": {"$mergeObjects": ["$$record", {
                "revokedAt": {"$ifNull": ["$$record.revokedAt", now.to_rfc3339()]},
            }]},
        }};
        let result = self
            .collection(collections::SPACES)
            .update_one(
                granted_space(grant),
                vec![
                    doc! {"$set": {
                        "shareTokens": append_share_token(revoked, record)?,
                        "updatedAt": now.to_rfc3339(),
                    }},
                    doc! {"$unset": "workspaceShare"},
                ],
            )
            .await?;
        Ok(result.matched_count == 1)
    }

    /// 已有工作台链接时复用密文，并发请求也只登记一个令牌。
    pub(crate) async fn workspace_share(
        &self,
        grant: &Grant,
        record: &ShareTokenRecord,
        ciphertext: &str,
    ) -> Result<Option<WorkspaceShare>, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let create = doc! {"$and": [
            {"$eq": ["$visibility", "unlisted"]},
            {"$eq": [{"$type": "$workspaceShare"}, "missing"]},
        ]};
        let current = doc! {"$ifNull": ["$shareTokens", []]};
        let found = self
            .collection(collections::SPACES)
            .find_one_and_update(
                granted_space(grant),
                vec![doc! {"$set": {
                    "shareTokens": {"$cond": [
                        create.clone(), append_share_token(current, record)?, "$shareTokens",
                    ]},
                    "workspaceShare": {"$cond": [create, ciphertext, "$workspaceShare"]},
                }}],
            )
            .projection(doc! {"_id": 0, "visibility": 1, "workspaceShare": 1})
            .return_document(ReturnDocument::After)
            .await?;
        found
            .map(|document| {
                bson::deserialize_from_document(document)
                    .map_err(|error| RepoError::Corrupt(error.to_string()))
            })
            .transpose()
    }

    /// 开始删除空间：在空间文档上记下 `deletingAt`（墓碑）。之后任何授权都拿不到这个空间、任何
    /// 提交都写不进去，而空间编号仍被占着，清理完子集合之前别人不能用同一个编号新建空间（否则
    /// 按 `spaceId` 清理会删掉新空间的数据）。已经在删除中（上次没清理完）时照样返回 `true`。
    pub async fn mark_space_deleting(
        &self,
        grant: &Grant,
        now: Timestamp,
    ) -> Result<bool, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let result = self
            .collection(collections::SPACES)
            .update_one(
                tombstone_filter(grant),
                doc! {"$min": {"deletingAt": now.to_rfc3339()}},
            )
            .await?;
        Ok(result.matched_count == 1)
    }

    /// 清理正在删除的空间：先删各子集合里属于它的文档，最后删空间文档（释放编号）。中途失败时
    /// 墓碑还在，主人可以重试删除。区块是全局内容寻址的，不删；上传会话和任务留给处理服务按
    /// 各自的规则清理。返回空间文档是否被删掉。
    pub async fn purge_deleting_space(&self, grant: &Grant) -> Result<bool, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let mut filter = tombstone_filter(grant);
        filter.insert("deletingAt", doc! {"$exists": true});
        let spaces = self.collection(collections::SPACES);
        if spaces
            .find_one(filter.clone())
            .projection(doc! {"_id": 1})
            .await?
            .is_none()
        {
            return Ok(false);
        }
        // 编号还被墓碑占着，按空间编号整体清掉不会碰到别人的空间（有的集合不带主人副本，例如
        // 事件类型）。
        let children: Document = doc! {"spaceId": grant.space_id()};
        for collection in [
            collections::COMMITS,
            collections::ENTITIES,
            collections::ANCHORS,
            collections::RECORDS,
            collections::PALETTES,
            collections::STATE_BLOBS,
            collections::ASSET_REFS,
            collections::DRAFTS,
            collections::DRAFT_CHUNKS,
            collections::PREVIEWS,
            collections::EVENTS,
            collections::EVENT_TYPES,
            collections::STATE_SNAPSHOTS,
        ] {
            self.collection(collection)
                .delete_many(children.clone())
                .await?;
        }
        let deleted = spaces.delete_one(filter).await?;
        Ok(deleted.deleted_count == 1)
    }
}

fn append_share_token(records: Document, record: &ShareTokenRecord) -> Result<Document, RepoError> {
    Ok(doc! {"$slice": [
        {"$concatArrays": [records, {"$literal": [to_bson(record)?]}]},
        -(MAX_SHARE_TOKEN_RECORDS as i32),
    ]})
}

/// 删除用的条件：`{_id, owner.kind, owner.id}`，不排除墓碑。
fn tombstone_filter(grant: &Grant) -> Document {
    let owner_kind = match grant.owner().kind {
        metaverse_core::model::OwnerKind::Person => "person",
        metaverse_core::model::OwnerKind::Org => "org",
    };
    doc! {
        "_id": grant.space_id(),
        "owner.kind": owner_kind,
        "owner.id": &grant.owner().id,
    }
}
