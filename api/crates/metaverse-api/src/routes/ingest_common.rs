//! 上传、任务、事件、组合接口共用的小工具：路径范围、错误码、缓存头、游标、请求头。

use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use metaverse_core::ids::is_object_id;
use metaverse_core::model::{Actor, ActorKind, RequestActor, Space};
use metaverse_core::scope::PathScope;
use metaverse_core::Timestamp;

use crate::auth::{Caller, Grant, PublicBasis};
use crate::error::ApiError;
use crate::repo::Cursor;
use crate::AppState;

/// 发起者（任务、上传会话）。
pub fn request_actor(caller: &Caller) -> RequestActor {
    RequestActor {
        sub: caller.subject.clone(),
        nyx_service_id: caller.service_id.clone(),
    }
}

/// 写入者（事件、组合修订）。
pub fn path_actor(caller: &Caller, scope: PathScope, kind: ActorKind) -> Actor {
    Actor {
        sub: caller.subject.clone(),
        nyx_service_id: caller.service_id.clone(),
        scope,
        kind,
    }
}

/// 路径上的地块编号 → 路径范围；地块必须存在于空间的当前地块里，否则 404。
/// 返回空间文档（调用方常常还要用到）。
pub async fn path_scope(
    state: &AppState,
    grant: &Grant,
    plot_id: Option<&str>,
) -> Result<(PathScope, Space), ApiError> {
    let space = state
        .repo
        .space(grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let scope = match plot_id {
        None => PathScope::Physical,
        Some(plot) => {
            if !is_object_id(plot) || !space.plots.iter().any(|p| p.id == plot) {
                return Err(ApiError::not_found());
            }
            PathScope::Plot(plot.to_owned())
        }
    };
    Ok((scope, space))
}

/// 403：请求内容与路径范围不一致（设计 9.4）。
pub fn scope_violation(detail: impl Into<std::borrow::Cow<'static, str>>) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "scope_violation", detail)
}

/// 429：超过并发或数量上限。
pub fn too_many(code: &'static str, detail: impl Into<std::borrow::Cow<'static, str>>) -> ApiError {
    ApiError::new(StatusCode::TOO_MANY_REQUESTS, code, detail)
}

/// 413：超过大小上限或配额。
pub fn too_large(
    code: &'static str,
    detail: impl Into<std::borrow::Cow<'static, str>>,
) -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, code, detail)
}

/// 422，带机器可读的错误码。
pub fn invalid_with(
    code: &'static str,
    detail: impl Into<std::borrow::Cow<'static, str>>,
) -> ApiError {
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, code, detail)
}

/// 409，带机器可读的错误码。
pub fn conflict_with(
    code: &'static str,
    detail: impl Into<std::borrow::Cow<'static, str>>,
) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, code, detail)
}

pub fn set_header(response: &mut Response, name: header::HeaderName, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        response.headers_mut().insert(name, value);
    }
}

/// `/api/v1` 的响应不缓存（含内部级数据，或是写操作的结果）。
pub fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

/// 公开读的缓存头（与 `public::headers::cache_control` 相同的规则，设计 8.2）：只有公开空间
/// 的内容才能被共享缓存，凭令牌的一律 `private`，预览不缓存。
pub fn public_cache(
    mut response: Response,
    grant_basis: Option<PublicBasis>,
    max_age: u32,
) -> Response {
    let value = match grant_basis {
        Some(PublicBasis::PublicVisibility) => format!("public, max-age={max_age}"),
        Some(PublicBasis::ShareToken) => format!("private, max-age={max_age}"),
        Some(PublicBasis::Preview) | None => crate::public::headers::NO_STORE.to_owned(),
    };
    set_header(&mut response, header::CACHE_CONTROL, &value);
    response
}

