//! 扫描、物件模型和任务（设计 6.2–6.4、8.3）。
//!
//! ```text
//! POST /api/v1/spaces/{space_id}/scans                          导入扫描 → scan_import
//! POST /api/v1/spaces/{space_id}/scans/{scan_id}/voxelize       体素化 → voxelize
//! POST /api/v1/spaces/{space_id}/scans/{scan_id}/rebuild        重跑 AI 重建 → rebuild
//! POST /api/v1/spaces/{space_id}/scans/{scan_id}/alignment      用给定变换重新导入 → scan_import（带 transform）
//! POST /api/v1/spaces/{space_id}[/plots/{plot_id}]/models       物件模型 → model_import
//! GET  /api/v1/spaces/{space_id}[/plots/{plot_id}]/jobs/{job_id}
//! GET  /api/v1/spaces/{space_id}[/plots/{plot_id}]/jobs         最近的任务
//! ```
//!
//! - 扫描只经实体区路径；扫描编号 `scan_id` = 扫描资源的内容哈希；
//! - 引用的资源必须是本空间校验通过的上传（物件模型经地块路径时还要求是同一地块上传的）；
//! - 每个空间排队和运行中的任务数有上限（`JOB_MAX_PENDING_PER_SPACE`），超过返回 429；
//! - 带 `Idempotency-Key` 时，同一个键重复请求返回同一个任务（200），参数不同返回 409；
//! - 经地块路径只能查到本地块发起的任务。

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use metaverse_core::canonical::canonical_json;
use metaverse_core::ids::is_object_id;
use metaverse_core::model::{Job, JobKind, JobStatus, JOB_MAX_ATTEMPTS};
use metaverse_core::scope::{PathScope, UploadPurpose};
use metaverse_core::{is_sha256_hex, sha256_hex, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use utoipa::{IntoParams, ToSchema};

use super::ingest_common::{
    conflict_with, idempotency_key, invalid_with, no_store, optional_json, path_scope,
    request_actor, set_header, too_many,
};
use super::ApiJson;
use crate::auth::permissions::Capability;
use crate::auth::{Caller, Grant, Purpose};
use crate::error::{ApiError, ProblemDocument};
use crate::ingest::new_id;
use crate::repo::{AssetAvailability, JobInsert};
use crate::AppState;

/// `hints` 规范化后的最大字节数。
pub const MAX_HINTS_BYTES: usize = 4 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/spaces/{space_id}/scans", post(import_scan))
        .route(
            "/api/v1/spaces/{space_id}/scans/{scan_id}/voxelize",
            post(voxelize_scan),
        )
        .route(
            "/api/v1/spaces/{space_id}/scans/{scan_id}/rebuild",
            post(rebuild_scan),
        )
        .route(
            "/api/v1/spaces/{space_id}/scans/{scan_id}/alignment",
            post(align_scan),
        )
        .route("/api/v1/spaces/{space_id}/models", post(import_model))
        .route(
            "/api/v1/spaces/{space_id}/plots/{plot_id}/models",
            post(import_plot_model),
        )
        .route("/api/v1/spaces/{space_id}/jobs", get(list_jobs))
        .route(
            "/api/v1/spaces/{space_id}/plots/{plot_id}/jobs",
            get(list_plot_jobs),
        )
        .route("/api/v1/spaces/{space_id}/jobs/{job_id}", get(get_job))
        .route(
            "/api/v1/spaces/{space_id}/plots/{plot_id}/jobs/{job_id}",
            get(get_plot_job),
        )
}

