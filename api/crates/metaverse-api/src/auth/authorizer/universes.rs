//! 组合宇宙的授权（设计 4.5、12）与"凭组合的分享令牌读成员空间"（设计 8.2）。
//!
//! - 组合的主人规则与空间相同：主人本人、组织本身、组织 admin 是"管理"；组织 member/viewer
//!   只读；其他人看不到（404）。
//! - **加入**：调用者必须能管理该空间（空间主人、组织本身或组织 admin；member/viewer 是 403），
//!   并且能管理这个组合，或者这个空间在组合的邀请列表里。别人不能把你的空间拉进他的组合，
//!   你也不能把空间硬塞进别人的组合。
//! - **退出**：组合的管理者，或该空间的管理者（空间必须是当前成员）。
//! - **凭组合令牌读成员空间**：令牌是该组合的有效分享令牌（或组合本身公开），并且该空间在
//!   T 时刻是组合成员（取 `at ≤ T` 的最后一条修订）。空间主人把空间加入组合，就等于同意被凭
//!   组合链接查看。

use metaverse_core::ids::is_space_id;
use metaverse_core::model::{
    EvidenceBasis, OrgRole, Owner, OwnerEvidence, OwnerKind, ShareTokenRecord, Visibility,
};
use metaverse_core::{sha256_hex, Timestamp};
use subtle::ConstantTimeEq;

use super::super::access::{direct_access, level_for_role, AccessLevel};
use super::super::organizations::MembershipLookup;
use super::super::permissions::Capability;
use super::{plausible_share_token, Authorizer, Grant, GrantAccess, PublicBasis, Purpose};
use crate::auth::Caller;
use crate::error::ApiError;
use crate::repo::UniversePolicy;

/// 访问某个组合的授权凭据。
#[derive(Debug, Clone)]
pub struct UniverseGrant {
    universe_id: String,
    owner: Owner,
    access: GrantAccess,
    public_basis: Option<PublicBasis>,
}

impl UniverseGrant {
    pub fn universe_id(&self) -> &str {
        &self.universe_id
    }

    pub fn owner(&self) -> &Owner {
        &self.owner
    }

    pub fn access(&self) -> GrantAccess {
        self.access
    }

    pub fn can_manage(&self) -> bool {
        self.access == GrantAccess::Manage
    }

    pub fn public_basis(&self) -> Option<PublicBasis> {
        self.public_basis
    }
}

/// 新建组合的授权凭据。
#[derive(Debug, Clone)]
pub struct CreateUniverseGrant {
    owner: Owner,
    evidence: Option<OwnerEvidence>,
}

impl CreateUniverseGrant {
    pub fn owner(&self) -> &Owner {
        &self.owner
    }

    pub fn evidence(&self) -> Option<&OwnerEvidence> {
        self.evidence.as_ref()
    }
}

/// 成员变更（加入、退出）的依据。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MembershipBasis {
    /// 调用者能管理这个组合。
    UniverseManager,
    /// 加入：空间在组合的邀请列表里（数据访问层在更新条件里核对）。
    Invited,
    /// 退出：调用者能管理该空间，空间是当前成员（数据访问层在更新条件里核对）。
    SpaceManager,
}

/// 成员变更的授权凭据：组合 + 空间（管理）+ 依据。
#[derive(Debug, Clone)]
pub struct MembershipGrant {
    universe: UniverseGrant,
    space: Option<Grant>,
    space_id: String,
    basis: MembershipBasis,
}

impl MembershipGrant {
    pub fn universe(&self) -> &UniverseGrant {
        &self.universe
    }

    /// 加入时一定有；组合管理者移除成员时没有。
    pub fn space(&self) -> Option<&Grant> {
        self.space.as_ref()
    }

    pub fn space_id(&self) -> &str {
        &self.space_id
    }

    pub fn basis(&self) -> MembershipBasis {
        self.basis
    }
}

