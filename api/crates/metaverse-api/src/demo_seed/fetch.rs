//! 下载种子文件：边下载边数字节，超过声明的大小立即停止；下载完核对大小和 sha256。
//!
//! - 只跟随最多 5 次重定向，而且新地址必须同样合法（https，或本机 http），否则不跟随、按失败处理；
//!   https 不能被重定向成 http（哪怕是本机地址）：本机 http 只给"一开始就是本机地址"的本地测试用；
//! - 错误信息里不带地址（重定向后的地址可能是带签名的临时链接），只写文件名；
//! - 代理照常读 `HTTPS_PROXY` / `NO_PROXY`（reqwest 默认行为）；
//! - 根证书用内置的公共根证书；另外设了 `SSL_CERT_FILE`（标准变量，PEM）时也信任其中的证书——
//!   只在本地经过会重新签发证书的出口代理时需要，线上不设；
//! - 失败分两类：地址不存在、内容不对（大小、哈希、状态码 4xx）不会自己变好，不重试；
//!   网络错误、超时、5xx、429 可以重试。

use std::time::Duration;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};

use url::Url;

use super::config::{url_allowed, SeedFile};
use super::SeedError;

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

/// 下载用的 HTTP 客户端（每次种子运行建一个）。
pub struct Fetcher {
    client: reqwest::Client,
}

impl Fetcher {
    pub fn new() -> Result<Self, SeedError> {
        let redirect = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("重定向次数太多")
            } else if redirect_allowed(attempt.previous(), attempt.url()) {
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
            .map_err(|error| SeedError::Permanent(format!("无法创建 HTTP 客户端：{error}")))?;
        Ok(Self { client })
    }

    /// 下载一个文件并核对大小和 sha256。
    pub async fn fetch(&self, file: &SeedFile) -> Result<Vec<u8>, SeedError> {
        let response = self
            .client
            .get(file.url.clone())
            .send()
            .await
            .map_err(|error| {
                SeedError::Transient(format!("下载 {} 失败：{}", file.name, describe(error)))
            })?;
        let status = response.status();
        if status.is_redirection() {
            return Err(SeedError::Permanent(format!(
                "下载 {} 失败：HTTP {status}，重定向到了不允许的地址（只跟随到 https；https 不能转成 http）",
                file.name
            )));
        }
        if !status.is_success() {
            let message = format!("下载 {} 失败：HTTP {status}", file.name);
            return Err(
                if status.is_server_error() || status.as_u16() == 408 || status.as_u16() == 429 {
                    SeedError::Transient(message)
                } else {
                    SeedError::Permanent(message)
                },
            );
        }
        if let Some(length) = response.content_length() {
            if length != file.size {
                return Err(SeedError::Permanent(format!(
                    "{} 的大小 {length} 与配置的 {} 不符",
                    file.name, file.size
                )));
            }
        }
        let capacity = usize::try_from(file.size).unwrap_or(usize::MAX);
        let mut bytes = Vec::with_capacity(capacity);
        let mut digest = Sha256::new();
        let mut stream = response.bytes_stream();
        while let Some(part) = stream.next().await {
            let part = part.map_err(|error| {
                SeedError::Transient(format!("下载 {} 中断：{}", file.name, describe(error)))
            })?;
            if (bytes.len() + part.len()) as u64 > file.size {
                return Err(SeedError::Permanent(format!(
                    "{} 比配置的 {} 字节大",
                    file.name, file.size
                )));
            }
            digest.update(&part);
            bytes.extend_from_slice(&part);
        }
        if bytes.len() as u64 != file.size {
            return Err(SeedError::Permanent(format!(
                "{} 只有 {} 字节，配置的是 {}",
                file.name,
                bytes.len(),
                file.size
            )));
        }
        let actual = metaverse_core::to_hex(&digest.finalize());
        if actual != file.sha256 {
            return Err(SeedError::Permanent(format!(
                "{} 的 sha256 是 {actual}，与配置的 {} 不符",
                file.name, file.sha256
            )));
        }
        Ok(bytes)
    }
}

/// 错误说明：去掉地址，带上底层原因（连接被拒、证书、超时等）。
fn describe(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut text = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        text.push_str("：");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// 能不能跟随到 `next`：新地址本身要合法（[`url_allowed`]），而且只要之前经过 https，就只能继续 https
/// （本机明文 http 只给一开始就是本机地址的测试用，不能由公网地址重定向过去）。
pub fn redirect_allowed(previous: &[Url], next: &Url) -> bool {
    url_allowed(next)
        && (next.scheme() == "https" || previous.iter().all(|url| url.scheme() == "http"))
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

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn redirects_never_downgrade_to_http() {
        let https = url("https://scaniverse.com/api/media/x/mesh.drc");
        let cdn = url("https://cdn.example/x/mesh.drc?sig=1");
        let local = url("http://127.0.0.1:9000/files/mesh.drc");
        // https → https、本机 http → 本机 http / https：可以。
        assert!(redirect_allowed(std::slice::from_ref(&https), &cdn));
        assert!(redirect_allowed(
            std::slice::from_ref(&local),
            &url("http://localhost:9000/x")
        ));
        assert!(redirect_allowed(std::slice::from_ref(&local), &cdn));
        // https → 本机 http：不可以（公网地址不能把下载引到本机的明文端口）。
        assert!(!redirect_allowed(std::slice::from_ref(&https), &local));
        assert!(!redirect_allowed(&[local.clone(), https.clone()], &local));
        // 新地址本身不合法：不可以。
        for bad in [
            "http://scaniverse.com/mesh.drc",
            "ftp://scaniverse.com/mesh.drc",
            "https://user:pass@cdn.example/mesh.drc",
            "file:///etc/passwd",
        ] {
            assert!(
                !redirect_allowed(std::slice::from_ref(&local), &url(bad)),
                "{bad}"
            );
            assert!(
                !redirect_allowed(std::slice::from_ref(&https), &url(bad)),
                "{bad}"
            );
        }
    }
}
