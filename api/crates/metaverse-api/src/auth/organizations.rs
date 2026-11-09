//! 组织角色查询（设计 9.2）。
//!
//! 改编自 CMA `api/crates/cma/src/auth/organizations/{mod.rs,transport.rs}`：
//!
//! - 用**调用者自己的凭据**调用 NyxID `GET /api/v1/orgs/{orgId}/authorization`；
//!   CMA 用服务端保存的登录令牌，本服务网站只读、不登录，所以改用 NyxID 转发来的
//!   调用者令牌（`Authorization: Bearer …`，需要在 NyxID 注册时开启
//!   `forward_access_token`）。这是设计里有记录的例外：令牌只在内存里用，
//!   只调这一个接口，不记日志、不落库、用完即弃。
//! - 转发来的是 JWT 时，先验签并要求它的 sub 等于身份令牌的 sub（CMA 用 userinfo
//!   核对主体，这里用同一组 NyxID 公钥核对）。
//! - 返回的编号必须等于 `orgId`（不认 slug）；角色只能是 admin、member、viewer。
//! - 三态结果：成员（带角色和证据）/ 不是成员（401、403、404）/ 查不到（其他错误、超时、
//!   没有转发令牌）。整次查询 15 秒截止。
//! - 结果不跨请求缓存；证据最多用 60 秒，从查询开始时算起。

use std::{
    fmt,
    sync::Arc,
    time::{Duration, SystemTime},
};

use metaverse_core::ids::is_subject_id;
use metaverse_core::model::OrgRole;
use serde::Deserialize;
use zeroize::Zeroizing;

use super::jwt::{looks_like_jwt, Verifier, VerifyError};

/// 整次查询的截止时间（与 CMA 相同）。
pub const LOOKUP_TIMEOUT: Duration = Duration::from_secs(15);
/// 证据的最长使用时间（与 CMA `MAX_MEMBERSHIP_AGE` 相同）。
pub const MAX_MEMBERSHIP_AGE: Duration = Duration::from_secs(60);
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;

/// NyxID 转发来的调用者凭据。只在内存里，`Debug` 不输出内容，释放时清零。
#[derive(Clone)]
pub struct ForwardedCredential(Zeroizing<String>);

impl fmt::Debug for ForwardedCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ForwardedCredential(<redacted>)")
    }
}

impl ForwardedCredential {
    /// 从请求头取 `Authorization: Bearer <令牌>`。头只能出现一次；别的认证方案
    /// （例如公开接口的 `Share`）不算转发凭据。
    pub fn from_headers(headers: &axum::http::HeaderMap) -> Option<Self> {
        let mut values = headers.get_all(axum::http::header::AUTHORIZATION).iter();
        let value = values.next()?;
        if values.next().is_some() {
            return None;
        }
        let value = value.to_str().ok()?;
        let (scheme, token) = value.split_once(' ')?;
        if !scheme.eq_ignore_ascii_case("bearer")
            || token.is_empty()
            || token.len() > MAX_CREDENTIAL_BYTES
            || !token.bytes().all(|b| b.is_ascii_graphic())
        {
            return None;
        }
        Some(Self(Zeroizing::new(token.to_owned())))
    }

    #[cfg(test)]
    pub fn for_test(value: &str) -> Self {
        Self(Zeroizing::new(value.to_owned()))
    }

    fn value(&self) -> &str {
        &self.0
    }
}

/// 一次实时查询得到的组织角色证据。不能从请求体或存储里反序列化出来。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgMembership {
    pub org_id: String,
    pub role: OrgRole,
    pub observed_at: SystemTime,
    pub expires_at: SystemTime,
    deadline: tokio::time::Instant,
}

impl OrgMembership {
    /// 证据是否仍可使用：墙钟和单调时钟都没超过 60 秒。
    pub fn is_current(&self) -> bool {
        let now = SystemTime::now();
        tokio::time::Instant::now() < self.deadline
            && self.observed_at <= now
            && now < self.expires_at
    }
}

/// 三态结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MembershipLookup {
    Member(OrgMembership),
    NotMember,
    Unavailable,
}

#[derive(Deserialize)]
struct OrgAuthorization {
    id: String,
    your_role: OrgRole,
}

pub struct OrganizationClient {
    base_url: reqwest::Url,
    http: reqwest::Client,
    verifier: Arc<Verifier>,
}

impl OrganizationClient {
    pub fn new(base_url: &str, verifier: Arc<Verifier>) -> Result<Self, String> {
        super::jwt::validate_endpoint(base_url)
            .map_err(|_| "NYXID_BASE_URL 必须是 https 地址（本机测试可用 http）".to_owned())?;
        let base_url =
            reqwest::Url::parse(base_url).map_err(|error| format!("NYXID_BASE_URL：{error}"))?;
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(LOOKUP_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| format!("HTTP 客户端：{error}"))?;
        Ok(Self {
            base_url,
            http,
            verifier,
        })
    }

    fn endpoint(&self, org_id: &str) -> Option<reqwest::Url> {
        let mut endpoint = self.base_url.clone();
        endpoint.set_path("/api/v1/orgs");
        endpoint.set_query(None);
        endpoint.set_fragment(None);
        endpoint
            .path_segments_mut()
            .ok()?
            .push(org_id)
            .push("authorization");
        Some(endpoint)
    }

