//! 公开读接口的访问方式（设计 8.2）：
//!
//! 1. 公开空间：不需要令牌；
//! 2. 凭链接查看的空间：`Authorization: Share <空间的分享令牌>`；
//! 3. **凭组合的分享令牌**：`Authorization: Share <组合的分享令牌>` + 查询参数
//!    `?universe=<组合编号>`。服务端校验令牌属于这个组合，并且该空间在 T 时刻是组合成员
//!    （T 由各接口决定：`state?at=` 用 at，时间窗用 `min(to, 现在)`，其余用现在）。
//!
//! 没带令牌、令牌无效、不是成员一律 404，拒绝响应不缓存（错误响应都是 `no-store`）。
//! 成功响应凭令牌的一律 `Cache-Control: private`。
//!
//! 其他公开接口（快照、提交列表等）接入组合令牌时，调用 [`public_space_grant`] 即可；
//! 校验本身在 `Authorizer::public_space_via_universe`（`auth/authorizer/universes.rs`）。

use axum::http::{header, HeaderMap};
use metaverse_core::ids::is_space_id;
use metaverse_core::Timestamp;

use crate::auth::Grant;
use crate::error::ApiError;
use crate::AppState;

/// `Authorization: Share <令牌>`。头只能出现一次；别的认证方案一律忽略。
pub fn share_token(headers: &HeaderMap) -> Option<&str> {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    let (scheme, token) = value.to_str().ok()?.split_once(' ')?;
    scheme.eq_ignore_ascii_case("share").then_some(token.trim())
}

/// 公开读某个空间的授权凭据：带 `universe` 时凭组合令牌（要求 T 时刻是成员），
/// 否则凭空间自己的可见性或分享令牌。
pub async fn public_space_grant(
    state: &AppState,
    space_id: &str,
    headers: &HeaderMap,
    universe: Option<&str>,
    at: Timestamp,
) -> Result<Grant, ApiError> {
    match universe {
        Some(universe_id) => {
            if !is_space_id(universe_id) {
                return Err(ApiError::not_found());
            }
            state
                .authorizer
                .public_space_via_universe(space_id, universe_id, share_token(headers), at)
                .await
        }
        None => {
            state
                .authorizer
                .public_space(space_id, share_token(headers))
                .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn only_one_share_header() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, HeaderValue::from_static("Share abc"));
        assert_eq!(share_token(&headers), Some("abc"));
        headers.append(header::AUTHORIZATION, HeaderValue::from_static("Share def"));
        assert_eq!(share_token(&headers), None);
    }
}
