//! 草稿接口（设计 5.6、8.3）：实体区 `/api/v1/spaces/{space_id}/drafts...` 和地块
//! `/api/v1/spaces/{space_id}/plots/{plot_id}/drafts...` 两组路径，每组一套 operationId，
//! NyxID 的操作范围可以按路径分别授权（例如地块 key 可以发布，实体区 key 只能建草稿和预览）。
//!
//! - 草稿属于创建时的路径范围：经别的范围的路径访问一律 404；
//! - 批量操作每次 ≤ 200 条、请求体 ≤ 1MB，超出返回 413 并提示改走上传；
//! - 地块路径下每个操作都必须落在地块内，实体区路径只能改实体区，越界返回 403 `out_of_scope`；
//! - 发布时与 (baseSeq, head] 的变化有交集返回 409 `draft_conflict` 并列出冲突的键
//!   （`chunk:<图层>:cx,cy,cz`、`entity:<编号>`、`anchor:<编号>`、`palette:<方块名>`），
//!   可以带 `replay: true` 在最新版本上重放；按最新的区域和地块越界返回 409 `out_of_scope`。

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use metaverse_core::chunk::ChunkKey;
use metaverse_core::ids::is_object_id;
use metaverse_core::model::{Author, Touched, DRAFT_TTL_SECONDS};
use metaverse_core::ops::{OpError, MAX_OPS_PER_BATCH};
use metaverse_core::scope::PathScope;
use metaverse_core::{is_sha256_hex, sha256_hex, Timestamp};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use super::admin_spaces::check_text;
use crate::auth::permissions::Capability;
use crate::auth::{Caller, Grant, Purpose};
use crate::error::{ApiError, ProblemDocument, PROBLEM_TYPE_PREFIX};
use crate::repo::{DraftDoc, DraftStatus, NewPreview, OpsRef};
use crate::timeline::drafts::{
    append_ops, ops_job_result, parse_op_values, parse_ops_file_blocking, publish, OpsSource,
    PublishError, PublishOptions, MAX_DRAFT_OPS, MAX_DRAFT_OPS_REFS, MAX_OPS_FILE_BYTES,
};
use crate::timeline::state::ApplyError;
use crate::timeline::writer::ensure_genesis;
use crate::AppState;

/// 批量操作的请求体上限（设计 8.3）。
pub const OPS_BODY_LIMIT: usize = 1024 * 1024;
/// 其他草稿接口的请求体上限。
pub const SMALL_BODY_LIMIT: usize = 64 * 1024;
/// 预览令牌默认有效期（秒）。
pub const PREVIEW_TTL_DEFAULT: i64 = 24 * 3600;
/// 预览令牌最长有效期（秒）。
pub const PREVIEW_TTL_MAX: i64 = 7 * 24 * 3600;
/// ops_from_upload 任务的租约（接口服务进程中途退出时，由处理服务回收为失败）。
const OPS_JOB_LEASE_SECONDS: i64 = 30 * 60;

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// 草稿碰过的键。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TouchedView {
    /// `[{layer, cx, cy, cz}]`
    #[schema(value_type = Vec<Object>)]
    pub chunks: Vec<ChunkKey>,
    pub entities: Vec<String>,
    pub anchors: Vec<String>,
    /// 是否新增了方块。
    pub palette: bool,
}

impl From<&Touched> for TouchedView {
    fn from(touched: &Touched) -> Self {
        Self {
            chunks: touched.chunks.clone(),
            entities: touched.entities.clone(),
            anchors: touched.anchors.clone(),
            palette: touched.palette,
        }
    }
}

/// 草稿新增的方块（临时编号，发布时换成正式编号）。
#[derive(Debug, Serialize, ToSchema)]
pub struct ProvisionalBlockView {
    pub name: String,
    pub id: u16,
}

/// 草稿。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DraftView {
    pub id: String,
    pub space_id: String,
    /// `physical` 或 `plot:<编号>`。
    pub scope: String,
    /// 基于哪个版本。
    pub base_seq: u64,
    /// 草稿版本，每追加一次加一；预览令牌绑定这个版本。
    pub rev: u64,
    /// `open` 或 `published`。
    pub status: String,
    pub created_by: String,
    pub ops_count: u64,
    /// 经上传追加的操作：`[{assetHash, after, count}]`。
    #[schema(value_type = Vec<Object>)]
    pub ops_refs: Vec<OpsRef>,
    pub touched: TouchedView,
    pub provisional_blocks: Vec<ProvisionalBlockView>,
    /// 草稿引用的资源（模型、贴图）。
    pub assets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_id: Option<String>,
    #[schema(value_type = String)]
    pub created_at: Timestamp,
    #[schema(value_type = String)]
    pub updated_at: Timestamp,
    #[schema(value_type = String)]
    pub expires_at: Timestamp,
}

impl From<&DraftDoc> for DraftView {
    fn from(draft: &DraftDoc) -> Self {
        Self {
            id: draft.id.clone(),
            space_id: draft.space_id.clone(),
            scope: draft.scope.to_string(),
            base_seq: draft.base_seq,
            rev: draft.rev,
            status: match draft.status {
                DraftStatus::Open => "open",
                DraftStatus::Published => "published",
            }
            .to_owned(),
            created_by: draft.created_by.sub.clone(),
            ops_count: draft.op_count(),
            ops_refs: draft.ops_refs.clone(),
            touched: TouchedView::from(&draft.touched),
            provisional_blocks: draft
                .provisional_blocks
                .iter()
                .map(|b| ProvisionalBlockView {
                    name: b.name.clone(),
                    id: b.id,
                })
                .collect(),
            assets: draft.assets.clone(),
            commit_id: draft.commit_id.clone(),
            created_at: draft.created_at,
            updated_at: draft.updated_at,
            expires_at: draft.expires_at,
        }
    }
}

