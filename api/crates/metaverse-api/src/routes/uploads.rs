//! 分片上传（设计 6.1、8.3、8.5）。
//!
//! ```text
//! POST /api/v1/spaces/{space_id}[/plots/{plot_id}]/uploads/{purpose}                    创建
//! PUT  /api/v1/spaces/{space_id}[/plots/{plot_id}]/uploads/{purpose}/{upload_id}/parts/{n}  传一片（原始字节）
//! POST /api/v1/spaces/{space_id}[/plots/{plot_id}]/uploads/{purpose}/{upload_id}/complete  完成 → 202 + 任务编号
//! GET  /api/v1/spaces/{space_id}[/plots/{plot_id}]/uploads/{purpose}/{upload_id}           查状态
//! ```
//!
//! - 用途写在路径里（NyxID 操作范围按路径限制能传哪类文件）；地块路径不能上传扫描（403）；
//! - 创建时声明总大小、整体 SHA-256、分片大小、格式；哈希已经存在就直接复用（200，`status: done`、
//!   `reused: true`），不再接收数据；
//! - 分片大小是 256KiB 的整数倍、最大 32MiB；片号从 0 开始；除最后一片外各片大小都等于分片大小，
//!   最后一片是余下的字节；第 n 片按 256KiB 切块写进 GridFS（布局见 `repo/uploads.rs`），重传幂等；
//! - 第 0 片按声明的格式核对文件头（glb 头里的总长度、图片像素上限等）；
//! - 配额：超过用途的大小上限或空间存储上限 413；进行中的上传太多 429；
//! - 完成：全部分片到齐后建 `upload_verify` 任务（参数 `{uploadId}`），由处理服务流式核对整体哈希、
//!   登记成资源（GridFS 文件名 = 内容哈希），把上传标记为 done 并写 `assetHash`；
//! - 先验身份（中间件）、再查资源级权限、最后才读分片的请求体；分片请求体上限 32MiB + 1KiB，
//!   本进程同时处理的分片数有上限（`UPLOAD_MAX_CONCURRENT_PARTS`）。

