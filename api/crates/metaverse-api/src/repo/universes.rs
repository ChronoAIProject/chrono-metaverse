//! 组合宇宙的读写（设计 4.5、12）。
//!
//! - 读写都要求组合的授权凭据（[`UniverseGrant`]、[`CreateUniverseGrant`]、[`MembershipGrant`]），
//!   条件自动带上组合编号和主人；
//! - 每次成员、摆放或连接变化都在一个事务里插入修订（`(universeId, seq)` 唯一）并按
//!   `head.seq == 旧值` 推进组合；匹配不到就是组合已经变了（409）；
//! - 加入凭邀请时，更新条件要求空间仍在邀请列表里；空间管理者退出时，要求空间仍是成员；
//! - 唯一不带授权的读取是 [`Repo::universe_policy`]，要求只有授权层能构造的钥匙。

use metaverse_core::model::{
    Owner, OwnerEvidence, OwnerKind, ShareTokenRecord, Universe, UniverseMember, UniverseRevision,
    Visibility,
};
use metaverse_core::Timestamp;
use mongodb::bson::{self, doc, Bson, Document};
use serde::Deserialize;

use super::transactions::{TxnOp, TxnOutcome};
use super::{collections, Repo, RepoError};
use crate::auth::{
    AuthorizerKey, CreateUniverseGrant, Grant, MembershipBasis, MembershipGrant, UniverseGrant,
};

