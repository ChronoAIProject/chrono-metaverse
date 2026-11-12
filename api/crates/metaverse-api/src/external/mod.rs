//! 提供方无关的 HTTPS 读取：授权由路由完成，网络与缓存规则在此统一执行。
use crate::{config::ConfigError, error::ApiError};
use axum::{
    body::Bytes,
    http::{HeaderMap, StatusCode},
};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::{
    net::IpAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::sync::{Mutex, Semaphore};

mod cache;
pub mod source;
#[cfg(test)]
mod tests;
mod transport;
use cache::{now_ms, DiskCache, Metadata};
use source::{CachePolicy, Source};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalConfig {
    pub directory: PathBuf,
    pub capacity: u64,
}
impl ExternalConfig {
    pub fn from_lookup(lookup: &dyn Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let directory = lookup("EXTERNAL_CACHE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("chrono-metaverse-external-v1"));
        if !directory.is_absolute() {
            return Err(ConfigError::Invalid(
                "EXTERNAL_CACHE_DIR",
                "需要绝对路径和本进程专用目录".into(),
            ));
        }
        let capacity = lookup("EXTERNAL_CACHE_BYTES")
            .map(|v| v.parse::<u64>())
            .transpose()
            .map_err(|_| ConfigError::Invalid("EXTERNAL_CACHE_BYTES", "需要非负整数字节数".into()))?
            .unwrap_or(512 * 1024 * 1024);
        Ok(Self {
            directory,
            capacity,
        })
    }
}

pub struct ExternalResources {
    cache: DiskCache,
    inflight: Semaphore,
    locks: Vec<Mutex<()>>,
    transport: Arc<dyn transport::Transport>,
}

impl ExternalResources {
    pub fn new(config: &ExternalConfig) -> Arc<Self> {
        Arc::new(Self {
            transport: Arc::new(transport::Https),
            cache: DiskCache::new(config.directory.clone(), config.capacity),
            inflight: Semaphore::new(8),
            locks: (0..64).map(|_| Mutex::new(())).collect(),
        })
    }

    pub async fn fetch(
        &self,
        source: &Source,
        url: &str,
    ) -> Result<(Bytes, String, bool), ApiError> {
        // 整个过程有时限，包括 DNS、排队、重定向和响应体。
        tokio::time::timeout(Duration::from_secs(25), self.fetch_inner(source, url))
            .await
            .map_err(|_| {
                ApiError::new(
                    StatusCode::GATEWAY_TIMEOUT,
                    "external_timeout",
                    "外部来源响应超时",
                )
            })?
    }

    async fn fetch_inner(
        &self,
        source: &Source,
        value: &str,
    ) -> Result<(Bytes, String, bool), ApiError> {
        let mut url = source.checked(value)?;
        let digest = Sha256::digest(url.as_str().as_bytes());
        let key = format!("{digest:x}");
        let _lock = self.locks[digest[0] as usize % self.locks.len()]
            .lock()
            .await;
        if source.cache.persist != Some(false) {
            if let Some((meta, bytes)) = self
                .cache
                .get(
                    &key,
                    source.max_bytes,
                    source.cache.max_age_seconds.unwrap_or(604800),
                )
                .await
            {
                return Ok((bytes, meta.content_type, true));
            }
        }
        // 地图和三维可同时启动；在总时限内排队，避免正常的混合场景被瞬时并发拒绝。
        let _permit = self.inflight.acquire().await.map_err(|_| {
            ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "external_busy",
                "外部资源并发已满，请稍后重试",
            )
        })?;
        let started = SystemTime::now();
        let mut lifetime = 604800;
        for redirects in 0..=5 {
            let response = self.transport.get(&url).await?;
            lifetime = lifetime.min(freshness(
                response.headers(),
                &source.cache,
                SystemTime::now(),
            ));
            if response.status().is_redirection() {
                if redirects == 5 {
                    return Err(upstream());
                }
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|h| h.to_str().ok())
                    .ok_or_else(upstream)?;
                url = source.checked(url.join(location).map_err(|_| upstream())?.as_str())?;
                continue;
            }
            if response.status() != StatusCode::OK {
                let status = match response.status() {
                    StatusCode::FORBIDDEN => StatusCode::FORBIDDEN,
                    StatusCode::NOT_FOUND => StatusCode::NOT_FOUND,
                    StatusCode::UNAUTHORIZED => StatusCode::FORBIDDEN,
                    _ => StatusCode::BAD_GATEWAY,
                };
                return Err(ApiError::new(
                    status,
                    "external_upstream",
                    format!("外部来源返回 HTTP {}", response.status().as_u16()),
                ));
            }
            if response
                .content_length()
                .is_some_and(|size| size > source.max_bytes as u64)
                || response
                    .headers()
                    .get("content-encoding")
                    .is_some_and(|v| v != "identity")
            {
                return Err(too_large());
            }
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_owned();
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| upstream())?;
                if bytes.len() + chunk.len() > source.max_bytes {
                    return Err(too_large());
                }
                bytes.extend_from_slice(&chunk);
            }
            let bytes = Bytes::from(bytes);
            let elapsed = started.elapsed().unwrap_or_default().as_secs();
            let lifetime = lifetime.saturating_sub(elapsed);
            if lifetime > 0 {
                let saved = now_ms();
                let meta = Metadata {
                    saved,
                    expires: saved + lifetime * 1000,
                    content_type: content_type.clone(),
                };
                if let Err(error) = self.cache.put(&key, &meta, &bytes).await {
                    tracing::warn!(%error, "外部资源磁盘缓存写入失败");
                }
            }
            return Ok((bytes, content_type, false));
        }
        Err(upstream())
    }
}