fn json_response<T: Serialize>(status: StatusCode, body: &T) -> Response {
    let mut response = (status, Json(body)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

/// 带附加字段的错误文档（RFC 9457 允许扩展字段）。
fn problem_with(status: StatusCode, code: &'static str, detail: String, extra: Value) -> Response {
    let mut body = json!({
        "type": format!("{PROBLEM_TYPE_PREFIX}{}", code.replace('_', "-")),
        "title": code.replace('_', " "),
        "status": status.as_u16(),
        "detail": detail,
        "code": code,
    });
    if let (Value::Object(map), Value::Object(extra)) = (&mut body, extra) {
        map.extend(extra);
    }
    let mut response = (status, Json(body)).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/problem+json"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn op_error(error: OpError) -> ApiError {
    match error {
        OpError::Scope { .. } => ApiError::new(
            StatusCode::FORBIDDEN,
            "out_of_scope",
            format!("{error}（地块路径下每个操作都必须落在地块内，实体区路径只能改实体区）"),
        ),
        OpError::TooManyOps => ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request_too_large",
            "一批最多 200 条操作，更多的操作请写成 NDJSON 文件分片上传，再调用 ops-from-upload",
        ),
        OpError::Invalid { .. } => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_op",
            error.to_string(),
        ),
    }
}

fn apply_error(error: ApplyError) -> ApiError {
    match error {
        ApplyError::Op(error) => op_error(error),
        ApplyError::Api(error) => error,
    }
}

// ---------------------------------------------------------------------------
// 公共步骤
// ---------------------------------------------------------------------------

/// 路径给出的草稿范围。地块编号格式不对就当作不存在。
fn path_scope(plot_id: Option<String>) -> Result<PathScope, ApiError> {
    match plot_id {
        None => Ok(PathScope::Physical),
        Some(id) if is_object_id(&id) && !id.starts_with('_') => Ok(PathScope::Plot(id)),
        Some(_) => Err(ApiError::not_found()),
    }
}

/// 草稿的写操作（建草稿、追加、从上传应用、预览、发布、丢弃）：功能级开关打开时先要求
/// `metaverse:content:write`（与上传、扫描任务相同），再做资源级"管理"检查。
async fn writable(state: &AppState, caller: &Caller, space_id: &str) -> Result<Grant, ApiError> {
    state
        .authorizer
        .require_capability(caller, Capability::WriteContent)?;
    state
        .authorizer
        .space(caller, space_id, Purpose::Manage)
        .await
}

/// 按路径读草稿：经别的范围的路径访问一律 404（不暴露草稿是否存在）。
async fn scoped_draft(
    state: &AppState,
    grant: &Grant,
    scope: &PathScope,
    draft_id: &str,
) -> Result<DraftDoc, ApiError> {
    if !is_object_id(draft_id) {
        return Err(ApiError::not_found());
    }
    let draft = state
        .repo
        .draft(grant, draft_id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if &draft.scope != scope {
        return Err(ApiError::not_found());
    }
    Ok(draft)
}

fn parse_optional<T: for<'de> Deserialize<'de> + Default>(body: &Bytes) -> Result<T, ApiError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(T::default());
    }
    serde_json::from_slice(body).map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_request",
            format!("请求体不合法：{error}"),
        )
    })
}

// ---------------------------------------------------------------------------
// 建草稿
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateDraftRequest {
    /// 基于哪个版本（默认最新）。命令行按拉取时的版本建草稿，发布时据此判断冲突。
    pub base_seq: Option<u64>,
}