use std::collections::BTreeMap;

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use metaverse_core::model::{
    Job, JobKind, JobStatus, Upload, UploadFormat, UploadPart, UploadStatus, ASSET_CHUNK_SIZE,
    MAX_UPLOAD_PART_SIZE, UPLOAD_TTL_SECONDS,
};
use metaverse_core::scope::{check_upload_purpose, PathScope, UploadPurpose};
use metaverse_core::{is_sha256_hex, sha256_hex, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::ToSchema;

use super::ingest_common::{
    conflict_with, invalid_with, no_store, path_scope, request_actor, scope_violation, set_header,
    too_large, too_many,
};
use super::ApiJson;
use crate::auth::permissions::Capability;
use crate::auth::{Caller, Grant, Purpose};
use crate::error::{ApiError, ProblemDocument};
use crate::ingest::{formats, new_id, purpose_from_path, purpose_name};
use crate::repo::{CompleteWrite, PartWrite};
use crate::AppState;

/// 分片请求体上限（设计 8.5：分片 ≤ 32MiB + 1KiB）。
pub const PART_BODY_LIMIT: usize = MAX_UPLOAD_PART_SIZE as usize + 1024;
/// 一个上传最多多少片（太多就用更大的分片）。
pub const MAX_PARTS: u64 = 10_000;
/// "完成"时列出的缺失片号最多几个。
const MISSING_LIST: usize = 20;

pub fn routes() -> Router<crate::AppState> {
    Router::new()
        .route(
            "/api/v1/spaces/{space_id}/uploads/{purpose}",
            post(create_upload),
        )
        .route(
            "/api/v1/spaces/{space_id}/plots/{plot_id}/uploads/{purpose}",
            post(create_plot_upload),
        )
        .route(
            "/api/v1/spaces/{space_id}/uploads/{purpose}/{upload_id}",
            get(get_upload),
        )
        .route(
            "/api/v1/spaces/{space_id}/plots/{plot_id}/uploads/{purpose}/{upload_id}",
            get(get_plot_upload),
        )
        .route(
            "/api/v1/spaces/{space_id}/uploads/{purpose}/{upload_id}/parts/{n}",
            put(put_upload_part).layer(DefaultBodyLimit::max(PART_BODY_LIMIT)),
        )
        .route(
            "/api/v1/spaces/{space_id}/plots/{plot_id}/uploads/{purpose}/{upload_id}/parts/{n}",
            put(put_plot_upload_part).layer(DefaultBodyLimit::max(PART_BODY_LIMIT)),
        )
        .route(
            "/api/v1/spaces/{space_id}/uploads/{purpose}/{upload_id}/complete",
            post(complete_upload),
        )
        .route(
            "/api/v1/spaces/{space_id}/plots/{plot_id}/uploads/{purpose}/{upload_id}/complete",
            post(complete_plot_upload),
        )
}

// ---------------------------------------------------------------------------
// 请求与视图
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateUploadRequest {
    /// 文件总字节数（也接受字段名 `totalSize`）。上限按用途（默认扫描 1GiB、物件模型 50MiB、
    /// 贴图 50MiB、ops 64MiB、脚本 4MiB）。
    #[serde(alias = "totalSize")]
    #[schema(example = 734003200)]
    pub size: u64,
    /// 整个文件的 SHA-256（64 位小写十六进制）。已存在时直接复用，不再接收数据。
    #[schema(example = "9f2c...（64 位十六进制）")]
    pub sha256: String,
    /// 分片大小：256KiB（262144）的整数倍，最大 32MiB（33554432）。
    #[schema(example = 8388608)]
    pub part_size: u64,
    /// 文件格式：scan、model 用途 glb/drc/obj/zip（zip = 模型 + 贴图，例如 Scaniverse 导出）；
    /// texture 用途 png/jpeg/webp（单边 ≤ 8192）；ops 用途 ndjson/gzip；script 用途 text。
    /// 收到第 0 片时按它核对文件头；处理服务校验时再嗅探一遍。
    #[schema(example = "drc")]
    pub format: String,
}

/// 上传会话的状态。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UploadView {
    pub upload_id: String,
    pub space_id: String,
    /// `scan`、`model`、`texture`、`ops`、`script`。
    pub purpose: String,
    /// 创建时的路径范围：`physical` 或 `plot:<编号>`。
    pub scope: String,
    /// 创建时声明的格式。
    pub declared_format: String,
    /// 处理服务嗅探出的格式（`glb | draco | obj | zip | png | jpeg | webp | ndjson | ndjson+gzip | text`），
    /// 校验通过后才有。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// `open`（接收分片中）、`complete`（校验中）、`done`（已登记成资源）、`failed`、`expired`。
    pub status: String,
    /// 声明的总字节数。
    pub size: u64,
    pub sha256: String,
    pub part_size: u64,
    /// 片数 = ceil(总大小 / 分片大小)；片号从 0 开始。
    pub part_count: u64,
    pub received_parts: u64,
    pub received_bytes: u64,
    /// 还没收到的片号（最多列 1000 个）。
    pub missing_parts: Vec<u64>,
    /// 完成时创建的校验任务。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    /// 校验通过后的资源哈希（= sha256）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_hash: Option<String>,
    /// 本空间已经拥有这份资源，直接复用（没有收数据）。
    pub reused: bool,
    /// 校验失败的原因。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    /// 没完成的上传在这个时间之后被清理。
    #[schema(value_type = String, format = DateTime)]
    pub expires_at: Timestamp,
}

impl UploadView {
    fn new(upload: &Upload) -> Self {
        let received_bytes = upload.parts.values().map(|part| part.size).sum();
        let missing_parts = (0..upload.part_count)
            .filter(|n| !upload.parts.contains_key(&n.to_string()))
            .take(1000)
            .collect();
        Self {
            upload_id: upload.id.clone(),
            space_id: upload.space_id.clone(),
            purpose: purpose_name(upload.purpose).to_owned(),
            scope: upload.scope.to_string(),
            declared_format: upload.declared_format.name().to_owned(),
            format: upload.format.clone(),
            content_type: upload.content_type.clone(),
            status: status_name(upload.status).to_owned(),
            size: upload.size,
            sha256: upload.sha256.clone(),
            part_size: upload.part_size,
            part_count: upload.part_count,
            received_parts: upload.parts.len() as u64,
            received_bytes,
            missing_parts: if upload.status == UploadStatus::Open {
                missing_parts
            } else {
                Vec::new()
            },
            job_id: upload.job_id.clone(),
            asset_hash: upload.asset_hash.clone(),
            reused: upload.reused,
            error: upload.error.clone(),
            created_at: upload.created_at,
            expires_at: upload.created_at.saturating_add_seconds(UPLOAD_TTL_SECONDS),
        }
    }
}

