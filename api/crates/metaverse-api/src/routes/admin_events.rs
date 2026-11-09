//! 事件的管理接口（设计 5.4、8.4）：登记事件类型新版本、抹除事件内容。
//! 不写进注册给 NyxID 的 OpenAPI，但服务端照样要求"管理"级别。
//!
//! ```text
//! POST /api/v1/admin/spaces/{space_id}/event-types                  登记事件类型的新版本
//! POST /api/v1/admin/spaces/{space_id}/events/{event_id}/redact     抹除内容
//! ```

use std::collections::BTreeSet;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use metaverse_core::ids::is_object_id;
use metaverse_core::model::{DataVisibility, Display, DisplayKind, EventType, StateRule};
use metaverse_core::{is_sha256_hex, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use super::events::event_type_view;
use super::ingest_common::{invalid_with, no_store};
use super::ApiJson;
use crate::auth::permissions::Capability;
use crate::auth::{Authorizer, Caller, Purpose};
use crate::error::{ApiError, ProblemDocument};
use crate::ingest::schema::CompiledSchema;
use crate::repo::{AssetRole, RepoError};
use crate::AppState;

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route(
            "/api/v1/admin/spaces/{space_id}/event-types",
            axum::routing::post(register_event_type),
        )
        .route(
            "/api/v1/admin/spaces/{space_id}/events/{event_id}/redact",
            axum::routing::post(redact_event),
        )
}

/// 公开字段最多几个。
const MAX_PUBLIC_FIELDS: usize = 32;
/// `maxAgeSec` 最长 30 天。
const MAX_AGE_SEC: u32 = 30 * 24 * 3600;
/// 显示时长、热力图窗口最长一天。
const MAX_DISPLAY_SEC: u32 = 24 * 3600;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterEventTypeRequest {
    /// 类型名：小写字母开头，1–64 个小写字母、数字、`.`、`_`、`-`，例如 `table.occupancy`。
    #[serde(rename = "type")]
    pub name: String,
    /// JSON Schema（默认 draft 2020-12，≤ 16KB，`$ref` 只能指向自身）。
    #[schema(value_type = Object)]
    pub schema: Value,
    /// 公开接口只返回这些字段（点分路径，例如 `guests`、`party.size`）。
    #[serde(default)]
    pub public_fields: Vec<String>,
    /// 事件不填 visibility 时的默认值：`public` 或 `internal`。
    #[schema(value_type = String, example = "public")]
    pub default_visibility: DataVisibility,
    /// 状态类事件：`{key, value?, clears?}`。
    #[serde(default)]
    #[schema(value_type = Option<Object>)]
    pub state: Option<StateRule>,
    /// 状态多久没更新就自动失效（秒，≤ 30 天）。
    #[serde(default)]
    pub max_age_sec: Option<u32>,
    /// 显示规则：`{kind: highlight|icon|label|path|spawnEntity|heat, icon?, color?, durationSec?,
    /// labelTemplate?, entityAsset?, pathRole?, heat?}`。
    #[schema(value_type = Object)]
    pub display: Display,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RedactResponse {
    pub id: String,
    pub redacted: bool,
    /// 一起抹除的记录数（原事件和指向它的更正）。
    pub records: u64,
}

fn valid_type_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

fn valid_field_path(path: &str) -> bool {
    path.len() <= 128
        && path.split('.').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        })
}

/// `labelTemplate` 里的 `{字段}` 只能引用公开字段。
fn template_fields(template: &str) -> Result<Vec<&str>, String> {
    let mut fields = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let after = &rest[start + 1..];
        let end = after
            .find('}')
            .ok_or_else(|| "labelTemplate 的 { 没有闭合".to_owned())?;
        fields.push(&after[..end]);
        rest = &after[end + 1..];
    }
    Ok(fields)
}

