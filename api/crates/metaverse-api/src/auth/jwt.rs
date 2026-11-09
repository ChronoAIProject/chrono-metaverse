//! NyxID 身份令牌验签（设计 9.1）。
//!
//! 照搬自 CMA `api/crates/cma/src/auth/nyxid_proxy/jwt.rs`，改动：
//!
//! - 服务编号从单个值改成允许列表 `ALLOWED_NYX_SERVICE_IDS`（注册成目录服务的过渡期
//!   需要同时接受新旧两个编号）；
//! - 显式拒绝带 `token_type` 的令牌并给出单独的原因（NyxID 的访问令牌和身份令牌用
//!   同一把密钥、同一个签发方签名，访问令牌带 `token_type`）；
//! - 去掉 CMA 的个人资料（`Profile`）投影；
//! - 增加 [`Verifier::verify_forwarded_access_token`]：查组织角色前，若 NyxID 转发来的
//!   调用者令牌是 JWT，先验签并要求它的 sub 等于身份令牌的 sub（设计 9.2）。
//!
//! 其余规则与 CMA 相同：只接受 RS256 并按 kid 选公钥；公钥列表缓存 5 分钟；遇到未知
//! kid 最多每 5 秒刷新一次；已知 kid 签名不对时不刷新；签发方、受众精确匹配；
//! 签发到过期不超过 60 秒，`iat`/`nbf` 允许 5 秒时钟容差，过期不留余量。

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::signature::{RsaPublicKeyComponents, RSA_PKCS1_2048_8192_SHA256};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::Mutex, time::Instant};

/// NyxID 代理注入的身份令牌请求头。
pub const HEADER: &str = "x-nyxid-identity-token";
const MAX_TOKEN_BYTES: usize = 16_384;
const MAX_JWKS_BYTES: usize = 32_768;
const CACHE_TTL: Duration = Duration::from_secs(300);
const REFRESH_COOLDOWN: Duration = Duration::from_secs(5);
const MAX_CLOCK_SKEW: i64 = 5;
/// 身份令牌签发到过期的最长时间。
pub const MAX_LIFETIME_SECONDS: i64 = 60;