// ---------------------------------------------------------------------------
// 请求与视图
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportScanRequest {
    /// 扫描资源的内容哈希（经 scan 用途上传并校验通过；带贴图的扫描请打包成 zip 上传）。
    /// 导入后它就是扫描编号。
    pub asset_hash: String,
    /// 现实中拍摄的时间（只用于显示）。
    #[serde(default)]
    #[schema(value_type = Option<String>, format = DateTime)]
    pub observed_at: Option<Timestamp>,
    /// 导入后是否做 AI 重建，默认 true。
    #[serde(default)]
    pub rebuild: Option<bool>,
    /// 导入后是否体素化，默认 false。
    #[serde(default)]
    pub voxelize: Option<bool>,
    /// 给处理服务的提示（任意 JSON 对象，≤ 4KB）。
    #[serde(default)]
    #[schema(value_type = Option<Object>)]
    pub hints: Option<Value>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlignScanRequest {
    /// 4×4 列主序变换矩阵（扫描坐标 → 空间坐标），16 个数，最后一行必须是 [0,0,0,1]，不能镜像。
    #[schema(value_type = Vec<f64>)]
    pub transform: Vec<f64>,
    #[serde(default)]
    #[schema(value_type = Option<String>, format = DateTime)]
    pub observed_at: Option<Timestamp>,
    #[serde(default)]
    pub rebuild: Option<bool>,
    #[serde(default)]
    pub voxelize: Option<bool>,
    #[serde(default)]
    #[schema(value_type = Option<Object>)]
    pub hints: Option<Value>,
}

#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoxelizeRequest {
    /// 体素化风格（可选，由处理服务解释），例如 `default`。
    #[serde(default)]
    pub style: Option<String>,
}

#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RebuildRequest {
    #[serde(default)]
    #[schema(value_type = Option<Object>)]
    pub hints: Option<Value>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportModelRequest {
    /// 物件模型资源的内容哈希（经 model 用途上传并校验通过）。
    pub asset_hash: String,
}

/// 任务。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: String,
    pub space_id: String,
    /// `upload_verify`、`scan_import`、`rebuild`、`voxelize`、`model_import`、`ops_from_upload` 等。
    pub kind: String,
    /// `queued`、`running`、`done`、`failed`。
    pub status: String,
    #[schema(value_type = Object)]
    pub params: Value,
    pub attempt: u32,
    pub max_attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// 任务写出的提交。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_commit_id: Option<String>,
    /// 非提交结果，例如 `{needsAlignment, proposedTransform, errorCm}`（重扫配准误差过大）、`{modelHash}`。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Object>)]
    pub result: Option<Value>,
    /// 运行中的进度（执行任务的一方写入，原样返回），例如 `ops_from_upload` 的
    /// `{opsApplied, opsTotal}`。没有进度信息时省略。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Object>)]
    pub progress: Option<Value>,
    /// 发起任务的路径范围。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<String>, format = DateTime)]
    pub started_at: Option<Timestamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<String>, format = DateTime)]
    pub finished_at: Option<Timestamp>,
}