async fn create(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    body: Bytes,
) -> Result<Response, ApiError> {
    let scope = path_scope(plot_id)?;
    let grant = writable(&state, &caller, &space_id).await?;
    let request: CreateDraftRequest = parse_optional(&body)?;
    let now = crate::now()?;
    ensure_genesis(&state.repo, &grant, &caller, now).await?;
    let space = state
        .repo
        .space(&grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if let PathScope::Plot(id) = &scope {
        if !space.plots.iter().any(|plot| &plot.id == id) {
            return Err(ApiError::not_found());
        }
    }
    let base_seq = request.base_seq.unwrap_or(space.head.seq);
    if base_seq > space.head.seq || base_seq == 0 {
        return Err(ApiError::invalid(format!(
            "baseSeq 必须在 1 到当前版本 {} 之间",
            space.head.seq
        )));
    }
    let draft = DraftDoc {
        id: format!("d_{}", uuid::Uuid::new_v4().simple()),
        space_id: space_id.clone(),
        owner: grant.owner().clone(),
        scope,
        base_seq,
        rev: 0,
        created_by: Author {
            sub: caller.subject.clone(),
        },
        status: DraftStatus::Open,
        ops: Vec::new(),
        ops_refs: Vec::new(),
        touched: Touched::default(),
        result_chunks: Vec::new(),
        result_entities: Vec::new(),
        result_anchors: Vec::new(),
        provisional_blocks: Vec::new(),
        assets: Vec::new(),
        commit_id: None,
        work_cells: 0,
        created_at: now,
        updated_at: now,
        expires_at: now.saturating_add_seconds(DRAFT_TTL_SECONDS),
    };
    state.repo.insert_draft(&grant, &draft).await?;
    tracing::info!(space = %space_id, draft = %draft.id, scope = %draft.scope, by = %caller.subject, "草稿已创建");
    let mut response = json_response(StatusCode::CREATED, &DraftView::from(&draft));
    let location = match &draft.scope {
        PathScope::Plot(plot) => {
            format!("/api/v1/spaces/{space_id}/plots/{plot}/drafts/{}", draft.id)
        }
        _ => format!("/api/v1/spaces/{space_id}/drafts/{}", draft.id),
    };
    if let Ok(value) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/drafts",
    operation_id = "create_draft",
    tag = "drafts",
    description = "在实体区建一个草稿（还没发布的修改）。之后用 append_draft_ops 追加操作、create_draft_preview 生成预览链接、publish_draft 发布。草稿只能改实体区，30 天后过期。可选 baseSeq 指定基于哪个版本（默认最新）。",
    params(("space_id" = String, Path, description = "空间编号", example = "front-hall")),
    request_body(content = Option<CreateDraftRequest>, description = "可省略"),
    security(("nyxid_identity" = [])),
    responses(
        (status = 201, description = "新草稿", body = DraftView),
        (status = 401, description = "身份令牌无效", body = ProblemDocument),
        (status = 403, description = "只有只读权限", body = ProblemDocument),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
        (status = 422, description = "baseSeq 不合法", body = ProblemDocument),
    )
)]
pub async fn create_draft(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
    body: Bytes,
) -> Result<Response, ApiError> {
    create(state, caller, space_id, None, body).await
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/drafts",
    operation_id = "create_plot_draft",
    tag = "drafts",
    description = "在某个地块建一个草稿。之后经同一地块路径追加操作、预览、发布；每个操作都必须落在这个地块内。30 天后过期。可选 baseSeq 指定基于哪个版本（默认最新）。",
    params(
        ("space_id" = String, Path, description = "空间编号", example = "front-hall"),
        ("plot_id" = String, Path, description = "地块编号", example = "p1"),
    ),
    request_body(content = Option<CreateDraftRequest>, description = "可省略"),
    security(("nyxid_identity" = [])),
    responses(
        (status = 201, description = "新草稿", body = DraftView),
        (status = 401, description = "身份令牌无效", body = ProblemDocument),
        (status = 403, description = "只有只读权限", body = ProblemDocument),
        (status = 404, description = "空间或地块不存在，或无权查看", body = ProblemDocument),
        (status = 422, description = "baseSeq 不合法", body = ProblemDocument),
    )
)]
pub async fn create_plot_draft(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, plot_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    create(state, caller, space_id, Some(plot_id), body).await
}

// ---------------------------------------------------------------------------
// 读草稿
// ---------------------------------------------------------------------------

async fn read(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    draft_id: String,
) -> Result<Response, ApiError> {
    let scope = path_scope(plot_id)?;
    let grant = state
        .authorizer
        .space(&caller, &space_id, Purpose::Read)
        .await?;
    let draft = scoped_draft(&state, &grant, &scope, &draft_id).await?;
    Ok(json_response(StatusCode::OK, &DraftView::from(&draft)))
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/drafts/{draft_id}",
    operation_id = "get_draft",
    tag = "drafts",
    description = "读取实体区草稿的状态：基于的版本、rev、操作条数、碰过的区块/物件/锚点、新增的方块、是否已发布。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("draft_id" = String, Path, description = "草稿编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "草稿", body = DraftView),
        (status = 404, description = "草稿不存在、不属于实体区，或无权查看", body = ProblemDocument),
    )
)]
pub async fn get_draft(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, draft_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    read(state, caller, space_id, None, draft_id).await
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/drafts/{draft_id}",
    operation_id = "get_plot_draft",
    tag = "drafts",
    description = "读取地块草稿的状态。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("plot_id" = String, Path, description = "地块编号"),
        ("draft_id" = String, Path, description = "草稿编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "草稿", body = DraftView),
        (status = 404, description = "草稿不存在、不属于这个地块，或无权查看", body = ProblemDocument),
    )
)]
pub async fn get_plot_draft(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, plot_id, draft_id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    read(state, caller, space_id, Some(plot_id), draft_id).await
}

// ---------------------------------------------------------------------------
// 批量操作
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppendOpsRequest {
    /// 高层操作（每次 ≤ 200 条）：`fill`、`hollowBox`、`replace`、`copyRegion`、`addBlock`、
    /// `placeEntity`、`removeEntity`、`createAnchor`、`moveAnchor`、`updateAnchor`、`removeAnchor`。
    #[schema(value_type = Vec<Object>)]
    pub ops: Vec<Value>,
    /// 调用方看到的草稿版本；给了就必须一致，否则 409。
    pub rev: Option<u64>,
}

