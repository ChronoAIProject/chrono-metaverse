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

/// 某个空间作为组合成员的时间段 `[start, end)`（`end` 为空表示至今），按修订历史计算：第 i 条
/// 修订从它的 `at` 起生效，到下一条修订的 `at` 为止。
///
/// 只算空间**这一次创建之后**开始的时间段：空间编号是全局的，删除后任何人都能重新注册；旧空间
/// 的成员资格（以及删除前没来得及写退出修订的旧数据）不能让新空间被凭别人的组合令牌读取——
/// 新空间的主人从来没有同意过（设计 8.2、12）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MembershipPeriods {
    periods: Vec<(Timestamp, Option<Timestamp>)>,
}

impl MembershipPeriods {
    /// 由修订历史（按 seq 排序的 `(at, 成员编号)`）算出 `space_id` 的成员期；`created_at` 之前
    /// 开始的时间段属于同编号的旧空间，丢掉。
    pub fn from_history(
        history: &[(Timestamp, Vec<String>)],
        space_id: &str,
        created_at: Option<Timestamp>,
    ) -> Self {
        let mut periods = Vec::new();
        let mut open: Option<Timestamp> = None;
        for (start, members) in history {
            let member = members.iter().any(|member| member == space_id);
            match (member, open) {
                (true, None) => open = Some(*start),
                (false, Some(begin)) => {
                    periods.push((begin, Some(*start)));
                    open = None;
                }
                _ => {}
            }
        }
        if let Some(begin) = open {
            periods.push((begin, None));
        }
        if let Some(created) = created_at {
            periods.retain(|(start, _)| *start >= created);
        }
        Self { periods }
    }

    /// 全部时间段（按开始时间排序，互不重叠）。
    pub fn periods(&self) -> &[(Timestamp, Option<Timestamp>)] {
        &self.periods
    }

    pub fn is_empty(&self) -> bool {
        self.periods.is_empty()
    }

    /// `at` 时刻是否是成员。
    pub fn contains(&self, at: Timestamp) -> bool {
        self.periods
            .iter()
            .any(|(start, end)| *start <= at && end.is_none_or(|end| at < end))
    }

    /// `[from, to]`（`to` 为空表示到以后）里是否有某个时刻是成员。
    pub fn overlaps(&self, from: Timestamp, to: Option<Timestamp>) -> bool {
        self.periods.iter().any(|(start, end)| {
            to.is_none_or(|to| *start <= to) && end.is_none_or(|end| end > from)
        })
    }

    /// 最后一个时间段的终点：现在仍是成员时为空。没有任何时间段时也为空。
    pub fn last_end(&self) -> Option<Timestamp> {
        self.periods.last().and_then(|(_, end)| *end)
    }
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

    /// 凭组合读成员空间的共同检查：空间存在；组合是因为"公开"（而不是凭令牌）才可读时，空间
    /// 本身也必须现在是公开的——组合是否公开只看当前成员，曾经的凭链接查看成员不能随着组合
    /// 改成公开而被任何人读到（设计 12"组合不能比任何成员更公开"）；空间这一次创建之后有成员期。
    async fn member_policy(
        &self,
        space_id: &str,
        universe: &UniverseGrant,
    ) -> Result<(crate::repo::SpacePolicy, MembershipPeriods), ApiError> {
        if !is_space_id(space_id) {
            return Err(ApiError::not_found());
        }
        let policy = self
            .repo
            .space_policy(&Self::key(), space_id)
            .await?
            .ok_or_else(ApiError::not_found)?;
        if universe.public_basis != Some(PublicBasis::ShareToken)
            && policy.visibility != Visibility::Public
        {
            return Err(ApiError::not_found());
        }
        let history = self.repo.universe_membership_history(universe).await?;
        let periods = MembershipPeriods::from_history(&history, space_id, policy.created_at);
        if periods.is_empty() {
            return Err(ApiError::not_found());
        }
        Ok((policy, periods))
    }

