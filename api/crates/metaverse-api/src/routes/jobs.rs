//! 任务查询（设计 6.4）。
//!
//! ```text
//! GET  /api/v1/spaces/{space_id}[/plots/{plot_id}]/jobs/{job_id}
//! GET  /api/v1/spaces/{space_id}[/plots/{plot_id}]/jobs         最近的任务
//! ```
//!
//! 任务由上传完成（`upload_verify`）、操作文件追加和交包（`ops_from_upload`）、部署种子
//! （`bundle_import`）建立，由接口服务的后台执行器执行。处理服务下线前的旧种类（`scan_import`、
//! `rebuild`、`voxelize`、`model_import` 等）的记录照样能查；发起它们的接口已下线（410，见
//! `routes/retired.rs`）。实体区路径看得到本空间所有范围的任务；地块路径、重建路径只看得到各自范围
//! 发起的。

use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use metaverse_core::ids::is_object_id;
use metaverse_core::model::{Job, JobStatus};
use metaverse_core::scope::PathScope;
use metaverse_core::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::{IntoParams, ToSchema};

use super::ingest_common::{no_store, path_scope};
use crate::auth::{Caller, Grant, Purpose};
use crate::error::{ApiError, ProblemDocument};
use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
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
// 视图
// ---------------------------------------------------------------------------

/// 任务。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: String,
    pub space_id: String,
    /// `upload_verify`、`ops_from_upload`（含交包）、`bundle_import`；处理服务下线前的旧种类
    /// （`scan_import`、`rebuild`、`voxelize`、`model_import` 等）照样能查。
    pub kind: String,
    /// `queued`、`running`、`done`、`failed`。
    pub status: String,
    #[schema(value_type = Object)]
    pub params: Value,
    pub attempt: u32,
    pub max_attempts: u32,
    /// 上一次的错误说明。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// 上一次错误的类别：`content`（内容不合规，不重试）、`fetch`（下载失败，按退避重试）、
    /// `transient`（暂时性问题，按退避重试）。处理服务下线前的旧记录没有。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_class: Option<String>,
    /// 退回队列后最早什么时候再领取。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<String>, format = DateTime)]
    pub not_before: Option<Timestamp>,
    /// 任务写出的提交。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_commit_id: Option<String>,
    /// 非提交结果：上传核对的 `{assetHash, reused, format}`、交包的展开结果、部署种子的导入结果；
    /// 处理服务下线前的旧任务另有 `{needsAlignment, proposedTransform, errorCm}`、`{modelHash}`。
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
            error_class: job
                .last_error
                .as_ref()
                .and_then(|error| error.class())
                .map(|class| class.name().to_owned()),
            last_error: job.last_error.map(|error| error.message().to_owned()),
            not_before: job.not_before,
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
// 查任务
// ---------------------------------------------------------------------------

/// 读任务的凭据和路径范围。`rebuild` 为真时是重建路径（只看得到重建范围的任务）。
pub(super) async fn readable(
    state: &AppState,
    caller: &Caller,
    space_id: &str,
    plot_id: Option<&str>,
    rebuild: bool,
) -> Result<(Grant, PathScope), ApiError> {
    let grant = state
        .authorizer
        .space(caller, space_id, Purpose::Read)
        .await?;
    if rebuild {
        return Ok((grant, PathScope::Rebuild));
    }
    let (scope, _) = path_scope(state, &grant, plot_id).await?;
    Ok((grant, scope))
}

/// 查一个任务。实体区路径看得到本空间所有范围的任务；地块路径、重建路径只看得到各自范围发起的。
pub(super) async fn show(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    rebuild: bool,
    job_id: String,
) -> Result<Response, ApiError> {
    let (grant, scope) = readable(&state, &caller, &space_id, plot_id.as_deref(), rebuild).await?;
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
    tag = "jobs",
    description = "查询任务进度和结果：status（queued/running/done/failed）、重试次数、失败原因和类别、结果提交和非提交结果（上传核对的 assetHash、交包的展开结果等）。实体区路径看得到本空间所有范围的任务。",
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
    show(state, caller, space_id, None, false, job_id).await
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/jobs/{job_id}",
    operation_id = "get_plot_job",
    tag = "jobs",
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
    show(state, caller, space_id, Some(plot_id), false, job_id).await
}

/// 最近的任务。地块路径、重建路径只列各自范围发起的。
pub(super) async fn list(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    rebuild: bool,
    query: JobListQuery,
) -> Result<Response, ApiError> {
    let (grant, scope) = readable(&state, &caller, &space_id, plot_id.as_deref(), rebuild).await?;
    let status = match query.status.as_deref() {
        None => None,
        Some(text) => Some(
            serde_json::from_value::<JobStatus>(json!(text))
                .map_err(|_| ApiError::invalid("status 只能是 queued、running、done、failed"))?,
        ),
    };
    let scope_filter = matches!(scope, PathScope::Plot(_) | PathScope::Rebuild).then_some(&scope);
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
    tag = "jobs",
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
    list(state, caller, space_id, None, false, query).await
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/jobs",
    operation_id = "list_plot_jobs",
    tag = "jobs",
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
    list(state, caller, space_id, Some(plot_id), false, query).await
}
