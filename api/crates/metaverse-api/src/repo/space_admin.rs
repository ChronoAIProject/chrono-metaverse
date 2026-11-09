//! 管理接口的空间写入（设计 8.4）：名称和可见性、分享令牌轮换、删除空间。
//! 区域和地块的修改写成一次提交，走 [`Repo::write_commit`]。

use metaverse_core::model::{ShareTokenRecord, Visibility};
use metaverse_core::Timestamp;
use mongodb::bson::{doc, Document};

use super::commits::{granted_space, to_bson};
use super::{collections, Repo, RepoError};
use crate::auth::Grant;

/// 一个空间最多保留多少条分享令牌记录（含已吊销的，留作审计）。
pub const MAX_SHARE_TOKEN_RECORDS: usize = 20;

/// 名称、说明、可见性的修改；`None` 表示不改。
#[derive(Debug, Clone, Default)]
pub struct SpaceSettings {
    pub name: Option<String>,
    pub description: Option<String>,
    pub visibility: Option<Visibility>,
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
        let spaces = self.collection(collections::SPACES);
        let Some(space) = self.space(grant).await? else {
            return Ok(false);
        };
        let mut records = space.share_tokens;
        for existing in &mut records {
            if existing.revoked_at.is_none() {
                existing.revoked_at = Some(now);
            }
        }
        records.push(record.clone());
        let skip = records.len().saturating_sub(MAX_SHARE_TOKEN_RECORDS);
        let records: Vec<ShareTokenRecord> = records.into_iter().skip(skip).collect();
        let result = spaces
            .update_one(
                granted_space(grant),
                doc! {"$set": {"shareTokens": to_bson(&records)?, "updatedAt": now.to_rfc3339()}},
            )
            .await?;
        Ok(result.matched_count == 1)
    }

    /// 删除空间：先删空间文档（之后任何授权都拿不到这个空间），再删各子集合里属于它的文档。
    /// 区块是全局内容寻址的，不删；上传会话和任务留给处理服务按各自的规则清理。
    pub async fn delete_space(&self, grant: &Grant) -> Result<bool, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let deleted = self
            .collection(collections::SPACES)
            .delete_one(granted_space(grant))
            .await?;
        if deleted.deleted_count != 1 {
            return Ok(false);
        }
        // 空间文档已经按主人删掉；子集合按空间编号整体清掉（有的集合不带主人副本，例如事件类型）。
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
        Ok(true)
    }
}