async fn append(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    draft_id: String,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Result<Response, ApiError> {
    let scope = path_scope(plot_id)?;
    let grant = writable(&state, &caller, &space_id).await?;
    let body = body.map_err(|rejection| {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_too_large",
                "批量操作的请求体最多 1MB；更多的操作请写成 NDJSON 文件分片上传，再调用 ops-from-upload",
            )
        } else {
            ApiError::invalid(rejection.body_text())
        }
    })?;
    let request: AppendOpsRequest = serde_json::from_slice(&body).map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_request",
            format!("请求体不合法：{error}"),
        )
    })?;
    if request.ops.len() > MAX_OPS_PER_BATCH {
        return Err(op_error(OpError::TooManyOps));
    }
    let draft = scoped_draft(&state, &grant, &scope, &draft_id).await?;
    if request.rev.is_some_and(|rev| rev != draft.rev) {
        return Err(ApiError::conflict(format!(
            "草稿已经是 rev {}，请重新读取后再追加",
            draft.rev
        )));
    }
    let ops = parse_op_values(&request.ops)?;
    let now = crate::now()?;
    let draft = append_ops(&state.repo, &grant, draft, ops, OpsSource::Inline, now)
        .await
        .map_err(apply_error)?;
    Ok(json_response(StatusCode::OK, &DraftView::from(&draft)))
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/drafts/{draft_id}/ops",
    operation_id = "append_draft_ops",
    tag = "drafts",
    description = "给实体区草稿追加一批高层操作（填充、空心盒、替换、复制区域、新增方块、放物件、新建/移动/修改锚点），每次最多 200 条、请求体最多 1MB、计算量最多 16M 格（填充、空心盒、替换按区域体积，复制区域按源体积的两倍；一个草稿累计最多 64M 格），超出返回 413，请拆批或改走上传（ops_from_upload）。操作只能写扩展层，并且只能改实体区；任何一条不合法或越界，整批都不生效。成功后草稿 rev 加一。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("draft_id" = String, Path, description = "草稿编号"),
    ),
    request_body = AppendOpsRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "追加后的草稿", body = DraftView),
        (status = 403, description = "只有只读权限，或操作超出了实体区", body = ProblemDocument),
        (status = 404, description = "草稿不存在或不属于实体区", body = ProblemDocument),
        (status = 409, description = "草稿已发布或 rev 不一致", body = ProblemDocument),
        (status = 413, description = "超过 200 条或 1MB", body = ProblemDocument),
        (status = 422, description = "操作不合法", body = ProblemDocument),
    )
)]
pub async fn append_draft_ops(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, draft_id)): Path<(String, String)>,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Result<Response, ApiError> {
    append(state, caller, space_id, None, draft_id, body).await
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/drafts/{draft_id}/ops",
    operation_id = "append_plot_draft_ops",
    tag = "drafts",
    description = "给地块草稿追加一批高层操作，每次最多 200 条、请求体最多 1MB（超出 413，请改走上传）。每个操作（填充盒、复制目标、物件包围盒、锚点的新旧位置）都必须落在这个地块内，否则 403 且整批不生效。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("plot_id" = String, Path, description = "地块编号"),
        ("draft_id" = String, Path, description = "草稿编号"),
    ),
    request_body = AppendOpsRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "追加后的草稿", body = DraftView),
        (status = 403, description = "只有只读权限，或操作超出了地块", body = ProblemDocument),
        (status = 404, description = "草稿不存在或不属于这个地块", body = ProblemDocument),
        (status = 409, description = "草稿已发布或 rev 不一致", body = ProblemDocument),
        (status = 413, description = "超过 200 条或 1MB", body = ProblemDocument),
        (status = 422, description = "操作不合法", body = ProblemDocument),
    )
)]
pub async fn append_plot_draft_ops(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, plot_id, draft_id)): Path<(String, String, String)>,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Result<Response, ApiError> {
    append(state, caller, space_id, Some(plot_id), draft_id, body).await
}

// ---------------------------------------------------------------------------
// 从上传应用操作（异步）
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpsFromUploadRequest {
    /// `ops` 用途的上传编号（已完成校验）。与 `assetHash` 二选一。
    pub upload_id: Option<String>,
    /// `ops` 用途的资源哈希（必须是本空间上传过的）。与 `uploadId` 二选一。
    pub asset_hash: Option<String>,
}

/// 已排队的任务。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OpsJobView {
    pub job_id: String,
    pub draft_id: String,
    /// `running`：进度和结果用 `GET /api/v1/spaces/{space_id}/jobs/{job_id}` 查询。
    pub status: String,
}

/// ops 上传的资源已经不在（被处理服务的定期清理删掉）。
fn ops_asset_gone() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "not_found",
        "这个 ops 上传的资源已经不存在（上传后 7 天内没被引用的资源会被清理），请重新上传",
    )
}

async fn from_upload(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    draft_id: String,
    body: Bytes,
) -> Result<Response, ApiError> {
    let scope = path_scope(plot_id)?;
    let grant = writable(&state, &caller, &space_id).await?;
    let request: OpsFromUploadRequest = parse_optional(&body)?;
    let (upload_id, asset_hash) = match (&request.upload_id, &request.asset_hash) {
        (Some(id), None) if !id.is_empty() && id.len() <= 128 => (Some(id.as_str()), None),
        (None, Some(hash)) if is_sha256_hex(hash) => (None, Some(hash.as_str())),
        _ => {
            return Err(ApiError::invalid(
                "请求体必须是 {uploadId} 或 {assetHash}（64 位小写十六进制）之一",
            ))
        }
    };
    let draft = scoped_draft(&state, &grant, &scope, &draft_id).await?;
    if draft.status != DraftStatus::Open {
        return Err(ApiError::conflict("草稿已经发布，不能再追加操作"));
    }
    let upload = state
        .repo
        .ops_upload(&grant, upload_id, asset_hash)
        .await?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "没有找到本空间已完成校验的 ops 上传",
            )
        })?;
    // 处理时整份读入，超过上限的文件（例如调小上限之前传的）在返回 202 之前就拒绝，
    // 不要等后台任务才失败。
    match state.repo.asset_length(&grant, &upload.asset_hash).await? {
        None => return Err(ops_asset_gone()),
        Some(length) if length > MAX_OPS_FILE_BYTES => {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "ops_file_too_large",
                format!(
                    "操作文件 {length} 字节，超过上限 {MAX_OPS_FILE_BYTES} 字节；请拆成几个文件分别上传和应用"
                ),
            ))
        }
        Some(_) => {}
    }
    if draft.ops_refs.len() >= MAX_DRAFT_OPS_REFS {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_many_ops_files",
            format!(
                "一个草稿最多引用 {MAX_DRAFT_OPS_REFS} 个操作文件，请合并成更大的文件或另建草稿"
            ),
        ));
    }
    // 和其他任务一样计入每空间的排队上限：每个任务都要把整份文件读进内存解析。
    let limit = state.ingest.config.max_pending_jobs_per_space;
    if state.repo.pending_jobs(&grant).await? >= limit {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_jobs",
            format!("这个空间排队和运行中的任务最多 {limit} 个，请稍后再试"),
        ));
    }
    // 清理的栅栏：任务参数和之后的草稿都会引用这个文件，插入任务之前先刷新 touchedAt 并确认
    // 还在；刷新不到说明它刚被清理删掉，和资源不存在一样 404，不建一个注定读不到文件的任务。
    if !state.repo.touch_asset(&grant, &upload.asset_hash).await? {
        return Err(ops_asset_gone());
    }
    let job_id = uuid::Uuid::new_v4().simple().to_string();
    let now = crate::now()?;
    let params = json!({
        "draftId": draft.id,
        "assetHash": upload.asset_hash,
        "uploadId": upload.upload_id,
    });
    state
        .repo
        .insert_ops_job(
            &grant,
            &job_id,
            &draft.scope,
            &params,
            &caller.subject,
            &caller.service_id,
            now,
            now.saturating_add_seconds(OPS_JOB_LEASE_SECONDS),
        )
        .await?;
    tracing::info!(space = %space_id, draft = %draft.id, job = %job_id, asset = %upload.asset_hash, "ops_from_upload 已开始");
    let background = state.clone();
    let owner = grant.owner().clone();
    let job = job_id.clone();
    let draft_id = draft.id.clone();
    let asset_hash = upload.asset_hash.clone();
    tokio::spawn(async move {
        run_ops_job(background, space_id, owner, job, draft_id, asset_hash).await;
    });
    let mut response = json_response(
        StatusCode::ACCEPTED,
        &OpsJobView {
            job_id,
            draft_id: draft.id,
            status: "running".to_owned(),
        },
    );
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("2"));
    Ok(response)
}