/// `If-Match: "<seq>"`（也接受不带引号的数字）。
pub fn if_match_seq(headers: &HeaderMap) -> Result<Option<u64>, ApiError> {
    let Some(value) = headers.get(header::IF_MATCH) else {
        return Ok(None);
    };
    let text = value
        .to_str()
        .map_err(|_| ApiError::invalid("If-Match 不是合法的文本"))?
        .trim();
    let text = text.strip_prefix("W/").unwrap_or(text).trim_matches('"');
    text.parse()
        .map(Some)
        .map_err(|_| ApiError::invalid("If-Match 必须是 seq，例如 \"3\""))
}

/// `Idempotency-Key`：1–200 个可见 ASCII 字符。
pub fn idempotency_key(headers: &HeaderMap) -> Result<Option<String>, ApiError> {
    let Some(value) = headers.get("idempotency-key") else {
        return Ok(None);
    };
    let text = value.to_str().unwrap_or_default().trim();
    if text.is_empty() || text.len() > 200 || !text.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(ApiError::invalid(
            "Idempotency-Key 必须是 1–200 个可见 ASCII 字符",
        ));
    }
    Ok(Some(text.to_owned()))
}

/// 分页游标：`base64url("<RFC 3339 时间>|<编号>")`，对调用方不透明。
pub fn encode_cursor(cursor: &Cursor) -> String {
    URL_SAFE_NO_PAD.encode(format!("{}|{}", cursor.at, cursor.id))
}

pub fn decode_cursor(text: &str) -> Result<Cursor, ApiError> {
    let invalid = || ApiError::invalid("after 游标无效");
    if text.len() > 512 {
        return Err(invalid());
    }
    let raw = URL_SAFE_NO_PAD.decode(text).map_err(|_| invalid())?;
    let raw = String::from_utf8(raw).map_err(|_| invalid())?;
    let (at, id) = raw.split_once('|').ok_or_else(invalid)?;
    if !is_object_id(id) {
        return Err(invalid());
    }
    Ok(Cursor {
        at: Timestamp::parse_rfc3339(at).map_err(|_| invalid())?,
        id: id.to_owned(),
    })
}

/// 可以省略的 JSON 请求体：空请求体按默认值处理。
pub fn optional_json<T: serde::de::DeserializeOwned + Default>(body: &[u8]) -> Result<T, ApiError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(T::default());
    }
    serde_json::from_slice(body)
        .map_err(|error| ApiError::invalid(format!("请求体不合法：{error}")))
}

/// 查询参数里的时间。
pub fn parse_time(name: &str, value: Option<&str>) -> Result<Option<Timestamp>, ApiError> {
    value
        .map(|text| {
            Timestamp::parse_rfc3339(text)
                .map_err(|_| ApiError::invalid(format!("{name} 必须是 RFC 3339 时间")))
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursors_round_trip_and_reject_garbage() {
        let cursor = Cursor {
            at: Timestamp::from_millis(1_762_603_200_123).unwrap(),
            id: "ev_0123".into(),
        };
        assert_eq!(decode_cursor(&encode_cursor(&cursor)).unwrap(), cursor);
        for bad in [
            "",
            "!!",
            &URL_SAFE_NO_PAD.encode("no-separator"),
            &URL_SAFE_NO_PAD.encode("2025-01-01T00:00:00Z|a/b"),
        ] {
            assert!(decode_cursor(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn if_match_forms() {
        let mut headers = HeaderMap::new();
        assert_eq!(if_match_seq(&headers).unwrap(), None);
        headers.insert(header::IF_MATCH, HeaderValue::from_static("\"7\""));
        assert_eq!(if_match_seq(&headers).unwrap(), Some(7));
        headers.insert(header::IF_MATCH, HeaderValue::from_static("W/\"8\""));
        assert_eq!(if_match_seq(&headers).unwrap(), Some(8));
        headers.insert(header::IF_MATCH, HeaderValue::from_static("abc"));
        assert!(if_match_seq(&headers).is_err());
    }
}