/// 加入还是退出。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MembershipChange {
    Join,
    Leave,
}

/// 按修订历史判断：空间在 `[from, to]`（`to` 为空表示到现在以后）里是否有某个时刻是成员。
/// 第 i 条修订从它的 `at` 起生效，到下一条修订的 `at` 为止。
fn member_during(
    history: &[(Timestamp, Vec<String>)],
    space_id: &str,
    from: Timestamp,
    to: Option<Timestamp>,
) -> bool {
    history.iter().enumerate().any(|(index, (start, members))| {
        let end = history.get(index + 1).map(|(next, _)| *next);
        members.iter().any(|member| member == space_id)
            && to.is_none_or(|to| *start <= to)
            && end.is_none_or(|end| end > from)
    })
}

/// 按修订历史判断：空间在 `at` 时刻是否是成员（取 `at ≤ T` 的最后一条修订，与
/// `Repo::universe_members_at` 相同）。
fn member_at(history: &[(Timestamp, Vec<String>)], space_id: &str, at: Timestamp) -> bool {
    history
        .iter()
        .rev()
        .find(|(start, _)| *start <= at)
        .is_some_and(|(_, members)| members.iter().any(|member| member == space_id))
}

/// 比较分享令牌：逐个比较全部未吊销的令牌，不提前退出。
fn token_matches(records: &[ShareTokenRecord], token: Option<&str>) -> bool {
    let Some(token) = token.filter(|token| plausible_share_token(token)) else {
        return false;
    };
    let presented = sha256_hex(token.as_bytes());
    records
        .iter()
        .filter(|record| record.revoked_at.is_none())
        .fold(false, |found, record| {
            found | bool::from(record.hash.as_bytes().ct_eq(presented.as_bytes()))
        })
}

impl Authorizer {
    /// 调用者对某个主人的资源的访问级别；查不到组织角色时返回 `None`。
    async fn caller_level(&self, caller: &Caller, owner: &Owner) -> Option<AccessLevel> {
        if let Some(level) = direct_access(owner, &caller.subject) {
            return Some(level);
        }
        match self
            .organizations
            .membership(&caller.subject, caller.credential(), &owner.id)
            .await
        {
            MembershipLookup::Member(evidence) => Some(level_for_role(evidence.role)),
            MembershipLookup::NotMember => Some(AccessLevel::None),
            MembershipLookup::Unavailable => None,
        }
    }

    async fn universe_policy_of(&self, universe_id: &str) -> Result<UniversePolicy, ApiError> {
        if !is_space_id(universe_id) {
            return Err(ApiError::not_found());
        }
        self.repo
            .universe_policy(&Self::key(), universe_id)
            .await?
            .ok_or_else(ApiError::not_found)
    }

    fn universe_grant(
        universe_id: &str,
        policy: &UniversePolicy,
        access: GrantAccess,
        public_basis: Option<PublicBasis>,
    ) -> UniverseGrant {
        UniverseGrant {
            universe_id: universe_id.to_owned(),
            owner: policy.owner.clone(),
            access,
            public_basis,
        }
    }

    /// `/api/v1/universes/{universe_id}` 的资源级检查（规则与 [`Authorizer::space`] 相同）。
    pub async fn universe(
        &self,
        caller: &Caller,
        universe_id: &str,
        purpose: Purpose,
    ) -> Result<UniverseGrant, ApiError> {
        if purpose == Purpose::Manage {
            self.require_capability(caller, Capability::WriteUniverses)?;
        }
        let policy = self.universe_policy_of(universe_id).await?;
        let level = match self.caller_level(caller, &policy.effective_owner()).await {
            Some(level) => level,
            None if purpose == Purpose::Manage => {
                return Err(ApiError::org_membership_unavailable())
            }
            None => AccessLevel::None,
        };
        let access = match (level, purpose) {
            (AccessLevel::None, _) => return Err(ApiError::not_found()),
            (AccessLevel::Read, Purpose::Manage) => return Err(ApiError::forbidden()),
            (AccessLevel::Read, Purpose::Read) => GrantAccess::Read,
            (AccessLevel::Manage, _) => GrantAccess::Manage,
        };
        Ok(Self::universe_grant(universe_id, &policy, access, None))
    }

