//! 错误格式：与 CMA `layer1-public/src/rest/problems.rs` 相同，RFC 9457 problem+json，
//! 字段是 `type`、`title`、`status`、`detail`、`code`。错误响应一律 `Cache-Control: no-store`。
//!
//! 返回码约定（设计 9.4）：看不到 → 404（不暴露资源是否存在）；能看到但不能写 → 403；
//! 身份不对 → 401；组织角色查不到且是写操作 → 503 `org_membership_unavailable`。

use std::borrow::Cow;

use axum::{
    extract::rejection::JsonRejection,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use utoipa::ToSchema;

use crate::repo::RepoError;

/// `type` 字段的前缀。
pub const PROBLEM_TYPE_PREFIX: &str = "urn:chrono-metaverse:problem:";

/// RFC 9457 错误文档。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct ProblemDocument {
    #[serde(rename = "type")]
    pub problem_type: String,
    pub title: String,
    pub status: u16,
    pub detail: String,
    /// 机器可读的错误码，例如 `unauthenticated`、`not_found`、`org_membership_unavailable`。
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub detail: Cow<'static, str>,
}

impl ApiError {
    pub fn new(
        status: StatusCode,
        code: &'static str,
        detail: impl Into<Cow<'static, str>>,
    ) -> Self {
        Self {
            status,
            code,
            detail: detail.into(),
        }
    }

    /// 401：缺少身份令牌或校验没通过。`reason` 是验签给出的原因码。
    pub fn unauthenticated(reason: &'static str) -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            format!("NyxID 身份令牌无效（{reason}）"),
        )
    }

    pub fn forbidden() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "调用者能看到这个资源，但没有执行这个操作的权限",
        )
    }

    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "资源不存在")
    }

    pub fn conflict(detail: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::CONFLICT, "conflict", detail)
    }

    pub fn invalid(detail: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "invalid_request", detail)
    }

    pub fn org_membership_unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "org_membership_unavailable",
            "暂时查不到调用者在 NyxID 组织里的角色，请稍后重试",
        )
    }

    pub fn identity_unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "identity_unavailable",
            "暂时拿不到 NyxID 公钥，无法校验身份令牌",
        )
    }

    pub fn store_unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "数据库暂时不可用",
        )
    }

    pub fn starting() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "starting",
            "服务正在启动（建立索引），请稍后重试",
        )
    }

    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "服务内部错误",
        )
    }

    pub fn document(&self) -> ProblemDocument {
        let slug = self.code.replace('_', "-");
        ProblemDocument {
            problem_type: format!("{PROBLEM_TYPE_PREFIX}{slug}"),
            title: self.code.replace('_', " "),
            status: self.status.as_u16(),
            detail: self.detail.to_string(),
            code: self.code.to_owned(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (self.status, Json(self.document())).into_response();
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/problem+json"),
        );
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}

impl From<RepoError> for ApiError {
    fn from(error: RepoError) -> Self {
        match error {
            RepoError::Unavailable => ApiError::store_unavailable(),
            RepoError::Duplicate => ApiError::conflict("编号已存在"),
            RepoError::GrantMismatch | RepoError::Corrupt(_) => {
                tracing::error!(error = %error, "数据访问层拒绝");
                ApiError::internal()
            }
        }
    }
}

impl From<JsonRejection> for ApiError {
    fn from(rejection: JsonRejection) -> Self {
        match rejection.status() {
            StatusCode::UNSUPPORTED_MEDIA_TYPE => Self::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_media_type",
                "请求体必须是 application/json",
            ),
            StatusCode::PAYLOAD_TOO_LARGE => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_too_large",
                "请求体超过上限",
            ),
            StatusCode::BAD_REQUEST => Self::new(
                StatusCode::BAD_REQUEST,
                "malformed_json",
                rejection.body_text(),
            ),
            _ => Self::invalid(rejection.body_text()),
        }
    }
}

/// 未知路径。
pub async fn not_found() -> ApiError {
    ApiError::not_found()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn problem_documents_are_machine_readable() {
        let response = ApiError::org_membership_unavailable().into_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/problem+json"
        );
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        let document = ApiError::not_found().document();
        assert_eq!(
            document.problem_type,
            "urn:chrono-metaverse:problem:not-found"
        );
        assert_eq!(document.title, "not found");
        assert_eq!(document.status, 404);
    }
}
