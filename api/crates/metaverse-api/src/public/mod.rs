//! 公开读接口的基础设施（设计 8.2 的"限流"和缓存规则），各公开接口共用：
//!
//! - [`guard`] 中间件：按来源地址限流（governor，与 CMA 相同的用法），并对每个空间设
//!   并发上限（`/api/public/spaces/{id}/...`）；拒绝一律 `Cache-Control: no-store`；
//! - 来源地址默认取 TCP 连接地址，不信任任何请求头；配置了 `TRUSTED_CLIENT_IP_HEADER`
//!   时才取那个头（只认恰好一个合法 IP 的值）。IPv6 按 /64 归并，换隐私地址不会换到新额度；
//! - [`ByteCache`]：快照、区块、资源共用的进程内缓存，有字节上限；
//! - [`headers`]：分享令牌和预览令牌的解析、缓存头。
//!
//! 部署在网关后面时，确认网关写入的可信头之前（设计 8.2），来源地址可能是网关地址，
//! 这时限流只能当兜底。

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::num::NonZeroU32;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use governor::{clock::Clock, DefaultKeyedRateLimiter, Quota, RateLimiter};

pub mod cache;
pub mod headers;

pub use cache::{ByteCache, CacheKey};

use crate::config::ConfigError;
use crate::error::ApiError;
use crate::AppState;
use metaverse_core::ids::is_space_id;

/// 默认每个来源地址每分钟的请求数。
pub const DEFAULT_RATE_PER_MINUTE: u32 = 1200;
/// 默认突发额度。
pub const DEFAULT_RATE_BURST: u32 = 200;
/// 默认每个空间同时处理的公开请求数。
pub const DEFAULT_SPACE_CONCURRENCY: usize = 64;
/// 区块和资源（内容寻址、可以永久缓存）默认每个来源地址每分钟的请求数：查看器打开一个空间
/// 会一次取几百个区块，所以单独一档、额度更高。
pub const DEFAULT_BLOB_RATE_PER_MINUTE: u32 = 12_000;
/// 区块和资源的默认突发额度。
pub const DEFAULT_BLOB_RATE_BURST: u32 = 2_000;
/// 默认进程内缓存的总字节数。
pub const DEFAULT_CACHE_BYTES: usize = 256 * 1024 * 1024;

/// 公开接口的配置（环境变量）。
///
/// | 变量 | 默认 | 说明 |
/// |---|---|---|
/// | `PUBLIC_RATE_LIMIT_PER_MINUTE` | 1200 | 每个来源地址每分钟的请求数 |
/// | `PUBLIC_RATE_LIMIT_BURST` | 200 | 突发额度 |
/// | `PUBLIC_BLOB_RATE_LIMIT_PER_MINUTE` | 12000 | 区块和资源（`/chunks/`、`/assets/`）每个来源地址每分钟的请求数 |
/// | `PUBLIC_BLOB_RATE_LIMIT_BURST` | 2000 | 区块和资源的突发额度 |
/// | `PUBLIC_SPACE_CONCURRENCY` | 64 | 每个空间同时处理的公开请求数 |
/// | `PUBLIC_CACHE_BYTES` | 268435456 | 进程内缓存总字节数（0 表示不缓存） |
/// | `TRUSTED_CLIENT_IP_HEADER` | 不设 | 可信的客户端地址请求头（例如 `cf-connecting-ip`）；不设就用连接地址 |
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicConfig {
    pub rate_per_minute: NonZeroU32,
    pub rate_burst: NonZeroU32,
    pub blob_rate_per_minute: NonZeroU32,
    pub blob_rate_burst: NonZeroU32,
    pub space_concurrency: usize,
    pub cache_bytes: usize,
    pub trusted_client_ip_header: Option<HeaderName>,
    /// 网站的对外地址（取自 `PUBLIC_BASE_URL`，不带结尾的 `/`），用来拼预览链接。
    pub site_base_url: String,
}

