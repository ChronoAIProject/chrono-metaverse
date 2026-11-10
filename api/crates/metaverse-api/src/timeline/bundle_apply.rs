//! 重建包的展开（docs/design/server-slim.md 2.6）：交包任务（`ops_from_upload`，参数
//! `{draftId, source: "bundle", manifestHash}`）和部署种子共用。
//!
//! 1. 读清单（≤ 16 MiB，核对哈希），按 6.3 完整校验：在阻塞线程池里"外层带类型、记录逐条"地解析
//!    （`metaverse_core::bundle::Bundle::parse`），`merge` 模式可以引用草稿工作状态里重建层已有的模板；
//! 2. `files[]` 的每个文件：属于本空间、核对记录满足这个用途对应的角色、长度等于 `size`；不满足的
//!    列出前 20 个；
//! 3. 按 6.4 展开成操作（`Bundle::for_each_op`），每条写成规范 JSON 一行，按内容哈希登记成本空间的
//!    `ops` 资源（同一份清单展开得到同一个哈希，已有就复用）；
//! 4. 在草稿的工作状态上分批作用这些操作（范围 `rebuild`，2.4、2.5 的规则全部生效），交给调用方
//!    按租约栅栏写回（`Repo::save_draft_for_job`）。
//!
//! 内存里同时有的是清单原文、展开的操作文件（与清单差不多大）、一批解析出的操作和草稿的工作状态，
//! 不会出现整份清单的通用 JSON 树。

use std::sync::Arc;

use axum::http::StatusCode;
use metaverse_core::bundle::{Bundle, BundleFile, FilePurpose, SpaceTemplates};
use metaverse_core::canonical::canonical_json_of;
use metaverse_core::limits::UploadLimits;
use metaverse_core::model::Layer;
use metaverse_core::ops::Op;
use metaverse_core::Timestamp;
use serde_json::{json, Value};

use super::drafts::{AppendSession, OpsSource, PreparedAppend, MAX_DRAFT_OPS};
use super::state::ApplyError;
use crate::auth::Grant;
use crate::error::ApiError;
use crate::repo::{AssetRole, DraftDoc, Repo, UnusableAsset};

/// 每批作用多少条操作。
const OPS_BATCH: usize = 2000;
/// 文件问题最多列几个。
const LIST_FILES: usize = 20;

/// 展开好、还没保存的结果。
#[derive(Debug, Clone)]
pub struct BundleApplied {
    /// 交包以后的草稿（`rev` 已加一），由调用方按栅栏保存。
    pub prepared: PreparedAppend,
    /// 任务结果（2.6 第 7 步）。
    pub result: Value,
}

/// 清单不合规（内容问题，不重试）：422 `invalid_bundle`。
fn invalid_bundle(detail: impl Into<String>) -> ApplyError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_bundle",
        detail.into(),
    )
    .into()
}

/// 清单文件用途对应的角色。
pub fn role_of(purpose: FilePurpose) -> AssetRole {
    match purpose {
        FilePurpose::Scan => AssetRole::Scan,
        FilePurpose::Webmodel => AssetRole::WebModel,
        FilePurpose::Model => AssetRole::Model,
        FilePurpose::Texture => AssetRole::Texture,
        FilePurpose::Script => AssetRole::Script,
    }
}

/// 解析清单得到的、展开以后还要用的部分。
struct Expanded {
    note: String,
    notes: Option<String>,
    files: Vec<BundleFile>,
    /// 展开的操作文件（每行一条规范 JSON）。
    ndjson: Vec<u8>,
    count: u64,
}

/// 第 2 步：`files[]` 的每个文件属于本空间、核对记录合乎用途、长度等于 `size`。
async fn check_files(
    repo: &Repo,
    grant: &Grant,
    files: &[BundleFile],
    limits: &UploadLimits,
) -> Result<(), ApplyError> {
    let wanted: Vec<(String, AssetRole)> = files
        .iter()
        .map(|file| (file.sha256.clone(), role_of(file.purpose)))
        .collect();
    let checked = repo.check_asset_roles(grant, &wanted, limits).await?;
    let mut problems: Vec<String> = checked
        .unusable
        .iter()
        .map(|unusable| {
            let path = files
                .iter()
                .find(|file| file.sha256 == unusable.hash)
                .map_or("?", |file| file.path.as_str());
            format!("{path}（{}）", UnusableAsset::describe(unusable))
        })
        .collect();
    for file in files {
        if let Some(length) = checked.lengths.get(&file.sha256) {
            if *length != file.size {
                problems.push(format!(
                    "{}：空间里的文件 {length} 字节，清单写的是 {} 字节",
                    file.path, file.size
                ));
            }
        }
    }
    if problems.is_empty() {
        return Ok(());
    }
    let count = problems.len();
    problems.truncate(LIST_FILES);
    Err(invalid_bundle(format!(
        "{count} 个文件还没上传、不属于本空间，或核对结果不合用途：{}",
        problems.join("；")
    )))
}

