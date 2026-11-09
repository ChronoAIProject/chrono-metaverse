//! 部署配置（环境变量），参照 CMA `config.rs` 的写法：从一个查找函数读取，便于测试；
//! 鉴权相关配置缺失时直接启动失败（设计 9.1：签发方和受众为空时有的库会静默跳过检查）。
//!
//! | 变量 | 必填 | 说明 |
//! |---|---|---|
//! | `MONGODB_URI` | 是 | MongoDB 连接串（chrono-cd 的 MongoDB 插件注入） |
//! | `MONGODB_DATABASE` | 否 | 数据库名，默认 `chrono_metaverse` |
//! | `NYXID_BASE_URL` | 是 | NyxID 地址，查组织角色用 |
//! | `NYXID_JWKS_URL` | 是 | NyxID 公钥列表地址 |
//! | `NYXID_JWT_ISSUER` | 是 | 身份令牌签发方，以 NyxID `/.well-known/openid-configuration` 为准 |
//! | `NYXID_JWT_AUDIENCE` | 是 | 身份令牌受众，注册服务时设置的 `identity_jwt_audience` |
//! | `ALLOWED_NYX_SERVICE_IDS` | 是 | 允许的 NyxID 服务编号，逗号分隔 |
//! | `BIND` | 否 | 监听地址，默认 `0.0.0.0:8080` |
//! | `PUBLIC_BASE_URL` | 否 | 对外地址，默认 `http://localhost:8080` |
//! | `METAVERSE_REQUIRE_PERMISSIONS` | 否 | 是否启用功能级权限（`true`/`false`），默认 `false` |
//! | `UPLOAD_*`、`JOB_MAX_PENDING_PER_SPACE` | 否 | 上传大小、格式和任务数的上限，见 [`crate::ingest`] |
//! | `PUBLIC_*`、`TRUSTED_CLIENT_IP_HEADER` | 否 | 公开接口的限流、并发、缓存和可信客户端地址头，见 [`crate::public::PublicConfig`] |
//! | `METAVERSE_DEMO_SEED`、`METAVERSE_DEMO_SHARE_TOKEN` | 否 | 部署配置种子（演示空间）和它的分享令牌原文，见 [`crate::demo_seed`] |

use std::net::SocketAddr;

use crate::auth::jwt;