impl JobView {
    pub fn new(job: Job) -> Self {
        let text = |value: Value| value.as_str().unwrap_or_default().to_owned();
        Self {
            kind: text(serde_json::to_value(job.kind).unwrap_or(Value::Null)),
            status: text(serde_json::to_value(job.status).unwrap_or(Value::Null)),
            id: job.id,
            space_id: job.space_id,
            params: job.params,
            attempt: job.attempt,
            max_attempts: job.max_attempts,
            last_error: job.last_error,
            result_commit_id: job.result_commit_id,
            result: job.result,
            progress: job.progress,
            scope: job.scope.map(|scope| scope.to_string()),
            created_at: job.created_at,
            started_at: job.started_at,
            finished_at: job.finished_at,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct JobList {
    pub items: Vec<JobView>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct JobListQuery {
    /// 只列某个状态：queued | running | done | failed。
    pub status: Option<String>,
    /// 最多几条（1–100，默认 20）。
    pub limit: Option<i64>,
}

// ---------------------------------------------------------------------------
// 共用
// ---------------------------------------------------------------------------

async fn writable(
    state: &AppState,
    caller: &Caller,
    space_id: &str,
    plot_id: Option<&str>,
) -> Result<(Grant, PathScope), ApiError> {
    state
        .authorizer
        .require_capability(caller, Capability::WriteContent)?;
    let grant = state
        .authorizer
        .space(caller, space_id, Purpose::Manage)
        .await?;
    let (scope, _) = path_scope(state, &grant, plot_id).await?;
    Ok((grant, scope))
}

fn check_hash(name: &str, value: &str) -> Result<(), ApiError> {
    if is_sha256_hex(value) {
        Ok(())
    } else {
        Err(ApiError::invalid(format!(
            "{name} 必须是 64 位小写十六进制"
        )))
    }
}

fn check_hints(hints: &Option<Value>) -> Result<(), ApiError> {
    match hints {
        None => Ok(()),
        Some(Value::Object(_)) => match canonical_json(hints.as_ref().expect("已匹配")) {
            Ok(text) if text.len() <= MAX_HINTS_BYTES => Ok(()),
            _ => Err(invalid_with(
                "hints_too_large",
                "hints 必须是不超过 4KB 的 JSON 对象",
            )),
        },
        Some(_) => Err(ApiError::invalid("hints 必须是 JSON 对象")),
    }
}

/// 资源必须是本空间校验通过的上传。
async fn require_asset(
    state: &AppState,
    grant: &Grant,
    hash: &str,
    purposes: &[UploadPurpose],
    scope: Option<&PathScope>,
) -> Result<(), ApiError> {
    match state
        .repo
        .asset_availability(grant, hash, purposes, scope)
        .await?
    {
        AssetAvailability::Ready => Ok(()),
        AssetAvailability::Pending => Err(conflict_with(
            "asset_not_ready",
            "资源还在校验中，等 upload_verify 任务完成后再试",
        )),
        AssetAvailability::Missing => Err(invalid_with(
            "asset_unknown",
            "本空间没有这个资源的已校验上传（先经对应用途上传并完成）",
        )),
    }
}

/// 对齐变换线性部分（左上 3×3）行列式的下限（不含）：不大于它就是退化或镜像。
/// 与处理服务 `processing/align.py` 的 `matrix_from_params`（`det > 1e-6`）相同。
pub const MIN_TRANSFORM_DET: f64 = 1e-6;
/// 对齐变换平移分量的绝对值上限（米，含）。与处理服务相同，也等于形状坐标的上限
/// `metaverse_core::shape::MAX_COORD`。
pub const MAX_TRANSFORM_TRANSLATION: f64 = metaverse_core::shape::MAX_COORD;
/// 线性部分各元素的绝对值上限（防止溢出；处理服务不限，这里更严不会让它拒绝）。
const MAX_TRANSFORM_ELEMENT: f64 = 1e7;

/// 4×4 列主序仿射变换：16 个有限数，最后一行 [0,0,0,1]，线性部分可逆且不镜像
/// （行列式 > [`MIN_TRANSFORM_DET`]），平移的绝对值 ≤ [`MAX_TRANSFORM_TRANSLATION`]。
/// 阈值与处理服务完全相同：这里放行的变换，处理服务不会再以参数不合法拒绝。
fn check_transform(values: &[f64]) -> Result<[f64; 16], ApiError> {
    let invalid = || {
        invalid_with(
            "invalid_transform",
            "transform 必须是 16 个有限数（列主序 4×4），最后一行 [0,0,0,1]，线性部分可逆且不镜像（行列式 > 1e-6），平移的绝对值不超过 100000 米",
        )
    };
    let matrix: [f64; 16] = values.try_into().map_err(|_| invalid())?;
    if !matrix
        .iter()
        .all(|v| v.is_finite() && v.abs() <= MAX_TRANSFORM_ELEMENT)
    {
        return Err(invalid());
    }
    if matrix[3] != 0.0 || matrix[7] != 0.0 || matrix[11] != 0.0 || matrix[15] != 1.0 {
        return Err(invalid());
    }
    if matrix[12..15]
        .iter()
        .any(|t| t.abs() > MAX_TRANSFORM_TRANSLATION)
    {
        return Err(invalid());
    }
    let m = |row: usize, col: usize| matrix[col * 4 + row];
    let det = m(0, 0) * (m(1, 1) * m(2, 2) - m(1, 2) * m(2, 1))
        - m(0, 1) * (m(1, 0) * m(2, 2) - m(1, 2) * m(2, 0))
        + m(0, 2) * (m(1, 0) * m(2, 1) - m(1, 1) * m(2, 0));
    // 不能镜像，也不能退化（与处理服务相同）。
    if det <= MIN_TRANSFORM_DET {
        return Err(invalid());
    }
    Ok(matrix)
}

/// 建任务。带幂等键时编号由 (空间, 范围, 种类, 键) 算出。
async fn create_job(
    state: &AppState,
    caller: &Caller,
    grant: &Grant,
    scope: PathScope,
    kind: JobKind,
    params: Value,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let key = idempotency_key(headers)?;
    let kind_name = serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let id = match &key {
        Some(key) => {
            let digest =
                sha256_hex(format!("{}\0{scope}\0{kind_name}\0{key}", grant.space_id()).as_bytes());
            format!("job_{}", &digest[..32])
        }
        None => new_id("job"),
    };
    if key.is_some() {
        if let Some(existing) = state.repo.job(grant, &id).await? {
            return idempotent_reply(existing, kind, &params, grant.space_id());
        }
    }
    let limit = state.ingest.config.max_pending_jobs_per_space;
    if state.repo.pending_jobs(grant).await? >= limit {
        return Err(too_many(
            "too_many_jobs",
            format!("这个空间排队和运行中的任务最多 {limit} 个，请稍后再试"),
        ));
    }
    let job = Job {
        id,
        space_id: grant.space_id().to_owned(),
        owner: grant.owner().clone(),
        kind,
        params: params.clone(),
        status: JobStatus::Queued,
        lease_owner: None,
        lease_until: None,
        attempt: 0,
        max_attempts: JOB_MAX_ATTEMPTS,
        last_error: None,
        result_commit_id: None,
        created_at: crate::now()?,
        actor: Some(request_actor(caller)),
        scope: Some(scope.clone()),
        result: None,
        progress: None,
        started_at: None,
        finished_at: None,
    };
    match state.repo.insert_job(grant, &job).await? {
        JobInsert::Inserted => {}
        JobInsert::Existing(existing) => {
            return idempotent_reply(*existing, kind, &params, grant.space_id())
        }
    }
    tracing::info!(space = %job.space_id, job = %job.id, kind = %kind_name, by = %caller.subject, "任务已创建");
    let location = match &scope {
        PathScope::Plot(plot) => format!(
            "/api/v1/spaces/{}/plots/{plot}/jobs/{}",
            job.space_id, job.id
        ),
        _ => format!("/api/v1/spaces/{}/jobs/{}", job.space_id, job.id),
    };
    let mut response = (StatusCode::ACCEPTED, Json(JobView::new(job))).into_response();
    set_header(&mut response, header::LOCATION, &location);
    Ok(no_store(response))
}

fn idempotent_reply(
    existing: Job,
    kind: JobKind,
    params: &Value,
    space_id: &str,
) -> Result<Response, ApiError> {
    if existing.kind != kind || &existing.params != params || existing.space_id != space_id {
        return Err(conflict_with(
            "idempotency_key_reused",
            "这个 Idempotency-Key 已用于参数不同的请求",
        ));
    }
    Ok(no_store(Json(JobView::new(existing)).into_response()))
}

/// scan_import 的参数。
fn scan_params(
    asset_hash: &str,
    observed_at: Option<Timestamp>,
    rebuild: Option<bool>,
    voxelize: Option<bool>,
    hints: Option<Value>,
    transform: Option<[f64; 16]>,
) -> Value {
    let mut params = Map::new();
    params.insert("assetHash".into(), json!(asset_hash));
    if let Some(at) = observed_at {
        params.insert("observedAt".into(), json!(at.to_rfc3339()));
    }
    if let Some(transform) = transform {
        params.insert("transform".into(), json!(transform));
    }
    params.insert("rebuild".into(), json!(rebuild.unwrap_or(true)));
    params.insert("voxelize".into(), json!(voxelize.unwrap_or(false)));
    if let Some(hints) = hints {
        params.insert("hints".into(), hints);
    }
    Value::Object(params)
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/scans",
    operation_id = "import_scan",
    tag = "scans",
    description = "导入扫描（只经实体区路径）：建 scan_import 任务，返回 202 和任务。处理服务读取扫描 → 对齐（首次自动对齐并固定坐标系，重扫自动配准；误差超阈值时不提交，任务 result = {needsAlignment, proposedTransform, errorCm}，再用 align_scan 给出变换）→ 网页用模型 → AI 重建 → 写一次提交 →（可选）体素化。assetHash 必须是本空间经 scan 用途上传并校验通过的资源；它就是扫描编号 scan_id。每个空间排队和运行中的任务数有上限（429）。可带 Idempotency-Key。",
    params(("space_id" = String, Path, description = "空间编号", example = "front-hall")),
    request_body = ImportScanRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 202, description = "任务已创建", body = JobView),
        (status = 200, description = "幂等键重复，返回已有任务", body = JobView),
        (status = 403, description = "没有写权限", body = ProblemDocument),
        (status = 404, description = "空间不存在", body = ProblemDocument),
        (status = 409, description = "资源还在校验中，或幂等键已用于别的请求", body = ProblemDocument),
        (status = 422, description = "参数不合法或资源不存在", body = ProblemDocument),
        (status = 429, description = "任务太多", body = ProblemDocument),
    )
)]
pub async fn import_scan(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<ImportScanRequest>,
) -> Result<Response, ApiError> {
    let (grant, scope) = writable(&state, &caller, &space_id, None).await?;
    check_hash("assetHash", &request.asset_hash)?;
    check_hints(&request.hints)?;
    require_asset(
        &state,
        &grant,
        &request.asset_hash,
        &[UploadPurpose::Scan],
        None,
    )
    .await?;
    let params = scan_params(
        &request.asset_hash,
        request.observed_at,
        request.rebuild,
        request.voxelize,
        request.hints,
        None,
    );
    create_job(
        &state,
        &caller,
        &grant,
        scope,
        JobKind::ScanImport,
        params,
        &headers,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/scans/{scan_id}/alignment",
    operation_id = "align_scan",
    tag = "scans",
    description = "用给定的对齐变换重新导入扫描（重扫配准误差过大、需要人工微调时用）：建带 transform 的 scan_import 任务。transform 是 4×4 列主序矩阵（扫描坐标 → 空间坐标），通常取任务结果里的 proposedTransform 微调；最后一行 [0,0,0,1]，线性部分行列式 > 1e-6（不能镜像或退化），平移绝对值 ≤ 100000 米，否则 422。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("scan_id" = String, Path, description = "扫描编号（扫描资源的内容哈希）"),
    ),
    request_body = AlignScanRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 202, description = "任务已创建", body = JobView),
        (status = 200, description = "幂等键重复，返回已有任务", body = JobView),
        (status = 409, description = "资源还在校验中", body = ProblemDocument),
        (status = 422, description = "变换不合法或资源不存在", body = ProblemDocument),
        (status = 429, description = "任务太多", body = ProblemDocument),
    )
)]
pub async fn align_scan(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, scan_id)): Path<(String, String)>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<AlignScanRequest>,
) -> Result<Response, ApiError> {
    let (grant, scope) = writable(&state, &caller, &space_id, None).await?;
    if !is_sha256_hex(&scan_id) {
        return Err(ApiError::not_found());
    }
    let transform = check_transform(&request.transform)?;
    check_hints(&request.hints)?;
    require_asset(&state, &grant, &scan_id, &[UploadPurpose::Scan], None).await?;
    let params = scan_params(
        &scan_id,
        request.observed_at,
        request.rebuild,
        request.voxelize,
        request.hints,
        Some(transform),
    );
    create_job(
        &state,
        &caller,
        &grant,
        scope,
        JobKind::ScanImport,
        params,
        &headers,
    )
    .await
}

