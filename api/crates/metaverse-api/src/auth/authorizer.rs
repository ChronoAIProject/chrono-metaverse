//! 资源级授权与授权凭据（设计 9.2、9.4）。
//!
//! 参照 CMA `layer2-core/src/resource_access/`：主人类型显式记录；组织空间创建时现场
//! 核验并写入归属证据；访问级别实时计算，不跨请求缓存。
//!
//! [`Grant`]、[`CreateGrant`]、[`AuthorizerKey`] 的字段都是私有的，只有本模块能构造，
//! 所以数据访问层（`repo/`）的每一次读写都必然经过这里的检查。

use metaverse_core::ids::is_space_id;
use metaverse_core::model::{EvidenceBasis, OrgRole, Owner, OwnerEvidence, OwnerKind, Visibility};
use metaverse_core::{sha256_hex, Timestamp};
use subtle::ConstantTimeEq;

use super::access::{direct_access, level_for_role, AccessLevel};
use super::organizations::{MembershipLookup, OrganizationClient};
use super::permissions::Capability;
use super::Caller;
use crate::error::ApiError;
use crate::repo::Repo;

/// 只读主人和可见性的钥匙：数据访问层的 [`Repo::space_policy`] 只接受它。
pub struct AuthorizerKey {
    _private: (),
}

/// 凭据允许的访问。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantAccess {
    /// 公开读接口：只能读公开级数据。
    Public,
    /// 只读（含内部级数据）。
    Read,
    /// 管理。
    Manage,
}

/// 公开访问的依据，决定响应能不能被共享缓存。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicBasis {
    /// 空间本身是公开的。
    PublicVisibility,
    /// 凭分享令牌。
    ShareToken,
    /// 凭草稿预览令牌（设计 5.6）：响应一律不缓存。
    Preview,
}

/// 访问某个空间的授权凭据（空间编号、主人、访问级别）。
#[derive(Debug, Clone)]
pub struct Grant {
    space_id: String,
    owner: Owner,
    access: GrantAccess,
    public_basis: Option<PublicBasis>,
}

/// 读取不属于某个空间的内容寻址数据（已发布的区块、登记在 `assetRefs` 里的资源）的凭据。
/// 这些数据一旦发出就收不回（设计 8.2），但数据访问层同样只认授权层签发的凭据。
#[derive(Debug, Clone)]
pub struct BlobGrant {
    _private: (),
}

/// 预览令牌指向的草稿版本（设计 5.6：绑定 {空间, 草稿, rev}）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewTarget {
    pub draft_id: String,
    pub rev: u64,
}

impl Grant {
    pub fn space_id(&self) -> &str {
        &self.space_id
    }

    /// 库里记录的主人，数据访问层用它做查询条件。
    pub fn owner(&self) -> &Owner {
        &self.owner
    }

    pub fn access(&self) -> GrantAccess {
        self.access
    }

    /// 能否读内部级数据（锚点、事件）。
    pub fn can_read_internal(&self) -> bool {
        matches!(self.access, GrantAccess::Read | GrantAccess::Manage)
    }

    pub fn can_manage(&self) -> bool {
        self.access == GrantAccess::Manage
    }

    pub fn public_basis(&self) -> Option<PublicBasis> {
        self.public_basis
    }
}

/// 新建空间的授权凭据：主人和组织归属证据。
#[derive(Debug, Clone)]
pub struct CreateGrant {
    owner: Owner,
    evidence: Option<OwnerEvidence>,
}

impl CreateGrant {
    pub fn owner(&self) -> &Owner {
        &self.owner
    }

    pub fn evidence(&self) -> Option<&OwnerEvidence> {
        self.evidence.as_ref()
    }
}

/// 请求的用途。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Read,
    Manage,
}

pub struct Authorizer {
    repo: Repo,
    organizations: OrganizationClient,
    issuer: String,
    require_permissions: bool,
}