/// 接口服务进程内处理 ops_from_upload（处理服务不领取这个种类）。后台用途走显式系统范围。
async fn run_ops_job(
    state: AppState,
    space_id: String,
    owner: metaverse_core::model::Owner,
    job_id: String,
    draft_id: String,
    asset_hash: String,
) {
    let grant = match state
        .authorizer
        .system_space(&space_id, &owner, "ops_from_upload", &job_id)
        .await
    {
        Ok(grant) => grant,
        Err(error) => {
            tracing::warn!(space = %space_id, job = %job_id, error = ?error, "ops_from_upload 拿不到系统范围");
            return;
        }
    };
    let outcome = process_ops_job(&state, &grant, &job_id, &draft_id, &asset_hash).await;
    let now = crate::now().unwrap_or_else(|_| epoch());
    let finished = match &outcome {
        Ok(result) => {
            state
                .repo
                .finish_ops_job(&grant, &job_id, Ok(result), now)
                .await
        }
        Err(message) => {
            tracing::info!(space = %space_id, job = %job_id, error = %message, "ops_from_upload 失败");
            state
                .repo
                .finish_ops_job(&grant, &job_id, Err(message), now)
                .await
        }
    };
    if let Err(error) = finished {
        tracing::warn!(space = %space_id, job = %job_id, error = %error, "ops_from_upload 结果没有写成");
    }
}

/// 进程里同时处理的 ops-from-upload 任务数。
const MAX_CONCURRENT_OPS_JOBS: usize = 1;

fn ops_job_slots() -> &'static tokio::sync::Semaphore {
    static SLOTS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    SLOTS.get_or_init(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_OPS_JOBS))
}

fn epoch() -> Timestamp {
    Timestamp::from_millis(0).expect("纪元时间在合法范围内")
}

