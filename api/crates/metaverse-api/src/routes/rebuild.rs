//! 重建路径（docs/design/server-slim.md 2.3）：`/api/v1/spaces/{space_id}/rebuild/` 下的上传、重建草稿、
//! 任务查询，路径范围记作 `rebuild`。NyxID 的操作范围能按这条路径单独授权、钉死 `space_id`；实体区和
//! 地块路径的 key 动不了重建层，也上传不了扫描。
//!
//! ```text
//! POST   .../rebuild/uploads/{purpose}                          create_rebuild_upload
//! PUT    .../rebuild/uploads/{purpose}/{upload_id}/parts/{n}    upload_rebuild_part
//! POST   .../rebuild/uploads/{purpose}/{upload_id}/complete     complete_rebuild_upload
//! GET    .../rebuild/uploads/{purpose}/{upload_id}              get_rebuild_upload
//! POST   .../rebuild/drafts                                     create_rebuild_draft
//! GET    .../rebuild/drafts/{draft_id}                          get_rebuild_draft
//! POST   .../rebuild/drafts/{draft_id}/bundle                   apply_rebuild_bundle
//! POST   .../rebuild/drafts/{draft_id}/moves                    move_rebuild_entities
//! POST   .../rebuild/drafts/{draft_id}/preview                  create_rebuild_draft_preview
//! POST   .../rebuild/drafts/{draft_id}/publish                  publish_rebuild_draft
//! DELETE .../rebuild/drafts/{draft_id}                          discard_rebuild_draft
//! GET    .../rebuild/jobs、.../rebuild/jobs/{job_id}            list_rebuild_jobs、get_rebuild_job
//! ```
//!
//! - **权限**：写操作要求本空间管理权，空间主人和组织管理员无需额外平台角色；
//!   普通成员只读，跨空间访问拒绝；Agent Key 操作范围由 NyxID 独立执行；
//! - **重建草稿只收一个包**：可交重建包或由 moves 在服务端生成 merge 包，不收任意内联操作或操作文件；
//!   交第二个包 409 `bundle_already_applied`；
//!   交过包以后只能预览、发布、丢弃；
//! - **草稿属于创建时的范围**：重建草稿只能经这条路径操作，实体区、地块草稿也不能经这条路径操作（404）；
//! - **上传的用途**：`scan`、`webmodel`、`model`、`texture`、`script`、`bundle`；交包时按 `uploadId` 只认
//!   本空间重建路径、用途 `bundle`、核对通过的上传，按 `assetHash` 时清单必须属于本空间、核对通过。

use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
    routing::{get, post, put},
    Router,
};
use metaverse_core::ids::is_object_id;
use metaverse_core::is_sha256_hex;
use metaverse_core::model::{Job, JobKind, JobStatus, RequestActor};
use metaverse_core::scope::PathScope;
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::ToSchema;

use super::drafts::{
    self as drafts, json_response, parse_optional, scoped_draft, writable, CreateDraftRequest,
    DraftView, PreviewRequest, PreviewView, PublishRequest, PublishView, SMALL_BODY_LIMIT,
};
use super::jobs::{self as jobs, JobList, JobListQuery, JobView};
use super::uploads::{
    self as uploads, CompleteUploadResponse, CreateUploadRequest, PartReceipt, UploadPath,
    UploadView, PART_BODY_LIMIT,
};
use super::ApiJson;
use crate::auth::Caller;
use crate::error::{ApiError, ProblemDocument};
use crate::ingest::new_id;
use crate::repo::{AssetRole, DraftStatus, UnusableAsset};
use crate::AppState;

pub mod moves;
use moves::move_rebuild_entities;

