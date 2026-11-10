//! 下载种子的文件（docs/design/server-slim.md 7.1、7.2）：边下载边数字节、算 sha256，超过声明的大小
//! 立即停止；下载完核对大小和 sha256。
//!
//! - 地址和每一跳重定向都按主机列表检查（[`super::hosts`]），最多 5 跳；https 不能被重定向成 http；
//!   跳到列表外的地址不跟随，按内容问题处理（不重试）；
//! - 错误信息里只写主机和文件路径，不写完整地址（重定向后的地址可能带签名）；
//! - 代理照常读 `HTTPS_PROXY` / `NO_PROXY`（reqwest 默认行为）；根证书用内置的公共根证书，另外设了
//!   `SSL_CERT_FILE`（标准变量，PEM）时也信任其中的证书——只在本地经过会重新签发证书的出口代理时
//!   需要，线上不设；
//! - 失败分两类（4.2）：`fetch`——403、404、408、429、5xx，网络错误、超时，按退避重试（GitHub 发布页
//!   刚上传的文件短时间 404、匿名访问被限流，修好以后会自己好）；`content`——别的状态码、大小或哈希
//!   不符、跳到列表外，不重试。

use std::time::Duration;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use url::Url;

use super::hosts::{host_of, HostList};

const MAX_REDIRECTS: usize = 5;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 两次收到数据之间最长等多久。
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// 一个文件最长下载多久（1GiB 按 2MB/s 算约 9 分钟）。
const FILE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const USER_AGENT: &str = concat!(
    "chrono-metaverse-api/",
    env!("CARGO_PKG_VERSION"),
    " (demo-seed)"
);

/// 下载失败。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FetchError {
    /// 不会自己变好：状态码不对、大小或哈希不符、跳到不允许的地址。
    #[error("{0}")]
    Content(String),
    /// 可以重试：403、404、408、429、5xx，网络错误、超时。
    #[error("{0}")]
    Fetch(String),
}

/// 下载用的 HTTP 客户端（每次执行建一个）。
pub struct Fetcher {
    client: reqwest::Client,
    hosts: HostList,
}

/// 一次进行中的下载：逐段取数据，最后核对大小和哈希。
pub struct Download<'a> {
    label: &'a str,
    size: u64,
    received: u64,
    digest: Sha256,
    stream: futures_util::stream::BoxStream<'static, reqwest::Result<axum::body::Bytes>>,
}

/// 错误说明：去掉地址，带上底层原因（连接被拒、证书、超时等）。
fn describe(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut text = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        text.push('：');
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// 按状态码分类：403、404、408、429、5xx 可以重试，其余不重试。
pub fn status_class(status: reqwest::StatusCode) -> fn(String) -> FetchError {
    if status.is_server_error() || matches!(status.as_u16(), 403 | 404 | 408 | 429) {
        FetchError::Fetch
    } else {
        FetchError::Content
    }
}

impl Fetcher {
    pub fn new(hosts: HostList) -> Result<Self, FetchError> {
        let policy_hosts = hosts.clone();
        let redirect = reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("重定向次数太多")
            } else if policy_hosts.redirect_allowed(attempt.previous(), attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        });
        let mut builder = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .timeout(FILE_TIMEOUT)
            .redirect(redirect);
        for certificate in extra_roots() {
            builder = builder.add_root_certificate(certificate);
        }
        let client = builder
            .build()
            .map_err(|error| FetchError::Content(format!("无法创建 HTTP 客户端：{error}")))?;
        Ok(Self { client, hosts })
    }

    /// 开始下载 `label`（错误信息里的文件名或路径），声明 `size` 字节。
    pub async fn open<'a>(
        &self,
        url: &Url,
        label: &'a str,
        size: u64,
    ) -> Result<Download<'a>, FetchError> {
        if !self.hosts.allows(url) {
            return Err(FetchError::Content(format!(
                "下载 {label} 失败：主机 {} 不在允许下载的主机列表里",
                host_of(url)
            )));
        }
        let response = self.client.get(url.clone()).send().await.map_err(|error| {
            if error.is_redirect() {
                FetchError::Content(format!("下载 {label} 失败：{}", describe(error)))
            } else {
                FetchError::Fetch(format!("下载 {label} 失败：{}", describe(error)))
            }
        })?;
        let status = response.status();
        if status.is_redirection() {
            return Err(FetchError::Content(format!(
                "下载 {label} 失败（{}）：HTTP {status}，重定向到了不允许的地址（只跟随到允许的主机；https 不能转成 http）",
                host_of(url)
            )));
        }
        if !status.is_success() {
            return Err(status_class(status)(format!(
                "下载 {label} 失败（{}）：HTTP {status}",
                host_of(url)
            )));
        }
        if let Some(length) = response.content_length() {
            if length != size {
                return Err(FetchError::Content(format!(
                    "{label} 的大小 {length} 与声明的 {size} 不符"
                )));
            }
        }
        Ok(Download {
            label,
            size,
            received: 0,
            digest: Sha256::new(),
            stream: response.bytes_stream().boxed(),
        })
    }

    /// 整个下载进内存（清单、来源表、zip 成员都不大），核对大小和 sha256。
    pub async fn fetch_bytes(
        &self,
        url: &Url,
        label: &str,
        sha256: &str,
        size: u64,
    ) -> Result<Vec<u8>, FetchError> {
        let mut download = self.open(url, label, size).await?;
        let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0).min(64 << 20));
        while let Some(part) = download.next().await? {
            bytes.extend_from_slice(&part);
        }
        download.finish(sha256)?;
        Ok(bytes)
    }
}