impl Default for PublicConfig {
    fn default() -> Self {
        Self {
            rate_per_minute: NonZeroU32::new(DEFAULT_RATE_PER_MINUTE).expect("非零"),
            rate_burst: NonZeroU32::new(DEFAULT_RATE_BURST).expect("非零"),
            blob_rate_per_minute: NonZeroU32::new(DEFAULT_BLOB_RATE_PER_MINUTE).expect("非零"),
            blob_rate_burst: NonZeroU32::new(DEFAULT_BLOB_RATE_BURST).expect("非零"),
            space_concurrency: DEFAULT_SPACE_CONCURRENCY,
            cache_bytes: DEFAULT_CACHE_BYTES,
            trusted_client_ip_header: None,
            site_base_url: crate::config::DEFAULT_PUBLIC_BASE_URL.to_owned(),
        }
    }
}

impl PublicConfig {
    pub fn from_lookup(lookup: &dyn Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let optional = |name: &str| {
            lookup(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        fn number<T: std::str::FromStr>(
            name: &'static str,
            value: Option<String>,
            default: T,
        ) -> Result<T, ConfigError> {
            match value {
                None => Ok(default),
                Some(text) => text
                    .parse()
                    .map_err(|_| ConfigError::Invalid(name, text.clone())),
            }
        }
        let defaults = Self::default();
        let rate_per_minute = number(
            "PUBLIC_RATE_LIMIT_PER_MINUTE",
            optional("PUBLIC_RATE_LIMIT_PER_MINUTE"),
            defaults.rate_per_minute,
        )?;
        let rate_burst = number(
            "PUBLIC_RATE_LIMIT_BURST",
            optional("PUBLIC_RATE_LIMIT_BURST"),
            defaults.rate_burst,
        )?;
        let blob_rate_per_minute = number(
            "PUBLIC_BLOB_RATE_LIMIT_PER_MINUTE",
            optional("PUBLIC_BLOB_RATE_LIMIT_PER_MINUTE"),
            defaults.blob_rate_per_minute,
        )?;
        let blob_rate_burst = number(
            "PUBLIC_BLOB_RATE_LIMIT_BURST",
            optional("PUBLIC_BLOB_RATE_LIMIT_BURST"),
            defaults.blob_rate_burst,
        )?;
        let space_concurrency = number(
            "PUBLIC_SPACE_CONCURRENCY",
            optional("PUBLIC_SPACE_CONCURRENCY"),
            defaults.space_concurrency,
        )?;
        if space_concurrency == 0 {
            return Err(ConfigError::Invalid(
                "PUBLIC_SPACE_CONCURRENCY",
                "必须大于 0".into(),
            ));
        }
        let cache_bytes = number(
            "PUBLIC_CACHE_BYTES",
            optional("PUBLIC_CACHE_BYTES"),
            defaults.cache_bytes,
        )?;
        let trusted_client_ip_header = optional("TRUSTED_CLIENT_IP_HEADER")
            .map(|name| {
                HeaderName::try_from(name.to_ascii_lowercase())
                    .map_err(|_| ConfigError::Invalid("TRUSTED_CLIENT_IP_HEADER", name))
            })
            .transpose()?;
        Ok(Self {
            rate_per_minute,
            rate_burst,
            blob_rate_per_minute,
            blob_rate_burst,
            space_concurrency,
            cache_bytes,
            trusted_client_ip_header,
            site_base_url: defaults.site_base_url,
        })
    }
}

/// 限流的键：来源网络（IPv4 一个地址，IPv6 一个 /64），拿不到地址时共用一个桶。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ClientKey {
    Network(IpAddr),
    Unidentified,
}

impl ClientKey {
    fn from_ip(ip: IpAddr) -> Self {
        let ip = match ip {
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) => IpAddr::V4(v4),
                None => {
                    let segments = v6.segments();
                    IpAddr::V6(Ipv6Addr::new(
                        segments[0],
                        segments[1],
                        segments[2],
                        segments[3],
                        0,
                        0,
                        0,
                        0,
                    ))
                }
            },
            v4 => v4,
        };
        ClientKey::Network(ip)
    }
}

/// 限流档位。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateTier {
    /// 普通公开接口。
    Default,
    /// 区块和资源（内容寻址，查看器一次会取很多个）。
    Blob,
}

