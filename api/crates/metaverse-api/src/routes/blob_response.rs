//! 区块和资源的二进制响应、分段下载（`Range`），以及时间线接口共用的查询参数解析。
//!
//! - 区块：zlib 压缩的规范字节，`application/octet-stream`；
//! - 资源：Content-Type 由服务端按白名单固定（网页用模型 `model/gltf-binary`、贴图
//!   `image/jpeg|png|webp`，其余一律 `application/octet-stream`），并加 `nosniff`；
//!   支持单段 `Range: bytes=a-b`（多段时整份返回），不合法的范围返回 416。

use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use metaverse_core::{is_sha256_hex, Timestamp};

use crate::error::ApiError;
use crate::public::CacheKey;
use crate::repo::AssetMeta;
use crate::AppState;

/// 资源响应允许的 Content-Type。
const ASSET_TYPES: &[&str] = &["model/gltf-binary", "image/jpeg", "image/png", "image/webp"];

/// 按白名单固定的 Content-Type：有核对记录的按实测的格式（docs/design/server-slim.md 4.6），
/// 没有的旧资源按登记时写的 `contentType`。
pub fn asset_content_type(meta: &AssetMeta) -> &'static str {
    let declared = match &meta.check {
        Some(check) => metaverse_core::model::UploadFormat::from_name(check.body.format())
            .map(|format| format.content_type()),
        None => meta.content_type.as_deref(),
    };
    declared
        .and_then(|declared| ASSET_TYPES.iter().find(|allowed| **allowed == declared))
        .copied()
        .unwrap_or("application/octet-stream")
}

/// 路径里的内容哈希；`suffix` 是 `.bin` 这类必须带的扩展名。格式不对一律 404。
pub fn path_hash<'a>(segment: &'a str, suffix: &str) -> Result<&'a str, ApiError> {
    let hash = segment
        .strip_suffix(suffix)
        .ok_or_else(ApiError::not_found)?;
    if is_sha256_hex(hash) {
        Ok(hash)
    } else {
        Err(ApiError::not_found())
    }
}

fn binary_headers(response: &mut Response, content_type: &str, cache: HeaderValue) {
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(content_type) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::CACHE_CONTROL, cache);
}

/// 区块响应。
pub fn chunk_response(data: Bytes, cache: HeaderValue) -> Response {
    let mut response = (StatusCode::OK, data).into_response();
    binary_headers(&mut response, "application/octet-stream", cache);
    response
}

/// `Range` 不合法（返回 416）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidRange;

/// 解析单段 `Range`。`Ok(None)` 表示整份返回；`Err` 表示范围不合法（416）。
pub fn parse_range(headers: &HeaderMap, length: u64) -> Result<Option<(u64, u64)>, InvalidRange> {
    let Some(value) = headers.get(header::RANGE) else {
        return Ok(None);
    };
    let Some(spec) = value
        .to_str()
        .ok()
        .and_then(|v| v.trim().strip_prefix("bytes="))
    else {
        return Ok(None);
    };
    if spec.contains(',') {
        return Ok(None);
    }
    let (start, end) = spec.split_once('-').ok_or(InvalidRange)?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let suffix: u64 = suffix.parse().map_err(|_| InvalidRange)?;
            if suffix == 0 || length == 0 {
                return Err(InvalidRange);
            }
            (length.saturating_sub(suffix), length - 1)
        }
        (start, "") => (
            start.parse().map_err(|_| InvalidRange)?,
            length.saturating_sub(1),
        ),
        (start, end) => {
            let start: u64 = start.parse().map_err(|_| InvalidRange)?;
            let end: u64 = end.parse().map_err(|_| InvalidRange)?;
            (start, end.min(length.saturating_sub(1)))
        }
    };
    if start >= length || start > end {
        return Err(InvalidRange);
    }
    Ok(Some((start, end + 1)))
}

fn encode_cached(content_type: &str, data: &[u8]) -> Bytes {
    let mut encoded = Vec::with_capacity(content_type.len() + 1 + data.len());
    encoded.extend_from_slice(content_type.as_bytes());
    encoded.push(b'\n');
    encoded.extend_from_slice(data);
    Bytes::from(encoded)
}

fn decode_cached(encoded: &Bytes) -> Option<(&'static str, Bytes)> {
    let split = encoded.iter().position(|b| *b == b'\n')?;
    let declared = std::str::from_utf8(&encoded[..split]).ok()?;
    let content_type = ASSET_TYPES
        .iter()
        .chain(["application/octet-stream"].iter())
        .find(|allowed| **allowed == declared)
        .copied()?;
    Some((content_type, encoded.slice(split + 1..)))
}

/// 缓存里已有的资源（公开资源只缓存登记过的，命中就不必再查库）。
pub fn cached_asset(state: &AppState, hash: &str) -> Option<(&'static str, Bytes)> {
    state
        .public
        .cache
        .get(&CacheKey::Asset(hash.to_owned()))
        .and_then(|bytes| decode_cached(&bytes))
}

fn range_not_satisfiable(length: u64) -> Response {
    let mut response = ApiError::new(
        StatusCode::RANGE_NOT_SATISFIABLE,
        "range_not_satisfiable",
        "请求的字节范围不合法",
    )
    .into_response();
    if let Ok(value) = HeaderValue::from_str(&format!("bytes */{length}")) {
        response.headers_mut().insert(header::CONTENT_RANGE, value);
    }
    response
}