/// 收到一片之后的回执。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PartReceipt {
    pub upload_id: String,
    /// 片号（从 0 开始）。
    pub part_number: u64,
    pub size: u64,
    /// 这一片的 SHA-256。
    pub sha256: String,
}

/// "完成上传"的结果。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompleteUploadResponse {
    pub upload_id: String,
    pub status: String,
    /// `upload_verify` 任务，用 `GET .../jobs/{job_id}` 查进度。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_hash: Option<String>,
}

fn status_name(status: UploadStatus) -> &'static str {
    match status {
        UploadStatus::Open => "open",
        UploadStatus::Complete => "complete",
        UploadStatus::Done => "done",
        UploadStatus::Failed => "failed",
        UploadStatus::Expired => "expired",
    }
}

// ---------------------------------------------------------------------------
// 共用步骤
// ---------------------------------------------------------------------------

fn purpose_of(path: &str) -> Result<UploadPurpose, ApiError> {
    purpose_from_path(path).ok_or_else(ApiError::not_found)
}

/// 资源级授权 + 路径范围 + 用途与范围一致。
async fn authorize(
    state: &AppState,
    caller: &Caller,
    space_id: &str,
    plot_id: Option<&str>,
    purpose: UploadPurpose,
    access: Purpose,
) -> Result<(Grant, PathScope, metaverse_core::model::Space), ApiError> {
    if access == Purpose::Manage {
        state
            .authorizer
            .require_capability(caller, Capability::WriteContent)?;
    }
    let grant = state.authorizer.space(caller, space_id, access).await?;
    let (scope, space) = path_scope(state, &grant, plot_id).await?;
    check_legacy_upload_purpose(&scope, purpose)
        .map_err(|error| scope_violation(error.to_string()))?;
    Ok((grant, scope, space))
}

/// 上传用途与路径范围。核心库的表（`check_upload_purpose`）已经是瘦身后的规则：扫描只经重建路径、
/// AI 物件集不能再上传。旧的扫描导入和物件集导入删掉之前（docs/design/server-slim.md S4），
/// 实体区路径照旧收这两种，其余按核心库的表。
fn check_legacy_upload_purpose(
    scope: &PathScope,
    purpose: UploadPurpose,
) -> Result<(), metaverse_core::scope::ScopeError> {
    if *scope == PathScope::Physical
        && matches!(purpose, UploadPurpose::Scan | UploadPurpose::Authored)
    {
        return Ok(());
    }
    check_upload_purpose(scope, purpose)
}

/// 读上传会话：必须是经同一路径范围、同一用途创建的，否则 404。
async fn load_upload(
    state: &AppState,
    grant: &Grant,
    scope: &PathScope,
    purpose: UploadPurpose,
    upload_id: &str,
) -> Result<Upload, ApiError> {
    if !metaverse_core::ids::is_object_id(upload_id) {
        return Err(ApiError::not_found());
    }
    state
        .repo
        .upload(grant, upload_id)
        .await?
        .filter(|upload| &upload.scope == scope && upload.purpose == purpose)
        .ok_or_else(ApiError::not_found)
}

fn expected_part_size(upload: &Upload, n: u64) -> u64 {
    if n + 1 == upload.part_count {
        upload.size - n * upload.part_size
    } else {
        upload.part_size
    }
}

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

