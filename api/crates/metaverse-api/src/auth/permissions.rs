//! 把 NyxID 令牌里的 `permissions` 精确映射成一组固定的能力（设计 9.2 的功能级开关）。
//!
//! 参照 CMA `api/crates/cma/src/permissions.rs`：只认完整的 `metaverse:*` 权限字符串，
//! 不认角色名和用户组；未知字符串、前缀通配（包括字面上的 `metaverse:*`）一律不授予；
//! 不在本地维护管理员名单。
//!
//! 第一步默认不启用（`METAVERSE_REQUIRE_PERMISSIONS=false`）：需要平台级限制时，请平台
//! 管理员在 NyxID 建 `metaverse-user`、`metaverse-admin` 角色并分配下面的权限，再打开开关。
//!
//! 例外是重建权限 `metaverse:rebuild:write`（docs/design/server-slim.md 第 3 节）：重建路径上的写操作
//! **始终**要求它，不看上面的开关，也没有关掉它的配置（见 `Authorizer::require_rebuild_write`）。

use std::collections::BTreeSet;

/// 本服务认识的权限字符串。
pub mod permission {
    /// 创建空间（管理接口）。
    pub const SPACE_CREATE: &str = "metaverse:space:create";
    /// 草稿、批量操作、发布等内容写入。
    pub const CONTENT_WRITE: &str = "metaverse:content:write";
    /// 写现实事件。
    pub const EVENT_WRITE: &str = "metaverse:event:write";
    /// 创建和修改组合宇宙。
    pub const UNIVERSE_WRITE: &str = "metaverse:universe:write";
    /// 写重建层：重建路径（`/api/v1/spaces/{space_id}/rebuild/`）上的全部写操作，始终要求。
    pub const REBUILD_WRITE: &str = "metaverse:rebuild:write";
}

/// 固定的能力集合。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Capability {
    CreateSpaces,
    WriteContent,
    WriteEvents,
    WriteUniverses,
    /// 写重建层（始终生效，不受功能级开关影响）。
    WriteRebuild,
}

/// 一组能力。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Capabilities(BTreeSet<Capability>);

impl Capabilities {
    pub fn allows(&self, capability: Capability) -> bool {
        self.0.contains(&capability)
    }

    pub fn iter(&self) -> impl Iterator<Item = Capability> + '_ {
        self.0.iter().copied()
    }
}

/// 精确映射；不认识的权限什么也不授予。
pub fn capabilities_from_permissions<S: AsRef<str>>(
    permissions: impl IntoIterator<Item = S>,
) -> Capabilities {
    let mut granted = BTreeSet::new();
    for permission in permissions {
        match permission.as_ref() {
            permission::SPACE_CREATE => {
                granted.insert(Capability::CreateSpaces);
            }
            permission::CONTENT_WRITE => {
                granted.insert(Capability::WriteContent);
            }
            permission::EVENT_WRITE => {
                granted.insert(Capability::WriteEvents);
            }
            permission::UNIVERSE_WRITE => {
                granted.insert(Capability::WriteUniverses);
            }
            permission::REBUILD_WRITE => {
                granted.insert(Capability::WriteRebuild);
            }
            _ => {}
        }
    }
    Capabilities(granted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_strings_are_additive_and_unknown_names_deny() {
        let granted = capabilities_from_permissions([
            permission::SPACE_CREATE,
            permission::EVENT_WRITE,
            "other-product:admin",
            "metaverse:space:*",
        ]);
        assert!(granted.allows(Capability::CreateSpaces));
        assert!(granted.allows(Capability::WriteEvents));
        assert_eq!(granted.iter().count(), 2);
    }

    #[test]
    fn wildcards_and_near_misses_grant_nothing() {
        for permission in [
            "*",
            "metaverse:*",
            "metaverse:space",
            "metaverse:space:create ",
            " metaverse:space:create",
            "METAVERSE:SPACE:CREATE",
            "metaverse:spaces:create",
            "metaverse-admin",
            "metaverse:rebuild:*",
            "metaverse:rebuild",
            "metaverse-rebuilder",
        ] {
            assert_eq!(
                capabilities_from_permissions([permission]).iter().count(),
                0,
                "{permission:?}"
            );
        }
    }

    #[test]
    fn every_capability_has_exactly_one_permission() {
        let all = capabilities_from_permissions([
            permission::SPACE_CREATE,
            permission::CONTENT_WRITE,
            permission::EVENT_WRITE,
            permission::UNIVERSE_WRITE,
            permission::REBUILD_WRITE,
        ]);
        assert_eq!(all.iter().count(), 5);
        assert!(all.allows(Capability::WriteRebuild));
    }
}