/// 已导入本空间的扫描才能体素化、重建。
async fn committed_scan(state: &AppState, grant: &Grant, scan_id: &str) -> Result<(), ApiError> {
    if is_sha256_hex(scan_id) && state.repo.scan_committed(grant, scan_id).await? {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "scan_not_found",
            "这个空间还没有导入这个扫描",
        ))
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/scans/{scan_id}/voxelize",
    operation_id = "voxelize_scan",
    tag = "scans",
    description = "把已导入的扫描体素化（方块风格，写区块和方块表到重建层）：建 voxelize 任务。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("scan_id" = String, Path, description = "扫描编号（扫描资源的内容哈希）"),
    ),
    request_body = VoxelizeRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 202, description = "任务已创建", body = JobView),
        (status = 200, description = "幂等键重复，返回已有任务", body = JobView),
        (status = 404, description = "空间或扫描不存在", body = ProblemDocument),
        (status = 429, description = "任务太多", body = ProblemDocument),
    )
)]
pub async fn voxelize_scan(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, scan_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, ApiError> {
    let request: VoxelizeRequest = optional_json(&body)?;
    let (grant, scope) = writable(&state, &caller, &space_id, None).await?;
    committed_scan(&state, &grant, &scan_id).await?;
    let mut params = Map::new();
    params.insert("scanAssetHash".into(), json!(scan_id));
    if let Some(style) = request.style {
        if !is_object_id(&style) || style.len() > 64 {
            return Err(ApiError::invalid("style 只能是 1–64 个字母、数字、-、_、."));
        }
        params.insert("style".into(), json!(style));
    }
    create_job(
        &state,
        &caller,
        &grant,
        scope,
        JobKind::Voxelize,
        Value::Object(params),
        &headers,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/scans/{scan_id}/rebuild",
    operation_id = "rebuild_scan",
    tag = "scans",
    description = "对已导入的扫描重跑 AI 重建（结构 + 物体），结果写成一次新提交：建 rebuild 任务。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("scan_id" = String, Path, description = "扫描编号（扫描资源的内容哈希）"),
    ),
    request_body = RebuildRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 202, description = "任务已创建", body = JobView),
        (status = 200, description = "幂等键重复，返回已有任务", body = JobView),
        (status = 404, description = "空间或扫描不存在", body = ProblemDocument),
        (status = 422, description = "hints 不合法", body = ProblemDocument),
        (status = 429, description = "任务太多", body = ProblemDocument),
    )
)]
pub async fn rebuild_scan(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, scan_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, ApiError> {
    let request: RebuildRequest = optional_json(&body)?;
    let (grant, scope) = writable(&state, &caller, &space_id, None).await?;
    committed_scan(&state, &grant, &scan_id).await?;
    check_hints(&request.hints)?;
    let mut params = Map::new();
    params.insert("scanAssetHash".into(), json!(scan_id));
    if let Some(hints) = request.hints {
        params.insert("hints".into(), hints);
    }
    create_job(
        &state,
        &caller,
        &grant,
        scope,
        JobKind::Rebuild,
        Value::Object(params),
        &headers,
    )
    .await
}

// ---------------------------------------------------------------------------
// 物件模型
// ---------------------------------------------------------------------------

async fn model(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    headers: HeaderMap,
    request: ImportModelRequest,
) -> Result<Response, ApiError> {
    let (grant, scope) = writable(&state, &caller, &space_id, plot_id.as_deref()).await?;
    check_hash("assetHash", &request.asset_hash)?;
    let same_scope = matches!(scope, PathScope::Plot(_)).then_some(&scope);
    require_asset(
        &state,
        &grant,
        &request.asset_hash,
        &[UploadPurpose::Model],
        same_scope,
    )
    .await?;
    let params = json!({"assetHash": request.asset_hash});
    create_job(
        &state,
        &caller,
        &grant,
        scope,
        JobKind::ModelImport,
        params,
        &headers,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/models",
    operation_id = "import_model",
    tag = "scans",
    description = "导入物件模型（实体区路径）：建 model_import 任务。处理服务校验模型、重新导出成受限的 glb（限制三角形数和贴图尺寸）并登记处理后的资源，任务 result = {modelHash}；\"放物件\"只能引用 modelHash。assetHash 必须是本空间经 model 用途上传并校验通过的资源。",
    params(("space_id" = String, Path, description = "空间编号")),
    request_body = ImportModelRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 202, description = "任务已创建", body = JobView),
        (status = 200, description = "幂等键重复，返回已有任务", body = JobView),
        (status = 409, description = "资源还在校验中", body = ProblemDocument),
        (status = 422, description = "资源不存在", body = ProblemDocument),
        (status = 429, description = "任务太多", body = ProblemDocument),
    )
)]
pub async fn import_model(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<ImportModelRequest>,
) -> Result<Response, ApiError> {
    model(state, caller, space_id, None, headers, request).await
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/models",
    operation_id = "import_plot_model",
    tag = "scans",
    description = "导入物件模型（地块路径）：同 import_model，但资源必须是经同一地块路径上传的。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("plot_id" = String, Path, description = "地块编号"),
    ),
    request_body = ImportModelRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 202, description = "任务已创建", body = JobView),
        (status = 200, description = "幂等键重复，返回已有任务", body = JobView),
        (status = 404, description = "空间或地块不存在", body = ProblemDocument),
        (status = 422, description = "资源不存在", body = ProblemDocument),
        (status = 429, description = "任务太多", body = ProblemDocument),
    )
)]
pub async fn import_plot_model(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, plot_id)): Path<(String, String)>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<ImportModelRequest>,
) -> Result<Response, ApiError> {
    model(state, caller, space_id, Some(plot_id), headers, request).await
}

