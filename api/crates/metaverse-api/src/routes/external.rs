//! 每次先校验空间版本或草稿预览权限，再读取来源和服务器缓存。
use super::public_access::{public_space_grant_for_seq, UniverseParam, ViewerHeaders};
use crate::{
    auth::Grant,
    error::{ApiError, ProblemDocument},
    external::source::Source,
    public::CacheKey,
    repo::DraftDoc,
    AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::Value;
use utoipa::IntoParams;

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ExternalQuery {
    /// 空间版本；草稿预览忽略此字段，以令牌绑定的修订为准。
    pub seq: Option<u64>,
    /// 声明来源的背景物件编号。
    pub entity: String,
    /// map 或 content。
    pub kind: String,
    /// 来源数组的下标。
    pub source: usize,
    /// 索引、分片或依赖的原始 HTTPS 地址。
    pub url: String,
}

#[utoipa::path(get, path = "/api/public/spaces/{space_id}/external", operation_id = "get_public_external", tag = "public",
    params(("space_id" = String, Path), ExternalQuery, UniverseParam),
    responses((status = 200, description = "外部资源字节，响应本身不缓存，每次重新授权"), (status = 403, description = "来源拒绝或超出来源范围", body = ProblemDocument), (status = 404, description = "空间版本或来源不可见", body = ProblemDocument)))]
pub async fn get_public_external(
    State(state): State<AppState>,
    Path(space_id): Path<String>,
    Query(query): Query<ExternalQuery>,
    Query(universe): Query<UniverseParam>,
    headers: ViewerHeaders,
) -> Result<Response, ApiError> {
    let seq = query
        .seq
        .ok_or_else(|| ApiError::invalid("需要空间版本 seq"))?;
    let grant = public_space_grant_for_seq(
        &state,
        &space_id,
        &headers,
        universe.universe.as_deref(),
        seq,
    )
    .await?;
    let space = state
        .repo
        .space(&grant)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if seq > space.head.seq {
        return Err(ApiError::not_found());
    }
    let key = CacheKey::Other {
        purpose: "external-source",
        space_id,
        key: serde_json::to_string(&(space.created_at, seq, &query.entity))
            .map_err(|_| ApiError::internal())?,
    };
    let entity = entity_body(&state, &grant, &query.entity, seq, None, &key).await?;
    respond(&state, query, entity).await
}

#[utoipa::path(get, path = "/api/public/previews/external", operation_id = "get_preview_external", tag = "public", params(ExternalQuery),
    responses((status = 200, description = "草稿来源的外部资源字节"), (status = 404, description = "预览已过期或草稿已变化", body = ProblemDocument)))]
pub async fn get_preview_external(
    State(state): State<AppState>,
    Query(query): Query<ExternalQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (grant, draft, _) = super::previews::previewed_with_target(&state, &headers).await?;
    let key = CacheKey::Other {
        purpose: "external-preview-source",
        space_id: grant.space_id().to_owned(),
        key: serde_json::to_string(&(&draft.id, draft.rev, &query.entity))
            .map_err(|_| ApiError::internal())?,
    };
    let entity = entity_body(
        &state,
        &grant,
        &query.entity,
        draft.base_seq,
        Some(&draft),
        &key,
    )
    .await?;
    respond(&state, query, entity).await
}

// 每个版本只查询声明来源的那一条物件，不为每片瓦片组装、编码和解析整份快照。
// 缓存键包含空间创建时间或草稿修订；调用方必须先重新授权。
async fn entity_body(
    state: &AppState,
    grant: &Grant,
    entity: &str,
    seq: u64,
    draft: Option<&DraftDoc>,
    key: &CacheKey,
) -> Result<Value, ApiError> {
    if let Some(bytes) = state.public.cache.get(key) {
        return serde_json::from_slice(&bytes).map_err(|_| ApiError::internal());
    }
    let changed = draft.and_then(|draft| {
        draft
            .result_entities
            .iter()
            .find(|change| change.id == entity)
    });
    let hash = match changed {
        Some(change) => change.hash.clone(),
        None => state
            .repo
            .manifest_at(grant, seq)
            .await?
            .entities
            .remove(entity),
    }
    .ok_or_else(ApiError::not_found)?;
    let body = state
        .repo
        .record_bodies(grant, &[&hash])
        .await?
        .remove(&hash)
        .ok_or_else(ApiError::not_found)?;
    state.public.cache.insert(
        key,
        Bytes::from(serde_json::to_vec(&body).map_err(|_| ApiError::internal())?),
    );
    Ok(body)
}

async fn respond(
    state: &AppState,
    query: ExternalQuery,
    entity: Value,
) -> Result<Response, ApiError> {
    let source = Source::from_entity(&entity, &query.kind, query.source)?;
    let (bytes, content_type, cached) = state.external.fetch(&source, &query.url).await?;
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    // 外部内容不能作为本站可执行文档使用；授权响应不交给共享 HTTP 缓存。
    let mime = content_type.split(';').next().unwrap_or("").trim();
    let safe_type = match mime {
        "application/json" | "model/gltf+json" | "model/gltf-binary" | "image/png"
        | "image/jpeg" | "image/webp" | "image/ktx2" => mime,
        _ => "application/octet-stream",
    };
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(safe_type).map_err(|_| ApiError::internal())?,
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment"),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static("sandbox; default-src 'none'"),
    );
    headers.insert(
        "x-resource-cache",
        HeaderValue::from_static(if cached { "hit" } else { "miss" }),
    );
    Ok(response)
}
