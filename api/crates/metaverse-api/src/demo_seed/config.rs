//! 部署配置种子的配置：`METAVERSE_DEMO_SEED`（JSON）、`METAVERSE_DEMO_SHARE_TOKEN`（分享令牌原文）和
//! `METAVERSE_DEMO_SEED_HOSTS`（允许下载的主机，见 [`super::hosts`]）。格式见
//! docs/design/server-slim.md 7.1：
//!
//! ```json
//! {"spaceId": "chronoai-lobby", "name": "ChronoAI 前厅", "description": "…",
//!  "owner": {"kind": "org", "id": "<组织编号>"}, "visibility": "unlisted", "revision": 4,
//!  "bundle": {"manifest": {"url": "https://…/manifest.json", "sha256": "…", "size": 312345},
//!             "sources":  {"url": "https://…/sources.json",  "sha256": "…", "size": 4567}}}
//! ```
//!
//! - 解析严格：拒绝未知字段；空间编号、名称、说明按建空间接口的规则校验；清单和来源表的地址必须在
//!   主机列表里，sha256 是 64 位小写十六进制，清单不超过重建包清单的上传上限，来源表不超过 1 MiB；
//! - `bundle` 可选：不给时种子只保证空间存在（建空间、写第一次提交），不导入任何内容；
//! - **旧格式**（出现 `files`、`rebuild`、`voxelize`、`hints`、`authored`、`observedAt`，处理服务下线前的
//!   写法）：记错误日志、跳过种子，接口服务照常启动（部署前由 `infra/chrono-cd/check-app.mjs` 拦住）；
//! - 其他不合法的配置与别的配置项一样让接口服务启动失败（见 `config.rs`）。
//!
//! 分享令牌原文只用来算哈希：`Debug` 不输出内容、释放时清零，错误信息里也不出现它。

use std::fmt;

use metaverse_core::ids::is_subject_id;
use metaverse_core::is_sha256_hex;
use metaverse_core::model::{Owner, OwnerKind, Visibility};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

use super::hosts::{HostList, HOSTS_ENV};
use super::sources::MAX_SOURCES_BYTES;
use crate::config::ConfigError;
use crate::routes::admin_spaces::NewSpace;

/// 种子配置的环境变量。
pub const SEED_ENV: &str = "METAVERSE_DEMO_SEED";
/// 分享令牌原文的环境变量（chrono-cd 里作为应用密钥注入）。
pub const SHARE_TOKEN_ENV: &str = "METAVERSE_DEMO_SHARE_TOKEN";
/// 旧格式（处理服务下线前）的字段：出现任何一个就记错误日志、跳过种子。
pub const LEGACY_KEYS: [&str; 6] = [
    "files",
    "rebuild",
    "voxelize",
    "hints",
    "authored",
    "observedAt",
];
/// 分享令牌原文的长度范围（base64url；32 个字符约 192 位随机数）。
pub const MIN_SHARE_TOKEN_CHARS: usize = 32;
pub const MAX_SHARE_TOKEN_CHARS: usize = 256;

/// 分享令牌原文。只在内存里，`Debug` 不输出内容，释放时清零。
#[derive(Clone, PartialEq, Eq)]
pub struct SeedShareToken(Zeroizing<String>);

impl fmt::Debug for SeedShareToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SeedShareToken(<redacted>)")
    }
}

impl SeedShareToken {
    /// 令牌的 sha256（十六进制），库里只存它。
    pub fn hash(&self) -> String {
        metaverse_core::sha256_hex(self.0.as_bytes())
    }

    /// 原文（只在拼演示链接、测试时用；不要写日志）。
    pub fn expose(&self) -> &str {
        &self.0
    }
}

/// 按地址、sha256、大小固定的一份小文件（清单、来源表）。也是 `bundle_import` 任务参数里的写法。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pinned {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

impl Pinned {
    /// 解析好的地址（配置读入时已经核对过能解析）。
    pub fn parsed_url(&self) -> Result<url::Url, String> {
        url::Url::parse(&self.url).map_err(|error| format!("地址不合法：{error}"))
    }
}

/// 要导入的重建包：清单和来源表。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeedBundle {
    pub manifest: Pinned,
    pub sources: Pinned,
}