async fn process_ops_job(
    state: &AppState,
    grant: &Grant,
    job_id: &str,
    draft_id: &str,
    asset_hash: &str,
) -> Result<Value, String> {
    use crate::repo::OpsAsset;
    // 进程里同时只处理 [`MAX_CONCURRENT_OPS_JOBS`] 个：每个都要把文件读进内存、解析、计算。
    // 等名额的任务只占一个空闲的异步任务，不占内存。
    let _slot = ops_job_slots()
        .acquire()
        .await
        .map_err(|_| "处理名额不可用".to_owned())?;
    let bytes = match state
        .repo
        .read_ops_asset(grant, asset_hash, MAX_OPS_FILE_BYTES)
        .await
        .map_err(|error| error.to_string())?
    {
        OpsAsset::Bytes(bytes) => bytes,
        OpsAsset::Missing => return Err("操作文件不存在".to_owned()),
        OpsAsset::TooLarge(length) => {
            return Err(format!(
                "操作文件 {length} 字节，超过上限 {MAX_OPS_FILE_BYTES} 字节"
            ))
        }
    };
    let ops = parse_ops_file_blocking(bytes, MAX_DRAFT_OPS).await?;
    let total = ops.len();
    let _ = state
        .repo
        .ops_job_progress(grant, job_id, 0, total as u64)
        .await;
    let draft = state
        .repo
        .draft(grant, draft_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "草稿不存在".to_owned())?;
    let now = crate::now().map_err(|error| error.detail.to_string())?;
    let draft = append_ops(
        &state.repo,
        grant,
        draft,
        ops,
        OpsSource::Upload(asset_hash.to_owned()),
        now,
    )
    .await
    .map_err(|error| match error {
        ApplyError::Op(error) => error.to_string(),
        ApplyError::Api(error) => error.detail.to_string(),
    })?;
    let _ = state
        .repo
        .ops_job_progress(grant, job_id, total as u64, total as u64)
        .await;
    Ok(ops_job_result(&draft, total))
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/drafts/{draft_id}/ops-from-upload",
    operation_id = "draft_ops_from_upload",
    tag = "drafts",
    description = "大批量操作（异步）：把已上传的 ops 文件（NDJSON，每行一个操作，可 gzip 压缩，文件 ≤ 64MiB、解压后 ≤ 256MiB、每行 ≤ 64KiB，最多 10 万条）应用到实体区草稿。一个草稿最多引用 20 个操作文件，计入每空间排队任务上限（429），方块操作累计计算量有上限（413）。请求体 {uploadId} 或 {assetHash}。返回 202 和任务编号，进度和结果用 get_job 查询；任何一条不合法或越界，整份都不生效（任务失败并给出原因）。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("draft_id" = String, Path, description = "草稿编号"),
    ),
    request_body = OpsFromUploadRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 202, description = "已开始处理", body = OpsJobView),
        (status = 403, description = "只有只读权限", body = ProblemDocument),
        (status = 404, description = "草稿或上传不存在，或上传的资源已被清理", body = ProblemDocument),
        (status = 409, description = "草稿已发布", body = ProblemDocument),
        (status = 413, description = "操作文件超过 64MiB", body = ProblemDocument),
        (status = 422, description = "请求体不合法", body = ProblemDocument),
    )
)]
pub async fn draft_ops_from_upload(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, draft_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    from_upload(state, caller, space_id, None, draft_id, body).await
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/drafts/{draft_id}/ops-from-upload",
    operation_id = "plot_draft_ops_from_upload",
    tag = "drafts",
    description = "大批量操作（异步）：把已上传的 ops 文件应用到地块草稿，每个操作都必须落在地块内。请求体 {uploadId} 或 {assetHash}。返回 202 和任务编号，用 get_job 查询进度。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("plot_id" = String, Path, description = "地块编号"),
        ("draft_id" = String, Path, description = "草稿编号"),
    ),
    request_body = OpsFromUploadRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 202, description = "已开始处理", body = OpsJobView),
        (status = 403, description = "只有只读权限", body = ProblemDocument),
        (status = 404, description = "草稿或上传不存在，或上传的资源已被清理", body = ProblemDocument),
        (status = 409, description = "草稿已发布", body = ProblemDocument),
        (status = 413, description = "操作文件超过 64MiB", body = ProblemDocument),
        (status = 422, description = "请求体不合法", body = ProblemDocument),
    )
)]
pub async fn plot_draft_ops_from_upload(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, plot_id, draft_id)): Path<(String, String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    from_upload(state, caller, space_id, Some(plot_id), draft_id, body).await
}

// ---------------------------------------------------------------------------
// 预览
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewRequest {
    /// 有效期（秒），默认 86400，最长 604800。
    pub ttl_seconds: Option<i64>,
}

/// 预览链接。令牌原文只返回这一次，库里只存哈希。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewView {
    /// 预览令牌（256 位随机数）。网页凭 `Authorization: Preview <令牌>` 读取预览。
    pub token: String,
    /// 预览页面地址，令牌在 `#` 后面，不会进入服务器日志。
    pub url: String,
    /// 绑定的草稿版本；之后再追加操作，这个令牌就失效。
    pub rev: u64,
    #[schema(value_type = String)]
    pub expires_at: Timestamp,
}

async fn preview(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    draft_id: String,
    body: Bytes,
) -> Result<Response, ApiError> {
    let scope = path_scope(plot_id)?;
    let grant = writable(&state, &caller, &space_id).await?;
    let request: PreviewRequest = parse_optional(&body)?;
    let ttl = request.ttl_seconds.unwrap_or(PREVIEW_TTL_DEFAULT);
    if !(60..=PREVIEW_TTL_MAX).contains(&ttl) {
        return Err(ApiError::invalid("ttlSeconds 必须在 60 到 604800 之间"));
    }
    let draft = scoped_draft(&state, &grant, &scope, &draft_id).await?;
    if draft.status != DraftStatus::Open {
        return Err(ApiError::conflict("草稿已经发布"));
    }
    let mut secret = [0u8; 32];
    SystemRandom::new()
        .fill(&mut secret)
        .map_err(|_| ApiError::internal())?;
    let token = URL_SAFE_NO_PAD.encode(secret);
    let now = crate::now()?;
    let expires_at = now.saturating_add_seconds(ttl).min(draft.expires_at);
    state
        .repo
        .insert_preview(
            &grant,
            &NewPreview {
                token_hash: &sha256_hex(token.as_bytes()),
                draft_id: &draft.id,
                rev: draft.rev,
                created_by: &caller.subject,
                now,
                expires_at,
            },
        )
        .await?;
    let url = format!("{}/preview#t={token}", state.public.config().site_base_url);
    Ok(json_response(
        StatusCode::CREATED,
        &PreviewView {
            token,
            url,
            rev: draft.rev,
            expires_at,
        },
    ))
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/drafts/{draft_id}/preview",
    operation_id = "create_draft_preview",
    tag = "drafts",
    description = "为实体区草稿生成预览链接，给人在网页上确认效果（预览和公开页面一样只显示公开锚点）。令牌默认 24 小时有效、最长 7 天，绑定当前的草稿版本 rev；草稿再追加操作、发布或丢弃后令牌失效。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("draft_id" = String, Path, description = "草稿编号"),
    ),
    request_body(content = Option<PreviewRequest>, description = "可省略"),
    security(("nyxid_identity" = [])),
    responses(
        (status = 201, description = "预览链接", body = PreviewView),
        (status = 403, description = "只有只读权限", body = ProblemDocument),
        (status = 404, description = "草稿不存在或不属于实体区", body = ProblemDocument),
        (status = 409, description = "草稿已发布", body = ProblemDocument),
    )
)]
pub async fn create_draft_preview(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, draft_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    preview(state, caller, space_id, None, draft_id, body).await
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/drafts/{draft_id}/preview",
    operation_id = "create_plot_draft_preview",
    tag = "drafts",
    description = "为地块草稿生成预览链接（默认 24 小时，最长 7 天，绑定当前 rev）。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("plot_id" = String, Path, description = "地块编号"),
        ("draft_id" = String, Path, description = "草稿编号"),
    ),
    request_body(content = Option<PreviewRequest>, description = "可省略"),
    security(("nyxid_identity" = [])),
    responses(
        (status = 201, description = "预览链接", body = PreviewView),
        (status = 403, description = "只有只读权限", body = ProblemDocument),
        (status = 404, description = "草稿不存在或不属于这个地块", body = ProblemDocument),
        (status = 409, description = "草稿已发布", body = ProblemDocument),
    )
)]
pub async fn create_plot_draft_preview(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, plot_id, draft_id)): Path<(String, String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    preview(state, caller, space_id, Some(plot_id), draft_id, body).await
}

