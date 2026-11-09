//! 访问级别（设计 9.2 的表格），写成代码常量并配测试矩阵
//! （参照 CMA `layer2-core/src/resource_access/tests.rs`）。
//!
//! | 调用者 | 个人空间 | 组织空间 |
//! |---|---|---|
//! | 主人本人 | 管理 | — |
//! | 组织本身（令牌 sub 就是组织） | — | 管理 |
//! | 组织 admin | — | 管理（等同主人） |
//! | 组织 member / viewer | — | 只读（含内部级数据） |
//! | 其他人 | 无 | 无 |
//!
//! 以后需要成员也能写，只改 [`ORG_ROLE_ACCESS`]。

use metaverse_core::model::{OrgRole, Owner, OwnerKind};

/// 访问级别，按从低到高排序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AccessLevel {
    /// 看不到：返回 404，不暴露资源是否存在。
    None,
    /// 只读（含内部级数据）。
    Read,
    /// 管理：写入、`/api/v1/admin` 下的接口、删除空间、轮换分享令牌。
    Manage,
}

/// 组织角色 → 访问级别。
pub const ORG_ROLE_ACCESS: [(OrgRole, AccessLevel); 3] = [
    (OrgRole::Admin, AccessLevel::Manage),
    (OrgRole::Member, AccessLevel::Read),
    (OrgRole::Viewer, AccessLevel::Read),
];

pub fn level_for_role(role: OrgRole) -> AccessLevel {
    ORG_ROLE_ACCESS
        .iter()
        .find(|(candidate, _)| *candidate == role)
        .map_or(AccessLevel::None, |(_, level)| *level)
}

/// 不需要查组织角色就能确定的访问级别：主人本人、组织本身。
/// 返回 `None` 表示还要按组织角色判断。
pub fn direct_access(owner: &Owner, subject: &str) -> Option<AccessLevel> {
    match owner.kind {
        OwnerKind::Person if owner.id == subject => Some(AccessLevel::Manage),
        OwnerKind::Person => Some(AccessLevel::None),
        OwnerKind::Org if owner.id == subject => Some(AccessLevel::Manage),
        OwnerKind::Org => None,
    }
}

/// 完整的判断：`role` 是查到的组织角色（不是成员时为 `None`）。
pub fn access_level(owner: &Owner, subject: &str, role: Option<OrgRole>) -> AccessLevel {
    direct_access(owner, subject).unwrap_or_else(|| role.map_or(AccessLevel::None, level_for_role))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrix() {
        let person = Owner::person("alice");
        let org = Owner::org("org-1");
        let cases = [
            // (主人, 调用者, 组织角色, 期望)
            (&person, "alice", None, AccessLevel::Manage),
            (&person, "alice", Some(OrgRole::Viewer), AccessLevel::Manage),
            (&person, "bob", None, AccessLevel::None),
            // 个人空间不看组织角色。
            (&person, "bob", Some(OrgRole::Admin), AccessLevel::None),
            (&person, "org-1", Some(OrgRole::Admin), AccessLevel::None),
            (&org, "org-1", None, AccessLevel::Manage),
            (&org, "alice", Some(OrgRole::Admin), AccessLevel::Manage),
            (&org, "alice", Some(OrgRole::Member), AccessLevel::Read),
            (&org, "alice", Some(OrgRole::Viewer), AccessLevel::Read),
            (&org, "alice", None, AccessLevel::None),
        ];
        for (owner, subject, role, expected) in cases {
            assert_eq!(
                access_level(owner, subject, role),
                expected,
                "{owner:?} {subject} {role:?}"
            );
        }
    }

    #[test]
    fn direct_access_needs_no_lookup_only_for_owner_or_org_itself() {
        assert_eq!(
            direct_access(&Owner::org("org-1"), "org-1"),
            Some(AccessLevel::Manage)
        );
        assert_eq!(direct_access(&Owner::org("org-1"), "alice"), None);
        assert_eq!(
            direct_access(&Owner::person("alice"), "bob"),
            Some(AccessLevel::None)
        );
        assert!(AccessLevel::Manage > AccessLevel::Read && AccessLevel::Read > AccessLevel::None);
    }
}
