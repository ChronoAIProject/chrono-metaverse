//! 系统范围（设计 9.4："后台任务和管理用途使用显式的系统范围，并且必须写审计"）。
//!
//! 接口服务自己做的后台写入（例如公开读时顺带保存的状态快照）不属于调用者的权限，
//! 所以不用调用者的凭据写，而是由已有凭据派生一个只针对同一空间、写明用途的
//! [`SystemGrant`]；每次派生都写一条审计日志（`target = "audit"`）。
//!
//! 部署配置种子（`crate::demo_seed`）也在这里拿凭据：建空间的 [`CreateGrant`]（归属证据的依据是
//! `operator_seed`）和已有种子空间的"管理"凭据，同样每次都写审计日志。

use metaverse_core::model::{
    EvidenceBasis, Owner, OwnerEvidence, OwnerKind, OPERATOR_SEED_SUBJECT,
};
use metaverse_core::Timestamp;

use super::{Authorizer, CreateGrant, Grant, GrantAccess};
use crate::error::ApiError;

/// 部署配置种子看到的空间状态。
#[derive(Debug)]
pub enum SeedSpace {
    /// 空间不存在。
    Missing,
    /// 空间是部署配置种子为同一个组织建的（`operator_seed` 证据、主人一致）：可以接着做
    /// （补登记扫描资源、补建导入任务）。
    Seeded(Grant),
    /// 空间存在，但不是部署配置种子建的，或主人与配置不同：种子什么都不做。
    Foreign,
}

/// 后台用途的授权凭据：空间编号、主人、用途。只有授权层能构造。
#[derive(Debug, Clone)]
pub struct SystemGrant {
    space_id: String,
    owner: Owner,
    purpose: &'static str,
}

impl SystemGrant {
    pub fn space_id(&self) -> &str {
        &self.space_id
    }

    pub fn owner(&self) -> &Owner {
        &self.owner
    }

    pub fn purpose(&self) -> &'static str {
        self.purpose
    }
}

/// 后台执行器、定期清理、后台迁移用的跨空间凭据（docs/design/server-slim.md 4.2、第 5 节）：
/// 领取任务、找过期的上传和草稿、找没人引用的资源都要跨空间查，数据访问层只对这些专门的方法
/// 接受它。具体到某个空间的读写仍要另外签发那个空间的系统范围（[`Authorizer::system_space`]）。
/// 只有授权层能构造，每次签发写审计日志。
#[derive(Debug, Clone)]
pub struct BackgroundGrant {
    purpose: &'static str,
}

impl BackgroundGrant {
    pub fn purpose(&self) -> &'static str {
        self.purpose
    }
}

impl Authorizer {
    /// 签发后台用途的跨空间凭据（`runner`、`cleanup`、`migration`），写审计日志。
    pub fn background(&self, purpose: &'static str) -> BackgroundGrant {
        tracing::info!(target: "audit", purpose, "签发后台用途的跨空间凭据");
        BackgroundGrant { purpose }
    }

    /// 由一个已经通过检查的凭据派生同一空间的系统范围，并写审计日志。
    pub fn system_scope(grant: &Grant, purpose: &'static str) -> SystemGrant {
        tracing::info!(
            target: "audit",
            space = %grant.space_id,
            owner = %grant.owner.id,
            purpose,
            "使用系统范围"
        );
        SystemGrant {
            space_id: grant.space_id.clone(),
            owner: grant.owner.clone(),
            purpose,
        }
    }
}

impl Authorizer {
    /// 部署配置种子建空间的凭据（设计 9.2"部署配置种子是运维行为"）：主人只能是配置里写的组织，
    /// 归属证据的依据是 `operator_seed`、核验人是 [`OPERATOR_SEED_SUBJECT`]。写审计日志。
    pub fn seed_create_grant(
        &self,
        owner: &Owner,
        reference: &str,
        now: Timestamp,
    ) -> Result<CreateGrant, ApiError> {
        if owner.kind != OwnerKind::Org || !owner.is_valid() {
            return Err(ApiError::invalid(
                "部署配置种子的主人必须是组织（NyxID 规范编号）",
            ));
        }
        tracing::info!(
            target: "audit",
            owner = %owner.id,
            purpose = "demo_seed",
            reference,
            "签发部署配置种子的建空间凭据"
        );
        Ok(CreateGrant {
            owner: owner.clone(),
            evidence: Some(OwnerEvidence {
                issuer: self.issuer.clone(),
                org_id: owner.id.clone(),
                verified_by: OPERATOR_SEED_SUBJECT.to_owned(),
                verified_at: now,
                basis: EvidenceBasis::OperatorSeed,
                role_at_verification: None,
            }),
        })
    }

    /// 部署配置种子查看空间：不存在、是种子为同一组织建的（签发"管理"凭据并写审计日志）、
    /// 或是别人的空间（种子不碰）。
    pub async fn seed_space(
        &self,
        space_id: &str,
        owner: &Owner,
        reference: &str,
    ) -> Result<SeedSpace, ApiError> {
        let Some(policy) = self.repo.space_policy(&Self::key(), space_id).await? else {
            return Ok(SeedSpace::Missing);
        };
        let seeded = &policy.owner == owner
            && policy.owner_evidence.as_ref().is_some_and(|evidence| {
                evidence.basis == EvidenceBasis::OperatorSeed
                    && evidence.org_id == owner.id
                    && evidence.verified_by == OPERATOR_SEED_SUBJECT
            });
        if !seeded {
            tracing::warn!(
                target: "audit",
                space = %space_id,
                purpose = "demo_seed",
                reference,
                "空间已存在且不是部署配置种子为这个组织建的，种子不处理"
            );
            return Ok(SeedSpace::Foreign);
        }
        tracing::info!(
            target: "audit",
            space = %space_id,
            owner = %policy.owner.id,
            purpose = "demo_seed",
            reference,
            "签发系统范围"
        );
        Ok(SeedSpace::Seeded(Grant {
            space_id: space_id.to_owned(),
            owner: policy.owner,
            access: GrantAccess::Manage,
            public_basis: None,
            membership: None,
        }))
    }
}
