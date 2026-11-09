//! 公开读接口的访问方式（设计 8.2）：
//!
//! 1. 公开空间：不需要令牌；
//! 2. 凭链接查看的空间：`Authorization: Share <空间的分享令牌>`；
//! 3. **凭组合的分享令牌**：`Authorization: Share <组合的分享令牌>` + 查询参数
//!    `?universe=<组合编号>`。服务端校验令牌属于这个组合，并且该空间在相关时刻是组合成员：
//!    - 按时刻（`state?at=`、`/head`、增量事件）：T 时刻是成员（取 `at ≤ T` 的最后一条修订）；
//!    - 按时间段（时间窗事件、密度、提交列表）：这段时间里某个时刻是成员；
//!    - 按版本（快照 `?seq=`）：这个版本生效的时间段里某个时刻是成员。
//!
//! 没带令牌、令牌无效、不是成员一律 404，拒绝响应不缓存（错误响应都是 `no-store`）。
//! 成功响应凭令牌的一律 `Cache-Control: private`。区块和资源按内容哈希读取，本来就不校验
//! 令牌（已发布 / 已登记即可读），不需要接入。
//!
//! 校验本身在 `auth/authorizer/universes.rs`：`Authorizer::public_space_via_universe`、
//! `public_space_via_universe_during`、`public_space_via_universe_for_seq`。

use axum::http::HeaderMap;
use metaverse_core::ids::is_space_id;
use metaverse_core::Timestamp;
use serde::Deserialize;
use utoipa::IntoParams;

use crate::auth::Grant;
use crate::error::ApiError;
pub use crate::public::headers::share_token;
use crate::AppState;

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
    headers: &HeaderMap,
    universe: Option<&str>,
    at: Timestamp,
) -> Result<Grant, ApiError> {
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

/// 公开读某个空间一段时间 `[from, to]` 里的数据。
pub async fn public_space_grant_during(
    state: &AppState,
    space_id: &str,
    headers: &HeaderMap,
    universe: Option<&str>,
    from: Timestamp,
    to: Timestamp,
) -> Result<Grant, ApiError> {
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
    headers: &HeaderMap,
    universe: Option<&str>,
    seq: u64,
) -> Result<Grant, ApiError> {
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