    /// 凭组合读成员空间的凭据：公开级、带成员期（读取方据此裁剪提交和事件）。凭令牌时和凭空间
    /// 自己的分享令牌一样不可共享缓存（`PublicBasis::ShareToken`）。
    fn member_grant(
        space_id: &str,
        policy: crate::repo::SpacePolicy,
        universe: &UniverseGrant,
        periods: MembershipPeriods,
    ) -> Grant {
        Grant {
            space_id: space_id.to_owned(),
            public_basis: Some(match universe.public_basis {
                Some(PublicBasis::PublicVisibility) if policy.visibility == Visibility::Public => {
                    PublicBasis::PublicVisibility
                }
                _ => PublicBasis::ShareToken,
            }),
            owner: policy.owner,
            access: GrantAccess::Public,
            membership: Some(periods),
        }
    }

    /// 凭组合的分享令牌读成员空间的公开数据（`Authorization: Share <组合令牌>` +
    /// `?universe=<组合编号>`）。要求该空间在 T 时刻是组合成员；否则 404。
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
        let (policy, periods) = self.member_policy(space_id, &universe).await?;
        if !periods.contains(at) {
            return Err(ApiError::not_found());
        }
        Ok(Self::member_grant(space_id, policy, &universe, periods))
    }

    /// 凭组合令牌读成员空间不按时刻索引的信息（空间信息）：要求该空间曾经是组合成员——组合页
    /// 回看历史时，后来离开组合的成员也要能取到名称和事件显示规则。返回凭据和"现在是否仍是
    /// 成员"（调用方据此去掉离开之后的当前内容）。
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
        let (policy, periods) = self.member_policy(space_id, &universe).await?;
        let epoch = Timestamp::from_millis(0).map_err(|_| ApiError::internal())?;
        if !periods.overlaps(epoch, Some(now)) {
            return Err(ApiError::not_found());
        }
        let current = periods.contains(now);
        Ok((
            Self::member_grant(space_id, policy, &universe, periods),
            current,
        ))
    }

    /// 凭组合令牌读成员空间在一段时间 `[from, to]` 里的公开数据（时间窗事件、密度、提交列表）：
    /// 要求该空间在这段时间里的某个时刻是组合成员。读取方还要按凭据里的成员期裁剪结果。
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
        let (policy, periods) = self.member_policy(space_id, &universe).await?;
        if !periods.overlaps(from, Some(to)) {
            return Err(ApiError::not_found());
        }
        Ok(Self::member_grant(space_id, policy, &universe, periods))
    }

    /// 凭组合令牌读成员空间的某个版本（快照 `?seq=`）：这个版本生效的时间段
    /// `[at(seq), at(seq + 1))` 里该空间必须有某个时刻是组合成员。seq = 0（还没有任何提交的
    /// 空状态）生效的时间段是 `[空间创建时间, at(1))`。
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
        let (policy, periods) = self.member_policy(space_id, &universe).await?;
        let created_at = policy.created_at;
        let grant = Self::member_grant(space_id, policy, &universe, periods);
        // 只用来读提交时间，不交给调用方。
        let (start, end) = if seq == 0 {
            let start = match created_at {
                Some(created) => created,
                None => Timestamp::from_millis(0).map_err(|_| ApiError::internal())?,
            };
            let end = self
                .repo
                .commit_window(&grant, 1)
                .await?
                .map(|(first, _)| first);
            (start, end)
        } else {
            self.repo
                .commit_window(&grant, seq)
                .await?
                .ok_or_else(ApiError::not_found)?
        };
        let end = end.map(|end| end.saturating_add_millis(-1));
        let covered = grant
            .membership
            .as_ref()
            .is_some_and(|periods| periods.overlaps(start, end));
        if !covered {
            return Err(ApiError::not_found());
        }
        Ok(grant)
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
    /// 查看，设计 8.2、12），与修订里的成员一一对应。T 之前没有修订时返回空。
    ///
    /// 某个成员没有凭据（`None`）时调用方当作它不在组合里：空间已经删除；或者同编号的空间是后来
    /// 重新创建的（新主人没有加入过）；或者组合是因为公开才可读、而这个成员现在不公开。
    pub async fn universe_member_grants_at(
        &self,
        universe: &UniverseGrant,
        at: Timestamp,
    ) -> Result<
        (
            Option<metaverse_core::model::UniverseRevision>,
            Vec<Option<Grant>>,
        ),
        ApiError,
    > {
        let Some(revision) = self.repo.universe_revision_at(universe, at).await? else {
            return Ok((None, Vec::new()));
        };
        let history = self.repo.universe_membership_history(universe).await?;
        let mut grants = Vec::with_capacity(revision.state.members.len());
        for member in &revision.state.members {
            let Some(policy) = self
                .repo
                .space_policy(&Self::key(), &member.space_id)
                .await?
            else {
                tracing::info!(universe = %universe.universe_id, space = %member.space_id, "组合成员空间已不存在，跳过");
                grants.push(None);
                continue;
            };
            let periods =
                MembershipPeriods::from_history(&history, &member.space_id, policy.created_at);
            if !periods.contains(at) {
                tracing::info!(universe = %universe.universe_id, space = %member.space_id, "组合成员空间是后来重新创建的，跳过");
                grants.push(None);
                continue;
            }
            if universe.public_basis == Some(PublicBasis::PublicVisibility)
                && policy.visibility != Visibility::Public
            {
                grants.push(None);
                continue;
            }
            grants.push(Some(Grant {
                space_id: member.space_id.clone(),
                owner: policy.owner,
                access: GrantAccess::Public,
                public_basis: Some(PublicBasis::ShareToken),
                membership: Some(periods),
            }));
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
            membership: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: i64) -> Timestamp {
        Timestamp::from_millis(s * 1000).unwrap()
    }

    fn history() -> Vec<(Timestamp, Vec<String>)> {
        vec![
            (t(10), vec!["a".to_owned()]),
            (t(20), vec!["a".to_owned(), "b".to_owned()]),
            (t(30), vec!["b".to_owned()]),
            (t(40), vec!["a".to_owned(), "b".to_owned()]),
        ]
    }

    #[test]
    fn membership_periods_follow_revisions() {
        let history = history();
        let a = MembershipPeriods::from_history(&history, "a", None);
        // a 是 [10, 30) 和 [40, +∞) 的成员；b 是 [20, +∞) 的成员。
        assert_eq!(a.periods(), &[(t(10), Some(t(30))), (t(40), None)][..]);
        assert!(a.overlaps(t(29), Some(t(29))));
        assert!(!a.overlaps(t(30), Some(t(39))));
        assert!(a.overlaps(t(30), Some(t(40))));
        assert!(!a.overlaps(t(0), Some(t(9))));
        assert!(a.overlaps(t(0), Some(t(10))));
        let b = MembershipPeriods::from_history(&history, "b", None);
        assert!(b.overlaps(t(100), None));
        assert!(!b.overlaps(t(5), Some(t(19))));
        assert!(MembershipPeriods::from_history(&history, "c", None).is_empty());
        assert_eq!(a.last_end(), None);
        let only_first = MembershipPeriods::from_history(&history[..3], "a", None);
        assert_eq!(only_first.last_end(), Some(t(30)));
    }

    #[test]
    fn membership_at_a_moment_uses_the_last_revision_before_it() {
        let history = history();
        let a = MembershipPeriods::from_history(&history, "a", None);
        assert!(!a.contains(t(9)));
        assert!(a.contains(t(10)));
        assert!(a.contains(t(29)));
        assert!(!a.contains(t(30)));
        assert!(a.contains(t(40)));
        let b = MembershipPeriods::from_history(&history, "b", None);
        assert!(b.contains(t(1000)));
        assert!(!MembershipPeriods::from_history(&history, "c", None).contains(t(1000)));
        assert!(!MembershipPeriods::from_history(&[], "a", None).contains(t(1000)));
    }

    #[test]
    fn recreated_space_does_not_inherit_old_membership() {
        // 空间 a 在 10 加入、删除时没有写退出修订；同编号的新空间在 35 创建：
        // 旧的 [10, 30) 不算，40 之后重新加入的才算。
        let history = history();
        let a = MembershipPeriods::from_history(&history, "a", Some(t(35)));
        assert_eq!(a.periods(), &[(t(40), None)][..]);
        assert!(!a.contains(t(20)));
        assert!(a.contains(t(41)));
        // 新空间在最后一次加入之后才创建：没有任何成员期。
        let late = MembershipPeriods::from_history(&history, "a", Some(t(45)));
        assert!(late.is_empty());
        assert!(!late.contains(t(1000)));
        // 创建时间恰好等于加入时间：算。
        let same = MembershipPeriods::from_history(&history, "b", Some(t(20)));
        assert!(same.contains(t(20)));
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