fn upstream() -> ApiError {
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "external_upstream",
        "外部来源暂时不可用",
    )
}
fn too_large() -> ApiError {
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "external_size",
        "外部资源超过大小上限或使用不支持的压缩",
    )
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !v4.is_private()
                && !v4.is_loopback()
                && !v4.is_link_local()
                && !v4.is_broadcast()
                && !v4.is_unspecified()
                && !(a == 0
                    || a >= 224
                    || a == 100 && (64..=127).contains(&b)
                    || a == 192 && b == 0
                    || a == 192 && b == 88 && c == 99
                    || a == 198 && (b == 18 || b == 19 || b == 51 && c == 100)
                    || a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            // 仅全球单播，额外拒绝文档、Teredo、6to4 等可嵌套非公网 IPv4 的范围。
            segments[0] & 0xe000 == 0x2000
                && !(segments[0] == 0x2001 && segments[1] < 0x0200
                    || segments[0] == 0x2001 && segments[1] == 0x0db8
                    || segments[0] == 0x2002
                    || segments[0] == 0x3fff)
        }
    }
}

pub fn freshness(headers: &HeaderMap, policy: &CachePolicy, now: SystemTime) -> u64 {
    if policy.persist == Some(false)
        || headers.get_all("vary").iter().any(|value| {
            value.to_str().map_or(true, |value| {
                value.split(',').any(|name| {
                    !matches!(
                        name.trim().to_ascii_lowercase().as_str(),
                        "accept"
                            | "accept-encoding"
                            | "user-agent"
                            | "origin"
                            | "authorization"
                            | "cookie"
                    )
                })
            })
        })
    {
        return 0;
    }
    let controls = headers
        .get_all("cache-control")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect::<Vec<_>>()
        .join(",")
        .to_ascii_lowercase();
    let directives: Vec<_> = controls.split(',').map(str::trim).collect();
    if directives.iter().any(|v| {
        matches!(
            v.split('=').next().unwrap_or("").trim(),
            "private" | "no-store" | "no-cache"
        )
    }) {
        return 0;
    }
    let seconds = |name: &str| {
        directives.iter().find_map(|value| {
            let (key, value) = value.split_once('=')?;
            (key.trim() == name)
                .then(|| value.trim().trim_matches('"').parse::<u64>().ok())
                .flatten()
        })
    };
    // Set-Cookie 本身不禁止 HTTP 缓存；只在上游明确允许共享缓存时保存字节，
    // Cookie 不进入缓存，也不转发给浏览器或后续提供方请求。
    if headers.contains_key("set-cookie")
        && !directives.contains(&"public")
        && seconds("s-maxage").is_none()
    {
        return 0;
    }
    let date = headers
        .get("date")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| httpdate::parse_http_date(v).ok());
    let age = headers
        .get("age")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0)
        .max(
            date.and_then(|date| now.duration_since(date).ok())
                .unwrap_or_default()
                .as_secs(),
        );
    let ttl = seconds("s-maxage")
        .or_else(|| seconds("max-age"))
        .map(|ttl| ttl.saturating_sub(age))
        .unwrap_or_else(|| {
            headers
                .get("expires")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| httpdate::parse_http_date(v).ok())
                .and_then(|end| end.duration_since(now).ok())
                .unwrap_or_default()
                .as_secs()
                .saturating_sub(age)
        });
    ttl.min(policy.max_age_seconds.unwrap_or(604800))
        .min(604800)
}