    /// 查 `subject` 在 `org_id` 里的角色，用调用者自己转发来的凭据。
    pub async fn membership(
        &self,
        subject: &str,
        credential: Option<&ForwardedCredential>,
        org_id: &str,
    ) -> MembershipLookup {
        if !is_subject_id(org_id) {
            return MembershipLookup::NotMember;
        }
        let Some(credential) = credential else {
            return MembershipLookup::Unavailable;
        };
        tokio::time::timeout(LOOKUP_TIMEOUT, self.lookup(subject, credential, org_id))
            .await
            .unwrap_or(MembershipLookup::Unavailable)
    }

    async fn lookup(
        &self,
        subject: &str,
        credential: &ForwardedCredential,
        org_id: &str,
    ) -> MembershipLookup {
        // 证据的寿命从查询开始时算起，NyxID 响应慢也不会延长它。
        let monotonic_start = tokio::time::Instant::now();
        let observed_at = SystemTime::now();
        if looks_like_jwt(credential.value()) {
            match self
                .verifier
                .verify_forwarded_access_token(credential.value(), subject)
                .await
            {
                Ok(()) => {}
                Err(VerifyError::Rejected(_)) => return MembershipLookup::NotMember,
                Err(VerifyError::Unavailable(_)) => return MembershipLookup::Unavailable,
            }
        }
        let Some(endpoint) = self.endpoint(org_id) else {
            return MembershipLookup::Unavailable;
        };
        let Ok(mut response) = self
            .http
            .get(endpoint)
            .bearer_auth(credential.value())
            .send()
            .await
        else {
            return MembershipLookup::Unavailable;
        };
        match response.status().as_u16() {
            401 | 403 | 404 => return MembershipLookup::NotMember,
            200 => {}
            _ => return MembershipLookup::Unavailable,
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_BODY_BYTES as u64)
        {
            return MembershipLookup::Unavailable;
        }
        let mut body = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if body.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
                        return MembershipLookup::Unavailable;
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(_) => return MembershipLookup::Unavailable,
            }
        }
        let Ok(authorization) = serde_json::from_slice::<OrgAuthorization>(&body) else {
            return MembershipLookup::Unavailable;
        };
        // NyxID 的路由也接受 slug；归属判断只认规范编号。
        if authorization.id != org_id {
            return MembershipLookup::Unavailable;
        }
        let membership = OrgMembership {
            org_id: authorization.id,
            role: authorization.your_role,
            observed_at,
            expires_at: observed_at + MAX_MEMBERSHIP_AGE,
            deadline: monotonic_start + MAX_MEMBERSHIP_AGE,
        };
        if membership.is_current() {
            MembershipLookup::Member(membership)
        } else {
            MembershipLookup::Unavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header::AUTHORIZATION, HeaderMap, HeaderValue};

    #[test]
    fn forwarded_credential_parsing() {
        let mut headers = HeaderMap::new();
        assert!(ForwardedCredential::from_headers(&headers).is_none());
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer abc.def"));
        assert_eq!(
            ForwardedCredential::from_headers(&headers).unwrap().value(),
            "abc.def"
        );
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Share secret"));
        assert!(ForwardedCredential::from_headers(&headers).is_none());
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer "));
        assert!(ForwardedCredential::from_headers(&headers).is_none());
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer a"));
        headers.append(AUTHORIZATION, HeaderValue::from_static("Bearer b"));
        assert!(ForwardedCredential::from_headers(&headers).is_none());
        assert_eq!(
            format!("{:?}", ForwardedCredential::for_test("secret")),
            "ForwardedCredential(<redacted>)"
        );
    }

    #[tokio::test]
    async fn stale_evidence_is_not_current() {
        let now = SystemTime::now();
        let fresh = OrgMembership {
            org_id: "org-1".into(),
            role: OrgRole::Admin,
            observed_at: now,
            expires_at: now + MAX_MEMBERSHIP_AGE,
            deadline: tokio::time::Instant::now() + MAX_MEMBERSHIP_AGE,
        };
        assert!(fresh.is_current());
        let stale = OrgMembership {
            deadline: tokio::time::Instant::now(),
            ..fresh.clone()
        };
        assert!(!stale.is_current());
        let expired = OrgMembership {
            expires_at: now - Duration::from_secs(1),
            ..fresh
        };
        assert!(!expired.is_current());
    }

    #[test]
    fn endpoint_uses_canonical_org_id_path() {
        let verifier = Arc::new(
            Verifier::new(super::super::jwt::Config {
                issuer: "https://nyx.example".into(),
                jwks_url: "https://nyx.example/jwks".into(),
                audience: "urn:chrono-metaverse:api".into(),
                service_ids: vec!["svc".into()],
            })
            .unwrap(),
        );
        let client = OrganizationClient::new("https://nyx.example/some/path?x=1", verifier.clone());
        assert!(client.is_err());
        let client = OrganizationClient::new("https://nyx.example", verifier).unwrap();
        assert_eq!(
            client.endpoint("org-1").unwrap().as_str(),
            "https://nyx.example/api/v1/orgs/org-1/authorization"
        );
    }
}