/// 组合级授权需要的信息：主人、证据、可见性、分享令牌哈希、当前成员。
#[derive(Debug, Clone)]
pub struct UniversePolicy {
    pub owner: Owner,
    pub owner_evidence: Option<OwnerEvidence>,
    pub visibility: Visibility,
    pub share_tokens: Vec<ShareTokenRecord>,
    /// 当前成员的空间编号。
    pub members: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolicyDocument {
    owner: Owner,
    #[serde(default)]
    owner_evidence: Option<OwnerEvidence>,
    visibility: Visibility,
    #[serde(default)]
    share_tokens: Vec<ShareTokenRecord>,
    #[serde(default)]
    members: Vec<UniverseMember>,
}

impl UniversePolicy {
    /// 没有一致的组织归属证据时按个人所有处理（与空间相同）。
    pub fn effective_owner(&self) -> Owner {
        let consistent = match (&self.owner.kind, &self.owner_evidence) {
            (OwnerKind::Person, None) => true,
            (OwnerKind::Org, Some(evidence)) => evidence.org_id == self.owner.id,
            _ => false,
        };
        if consistent {
            self.owner.clone()
        } else {
            tracing::warn!(owner = %self.owner.id, "组合的组织归属证据缺失或不一致，按个人所有处理");
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

fn granted_universe(grant: &UniverseGrant) -> Document {
    doc! {
        "_id": grant.universe_id(),
        "owner.kind": owner_kind(grant.owner()),
        "owner.id": &grant.owner().id,
    }
}

fn granted_revisions(grant: &UniverseGrant) -> Document {
    doc! {
        "universeId": grant.universe_id(),
        "owner.kind": owner_kind(grant.owner()),
        "owner.id": &grant.owner().id,
    }
}

fn to_document<T: serde::Serialize>(value: &T) -> Result<Document, RepoError> {
    bson::serialize_to_document(value).map_err(|error| RepoError::Corrupt(error.to_string()))
}

fn to_bson<T: serde::Serialize>(value: &T) -> Result<Bson, RepoError> {
    bson::serialize_to_bson(value).map_err(|error| RepoError::Corrupt(error.to_string()))
}

fn from_document<T: serde::de::DeserializeOwned>(document: Document) -> Result<T, RepoError> {
    bson::deserialize_from_document(document).map_err(|error| RepoError::Corrupt(error.to_string()))
}

/// 组合文档上可以改的字段（不含成员、连接；它们随修订一起改）。
#[derive(Debug, Clone, Default)]
pub struct UniverseFieldsUpdate {
    pub name: Option<String>,
    pub visibility: Option<Visibility>,
    pub share_tokens: Option<Vec<ShareTokenRecord>>,
    pub invitations: Option<Vec<String>>,
}

/// 条件写入的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UniverseWrite {
    Applied,
    /// 组合已经变了（seq 不对），或者邀请、成员条件不再成立。
    Conflict,
}

impl Repo {
    /// 只读组合的主人、可见性、令牌哈希和成员，专供授权层使用。
    pub async fn universe_policy(
        &self,
        _key: &AuthorizerKey,
        universe_id: &str,
    ) -> Result<Option<UniversePolicy>, RepoError> {
        let found = self
            .collection(collections::UNIVERSES)
            .find_one(doc! {"_id": universe_id})
            .projection(doc! {
                "owner": 1, "ownerEvidence": 1, "visibility": 1, "shareTokens": 1, "members": 1
            })
            .await?;
        let Some(document) = found else {
            return Ok(None);
        };
        let policy: PolicyDocument = from_document(document)?;
        Ok(Some(UniversePolicy {
            owner: policy.owner,
            owner_evidence: policy.owner_evidence,
            visibility: policy.visibility,
            share_tokens: policy.share_tokens,
            members: policy
                .members
                .into_iter()
                .map(|member| member.space_id)
                .collect(),
        }))
    }

    /// 新建组合。主人和证据必须与创建凭据一致。
    pub async fn insert_universe(
        &self,
        grant: &CreateUniverseGrant,
        universe: &Universe,
    ) -> Result<(), RepoError> {
        if &universe.owner != grant.owner()
            || universe.owner_evidence.as_ref() != grant.evidence()
            || !universe.members.is_empty()
        {
            return Err(RepoError::GrantMismatch);
        }
        self.collection(collections::UNIVERSES)
            .insert_one(to_document(universe)?)
            .await?;
        Ok(())
    }

    /// 读组合文档。
    pub async fn universe(&self, grant: &UniverseGrant) -> Result<Option<Universe>, RepoError> {
        self.collection(collections::UNIVERSES)
            .find_one(granted_universe(grant))
            .await?
            .map(from_document)
            .transpose()
    }

    /// 修改组合：可选地带一条新修订（成员摆放或连接变了）。条件：管理凭据、`head.seq == base_seq`。
    pub async fn update_universe(
        &self,
        grant: &UniverseGrant,
        base_seq: u64,
        fields: &UniverseFieldsUpdate,
        revision: Option<&UniverseRevision>,
        now: Timestamp,
    ) -> Result<UniverseWrite, RepoError> {
        if !grant.can_manage() {
            return Err(RepoError::GrantMismatch);
        }
        let mut filter = granted_universe(grant);
        filter.insert("head.seq", base_seq as i64);
        let mut set = doc! {"updatedAt": now.to_rfc3339()};
        if let Some(name) = &fields.name {
            set.insert("name", name);
        }
        if let Some(visibility) = &fields.visibility {
            set.insert("visibility", to_bson(visibility)?);
        }
        if let Some(tokens) = &fields.share_tokens {
            set.insert("shareTokens", to_bson(tokens)?);
        }
        if let Some(invitations) = &fields.invitations {
            set.insert("invitations", to_bson(invitations)?);
        }
        let Some(revision) = revision else {
            let result = self
                .collection(collections::UNIVERSES)
                .update_one(filter, doc! {"$set": set})
                .await?;
            return Ok(if result.matched_count == 1 {
                UniverseWrite::Applied
            } else {
                UniverseWrite::Conflict
            });
        };
        self.write_revision(grant, filter, set, revision).await
    }

    /// 加入或退出：插入修订并推进组合，条件按凭据的依据核对。
    pub async fn change_membership(
        &self,
        grant: &MembershipGrant,
        base_seq: u64,
        revision: &UniverseRevision,
        invitations: &[String],
        now: Timestamp,
    ) -> Result<UniverseWrite, RepoError> {
        let universe = grant.universe();
        let mut filter = granted_universe(universe);
        filter.insert("head.seq", base_seq as i64);
        let joining = revision
            .state
            .members
            .iter()
            .any(|member| member.space_id == grant.space_id());
        match grant.basis() {
            MembershipBasis::UniverseManager => {}
            MembershipBasis::Invited if joining => {
                filter.insert("invitations", grant.space_id());
            }
            MembershipBasis::SpaceManager if !joining => {
                filter.insert("members.spaceId", grant.space_id());
            }
            _ => return Err(RepoError::GrantMismatch),
        }
        if joining {
            // 加入时空间必须由调用者管理（凭据里带着空间的管理凭据）。
            if !grant
                .space()
                .is_some_and(|space| space.can_manage() && space.space_id() == grant.space_id())
            {
                return Err(RepoError::GrantMismatch);
            }
            filter.insert("members.spaceId", doc! {"$ne": grant.space_id()});
        }
        let set = doc! {
            "updatedAt": now.to_rfc3339(),
            "invitations": to_bson(&invitations)?,
        };
        self.write_revision(universe, filter, set, revision).await
    }

    async fn write_revision(
        &self,
        grant: &UniverseGrant,
        filter: Document,
        mut set: Document,
        revision: &UniverseRevision,
    ) -> Result<UniverseWrite, RepoError> {
        if revision.universe_id != grant.universe_id()
            || revision.owner.as_ref() != Some(grant.owner())
        {
            return Err(RepoError::GrantMismatch);
        }
        let mut document = to_document(revision)?;
        document.insert("_id", format!("{}:{}", revision.universe_id, revision.seq));
        set.insert(
            "head",
            doc! {"seq": revision.seq as i64, "at": revision.at.to_rfc3339()},
        );
        set.insert("members", to_bson(&revision.state.members)?);
        set.insert("links", to_bson(&revision.state.links)?);
        let outcome = self
            .run_transaction(&[
                TxnOp::Insert {
                    collection: collections::UNIVERSE_REVISIONS,
                    document,
                },
                TxnOp::Update {
                    collection: collections::UNIVERSES,
                    filter,
                    update: doc! {"$set": set},
                },
            ])
            .await;
        match outcome {
            Ok(TxnOutcome::Committed) => Ok(UniverseWrite::Applied),
            Ok(TxnOutcome::NotMatched(_)) | Err(RepoError::Duplicate) => {
                Ok(UniverseWrite::Conflict)
            }
            Err(error) => Err(error),
        }
    }

    /// T 时刻生效的修订：`at ≤ T` 的最后一条。
    pub async fn universe_revision_at(
        &self,
        grant: &UniverseGrant,
        at: Timestamp,
    ) -> Result<Option<UniverseRevision>, RepoError> {
        let mut filter = granted_revisions(grant);
        filter.insert("at", doc! {"$lte": at.to_rfc3339()});
        self.collection(collections::UNIVERSE_REVISIONS)
            .find_one(filter)
            .sort(doc! {"seq": -1})
            .await?
            .map(from_document)
            .transpose()
    }

    /// 某一次修订。
    pub async fn universe_revision(
        &self,
        grant: &UniverseGrant,
        seq: u64,
    ) -> Result<Option<UniverseRevision>, RepoError> {
        let mut filter = granted_revisions(grant);
        filter.insert("seq", seq as i64);
        self.collection(collections::UNIVERSE_REVISIONS)
            .find_one(filter)
            .await?
            .map(from_document)
            .transpose()
    }

    /// T 时刻的成员（空间编号）。
    pub async fn universe_members_at(
        &self,
        grant: &UniverseGrant,
        at: Timestamp,
    ) -> Result<Vec<String>, RepoError> {
        Ok(self
            .universe_revision_at(grant, at)
            .await?
            .map(|revision| {
                revision
                    .state
                    .members
                    .into_iter()
                    .map(|member| member.space_id)
                    .collect()
            })
            .unwrap_or_default())
    }

    /// 全部修订的 (时间, 成员空间编号)，按 seq 排序（判断成员资格的时间段用，最多 10000 条）。
    pub async fn universe_membership_history(
        &self,
        grant: &UniverseGrant,
    ) -> Result<Vec<(Timestamp, Vec<String>)>, RepoError> {
        #[derive(Deserialize)]
        struct MemberId {
            #[serde(rename = "spaceId")]
            space_id: String,
        }
        #[derive(Deserialize)]
        struct StateMembers {
            #[serde(default)]
            members: Vec<MemberId>,
        }
        #[derive(Deserialize)]
        struct Row {
            at: Timestamp,
            state: StateMembers,
        }
        let mut cursor = self
            .collection(collections::UNIVERSE_REVISIONS)
            .find(granted_revisions(grant))
            .sort(doc! {"seq": 1})
            .projection(doc! {"at": 1, "state.members.spaceId": 1})
            .limit(10_000)
            .await?;
        let mut history = Vec::new();
        while cursor.advance().await? {
            let document: Document = cursor
                .deserialize_current()
                .map_err(|error| RepoError::Corrupt(error.to_string()))?;
            let row: Row = from_document(document)?;
            history.push((
                row.at,
                row.state.members.into_iter().map(|m| m.space_id).collect(),
            ));
        }
        Ok(history)
    }

    /// 第 seq 次提交生效的时间段 `[at(seq), at(seq + 1))`；seq 是最新提交时终点为空。
    /// 提交不存在时返回空。
    pub async fn commit_window(
        &self,
        grant: &Grant,
        seq: u64,
    ) -> Result<Option<(Timestamp, Option<Timestamp>)>, RepoError> {
        let at_of = |seq: u64| {
            let filter = doc! {
                "spaceId": grant.space_id(),
                "owner.kind": owner_kind(grant.owner()),
                "owner.id": &grant.owner().id,
                "seq": seq as i64,
            };
            async move {
                let found = self
                    .collection(collections::COMMITS)
                    .find_one(filter)
                    .projection(doc! {"at": 1})
                    .await?;
                Ok::<_, RepoError>(found.and_then(|document| {
                    document
                        .get_str("at")
                        .ok()
                        .and_then(|text| Timestamp::parse_rfc3339(text).ok())
                }))
            }
        };
        let Some(start) = at_of(seq).await? else {
            return Ok(None);
        };
        let end = at_of(seq + 1).await?;
        Ok(Some((start, end)))
    }

    /// 空间在 T 时刻的 seq：`at ≤ T` 的最大 seq；T 之前没有提交时为空。
    pub async fn space_seq_at(
        &self,
        grant: &Grant,
        at: Timestamp,
    ) -> Result<Option<u64>, RepoError> {
        let found = self
            .collection(collections::COMMITS)
            .find_one(doc! {
                "spaceId": grant.space_id(),
                "owner.kind": owner_kind(grant.owner()),
                "owner.id": &grant.owner().id,
                "at": {"$lte": at.to_rfc3339()},
            })
            .sort(doc! {"at": -1, "seq": -1})
            .projection(doc! {"seq": 1})
            .await?;
        Ok(found.and_then(|document| match document.get("seq") {
            Some(Bson::Int64(seq)) => u64::try_from(*seq).ok(),
            Some(Bson::Int32(seq)) => u64::try_from(*seq).ok(),
            Some(Bson::Double(seq)) if *seq >= 0.0 => Some(*seq as u64),
            _ => None,
        }))
    }
}