impl RateTier {
    /// 按路径判断档位：`/api/public/chunks/`、`/api/public/assets/` 和预览的区块、资源。
    pub fn for_path(path: &str) -> Self {
        const BLOB_PREFIXES: [&str; 4] = [
            "/api/public/chunks/",
            "/api/public/assets/",
            "/api/public/previews/chunks/",
            "/api/public/previews/assets/",
        ];
        if BLOB_PREFIXES.iter().any(|prefix| path.starts_with(prefix)) {
            RateTier::Blob
        } else {
            RateTier::Default
        }
    }
}

/// 每个空间的并发计数。
#[derive(Default)]
struct SpaceConcurrency {
    in_flight: Mutex<HashMap<String, usize>>,
}

/// 占着一个空间的并发名额，释放时计数减一。
pub struct SpacePermit {
    services: Arc<PublicServices>,
    space_id: String,
}

impl Drop for SpacePermit {
    fn drop(&mut self) {
        let mut map = self
            .services
            .concurrency
            .in_flight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(count) = map.get_mut(&self.space_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                map.remove(&self.space_id);
            }
        }
    }
}

/// 公开接口共用的服务：限流器、并发计数、缓存。
pub struct PublicServices {
    config: PublicConfig,
    limiter: DefaultKeyedRateLimiter<ClientKey>,
    blob_limiter: DefaultKeyedRateLimiter<ClientKey>,
    concurrency: SpaceConcurrency,
    decisions: AtomicU64,
    rejections: AtomicU64,
    pub cache: ByteCache,
}

impl PublicServices {
    pub fn new(config: PublicConfig) -> Arc<Self> {
        let quota = Quota::per_minute(config.rate_per_minute).allow_burst(config.rate_burst);
        let blob_quota =
            Quota::per_minute(config.blob_rate_per_minute).allow_burst(config.blob_rate_burst);
        Arc::new(Self {
            limiter: RateLimiter::keyed(quota),
            blob_limiter: RateLimiter::keyed(blob_quota),
            concurrency: SpaceConcurrency::default(),
            decisions: AtomicU64::new(0),
            rejections: AtomicU64::new(0),
            cache: ByteCache::new(config.cache_bytes),
            config,
        })
    }

    pub fn config(&self) -> &PublicConfig {
        &self.config
    }

    /// 来源地址：配置了可信头就只认那个头（恰好一个值、恰好一个合法 IP），否则用连接地址。
    pub fn client_key(&self, headers: &HeaderMap, peer: Option<SocketAddr>) -> ClientKey {
        if let Some(name) = &self.config.trusted_client_ip_header {
            let mut values = headers.get_all(name).iter();
            if let (Some(value), None) = (values.next(), values.next()) {
                if let Some(ip) = value
                    .to_str()
                    .ok()
                    .and_then(|text| text.trim().parse::<IpAddr>().ok())
                {
                    return ClientKey::from_ip(ip);
                }
            }
            // 头缺失或不合法时退回连接地址，不信任调用方自己写的值。
        }
        peer.map_or(ClientKey::Unidentified, |peer| {
            ClientKey::from_ip(peer.ip())
        })
    }

    /// 限流检查；超出时返回需要等待的秒数。`tier` 区分普通接口和内容寻址数据。
    pub fn check_rate(&self, key: &ClientKey, tier: RateTier) -> Result<(), u64> {
        let limiter = match tier {
            RateTier::Default => &self.limiter,
            RateTier::Blob => &self.blob_limiter,
        };
        let decision = limiter.check_key(key).map_err(|refusal| {
            refusal
                .wait_time_from(limiter.clock().now())
                .as_secs()
                .max(1)
        });
        let count = self.decisions.fetch_add(1, Ordering::Relaxed) + 1;
        if count.is_multiple_of(1024) {
            self.limiter.retain_recent();
            self.blob_limiter.retain_recent();
        }
        if decision.is_err() {
            let rejected = self.rejections.fetch_add(1, Ordering::Relaxed) + 1;
            // 只按 2 的幂次记日志，被拒的流量不会刷爆日志。
            if rejected.is_power_of_two() {
                tracing::warn!(rejected, "公开接口限流");
            }
        }
        decision
    }