#[derive(Clone, Debug)]
pub struct Config {
    pub issuer: String,
    pub jwks_url: String,
    pub audience: String,
    pub service_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum VerifyError {
    #[error("NyxID 身份令牌被拒绝：{0}")]
    Rejected(&'static str),
    #[error("暂时无法校验 NyxID 身份令牌：{0}")]
    Unavailable(&'static str),
}

/// 验签通过的身份。
#[derive(Debug, Clone)]
pub struct VerifiedIdentity {
    pub issuer: String,
    pub subject: String,
    pub permissions: Vec<String>,
    pub service_id: String,
    pub jti: String,
    pub issued_at: SystemTime,
    pub expires_at: SystemTime,
}

/// 身份令牌头只能出现一次：重复的头可能让不同的 HTTP 层选中不同的身份。
/// 逗号拼接的值也会在解析 JWT 时失败。
pub fn identity_token(headers: &axum::http::HeaderMap) -> Result<Option<&str>, VerifyError> {
    let mut values = headers.get_all(HEADER).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(VerifyError::Rejected("duplicate_identity_header"));
    }
    let value = value
        .to_str()
        .map_err(|_| VerifyError::Rejected("identity_header"))?;
    if value.is_empty() || value.len() > MAX_TOKEN_BYTES {
        return Err(VerifyError::Rejected("token_bounds"));
    }
    Ok(Some(value))
}

pub struct Verifier {
    config: Config,
    client: reqwest::Client,
    cache: Mutex<Cached>,
}

#[derive(Default)]
struct Cached {
    keys: Option<(Arc<KeySet>, Instant)>,
    next_refresh: Option<Instant>,
}

impl Verifier {
    pub fn new(config: Config) -> Result<Self, VerifyError> {
        validate_endpoint(&config.jwks_url)?;
        validate_endpoint(&config.issuer)?;
        if config.service_ids.is_empty()
            || config.service_ids.len() > 16
            || !config.service_ids.iter().all(|id| identifier(id))
            || config.audience.trim().is_empty()
            || config.audience.len() > 2048
            || config.audience.chars().any(char::is_control)
        {
            return Err(VerifyError::Unavailable("trust_configuration"));
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(3))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| VerifyError::Unavailable("http_client"))?;
        Ok(Self {
            config,
            client,
            cache: Mutex::new(Cached::default()),
        })
    }

    pub fn issuer(&self) -> &str {
        &self.config.issuer
    }

    pub async fn verify(&self, raw: &str) -> Result<VerifiedIdentity, VerifyError> {
        let token = Token::parse(raw)?;
        let keys = self.keys_for(&token.kid).await?;
        // 已知 kid 的签名不对时绝不刷新公钥列表。
        let claims: Claims = keys.verify(&token)?;
        claims.validate(&self.config, now()?)
    }

    /// NyxID 转发来的调用者访问令牌（JWT 形式）：验签，并要求签发方一致、
    /// `token_type = access`、未过期、sub 等于身份令牌的 sub。
    pub async fn verify_forwarded_access_token(
        &self,
        raw: &str,
        expected_subject: &str,
    ) -> Result<(), VerifyError> {
        let token = Token::parse(raw)?;
        let keys = self.keys_for(&token.kid).await?;
        let claims: ForwardedClaims = keys.verify(&token)?;
        let now = now()?;
        if claims.iss != self.config.issuer
            || claims.token_type != "access"
            || claims.sub != expected_subject
            || !identifier(&claims.sub)
        {
            return Err(VerifyError::Rejected("forwarded_token_subject"));
        }
        if claims.exp <= now
            || claims
                .nbf
                .is_some_and(|nbf| nbf > now.saturating_add(MAX_CLOCK_SKEW))
        {
            return Err(VerifyError::Rejected("forwarded_token_time"));
        }
        Ok(())
    }

    async fn keys_for(&self, kid: &str) -> Result<Arc<KeySet>, VerifyError> {
        // 每个校验器一个公钥地址、一份有界缓存。刷新期间持有锁，
        // 并发的未命中和失败会合并成一次请求。
        let mut cache = self.cache.lock().await;
        let now = Instant::now();
        let current = cache
            .keys
            .as_ref()
            .filter(|(_, until)| *until > now)
            .map(|(keys, _)| keys.clone());
        if let Some(keys) = &current {
            if keys.0.contains_key(kid) {
                return Ok(keys.clone());
            }
        }
        if cache.next_refresh.is_some_and(|after| after > now) {
            return Err(if current.is_some() {
                VerifyError::Rejected("signing_key_unknown")
            } else {
                VerifyError::Unavailable("jwks_refresh_throttled")
            });
        }
        cache.next_refresh = Some(now + REFRESH_COOLDOWN);
        // 未知 kid 刷新失败时不丢弃仍在有效期内的公钥；过期的公钥在拉取失败后不再使用。
        let keys = Arc::new(self.fetch().await?);
        cache.keys = Some((keys.clone(), Instant::now() + CACHE_TTL));
        if !keys.0.contains_key(kid) {
            return Err(VerifyError::Rejected("signing_key_unknown"));
        }
        Ok(keys)
    }

    async fn fetch(&self) -> Result<KeySet, VerifyError> {
        let mut response = self
            .client
            .get(&self.config.jwks_url)
            .send()
            .await
            .map_err(|_| VerifyError::Unavailable("jwks_request"))?;
        if !response.status().is_success() {
            return Err(VerifyError::Unavailable("jwks_status"));
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_JWKS_BYTES as u64)
        {
            return Err(VerifyError::Unavailable("jwks_bounds"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| VerifyError::Unavailable("jwks_body"))?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_JWKS_BYTES {
                return Err(VerifyError::Unavailable("jwks_bounds"));
            }
            bytes.extend_from_slice(&chunk);
        }
        KeySet::parse(&bytes)
    }
}

fn now() -> Result<i64, VerifyError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| VerifyError::Unavailable("clock"))?
        .as_secs();
    i64::try_from(now).map_err(|_| VerifyError::Unavailable("clock"))
}

