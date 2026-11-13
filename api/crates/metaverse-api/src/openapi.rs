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
    extract::Query,
    http::{header, HeaderValue},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
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
        crate::routes::external::get_public_external,
        crate::routes::external::get_preview_external,
        serve,
        agent_guide,
        crate::routes::spaces::get_space,
        crate::routes::admin_spaces::create_space,
        crate::routes::public_spaces::get_public_space,
        // 上传、任务、事件、组合
        crate::routes::uploads::create_upload,
        crate::routes::uploads::create_plot_upload,
        crate::routes::uploads::put_upload_part,
        crate::routes::uploads::put_plot_upload_part,
        crate::routes::uploads::complete_upload,
        crate::routes::uploads::complete_plot_upload,
        crate::routes::uploads::get_upload,
        crate::routes::uploads::get_plot_upload,
        crate::routes::jobs::get_job,
        crate::routes::jobs::get_plot_job,
        crate::routes::jobs::list_jobs,
        crate::routes::jobs::list_plot_jobs,
        // 重建路径（docs/design/server-slim.md 2.3）
        crate::routes::rebuild::create_rebuild_upload,
        crate::routes::rebuild::upload_rebuild_part,
        crate::routes::rebuild::complete_rebuild_upload,
        crate::routes::rebuild::get_rebuild_upload,
        crate::routes::rebuild::create_rebuild_draft,
        crate::routes::rebuild::get_rebuild_draft,
        crate::routes::rebuild::apply_rebuild_bundle,
        crate::routes::rebuild::moves::move_rebuild_entities,
        crate::routes::rebuild::create_rebuild_draft_preview,
        crate::routes::rebuild::publish_rebuild_draft,
        crate::routes::rebuild::discard_rebuild_draft,
        crate::routes::rebuild::list_rebuild_jobs,
        crate::routes::rebuild::get_rebuild_job,
        crate::routes::events::write_events,
        crate::routes::events::write_corrections,
        crate::routes::events::list_events,
        crate::routes::events::list_event_types,
        crate::routes::admin_events::register_event_type,
        crate::routes::admin_events::redact_event,
        crate::routes::public_events::get_public_head,
        crate::routes::public_events::list_public_events,
        crate::routes::public_events::get_public_event_density,
        crate::routes::public_events::get_public_state,
        crate::routes::universes::create_universe,
        crate::routes::universes::get_universe,
        crate::routes::universes::update_universe,
        crate::routes::universes::join_universe,
        crate::routes::universes::leave_universe,
        crate::routes::public_universes::get_public_universe,
        crate::routes::public_universes::get_public_universe_revision,
        // 时间线与公开读分工
        crate::routes::timeline::list_timeline,
        crate::routes::timeline::get_snapshot,
        crate::routes::timeline::get_chunk,
        crate::routes::timeline::get_asset,
        crate::routes::timeline::get_region_content,
        crate::routes::drafts::create_draft,
        crate::routes::drafts::create_plot_draft,
        crate::routes::drafts::get_draft,
        crate::routes::drafts::get_plot_draft,
        crate::routes::drafts::append_draft_ops,
        crate::routes::drafts::append_plot_draft_ops,
        crate::routes::drafts::draft_ops_from_upload,
        crate::routes::drafts::plot_draft_ops_from_upload,
        crate::routes::drafts::create_draft_preview,
        crate::routes::drafts::create_plot_draft_preview,
        crate::routes::drafts::publish_draft,
        crate::routes::drafts::publish_plot_draft,
        crate::routes::drafts::discard_draft,
        crate::routes::drafts::discard_plot_draft,
        crate::routes::admin_space_settings::update_space,
        crate::routes::admin_space_settings::rotate_share_token,
        crate::routes::admin_space_settings::set_layout,
        crate::routes::admin_space_settings::delete_space,
        crate::routes::public_timeline::get_public_snapshot,
        crate::routes::public_timeline::get_public_timeline,
        crate::routes::public_timeline::get_public_chunk,
        crate::routes::public_timeline::get_public_asset,
        crate::routes::previews::get_preview,
        crate::routes::previews::get_preview_chunk,
        crate::routes::previews::get_preview_asset,
    ),
    modifiers(&IdentitySecurity),
    tags(
        (name = "spaces", description = "空间：查看"),
        (name = "uploads", description = "分片上传"),
        (name = "jobs", description = "任务查询：上传核对、操作文件追加、交包、部署种子导入"),
        (name = "events", description = "现实事件"),
        (name = "universes", description = "组合宇宙"),
        (name = "timeline", description = "时间线：提交列表、快照、区块、区域内容"),
        (name = "drafts", description = "草稿：建草稿、批量操作、预览、发布（实体区和地块两组路径）"),
        (name = "rebuild", description = "重建路径：上传、重建草稿（只收一个重建包）、交包、预览、发布、任务查询；写操作要求 metaverse:rebuild:write"),
        (name = "admin", description = "管理接口（不进 AI 工具）"),
        (name = "public", description = "公开读接口（不经过 NyxID）"),
        (name = "health", description = "健康检查"),
    )
)]
pub struct ApiDoc;