// ---------------------------------------------------------------------------
// 查任务
// ---------------------------------------------------------------------------

async fn readable(
    state: &AppState,
    caller: &Caller,
    space_id: &str,
    plot_id: Option<&str>,
) -> Result<(Grant, PathScope), ApiError> {
    let grant = state
        .authorizer
        .space(caller, space_id, Purpose::Read)
        .await?;
    let (scope, _) = path_scope(state, &grant, plot_id).await?;
    Ok((grant, scope))
}

async fn show(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    job_id: String,
) -> Result<Response, ApiError> {
    let (grant, scope) = readable(&state, &caller, &space_id, plot_id.as_deref()).await?;
    if !is_object_id(&job_id) {
        return Err(ApiError::not_found());
    }
    let job = state
        .repo
        .job(&grant, &job_id)
        .await?
        .filter(|job| scope == PathScope::Physical || job.scope.as_ref() == Some(&scope))
        .ok_or_else(ApiError::not_found)?;
    Ok(no_store(Json(JobView::new(job)).into_response()))
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/jobs/{job_id}",
    operation_id = "get_job",
    tag = "scans",
    description = "查询任务进度和结果：status（queued/running/done/failed）、重试次数、失败原因、结果提交和非提交结果（例如需要人工对齐时的 proposedTransform）。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("job_id" = String, Path, description = "任务编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "任务", body = JobView),
        (status = 404, description = "任务不存在或无权查看", body = ProblemDocument),
    )
)]
pub async fn get_job(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, job_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    show(state, caller, space_id, None, job_id).await
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/jobs/{job_id}",
    operation_id = "get_plot_job",
    tag = "scans",
    description = "查询任务（地块路径）：只能查到经这个地块路径发起的任务。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("plot_id" = String, Path, description = "地块编号"),
        ("job_id" = String, Path, description = "任务编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "任务", body = JobView),
        (status = 404, description = "任务不存在或不属于这个地块", body = ProblemDocument),
    )
)]
pub async fn get_plot_job(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, plot_id, job_id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    show(state, caller, space_id, Some(plot_id), job_id).await
}