/// 公钥地址、签发方、NyxID 地址：只接受 https；明文 http 只允许本机（本地测试）。
pub fn validate_endpoint(raw: &str) -> Result<(), VerifyError> {
    let url =
        reqwest::Url::parse(raw).map_err(|_| VerifyError::Unavailable("trust_configuration"))?;
    let loopback = url.host().is_some_and(|host| match host {
        url::Host::Domain(host) => host == "localhost",
        url::Host::Ipv4(ip) => ip.is_loopback(),
        url::Host::Ipv6(ip) => ip.is_loopback(),
    });
    if raw.trim() != raw
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
    {
        return Err(VerifyError::Unavailable("trust_configuration"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    alg: String,
    typ: String,
    kid: String,
}

struct Token<'a> {
    kid: String,
    signed: &'a [u8],
    signature: Vec<u8>,
    body: Vec<u8>,
}

impl<'a> Token<'a> {
    fn parse(raw: &'a str) -> Result<Self, VerifyError> {
        if raw.is_empty() || raw.len() > MAX_TOKEN_BYTES {
            return Err(VerifyError::Rejected("token_bounds"));
        }
        let mut parts = raw.split('.');
        let header = parts.next().unwrap_or_default();
        let body = parts.next().ok_or(VerifyError::Rejected("token_format"))?;
        let signature = parts.next().ok_or(VerifyError::Rejected("token_format"))?;
        if parts.next().is_some()
            || header.len() > 1024
            || header.is_empty()
            || body.is_empty()
            || signature.is_empty()
        {
            return Err(VerifyError::Rejected("token_format"));
        }
        let header: Header = serde_json::from_slice(&decode(header)?)
            .map_err(|_| VerifyError::Rejected("token_header"))?;
        if header.alg != "RS256" || header.typ != "JWT" || !identifier(&header.kid) {
            return Err(VerifyError::Rejected("token_header"));
        }
        let signature_bytes = decode(signature)?;
        if !(256..=1024).contains(&signature_bytes.len()) {
            return Err(VerifyError::Rejected("token_signature_bounds"));
        }
        Ok(Self {
            kid: header.kid,
            signed: &raw.as_bytes()[..raw.len() - signature.len() - 1],
            signature: signature_bytes,
            body: decode(body)?,
        })
    }
}

/// 看起来像紧凑 JWT（三段 base64url，头部以 `{` 开头）。
pub fn looks_like_jwt(raw: &str) -> bool {
    let mut parts = raw.split('.');
    let header = parts.next().unwrap_or_default();
    parts.next().is_some()
        && parts.next().is_some()
        && parts.next().is_none()
        && decode(header).is_ok_and(|bytes| bytes.first() == Some(&b'{'))
}

fn decode(value: &str) -> Result<Vec<u8>, VerifyError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| VerifyError::Rejected("token_encoding"))
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Claims {
    sub: String,
    iss: String,
    aud: String,
    exp: i64,
    iat: i64,
    jti: String,
    nyx_service_id: String,
    permissions: Vec<String>,
    nbf: Option<i64>,
    // 以下字段属于 NyxID 现有的身份令牌格式，不授予任何能力；
    // 只有签名过的 permissions 会被映射成能力。
    #[serde(rename = "email")]
    _email: Option<String>,
    #[serde(rename = "name")]
    _name: Option<String>,
    #[serde(rename = "roles")]
    _roles: Option<Vec<String>>,
    #[serde(rename = "groups")]
    _groups: Option<Vec<String>>,
    /// 访问令牌才有；身份令牌带它一律拒绝（即使值是 null）。
    #[serde(default)]
    token_type: Presence,
}

/// 只记录字段是否出现，不关心取值。
#[derive(Default)]
struct Presence(bool);

impl<'de> Deserialize<'de> for Presence {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        serde::de::IgnoredAny::deserialize(deserializer)?;
        Ok(Presence(true))
    }
}

