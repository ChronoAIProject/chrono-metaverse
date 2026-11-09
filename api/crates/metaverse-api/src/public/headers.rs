//! 公开接口的请求头与缓存头（设计 8.2）。
//!
//! - 分享令牌：`Authorization: Share <令牌>`；预览令牌：`Authorization: Preview <令牌>`。
//!   头只能出现一次，别的认证方案一律忽略（当作没带）。
//! - 成功响应：凭令牌访问一律 `private`；只有公开空间的内容才能用 `public`；
//!   `.bin`（内容寻址的区块和资源）用 `public, max-age=31536000, immutable`；
//!   预览和拒绝响应一律 `no-store`。

use axum::http::{header, HeaderMap, HeaderValue};

use crate::auth::{Grant, PublicBasis};

/// 内容不变的文件（区块、资源）。
pub const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// 不缓存。
pub const NO_STORE: &str = "no-store";

fn scheme_token<'a>(headers: &'a HeaderMap, scheme: &str) -> Option<&'a str> {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    let (found, token) = value.to_str().ok()?.split_once(' ')?;
    found.eq_ignore_ascii_case(scheme).then_some(token.trim())
}

/// `Authorization: Share <令牌>`。
pub fn share_token(headers: &HeaderMap) -> Option<&str> {
    scheme_token(headers, "share")
}

/// `Authorization: Preview <令牌>`。
pub fn preview_token(headers: &HeaderMap) -> Option<&str> {
    scheme_token(headers, "preview")
}

/// 按授权依据给出缓存头：公开空间 `public`，凭令牌 `private`，预览 `no-store`。
pub fn cache_control(grant: &Grant, max_age_seconds: u32) -> HeaderValue {
    let text = match grant.public_basis() {
        Some(PublicBasis::PublicVisibility) => format!("public, max-age={max_age_seconds}"),
        Some(PublicBasis::Preview) | None => NO_STORE.to_owned(),
        Some(PublicBasis::ShareToken) => format!("private, max-age={max_age_seconds}"),
    };
    HeaderValue::from_str(&text).unwrap_or(HeaderValue::from_static(NO_STORE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schemes_are_exclusive() {
        let mut headers = HeaderMap::new();
        assert_eq!(share_token(&headers), None);
        headers.insert(header::AUTHORIZATION, HeaderValue::from_static("Share abc"));
        assert_eq!(share_token(&headers), Some("abc"));
        assert_eq!(preview_token(&headers), None);
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("preview xyz"),
        );
        assert_eq!(preview_token(&headers), Some("xyz"));
        assert_eq!(share_token(&headers), None);
        headers.append(header::AUTHORIZATION, HeaderValue::from_static("Share abc"));
        assert_eq!(share_token(&headers), None);
        assert_eq!(preview_token(&headers), None);
    }
}