/// 分享令牌原文的格式：base64url，长度 22–256（至少 128 位随机数）。
fn plausible_share_token(token: &str) -> bool {
    (22..=256).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Authorizer {
    pub fn new(
        repo: Repo,
        organizations: OrganizationClient,
        issuer: String,
        require_permissions: bool,
    ) -> Self {
        Self {
            repo,
            organizations,
            issuer,
            require_permissions,
        }
    }

    fn key() -> AuthorizerKey {
        AuthorizerKey { _private: () }
    }

    /// 功能级权限（可选，设计 9.2）。
    pub fn require_capability(
        &self,
        caller: &Caller,
        capability: Capability,
    ) -> Result<(), ApiError> {
        if self.require_permissions && !caller.capabilities.allows(capability) {
            return Err(ApiError::forbidden());
        }
        Ok(())
    }

    /// `/api/v1/spaces/{space_id}/...` 的资源级检查。
    ///
    /// - 看不到 → 404；能看到但要管理而只有只读 → 403；
    /// - 组织角色查不到：读操作按"不是成员"处理（404），写操作返回 503。
    pub async fn space(
        &self,
        caller: &Caller,
        space_id: &str,
        purpose: Purpose,
    ) -> Result<Grant, ApiError> {
        if !is_space_id(space_id) {
            return Err(ApiError::not_found());
        }
        let policy = self
            .repo
            .space_policy(&Self::key(), space_id)
            .await?
            .ok_or_else(ApiError::not_found)?;
        let owner = policy.effective_owner();
        let level = match direct_access(&owner, &caller.subject) {
            Some(level) => level,
            None => match self
                .organizations
                .membership(&caller.subject, caller.credential(), &owner.id)
                .await
            {
                MembershipLookup::Member(evidence) => level_for_role(evidence.role),
                MembershipLookup::NotMember => AccessLevel::None,
                MembershipLookup::Unavailable => match purpose {
                    Purpose::Read => AccessLevel::None,
                    Purpose::Manage => return Err(ApiError::org_membership_unavailable()),
                },
            },
        };
        let access = match (level, purpose) {
            (AccessLevel::None, _) => return Err(ApiError::not_found()),
            (AccessLevel::Read, Purpose::Manage) => return Err(ApiError::forbidden()),
            (AccessLevel::Read, Purpose::Read) => GrantAccess::Read,
            (AccessLevel::Manage, _) => GrantAccess::Manage,
        };
        Ok(Grant {
            space_id: space_id.to_owned(),
            owner: policy.owner,
            access,
            public_basis: None,
        })
    }

    /// 建空间（管理接口，设计 8.4）：个人空间由本人创建；组织空间要求调用者是组织本身，
    /// 或经 NyxID 现场核验是该组织的 admin，并写入归属证据。
    pub async fn create_space(
        &self,
        caller: &Caller,
        owner: &Owner,
        now: Timestamp,
    ) -> Result<CreateGrant, ApiError> {
        self.require_capability(caller, Capability::CreateSpaces)?;
        if !owner.is_valid() {
            return Err(ApiError::invalid("owner.id 必须是 NyxID 的规范编号"));
        }
        match owner.kind {
            OwnerKind::Person if owner.id == caller.subject => Ok(CreateGrant {
                owner: owner.clone(),
                evidence: None,
            }),
            OwnerKind::Person => Err(ApiError::forbidden()),
            OwnerKind::Org if owner.id == caller.subject => Ok(CreateGrant {
                owner: owner.clone(),
                evidence: Some(OwnerEvidence {
                    issuer: self.issuer.clone(),
                    org_id: owner.id.clone(),
                    verified_by: caller.subject.clone(),
                    verified_at: now,
                    basis: EvidenceBasis::OrgSubject,
                    role_at_verification: None,
                }),
            }),
            OwnerKind::Org => {
                match self
                    .organizations
                    .membership(&caller.subject, caller.credential(), &owner.id)
                    .await
                {
                    MembershipLookup::Member(evidence)
                        if evidence.role == OrgRole::Admin && evidence.is_current() =>
                    {
                        Ok(CreateGrant {
                            owner: owner.clone(),
                            evidence: Some(OwnerEvidence {
                                issuer: self.issuer.clone(),
                                org_id: owner.id.clone(),
                                verified_by: caller.subject.clone(),
                                verified_at: Timestamp::from_system_time(evidence.observed_at)
                                    .unwrap_or(now),
                                basis: EvidenceBasis::OrgAdmin,
                                role_at_verification: Some(OrgRole::Admin),
                            }),
                        })
                    }
                    MembershipLookup::Member(_) | MembershipLookup::NotMember => {
                        Err(ApiError::forbidden())
                    }
                    MembershipLookup::Unavailable => Err(ApiError::org_membership_unavailable()),
                }
            }
        }
    }

    /// 公开读接口（设计 8.2）：公开空间直接可读；凭链接查看的空间要带有效的分享令牌，
    /// 没带或无效一律 404。
    pub async fn public_space(
        &self,
        space_id: &str,
        share_token: Option<&str>,
    ) -> Result<Grant, ApiError> {
        if !is_space_id(space_id) {
            return Err(ApiError::not_found());
        }
        let policy = self
            .repo
            .space_policy(&Self::key(), space_id)
            .await?
            .ok_or_else(ApiError::not_found)?;
        let basis = if policy.visibility == Visibility::Public {
            PublicBasis::PublicVisibility
        } else {
            let token = share_token
                .filter(|token| plausible_share_token(token))
                .ok_or_else(ApiError::not_found)?;
            let presented = sha256_hex(token.as_bytes());
            // 逐个比较全部令牌，不提前退出，比较本身是常数时间。
            let matched = policy
                .share_tokens
                .iter()
                .filter(|record| record.revoked_at.is_none())
                .fold(false, |found, record| {
                    found | bool::from(record.hash.as_bytes().ct_eq(presented.as_bytes()))
                });
            if !matched {
                return Err(ApiError::not_found());
            }
            PublicBasis::ShareToken
        };
        Ok(Grant {
            space_id: space_id.to_owned(),
            owner: policy.owner,
            access: GrantAccess::Public,
            public_basis: Some(basis),
        })
    }
}

// 组合宇宙、凭组合令牌读成员空间、系统范围：放在子模块里，可以构造本模块的凭据。
mod system;
mod universes;

pub use system::SystemGrant;
pub use universes::{
    CreateUniverseGrant, MembershipBasis, MembershipChange, MembershipGrant, UniverseGrant,
};
/// 预览令牌原文的格式：base64url，43 个字符（256 位随机数）。
fn plausible_preview_token(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Authorizer {
    /// 刚创建的空间：创建凭据换成同一空间的"管理"凭据（用于写第一次提交）。
    pub fn grant_for_created_space(&self, grant: &CreateGrant, space_id: &str) -> Grant {
        Grant {
            space_id: space_id.to_owned(),
            owner: grant.owner.clone(),
            access: GrantAccess::Manage,
            public_basis: None,
        }
    }

    /// 后台用途的显式系统范围（设计 9.4）：只在服务端自己发起的后台处理里使用
    /// （例如接口服务进程内处理的 `ops_from_upload` 任务），每次签发都写审计日志。
    /// 空间的主人必须仍是发起时记录的主人，否则拒绝。
    pub async fn system_space(
        &self,
        space_id: &str,
        expected_owner: &Owner,
        purpose: &'static str,
        reference: &str,
    ) -> Result<Grant, ApiError> {
        let policy = self
            .repo
            .space_policy(&Self::key(), space_id)
            .await?
            .ok_or_else(ApiError::not_found)?;
        if &policy.owner != expected_owner {
            tracing::warn!(target: "audit", space = %space_id, purpose, reference, "系统范围被拒绝：空间主人已变");
            return Err(ApiError::not_found());
        }
        tracing::info!(target: "audit", space = %space_id, owner = %policy.owner.id, purpose, reference, "签发系统范围");
        Ok(Grant {
            space_id: space_id.to_owned(),
            owner: policy.owner,
            access: GrantAccess::Manage,
            public_basis: None,
        })
    }

    /// 读取已发布区块和已登记资源的凭据（公开读接口 `.bin`）。
    pub fn published_blobs(&self) -> BlobGrant {
        BlobGrant { _private: () }
    }

    /// 草稿预览（设计 5.6、8.2）：令牌只存哈希；过期、不存在、格式不对一律 404。
    /// 返回的凭据和公开读接口一样只能读公开级数据。
    pub async fn preview(
        &self,
        token: Option<&str>,
        now: Timestamp,
    ) -> Result<(Grant, PreviewTarget), ApiError> {
        let token = token
            .filter(|token| plausible_preview_token(token))
            .ok_or_else(ApiError::not_found)?;
        let record = self
            .repo
            .preview_by_hash(&Self::key(), &sha256_hex(token.as_bytes()))
            .await?
            .filter(|record| record.expires_at > now && is_space_id(&record.space_id))
            .ok_or_else(ApiError::not_found)?;
        let policy = self
            .repo
            .space_policy(&Self::key(), &record.space_id)
            .await?
            .ok_or_else(ApiError::not_found)?;
        if policy.owner != record.owner {
            return Err(ApiError::not_found());
        }
        Ok((
            Grant {
                space_id: record.space_id,
                owner: policy.owner,
                access: GrantAccess::Public,
                public_basis: Some(PublicBasis::Preview),
            },
            PreviewTarget {
                draft_id: record.draft_id,
                rev: record.rev,
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_token_format() {
        assert!(plausible_preview_token(&"a".repeat(43)));
        assert!(!plausible_preview_token(&"a".repeat(42)));
        assert!(!plausible_preview_token(&format!("{}=", "a".repeat(42))));
    }

    #[test]
    fn share_token_format() {
        assert!(plausible_share_token(&"a".repeat(43)));
        assert!(!plausible_share_token("short"));
        assert!(!plausible_share_token(&"a".repeat(257)));
        assert!(!plausible_share_token(&format!("{}=", "a".repeat(42))));
    }
}
