//! `POST /api/v1/admin/spaces`：创建空间（设计 8.4）。
//!
//! 管理接口不写进注册给 NyxID 的 OpenAPI，但这不是安全边界：服务端照样按 9.2 要求
//! "管理"级别——个人空间由本人创建；组织空间要求调用者是组织本身，或经 NyxID 现场
//! 核验是该组织的 admin，并写入归属证据。

use axum::{
    extract::State,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use metaverse_core::ids::is_space_id;
use metaverse_core::model::{Head, Owner, OwnerKind, ShareTokenRecord, Space, Visibility};
use metaverse_core::record::AnchorBody;
use metaverse_core::{sha256_hex, Timestamp};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::views::SpaceView;
use super::ApiJson;
use crate::auth::{Caller, CreateGrant};
use crate::error::{ApiError, ProblemDocument};
use crate::repo::RepoError;
use crate::AppState;

/// 新空间默认的存储上限：10 GiB。
pub const DEFAULT_STORAGE_LIMIT_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 200;
const MAX_DESCRIPTION_CHARS: usize = 2000;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct OwnerInput {
    /// `person` 或 `org`。必须显式给出，不能从编号去猜。
    #[schema(value_type = String, example = "org")]
    pub kind: OwnerKind,
    /// NyxID 主体编号（规范编号，不认 slug）。
    pub id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSpaceRequest {
    /// 空间编号：3–64 个字符，小写字母、数字和 `-`。不当作秘密。
    #[schema(example = "front-hall")]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub owner: OwnerInput,
    /// 默认 `unlisted`（凭分享令牌查看）。
    #[serde(default)]
    #[schema(value_type = Option<String>, example = "unlisted")]
    pub visibility: Visibility,
}

/// 分享令牌原文只在创建时返回这一次，库里只存哈希。
#[derive(Debug, Serialize, ToSchema)]
pub struct ShareTokenView {
    pub id: String,
    pub token: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateSpaceResponse {
    pub space: SpaceView,
    pub share_token: ShareTokenView,
}

pub(crate) fn check_text(
    name: &'static str,
    value: &str,
    max: usize,
    allow_empty: bool,
) -> Result<(), ApiError> {
    let count = value.chars().count();
    if (!allow_empty && value.trim().is_empty())
        || count > max
        || value.chars().any(|c| c.is_control() && c != '\n')
    {
        return Err(ApiError::invalid(format!("{name} 为空、太长或含控制字符")));
    }
    Ok(())
}

/// 生成分享令牌：256 位随机数（设计要求至少 128 位），base64url。
pub(crate) fn new_share_token() -> Result<(String, String), ApiError> {
    let random = SystemRandom::new();
    let mut secret = [0u8; 32];
    let mut id = [0u8; 9];
    random.fill(&mut secret).map_err(|_| ApiError::internal())?;
    random.fill(&mut id).map_err(|_| ApiError::internal())?;
    Ok((
        format!("st_{}", URL_SAFE_NO_PAD.encode(id)),
        URL_SAFE_NO_PAD.encode(secret),
    ))
}

#[utoipa::path(
    post,
    path = "/api/v1/admin/spaces",
    operation_id = "admin_create_space",
    tag = "admin",
    request_body = CreateSpaceRequest,
    security(("nyxid_identity" = [])),
    responses(
        (status = 201, description = "已创建；分享令牌原文只返回这一次", body = CreateSpaceResponse),
        (status = 401, description = "身份令牌无效", body = ProblemDocument),
        (status = 403, description = "不能以这个主人创建空间", body = ProblemDocument),
        (status = 409, description = "空间编号已存在", body = ProblemDocument),
        (status = 422, description = "请求内容不合法", body = ProblemDocument),
        (status = 503, description = "查不到组织角色或数据库不可用", body = ProblemDocument),
    )
)]
pub async fn create_space(
    State(state): State<AppState>,
    caller: Caller,
    ApiJson(request): ApiJson<CreateSpaceRequest>,
) -> Result<Response, ApiError> {
    let new = NewSpace {
        id: request.id,
        name: request.name,
        description: request.description,
        visibility: request.visibility,
    };
    new.validate()?;
    let owner = Owner {
        kind: request.owner.kind,
        id: request.owner.id,
    };
    let now = crate::now()?;
    let grant = state.authorizer.create_space(&caller, &owner, now).await?;
    let (token_id, token) = new_share_token()?;
    let share_tokens = vec![ShareTokenRecord {
        id: token_id.clone(),
        hash: sha256_hex(token.as_bytes()),
        created_at: now,
        revoked_at: None,
    }];
    let (space, anchors) = match create_space_with(
        &state,
        &grant,
        new,
        share_tokens,
        (&caller.subject, &caller.service_id),
        now,
    )
    .await?
    {
        SpaceCreation::Created { space, anchors } => (*space, anchors),
        SpaceCreation::Duplicate => return Err(ApiError::conflict("空间编号已存在")),
    };
    let location = format!("/api/v1/spaces/{}", space.id);
    let body = CreateSpaceResponse {
        space: SpaceView::new(space, anchors),
        share_token: ShareTokenView {
            id: token_id,
            token,
        },
    };
    let mut response = (StatusCode::CREATED, Json(body)).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(value) = HeaderValue::from_str(&location) {
        headers.insert(header::LOCATION, value);
    }
    Ok(response)
}

/// 新空间的内容。管理接口和部署配置种子（`crate::demo_seed`）用同一套校验和写入。
#[derive(Debug, Clone)]
pub(crate) struct NewSpace {
    pub id: String,
    pub name: String,
    pub description: String,
    pub visibility: Visibility,
}

impl NewSpace {
    /// 建空间的校验：编号格式、名称和说明的长度与字符。
    pub(crate) fn validate(&self) -> Result<(), ApiError> {
        if !is_space_id(&self.id) {
            return Err(ApiError::invalid(
                "id 必须是 3–64 个字符的小写字母、数字和 -，首尾不能是 -",
            ));
        }
        check_text("name", &self.name, MAX_NAME_CHARS, false)?;
        check_text(
            "description",
            &self.description,
            MAX_DESCRIPTION_CHARS,
            true,
        )
    }
}

/// [`create_space_with`] 的结果。
#[derive(Debug)]
pub(crate) enum SpaceCreation {
    /// 已创建；`space` 是写完第一次提交后的空间文档，`anchors` 是当前锚点。
    Created {
        space: Box<Space>,
        anchors: Vec<AnchorBody>,
    },
    /// 空间编号已存在（唯一键：多副本同时建同一个空间也只有一个成功）。
    Duplicate,
}

/// 写空间文档（主人和归属证据取自创建凭据），再写第一次提交（`_space` 锚点 + 通用方块表，
/// 设计 4.3、4.4）。管理接口 `admin_create_space` 和部署配置种子共用这一条路径；
/// `genesis_by` 是第一次提交的发布者 `(sub, nyxServiceId)`。
pub(crate) async fn create_space_with(
    state: &AppState,
    grant: &CreateGrant,
    new: NewSpace,
    share_tokens: Vec<ShareTokenRecord>,
    genesis_by: (&str, &str),
    now: Timestamp,
) -> Result<SpaceCreation, ApiError> {
    new.validate()?;
    let space = Space {
        id: new.id,
        name: new.name.trim().to_owned(),
        description: new.description,
        owner: grant.owner().clone(),
        owner_evidence: grant.evidence().cloned(),
        visibility: new.visibility,
        share_tokens,
        frame: None,
        head: Head {
            seq: 0,
            at: now,
            commit_id: None,
        },
        regions: Vec::new(),
        plots: Vec::new(),
        storage_limit_bytes: DEFAULT_STORAGE_LIMIT_BYTES,
        storage_used_bytes: 0,
        created_at: now,
        updated_at: now,
    };
    match state.repo.insert_space(grant, &space).await {
        Ok(()) => {}
        Err(RepoError::Duplicate) => return Ok(SpaceCreation::Duplicate),
        Err(error) => return Err(error.into()),
    }
    tracing::info!(
        space = %space.id,
        owner_kind = ?space.owner.kind,
        owner = %space.owner.id,
        by = %genesis_by.0,
        "空间已创建"
    );
    // 第一次提交失败也不影响建空间：之后第一次建草稿、改区域，或建会写提交的任务（导入扫描、
    // 体素化、重建）时会补写（只在 head.seq == 0 时写）。
    let space_grant = state.authorizer.grant_for_created_space(grant, &space.id);
    match crate::timeline::writer::ensure_genesis_as(
        &state.repo,
        &space_grant,
        genesis_by.0,
        genesis_by.1,
        now,
    )
    .await
    {
        Ok(_) => {
            let current = state.repo.space(&space_grant).await.ok().flatten();
            let anchors = state.repo.anchors(&space_grant).await.unwrap_or_default();
            Ok(SpaceCreation::Created {
                space: Box::new(current.unwrap_or(space)),
                anchors,
            })
        }
        Err(error) => {
            tracing::warn!(space = %space.id, error = ?error, "第一次提交没有写成，稍后补写");
            Ok(SpaceCreation::Created {
                space: Box::new(space),
                anchors: Vec::new(),
            })
        }
    }
}
