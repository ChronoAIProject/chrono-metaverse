//! 部署配置种子的配置：`METAVERSE_DEMO_SEED`（JSON）和 `METAVERSE_DEMO_SHARE_TOKEN`（分享令牌原文）。
//!
//! 解析严格：拒绝未知字段；地址只接受 https（本机测试可用 http://127.0.0.1 这类本机地址）；每个文件
//! 必须声明大小和 sha256，总大小不超过 [`MAX_SEED_TOTAL_BYTES`] 和扫描上传上限（`UPLOAD_MAX_SCAN_BYTES`）
//! 中较小的一个；空间编号、名称、说明按建空间接口的规则校验。配置不合法时接口服务启动失败（与其他配置一样，见 `config.rs`）。
//!
//! 分享令牌原文只用来算哈希：`Debug` 不输出内容、释放时清零，错误信息里也不出现它。

use std::fmt;

use metaverse_core::canonical::canonical_json;
use metaverse_core::ids::is_subject_id;
use metaverse_core::model::{Owner, OwnerKind, UploadFormat, Visibility};
use metaverse_core::{is_sha256_hex, Timestamp};
use serde::Deserialize;
use serde_json::Value;
use zeroize::Zeroizing;

use crate::config::ConfigError;
use crate::routes::admin_spaces::NewSpace;
use crate::routes::jobs::MAX_HINTS_BYTES;

/// 种子配置的环境变量。
pub const SEED_ENV: &str = "METAVERSE_DEMO_SEED";
/// 分享令牌原文的环境变量（chrono-cd 里作为应用密钥注入）。
pub const SHARE_TOKEN_ENV: &str = "METAVERSE_DEMO_SHARE_TOKEN";
/// 最多几个文件（一个网格 + 贴图、材质）。
pub const MAX_FILES: usize = 32;
/// 种子文件总大小的固定上限（256MiB）。下载的文件和打包的 zip 都在内存里，峰值约为总大小的两倍；
/// 接口服务的 `memory_limit` 是 1Gi，还要给并发的分片上传留余量。种子在每次启动时执行，超内存被杀
/// 会让接口服务反复重启，所以这里比扫描上传的上限（默认 1GiB）严。
pub const MAX_SEED_TOTAL_BYTES: u64 = 256 << 20;
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

/// 文件在扫描里的作用（按扩展名）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileRole {
    /// 网格：glb、drc、obj。
    Mesh,
    /// 贴图：jpg、jpeg、png、webp。
    Texture,
    /// obj 的材质文件：mtl。
    Material,
    /// 已经打好的 zip（只能单独一个文件）。
    Archive,
}

/// 一个要下载的文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedFile {
    pub url: url::Url,
    /// 文件名（zip 里的成员名，也决定格式）。
    pub name: String,
    pub sha256: String,
    pub size: u64,
    pub role: FileRole,
    /// 按扩展名推断的格式（下载后核对文件头）；`mtl` 按纯文本核对。
    pub format: UploadFormat,
}

/// 解析好的种子配置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DemoSeedConfig {
    pub space_id: String,
    pub name: String,
    pub description: String,
    pub owner: Owner,
    pub visibility: Visibility,
    pub observed_at: Option<Timestamp>,
    pub files: Vec<SeedFile>,
    pub rebuild: bool,
    pub voxelize: bool,
    pub hints: Option<Value>,
    /// 导入版本：改大以后重启接口服务，会对同一个空间再发起一次导入（见 `demo_seed` 模块说明）。
    pub revision: u32,
    pub share_token: Option<SeedShareToken>,
    /// 所有文件加起来（以及打包后的 zip）的上限：[`MAX_SEED_TOTAL_BYTES`] 和扫描上传上限中较小的。
    pub max_total_bytes: u64,
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
    #[serde(default)]
    observed_at: Option<Timestamp>,
    files: Vec<RawFile>,
    #[serde(default = "default_true")]
    rebuild: bool,
    #[serde(default)]
    voxelize: bool,
    #[serde(default)]
    hints: Option<Value>,
    #[serde(default = "default_revision")]
    revision: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawOwner {
    kind: OwnerKind,
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    url: String,
    name: String,
    sha256: String,
    size: u64,
}