// ---------------------------------------------------------------------------
// 发布
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishRequest {
    /// 提交说明（≤ 2000 字）。
    pub message: Option<String>,
    /// 与时间线上的新变化冲突时，在最新版本上重放草稿的全部操作，而不是返回 409。
    #[serde(default)]
    pub replay: bool,
    /// 调用方看到的草稿版本；给了就必须一致。
    pub rev: Option<u64>,
    /// 现实中发生的时间（只用于显示），RFC 3339。
    #[schema(value_type = Option<String>)]
    pub observed_at: Option<Timestamp>,
    /// 生成这些操作的建造脚本（只为追溯）：本空间 script 用途上传的资源哈希，否则 422
    /// `unknown_asset`。
    pub script_ref: Option<String>,
}

/// 发布结果。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublishView {
    pub commit_id: String,
    pub seq: u64,
    #[schema(value_type = String)]
    pub at: Timestamp,
    pub draft_id: String,
}

async fn publish_draft_inner(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    draft_id: String,
    body: Bytes,
) -> Result<Response, ApiError> {
    let scope = path_scope(plot_id)?;
    let grant = writable(&state, &caller, &space_id).await?;
    let request: PublishRequest = parse_optional(&body)?;
    let message = request.message.unwrap_or_else(|| "发布草稿".to_owned());
    check_text("message", &message, 2000, false)?;
    if request
        .script_ref
        .as_deref()
        .is_some_and(|hash| !is_sha256_hex(hash))
    {
        return Err(ApiError::invalid(
            "scriptRef 必须是 64 位小写十六进制的资源哈希",
        ));
    }
    let draft = scoped_draft(&state, &grant, &scope, &draft_id).await?;
    let options = PublishOptions {
        message,
        replay: request.replay,
        expected_rev: request.rev,
        observed_at: request.observed_at,
        script_ref: request.script_ref,
    };
    let now = crate::now()?;
    match publish(&state.repo, &grant, &caller, &draft, &options, now).await {
        Ok(outcome) => {
            state.public.cache.invalidate_space(&space_id);
            tracing::info!(space = %space_id, draft = %draft.id, seq = outcome.seq, by = %caller.subject, "草稿已发布");
            Ok(json_response(
                StatusCode::OK,
                &PublishView {
                    commit_id: outcome.commit_id,
                    seq: outcome.seq,
                    at: outcome.at,
                    draft_id: draft.id,
                },
            ))
        }
        Err(PublishError::Api(error)) => Err(error),
        Err(PublishError::Conflicts { keys, head_seq }) => Ok(problem_with(
            StatusCode::CONFLICT,
            "draft_conflict",
            format!(
                "时间线已从 seq {} 前进到 {head_seq}，其中的变化与草稿碰过的 {} 个键冲突；可以带 replay: true 在最新版本上重放，或重新拉取后再建草稿",
                draft.base_seq,
                keys.len()
            ),
            json!({"conflicts": keys, "baseSeq": draft.base_seq, "headSeq": head_seq}),
        )),
        Err(PublishError::OutOfScope(error)) => Ok(problem_with(
            StatusCode::CONFLICT,
            "out_of_scope",
            format!("按最新的区域和地块，{error}"),
            json!({}),
        )),
        Err(PublishError::ReplayFailed(error)) => Ok(problem_with(
            StatusCode::CONFLICT,
            "replay_failed",
            format!("在最新版本上重放失败：{error}"),
            json!({}),
        )),
        Err(PublishError::AssetsGone(gone)) => {
            tracing::info!(space = %space_id, draft = %draft.id, assets = ?gone, "发布时引用的资源已被清理，没有发布");
            Ok(problem_with(
                StatusCode::CONFLICT,
                "asset_gone",
                format!(
                    "草稿引用的 {} 个资源已经被清理（上传后 7 天内没被引用的资源会被删除），没有发布；请重新上传 assets 里列出的资源（内容相同，哈希也相同）后再发布",
                    gone.len()
                ),
                json!({"assets": gone}),
            ))
        }
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/drafts/{draft_id}/publish",
    operation_id = "publish_draft",
    tag = "drafts",
    description = "发布实体区草稿，写成时间线上的一次提交（时间由服务端赋值）。时间线已经前进时，和期间各提交的变化求交集：没有交集就直接叠加发布；有交集返回 409 并列出冲突的键，可带 replay: true 在最新版本上重放。发布时按最新的区域重新校验全部操作。提交的 actor 记发布者，author 记草稿创建者。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("draft_id" = String, Path, description = "草稿编号"),
    ),
    request_body(content = Option<PublishRequest>, description = "可省略"),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "已发布", body = PublishView),
        (status = 403, description = "只有只读权限", body = ProblemDocument),
        (status = 404, description = "草稿不存在或不属于实体区", body = ProblemDocument),
        (status = 409, description = "冲突（conflicts 列出冲突的键）、越界、已发布或 rev 不一致；asset_gone：引用的资源已被清理（assets 列出哈希，重新上传后再发布）", body = ProblemDocument),
        (status = 422, description = "scriptRef 不是本空间的脚本资源", body = ProblemDocument),
    )
)]
pub async fn publish_draft(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, draft_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    publish_draft_inner(state, caller, space_id, None, draft_id, body).await
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/drafts/{draft_id}/publish",
    operation_id = "publish_plot_draft",
    tag = "drafts",
    description = "发布地块草稿，写成一次提交。冲突规则同 publish_draft；发布时按最新的地块范围重新校验全部操作。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("plot_id" = String, Path, description = "地块编号"),
        ("draft_id" = String, Path, description = "草稿编号"),
    ),
    request_body(content = Option<PublishRequest>, description = "可省略"),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "已发布", body = PublishView),
        (status = 403, description = "只有只读权限", body = ProblemDocument),
        (status = 404, description = "草稿不存在或不属于这个地块", body = ProblemDocument),
        (status = 409, description = "冲突、越界、已发布或 rev 不一致；asset_gone：引用的资源已被清理", body = ProblemDocument),
        (status = 422, description = "scriptRef 不是本空间的脚本资源", body = ProblemDocument),
    )
)]
pub async fn publish_plot_draft(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, plot_id, draft_id)): Path<(String, String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    publish_draft_inner(state, caller, space_id, Some(plot_id), draft_id, body).await
}