impl Claims {
    fn validate(self, config: &Config, now: i64) -> Result<VerifiedIdentity, VerifyError> {
        if self.token_type.0 {
            return Err(VerifyError::Rejected("token_type"));
        }
        if self.iss != config.issuer || self.aud != config.audience {
            return Err(VerifyError::Rejected("token_destination"));
        }
        if !config.service_ids.contains(&self.nyx_service_id) {
            return Err(VerifyError::Rejected("service_not_allowed"));
        }
        if !identifier(&self.sub)
            || !identifier(&self.jti)
            || self.permissions.len() > 256
            || self.permissions.iter().any(|p| !identifier(p))
        {
            return Err(VerifyError::Rejected("token_claims"));
        }
        // 过期不留余量；iat/nbf 允许 5 秒时钟容差。
        if self.iat < 0
            || now < 0
            || self.exp <= self.iat
            || self.exp.saturating_sub(self.iat) > MAX_LIFETIME_SECONDS
            || self.exp <= now
            || self.iat > now.saturating_add(MAX_CLOCK_SKEW)
            || self.nbf.is_some_and(|nbf| {
                nbf < 0 || nbf >= self.exp || nbf > now.saturating_add(MAX_CLOCK_SKEW)
            })
        {
            return Err(VerifyError::Rejected("token_time"));
        }
        Ok(VerifiedIdentity {
            issuer: self.iss,
            subject: self.sub,
            permissions: self.permissions,
            service_id: self.nyx_service_id,
            jti: self.jti,
            issued_at: UNIX_EPOCH + Duration::from_secs(self.iat as u64),
            expires_at: UNIX_EPOCH + Duration::from_secs(self.exp as u64),
        })
    }
}

/// 转发来的访问令牌只读这几项，其余字段忽略（访问令牌的格式不归本服务管）。
#[derive(Deserialize)]
struct ForwardedClaims {
    sub: String,
    iss: String,
    exp: i64,
    nbf: Option<i64>,
    token_type: String,
}

#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Deserialize)]
struct Jwk {
    kty: String,
    kid: String,
    n: String,
    e: String,
    alg: Option<String>,
    #[serde(rename = "use")]
    purpose: Option<String>,
    key_ops: Option<Vec<String>>,
}

struct RsaKey {
    n: Vec<u8>,
    e: Vec<u8>,
}

struct KeySet(BTreeMap<String, RsaKey>);

impl KeySet {
    fn parse(bytes: &[u8]) -> Result<Self, VerifyError> {
        let invalid = || VerifyError::Unavailable("jwks_invalid");
        if bytes.len() > MAX_JWKS_BYTES {
            return Err(VerifyError::Unavailable("jwks_bounds"));
        }
        let jwks: Jwks = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if jwks.keys.is_empty() || jwks.keys.len() > 16 {
            return Err(invalid());
        }
        let mut keys = BTreeMap::new();
        for key in jwks.keys {
            if key.kty != "RSA"
                || !identifier(&key.kid)
                || key.alg.as_deref().is_some_and(|alg| alg != "RS256")
                || key
                    .purpose
                    .as_deref()
                    .is_some_and(|purpose| purpose != "sig")
                || key
                    .key_ops
                    .as_ref()
                    .is_some_and(|ops| ops.len() != 1 || ops[0] != "verify")
            {
                return Err(invalid());
            }
            let n = decode(&key.n).map_err(|_| invalid())?;
            let e = decode(&key.e).map_err(|_| invalid())?;
            if !(256..=1024).contains(&n.len())
                || !(1..=8).contains(&e.len())
                || n[0] == 0
                || e[0] == 0
                || keys.insert(key.kid, RsaKey { n, e }).is_some()
            {
                return Err(invalid());
            }
        }
        Ok(Self(keys))
    }

    fn verify<T: serde::de::DeserializeOwned>(&self, token: &Token<'_>) -> Result<T, VerifyError> {
        let key = self
            .0
            .get(&token.kid)
            .ok_or(VerifyError::Rejected("signing_key_unknown"))?;
        RsaPublicKeyComponents {
            n: &key.n,
            e: &key.e,
        }
        .verify(&RSA_PKCS1_2048_8192_SHA256, token.signed, &token.signature)
        .map_err(|_| VerifyError::Rejected("token_signature"))?;
        serde_json::from_slice(&token.body).map_err(|_| VerifyError::Rejected("token_claims"))
    }
}

#[cfg(test)]
#[path = "jwt_tests.rs"]
mod tests;