async fn create(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    purpose: String,
    request: CreateUploadRequest,
) -> Result<Response, ApiError> {
    let purpose = purpose_of(&purpose)?;
    let (grant, scope, space) = authorize(
        &state,
        &caller,
        &space_id,
        plot_id.as_deref(),
        purpose,
        Purpose::Manage,
    )
    .await?;
    let limits = &state.ingest.config;
    if !is_sha256_hex(&request.sha256) {
        return Err(ApiError::invalid("sha256 必须是 64 位小写十六进制"));
    }
    let format = UploadFormat::from_name(&request.format)
        .filter(|format| limits.formats(purpose).contains(format))
        .ok_or_else(|| {
            let allowed: Vec<_> = limits.formats(purpose).iter().map(|f| f.name()).collect();
            invalid_with(
                "unsupported_format",
                format!(
                    "{} 用途只接受这些格式：{}",
                    purpose_name(purpose),
                    allowed.join("、")
                ),
            )
        })?;
    if request.part_size == 0
        || !request.part_size.is_multiple_of(ASSET_CHUNK_SIZE)
        || request.part_size > MAX_UPLOAD_PART_SIZE
    {
        return Err(invalid_with(
            "invalid_part_size",
            "partSize 必须是 256KiB（262144）的整数倍，最大 32MiB（33554432）",
        ));
    }
    if request.size == 0 {
        return Err(ApiError::invalid("size 必须大于 0"));
    }
    let max = limits.max_bytes(purpose);
    if request.size > max {
        return Err(too_large(
            "upload_too_large",
            format!("{} 用途的文件最大 {max} 字节", purpose_name(purpose)),
        ));
    }
    let part_count = request.size.div_ceil(request.part_size);
    if part_count > MAX_PARTS {
        return Err(invalid_with(
            "too_many_parts",
            format!("最多 {MAX_PARTS} 片，请用更大的分片"),
        ));
    }
    let now = crate::now()?;
    let mut upload = Upload {
        id: new_id("up"),
        space_id: grant.space_id().to_owned(),
        owner: grant.owner().clone(),
        scope,
        purpose,
        declared_format: format,
        status: UploadStatus::Open,
        size: request.size,
        sha256: request.sha256.clone(),
        part_size: request.part_size,
        part_count,
        parts: BTreeMap::new(),
        header_checked: false,
        actor: request_actor(&caller),
        created_at: now,
        updated_at: now,
        completed_at: None,
        job_id: None,
        reused: false,
        asset_hash: None,
        format: None,
        content_type: None,
        verified_at: None,
        verified_sha256: None,
        error: None,
        failed_at: None,
    };
    // 本空间已经拥有同一用途的这份资源：直接复用，不再接收数据（设计 6.1）。只凭哈希不行——
    // 别的主人的资源（或全系统里有没有某个文件）都不能这样拿到：其他情况一律照常上传完整数据，
    // 由处理服务核对整体哈希后在存储层去重，所有权只靠真正传过数据确立。两种情况都返回 201。
    if let Some(length) = state
        .repo
        .reusable_asset_length(&grant, &request.sha256, purpose, &limits.upload_limits())
        .await?
    {
        if length != request.size {
            return Err(invalid_with(
                "size_mismatch",
                "同一哈希的已有资源大小与声明的 size 不一致",
            ));
        }
        // 清理的栅栏：先刷新 touchedAt 并确认资源还在，刷新之后的 7 天里清理删不掉它，调用方
        // 在这期间拿这次上传去建任务、追加操作。刷新不到说明它刚被清理删掉：按本空间没有这份
        // 资源处理，往下照常要求上传完整数据，不登记一个指向已删除资源的"复用"上传。
        if state.repo.touch_asset(&grant, &request.sha256).await? {
            upload.status = UploadStatus::Done;
            upload.asset_hash = Some(request.sha256.clone());
            upload.reused = true;
            upload.header_checked = true;
            upload.completed_at = Some(now);
            state.repo.insert_upload(&grant, &upload).await?;
            tracing::info!(space = %upload.space_id, upload = %upload.id, purpose = purpose_name(purpose), "复用本空间已有的资源");
            return Ok(no_store(
                (StatusCode::CREATED, Json(UploadView::new(&upload))).into_response(),
            ));
        }
        tracing::info!(space = %upload.space_id, purpose = purpose_name(purpose), "可复用的资源刚被清理，改为完整上传");
    }
    let pending = state.repo.pending_uploads(&grant).await?;
    if pending.count >= limits.max_open_uploads_per_space {
        return Err(too_many(
            "too_many_uploads",
            format!(
                "这个空间同时进行中的上传最多 {} 个，请先完成或等待过期",
                limits.max_open_uploads_per_space
            ),
        ));
    }
    let projected = space
        .storage_used_bytes
        .saturating_add(pending.bytes)
        .saturating_add(request.size);
    if projected > space.storage_limit_bytes {
        return Err(too_large(
            "storage_limit_exceeded",
            "超过空间的存储上限（含进行中的上传）",
        ));
    }
    state.repo.insert_upload(&grant, &upload).await?;
    tracing::info!(
        space = %upload.space_id,
        upload = %upload.id,
        purpose = purpose_name(purpose),
        size = upload.size,
        by = %caller.subject,
        "创建上传"
    );
    let mut response = (StatusCode::CREATED, Json(UploadView::new(&upload))).into_response();
    let base = match &upload.scope {
        PathScope::Plot(plot) => format!("/api/v1/spaces/{}/plots/{plot}", upload.space_id),
        _ => format!("/api/v1/spaces/{}", upload.space_id),
    };
    set_header(
        &mut response,
        header::LOCATION,
        &format!("{base}/uploads/{}/{}", purpose_name(purpose), upload.id),
    );
    Ok(no_store(response))
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/uploads/{purpose}",
    operation_id = "create_upload",
    tag = "uploads",
    description = "创建分片上传（实体区路径）。声明总大小、整体 SHA-256、分片大小（256KiB 的整数倍，≤32MiB）和格式；用途写在路径里（scan、model、texture、ops、script、authored；authored 是 AI 物件集 JSON，交给 import_scan、rebuild_scan 的 authoredAsset）。本空间已经拥有同一用途的这份资源时直接复用（status=done、reused=true），否则返回上传编号（两种情况都是 201；别的空间有同一份内容也要完整上传），之后按片号（从 0 开始）PUT 原始字节，最后调用 complete。大小上限：扫描 1GiB、物件模型 50MiB、贴图 50MiB、ops 64MiB（接口服务应用操作时整份读入，不能调大）、脚本 4MiB（可配置）、AI 物件集 4MiB（固定）；超过上限或空间存储上限返回 413，进行中的上传太多返回 429。大文件请用命令行，不要经 AI 工具传二进制。",
    params(
        ("space_id" = String, Path, description = "空间编号", example = "front-hall"),
        ("purpose" = String, Path, description = "用途：scan | model | texture | ops | script | authored（AI 物件集，JSON，≤ 4MB，只经实体区路径）", example = "scan"),
    ),
    request_body = CreateUploadRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 201, description = "已创建，开始上传分片", body = UploadView),
        (status = 403, description = "没有写权限", body = ProblemDocument),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
        (status = 413, description = "超过大小上限或空间存储上限", body = ProblemDocument),
        (status = 422, description = "参数不合法（哈希、分片大小、格式）", body = ProblemDocument),
        (status = 429, description = "进行中的上传太多", body = ProblemDocument),
    )
)]
pub async fn create_upload(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, purpose)): Path<(String, String)>,
    ApiJson(request): ApiJson<CreateUploadRequest>,
) -> Result<Response, ApiError> {
    create(state, caller, space_id, None, purpose, request).await
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/uploads/{purpose}",
    operation_id = "create_plot_upload",
    tag = "uploads",
    description = "创建分片上传（地块路径）。与 create_upload 相同，但地块路径下不能上传扫描（403 scope_violation）；地块合作方的 agent key 一般只开放这一组路径。",
    params(
        ("space_id" = String, Path, description = "空间编号", example = "restaurant"),
        ("plot_id" = String, Path, description = "地块编号", example = "p1"),
        ("purpose" = String, Path, description = "用途：model | texture | ops | script", example = "model"),
    ),
    request_body = CreateUploadRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 201, description = "已创建", body = UploadView),
        (status = 403, description = "没有写权限，或地块路径上传扫描", body = ProblemDocument),
        (status = 404, description = "空间或地块不存在", body = ProblemDocument),
        (status = 413, description = "超过大小上限或空间存储上限", body = ProblemDocument),
        (status = 422, description = "参数不合法", body = ProblemDocument),
        (status = 429, description = "进行中的上传太多", body = ProblemDocument),
    )
)]
pub async fn create_plot_upload(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, plot_id, purpose)): Path<(String, String, String)>,
    ApiJson(request): ApiJson<CreateUploadRequest>,
) -> Result<Response, ApiError> {
    create(state, caller, space_id, Some(plot_id), purpose, request).await
}

