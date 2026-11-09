//! 空间的读写。每个方法都要求授权凭据，查询条件自动带上空间编号和主人。

use metaverse_core::model::{Owner, OwnerEvidence, OwnerKind, ShareTokenRecord, Space, Visibility};
use metaverse_core::record::AnchorBody;
use mongodb::bson::{self, doc, Document};
use serde::Deserialize;

use super::{collections, Repo, RepoError};
use crate::auth::{AuthorizerKey, CreateGrant, Grant};

/// 资源级授权需要的最少信息：主人、组织归属证据、可见性、分享令牌哈希。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpacePolicy {
    pub owner: Owner,
    #[serde(default)]
    pub owner_evidence: Option<OwnerEvidence>,
    pub visibility: Visibility,
    #[serde(default)]
    pub share_tokens: Vec<ShareTokenRecord>,
}

impl SpacePolicy {
    /// 判断访问级别时使用的主人：没有一致的组织归属证据的空间一律按个人所有处理
    /// （设计 9.2，与 CMA 的规则相同）。
    pub fn effective_owner(&self) -> Owner {
        let consistent = match (&self.owner.kind, &self.owner_evidence) {
            (OwnerKind::Person, None) => true,
            (OwnerKind::Org, Some(evidence)) => evidence.org_id == self.owner.id,
            _ => false,
        };
        if consistent {
            self.owner.clone()
        } else {
            tracing::warn!(owner = %self.owner.id, "空间的组织归属证据缺失或不一致，按个人所有处理");
            Owner::person(self.owner.id.clone())
        }
    }
}

fn owner_kind(owner: &Owner) -> &'static str {
    match owner.kind {
        OwnerKind::Person => "person",
        OwnerKind::Org => "org",
    }
}

/// `{_id, owner.kind, owner.id}`：读写都带上主人，主人变了就匹配不到。
fn granted_space(grant: &Grant) -> Document {
    doc! {
        "_id": grant.space_id(),
        "owner.kind": owner_kind(grant.owner()),
        "owner.id": &grant.owner().id,
    }
}

/// 子集合的过滤条件：`{spaceId, owner.kind, owner.id}`。
fn granted_children(grant: &Grant) -> Document {
    doc! {
        "spaceId": grant.space_id(),
        "owner.kind": owner_kind(grant.owner()),
        "owner.id": &grant.owner().id,
    }
}

/// 子集合里锚点当前状态的文档。
#[derive(Deserialize)]
struct AnchorDocument {
    body: AnchorBody,
}

/// 一次最多返回的锚点数。
const MAX_ANCHORS: i64 = 10_000;

impl Repo {
    /// 只读主人、可见性和分享令牌哈希，专供授权层使用。
    pub async fn space_policy(
        &self,
        _key: &AuthorizerKey,
        space_id: &str,
    ) -> Result<Option<SpacePolicy>, RepoError> {
        let found = self
            .collection(collections::SPACES)
            .find_one(doc! {"_id": space_id})
            .projection(doc! {"owner": 1, "ownerEvidence": 1, "visibility": 1, "shareTokens": 1})
            .await?;
        found
            .map(|document| {
                bson::deserialize_from_document(document)
                    .map_err(|error| RepoError::Corrupt(error.to_string()))
            })
            .transpose()
    }

    /// 新建空间。写入内容的主人和证据必须与创建凭据完全一致。
    pub async fn insert_space(&self, grant: &CreateGrant, space: &Space) -> Result<(), RepoError> {
        if &space.owner != grant.owner()
            || space.owner_evidence.as_ref() != grant.evidence()
            || !space.ownership_is_consistent()
        {
            return Err(RepoError::GrantMismatch);
        }
        let document = bson::serialize_to_document(space)
            .map_err(|error| RepoError::Corrupt(error.to_string()))?;
        self.collection(collections::SPACES)
            .insert_one(document)
            .await?;
        Ok(())
    }

    /// 读空间文档。
    pub async fn space(&self, grant: &Grant) -> Result<Option<Space>, RepoError> {
        let found = self
            .collection(collections::SPACES)
            .find_one(granted_space(grant))
            .await?;
        found
            .map(|document| {
                bson::deserialize_from_document(document)
                    .map_err(|error| RepoError::Corrupt(error.to_string()))
            })
            .transpose()
    }

    /// 锚点的当前状态。公开凭据只能读到公开级锚点。
    pub async fn anchors(&self, grant: &Grant) -> Result<Vec<AnchorBody>, RepoError> {
        let mut filter = granted_children(grant);
        if !grant.can_read_internal() {
            filter.insert("body.visibility", "public");
        }
        let mut cursor = self
            .collection(collections::ANCHORS)
            .find(filter)
            .sort(doc! {"id": 1})
            .limit(MAX_ANCHORS)
            .await?;
        let mut anchors = Vec::new();
        while cursor.advance().await? {
            let document: Document = cursor
                .deserialize_current()
                .map_err(|error| RepoError::Corrupt(error.to_string()))?;
            let anchor: AnchorDocument = bson::deserialize_from_document(document)
                .map_err(|error| RepoError::Corrupt(error.to_string()))?;
            anchors.push(anchor.body);
        }
        Ok(anchors)
    }
}