    /// 建组合（设计 12：组织成员都能创建组合，创建者是主人）。主人规则与建空间相同：
    /// 个人组合由本人创建；组织组合要求调用者是组织本身或组织 admin，并写入归属证据。
    pub async fn create_universe(
        &self,
        caller: &Caller,
        owner: &Owner,
        now: Timestamp,
    ) -> Result<CreateUniverseGrant, ApiError> {
        self.require_capability(caller, Capability::WriteUniverses)?;
        if !owner.is_valid() {
            return Err(ApiError::invalid("owner.id 必须是 NyxID 的规范编号"));
        }
        match owner.kind {
            OwnerKind::Person if owner.id == caller.subject => Ok(CreateUniverseGrant {
                owner: owner.clone(),
                evidence: None,
            }),
            OwnerKind::Person => Err(ApiError::forbidden()),
            OwnerKind::Org if owner.id == caller.subject => Ok(CreateUniverseGrant {
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
            OwnerKind::Org => match self
                .organizations
                .membership(&caller.subject, caller.credential(), &owner.id)
                .await
            {
                MembershipLookup::Member(evidence)
                    if evidence.role == OrgRole::Admin && evidence.is_current() =>
                {
                    Ok(CreateUniverseGrant {
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
            },
        }
    }

    /// 加入或退出（设计 12）。
    pub async fn universe_membership(
        &self,
        caller: &Caller,
        universe_id: &str,
        space_id: &str,
        change: MembershipChange,
    ) -> Result<MembershipGrant, ApiError> {
        self.require_capability(caller, Capability::WriteUniverses)?;
        if !is_space_id(space_id) {
            return Err(ApiError::not_found());
        }
        let policy = self.universe_policy_of(universe_id).await?;
        // 组合这一侧查不到组织角色时按"不能管理"处理：加入还可以凭邀请，退出还可以凭空间。
        let universe_level = self
            .caller_level(caller, &policy.effective_owner())
            .await
            .unwrap_or(AccessLevel::None);
        let manages_universe = universe_level == AccessLevel::Manage;
        match change {
            MembershipChange::Join => {
                let space = self.space(caller, space_id, Purpose::Manage).await?;
                let (access, basis) = if manages_universe {
                    (GrantAccess::Manage, MembershipBasis::UniverseManager)
                } else {
                    (GrantAccess::Public, MembershipBasis::Invited)
                };
                Ok(MembershipGrant {
                    universe: Self::universe_grant(universe_id, &policy, access, None),
                    space: Some(space),
                    space_id: space_id.to_owned(),
                    basis,
                })
            }
            MembershipChange::Leave if manages_universe => Ok(MembershipGrant {
                universe: Self::universe_grant(universe_id, &policy, GrantAccess::Manage, None),
                space: None,
                space_id: space_id.to_owned(),
                basis: MembershipBasis::UniverseManager,
            }),
            MembershipChange::Leave => {
                let space = match self.space(caller, space_id, Purpose::Manage).await {
                    Ok(space) => space,
                    Err(_) if universe_level == AccessLevel::Read => {
                        return Err(ApiError::forbidden())
                    }
                    Err(error) => return Err(error),
                };
                if !policy.members.iter().any(|member| member == space_id) {
                    return Err(ApiError::not_found());
                }
                Ok(MembershipGrant {
                    universe: Self::universe_grant(universe_id, &policy, GrantAccess::Public, None),
                    space: Some(space),
                    space_id: space_id.to_owned(),
                    basis: MembershipBasis::SpaceManager,
                })
            }
        }
    }

    /// 组合当前的有效可见性：组合不能比任何成员更公开，成员里有凭链接查看的空间时，
    /// 组合也只能凭链接查看（设计 12）。
    async fn universe_is_public(&self, policy: &UniversePolicy) -> Result<bool, ApiError> {
        if policy.visibility != Visibility::Public {
            return Ok(false);
        }
        for member in &policy.members {
            let public = self
                .repo
                .space_policy(&Self::key(), member)
                .await?
                .is_some_and(|space| space.visibility == Visibility::Public);
            if !public {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// 公开读组合（设计 8.2）：组合实际公开时无需令牌；否则要带有效的组合分享令牌，
    /// 没带或无效一律 404。
    pub async fn public_universe(
        &self,
        universe_id: &str,
        share_token: Option<&str>,
    ) -> Result<UniverseGrant, ApiError> {
        let policy = self.universe_policy_of(universe_id).await?;
        let basis = if token_matches(&policy.share_tokens, share_token) {
            PublicBasis::ShareToken
        } else if self.universe_is_public(&policy).await? {
            PublicBasis::PublicVisibility
        } else {
            return Err(ApiError::not_found());
        };
        Ok(Self::universe_grant(
            universe_id,
            &policy,
            GrantAccess::Public,
            Some(basis),
        ))
    }

    /// 凭组合的分享令牌读成员空间的公开数据（`Authorization: Share <组合令牌>` +
    /// `?universe=<组合编号>`）。要求该空间在 T 时刻是组合成员；否则 404。
    ///
    /// 返回的凭据和凭空间自己的分享令牌一样是公开级、不可共享缓存（`PublicBasis::ShareToken`）。
    pub async fn public_space_via_universe(
        &self,
        space_id: &str,
        universe_id: &str,
        share_token: Option<&str>,
        at: Timestamp,
    ) -> Result<Grant, ApiError> {
        if !is_space_id(space_id) {
            return Err(ApiError::not_found());
        }
        let universe = self.public_universe(universe_id, share_token).await?;
        let members = self.repo.universe_members_at(&universe, at).await?;
        if !members.iter().any(|member| member == space_id) {
            return Err(ApiError::not_found());
        }
        let policy = self
            .repo
            .space_policy(&Self::key(), space_id)
            .await?
            .ok_or_else(ApiError::not_found)?;
        Ok(Grant {
            space_id: space_id.to_owned(),
            owner: policy.owner,
            access: GrantAccess::Public,
            public_basis: Some(match universe.public_basis {
                // 组合公开意味着全部成员都公开。
                Some(PublicBasis::PublicVisibility) if policy.visibility == Visibility::Public => {
                    PublicBasis::PublicVisibility
                }
                _ => PublicBasis::ShareToken,
            }),
        })
    }

    /// 凭组合令牌读成员空间不按时刻索引的信息（空间信息）：与不带时间段的提交列表相同，要求该
    /// 空间在 `[纪元, now]` 里某个时刻是组合成员——组合页回看历史时，后来离开组合的成员也要能
    /// 取到名称和事件显示规则。返回凭据和"现在是否仍是成员"（调用方据此去掉离开之后的当前内容）。
    pub async fn public_space_via_universe_ever(
        &self,
        space_id: &str,
        universe_id: &str,
        share_token: Option<&str>,
        now: Timestamp,
    ) -> Result<(Grant, bool), ApiError> {
        if !is_space_id(space_id) {
            return Err(ApiError::not_found());
        }
        let universe = self.public_universe(universe_id, share_token).await?;
        let history = self.repo.universe_membership_history(&universe).await?;
        let epoch = Timestamp::from_millis(0).map_err(|_| ApiError::internal())?;
        if !member_during(&history, space_id, epoch, Some(now)) {
            return Err(ApiError::not_found());
        }
        let current = member_at(&history, space_id, now);
        let grant = self.member_space_grant(space_id, &universe).await?;
        Ok((grant, current))
    }

    /// 凭组合令牌读成员空间在一段时间 `[from, to]` 里的公开数据（时间窗事件、密度、提交列表）：
    /// 要求该空间在这段时间里的某个时刻是组合成员。
    pub async fn public_space_via_universe_during(
        &self,
        space_id: &str,
        universe_id: &str,
        share_token: Option<&str>,
        from: Timestamp,
        to: Timestamp,
    ) -> Result<Grant, ApiError> {
        if !is_space_id(space_id) {
            return Err(ApiError::not_found());
        }
        let universe = self.public_universe(universe_id, share_token).await?;
        let history = self.repo.universe_membership_history(&universe).await?;
        if !member_during(&history, space_id, from, Some(to)) {
            return Err(ApiError::not_found());
        }
        self.member_space_grant(space_id, &universe).await
    }

    /// 凭组合令牌读成员空间的某个版本（快照 `?seq=`）：这个版本生效的时间段
    /// `[at(seq), at(seq + 1))` 里该空间必须有某个时刻是组合成员。
    pub async fn public_space_via_universe_for_seq(
        &self,
        space_id: &str,
        universe_id: &str,
        share_token: Option<&str>,
        seq: u64,
    ) -> Result<Grant, ApiError> {
        if !is_space_id(space_id) {
            return Err(ApiError::not_found());
        }
        let universe = self.public_universe(universe_id, share_token).await?;
        let history = self.repo.universe_membership_history(&universe).await?;
        if !history
            .iter()
            .any(|(_, members)| members.iter().any(|m| m == space_id))
        {
            return Err(ApiError::not_found());
        }
        let grant = self.member_space_grant(space_id, &universe).await?;
        // 只用来读提交时间，不交给调用方。
        let (start, end) = self
            .repo
            .commit_window(&grant, seq)
            .await?
            .ok_or_else(ApiError::not_found)?;
        let end = end.map(|end| end.saturating_add_millis(-1));
        if !member_during(&history, space_id, start, end) {
            return Err(ApiError::not_found());
        }
        Ok(grant)
    }

    async fn member_space_grant(
        &self,
        space_id: &str,
        universe: &UniverseGrant,
    ) -> Result<Grant, ApiError> {
        let policy = self
            .repo
            .space_policy(&Self::key(), space_id)
            .await?
            .ok_or_else(ApiError::not_found)?;
        Ok(Grant {
            space_id: space_id.to_owned(),
            owner: policy.owner,
            access: GrantAccess::Public,
            public_basis: Some(match universe.public_basis {
                Some(PublicBasis::PublicVisibility) if policy.visibility == Visibility::Public => {
                    PublicBasis::PublicVisibility
                }
                _ => PublicBasis::ShareToken,
            }),
        })
    }

    /// 公开读空间，同时返回授权信息（`/head` 把它放进进程内缓存）。规则同 [`Authorizer::public_space`]。
    pub async fn public_space_with_policy(
        &self,
        space_id: &str,
        share_token: Option<&str>,
    ) -> Result<(Grant, crate::repo::SpacePolicy), ApiError> {
        if !is_space_id(space_id) {
            return Err(ApiError::not_found());
        }
        let policy = self
            .repo
            .space_policy(&Self::key(), space_id)
            .await?
            .ok_or_else(ApiError::not_found)?;
        let grant = Self::public_space_from_policy(space_id, &policy, share_token)?;
        Ok((grant, policy))
    }

    /// 组合在 T 时刻的修订，以及读取各成员空间公开数据的凭据（成员资格就是同意被凭组合
    /// 查看，设计 8.2、12）。T 之前没有修订时返回空。
    pub async fn universe_member_grants_at(
        &self,
        universe: &UniverseGrant,
        at: Timestamp,
    ) -> Result<(Option<metaverse_core::model::UniverseRevision>, Vec<Grant>), ApiError> {
        let Some(revision) = self.repo.universe_revision_at(universe, at).await? else {
            return Ok((None, Vec::new()));
        };
        let mut grants = Vec::with_capacity(revision.state.members.len());
        for member in &revision.state.members {
            let policy = self
                .repo
                .space_policy(&Self::key(), &member.space_id)
                .await?
                .ok_or_else(|| {
                    tracing::error!(universe = %universe.universe_id, space = %member.space_id, "组合成员空间不存在");
                    ApiError::internal()
                })?;
            grants.push(Grant {
                space_id: member.space_id.clone(),
                owner: policy.owner,
                access: GrantAccess::Public,
                public_basis: Some(PublicBasis::ShareToken),
            });
        }
        Ok((Some(revision), grants))
    }

    /// 用缓存的空间授权信息签发公开凭据（`/head` 的进程内缓存命中时用，令牌照样要校验）。
    pub fn public_space_from_policy(
        space_id: &str,
        policy: &crate::repo::SpacePolicy,
        share_token: Option<&str>,
    ) -> Result<Grant, ApiError> {
        let basis = if policy.visibility == Visibility::Public {
            PublicBasis::PublicVisibility
        } else if token_matches(&policy.share_tokens, share_token) {
            PublicBasis::ShareToken
        } else {
            return Err(ApiError::not_found());
        };
        Ok(Grant {
            space_id: space_id.to_owned(),
            owner: policy.owner.clone(),
            access: GrantAccess::Public,
            public_basis: Some(basis),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn membership_periods_follow_revisions() {
        let t = |s: i64| Timestamp::from_millis(s * 1000).unwrap();
        let history = vec![
            (t(10), vec!["a".to_owned()]),
            (t(20), vec!["a".to_owned(), "b".to_owned()]),
            (t(30), vec!["b".to_owned()]),
        ];
        // a 是 [10, 30) 的成员；b 是 [20, +∞) 的成员。
        assert!(member_during(&history, "a", t(29), Some(t(29))));
        assert!(!member_during(&history, "a", t(30), Some(t(40))));
        assert!(!member_during(&history, "a", t(0), Some(t(9))));
        assert!(member_during(&history, "a", t(0), Some(t(10))));
        assert!(member_during(&history, "b", t(100), None));
        assert!(!member_during(&history, "b", t(5), Some(t(19))));
        assert!(!member_during(&history, "c", t(0), None));
    }

    #[test]
    fn membership_at_a_moment_uses_the_last_revision_before_it() {
        let t = |s: i64| Timestamp::from_millis(s * 1000).unwrap();
        let history = vec![
            (t(10), vec!["a".to_owned()]),
            (t(20), vec!["a".to_owned(), "b".to_owned()]),
            (t(30), vec!["b".to_owned()]),
        ];
        assert!(!member_at(&history, "a", t(9)));
        assert!(member_at(&history, "a", t(10)));
        assert!(member_at(&history, "a", t(29)));
        assert!(!member_at(&history, "a", t(30)));
        assert!(member_at(&history, "b", t(1000)));
        assert!(!member_at(&history, "c", t(1000)));
        assert!(!member_at(&[], "a", t(1000)));
    }

    #[test]
    fn token_matching_ignores_revoked_and_malformed() {
        let token = "a".repeat(43);
        let record = |revoked: bool| ShareTokenRecord {
            id: "st_1".into(),
            hash: sha256_hex(token.as_bytes()),
            created_at: Timestamp::from_millis(0).unwrap(),
            revoked_at: revoked.then(|| Timestamp::from_millis(1).unwrap()),
        };
        assert!(token_matches(&[record(false)], Some(&token)));
        assert!(!token_matches(&[record(true)], Some(&token)));
        assert!(!token_matches(&[record(false)], Some("short")));
        assert!(!token_matches(&[record(false)], None));
        assert!(!token_matches(&[], Some(&token)));
    }
}