    /// 占一个空间的并发名额；满了返回 `None`。
    pub fn acquire_space(self: &Arc<Self>, space_id: &str) -> Option<SpacePermit> {
        let mut map = self
            .concurrency
            .in_flight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let count = map.entry(space_id.to_owned()).or_insert(0);
        if *count >= self.config.space_concurrency {
            return None;
        }
        *count += 1;
        drop(map);
        Some(SpacePermit {
            services: self.clone(),
            space_id: space_id.to_owned(),
        })
    }
}

fn too_many_requests(retry_after: u64) -> Response {
    let mut response = ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        "请求太频繁，请稍后重试",
    )
    .into_response();
    if let Ok(value) = HeaderValue::from_str(&retry_after.to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

/// 路径 `/api/public/spaces/{id}/...` 里的空间编号段（原样，没有百分号解码）。
#[derive(Debug, PartialEq, Eq)]
enum SpaceSegment<'a> {
    /// 不是空间路径。
    None,
    /// 规范的空间编号：并发计数就用它。
    Id(&'a str),
    /// 不是规范的空间编号（例如 `rest%61urant`）。路由提取路径参数时会做百分号解码，同一个
    /// 空间可以写成任意多种编码；按原始字符串计数就能把每空间并发上限放大成任意倍，所以直接 404。
    Invalid,
}

fn space_of(path: &str) -> SpaceSegment<'_> {
    let Some(rest) = path.strip_prefix("/api/public/spaces/") else {
        return SpaceSegment::None;
    };
    match rest.split('/').next() {
        Some(id) if is_space_id(id) => SpaceSegment::Id(id),
        _ => SpaceSegment::Invalid,
    }
}