/// 编辑空间前先读取本指南，了解草稿操作、短期预览及明确确认后发布的协议。
#[utoipa::path(
    get,
    path = "/api/v1/agent-guide",
    operation_id = "get_agent_guide",
    tag = "drafts",
    responses((status = 200, description = "空间编辑协议；不授予权限，也不能替代用户的发布确认", body = String, content_type = "text/markdown"))
)]
pub async fn agent_guide() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/markdown; charset=utf-8")],
        include_str!("../resources/agent-guide.md"),
    )
}

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

/// Concrete space paths let custom NyxID connections discover tools while the Key's
/// operation rules enforce that same literal space. This document grants no access.
fn space_document(space_id: &str) -> Result<Value, crate::error::ApiError> {
    if !metaverse_core::ids::is_space_id(space_id) {
        return Err(crate::error::ApiError::invalid("spaceId 格式不对"));
    }
    let mut document = nyxid_document();
    let paths = document["paths"].as_object_mut().expect("paths");
    let original = std::mem::take(paths);
    for (path, mut item) in original {
        if path == "/api/v1/agent-guide" {
            paths.insert(path, item);
        } else if path.starts_with("/api/v1/spaces/{space_id}") {
            // Utoipa emits parameters on operations; also handle path-level parameters.
            fn remove_space_parameter(value: &mut Value) {
                if let Some(parameters) = value.get_mut("parameters").and_then(Value::as_array_mut)
                {
                    parameters.retain(|p| p["in"] != "path" || p["name"] != "space_id");
                }
            }
            remove_space_parameter(&mut item);
            if let Some(operations) = item.as_object_mut() {
                for operation in operations.values_mut() {
                    remove_space_parameter(operation);
                }
            }
            paths.insert(path.replace("{space_id}", space_id), item);
        }
    }
    prune_schemas(&mut document);
    Ok(document)
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

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentQuery {
    space_id: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/openapi.json",
    operation_id = "get_openapi",
    tag = "health",
    params(("spaceId" = Option<String>, Query, description = "可选：把空间路径固定到此编号，配合 NyxID Key 字面路径规则限制范围；文档本身不授予权限")),
    responses((status = 200, description = "注册给 NyxID 的 OpenAPI 文档"))
)]
pub async fn serve(Query(query): Query<DocumentQuery>) -> Result<Response, crate::error::ApiError> {
    static DOCUMENT: OnceLock<String> = OnceLock::new();
    let body = match query.space_id {
        Some(id) => serde_json::to_string(&space_document(&id)?).expect("可以序列化"),
        None => DOCUMENT
            .get_or_init(|| serde_json::to_string(&nyxid_document()).expect("可以序列化"))
            .clone(),
    };
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
    Ok(response)
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

    /// 预览响应 = 快照 + spaceName + preview（网站 `PreviewView`）。
    #[test]
    fn preview_response_schema_has_space_name_and_draft_info() {
        let document = full_document();
        let schema =
            serde_json::to_string(&document["components"]["schemas"]["PreviewSnapshotView"])
                .unwrap();
        for part in ["SnapshotView", "spaceName", "PreviewInfoView"] {
            assert!(schema.contains(part), "{part}: {schema}");
        }
        let info = &document["components"]["schemas"]["PreviewInfoView"]["properties"];
        for field in ["draftId", "rev", "baseSeq", "scope", "expiresAt"] {
            assert!(info.get(field).is_some(), "{field}");
        }
        let response = &document["paths"]["/api/public/previews"]["get"]["responses"]["200"];
        assert!(response.to_string().contains("PreviewSnapshotView"));
    }

    /// 重建路径都在注册给 NyxID 的文档里（docs/design/server-slim.md 2.3）。
    #[test]
    fn rebuild_operations_are_registered() {
        let document = nyxid_document();
        let all = operations(&document);
        let expected = [
            (
                "post /api/v1/spaces/{space_id}/rebuild/uploads/{purpose}",
                "create_rebuild_upload",
            ),
            (
                "put /api/v1/spaces/{space_id}/rebuild/uploads/{purpose}/{upload_id}/parts/{n}",
                "upload_rebuild_part",
            ),
            (
                "post /api/v1/spaces/{space_id}/rebuild/uploads/{purpose}/{upload_id}/complete",
                "complete_rebuild_upload",
            ),
            (
                "get /api/v1/spaces/{space_id}/rebuild/uploads/{purpose}/{upload_id}",
                "get_rebuild_upload",
            ),
            (
                "post /api/v1/spaces/{space_id}/rebuild/drafts",
                "create_rebuild_draft",
            ),
            (
                "get /api/v1/spaces/{space_id}/rebuild/drafts/{draft_id}",
                "get_rebuild_draft",
            ),
            (
                "post /api/v1/spaces/{space_id}/rebuild/drafts/{draft_id}/bundle",
                "apply_rebuild_bundle",
            ),
            (
                "post /api/v1/spaces/{space_id}/rebuild/drafts/{draft_id}/moves",
                "move_rebuild_entities",
            ),
            (
                "post /api/v1/spaces/{space_id}/rebuild/drafts/{draft_id}/preview",
                "create_rebuild_draft_preview",
            ),
            (
                "post /api/v1/spaces/{space_id}/rebuild/drafts/{draft_id}/publish",
                "publish_rebuild_draft",
            ),
            (
                "delete /api/v1/spaces/{space_id}/rebuild/drafts/{draft_id}",
                "discard_rebuild_draft",
            ),
            (
                "get /api/v1/spaces/{space_id}/rebuild/jobs",
                "list_rebuild_jobs",
            ),
            (
                "get /api/v1/spaces/{space_id}/rebuild/jobs/{job_id}",
                "get_rebuild_job",
            ),
        ];
        for (operation, id) in expected {
            assert!(
                all.iter().any(|(op, found)| op == operation && found == id),
                "{operation} {id}"
            );
        }
        let rebuild: Vec<_> = all
            .iter()
            .filter(|(op, _)| op.contains("/rebuild/"))
            .collect();
        assert_eq!(rebuild.len(), 13, "{rebuild:?}");
        // 写操作都声明了身份令牌。
        let body = &document["paths"]["/api/v1/spaces/{space_id}/rebuild/drafts/{draft_id}/bundle"]
            ["post"];
        assert!(body["security"].to_string().contains("nyxid_identity"));
        assert!(document["components"]["schemas"]
            .get("ApplyBundleRequest")
            .is_some());
    }

    #[test]
    fn scoped_discovery_preserves_operations_without_a_widening_space_argument() {
        let document = space_document("test-lobby").unwrap();
        let paths = document["paths"].as_object().unwrap();
        assert!(paths
            .keys()
            .all(|p| p == "/api/v1/agent-guide" || p.starts_with("/api/v1/spaces/test-lobby")));
        let movement = &paths["/api/v1/spaces/test-lobby/rebuild/drafts/{draft_id}/moves"]["post"];
        assert_eq!(movement["operationId"], "move_rebuild_entities");
        let parameters = movement["parameters"].as_array().unwrap();
        assert!(parameters.iter().any(|p| p["name"] == "draft_id"));
        assert!(!parameters.iter().any(|p| p["name"] == "space_id"));
        assert!(movement["security"].to_string().contains("nyxid_identity"));
        assert!(movement["requestBody"]
            .to_string()
            .contains("MoveEntitiesRequest"));
        for invalid in ["../other", "test-lobby/../other", "{space_id}", "ab", ""] {
            assert!(space_document(invalid).is_err());
        }
        assert!(nyxid_document()["paths"]
            .get("/api/v1/spaces/{space_id}")
            .is_some());
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
        assert!(paths.contains(&"/api/v1/spaces/{space_id}".to_owned()));
        assert!(paths.contains(&"/api/v1/spaces/{space_id}/sources/{source}/events".to_owned()));
        assert!(paths.contains(&"/api/v1/spaces/{space_id}/drafts/{draft_id}/publish".to_owned()));
        // 命令行 pull 下载网页用模型、原始扫描用（设计 8.2）。
        assert!(paths.contains(&"/api/v1/spaces/{space_id}/assets/{hash}".to_owned()));
        assert_eq!(
            document["paths"]["/api/v1/spaces/{space_id}/assets/{hash}"]["get"]["operationId"],
            "get_asset"
        );
        assert!(paths
            .iter()
            .all(|p| p.starts_with("/api/v1/") && !p.starts_with("/api/v1/admin")));
        let schemas = document["components"]["schemas"].as_object().unwrap();
        assert!(schemas.contains_key("SpaceView"));
        assert!(schemas.contains_key("ProblemDocument"));
        assert!(!schemas.contains_key("CreateSpaceRequest"));
        assert!(!schemas.contains_key("PublicSpaceView"));
        assert!(document["components"]["securitySchemes"]["nyxid_identity"].is_object());
    }
}