// ---------------------------------------------------------------------------
// 分片
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn put_part(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    purpose: String,
    upload_id: String,
    n: String,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let purpose = purpose_of(&purpose)?;
    let (grant, scope, _) = authorize(
        &state,
        &caller,
        &space_id,
        plot_id.as_deref(),
        purpose,
        Purpose::Manage,
    )
    .await?;
    let upload = load_upload(&state, &grant, &scope, purpose, &upload_id).await?;
    if upload.status != UploadStatus::Open {
        return Err(conflict_with(
            "upload_not_open",
            format!("上传已是 {} 状态，不再接收分片", status_name(upload.status)),
        ));
    }
    let n: u64 = n
        .parse()
        .ok()
        .filter(|n| *n < upload.part_count)
        .ok_or_else(|| {
            invalid_with(
                "invalid_part_number",
                format!("片号必须是 0 到 {} 之间的整数", upload.part_count - 1),
            )
        })?;
    let expected = expected_part_size(&upload, n);
    // 声明的长度不对就不读请求体。
    if let Some(length) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        if length > expected {
            return Err(too_large(
                "part_too_large",
                format!("第 {n} 片应为 {expected} 字节，累计会超过声明的总大小"),
            ));
        }
        if length < expected {
            return Err(invalid_with(
                "part_size_mismatch",
                format!("第 {n} 片应为 {expected} 字节"),
            ));
        }
    }
    let Some(_permit) = state.ingest.part_permit().await else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "upload_busy",
            "正在处理的分片太多，请稍后重试",
        ));
    };
    let data = axum::body::to_bytes(body, expected as usize)
        .await
        .map_err(|_| {
            too_large(
                "part_too_large",
                format!("第 {n} 片应为 {expected} 字节，累计会超过声明的总大小"),
            )
        })?;
    if data.len() as u64 != expected {
        return Err(invalid_with(
            "part_size_mismatch",
            format!("第 {n} 片应为 {expected} 字节，收到 {}", data.len()),
        ));
    }
    if n == 0 {
        formats::check_header(
            upload.declared_format,
            &data,
            upload.size,
            state.ingest.config.max_texture_side,
        )
        .map_err(|error| match error {
            formats::FormatError::TextureTooLarge { .. } => {
                too_large("texture_too_large", error.to_string())
            }
            other => invalid_with("format_mismatch", other.to_string()),
        })?;
    }
    let part = UploadPart {
        size: expected,
        sha256: sha256_hex(&data),
    };
    let now = crate::now()?;
    match state
        .repo
        .write_upload_part(&grant, &upload, n, &data, part.clone(), now)
        .await?
    {
        PartWrite::Stored => {}
        PartWrite::NotOpen => {
            return Err(conflict_with(
                "upload_not_open",
                "上传已不再接收分片（已完成、已过期或已清理）",
            ))
        }
    }
    tracing::debug!(upload = %upload.id, part = n, size = expected, "收到分片");
    Ok(no_store(
        Json(PartReceipt {
            upload_id: upload.id,
            part_number: n,
            size: part.size,
            sha256: part.sha256,
        })
        .into_response(),
    ))
}