async fn list(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    query: JobListQuery,
) -> Result<Response, ApiError> {
    let (grant, scope) = readable(&state, &caller, &space_id, plot_id.as_deref()).await?;
    let status = match query.status.as_deref() {
        None => None,
        Some(text) => Some(
            serde_json::from_value::<JobStatus>(json!(text))
                .map_err(|_| ApiError::invalid("status 只能是 queued、running、done、failed"))?,
        ),
    };
    let scope_filter = matches!(scope, PathScope::Plot(_)).then_some(&scope);
    let jobs = state
        .repo
        .recent_jobs(&grant, scope_filter, status, query.limit.unwrap_or(20))
        .await?;
    Ok(no_store(
        Json(JobList {
            items: jobs.into_iter().map(JobView::new).collect(),
        })
        .into_response(),
    ))
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/jobs",
    operation_id = "list_jobs",
    tag = "scans",
    description = "最近的任务（按创建时间倒序，最多 100 条），可按状态过滤。",
    params(("space_id" = String, Path, description = "空间编号"), JobListQuery),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "任务列表", body = JobList),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
    )
)]
pub async fn list_jobs(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
    Query(query): Query<JobListQuery>,
) -> Result<Response, ApiError> {
    list(state, caller, space_id, None, query).await
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/jobs",
    operation_id = "list_plot_jobs",
    tag = "scans",
    description = "最近的任务（地块路径）：只列经这个地块路径发起的任务。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("plot_id" = String, Path, description = "地块编号"),
        JobListQuery
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "任务列表", body = JobList),
        (status = 404, description = "空间或地块不存在", body = ProblemDocument),
    )
)]
pub async fn list_plot_jobs(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, plot_id)): Path<(String, String)>,
    Query(query): Query<JobListQuery>,
) -> Result<Response, ApiError> {
    list(state, caller, space_id, Some(plot_id), query).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transforms_must_be_affine_and_invertible() {
        let identity = [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 2.0, 0.0, 3.0, 1.0,
        ];
        assert!(check_transform(&identity).is_ok());
        assert!(check_transform(&identity[..15]).is_err());
        let mut projective = identity;
        projective[3] = 0.5;
        assert!(check_transform(&projective).is_err());
        let mut flat = identity;
        flat[0] = 0.0;
        assert!(check_transform(&flat).is_err());
        let mut mirrored = identity;
        mirrored[0] = -1.0;
        assert!(check_transform(&mirrored).is_err());
        let mut nan = identity;
        nan[12] = f64::NAN;
        assert!(check_transform(&nan).is_err());
    }

    /// 边界值与处理服务 `matrix_from_params` 相同：行列式必须 > 1e-6，平移绝对值 ≤ 1e5。
    #[test]
    fn transform_limits_match_the_worker() {
        let scaled = |s: f64| {
            [
                s, 0.0, 0.0, 0.0, 0.0, s, 0.0, 0.0, 0.0, 0.0, s, 0.0, 0.0, 0.0, 0.0, 1.0,
            ]
        };
        // 毫米 → 米（0.001 倍，行列式 1e-9）：两边都拒绝。
        assert!(check_transform(&scaled(0.001)).is_err());
        // 0.0099³ ≈ 9.7e-7：不大于下限，拒绝（原来的 1e-9 下限会放行）；0.011³ ≈ 1.33e-6：通过。
        assert!(check_transform(&scaled(0.0099)).is_err());
        assert!(check_transform(&scaled(0.011)).is_ok());
        let translated = |x: f64, y: f64, z: f64| {
            let mut m = scaled(1.0);
            m[12] = x;
            m[13] = y;
            m[14] = z;
            m
        };
        assert!(check_transform(&translated(1e5, -1e5, 0.0)).is_ok());
        assert!(check_transform(&translated(1e5 + 1.0, 0.0, 0.0)).is_err());
        assert!(check_transform(&translated(0.0, -100_000.5, 0.0)).is_err());
        assert!(check_transform(&translated(0.0, 0.0, 2e6)).is_err());
        assert_eq!(MAX_TRANSFORM_TRANSLATION, 1e5);
        assert_eq!(MIN_TRANSFORM_DET, 1e-6);
    }

    #[test]
    fn hints_are_small_objects() {
        assert!(check_hints(&None).is_ok());
        assert!(check_hints(&Some(json!({"floor": "tile"}))).is_ok());
        assert!(check_hints(&Some(json!([1]))).is_err());
        assert!(check_hints(&Some(json!({"x": "y".repeat(5000)}))).is_err());
    }
}