/// 解析好的种子配置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DemoSeedConfig {
    pub space_id: String,
    pub name: String,
    pub description: String,
    pub owner: Owner,
    pub visibility: Visibility,
    /// 导入版本：改大以后重启接口服务，会对同一个空间再导入一次（见 `demo_seed` 模块说明）。
    pub revision: u32,
    /// 要导入的重建包；没有时只保证空间存在。
    pub bundle: Option<SeedBundle>,
    pub share_token: Option<SeedShareToken>,
    /// 允许下载的主机（`METAVERSE_DEMO_SEED_HOSTS`）。
    pub hosts: HostList,
    /// 清单的大小上限（重建包清单的上传上限 `UPLOAD_MAX_BUNDLE_BYTES`）。
    pub max_manifest_bytes: u64,
}

impl DemoSeedConfig {
    /// 新空间的内容（与建空间接口相同的校验）。
    pub(crate) fn new_space(&self) -> NewSpace {
        NewSpace {
            id: self.space_id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            visibility: self.visibility,
        }
    }

    /// 审计日志里引用这次种子的方式：`<空间编号>@<版本>`。
    pub fn reference(&self) -> String {
        format!("{}@{}", self.space_id, self.revision)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawSeed {
    space_id: String,
    name: String,
    #[serde(default)]
    description: String,
    owner: RawOwner,
    #[serde(default)]
    visibility: Visibility,
    #[serde(default = "default_revision")]
    revision: u32,
    #[serde(default)]
    bundle: Option<SeedBundle>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawOwner {
    kind: OwnerKind,
    id: String,
}

fn default_revision() -> u32 {
    1
}

fn invalid(reason: impl Into<String>) -> ConfigError {
    ConfigError::Invalid(SEED_ENV, reason.into())
}

fn parse_share_token(raw: Option<String>) -> Result<Option<SeedShareToken>, ConfigError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let token = SeedShareToken(Zeroizing::new(raw));
    let length = token.0.len();
    if !(MIN_SHARE_TOKEN_CHARS..=MAX_SHARE_TOKEN_CHARS).contains(&length)
        || !token
            .0
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        // 不把值写进错误信息。
        return Err(ConfigError::Invalid(
            SHARE_TOKEN_ENV,
            format!(
                "必须是 {MIN_SHARE_TOKEN_CHARS}–{MAX_SHARE_TOKEN_CHARS} 个 base64url 字符（A–Z、a–z、0–9、-、_），例如 openssl rand -base64 32 | tr '+/' '-_' | tr -d '='"
            ),
        ));
    }
    Ok(Some(token))
}

/// 一份固定文件（清单或来源表）的规则：地址在主机列表里，sha256 合法，大小在 1–`max` 之间。
fn check_pinned(
    what: &str,
    pinned: &Pinned,
    hosts: &HostList,
    max: u64,
) -> Result<(), ConfigError> {
    let url = pinned
        .parsed_url()
        .map_err(|reason| invalid(format!("bundle.{what}.url {reason}")))?;
    if !hosts.allows(&url) {
        return Err(invalid(format!(
            "bundle.{what}.url 的主机 {} 不在 {HOSTS_ENV} 里（只用 https，本机测试可用 http://127.0.0.1:<端口>，不带用户名、密码和片段）",
            super::hosts::host_of(&url)
        )));
    }
    if !is_sha256_hex(&pinned.sha256) {
        return Err(invalid(format!(
            "bundle.{what}.sha256 必须是 64 位小写十六进制"
        )));
    }
    if pinned.size == 0 || pinned.size > max {
        return Err(invalid(format!(
            "bundle.{what}.size 必须在 1–{max} 字节之间"
        )));
    }
    Ok(())
}

impl DemoSeedConfig {
    /// 读配置。没设 `METAVERSE_DEMO_SEED`（或是旧格式，记错误日志）时返回 `None`（什么都不做）。
    /// `max_manifest_bytes` 是重建包清单的上传上限（`UPLOAD_MAX_BUNDLE_BYTES`）。
    pub fn from_lookup(
        lookup: &dyn Fn(&str) -> Option<String>,
        max_manifest_bytes: u64,
    ) -> Result<Option<Self>, ConfigError> {
        let optional = |name: &str| {
            lookup(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        // 主机列表在种子之外也要合法（后台执行器做 bundle_import 时用同一份）。
        let hosts = HostList::from_lookup(lookup)?;
        // 没有种子时令牌用不上，也不检查（不能因为一个用不上的密钥启动失败）。
        let Some(text) = optional(SEED_ENV) else {
            return Ok(None);
        };
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| invalid(format!("不是合法的种子配置 JSON：{error}")))?;
        if let Some(object) = value.as_object() {
            let legacy: Vec<&str> = LEGACY_KEYS
                .iter()
                .copied()
                .filter(|key| object.contains_key(*key))
                .collect();
            if !legacy.is_empty() {
                tracing::error!(
                    fields = ?legacy,
                    "部署配置种子是旧格式（{}），旧格式的种子要处理服务，已不支持，改成 bundle（docs/design/server-slim.md 7.1）；跳过种子，服务照常启动",
                    legacy.join("、")
                );
                return Ok(None);
            }
        }
        let token = parse_share_token(optional(SHARE_TOKEN_ENV))?;
        let raw: RawSeed = serde_json::from_value(value)
            .map_err(|error| invalid(format!("不是合法的种子配置：{error}")))?;
        Self::from_raw(raw, token, hosts, max_manifest_bytes).map(Some)
    }

    fn from_raw(
        raw: RawSeed,
        share_token: Option<SeedShareToken>,
        hosts: HostList,
        max_manifest_bytes: u64,
    ) -> Result<Self, ConfigError> {
        if raw.owner.kind != OwnerKind::Org || !is_subject_id(&raw.owner.id) {
            return Err(invalid(
                "owner 必须是 {\"kind\": \"org\", \"id\": <NyxID 组织的规范编号>}",
            ));
        }
        if raw.revision == 0 {
            return Err(invalid("revision 从 1 开始"));
        }
        if let Some(bundle) = &raw.bundle {
            if hosts.is_empty() {
                return Err(invalid(format!(
                    "带 bundle 时必须设置 {HOSTS_ENV}（允许下载的主机，逗号分隔）"
                )));
            }
            check_pinned("manifest", &bundle.manifest, &hosts, max_manifest_bytes)?;
            check_pinned("sources", &bundle.sources, &hosts, MAX_SOURCES_BYTES)?;
        }
        match (raw.visibility, &share_token) {
            (Visibility::Unlisted, None) => {
                return Err(invalid(format!(
                    "visibility 是 unlisted（凭分享令牌查看）时必须设置 {SHARE_TOKEN_ENV}"
                )))
            }
            (Visibility::Unlisted, Some(_)) | (Visibility::Public, _) => {}
        }
        let seed = Self {
            space_id: raw.space_id,
            name: raw.name,
            description: raw.description,
            owner: Owner::org(raw.owner.id),
            visibility: raw.visibility,
            revision: raw.revision,
            bundle: raw.bundle,
            share_token,
            hosts,
            max_manifest_bytes,
        };
        seed.new_space()
            .validate()
            .map_err(|error| invalid(error.detail.into_owned()))?;
        Ok(seed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    const TOKEN: &str = "seedtoken_0123456789abcdefghijklmnopqrstuvwxyzABC";
    const ORG: &str = "52aa284c-b5b2-49bd-9d12-79f24772dbd7";
    const HOSTS: &str = "raw.githubusercontent.com,github.com,scaniverse.com";
    const MAX_MANIFEST: u64 = 16 << 20;

    fn pinned(path: &str, byte: char, size: u64) -> Value {
        json!({"url": format!("https://raw.githubusercontent.com/o/r/{}/infra/chrono-cd/demo/lobby-r4/{path}", "0".repeat(40)),
               "sha256": byte.to_string().repeat(64), "size": size})
    }

    fn seed() -> Value {
        json!({
            "spaceId": "chronoai-lobby",
            "name": "ChronoAI 前厅",
            "description": "演示",
            "owner": {"kind": "org", "id": ORG},
            "visibility": "unlisted",
            "revision": 4,
            "bundle": {"manifest": pinned("manifest.json", 'a', 312_345),
                       "sources": pinned("sources.json", 'b', 4567)}
        })
    }

    fn load_with(
        seed: &Value,
        token: Option<&str>,
        hosts: Option<&str>,
    ) -> Result<Option<DemoSeedConfig>, ConfigError> {
        let mut values = BTreeMap::new();
        values.insert(SEED_ENV, seed.to_string());
        if let Some(token) = token {
            values.insert(SHARE_TOKEN_ENV, token.to_owned());
        }
        if let Some(hosts) = hosts {
            values.insert(HOSTS_ENV, hosts.to_owned());
        }
        DemoSeedConfig::from_lookup(&|name| values.get(name).cloned(), MAX_MANIFEST)
    }

    fn load(seed: &Value, token: Option<&str>) -> Result<Option<DemoSeedConfig>, ConfigError> {
        load_with(seed, token, Some(HOSTS))
    }

    fn reason(result: Result<Option<DemoSeedConfig>, ConfigError>) -> String {
        match result {
            Err(ConfigError::Invalid(_, reason)) => reason,
            other => panic!("应当拒绝，实际 {other:?}"),
        }
    }

    #[test]
    fn parses_the_documented_shape() {
        let config = load(&seed(), Some(TOKEN)).unwrap().unwrap();
        assert_eq!(config.space_id, "chronoai-lobby");
        assert_eq!(config.owner, Owner::org(ORG));
        assert_eq!(config.visibility, Visibility::Unlisted);
        assert_eq!(config.revision, 4);
        let bundle = config.bundle.as_ref().unwrap();
        assert_eq!(bundle.manifest.size, 312_345);
        assert_eq!(bundle.sources.sha256, "b".repeat(64));
        assert_eq!(config.reference(), "chronoai-lobby@4");
        assert_eq!(
            config.share_token.as_ref().unwrap().hash(),
            metaverse_core::sha256_hex(TOKEN.as_bytes())
        );
        // 没有 bundle：只保证空间存在；版本默认 1；不要求主机列表。
        let mut bare = seed();
        bare.as_object_mut().unwrap().remove("bundle");
        bare.as_object_mut().unwrap().remove("revision");
        let config = load_with(&bare, Some(TOKEN), None).unwrap().unwrap();
        assert!(config.bundle.is_none());
        assert_eq!(config.revision, 1);
    }

    #[test]
    fn absent_seed_does_nothing() {
        let values: BTreeMap<&str, String> = BTreeMap::new();
        assert_eq!(
            DemoSeedConfig::from_lookup(&|name| values.get(name).cloned(), MAX_MANIFEST),
            Ok(None)
        );
        let blank = BTreeMap::from([(SEED_ENV, "  ".to_owned())]);
        assert_eq!(
            DemoSeedConfig::from_lookup(&|name| blank.get(name).cloned(), MAX_MANIFEST),
            Ok(None)
        );
        // 没有种子时，令牌即使格式不对也不检查。
        let stray = BTreeMap::from([(SHARE_TOKEN_ENV, "short".to_owned())]);
        assert_eq!(
            DemoSeedConfig::from_lookup(&|name| stray.get(name).cloned(), MAX_MANIFEST),
            Ok(None)
        );
        // 主机列表本身不合法：照样报错（执行器也用它）。
        let hosts = BTreeMap::from([(HOSTS_ENV, "https://x.example/".to_owned())]);
        assert!(matches!(
            DemoSeedConfig::from_lookup(&|name| hosts.get(name).cloned(), MAX_MANIFEST),
            Err(ConfigError::Invalid(HOSTS_ENV, _))
        ));
    }

    #[test]
    fn legacy_format_is_skipped_not_fatal() {
        for key in LEGACY_KEYS {
            let mut value = seed();
            value[key] = json!(true);
            assert_eq!(load(&value, Some(TOKEN)), Ok(None), "{key}");
        }
        // 线上第 1–3 版的写法（files + authored + hints）：跳过。
        let old = json!({"spaceId": "chronoai-lobby", "name": "前厅", "owner": {"kind": "org", "id": ORG},
                         "files": [{"url": "https://scaniverse.com/x/mesh.drc", "name": "mesh.drc",
                                    "sha256": "a".repeat(64), "size": 10}],
                         "rebuild": true, "revision": 3});
        assert_eq!(load(&old, Some(TOKEN)), Ok(None));
    }

    #[test]
    fn rejects_unknown_fields_everywhere() {
        let mut top = seed();
        top["extra"] = json!(1);
        assert!(reason(load(&top, Some(TOKEN))).contains("extra"));
        let mut owner = seed();
        owner["owner"]["slug"] = json!("chronoai");
        assert!(reason(load(&owner, Some(TOKEN))).contains("slug"));
        let mut bundle = seed();
        bundle["bundle"]["zip"] = json!([]);
        assert!(reason(load(&bundle, Some(TOKEN))).contains("zip"));
        let mut file = seed();
        file["bundle"]["manifest"]["name"] = json!("x");
        assert!(reason(load(&file, Some(TOKEN))).contains("name"));
    }

    #[test]
    fn bundle_files_are_pinned_and_hosts_listed() {
        // 主机不在列表、http、带密码、片段：拒绝。
        for (url, ok) in [
            (
                "https://raw.githubusercontent.com/o/r/x/manifest.json",
                true,
            ),
            ("https://evil.example/manifest.json", false),
            ("http://raw.githubusercontent.com/manifest.json", false),
            ("https://u:p@raw.githubusercontent.com/manifest.json", false),
            ("https://raw.githubusercontent.com/manifest.json#x", false),
        ] {
            let mut value = seed();
            value["bundle"]["manifest"]["url"] = json!(url);
            assert_eq!(load(&value, Some(TOKEN)).is_ok(), ok, "{url}");
        }
        // 本机测试：列表里写出带端口的本机地址。
        let mut local = seed();
        local["bundle"]["manifest"]["url"] = json!("http://127.0.0.1:9000/manifest.json");
        local["bundle"]["sources"]["url"] = json!("http://127.0.0.1:9000/sources.json");
        assert!(load_with(&local, Some(TOKEN), Some("127.0.0.1:9000")).is_ok());
        assert!(load_with(&local, Some(TOKEN), Some("127.0.0.1")).is_err());
        // 带 bundle 却没有主机列表。
        assert!(reason(load_with(&seed(), Some(TOKEN), None)).contains(HOSTS_ENV));
        type Edit = Box<dyn Fn(&mut Value)>;
        let cases: Vec<(&str, Edit)> = vec![
            (
                "sha256",
                Box::new(|v| v["bundle"]["manifest"]["sha256"] = json!("A".repeat(64))),
            ),
            (
                "size",
                Box::new(|v| v["bundle"]["manifest"]["size"] = json!(0)),
            ),
            (
                "size",
                Box::new(|v| v["bundle"]["manifest"]["size"] = json!(MAX_MANIFEST + 1)),
            ),
            (
                "size",
                Box::new(|v| v["bundle"]["sources"]["size"] = json!(MAX_SOURCES_BYTES + 1)),
            ),
            (
                "种子配置",
                Box::new(|v| {
                    v["bundle"].as_object_mut().unwrap().remove("sources");
                }),
            ),
        ];
        for (expected, edit) in cases {
            let mut value = seed();
            edit(&mut value);
            let reason = reason(load(&value, Some(TOKEN)));
            assert!(reason.contains(expected), "{expected}: {reason}");
        }
    }

    #[test]
    fn space_fields_follow_create_space_rules() {
        let mut value = seed();
        value["spaceId"] = json!("Chronoai_Lobby");
        assert!(reason(load(&value, Some(TOKEN))).contains("id 必须是"));
        let mut value = seed();
        value["name"] = json!("  ");
        assert!(reason(load(&value, Some(TOKEN))).contains("name"));
        let mut value = seed();
        value["description"] = json!("x".repeat(2001));
        assert!(reason(load(&value, Some(TOKEN))).contains("description"));
        let mut value = seed();
        value["owner"] = json!({"kind": "person", "id": "alice"});
        assert!(reason(load(&value, Some(TOKEN))).contains("owner"));
        let mut value = seed();
        value["owner"]["id"] = json!("chronoai/org");
        assert!(reason(load(&value, Some(TOKEN))).contains("owner"));
        let mut value = seed();
        value["revision"] = json!(0);
        assert!(reason(load(&value, Some(TOKEN))).contains("revision"));
    }

    #[test]
    fn share_token_rules_and_redaction() {
        // 凭链接查看必须有令牌；公开空间不需要。
        assert!(reason(load(&seed(), None)).contains(SHARE_TOKEN_ENV));
        let mut public = seed();
        public["visibility"] = json!("public");
        let config = load(&public, None).unwrap().unwrap();
        assert!(config.share_token.is_none());
        // 令牌格式不对：错误信息里没有令牌原文。
        for bad in [
            "short",
            "has space in it but is long enough 0123",
            "加密令牌加密令牌加密令牌加密令牌加密令牌加密令牌",
        ] {
            match load(&seed(), Some(bad)) {
                Err(ConfigError::Invalid(name, reason)) => {
                    assert_eq!(name, SHARE_TOKEN_ENV);
                    assert!(!reason.contains(bad));
                }
                other => panic!("应当拒绝 {bad}：{other:?}"),
            }
        }
        // Debug 不输出令牌。
        let config = load(&seed(), Some(TOKEN)).unwrap().unwrap();
        let printed = format!("{config:?}");
        assert!(!printed.contains(TOKEN));
        assert!(printed.contains("<redacted>"));
    }
}