#[utoipa::path(
    put,
    path = "/api/v1/spaces/{space_id}/uploads/{purpose}/{upload_id}/parts/{n}",
    operation_id = "put_upload_part",
    tag = "uploads",
    description = "上传一片（实体区路径）。请求体是原始字节（application/octet-stream），片号 n 从 0 开始；除最后一片外每片都必须正好是分片大小，最后一片是余下的字节。同一片可以重传（覆盖）。片号超出范围或长度不对返回 422，超过声明的总大小返回 413。请求体最大 32MiB + 1KiB。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("purpose" = String, Path, description = "用途"),
        ("upload_id" = String, Path, description = "上传编号"),
        ("n" = u64, Path, description = "片号，从 0 开始"),
    ),
    request_body(content = Vec<u8>, content_type = "application/octet-stream"),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "已收到", body = PartReceipt),
        (status = 404, description = "上传不存在", body = ProblemDocument),
        (status = 409, description = "上传已不接收分片", body = ProblemDocument),
        (status = 413, description = "超过声明的大小或像素上限", body = ProblemDocument),
        (status = 422, description = "片号或长度不对、文件头与格式不符", body = ProblemDocument),
        (status = 503, description = "正在处理的分片太多", body = ProblemDocument),
    )
)]
pub async fn put_upload_part(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, purpose, upload_id, n)): Path<(String, String, String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    put_part(
        state, caller, space_id, None, purpose, upload_id, n, headers, body,
    )
    .await
}

#[utoipa::path(
    put,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/uploads/{purpose}/{upload_id}/parts/{n}",
    operation_id = "put_plot_upload_part",
    tag = "uploads",
    description = "上传一片（地块路径）。规则同 put_upload_part。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("plot_id" = String, Path, description = "地块编号"),
        ("purpose" = String, Path, description = "用途"),
        ("upload_id" = String, Path, description = "上传编号"),
        ("n" = u64, Path, description = "片号，从 0 开始"),
    ),
    request_body(content = Vec<u8>, content_type = "application/octet-stream"),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "已收到", body = PartReceipt),
        (status = 404, description = "上传不存在", body = ProblemDocument),
        (status = 409, description = "上传已不接收分片", body = ProblemDocument),
        (status = 413, description = "超过声明的大小", body = ProblemDocument),
        (status = 422, description = "片号或长度不对", body = ProblemDocument),
    )
)]
pub async fn put_plot_upload_part(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, plot_id, purpose, upload_id, n)): Path<(
        String,
        String,
        String,
        String,
        String,
    )>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    put_part(
        state,
        caller,
        space_id,
        Some(plot_id),
        purpose,
        upload_id,
        n,
        headers,
        body,
    )
    .await
}