pub const DEFAULT_BIND: &str = "0.0.0.0:8080";
pub const DEFAULT_PUBLIC_BASE_URL: &str = "http://localhost:8080";
pub const DEFAULT_DATABASE: &str = "chrono_metaverse";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NyxIdConfig {
    pub base_url: String,
    pub jwks_url: String,
    pub issuer: String,
    pub audience: String,
    pub allowed_service_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub bind: SocketAddr,
    pub public_base_url: url::Url,
    pub mongodb_uri: String,
    pub mongodb_database: String,
    pub nyxid: NyxIdConfig,
    pub require_permissions: bool,
    /// 上传、任务的上限（`UPLOAD_*`、`JOB_*`，见 `ingest` 模块）。
    pub ingest: crate::ingest::IngestConfig,
    /// 公开接口的限流、并发和缓存（见 [`crate::public::PublicConfig`]）。
    pub public: crate::public::PublicConfig,
    /// 部署配置种子（`METAVERSE_DEMO_SEED`，没设时为空），见 [`crate::demo_seed`]。
    pub demo_seed: Option<crate::demo_seed::DemoSeedConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("缺少必填的环境变量 {0}")]
    Missing(&'static str),
    #[error("环境变量 {0} 的值不可用：{1}")]
    Invalid(&'static str, String),
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let optional = |name: &str| {
            lookup(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let required = |name: &'static str| optional(name).ok_or(ConfigError::Missing(name));

        let bind_text = optional("BIND").unwrap_or_else(|| DEFAULT_BIND.into());
        let bind = bind_text
            .parse()
            .map_err(|_| ConfigError::Invalid("BIND", bind_text.clone()))?;
        let public_base_url =
            optional("PUBLIC_BASE_URL").unwrap_or_else(|| DEFAULT_PUBLIC_BASE_URL.into());
        let public_base_url = url::Url::parse(&public_base_url)
            .map_err(|error| ConfigError::Invalid("PUBLIC_BASE_URL", error.to_string()))?;

        let mongodb_uri = required("MONGODB_URI")?;
        if !(mongodb_uri.starts_with("mongodb://") || mongodb_uri.starts_with("mongodb+srv://")) {
            return Err(ConfigError::Invalid(
                "MONGODB_URI",
                "必须以 mongodb:// 或 mongodb+srv:// 开头".into(),
            ));
        }
        let mongodb_database =
            optional("MONGODB_DATABASE").unwrap_or_else(|| DEFAULT_DATABASE.into());
        if mongodb_database.len() > 63
            || !mongodb_database
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(ConfigError::Invalid("MONGODB_DATABASE", mongodb_database));
        }

        let endpoint = |name: &'static str| -> Result<String, ConfigError> {
            let value = required(name)?;
            jwt::validate_endpoint(&value).map_err(|_| {
                ConfigError::Invalid(
                    name,
                    "必须是 https 地址（本机测试可用 http），不带用户名、查询和片段".into(),
                )
            })?;
            Ok(value)
        };
        let base_url = endpoint("NYXID_BASE_URL")?;
        let jwks_url = endpoint("NYXID_JWKS_URL")?;
        let issuer = endpoint("NYXID_JWT_ISSUER")?;
        let audience = required("NYXID_JWT_AUDIENCE")?;
        if audience.len() > 2048 || audience.chars().any(char::is_control) {
            return Err(ConfigError::Invalid("NYXID_JWT_AUDIENCE", audience));
        }
        let services = required("ALLOWED_NYX_SERVICE_IDS")?;
        let mut allowed_service_ids: Vec<String> = Vec::new();
        for id in services
            .split(',')
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            if id.len() > 256 || id.chars().any(|c| c.is_control() || c.is_whitespace()) {
                return Err(ConfigError::Invalid(
                    "ALLOWED_NYX_SERVICE_IDS",
                    id.to_owned(),
                ));
            }
            if !allowed_service_ids.iter().any(|existing| existing == id) {
                allowed_service_ids.push(id.to_owned());
            }
        }
        if allowed_service_ids.is_empty() {
            return Err(ConfigError::Missing("ALLOWED_NYX_SERVICE_IDS"));
        }
        let require_permissions = match optional("METAVERSE_REQUIRE_PERMISSIONS").as_deref() {
            None | Some("false") => false,
            Some("true") => true,
            Some(other) => {
                return Err(ConfigError::Invalid(
                    "METAVERSE_REQUIRE_PERMISSIONS",
                    other.to_owned(),
                ))
            }
        };
        let ingest = crate::ingest::IngestConfig::from_lookup(&lookup)?;
        let demo_seed =
            crate::demo_seed::DemoSeedConfig::from_lookup(&lookup, ingest.max_scan_bytes)?;
        let mut public = crate::public::PublicConfig::from_lookup(&lookup)?;
        public.site_base_url = public_base_url.as_str().trim_end_matches('/').to_owned();
        Ok(Self {
            public,
            bind,
            public_base_url,
            mongodb_uri,
            mongodb_database,
            nyxid: NyxIdConfig {
                base_url,
                jwks_url,
                issuer,
                audience,
                allowed_service_ids,
            },
            require_permissions,
            ingest,
            demo_seed,
        })
    }

    /// 身份令牌校验器的配置。
    pub fn verifier_config(&self) -> jwt::Config {
        jwt::Config {
            issuer: self.nyxid.issuer.clone(),
            jwks_url: self.nyxid.jwks_url.clone(),
            audience: self.nyxid.audience.clone(),
            service_ids: self.nyxid.allowed_service_ids.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn base() -> BTreeMap<&'static str, &'static str> {
        BTreeMap::from([
            ("MONGODB_URI", "mongodb://127.0.0.1:27017/?replicaSet=rs0"),
            ("NYXID_BASE_URL", "https://nyx.example"),
            (
                "NYXID_JWKS_URL",
                "https://nyx.example/.well-known/jwks.json",
            ),
            ("NYXID_JWT_ISSUER", "https://nyx.example"),
            ("NYXID_JWT_AUDIENCE", "urn:chrono-metaverse:api"),
            ("ALLOWED_NYX_SERVICE_IDS", "svc-a, svc-b,svc-a"),
        ])
    }

    fn load(values: &BTreeMap<&'static str, &'static str>) -> Result<Config, ConfigError> {
        Config::from_lookup(|name| values.get(name).map(|v| (*v).to_owned()))
    }

    #[test]
    fn defaults_and_service_list() {
        let config = load(&base()).unwrap();
        assert_eq!(config.bind.to_string(), DEFAULT_BIND);
        assert_eq!(config.mongodb_database, DEFAULT_DATABASE);
        assert_eq!(config.nyxid.allowed_service_ids, ["svc-a", "svc-b"]);
        assert!(!config.require_permissions);
    }

    #[test]
    fn auth_configuration_is_required() {
        for name in [
            "MONGODB_URI",
            "NYXID_BASE_URL",
            "NYXID_JWKS_URL",
            "NYXID_JWT_ISSUER",
            "NYXID_JWT_AUDIENCE",
            "ALLOWED_NYX_SERVICE_IDS",
        ] {
            let mut values = base();
            values.remove(name);
            assert_eq!(load(&values), Err(ConfigError::Missing(name)));
            values.insert(name, "   ");
            assert_eq!(load(&values), Err(ConfigError::Missing(name)));
        }
        let mut values = base();
        values.insert("ALLOWED_NYX_SERVICE_IDS", " , ,");
        assert_eq!(
            load(&values),
            Err(ConfigError::Missing("ALLOWED_NYX_SERVICE_IDS"))
        );
    }

    #[test]
    fn insecure_or_malformed_values_fail_fast() {
        for (name, value) in [
            ("NYXID_JWKS_URL", "http://nyx.example/jwks"),
            ("NYXID_BASE_URL", "https://nyx.example/?q=1"),
            ("MONGODB_URI", "postgres://x"),
            ("MONGODB_DATABASE", "bad name"),
            ("BIND", "nowhere"),
            ("METAVERSE_REQUIRE_PERMISSIONS", "yes"),
        ] {
            let mut values = base();
            values.insert(name, value);
            assert!(
                matches!(load(&values), Err(ConfigError::Invalid(n, _)) if n == name),
                "{name}"
            );
        }
        let mut values = base();
        values.insert("NYXID_JWKS_URL", "http://127.0.0.1:9000/jwks");
        assert!(load(&values).is_ok());
    }
}