/// 事件类型定义的校验（同步：编译 schema）。
fn check_definition(request: &RegisterEventTypeRequest) -> Result<(), ApiError> {
    if !valid_type_name(&request.name) {
        return Err(ApiError::invalid(
            "type 必须以小写字母开头，由 1–64 个小写字母、数字、.、_、- 组成",
        ));
    }
    CompiledSchema::compile(&request.schema)
        .map_err(|error| invalid_with("invalid_schema", error))?;
    if request.public_fields.len() > MAX_PUBLIC_FIELDS
        || !request
            .public_fields
            .iter()
            .all(|path| valid_field_path(path))
    {
        return Err(ApiError::invalid(format!(
            "publicFields 最多 {MAX_PUBLIC_FIELDS} 个点分路径（字母、数字、_、-）"
        )));
    }
    let public: BTreeSet<&str> = request.public_fields.iter().map(String::as_str).collect();
    if let Some(state) = &request.state {
        if !is_object_id(&state.key) {
            return Err(ApiError::invalid("state.key 格式不对"));
        }
        if let Some(value) = &state.value {
            if state.clears || !valid_field_path(value) {
                return Err(ApiError::invalid(
                    "state.value 必须是点分路径，且 clears 的类型不带 value",
                ));
            }
        }
    }
    if request
        .max_age_sec
        .is_some_and(|age| age == 0 || age > MAX_AGE_SEC)
    {
        return Err(ApiError::invalid("maxAgeSec 必须在 1 秒到 30 天之间"));
    }
    if request.max_age_sec.is_some() && request.state.is_none() {
        return Err(ApiError::invalid("maxAgeSec 只用于状态类事件（带 state）"));
    }
    let display = &request.display;
    if display
        .duration_sec
        .is_some_and(|sec| sec == 0 || sec > MAX_DISPLAY_SEC)
    {
        return Err(ApiError::invalid(
            "display.durationSec 必须在 1 秒到一天之间",
        ));
    }
    if let Some(icon) = &display.icon {
        if icon.chars().count() > 64 || icon.chars().any(char::is_control) {
            return Err(ApiError::invalid("display.icon 太长或含控制字符"));
        }
    }
    if let Some(template) = &display.label_template {
        if template.chars().count() > 200 || template.chars().any(char::is_control) {
            return Err(ApiError::invalid("display.labelTemplate 太长或含控制字符"));
        }
        for field in template_fields(template).map_err(ApiError::invalid)? {
            if !public.contains(field) {
                return Err(invalid_with(
                    "label_not_public",
                    format!("labelTemplate 只能引用公开字段，{field} 不在 publicFields 里"),
                ));
            }
        }
    }
    if let Some(asset) = &display.entity_asset {
        if !is_sha256_hex(asset) {
            return Err(ApiError::invalid("display.entityAsset 必须是资源哈希"));
        }
    }
    if display.kind == DisplayKind::Path && display.path_role.is_none() {
        return Err(ApiError::invalid(
            "路线显示（kind = path）必须给出 pathRole",
        ));
    }
    if display.kind == DisplayKind::SpawnEntity && display.entity_asset.is_none() {
        return Err(ApiError::invalid("spawnEntity 必须给出 entityAsset"));
    }
    if let Some(heat) = &display.heat {
        if heat.window_sec == 0
            || heat.window_sec > MAX_DISPLAY_SEC
            || heat.weight.is_some_and(|w| !w.is_finite() || w <= 0.0)
        {
            return Err(ApiError::invalid("display.heat 不合法"));
        }
    }
    if display.kind == DisplayKind::Heat && display.heat.is_none() {
        return Err(ApiError::invalid("热力图显示（kind = heat）必须给出 heat"));
    }
    Ok(())
}

