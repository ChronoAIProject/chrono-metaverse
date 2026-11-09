//! OpenAPI 文档（设计 8.3、14）。
//!
//! - 每个接口都写 `operationId`，小写加下划线；NyxID 把它变成 AI 工具名
//!   （`chrono-metaverse__get_space`）。
//! - `paths` 写完整路径（带 `/api` 前缀），NyxID 用注册地址拼路径，不看 `servers`。
//! - `/api/openapi.json` 是注册给 NyxID 的文档：**只包含 `/api/v1/*`，不含管理接口**，
//!   也不含公开读接口和健康检查，组件里只保留被引用到的结构。
//! - [`full_document`] 包含全部接口，供测试和以后生成网站、命令行的客户端用。

use std::collections::BTreeSet;
use std::sync::OnceLock;

use axum::{
    http::{header, HeaderValue},
    response::{IntoResponse, Response},
};
use serde_json::Value;
use utoipa::{
    openapi::security::{ApiKey, ApiKeyValue, SecurityScheme},
    Modify, OpenApi,
};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "chrono-metaverse API",
        description = "实体空间的数字孪生 + 虚拟扩展，按一条时间线记录和回放。写接口经 NyxID 代理调用，服务端校验 NyxID 身份令牌（X-NyxID-Identity-Token）。",
    ),
    paths(
        crate::health::healthz,
        serve,
        crate::routes::spaces::get_space,
        crate::routes::admin_spaces::create_space,
        crate::routes::public_spaces::get_public_space,
    ),
    modifiers(&IdentitySecurity),
    tags(
        (name = "spaces", description = "空间：查看"),
        (name = "admin", description = "管理接口（不进 AI 工具）"),
        (name = "public", description = "公开读接口（不经过 NyxID）"),
        (name = "health", description = "健康检查"),
    )
)]
pub struct ApiDoc;

struct IdentitySecurity;

impl Modify for IdentitySecurity {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            "nyxid_identity",
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::with_description(
                "X-NyxID-Identity-Token",
                "NyxID 代理注入的身份令牌（RS256，≤60 秒，一次性）",
            ))),
        );
    }
}

/// 全部接口。
pub fn full_document() -> Value {
    serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI 文档可以序列化")
}

/// 注册给 NyxID 的文档：只保留 `/api/v1/*` 中非管理接口，并去掉没被引用的结构。
pub fn nyxid_document() -> Value {
    let mut document = full_document();
    if let Some(paths) = document.get_mut("paths").and_then(Value::as_object_mut) {
        paths.retain(|path, _| path.starts_with("/api/v1/") && !path.starts_with("/api/v1/admin"));
    }
    prune_schemas(&mut document);
    document
}

fn collect_refs(value: &Value, refs: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, item) in map {
                if key == "$ref" {
                    if let Some(name) = item
                        .as_str()
                        .and_then(|r| r.strip_prefix("#/components/schemas/"))
                    {
                        refs.insert(name.to_owned());
                    }
                } else {
                    collect_refs(item, refs);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_refs(item, refs)),
        _ => {}
    }
}

fn prune_schemas(document: &mut Value) {
    let mut used = BTreeSet::new();
    collect_refs(&document["paths"], &mut used);
    let Some(schemas) = document
        .pointer_mut("/components/schemas")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    loop {
        let before = used.len();
        for name in used.clone() {
            if let Some(schema) = schemas.get(&name) {
                collect_refs(schema, &mut used);
            }
        }
        if used.len() == before {
            break;
        }
    }
    schemas.retain(|name, _| used.contains(name));
}

#[utoipa::path(
    get,
    path = "/api/openapi.json",
    operation_id = "get_openapi",
    tag = "health",
    responses((status = 200, description = "注册给 NyxID 的 OpenAPI 文档"))
)]
pub async fn serve() -> Response {
    static DOCUMENT: OnceLock<String> = OnceLock::new();
    let body = DOCUMENT
        .get_or_init(|| serde_json::to_string(&nyxid_document()).expect("可以序列化"))
        .clone();
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=300"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operations(document: &Value) -> Vec<(String, String)> {
        let mut found = Vec::new();
        for (path, item) in document["paths"].as_object().unwrap() {
            for (method, operation) in item.as_object().unwrap() {
                if ["get", "post", "put", "patch", "delete"].contains(&method.as_str()) {
                    found.push((
                        format!("{method} {path}"),
                        operation["operationId"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                    ));
                }
            }
        }
        found
    }

    #[test]
    fn every_operation_id_is_lower_snake_case() {
        let all = operations(&full_document());
        assert!(all.len() >= 4);
        for (operation, id) in all {
            assert!(
                !id.is_empty()
                    && id.starts_with(|c: char| c.is_ascii_lowercase())
                    && id
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "{operation}: {id:?}"
            );
        }
    }

    #[test]
    fn nyxid_document_has_only_non_admin_v1_paths() {
        let document = nyxid_document();
        let paths: Vec<_> = document["paths"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(paths, ["/api/v1/spaces/{space_id}"]);
        let schemas = document["components"]["schemas"].as_object().unwrap();
        assert!(schemas.contains_key("SpaceView"));
        assert!(schemas.contains_key("ProblemDocument"));
        assert!(!schemas.contains_key("CreateSpaceRequest"));
        assert!(!schemas.contains_key("PublicSpaceView"));
        assert!(document["components"]["securitySchemes"]["nyxid_identity"].is_object());
    }
}