fn rebuild() -> Result<PathScope, ApiError> {
    Ok(PathScope::Rebuild)
}

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/rebuild/uploads/{purpose}",
    operation_id = "create_rebuild_upload",
    tag = "rebuild",
    description = "创建重建路径的分片上传（要求本空间管理权）。用途：scan（原始扫描：glb、drc、obj，或 Scaniverse 导出的 zip）、webmodel（网页用模型 glb）、model（物件模型 glb）、texture（png、jpeg、webp）、script（建模记录等 UTF-8 文本）、bundle（重建包清单 JSON）。声明总大小、整体 SHA-256、分片大小（256KiB 的整数倍，≤32MiB）和格式；本空间已经拥有这份内容、核对结果合乎用途时直接复用（status=done、reused=true、带 check），否则返回上传编号，之后按片号 PUT 原始字节，最后调用 complete_rebuild_upload。各用途的上限见 get_space 的 uploadLimits。",
    params(
        ("space_id" = String, Path, description = "空间编号", example = "sample-space"),
        ("purpose" = String, Path, description = "用途：scan | webmodel | model | texture | script | bundle", example = "bundle"),
    ),
    request_body = CreateUploadRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 201, description = "已创建，开始上传分片（或已直接复用）", body = UploadView),
        (status = 403, description = "没有本空间管理权，或这个用途不能经重建路径上传", body = ProblemDocument),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
        (status = 413, description = "超过大小上限或空间存储上限", body = ProblemDocument),
        (status = 422, description = "参数不合法（哈希、分片大小、格式）", body = ProblemDocument),
        (status = 429, description = "进行中的上传太多", body = ProblemDocument),
    )
)]
pub async fn create_rebuild_upload(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, purpose)): Path<(String, String)>,
    ApiJson(request): ApiJson<CreateUploadRequest>,
) -> Result<Response, ApiError> {
    uploads::create(
        state,
        caller,
        space_id,
        UploadPath::Rebuild,
        purpose,
        request,
    )
    .await
}

#[utoipa::path(
    put,
    path = "/api/v1/spaces/{space_id}/rebuild/uploads/{purpose}/{upload_id}/parts/{n}",
    operation_id = "upload_rebuild_part",
    tag = "rebuild",
    description = "上传一片（重建路径，要求本空间管理权）。请求体是原始字节，片号 n 从 0 开始；除最后一片外每片都必须正好是分片大小。同一片可以重传。规则同 put_upload_part。",
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
        (status = 403, description = "没有本空间管理权", body = ProblemDocument),
        (status = 404, description = "上传不存在（或不是经重建路径创建的）", body = ProblemDocument),
        (status = 409, description = "上传已不接收分片", body = ProblemDocument),
        (status = 413, description = "超过声明的大小", body = ProblemDocument),
        (status = 422, description = "片号或长度不对、文件头与格式不符", body = ProblemDocument),
        (status = 503, description = "正在处理的分片太多", body = ProblemDocument),
    )
)]
pub async fn upload_rebuild_part(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, purpose, upload_id, n)): Path<(String, String, String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    uploads::put_part(
        state,
        caller,
        space_id,
        UploadPath::Rebuild,
        purpose,
        upload_id,
        n,
        headers,
        body,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/rebuild/uploads/{purpose}/{upload_id}/complete",
    operation_id = "complete_rebuild_upload",
    tag = "rebuild",
    description = "完成上传（重建路径，要求本空间管理权）。全部分片到齐后返回 202 和 upload_verify 任务编号；接口服务的后台执行器流式核对整体哈希和文件内容（glb 实测包围盒、图片尺寸、zip 目录、清单的外层结构），通过后登记成资源并把上传标记为 done，用 get_rebuild_job 或 get_rebuild_upload 等结果。重复调用返回同一个任务；还有缺片时 409。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("purpose" = String, Path, description = "用途"),
        ("upload_id" = String, Path, description = "上传编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 202, description = "已开始核对", body = CompleteUploadResponse),
        (status = 200, description = "已经核对通过（或复用）", body = CompleteUploadResponse),
        (status = 403, description = "没有本空间管理权", body = ProblemDocument),
        (status = 404, description = "上传不存在", body = ProblemDocument),
        (status = 409, description = "还缺分片，或上传已失败、过期", body = ProblemDocument),
        (status = 429, description = "排队中的任务太多", body = ProblemDocument),
    )
)]
pub async fn complete_rebuild_upload(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, purpose, upload_id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    uploads::complete(
        state,
        caller,
        space_id,
        UploadPath::Rebuild,
        purpose,
        upload_id,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/rebuild/uploads/{purpose}/{upload_id}",
    operation_id = "get_rebuild_upload",
    tag = "rebuild",
    description = "查询重建路径上传的状态：已收到哪些分片、还缺哪些、核对任务、资源哈希 assetHash 和服务端的核对记录 check。按访问级别读，不要求本空间管理权。",
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
pub async fn get_rebuild_upload(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, purpose, upload_id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    uploads::show(
        state,
        caller,
        space_id,
        UploadPath::Rebuild,
        purpose,
        upload_id,
    )
    .await
}

// ---------------------------------------------------------------------------
// 重建草稿
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/rebuild/drafts",
    operation_id = "create_rebuild_draft",
    tag = "rebuild",
    description = "建一个重建草稿（要求本空间管理权）。重建草稿只收一个重建包：之后用 apply_rebuild_bundle 交包、create_rebuild_draft_preview 生成预览链接、publish_rebuild_draft 发布。可选 baseSeq 指定基于哪个版本（命令行取清单的 base.seq，默认最新）；发布时与 (baseSeq, 最新] 里改过重建层的提交冲突。30 天后过期。",
    params(("space_id" = String, Path, description = "空间编号", example = "sample-space")),
    request_body(content = Option<CreateDraftRequest>, description = "可省略"),
    security(("nyxid_identity" = [])),
    responses(
        (status = 201, description = "新的重建草稿", body = DraftView),
        (status = 403, description = "没有本空间管理权", body = ProblemDocument),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
        (status = 422, description = "baseSeq 不合法", body = ProblemDocument),
    )
)]
pub async fn create_rebuild_draft(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
    body: Bytes,
) -> Result<Response, ApiError> {
    drafts::create(state, caller, space_id, rebuild(), body).await
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/rebuild/drafts/{draft_id}",
    operation_id = "get_rebuild_draft",
    tag = "rebuild",
    description = "读取重建草稿：基于的版本、rev、交的包（bundleRef）、扫描（scan）、碰过的物件和锚点、可预览的资源（assets）和只为防清理而持有的资源（heldAssets）、是否已发布（unchanged 表示内容没变、没写提交）。按访问级别读。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("draft_id" = String, Path, description = "草稿编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "草稿", body = DraftView),
        (status = 404, description = "草稿不存在、不是重建草稿，或无权查看", body = ProblemDocument),
    )
)]
pub async fn get_rebuild_draft(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, draft_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    drafts::read(state, caller, space_id, rebuild(), draft_id).await
}