/// 在阻塞线程上从展开的操作文件里取下一批操作（从 `offset` 起，最多 [`OPS_BATCH`] 条）。
async fn next_batch(ndjson: Arc<Vec<u8>>, offset: usize) -> Result<(Vec<Op>, usize), ApplyError> {
    tokio::task::spawn_blocking(move || {
        let mut ops = Vec::new();
        let mut at = offset;
        while at < ndjson.len() && ops.len() < OPS_BATCH {
            let end = ndjson[at..]
                .iter()
                .position(|b| *b == b'\n')
                .map_or(ndjson.len(), |i| at + i);
            let op: Op = serde_json::from_slice(&ndjson[at..end]).map_err(|error| {
                tracing::error!(error = %error, "展开的操作文件读不回来");
                ApiError::internal()
            })?;
            ops.push(op);
            at = end + 1;
        }
        Ok::<_, ApiError>((ops, at))
    })
    .await
    .map_err(|_| ApiError::internal())?
    .map_err(ApplyError::from)
}

/// 把重建包展开、作用到重建草稿上（docs/design/server-slim.md 2.6 第 2–5 步），返回还没保存的
/// 草稿和任务结果。调用方已经确认草稿是 `open`、范围 `rebuild`，本任务还没做过。
pub async fn apply_bundle(
    repo: &Repo,
    grant: &Grant,
    draft: DraftDoc,
    manifest_hash: &str,
    job_id: &str,
    limits: &UploadLimits,
    now: Timestamp,
) -> Result<BundleApplied, ApplyError> {
    let draft_id = draft.id.clone();
    // 1. 读清单。
    let meta = repo
        .asset_meta_for_runner(grant, manifest_hash)
        .await?
        .ok_or_else(|| invalid_bundle("清单不存在（可能已被清理），请重新上传"))?;
    if meta.length > limits.bundle.max_bytes {
        return Err(invalid_bundle(format!(
            "清单 {} 字节，超过上限 {} 字节",
            meta.length, limits.bundle.max_bytes
        )));
    }
    let bytes = repo
        .read_asset_bytes(&meta, limits.bundle.max_bytes)
        .await?;
    // 交包的检查（重建草稿、只收一个包）在开始时做；展开文件的哈希要等展开以后才知道，
    // 收尾时换成真正的来源。
    let placeholder = OpsSource::Bundle {
        asset_hash: String::new(),
        job_id: job_id.to_owned(),
        manifest_hash: manifest_hash.to_owned(),
        note: String::new(),
        notes: None,
    };
    let mut session = AppendSession::begin(repo, grant, draft, &placeholder, limits).await?;
    let templates = session.templates_of(Layer::Rebuilt);
    let parse_limits = *limits;
    let expanded = tokio::task::spawn_blocking(move || -> Result<Expanded, String> {
        let text = std::str::from_utf8(&bytes).map_err(|_| "清单必须是 UTF-8 文本".to_owned())?;
        let bundle = Bundle::parse(text, &parse_limits, Some(SpaceTemplates(&templates)))
            .map_err(|error| error.to_string())?;
        let mut ndjson = Vec::with_capacity(text.len() + 4096);
        let mut count = 0u64;
        bundle
            .for_each_op(|op| {
                let line = canonical_json_of(&op).map_err(|error| {
                    metaverse_core::bundle::BundleError {
                        field: "$".into(),
                        message: format!("操作无法规范化：{error}"),
                    }
                })?;
                ndjson.extend_from_slice(line.as_bytes());
                ndjson.push(b'\n');
                count += 1;
                Ok::<(), metaverse_core::bundle::BundleError>(())
            })
            .map_err(|error| error.to_string())?;
        Ok(Expanded {
            note: bundle.note.clone(),
            notes: bundle.notes.clone(),
            files: bundle.files.clone(),
            ndjson,
            count,
        })
    })
    .await
    .map_err(|_| ApiError::internal())?
    .map_err(|message| invalid_bundle(format!("清单不合规：{message}")))?;
    if expanded.count > MAX_DRAFT_OPS {
        return Err(invalid_bundle(format!(
            "展开后有 {} 条操作，超过一个草稿的上限 {MAX_DRAFT_OPS} 条",
            expanded.count
        )));
    }
    // 2. 文件。
    check_files(repo, grant, &expanded.files, limits).await?;
    // 3. 展开的操作文件登记成本空间的 ops 资源（按内容哈希，已有就复用）。
    let ops_hash = repo
        .put_asset_bytes_with(
            grant,
            &expanded.ndjson,
            "application/x-ndjson",
            "ops",
            &[("format", "ndjson")],
        )
        .await?
        .hash;
    // 4. 分批作用。
    let ndjson = Arc::new(expanded.ndjson);
    let mut offset = 0;
    while offset < ndjson.len() {
        let (ops, next) = next_batch(ndjson.clone(), offset).await?;
        offset = next;
        if !ops.is_empty() {
            session.apply(repo, grant, ops).await?;
        }
    }
    drop(ndjson);
    let applied = session.applied();
    let source = OpsSource::Bundle {
        asset_hash: ops_hash.clone(),
        job_id: job_id.to_owned(),
        manifest_hash: manifest_hash.to_owned(),
        note: expanded.note,
        notes: expanded.notes,
    };
    let prepared = session.finish(repo, grant, source, now).await?;
    let mut result = prepared.report.to_json();
    if let Value::Object(map) = &mut result {
        map.insert("applied".into(), json!(applied));
        map.insert("files".into(), json!(expanded.files.len()));
        map.insert("manifestHash".into(), json!(manifest_hash));
        map.insert("opsHash".into(), json!(ops_hash));
        map.insert("draftId".into(), json!(draft_id));
        map.insert("rev".into(), json!(prepared.draft.rev));
    }
    Ok(BundleApplied { prepared, result })
}
