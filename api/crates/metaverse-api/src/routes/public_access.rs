//! 公开读接口的访问方式（设计 8.2）：
//!
//! 1. 公开空间：不需要令牌；
//! 2. 凭链接查看的空间：`Authorization: Share <空间的分享令牌>`；
//! 3. **凭组合的分享令牌**：`Authorization: Share <组合的分享令牌>` + 查询参数
//!    `?universe=<组合编号>`。服务端校验令牌属于这个组合，并且该空间在相关时刻是组合成员：
//!    - 按时刻（`state?at=`、`/head`、增量事件）：T 时刻是成员（取 `at ≤ T` 的最后一条修订）；
//!    - 空间信息（不按时刻索引）：`[纪元, now]` 里某个时刻是成员；现在已不是成员时只给名称、
//!      事件显示规则这类信息，不给离开之后的区域、地块、锚点；
//!    - 按时间段（时间窗事件、密度、提交列表）：这段时间里某个时刻是成员；
//!    - 按版本（快照 `?seq=`）：这个版本生效的时间段里某个时刻是成员。
//!
//! 通过检查后，凭据带着该空间的**成员期**（`Grant::membership`）：提交列表、事件、密度只返回
//! `at` 落在成员期里的记录（加入之前、离开之后的都不返回）。成员期只算空间这一次创建之后
//! 开始的时间段（同编号重建的空间不继承旧空间的成员资格）；组合因为公开而可读（没带令牌）时，
//! 成员空间本身也必须现在是公开的。
//!
//! 没带令牌、令牌无效、不是成员一律 404，拒绝响应不缓存（错误响应都是 `no-store`）。
//! 成功响应凭令牌的一律 `Cache-Control: private`。区块和资源按内容哈希读取，本来就不校验
//! 令牌（已发布 / 已登记即可读），不需要接入。
//!
//! 校验本身在 `auth/authorizer/universes.rs`：`Authorizer::public_space_via_universe`、
//! `public_space_via_universe_during`、`public_space_via_universe_for_seq`。

use axum::{
    extract::FromRequestParts,
    http::{request::Parts, HeaderMap},
};
use metaverse_core::ids::is_space_id;
use metaverse_core::Timestamp;
use serde::Deserialize;
use std::ops::Deref;
use utoipa::IntoParams;

use crate::auth::Grant;
use crate::error::ApiError;
pub use crate::public::headers::share_token;
use crate::AppState;

/// Headers plus an unforgeable, request-local grant from the browser viewer middleware.
/// Client-supplied headers can never create this grant.
pub struct ViewerHeaders {
    headers: HeaderMap,
    grant: Option<Grant>,
}
impl Deref for ViewerHeaders {
    type Target = HeaderMap;
    fn deref(&self) -> &HeaderMap {
        &self.headers
    }
}
impl<S: Send + Sync> FromRequestParts<S> for ViewerHeaders {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        Ok(Self {
            headers: parts.headers.clone(),
            grant: parts
                .extensions
                .get::<crate::auth::oauth::catalog::BrowserViewerGrant>()
                .map(|g| g.0.clone()),
        })
    }
}
impl ViewerHeaders {
    pub fn browser_grant(
        &self,
        space_id: &str,
        universe: Option<&str>,
    ) -> Result<Option<Grant>, ApiError> {
        if let Some(grant) = &self.grant {
            if grant.space_id() != space_id || universe.is_some() {
                return Err(ApiError::not_found());
            }
        }
        Ok(self.grant.clone())
    }
}

/// 凭组合的分享令牌读取时的组合编号。
#[derive(Debug, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct UniverseParam {
    /// 组合编号；同时要带 `Authorization: Share <组合的分享令牌>`。
    pub universe: Option<String>,
}

fn universe_id(universe: Option<&str>) -> Result<Option<&str>, ApiError> {
    match universe {
        Some(id) if !is_space_id(id) => Err(ApiError::not_found()),
        other => Ok(other),
    }
}

/// 公开读某个空间（按时刻 `at` 判断组合成员资格）。
pub async fn public_space_grant(
    state: &AppState,
    space_id: &str,
    headers: &ViewerHeaders,
    universe: Option<&str>,
    at: Timestamp,
) -> Result<Grant, ApiError> {
    if let Some(grant) = headers.browser_grant(space_id, universe)? {
        return Ok(grant);
    }
    match universe_id(universe)? {
        Some(universe_id) => {
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

/// 公开读某个空间不按时刻索引的信息（空间信息）。凭组合令牌时要求 `[纪元, now]` 里某个时刻
/// 是成员（与不带时间段的提交列表相同）。返回凭据和"现在是否仍可见"：不经组合时总是 `true`；
/// 经组合时表示该空间现在仍是组合成员。
pub async fn public_space_grant_ever(
    state: &AppState,
    space_id: &str,
    headers: &ViewerHeaders,
    universe: Option<&str>,
    now: Timestamp,
) -> Result<(Grant, bool), ApiError> {
    if let Some(grant) = headers.browser_grant(space_id, universe)? {
        return Ok((grant, true));
    }
    match universe_id(universe)? {
        Some(universe_id) => {
            state
                .authorizer
                .public_space_via_universe_ever(space_id, universe_id, share_token(headers), now)
                .await
        }
        None => state
            .authorizer
            .public_space(space_id, share_token(headers))
            .await
            .map(|grant| (grant, true)),
    }
}

/// 公开读某个空间一段时间 `[from, to]` 里的数据。
pub async fn public_space_grant_during(
    state: &AppState,
    space_id: &str,
    headers: &ViewerHeaders,
    universe: Option<&str>,
    from: Timestamp,
    to: Timestamp,
) -> Result<Grant, ApiError> {
    if let Some(grant) = headers.browser_grant(space_id, universe)? {
        return Ok(grant);
    }
    match universe_id(universe)? {
        Some(universe_id) => {
            state
                .authorizer
                .public_space_via_universe_during(
                    space_id,
                    universe_id,
                    share_token(headers),
                    from,
                    to,
                )
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

/// 公开读某个空间的第 seq 个版本。
pub async fn public_space_grant_for_seq(
    state: &AppState,
    space_id: &str,
    headers: &ViewerHeaders,
    universe: Option<&str>,
    seq: u64,
) -> Result<Grant, ApiError> {
    if let Some(grant) = headers.browser_grant(space_id, universe)? {
        return Ok(grant);
    }
    match universe_id(universe)? {
        Some(universe_id) => {
            state
                .authorizer
                .public_space_via_universe_for_seq(space_id, universe_id, share_token(headers), seq)
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