impl Download<'_> {
    /// 下一段数据；收完了是 `None`。超过声明的大小立即报错。
    pub async fn next(&mut self) -> Result<Option<axum::body::Bytes>, FetchError> {
        let Some(part) = self.stream.next().await else {
            return Ok(None);
        };
        let part = part.map_err(|error| {
            FetchError::Fetch(format!("下载 {} 中断：{}", self.label, describe(error)))
        })?;
        self.received += part.len() as u64;
        if self.received > self.size {
            return Err(FetchError::Content(format!(
                "{} 比声明的 {} 字节大",
                self.label, self.size
            )));
        }
        self.digest.update(&part);
        Ok(Some(part))
    }

    /// 收完以后核对大小和 sha256。
    pub fn finish(self, sha256: &str) -> Result<(), FetchError> {
        if self.received != self.size {
            return Err(FetchError::Content(format!(
                "{} 只有 {} 字节，声明的是 {}",
                self.label, self.received, self.size
            )));
        }
        let actual = metaverse_core::to_hex(&self.digest.finalize());
        if actual != sha256 {
            return Err(FetchError::Content(format!(
                "{} 的 sha256 是 {actual}，与声明的 {sha256} 不符",
                self.label
            )));
        }
        Ok(())
    }
}

/// `SSL_CERT_FILE` 里的证书（没设或读不出来时为空，只记日志）。
fn extra_roots() -> Vec<reqwest::Certificate> {
    let Some(path) = std::env::var_os("SSL_CERT_FILE") else {
        return Vec::new();
    };
    match std::fs::read(&path)
        .map_err(|error| error.to_string())
        .and_then(|pem| {
            reqwest::Certificate::from_pem_bundle(&pem).map_err(|error| error.to_string())
        }) {
        Ok(certificates) => {
            tracing::info!(
                count = certificates.len(),
                "部署配置种子：另外信任 SSL_CERT_FILE 里的根证书"
            );
            certificates
        }
        Err(error) => {
            tracing::warn!(error = %error, "部署配置种子：SSL_CERT_FILE 读不出来，只用内置根证书");
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_codes_are_classified() {
        for (code, retry) in [
            (403, true),
            (404, true),
            (408, true),
            (429, true),
            (500, true),
            (503, true),
            (400, false),
            (401, false),
            (410, false),
        ] {
            let class = status_class(reqwest::StatusCode::from_u16(code).unwrap())(String::new());
            assert_eq!(matches!(class, FetchError::Fetch(_)), retry, "{code}");
        }
    }
}