/// `/api/public/*` 的中间件：先限流，再占空间的并发名额。
pub async fn guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let services = state.public.clone();
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0);
    let key = services.client_key(request.headers(), peer);
    let tier = RateTier::for_path(request.uri().path());
    if let Err(retry_after) = services.check_rate(&key, tier) {
        return too_many_requests(retry_after);
    }
    let _permit = match space_of(request.uri().path()) {
        SpaceSegment::Invalid => return ApiError::not_found().into_response(),
        SpaceSegment::Id(space_id) => match services.acquire_space(space_id) {
            Some(permit) => Some(permit),
            None => {
                tracing::warn!(space = %space_id, "空间的公开请求并发已满");
                return ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "space_busy",
                    "这个空间的访问量太大，请稍后重试",
                )
                .into_response();
            }
        },
        SpaceSegment::None => None,
    };
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(pairs: &[(&str, &str)]) -> Result<PublicConfig, ConfigError> {
        PublicConfig::from_lookup(&|name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        })
    }

    #[test]
    fn configuration_defaults_and_validation() {
        assert_eq!(config(&[]).unwrap(), PublicConfig::default());
        let custom = config(&[
            ("PUBLIC_RATE_LIMIT_PER_MINUTE", "60"),
            ("PUBLIC_RATE_LIMIT_BURST", "5"),
            ("PUBLIC_SPACE_CONCURRENCY", "2"),
            ("PUBLIC_CACHE_BYTES", "0"),
            ("TRUSTED_CLIENT_IP_HEADER", "CF-Connecting-IP"),
        ])
        .unwrap();
        assert_eq!(custom.rate_per_minute.get(), 60);
        assert_eq!(
            custom.trusted_client_ip_header.unwrap().as_str(),
            "cf-connecting-ip"
        );
        for (name, value) in [
            ("PUBLIC_RATE_LIMIT_PER_MINUTE", "0"),
            ("PUBLIC_RATE_LIMIT_BURST", "-1"),
            ("PUBLIC_SPACE_CONCURRENCY", "0"),
            ("PUBLIC_CACHE_BYTES", "lots"),
            ("TRUSTED_CLIENT_IP_HEADER", "bad header"),
        ] {
            assert!(
                matches!(config(&[(name, value)]), Err(ConfigError::Invalid(n, _)) if n == name),
                "{name}"
            );
        }
    }

    #[test]
    fn client_key_ignores_headers_unless_trusted() {
        let services = PublicServices::new(PublicConfig::default());
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("1.2.3.4"));
        let peer: SocketAddr = "10.0.0.9:5000".parse().unwrap();
        assert_eq!(
            services.client_key(&headers, Some(peer)),
            ClientKey::Network("10.0.0.9".parse().unwrap())
        );
        assert_eq!(services.client_key(&headers, None), ClientKey::Unidentified);
        let trusted = PublicServices::new(PublicConfig {
            trusted_client_ip_header: Some(HeaderName::from_static("cf-connecting-ip")),
            ..PublicConfig::default()
        });
        headers.insert("cf-connecting-ip", HeaderValue::from_static("2001:db8::1"));
        assert_eq!(
            trusted.client_key(&headers, Some(peer)),
            ClientKey::Network("2001:db8::".parse().unwrap())
        );
        // 不合法或出现多次时退回连接地址。
        headers.insert(
            "cf-connecting-ip",
            HeaderValue::from_static("1.2.3.4, 5.6.7.8"),
        );
        assert_eq!(
            trusted.client_key(&headers, Some(peer)),
            ClientKey::Network("10.0.0.9".parse().unwrap())
        );
        headers.insert(
            "cf-connecting-ip",
            HeaderValue::from_static("::ffff:1.2.3.4"),
        );
        assert_eq!(
            trusted.client_key(&headers, Some(peer)),
            ClientKey::Network("1.2.3.4".parse().unwrap())
        );
    }

    #[test]
    fn rate_limit_and_space_concurrency() {
        let services = PublicServices::new(PublicConfig {
            rate_per_minute: NonZeroU32::new(60).unwrap(),
            rate_burst: NonZeroU32::new(2).unwrap(),
            space_concurrency: 2,
            ..PublicConfig::default()
        });
        let key = ClientKey::Network("1.2.3.4".parse().unwrap());
        assert!(services.check_rate(&key, RateTier::Default).is_ok());
        assert!(services.check_rate(&key, RateTier::Default).is_ok());
        assert!(services.check_rate(&key, RateTier::Default).unwrap_err() >= 1);
        // 别的来源、内容寻址数据的档位不受影响。
        assert!(services
            .check_rate(&ClientKey::Unidentified, RateTier::Default)
            .is_ok());
        assert!(services.check_rate(&key, RateTier::Blob).is_ok());
        assert_eq!(
            RateTier::for_path("/api/public/chunks/abc.bin"),
            RateTier::Blob
        );
        assert_eq!(
            RateTier::for_path("/api/public/spaces/x/snapshot"),
            RateTier::Default
        );
        let first = services.acquire_space("front-hall").unwrap();
        let _second = services.acquire_space("front-hall").unwrap();
        assert!(services.acquire_space("front-hall").is_none());
        assert!(services.acquire_space("other-space").is_some());
        drop(first);
        assert!(services.acquire_space("front-hall").is_some());
    }

    #[test]
    fn space_segment() {
        assert_eq!(
            space_of("/api/public/spaces/front-hall"),
            SpaceSegment::Id("front-hall")
        );
        assert_eq!(
            space_of("/api/public/spaces/front-hall/snapshot"),
            SpaceSegment::Id("front-hall")
        );
        assert_eq!(space_of("/api/public/chunks/abc.bin"), SpaceSegment::None);
        assert_eq!(space_of("/api/public/spaces/"), SpaceSegment::Invalid);
        // 百分号编码的变体不能各占一个并发计数桶。
        for path in [
            "/api/public/spaces/rest%61urant",
            "/api/public/spaces/%72estaurant/snapshot",
            "/api/public/spaces/REST%61URANT/head",
            "/api/public/spaces/Restaurant",
        ] {
            assert_eq!(space_of(path), SpaceSegment::Invalid, "{path}");
        }
    }
}
