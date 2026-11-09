//! 系统范围（设计 9.4："后台任务和管理用途使用显式的系统范围，并且必须写审计"）。
//!
//! 接口服务自己做的后台写入（例如公开读时顺带保存的状态快照）不属于调用者的权限，
//! 所以不用调用者的凭据写，而是由已有凭据派生一个只针对同一空间、写明用途的
//! [`SystemGrant`]；每次派生都写一条审计日志（`target = "audit"`）。

use metaverse_core::model::Owner;

use super::{Authorizer, Grant};

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

impl Authorizer {
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
