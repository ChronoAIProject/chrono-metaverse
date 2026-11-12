//! 来源来自已授权的物件，不能由请求者临时声明代理范围。
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::Value;
use url::Url;

use crate::error::ApiError;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CachePolicy {
    pub persist: Option<bool>,
    pub max_age_seconds: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct Source {
    root: Url,
    prefixes: Vec<Url>,
    template: Option<String>,
    zoom: (u64, u64),
    pub cache: CachePolicy,
    pub max_bytes: usize,
}

pub fn https(value: &str) -> Result<Url, ApiError> {
    let url = Url::parse(value).map_err(|_| ApiError::invalid("外部资源地址无效"))?;
    if value.len() > 2000
        || value.chars().any(char::is_whitespace)
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || url.port_or_known_default() != Some(443)
    {
        return Err(ApiError::invalid(
            "外部资源必须使用不含凭据的标准 HTTPS 地址",
        ));
    }
    // 拒绝编码后的分隔符、点和二次转义，避免代理路径规范化产生不同范围。
    let path = url.path().to_ascii_lowercase();
    if ["%2f", "%5c", "%2e", "%25"]
        .iter()
        .any(|s| path.contains(s))
    {
        return Err(ApiError::invalid("外部资源路径含有不支持的转义"));
    }
    Ok(url)
}

impl Source {
    pub fn from_entity(entity: &Value, kind: &str, index: usize) -> Result<Self, ApiError> {
        let props = &entity["props"];
        if props["background"] != true {
            return Err(ApiError::not_found());
        }
        let (config, sources, field, max_bytes) = match kind {
            "content" => {
                let config = &props["externalContent"];
                if config["format"] != "3d-tiles" && config["format"] != "mvt" {
                    return Err(ApiError::not_found());
                }
                (
                    config,
                    &config["sources"],
                    "url",
                    if config["format"] == "mvt" {
                        8 * 1024 * 1024
                    } else {
                        32 * 1024 * 1024
                    },
                )
            }
            "map" => {
                let config = &props["environment"];
                (
                    config,
                    &config["map"]["sources"],
                    "urlTemplate",
                    8 * 1024 * 1024,
                )
            }
            _ => return Err(ApiError::invalid("未知的外部来源类型")),
        };
        if config["version"] != 1 {
            return Err(ApiError::not_found());
        }
        let sources = sources
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 4)
            .ok_or_else(ApiError::not_found)?;
        let raw = sources.get(index).ok_or_else(ApiError::not_found)?;
        if raw["delivery"] != "server"
            || raw["attribution"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty() || s.len() > 2000)
        {
            return Err(ApiError::not_found());
        }
        https(raw["page"].as_str().ok_or_else(ApiError::not_found)?)?;
        let value = raw[field].as_str().ok_or_else(ApiError::not_found)?;
        let root = https(value)?;
        let mut prefixes = Vec::new();
        if kind == "content" {
            // TileJSON 可以位于域名根目录；其瓦片目录必须显式声明，不能开放整个域名。
            if config["format"] == "3d-tiles" {
                prefixes.push(
                    root.join(".")
                        .map_err(|_| ApiError::invalid("来源目录无效"))?,
                );
            }
            if let Some(values) = raw.get("resourcePrefixes") {
                let values = values
                    .as_array()
                    .filter(|v| v.len() <= 8)
                    .ok_or_else(|| ApiError::invalid("依赖目录最多八个"))?;
                for value in values {
                    let prefix = https(
                        value
                            .as_str()
                            .ok_or_else(|| ApiError::invalid("依赖目录无效"))?,
                    )?;
                    if !prefix.path().ends_with('/') || prefix.query().is_some() {
                        return Err(ApiError::invalid("依赖目录必须以 / 结束且不带查询参数"));
                    }
                    prefixes.push(prefix);
                }
            }
        }
        let cache: CachePolicy = serde_json::from_value(
            raw.get("cache")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        )
        .map_err(|_| ApiError::invalid("缓存配置无效"))?;
        if cache.max_age_seconds.is_some_and(|age| age > 604800) {
            return Err(ApiError::invalid("缓存期最多七天"));
        }
        let zoom = if kind == "map" {
            let min = raw["minZoom"]
                .as_u64()
                .ok_or_else(|| ApiError::invalid("地图层级无效"))?;
            let max = raw["maxZoom"]
                .as_u64()
                .filter(|max| *max >= min && *max <= 20)
                .ok_or_else(|| ApiError::invalid("地图层级无效"))?;
            if !["{x}", "{y}", "{z}"].iter().all(|key| value.contains(key)) {
                return Err(ApiError::invalid("地图模板无效"));
            }
            (min, max)
        } else {
            (0, 0)
        };
        Ok(Self {
            root,
            prefixes,
            template: (kind == "map").then(|| value.to_owned()),
            zoom,
            cache,
            max_bytes,
        })
    }

    pub fn allows(&self, url: &Url) -> bool {
        if let Some(template) = &self.template {
            // 精确匹配模板的三个数字，而非给整个地图域名开放代理。
            let mut values = [None; 3];
            let mut pattern = template.as_str();
            let mut input = url.as_str();
            loop {
                let next = ["{z}", "{x}", "{y}"]
                    .iter()
                    .enumerate()
                    .filter_map(|(i, key)| pattern.find(key).map(|pos| (pos, i)))
                    .min();
                let Some((pos, i)) = next else {
                    break;
                };
                if !input.starts_with(&pattern[..pos]) {
                    return false;
                }
                input = &input[pos..];
                let count = input.bytes().take_while(u8::is_ascii_digit).count();
                if count == 0 || count > 7 || values[i].is_some() {
                    return false;
                }
                values[i] = input[..count].parse::<u64>().ok();
                input = &input[count..];
                pattern = &pattern[pos + 3..];
            }
            let [Some(z), Some(x), Some(y)] = values else {
                return false;
            };
            return input == pattern
                && (self.zoom.0..=self.zoom.1).contains(&z)
                && x < 1 << z
                && y < 1 << z;
        }
        url == &self.root
            || self.prefixes.iter().any(|prefix| {
                url.origin() == prefix.origin() && url.path().starts_with(prefix.path())
            })
    }

    pub fn checked(&self, value: &str) -> Result<Url, ApiError> {
        let url = https(value)?;
        if !self.allows(&url) {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "external_scope",
                "资源不在空间声明的来源范围内",
            ));
        }
        Ok(url)
    }
}