/// 交包的请求体：二选一。
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyBundleRequest {
    /// 本空间经重建路径上传、用途 `bundle`、核对通过的上传编号。与 `assetHash` 二选一。
    pub upload_id: Option<String>,
    /// 本空间核对通过的重建包清单的资源哈希。与 `uploadId` 二选一。
    pub asset_hash: Option<String>,
}

/// 已排队的展开任务。
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BundleJobView {
    pub job_id: String,
    pub draft_id: String,
    /// 清单的资源哈希。
    pub manifest_hash: String,
    /// `queued`：由后台执行器展开，结果用 get_rebuild_job 查询。
    pub status: String,
}

fn bundle_already_applied() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "bundle_already_applied",
        "这个重建草稿已经交过一个重建包（或正在展开）；要换包请丢弃草稿，另建一个",
    )
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/rebuild/drafts/{draft_id}/bundle",
    operation_id = "apply_rebuild_bundle",
    tag = "rebuild",
    description = "给重建草稿交一个重建包（要求本空间管理权）。请求体 {uploadId}（本空间经重建路径上传、用途 bundle、核对通过的上传）或 {assetHash}（本空间核对通过的清单）。只插入展开任务并返回 202 {jobId, status: queued}；后台执行器读清单、按规则完整校验（文件都属于本空间、核对结果合乎用途、长度一致）、展开成操作（setScan、clearRebuilt、placeEntity、removeEntity 带 ifPresent、createAnchor 带 ifNew），作用到草稿上。结果用 get_rebuild_job 查询：{applied, entities: {placed, removed}, anchors: {created, skipped: [{id, reason: exists|existed}]}, anchorDrift: [{anchorId, entityIds}], files}。一个重建草稿只收一个包，第二个 409 bundle_already_applied。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("draft_id" = String, Path, description = "重建草稿编号"),
    ),
    request_body = ApplyBundleRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 202, description = "已排队展开", body = BundleJobView),
        (status = 403, description = "没有本空间管理权", body = ProblemDocument),
        (status = 404, description = "草稿不存在或不是重建草稿；清单上传不存在或资源已被清理", body = ProblemDocument),
        (status = 409, description = "草稿已发布，或已经交过包（bundle_already_applied）", body = ProblemDocument),
        (status = 413, description = "清单超过大小上限", body = ProblemDocument),
        (status = 422, description = "请求体不合法；assetHash 不是本空间核对通过的清单（unknown_asset）", body = ProblemDocument),
        (status = 429, description = "排队中的任务太多", body = ProblemDocument),
    )
)]
pub async fn apply_rebuild_bundle(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, draft_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    let scope = PathScope::Rebuild;
    let grant = writable(&state, &caller, &space_id, &scope).await?;
    let request: ApplyBundleRequest = parse_optional(&body)?;
    let draft = scoped_draft(&state, &grant, &scope, &draft_id).await?;
    if draft.status != DraftStatus::Open {
        return Err(ApiError::conflict("草稿已经发布，不能再交包"));
    }
    if draft.bundle_ref.is_some()
        || !draft.ops_refs.is_empty()
        || state.repo.draft_has_pending_job(&grant, &draft.id).await?
    {
        return Err(bundle_already_applied());
    }
    let limits = state.ingest.config.upload_limits();
    let manifest_hash = match (&request.upload_id, &request.asset_hash) {
        (Some(id), None) if is_object_id(id) => state
            .repo
            .bundle_upload(&grant, id)
            .await?
            .map(|upload| upload.asset_hash)
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "没有找到本空间经重建路径上传、用途 bundle、已核对通过的上传",
                )
            })?,
        (None, Some(hash)) if is_sha256_hex(hash) => {
            let unusable = state
                .repo
                .unusable_assets(&grant, &[(hash.clone(), AssetRole::Bundle)], &limits)
                .await?;
            if let Some(problem) = unusable.first() {
                return Err(ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "unknown_asset",
                    format!("assetHash {}", UnusableAsset::describe(problem)),
                ));
            }
            hash.clone()
        }
        _ => {
            return Err(ApiError::invalid(
                "请求体必须是 {uploadId} 或 {assetHash}（64 位小写十六进制）之一",
            ))
        }
    };
    // 展开时整份读入：超过上限的清单（例如调小上限之前传的）在返回 202 之前就拒绝。
    match state.repo.asset_length(&grant, &manifest_hash).await? {
        None => {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "清单资源已经不存在（上传后 7 天内没被引用的资源会被清理），请重新上传",
            ))
        }
        Some(length) if length > limits.bundle.max_bytes => {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "bundle_too_large",
                format!(
                    "清单 {length} 字节，超过上限 {} 字节",
                    limits.bundle.max_bytes
                ),
            ))
        }
        Some(_) => {}
    }
    queue_bundle(&state, &caller, &grant, draft, manifest_hash).await
}