// ---------------------------------------------------------------------------
// 完成
// ---------------------------------------------------------------------------

async fn complete(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    purpose: String,
    upload_id: String,
) -> Result<Response, ApiError> {
    let purpose = purpose_of(&purpose)?;
    let (grant, scope, _) = authorize(
        &state,
        &caller,
        &space_id,
        plot_id.as_deref(),
        purpose,
        Purpose::Manage,
    )
    .await?;
    let upload = load_upload(&state, &grant, &scope, purpose, &upload_id).await?;
    let reply = |status: StatusCode, upload: &Upload| {
        no_store(
            (
                status,
                Json(CompleteUploadResponse {
                    upload_id: upload.id.clone(),
                    status: status_name(upload.status).to_owned(),
                    job_id: upload.job_id.clone(),
                    asset_hash: upload.asset_hash.clone(),
                }),
            )
                .into_response(),
        )
    };
    match upload.status {
        // 重复调用"完成"：返回同一个任务。
        UploadStatus::Complete => return Ok(reply(StatusCode::ACCEPTED, &upload)),
        UploadStatus::Done => return Ok(reply(StatusCode::OK, &upload)),
        UploadStatus::Failed | UploadStatus::Expired => {
            return Err(conflict_with(
                "upload_not_open",
                format!("上传已是 {} 状态", status_name(upload.status)),
            ))
        }
        UploadStatus::Open => {}
    }
    let missing: Vec<u64> = (0..upload.part_count)
        .filter(|n| {
            upload
                .parts
                .get(&n.to_string())
                .is_none_or(|part| part.size != expected_part_size(&upload, *n))
        })
        .collect();
    if !missing.is_empty() || !upload.header_checked {
        let listed: Vec<String> = missing
            .iter()
            .take(MISSING_LIST)
            .map(u64::to_string)
            .collect();
        return Err(conflict_with(
            "upload_incomplete",
            format!(
                "还缺 {} 片：{}{}",
                missing.len(),
                listed.join("、"),
                if missing.len() > MISSING_LIST {
                    "……"
                } else {
                    ""
                }
            ),
        ));
    }
    let limit = state.ingest.config.max_pending_jobs_per_space;
    if state.repo.pending_jobs(&grant).await? >= limit {
        return Err(too_many(
            "too_many_jobs",
            format!("这个空间排队和运行中的任务最多 {limit} 个，请稍后再完成上传"),
        ));
    }
    let now = crate::now()?;
    let job = Job {
        id: new_id("job"),
        space_id: grant.space_id().to_owned(),
        owner: grant.owner().clone(),
        kind: JobKind::UploadVerify,
        params: json!({"uploadId": upload.id}),
        status: JobStatus::Queued,
        lease_owner: None,
        lease_until: None,
        attempt: 0,
        max_attempts: JobKind::UploadVerify.max_attempts(),
        last_error: None,
        not_before: None,
        history: Vec::new(),
        result_commit_id: None,
        created_at: now,
        actor: Some(request_actor(&caller)),
        scope: Some(scope.clone()),
        result: None,
        progress: None,
        started_at: None,
        finished_at: None,
    };
    match state
        .repo
        .complete_upload(&grant, &upload, &job, now)
        .await?
    {
        CompleteWrite::Completed => {
            tracing::info!(space = %upload.space_id, upload = %upload.id, job = %job.id, "上传完成，等待核对");
            // 叫醒本进程的后台执行器，不等轮询。
            state.job_signal.notify();
            let mut done = upload;
            done.status = UploadStatus::Complete;
            done.job_id = Some(job.id);
            let mut response = reply(StatusCode::ACCEPTED, &done);
            if let Some(job_id) = &done.job_id {
                let base = match &scope {
                    PathScope::Plot(plot) => format!("/api/v1/spaces/{space_id}/plots/{plot}"),
                    _ => format!("/api/v1/spaces/{space_id}"),
                };
                set_header(
                    &mut response,
                    header::LOCATION,
                    &format!("{base}/jobs/{job_id}"),
                );
            }
            Ok(response)
        }
        CompleteWrite::NotOpen => {
            let current = load_upload(&state, &grant, &scope, purpose, &upload_id).await?;
            match current.status {
                UploadStatus::Complete => Ok(reply(StatusCode::ACCEPTED, &current)),
                UploadStatus::Done => Ok(reply(StatusCode::OK, &current)),
                // 还有分片请求正在写数据块：等它们写完再完成，否则校验的数据可能被改写。
                UploadStatus::Open => {
                    let mut response = conflict_with(
                        "parts_in_progress",
                        "还有分片正在写入，请等这些请求结束后再调用 complete",
                    )
                    .into_response();
                    response
                        .headers_mut()
                        .insert(header::RETRY_AFTER, HeaderValue::from_static("2"));
                    Ok(response)
                }
                other => Err(conflict_with(
                    "upload_not_open",
                    format!("上传已是 {} 状态", status_name(other)),
                )),
            }
        }
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/uploads/{purpose}/{upload_id}/complete",
    operation_id = "complete_upload",
    tag = "uploads",
    description = "完成上传（实体区路径）。全部分片到齐后返回 202 和 upload_verify 任务编号；处理服务流式核对整体哈希，通过后登记成资源并把上传标记为 done（assetHash = sha256），失败则删除分片、标记 failed。重复调用返回同一个任务。还有缺片时返回 409。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("purpose" = String, Path, description = "用途"),
        ("upload_id" = String, Path, description = "上传编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 202, description = "已开始校验", body = CompleteUploadResponse),
        (status = 200, description = "已经校验通过（或复用）", body = CompleteUploadResponse),
        (status = 404, description = "上传不存在", body = ProblemDocument),
        (status = 409, description = "还缺分片，或上传已失败、过期", body = ProblemDocument),
        (status = 429, description = "排队中的任务太多", body = ProblemDocument),
    )
)]
pub async fn complete_upload(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, purpose, upload_id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    complete(state, caller, space_id, None, purpose, upload_id).await
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/uploads/{purpose}/{upload_id}/complete",
    operation_id = "complete_plot_upload",
    tag = "uploads",
    description = "完成上传（地块路径）。规则同 complete_upload。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("plot_id" = String, Path, description = "地块编号"),
        ("purpose" = String, Path, description = "用途"),
        ("upload_id" = String, Path, description = "上传编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 202, description = "已开始校验", body = CompleteUploadResponse),
        (status = 200, description = "已经校验通过（或复用）", body = CompleteUploadResponse),
        (status = 404, description = "上传不存在", body = ProblemDocument),
        (status = 409, description = "还缺分片", body = ProblemDocument),
    )
)]
pub async fn complete_plot_upload(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, plot_id, purpose, upload_id)): Path<(String, String, String, String)>,
) -> Result<Response, ApiError> {
    complete(state, caller, space_id, Some(plot_id), purpose, upload_id).await
}