#[utoipa::path(
    post,
    path = "/api/v1/admin/spaces/{space_id}/event-types",
    operation_id = "admin_register_event_type",
    tag = "admin",
    description = "登记事件类型的新版本（只追加，版本号自动加一）。回放时用事件记录的版本。display.entityAsset（spawnEntity 显示的模型）必须是本空间 model_import 处理后的模型，登记时同时写进 assetRefs，网页可以经公开资源接口读取；不合格返回 422 unknown_asset。需要\"管理\"级别。",
    params(("space_id" = String, Path, description = "空间编号")),
    request_body = RegisterEventTypeRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 201, description = "已登记；返回完整的事件类型（含版本号）"),
        (status = 403, description = "没有管理权限", body = ProblemDocument),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
        (status = 422, description = "定义不合法，或 entityAsset 不是本空间处理后的模型", body = ProblemDocument),
    )
)]
pub async fn register_event_type(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
    ApiJson(request): ApiJson<RegisterEventTypeRequest>,
) -> Result<Response, ApiError> {
    // 功能级开关打开时：事件类型和抹除都属于事件写入，要求 `metaverse:event:write`。
    state
        .authorizer
        .require_capability(&caller, Capability::WriteEvents)?;
    let grant = state
        .authorizer
        .space(&caller, &space_id, Purpose::Manage)
        .await?;
    check_definition(&request)?;
    // spawnEntity 的模型：网页按公开资源接口加载，所以和草稿里的物件模型一样只能引用本空间
    // model_import 处理后的模型，并登记到 assetRefs（设计 8.2：assetRefs 登记网页需要的资源）。
    // 先登记再写事件类型：登记是幂等的，事件类型没写成也只是让一个合格的模型可以公开读取。
    if let Some(asset) = &request.display.entity_asset {
        let unusable = state
            .repo
            .unusable_assets(&grant, &[(asset.clone(), AssetRole::Model)])
            .await?;
        if let Some(problem) = unusable.first() {
            return Err(invalid_with(
                "unknown_asset",
                format!("display.entityAsset 不能用：{}", problem.describe()),
            ));
        }
        state
            .repo
            .register_event_type_asset(&grant, asset, &request.name, crate::now()?)
            .await?;
    }
    for _ in 0..5 {
        let latest = state
            .repo
            .event_types(&grant)
            .await?
            .iter()
            .filter(|event_type| event_type.name == request.name)
            .map(|event_type| event_type.version)
            .max()
            .unwrap_or(0);
        let event_type = EventType {
            space_id: grant.space_id().to_owned(),
            name: request.name.clone(),
            version: latest + 1,
            schema: request.schema.clone(),
            public_fields: request.public_fields.clone(),
            default_visibility: request.default_visibility,
            state: request.state.clone(),
            max_age_sec: request.max_age_sec,
            display: request.display.clone(),
        };
        match state.repo.insert_event_type(&grant, &event_type).await {
            Ok(()) => {
                tracing::info!(space = %space_id, event_type = %event_type.name, version = event_type.version, by = %caller.subject, "登记事件类型");
                return Ok(no_store(
                    (
                        StatusCode::CREATED,
                        Json(event_type_view(&event_type, true)),
                    )
                        .into_response(),
                ));
            }
            // 并发登记同一类型：重读最新版本再试。
            Err(RepoError::Duplicate) => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(ApiError::conflict("同时登记这个事件类型的请求太多，请重试"))
}

#[utoipa::path(
    post,
    path = "/api/v1/admin/spaces/{space_id}/events/{event_id}/redact",
    operation_id = "admin_redact_event",
    tag = "admin",
    description = "抹除一条事件的内容（设计 5.3）：去掉 data、标记 redacted，之后公开接口和 /api/v1 都不再返回它的 data。抹除原事件时，指向它的更正一起抹除。需要\"管理\"级别。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("event_id" = String, Path, description = "事件编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "已抹除", body = RedactResponse),
        (status = 403, description = "没有管理权限", body = ProblemDocument),
        (status = 404, description = "事件不存在", body = ProblemDocument),
    )
)]
pub async fn redact_event(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, event_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    state
        .authorizer
        .require_capability(&caller, Capability::WriteEvents)?;
    let grant = state
        .authorizer
        .space(&caller, &space_id, Purpose::Manage)
        .await?;
    if !is_object_id(&event_id) {
        return Err(ApiError::not_found());
    }
    let event = state
        .repo
        .event(&grant, &event_id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let now: Timestamp = crate::now()?;
    let records = state
        .repo
        .redact_event(&grant, &event, &caller.subject, now)
        .await?;
    // 抹除不产生新的记录时间，受影响的状态快照直接删掉。
    let system = Authorizer::system_scope(&grant, "抹除事件后删除状态快照");
    state.repo.delete_state_snapshots(&system, event.at).await?;
    state.ingest.head_cache.invalidate(grant.space_id());
    tracing::info!(
        target: "audit",
        space = %space_id,
        event = %event_id,
        records,
        by = %caller.subject,
        "抹除事件内容"
    );
    Ok(no_store(
        Json(RedactResponse {
            id: event_id,
            redacted: true,
            records,
        })
        .into_response(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_paths_and_templates() {
        assert!(valid_type_name("table.occupancy"));
        assert!(valid_type_name("delivery-sent_2"));
        assert!(!valid_type_name("Table"));
        assert!(!valid_type_name("1st"));
        assert!(!valid_type_name("a b"));
        assert!(valid_field_path("party.size"));
        assert!(!valid_field_path("party..size"));
        assert!(!valid_field_path("a/b"));
        assert_eq!(
            template_fields("{guests} 位，{party.size}").unwrap(),
            ["guests", "party.size"]
        );
        assert!(template_fields("{oops").is_err());
    }
}
