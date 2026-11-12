//! 每次连接前检查并固定 DNS，不转发浏览器凭据、Cookie 或 Referer。
use super::{public_ip, upstream};
use crate::error::ApiError;
use axum::http::StatusCode;
use std::{future::Future, net::SocketAddr, pin::Pin, time::Duration};
use url::Url;

type Transfer<'a> = Pin<Box<dyn Future<Output = Result<reqwest::Response, ApiError>> + Send + 'a>>;
pub(super) trait Transport: Send + Sync {
    fn get<'a>(&'a self, url: &'a Url) -> Transfer<'a>;
}
pub(super) struct Https;
impl Transport for Https {
    fn get<'a>(&'a self, url: &'a Url) -> Transfer<'a> {
        Box::pin(async move {
            let host = url
                .host_str()
                .ok_or_else(|| ApiError::invalid("缺少来源主机"))?;
            let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, 443))
                .await
                .map_err(|_| upstream())?
                .collect();
            if addresses.is_empty() || addresses.iter().any(|addr| !public_ip(addr.ip())) {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "external_network",
                    "外部来源必须解析到公网地址",
                ));
            }
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .resolve_to_addrs(host, &addresses)
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(20))
                .user_agent("chrono-metaverse/1.0 (+external-resources)")
                .build()
                .map_err(|_| ApiError::internal())?;
            client
                .get(url.clone())
                .header("accept-encoding", "identity")
                .send()
                .await
                .map_err(|_| upstream())
        })
    }
}