// ---------------------------------------------------------------------------
// 查状态
// ---------------------------------------------------------------------------

async fn show(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    purpose: String,
    upload_id: String,
) -> Result<Response, ApiError> {
    let purpose = purpose_of(&purpose)?;
    let (grant, scope, _) = authorize(
        &state,
        &caller,
        &space_id,
        plot_id.as_deref(),
        purpose,
        Purpose::Read,
    )
    .await?;
    let upload = load_upload(&state, &grant, &scope, purpose, &upload_id).await?;
    Ok(no_store(Json(UploadView::new(&upload)).into_response()))
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/uploads/{purpose}/{upload_id}",
    operation_id = "get_upload",
    tag = "uploads",
    description = "查询上传状态（实体区路径）：已收到哪些分片、还缺哪些、校验任务、资源哈希。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("purpose" = String, Path, description = "用途"),
        ("upload_id" = String, Path, description = "上传编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "上传状态", body = UploadView),
        (status = 404, description = "上传不存在或无权查看", body = ProblemDocument),
    )
)]
pub async fn get_upload(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, purpose, upload_id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    show(state, caller, space_id, None, purpose, upload_id).await
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/uploads/{purpose}/{upload_id}",
    operation_id = "get_plot_upload",
    tag = "uploads",
    description = "查询上传状态（地块路径）。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("plot_id" = String, Path, description = "地块编号"),
        ("purpose" = String, Path, description = "用途"),
        ("upload_id" = String, Path, description = "上传编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "上传状态", body = UploadView),
        (status = 404, description = "上传不存在或无权查看", body = ProblemDocument),
    )
)]
pub async fn get_plot_upload(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, plot_id, purpose, upload_id)): Path<(String, String, String, String)>,
) -> Result<Response, ApiError> {
    show(state, caller, space_id, Some(plot_id), purpose, upload_id).await
}