// ---------------------------------------------------------------------------
// 丢弃
// ---------------------------------------------------------------------------

async fn discard(
    state: AppState,
    caller: Caller,
    space_id: String,
    plot_id: Option<String>,
    draft_id: String,
) -> Result<Response, ApiError> {
    let scope = path_scope(plot_id)?;
    let grant = writable(&state, &caller, &space_id).await?;
    let draft = scoped_draft(&state, &grant, &scope, &draft_id).await?;
    if !state.repo.delete_draft(&grant, &draft.id).await? {
        return Err(ApiError::not_found());
    }
    tracing::info!(space = %space_id, draft = %draft.id, by = %caller.subject, "草稿已丢弃");
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[utoipa::path(
    delete,
    path = "/api/v1/spaces/{space_id}/drafts/{draft_id}",
    operation_id = "discard_draft",
    tag = "drafts",
    description = "丢弃实体区草稿：草稿、草稿区块和预览令牌一起删除，预览链接立即失效。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("draft_id" = String, Path, description = "草稿编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 204, description = "已丢弃"),
        (status = 403, description = "只有只读权限", body = ProblemDocument),
        (status = 404, description = "草稿不存在或不属于实体区", body = ProblemDocument),
    )
)]
pub async fn discard_draft(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, draft_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    discard(state, caller, space_id, None, draft_id).await
}

#[utoipa::path(
    delete,
    path = "/api/v1/spaces/{space_id}/plots/{plot_id}/drafts/{draft_id}",
    operation_id = "discard_plot_draft",
    tag = "drafts",
    description = "丢弃地块草稿：草稿、草稿区块和预览令牌一起删除。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("plot_id" = String, Path, description = "地块编号"),
        ("draft_id" = String, Path, description = "草稿编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 204, description = "已丢弃"),
        (status = 403, description = "只有只读权限", body = ProblemDocument),
        (status = 404, description = "草稿不存在或不属于这个地块", body = ProblemDocument),
    )
)]
pub async fn discard_plot_draft(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, plot_id, draft_id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    discard(state, caller, space_id, Some(plot_id), draft_id).await
}

/// 草稿接口的路由（`/api/v1` 下，由调用方套身份中间件）。
pub fn routes() -> Router<AppState> {
    let small = DefaultBodyLimit::max(SMALL_BODY_LIMIT);
    let ops = DefaultBodyLimit::max(OPS_BODY_LIMIT);
    Router::new()
        .route(
            "/api/v1/spaces/{space_id}/drafts",
            post(create_draft).layer(small),
        )
        .route(
            "/api/v1/spaces/{space_id}/plots/{plot_id}/drafts",
            post(create_plot_draft).layer(small),
        )
        .route(
            "/api/v1/spaces/{space_id}/drafts/{draft_id}",
            get(get_draft).delete(discard_draft),
        )
        .route(
            "/api/v1/spaces/{space_id}/plots/{plot_id}/drafts/{draft_id}",
            get(get_plot_draft).delete(discard_plot_draft),
        )
        .route(
            "/api/v1/spaces/{space_id}/drafts/{draft_id}/ops",
            post(append_draft_ops).layer(ops),
        )
        .route(
            "/api/v1/spaces/{space_id}/plots/{plot_id}/drafts/{draft_id}/ops",
            post(append_plot_draft_ops).layer(ops),
        )
        .route(
            "/api/v1/spaces/{space_id}/drafts/{draft_id}/ops-from-upload",
            post(draft_ops_from_upload).layer(small),
        )
        .route(
            "/api/v1/spaces/{space_id}/plots/{plot_id}/drafts/{draft_id}/ops-from-upload",
            post(plot_draft_ops_from_upload).layer(small),
        )
        .route(
            "/api/v1/spaces/{space_id}/drafts/{draft_id}/preview",
            post(create_draft_preview).layer(small),
        )
        .route(
            "/api/v1/spaces/{space_id}/plots/{plot_id}/drafts/{draft_id}/preview",
            post(create_plot_draft_preview).layer(small),
        )
        .route(
            "/api/v1/spaces/{space_id}/drafts/{draft_id}/publish",
            post(publish_draft).layer(small),
        )
        .route(
            "/api/v1/spaces/{space_id}/plots/{plot_id}/drafts/{draft_id}/publish",
            post(publish_plot_draft).layer(small),
        )
}
