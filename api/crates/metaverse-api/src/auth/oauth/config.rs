use std::fmt;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use zeroize::Zeroizing;

use crate::{auth::jwt, config::ConfigError};

/// 配置中的秘密不进入 Debug、错误信息或浏览器响应。
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(pub(super) Zeroizing<String>);

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthConfig {
    pub client_id: String,
    pub client_secret: Secret,
    pub encryption_key: Secret,
    pub origin: String,
    pub redirect_uri: String,
    pub secure_cookie: bool,
    /// 固定的 CMA 服务器；不接受浏览器指定转发目标。
    pub cma_base_url: Option<String>,
}

impl OAuthConfig {
    pub fn from_lookup(
        lookup: &impl Fn(&str) -> Option<String>,
        public_url: &url::Url,
    ) -> Result<Option<Self>, ConfigError> {
        let names = [
            "NYXID_OAUTH_CLIENT_ID",
            "NYXID_OAUTH_CLIENT_SECRET",
            "NYXID_OAUTH_ENCRYPTION_KEY",
        ];
        let values: Vec<_> = names
            .iter()
            .map(|name| {
                lookup(name)
                    .map(Zeroizing::new)
                    .filter(|v| !v.trim().is_empty())
            })
            .collect();
        if values.iter().all(Option::is_none) {
            return Ok(None);
        }
        for (name, value) in names.iter().zip(&values) {
            if value.is_none() {
                return Err(ConfigError::Missing(name));
            }
        }
        let invalid = |name| ConfigError::Invalid(name, "OAuth 配置格式不正确".into());
        let client_id = values[0].as_ref().unwrap().trim().to_owned();
        if client_id.len() > 256 || !client_id.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(invalid(names[0]));
        }
        let secret = values[1].as_ref().unwrap();
        if secret.len() > 4096 || secret.chars().any(char::is_control) {
            return Err(invalid(names[1]));
        }
        let key = values[2].as_ref().unwrap().trim();
        let bytes = Zeroizing::new(STANDARD.decode(key).map_err(|_| invalid(names[2]))?);
        if bytes.len() != 32 {
            return Err(invalid(names[2]));
        }
        jwt::validate_endpoint(public_url.as_str()).map_err(|_| invalid("PUBLIC_BASE_URL"))?;
        if public_url.path() != "/" {
            return Err(invalid("PUBLIC_BASE_URL"));
        }
        let origin = public_url.origin().ascii_serialization();
        let cma_base_url = lookup("CMA_BASE_URL")
            .filter(|v| !v.trim().is_empty())
            .map(|value| {
                jwt::validate_endpoint(&value).map_err(|_| invalid("CMA_BASE_URL"))?;
                let url = url::Url::parse(&value).map_err(|_| invalid("CMA_BASE_URL"))?;
                if url.path() != "/" {
                    return Err(invalid("CMA_BASE_URL"));
                }
                Ok(url.origin().ascii_serialization())
            })
            .transpose()?;
        Ok(Some(Self {
            client_id,
            client_secret: Secret(secret.clone()),
            encryption_key: Secret(Zeroizing::new(key.to_owned())),
            redirect_uri: format!("{origin}/api/auth/nyxid/callback"),
            origin,
            secure_cookie: public_url.scheme() == "https",
            cma_base_url,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(pairs: &[(&str, &str)], url: &str) -> Result<Option<OAuthConfig>, ConfigError> {
        OAuthConfig::from_lookup(
            &|name| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| value.to_string())
            },
            &url::Url::parse(url).unwrap(),
        )
    }

    #[test]
    fn optional_configuration_is_atomic_and_secrets_are_redacted() {
        assert!(config(&[], "https://metaverse.example").unwrap().is_none());
        let key = STANDARD.encode([7_u8; 32]);
        let pairs = [
            ("NYXID_OAUTH_CLIENT_ID", "metaverse"),
            ("NYXID_OAUTH_CLIENT_SECRET", "private-client-secret"),
            ("NYXID_OAUTH_ENCRYPTION_KEY", key.as_str()),
        ];
        for missing in 0..pairs.len() {
            let incomplete: Vec<_> = pairs
                .iter()
                .enumerate()
                .filter(|(index, _)| *index != missing)
                .map(|(_, pair)| *pair)
                .collect();
            assert!(config(&incomplete, "https://metaverse.example").is_err());
        }
        let value = config(&pairs, "https://metaverse.example")
            .unwrap()
            .unwrap();
        assert!(value.secure_cookie);
        assert_eq!(
            value.redirect_uri,
            "https://metaverse.example/api/auth/nyxid/callback"
        );
        let debug = format!("{value:?}");
        assert!(!debug.contains("private-client-secret") && !debug.contains(&key));
        for url in [
            "http://metaverse.example",
            "https://metaverse.example/path",
            "https://user:pass@metaverse.example",
            "https://metaverse.example/?x=1",
        ] {
            assert!(config(&pairs, url).is_err());
        }
        assert!(
            !config(&pairs, "http://127.0.0.1:8080")
                .unwrap()
                .unwrap()
                .secure_cookie
        );
        for endpoint in [
            "http://external.test",
            "https://cma.example/api",
            "https://user:secret@cma.example",
            "https://cma.example/?target=x",
        ] {
            let mut cma = pairs.to_vec();
            cma.push(("CMA_BASE_URL", endpoint));
            assert!(config(&cma, "https://metaverse.example").is_err());
        }
        let mut cma = pairs.to_vec();
        cma.push(("CMA_BASE_URL", "https://cma.example"));
        assert_eq!(
            config(&cma, "https://metaverse.example")
                .unwrap()
                .unwrap()
                .cma_base_url
                .as_deref(),
            Some("https://cma.example")
        );
        let mut invalid = pairs;
        invalid[2].1 = "invalid-key-material";
        let error = config(&invalid, "https://metaverse.example")
            .unwrap_err()
            .to_string();
        assert!(!error.contains("invalid-key-material"));
    }
}