async fn queue_bundle(
    state: &AppState,
    caller: &Caller,
    grant: &crate::auth::Grant,
    draft: crate::repo::DraftDoc,
    manifest_hash: String,
) -> Result<Response, ApiError> {
    let space_id = grant.space_id();
    let limit = state.ingest.config.max_pending_jobs_per_space;
    if state.repo.pending_jobs(grant).await? >= limit {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_jobs",
            format!("这个空间排队和运行中的任务最多 {limit} 个，请稍后再试"),
        ));
    }
    // 清理的栅栏：任务参数和之后的草稿都会引用清单，插入任务之前先刷新 touchedAt 并确认还在。
    if !state.repo.touch_asset(grant, &manifest_hash).await? {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "清单资源刚被清理，请重新上传",
        ));
    }
    let now = crate::now()?;
    let job = Job {
        id: new_id("job"),
        space_id: grant.space_id().to_owned(),
        owner: grant.owner().clone(),
        kind: JobKind::OpsFromUpload,
        params: json!({
            "draftId": draft.id,
            "source": "bundle",
            "manifestHash": manifest_hash,
        }),
        status: JobStatus::Queued,
        lease_owner: None,
        lease_until: None,
        attempt: 0,
        max_attempts: JobKind::OpsFromUpload.max_attempts(),
        last_error: None,
        not_before: None,
        history: Vec::new(),
        result_commit_id: None,
        created_at: now,
        actor: Some(RequestActor {
            sub: caller.subject.clone(),
            nyx_service_id: caller.service_id.clone(),
        }),
        scope: Some(PathScope::Rebuild),
        result: None,
        progress: None,
        started_at: None,
        finished_at: None,
    };
    state.repo.insert_job(grant, &job).await?;
    // 叫醒本进程的后台执行器（重任务名额），不等轮询。
    state.job_signal.notify();
    tracing::info!(space = %space_id, draft = %draft.id, job = %job.id, manifest = %manifest_hash, by = %caller.subject, "交包，展开任务已排队");
    let mut response = json_response(
        StatusCode::ACCEPTED,
        &BundleJobView {
            job_id: job.id.clone(),
            draft_id: draft.id,
            manifest_hash,
            status: "queued".to_owned(),
        },
    );
    let headers = response.headers_mut();
    headers.insert(header::RETRY_AFTER, HeaderValue::from_static("2"));
    if let Ok(value) = HeaderValue::from_str(&format!(
        "/api/v1/spaces/{space_id}/rebuild/jobs/{}",
        job.id
    )) {
        headers.insert(header::LOCATION, value);
    }
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/rebuild/drafts/{draft_id}/preview",
    operation_id = "create_rebuild_draft_preview",
    tag = "rebuild",
    description = "为重建草稿生成预览链接（要求本空间管理权），给人在网页上确认效果后再发布。预览只给可预览的资源（网页用模型、物件模型、贴图）；原始扫描、包清单、建模记录、操作文件拿预览令牌一律读不到。令牌默认 24 小时、最长 7 天，绑定当前 rev。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("draft_id" = String, Path, description = "重建草稿编号"),
    ),
    request_body(content = Option<PreviewRequest>, description = "可省略"),
    security(("nyxid_identity" = [])),
    responses(
        (status = 201, description = "预览链接", body = PreviewView),
        (status = 403, description = "没有本空间管理权", body = ProblemDocument),
        (status = 404, description = "草稿不存在或不是重建草稿", body = ProblemDocument),
        (status = 409, description = "草稿已发布", body = ProblemDocument),
    )
)]
pub async fn create_rebuild_draft_preview(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, draft_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    drafts::preview(state, caller, space_id, rebuild(), draft_id, body).await
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/rebuild/drafts/{draft_id}/publish",
    operation_id = "publish_rebuild_draft",
    tag = "rebuild",
    description = "发布重建草稿（要求本空间管理权；给本地重建 agent 的 key 默认不开放这一项，人看过预览链接后自己发布）。写成一次提交：发布者类别 rebuild，带包清单和扫描（与最新版本完全相同就不写），第一次带扫描的提交固定坐标系；message 默认取包的 note，scriptRef 默认取包的建模记录。冲突：中途有改过重建层的提交（layer:rebuilt）、带扫描的提交（scan）、改过本包新建的锚点（anchor:<编号>）时 409，可以带 replay: true 在最新版本上重放。内容与最新版本相比没有变化时不写提交，返回 200 {unchanged: true, seq}。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("draft_id" = String, Path, description = "重建草稿编号"),
    ),
    request_body(content = Option<PublishRequest>, description = "可省略"),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "已发布（或内容没变、unchanged）", body = PublishView),
        (status = 403, description = "没有本空间管理权", body = ProblemDocument),
        (status = 404, description = "草稿不存在或不是重建草稿", body = ProblemDocument),
        (status = 409, description = "冲突（conflicts 列出冲突的键）、越界、模板引用不完整（broken_template_ref）、已发布或 rev 不一致；asset_gone：引用的资源已被清理", body = ProblemDocument),
        (status = 422, description = "还没交包；scriptRef 不是本空间的文本资源", body = ProblemDocument),
    )
)]
pub async fn publish_rebuild_draft(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, draft_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    drafts::publish_draft_inner(state, caller, space_id, rebuild(), draft_id, body).await
}