/// 整份内容已在内存里时的资源响应（支持分段）。
pub fn bytes_asset_response(
    data: Bytes,
    content_type: &str,
    request: &HeaderMap,
    cache: HeaderValue,
) -> Response {
    let length = data.len() as u64;
    let range = match parse_range(request, length) {
        Ok(range) => range,
        Err(InvalidRange) => return range_not_satisfiable(length),
    };
    let mut response = match range {
        None => (StatusCode::OK, data).into_response(),
        Some((start, end)) => {
            let mut response = (
                StatusCode::PARTIAL_CONTENT,
                data.slice(start as usize..end as usize),
            )
                .into_response();
            if let Ok(value) = HeaderValue::from_str(&format!("bytes {start}-{}/{length}", end - 1))
            {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            response
        }
    };
    binary_headers(&mut response, content_type, cache);
    response
        .headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response
}

/// 资源响应：不大的资源整份读入（`cache` 为真时放进进程内缓存），大的按数据块流式返回。
pub async fn asset_response(
    state: &AppState,
    meta: &AssetMeta,
    request: &HeaderMap,
    cache_control: HeaderValue,
    cache: bool,
) -> Result<Response, ApiError> {
    let content_type = asset_content_type(meta);
    let max_item = state.public.cache.max_item_bytes() as u64;
    if cache && meta.length <= max_item {
        let data = Bytes::from(state.repo.read_asset_bytes(meta, max_item).await?);
        state.public.cache.insert(
            &CacheKey::Asset(meta.hash.clone()),
            encode_cached(content_type, &data),
        );
        return Ok(bytes_asset_response(
            data,
            content_type,
            request,
            cache_control,
        ));
    }
    let length = meta.length;
    let range = match parse_range(request, length) {
        Ok(range) => range,
        Err(InvalidRange) => return Ok(range_not_satisfiable(length)),
    };
    let (start, end) = range.unwrap_or((0, length));
    let stream = state.repo.asset_stream(meta, start, end).await?;
    let status = if range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let mut response = (status, Body::from_stream(stream)).into_response();
    binary_headers(&mut response, content_type, cache_control);
    let headers = response.headers_mut();
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Ok(value) = HeaderValue::from_str(&(end - start).to_string()) {
        headers.insert(header::CONTENT_LENGTH, value);
    }
    if range.is_some() {
        if let Ok(value) = HeaderValue::from_str(&format!("bytes {start}-{}/{length}", end - 1)) {
            headers.insert(header::CONTENT_RANGE, value);
        }
    }
    Ok(response)
}

// ---------------------------------------------------------------------------
// 查询参数
// ---------------------------------------------------------------------------

/// 时间参数（RFC 3339）。
pub fn parse_time(name: &str, value: Option<&str>) -> Result<Option<Timestamp>, ApiError> {
    value
        .filter(|v| !v.is_empty())
        .map(|v| {
            Timestamp::parse_rfc3339(v)
                .map_err(|_| ApiError::invalid(format!("{name} 必须是 RFC 3339 时间")))
        })
        .transpose()
}

/// 非负整数参数（seq、游标）。
pub fn parse_seq(name: &str, value: Option<&str>) -> Result<Option<u64>, ApiError> {
    value
        .filter(|v| !v.is_empty())
        .map(|v| {
            v.parse::<u64>()
                .ok()
                .filter(|seq| *seq <= i64::MAX as u64)
                .ok_or_else(|| ApiError::invalid(format!("{name} 必须是非负整数")))
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn range(value: &str, length: u64) -> Result<Option<(u64, u64)>, InvalidRange> {
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_str(value).unwrap());
        parse_range(&headers, length)
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range(&HeaderMap::new(), 10), Ok(None));
        assert_eq!(range("bytes=0-3", 10), Ok(Some((0, 4))));
        assert_eq!(range("bytes=5-", 10), Ok(Some((5, 10))));
        assert_eq!(range("bytes=-3", 10), Ok(Some((7, 10))));
        assert_eq!(range("bytes=8-100", 10), Ok(Some((8, 10))));
        assert_eq!(range("bytes=0-1,4-5", 10), Ok(None));
        assert_eq!(range("items=0-1", 10), Ok(None));
        assert_eq!(range("bytes=10-", 10), Err(InvalidRange));
        assert_eq!(range("bytes=5-2", 10), Err(InvalidRange));
        assert_eq!(range("bytes=-0", 10), Err(InvalidRange));
        assert_eq!(range("bytes=x-1", 10), Err(InvalidRange));
    }

    #[test]
    fn cached_assets_keep_their_type() {
        let encoded = encode_cached("image/png", b"\x89PNG");
        let (content_type, data) = decode_cached(&encoded).unwrap();
        assert_eq!(content_type, "image/png");
        assert_eq!(&data[..], b"\x89PNG");
    }

    #[test]
    fn hashes_in_paths() {
        let hash = "a".repeat(64);
        assert_eq!(path_hash(&format!("{hash}.bin"), ".bin").unwrap(), hash);
        assert!(path_hash(&hash, ".bin").is_err());
        assert_eq!(path_hash(&hash, "").unwrap(), hash);
        assert!(path_hash("ABC.bin", ".bin").is_err());
    }
}