fn default_true() -> bool {
    true
}

fn default_revision() -> u32 {
    1
}

fn invalid(reason: impl Into<String>) -> ConfigError {
    ConfigError::Invalid(SEED_ENV, reason.into())
}

/// 本机地址（测试和本地开发可用明文 http）。
fn is_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// 下载地址（也用于跟随重定向时检查新地址）：https，或本机的 http；不带用户名密码和片段。
pub fn url_allowed(url: &url::Url) -> bool {
    let scheme_ok = match url.scheme() {
        "https" => true,
        "http" => is_loopback(url),
        _ => false,
    };
    scheme_ok
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

/// 文件名：1–128 个字符，字母、数字、`.`、`_`、`-`，不以 `.` 开头；扩展名决定作用和格式。
fn file_kind(name: &str) -> Option<(FileRole, UploadFormat)> {
    let safe = (1..=128).contains(&name.len())
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if !safe {
        return None;
    }
    let extension = name.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match extension.as_str() {
        "glb" => (FileRole::Mesh, UploadFormat::Glb),
        "drc" => (FileRole::Mesh, UploadFormat::Drc),
        "obj" => (FileRole::Mesh, UploadFormat::Obj),
        "jpg" | "jpeg" => (FileRole::Texture, UploadFormat::Jpeg),
        "png" => (FileRole::Texture, UploadFormat::Png),
        "webp" => (FileRole::Texture, UploadFormat::Webp),
        "mtl" => (FileRole::Material, UploadFormat::Text),
        "zip" => (FileRole::Archive, UploadFormat::Zip),
        _ => return None,
    })
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

impl DemoSeedConfig {
    /// 读配置。没设 `METAVERSE_DEMO_SEED` 时返回 `None`（什么都不做）。
    /// `max_scan_bytes` 是扫描上传的上限（`UPLOAD_MAX_SCAN_BYTES`）；种子文件总大小不超过它和
    /// [`MAX_SEED_TOTAL_BYTES`] 中较小的一个。
    pub fn from_lookup(
        lookup: &dyn Fn(&str) -> Option<String>,
        max_scan_bytes: u64,
    ) -> Result<Option<Self>, ConfigError> {
        let max_total_bytes = max_scan_bytes.min(MAX_SEED_TOTAL_BYTES);
        let optional = |name: &str| {
            lookup(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        // 没有种子时令牌用不上，也不检查（不能因为一个用不上的密钥启动失败）。
        let Some(text) = optional(SEED_ENV) else {
            return Ok(None);
        };
        let token = parse_share_token(optional(SHARE_TOKEN_ENV))?;
        let raw: RawSeed = serde_json::from_str(&text)
            .map_err(|error| invalid(format!("不是合法的种子配置 JSON：{error}")))?;
        Self::from_raw(raw, token, max_total_bytes).map(Some)
    }

    fn from_raw(
        raw: RawSeed,
        share_token: Option<SeedShareToken>,
        max_total_bytes: u64,
    ) -> Result<Self, ConfigError> {
        if raw.owner.kind != OwnerKind::Org || !is_subject_id(&raw.owner.id) {
            return Err(invalid(
                "owner 必须是 {\"kind\": \"org\", \"id\": <NyxID 组织的规范编号>}",
            ));
        }
        if raw.revision == 0 {
            return Err(invalid("revision 从 1 开始"));
        }
        if raw.files.is_empty() || raw.files.len() > MAX_FILES {
            return Err(invalid(format!("files 要有 1–{MAX_FILES} 个文件")));
        }
        let mut files = Vec::with_capacity(raw.files.len());
        let mut total: u64 = 0;
        for file in raw.files {
            let url = url::Url::parse(&file.url)
                .map_err(|error| invalid(format!("文件 {} 的地址不合法：{error}", file.name)))?;
            if !url_allowed(&url) {
                return Err(invalid(format!(
                    "文件 {} 的地址必须是 https（本机测试可用 http://127.0.0.1），不带用户名、密码和片段",
                    file.name
                )));
            }
            let (role, format) = file_kind(&file.name).ok_or_else(|| {
                invalid(format!(
                    "文件名 {:?} 不合法：只能用字母、数字、.、_、-，扩展名是 glb、drc、obj、jpg、jpeg、png、webp、mtl 或 zip",
                    file.name
                ))
            })?;
            if !is_sha256_hex(&file.sha256) {
                return Err(invalid(format!(
                    "文件 {} 的 sha256 必须是 64 位小写十六进制",
                    file.name
                )));
            }
            if file.size == 0 || file.size > max_total_bytes {
                return Err(invalid(format!(
                    "文件 {} 的大小必须在 1–{max_total_bytes} 字节之间",
                    file.name
                )));
            }
            total = total.saturating_add(file.size);
            if files
                .iter()
                .any(|other: &SeedFile| other.name.eq_ignore_ascii_case(&file.name))
            {
                return Err(invalid(format!("文件名重复：{}", file.name)));
            }
            files.push(SeedFile {
                url,
                name: file.name,
                sha256: file.sha256,
                size: file.size,
                role,
                format,
            });
        }
        if total > max_total_bytes {
            return Err(invalid(format!(
                "文件总大小 {total} 超过上限 {max_total_bytes}（种子在内存里处理，上限取 256MiB 和 UPLOAD_MAX_SCAN_BYTES 中较小的）"
            )));
        }
        let meshes = files.iter().filter(|f| f.role == FileRole::Mesh).count();
        let archives = files.iter().filter(|f| f.role == FileRole::Archive).count();
        let usable = if files.len() == 1 {
            meshes == 1 || archives == 1
        } else {
            meshes == 1 && archives == 0
        };
        if !usable {
            return Err(invalid(
                "files 要么是单独一个 glb / drc / obj / zip，要么是一个 glb / drc / obj 网格加贴图（jpg、png、webp）和材质（mtl），会打包成 zip",
            ));
        }
        if let Some(hints) = &raw.hints {
            let fits = hints.is_object()
                && canonical_json(hints).is_ok_and(|text| text.len() <= MAX_HINTS_BYTES);
            if !fits {
                return Err(invalid(format!(
                    "hints 必须是规范化后不超过 {MAX_HINTS_BYTES} 字节的 JSON 对象"
                )));
            }
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
            observed_at: raw.observed_at,
            files,
            rebuild: raw.rebuild,
            voxelize: raw.voxelize,
            hints: raw.hints,
            revision: raw.revision,
            share_token,
            max_total_bytes,
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

    fn seed() -> Value {
        json!({
            "spaceId": "chronoai-lobby",
            "name": "ChronoAI 前厅",
            "description": "演示",
            "owner": {"kind": "org", "id": ORG},
            "visibility": "unlisted",
            "files": [
                {"url": "https://scaniverse.com/api/media/x/mesh.drc", "name": "mesh.drc",
                 "sha256": "a".repeat(64), "size": 1000},
                {"url": "https://scaniverse.com/api/media/x/tex.jpg", "name": "tex.jpg",
                 "sha256": "b".repeat(64), "size": 2000}
            ],
            "rebuild": true,
            "voxelize": false,
            "hints": {"objects": [{"center": [1, 0.5, 2], "kind": "chair"}]}
        })
    }

    fn load(seed: &Value, token: Option<&str>) -> Result<Option<DemoSeedConfig>, ConfigError> {
        let mut values = BTreeMap::new();
        values.insert(SEED_ENV, seed.to_string());
        if let Some(token) = token {
            values.insert(SHARE_TOKEN_ENV, token.to_owned());
        }
        DemoSeedConfig::from_lookup(&|name| values.get(name).cloned(), 1 << 30)
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
        assert_eq!(config.revision, 1);
        assert!(config.rebuild && !config.voxelize);
        assert_eq!(config.files[0].role, FileRole::Mesh);
        assert_eq!(config.files[0].format, UploadFormat::Drc);
        assert_eq!(config.files[1].role, FileRole::Texture);
        assert_eq!(config.reference(), "chronoai-lobby@1");
        assert_eq!(
            config.share_token.as_ref().unwrap().hash(),
            metaverse_core::sha256_hex(TOKEN.as_bytes())
        );
    }

    #[test]
    fn absent_seed_does_nothing() {
        let values: BTreeMap<&str, String> = BTreeMap::new();
        assert_eq!(
            DemoSeedConfig::from_lookup(&|name| values.get(name).cloned(), 1 << 30),
            Ok(None)
        );
        let blank = BTreeMap::from([(SEED_ENV, "  ".to_owned())]);
        assert_eq!(
            DemoSeedConfig::from_lookup(&|name| blank.get(name).cloned(), 1 << 30),
            Ok(None)
        );
        // 没有种子时，令牌即使格式不对也不检查。
        let stray = BTreeMap::from([(SHARE_TOKEN_ENV, "short".to_owned())]);
        assert_eq!(
            DemoSeedConfig::from_lookup(&|name| stray.get(name).cloned(), 1 << 30),
            Ok(None)
        );
    }

    #[test]
    fn rejects_unknown_fields_everywhere() {
        let mut top = seed();
        top["extra"] = json!(1);
        assert!(reason(load(&top, Some(TOKEN))).contains("extra"));
        let mut owner = seed();
        owner["owner"]["slug"] = json!("chronoai");
        assert!(reason(load(&owner, Some(TOKEN))).contains("slug"));
        let mut file = seed();
        file["files"][0]["contentType"] = json!("x");
        assert!(reason(load(&file, Some(TOKEN))).contains("contentType"));
    }

    #[test]
    fn urls_must_be_https_except_loopback() {
        for (url, ok) in [
            ("https://scaniverse.com/a/mesh.drc", true),
            ("https://cdn.example/a/mesh.drc?sig=1", true),
            ("http://127.0.0.1:9000/mesh.drc", true),
            ("http://localhost:9000/mesh.drc", true),
            ("http://[::1]:9000/mesh.drc", true),
            ("http://scaniverse.com/a/mesh.drc", false),
            ("ftp://scaniverse.com/mesh.drc", false),
            ("https://user:pass@scaniverse.com/mesh.drc", false),
            ("https://scaniverse.com/mesh.drc#x", false),
            ("file:///etc/passwd", false),
        ] {
            let mut value = seed();
            value["files"][0]["url"] = json!(url);
            assert_eq!(load(&value, Some(TOKEN)).is_ok(), ok, "{url}");
        }
    }

    /// 改一份配置的函数。
    type Edit = Box<dyn Fn(&mut Value)>;

    #[test]
    fn file_rules() {
        let cases: Vec<(&str, Edit)> = vec![
            (
                "sha256",
                Box::new(|v| v["files"][0]["sha256"] = json!("A".repeat(64))),
            ),
            ("大小", Box::new(|v| v["files"][0]["size"] = json!(0))),
            (
                "大小",
                Box::new(|v| v["files"][0]["size"] = json!(MAX_SEED_TOTAL_BYTES + 1)),
            ),
            (
                "总大小",
                Box::new(|v| {
                    v["files"][0]["size"] = json!(1u64 << 27);
                    v["files"][1]["size"] = json!((1u64 << 27) + 1);
                }),
            ),
            (
                "文件名",
                Box::new(|v| v["files"][0]["name"] = json!("../mesh.drc")),
            ),
            (
                "文件名",
                Box::new(|v| v["files"][0]["name"] = json!(".mesh.drc")),
            ),
            (
                "文件名",
                Box::new(|v| v["files"][0]["name"] = json!("mesh.exe")),
            ),
            (
                "重复",
                Box::new(|v| v["files"][1]["name"] = json!("MESH.drc")),
            ),
            (
                "要么",
                Box::new(|v| v["files"][1]["name"] = json!("other.glb")),
            ),
            (
                "要么",
                Box::new(|v| v["files"][0]["name"] = json!("tex2.png")),
            ),
            (
                "要么",
                Box::new(|v| v["files"][1]["name"] = json!("scan.zip")),
            ),
            ("1–32", Box::new(|v| v["files"] = json!([]))),
        ];
        for (expected, edit) in cases {
            let mut value = seed();
            edit(&mut value);
            let reason = reason(load(&value, Some(TOKEN)));
            assert!(reason.contains(expected), "{expected}: {reason}");
        }
        // 单独一个网格或 zip 可以。
        for name in ["scan.glb", "scan.zip", "scan.obj"] {
            let mut value = seed();
            value["files"] = json!([{"url": "https://x.example/f", "name": name,
                                     "sha256": "c".repeat(64), "size": 10}]);
            assert!(load(&value, Some(TOKEN)).is_ok(), "{name}");
        }
        // obj + mtl + 贴图可以。
        let mut value = seed();
        value["files"][0]["name"] = json!("scan.obj");
        value["files"]
            .as_array_mut()
            .unwrap()
            .push(json!({"url": "https://x.example/m", "name": "scan.mtl", "sha256": "d".repeat(64), "size": 10}));
        assert!(load(&value, Some(TOKEN)).is_ok());
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
        let mut value = seed();
        value["observedAt"] = json!("昨天");
        assert!(load(&value, Some(TOKEN)).is_err());
        let mut value = seed();
        value["observedAt"] = json!("2026-10-01T09:30:00+08:00");
        let config = load(&value, Some(TOKEN)).unwrap().unwrap();
        assert_eq!(
            config.observed_at.unwrap().to_rfc3339(),
            "2026-10-01T01:30:00.000Z"
        );
    }

    #[test]
    fn total_size_is_capped_by_the_smaller_limit() {
        let total = |max_scan_bytes: u64| {
            let values = BTreeMap::from([
                (SEED_ENV, seed().to_string()),
                (SHARE_TOKEN_ENV, TOKEN.to_owned()),
            ]);
            DemoSeedConfig::from_lookup(&|name| values.get(name).cloned(), max_scan_bytes)
                .unwrap()
                .unwrap()
                .max_total_bytes
        };
        // 扫描上传上限 1GiB 时取种子自己的 256MiB（全在内存里处理）；上传上限更小时取上传上限。
        assert_eq!(total(1 << 30), MAX_SEED_TOTAL_BYTES);
        assert_eq!(total(1 << 20), 1 << 20);
        // 单个文件不超过上传上限，但超过种子的上限：拒绝。
        let mut value = seed();
        value["files"][0]["size"] = json!(MAX_SEED_TOTAL_BYTES + 1);
        assert!(reason(load(&value, Some(TOKEN))).contains(&MAX_SEED_TOTAL_BYTES.to_string()));
        let mut value = seed();
        value["files"][0]["size"] = json!(1500);
        let values = BTreeMap::from([
            (SEED_ENV, value.to_string()),
            (SHARE_TOKEN_ENV, TOKEN.to_owned()),
        ]);
        let rejected = DemoSeedConfig::from_lookup(&|name| values.get(name).cloned(), 3000);
        assert!(
            matches!(rejected, Err(ConfigError::Invalid(_, reason)) if reason.contains("总大小"))
        );
    }

    #[test]
    fn hints_must_be_a_small_object() {
        let mut value = seed();
        value["hints"] = json!([1, 2]);
        assert!(reason(load(&value, Some(TOKEN))).contains("hints"));
        let mut value = seed();
        value["hints"] = json!({"objects": [{"label": "x".repeat(5000)}]});
        assert!(reason(load(&value, Some(TOKEN))).contains("hints"));
        let mut value = seed();
        value.as_object_mut().unwrap().remove("hints");
        assert_eq!(load(&value, Some(TOKEN)).unwrap().unwrap().hints, None);
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