#[utoipa::path(
    delete,
    path = "/api/v1/spaces/{space_id}/rebuild/drafts/{draft_id}",
    operation_id = "discard_rebuild_draft",
    tag = "rebuild",
    description = "丢弃重建草稿（要求本空间管理权）：草稿和预览令牌一起删除，预览链接立即失效。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("draft_id" = String, Path, description = "重建草稿编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 204, description = "已丢弃"),
        (status = 403, description = "没有本空间管理权", body = ProblemDocument),
        (status = 404, description = "草稿不存在或不是重建草稿", body = ProblemDocument),
    )
)]
pub async fn discard_rebuild_draft(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, draft_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    drafts::discard(state, caller, space_id, rebuild(), draft_id).await
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/rebuild/jobs",
    operation_id = "list_rebuild_jobs",
    tag = "rebuild",
    description = "最近的重建范围任务（上传核对、包展开、种子导入），按创建时间倒序，最多 100 条，可按状态过滤。按访问级别读。",
    params(("space_id" = String, Path, description = "空间编号"), JobListQuery),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "任务列表", body = JobList),
        (status = 404, description = "空间不存在或无权查看", body = ProblemDocument),
    )
)]
pub async fn list_rebuild_jobs(
    State(state): State<AppState>,
    caller: Caller,
    Path(space_id): Path<String>,
    Query(query): Query<JobListQuery>,
) -> Result<Response, ApiError> {
    jobs::list(state, caller, space_id, None, true, query).await
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/rebuild/jobs/{job_id}",
    operation_id = "get_rebuild_job",
    tag = "rebuild",
    description = "查询重建范围的任务：状态、重试次数、失败原因（errorClass：content 不重试，fetch、transient 按退避重试）、进度和结果（包展开的 {applied, entities, anchors, anchorDrift, files}）。只看得到重建范围发起的任务。",
    params(
        ("space_id" = String, Path, description = "空间编号"),
        ("job_id" = String, Path, description = "任务编号"),
    ),
    security(("nyxid_identity" = [])),
    responses(
        (status = 200, description = "任务", body = JobView),
        (status = 404, description = "任务不存在、不是重建范围的，或无权查看", body = ProblemDocument),
    )
)]
pub async fn get_rebuild_job(
    State(state): State<AppState>,
    caller: Caller,
    Path((space_id, job_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    jobs::show(state, caller, space_id, None, true, job_id).await
}

/// 重建路径的路由（`/api/v1` 下，由调用方套身份中间件）。
pub fn routes() -> Router<AppState> {
    let small = DefaultBodyLimit::max(SMALL_BODY_LIMIT);
    let base = "/api/v1/spaces/{space_id}/rebuild";
    Router::new()
        .route(
            &format!("{base}/uploads/{{purpose}}"),
            post(create_rebuild_upload),
        )
        .route(
            &format!("{base}/uploads/{{purpose}}/{{upload_id}}"),
            get(get_rebuild_upload),
        )
        .route(
            &format!("{base}/uploads/{{purpose}}/{{upload_id}}/parts/{{n}}"),
            put(upload_rebuild_part).layer(DefaultBodyLimit::max(PART_BODY_LIMIT)),
        )
        .route(
            &format!("{base}/uploads/{{purpose}}/{{upload_id}}/complete"),
            post(complete_rebuild_upload),
        )
        .route(
            &format!("{base}/drafts"),
            post(create_rebuild_draft).layer(small),
        )
        .route(
            &format!("{base}/drafts/{{draft_id}}"),
            get(get_rebuild_draft).delete(discard_rebuild_draft),
        )
        .route(
            &format!("{base}/drafts/{{draft_id}}/bundle"),
            post(apply_rebuild_bundle).layer(small),
        )
        .route(
            &format!("{base}/drafts/{{draft_id}}/moves"),
            post(move_rebuild_entities).layer(small),
        )
        .route(
            &format!("{base}/drafts/{{draft_id}}/preview"),
            post(create_rebuild_draft_preview).layer(small),
        )
        .route(
            &format!("{base}/drafts/{{draft_id}}/publish"),
            post(publish_rebuild_draft).layer(small),
        )
        .route(&format!("{base}/jobs"), get(list_rebuild_jobs))
        .route(&format!("{base}/jobs/{{job_id}}"), get(get_rebuild_job))
}
