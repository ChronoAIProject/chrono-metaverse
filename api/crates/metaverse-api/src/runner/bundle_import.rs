//! 部署种子导入重建包（docs/design/server-slim.md 7.2"执行器做 `bundle_import`"），占重任务名额。
//! 参数 `{manifest: {url, sha256, size}, sources: {url, sha256, size}, revision}`，范围 `rebuild`。
//!
//! 1. 下载清单和来源表并核对（都很小，不缓存），按 SHAPES 7 和来源表规则校验；
//! 2. 清单 `files[]` 的每个文件（连同清单本身）：本空间已拥有、核对结果合乎用途、长度对得上 → 刷新
//!    `touchedAt`，跳过；否则按来源表下载进一个系统身份的上传会话（`url`：边下边写数据块；`zip`：
//!    逐个下载成员、核对哈希和大小，按 `demo_seed::pack` 的布局写本地头和数据，最后写中央目录），
//!    再走与 `upload_verify` 相同的核对和登记（计入存储用量）。来源表里没有 → 失败（`content`）；
//! 3. 草稿：编号由任务编号算出，不存在就建（基础版本取最新 seq，种子不看清单的 `base`）；草稿的
//!    `bundleRef` 已经是这份清单 → 跳过展开；否则按交包的规则展开、追加（事务里带本任务的租约条件，
//!    只写进度、不完成任务）；
//! 4. 发布：说明是清单的 `note` 加"（部署配置种子第 N 版）"；遇到冲突自动在最新版本上重放；提交带
//!    `jobId`，同一个事务里把任务标记完成；没有变化就不写提交，草稿标记已发布，任务结果写
//!    `unchanged: true`；
//! 5. 结果：`{manifest, files: {total, reused, downloaded, bytes}, draftId, commitId?, seq, unchanged?,
//!    entities, anchors: {created, skipped}, anchorDrift}`。
//!
//! 失败分类（4.2）：哈希或大小不符、清单或来源表不合规、展开或校验不过、主机不在列表 → `content`；
//! 403、404、408、429、5xx、网络错误、超时 → `fetch`（用完次数后失败，下次启动时种子重新排队）；
//! 数据库 → `transient`。错误说明只写主机和文件路径，不写完整地址。
//!
//! **重做是安全的**：上传会话的编号由（任务、文件哈希）算出，重做时接着用；登记按哈希幂等；草稿按
//! `bundleRef` 判断是否已经展开；发布带 `jobId`（唯一索引）且与任务完成在同一个事务里；所有写入都带
//! 租约栅栏。

use std::collections::BTreeMap;
use std::sync::Arc;

use metaverse_core::bundle::{Bundle, BundleFile, FilePurpose};
use metaverse_core::model::{
    Author, OwnerKind, RequestActor, Touched, Upload, UploadFormat, UploadPart, UploadStatus,
    OPERATOR_SEED_SUBJECT,
};
use metaverse_core::scope::{PathScope, UploadPurpose};
use metaverse_core::sha256_hex;
use serde::Deserialize;
use serde_json::{json, Value};

use super::upload_verify::{self, Mode};
use super::{JobFailure, Lease, Runner};
use crate::auth::{Grant, SeedSpace};
use crate::demo_seed::fetch::{FetchError, Fetcher};
use crate::demo_seed::pack::{self, ZipBuilder};
use crate::demo_seed::sources::{Source, Sources};
use crate::demo_seed::Pinned;
use crate::repo::{
    AssetRole, DraftDoc, DraftStatus, JobDraftSave, JobFence, JobStep, PartWrite, Repo, RepoError,
};
use crate::timeline::bundle_apply::{apply_bundle, role_of};
use crate::timeline::drafts::{
    publish, JobPublish, PublishError, PublishOptions, PublishOutcome, Publisher,
};
use crate::timeline::state::ApplyError;

/// 写进上传会话的分片大小（32 个 256 KiB 的数据块）。
const PART_SIZE: u64 = 8 << 20;
/// 草稿的过期时间（与接口建的草稿相同）。
const DRAFT_TTL_SECONDS: i64 = 30 * 24 * 3600;
/// 提交说明的字符数上限（与发布接口相同）。
const MAX_MESSAGE_CHARS: usize = 2000;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Params {
    manifest: Pinned,
    sources: Pinned,
    revision: u32,
}

fn now() -> Result<metaverse_core::Timestamp, JobFailure> {
    crate::now().map_err(|_| JobFailure::Transient("取不到当前时间".to_owned()))
}

fn fetch_failure(error: FetchError) -> JobFailure {
    match error {
        FetchError::Fetch(message) => JobFailure::Fetch(message),
        FetchError::Content(message) => JobFailure::Content(message),
    }
}

fn apply_failure(error: ApplyError) -> JobFailure {
    match error {
        ApplyError::Op(error) => JobFailure::Content(format!("展开重建包失败：{error}")),
        ApplyError::Api(error) => error.into(),
    }
}

/// 种子草稿的编号：由任务编号算出，重做时找得到同一个草稿。
pub fn seed_draft_id(job_id: &str) -> String {
    format!(
        "d_{}",
        &sha256_hex(format!("demo-seed-draft\0{job_id}").as_bytes())[..32]
    )
}

/// 种子上传会话的编号：由（任务、文件哈希）算出，重做时接着用。
pub fn seed_upload_id(job_id: &str, sha256: &str) -> String {
    format!(
        "up_seed_{}",
        &sha256_hex(format!("demo-seed-upload\0{job_id}\0{sha256}").as_bytes())[..32]
    )
}

/// 按路径的扩展名定上传格式（与命令行 `bundle push` 相同的规则）。
pub fn format_of(purpose: FilePurpose, path: &str) -> Option<UploadFormat> {
    let extension = path
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase());
    match (purpose, extension.as_deref()) {
        (FilePurpose::Scan, Some("zip")) => Some(UploadFormat::Zip),
        (FilePurpose::Scan, Some("glb")) => Some(UploadFormat::Glb),
        (FilePurpose::Scan, Some("drc")) => Some(UploadFormat::Drc),
        (FilePurpose::Scan, Some("obj")) => Some(UploadFormat::Obj),
        (FilePurpose::Webmodel | FilePurpose::Model, Some("glb")) => Some(UploadFormat::Glb),
        (FilePurpose::Texture, Some("png")) => Some(UploadFormat::Png),
        (FilePurpose::Texture, Some("jpg" | "jpeg")) => Some(UploadFormat::Jpeg),
        (FilePurpose::Texture, Some("webp")) => Some(UploadFormat::Webp),
        (FilePurpose::Script, _) => Some(UploadFormat::Text),
        _ => None,
    }
}

/// 展开好、等发布的种子导入。
pub struct Prepared {
    grant: Grant,
    params: Params,
    draft: DraftDoc,
    summary: Value,
}

impl Prepared {
    pub fn draft_id(&self) -> &str {
        &self.draft.id
    }
}

pub async fn run(runner: &Arc<Runner>, lease: &Lease) -> Result<(), JobFailure> {
    match prepare_import(runner, lease).await? {
        None => Ok(()),
        Some(prepared) => publish_import(runner, lease, prepared).await,
    }
}

/// 第 1–3 步（下载、登记、展开）。`None`：上一次已经发布，这一次只补完成了任务。分成两步是为了
/// 测试能在"追加"和"发布"之间换租约（docs/design/server-slim.md 13.2 S4 的验收）。
pub async fn prepare_import(
    runner: &Arc<Runner>,
    lease: &Lease,
) -> Result<Option<Prepared>, JobFailure> {
    let job = &lease.job;
    let fence = &lease.fence;
    let params: Params = serde_json::from_value(job.params.clone())
        .map_err(|error| JobFailure::Content(format!("任务参数不合法：{error}")))?;
    if job.scope.as_ref() != Some(&PathScope::Rebuild) || job.owner.kind != OwnerKind::Org {
        return Err(JobFailure::Content(
            "种子导入任务的范围必须是 rebuild、主人必须是组织".to_owned(),
        ));
    }
    // 只碰部署配置种子为同一组织建的空间（设计 9.2）。
    let grant = match runner
        .state
        .authorizer
        .seed_space(&job.space_id, &job.owner, &job.id)
        .await
    {
        Ok(SeedSpace::Seeded(grant)) => grant,
        Ok(_) => {
            return Err(JobFailure::Content(
                "空间已经不在了，或不是部署配置种子为这个组织建的".to_owned(),
            ))
        }
        Err(error) => return Err(error.into()),
    };
    let repo = &runner.state.repo;
    if !repo.space_instance_exists(&grant, job.created_at).await? {
        return Err(JobFailure::Content("任务所在的空间已经删除".to_owned()));
    }
    let manifest_hash = params.manifest.sha256.clone();
    let draft_id = seed_draft_id(&job.id);
    let existing = repo.draft(&grant, &draft_id).await?;
    if let Some(draft) = &existing {
        if draft.scope != PathScope::Rebuild {
            return Err(JobFailure::Content("种子草稿不是重建草稿".to_owned()));
        }
        // 上一次已经发布（与任务完成在同一个事务里，正常不会走到这里）：按草稿补完成任务。
        if draft.status == DraftStatus::Published {
            let mut result = summary_of(job.progress.as_ref(), &manifest_hash, &draft_id);
            if let Value::Object(map) = &mut result {
                match &draft.commit_id {
                    Some(commit) => {
                        map.insert("commitId".into(), json!(commit));
                    }
                    None => {
                        map.insert("unchanged".into(), json!(draft.unchanged));
                    }
                }
            }
            return if repo
                .complete_job(&runner.background, fence, &result, now()?)
                .await?
            {
                Ok(None)
            } else {
                Err(JobFailure::LeaseLost)
            };
        }
    }
    let (draft, summary) = match existing {
        // 上一次已经展开、追加，只差发布：不再下载，结果摘要取上一次写的进度。
        Some(draft) if draft.bundle_ref.as_deref() == Some(manifest_hash.as_str()) => {
            let summary = summary_of(job.progress.as_ref(), &manifest_hash, &draft_id);
            (draft, summary)
        }
        Some(draft) if draft.bundle_ref.is_some() || !draft.ops_refs.is_empty() => {
            return Err(JobFailure::Content("种子草稿已经交过别的重建包".to_owned()))
        }
        existing => prepare(runner, lease, &grant, &params, &draft_id, existing).await?,
    };
    Ok(Some(Prepared {
        grant,
        params,
        draft,
        summary,
    }))
}

/// 第 4 步：发布（见 [`publish_seed`]）。
pub async fn publish_import(
    runner: &Arc<Runner>,
    lease: &Lease,
    prepared: Prepared,
) -> Result<(), JobFailure> {
    publish_seed(
        runner,
        &lease.fence,
        &prepared.grant,
        &prepared.params,
        prepared.draft,
        prepared.summary,
    )
    .await
}

/// 结果摘要：上一次写在进度里的（展开以后写的那一份），没有就只有清单和草稿。
fn summary_of(progress: Option<&Value>, manifest_hash: &str, draft_id: &str) -> Value {
    match progress {
        Some(progress) if progress.get("stage").and_then(Value::as_str) == Some("applied") => {
            let mut summary = progress.clone();
            if let Value::Object(map) = &mut summary {
                map.remove("stage");
            }
            summary
        }
        _ => json!({"manifest": manifest_hash, "draftId": draft_id}),
    }
}

/// 第 1–3 步：下载并核对清单、来源表，备齐文件，建草稿并展开。返回保存好的草稿和结果摘要。
async fn prepare(
    runner: &Arc<Runner>,
    lease: &Lease,
    grant: &Grant,
    params: &Params,
    draft_id: &str,
    existing: Option<DraftDoc>,
) -> Result<(DraftDoc, Value), JobFailure> {
    let job = &lease.job;
    let fence = &lease.fence;
    let repo = &runner.state.repo;
    let fetcher = Fetcher::new(runner.config.seed_hosts.clone()).map_err(fetch_failure)?;
    let manifest = fetch_pinned(&fetcher, &params.manifest, "清单").await?;
    let sources = fetch_pinned(&fetcher, &params.sources, "来源表").await?;
    let limits = runner.state.ingest.config.upload_limits();
    let hosts = runner.config.seed_hosts.clone();
    let parse_input = manifest.clone();
    let (files, sources) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let text =
            std::str::from_utf8(&parse_input).map_err(|_| "清单必须是 UTF-8 文本".to_owned())?;
        // 种子的包要在新库里也能展开，所以不能引用目标空间已有的模板。
        let bundle =
            Bundle::parse(text, &limits, None).map_err(|error| format!("清单不合规：{error}"))?;
        let sources = Sources::parse(&sources, &hosts, &bundle.files)?;
        Ok((bundle.files, sources))
    })
    .await
    .map_err(|_| JobFailure::Transient("校验清单的线程异常退出".to_owned()))?
    .map_err(JobFailure::Content)?;
    if !repo
        .job_progress(
            &runner.background,
            fence,
            &json!({"stage": "files", "filesTotal": files.len()}),
        )
        .await?
    {
        return Err(JobFailure::LeaseLost);
    }

    // 第 2 步：文件（连同清单本身）。
    let report = ensure_files(
        runner,
        grant,
        job,
        fence,
        &fetcher,
        &files,
        &sources,
        &params.manifest,
        manifest,
    )
    .await?;
    drop(sources);

    // 第 3 步：草稿。
    let draft = match existing {
        Some(draft) => draft,
        None => seed_draft(repo, grant, draft_id).await?,
    };
    let limits = runner.state.ingest.config.upload_limits();
    let now = now()?;
    let applied = apply_bundle(
        repo,
        grant,
        draft,
        &params.manifest.sha256,
        &job.id,
        &limits,
        now,
    )
    .await
    .map_err(apply_failure)?;
    let mut summary = json!({
        "manifest": params.manifest.sha256,
        "files": report,
        "draftId": draft_id,
    });
    if let (Value::Object(map), Value::Object(expanded)) = (&mut summary, &applied.result) {
        for key in ["entities", "anchors", "anchorDrift", "applied"] {
            if let Some(value) = expanded.get(key) {
                map.insert(key.into(), value.clone());
            }
        }
    }
    let mut progress = summary.clone();
    if let Value::Object(map) = &mut progress {
        map.insert("stage".into(), json!("applied"));
    }
    match repo
        .save_draft_for_job(
            grant,
            &applied.prepared.draft,
            applied.prepared.expected_rev,
            fence,
            JobStep::Progress(&progress),
            now,
        )
        .await?
    {
        JobDraftSave::Saved => {}
        JobDraftSave::LeaseLost => return Err(JobFailure::LeaseLost),
        JobDraftSave::DraftChanged => {
            return Err(JobFailure::Transient(
                "种子草稿在展开期间被修改，退回队列重做".to_owned(),
            ))
        }
    }
    tracing::info!(
        space = %job.space_id, job = %job.id, draft = %draft_id,
        manifest = %params.manifest.sha256, ops = applied.prepared.draft.op_count(),
        "部署配置种子：重建包已展开进草稿"
    );
    Ok((applied.prepared.draft, summary))
}

async fn fetch_pinned(
    fetcher: &Fetcher,
    pinned: &Pinned,
    label: &str,
) -> Result<Vec<u8>, JobFailure> {
    let url = pinned.parsed_url().map_err(JobFailure::Content)?;
    fetcher
        .fetch_bytes(&url, label, &pinned.sha256, pinned.size)
        .await
        .map_err(fetch_failure)
}

/// 种子的重建草稿（基础版本取最新 seq）。别的执行器刚建好就用它的。
async fn seed_draft(repo: &Repo, grant: &Grant, draft_id: &str) -> Result<DraftDoc, JobFailure> {
    let now = now()?;
    crate::timeline::writer::ensure_genesis_as(repo, grant, OPERATOR_SEED_SUBJECT, "", now).await?;
    let space = repo
        .space(grant)
        .await?
        .ok_or_else(|| JobFailure::Content("空间已经不在了".to_owned()))?;
    let draft = DraftDoc {
        id: draft_id.to_owned(),
        space_id: grant.space_id().to_owned(),
        owner: grant.owner().clone(),
        scope: PathScope::Rebuild,
        base_seq: space.head.seq,
        rev: 0,
        created_by: Author {
            sub: OPERATOR_SEED_SUBJECT.to_owned(),
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
        held_assets: Vec::new(),
        scan: None,
        bundle_ref: None,
        default_message: None,
        default_script_ref: None,
        unchanged: false,
        commit_id: None,
        work_cells: 0,
        created_at: now,
        updated_at: now,
        expires_at: now.saturating_add_seconds(DRAFT_TTL_SECONDS),
    };
    match repo.insert_draft(grant, &draft).await {
        Ok(()) => Ok(draft),
        Err(RepoError::Duplicate) => repo
            .draft(grant, draft_id)
            .await?
            .ok_or_else(|| JobFailure::Transient("种子草稿刚建好又不见了".to_owned())),
        Err(error) => Err(error.into()),
    }
}

/// 一个要备齐的文件。
struct Wanted<'a> {
    path: &'a str,
    purpose: UploadPurpose,
    format: UploadFormat,
    sha256: &'a str,
    size: u64,
}

/// 第 2 步：清单 `files[]` 的每个文件和清单本身，空间里没有（或核对结果不合用途）就按来源表下载、
/// 核对、登记。返回 `{total, reused, downloaded, bytes}`。
#[allow(clippy::too_many_arguments)]
async fn ensure_files(
    runner: &Arc<Runner>,
    grant: &Grant,
    job: &metaverse_core::model::Job,
    fence: &JobFence,
    fetcher: &Fetcher,
    files: &[BundleFile],
    sources: &Sources,
    manifest: &Pinned,
    manifest_bytes: Vec<u8>,
) -> Result<Value, JobFailure> {
    let repo = &runner.state.repo;
    let limits = runner.state.ingest.config.upload_limits();
    let mut wanted = Vec::with_capacity(files.len() + 1);
    for file in files {
        let format = format_of(file.purpose, &file.path).ok_or_else(|| {
            JobFailure::Content(format!(
                "{} 的扩展名不合 {} 用途（按扩展名定上传格式）",
                file.path,
                file.purpose.name()
            ))
        })?;
        wanted.push(Wanted {
            path: &file.path,
            purpose: file.purpose.upload_purpose(),
            format,
            sha256: &file.sha256,
            size: file.size,
        });
    }
    wanted.push(Wanted {
        path: "manifest.json",
        purpose: UploadPurpose::Bundle,
        format: UploadFormat::Json,
        sha256: &manifest.sha256,
        size: manifest.size,
    });
    let roles: Vec<(String, AssetRole)> = wanted
        .iter()
        .map(|item| {
            let role = match item.purpose {
                UploadPurpose::Bundle => AssetRole::Bundle,
                _ => files
                    .iter()
                    .find(|file| file.sha256 == item.sha256)
                    .map_or(AssetRole::Bundle, |file| role_of(file.purpose)),
            };
            (item.sha256.to_owned(), role)
        })
        .collect();
    let checked = repo.check_asset_roles(grant, &roles, &limits).await?;
    let usable: Vec<String> = wanted
        .iter()
        .filter(|item| {
            !checked.unusable.iter().any(|bad| bad.hash == item.sha256)
                && checked.lengths.get(item.sha256) == Some(&item.size)
        })
        .map(|item| item.sha256.to_owned())
        .collect();
    // 刷新 touchedAt（清理的栅栏）；刷新不到的刚被清理删掉，照样下载。
    let gone = repo.touch_assets(grant, &usable).await?;
    let reusable: Vec<&String> = usable.iter().filter(|hash| !gone.contains(hash)).collect();
    let missing: Vec<&Wanted> = wanted
        .iter()
        .filter(|item| !reusable.iter().any(|hash| hash.as_str() == item.sha256))
        .collect();
    // 存储上限（与上传接口一样计进行中的这些文件）。
    let needed: u64 = missing.iter().map(|item| item.size).sum();
    let space = repo
        .space(grant)
        .await?
        .ok_or_else(|| JobFailure::Content("空间已经不在了".to_owned()))?;
    if space.storage_used_bytes.saturating_add(needed) > space.storage_limit_bytes {
        return Err(JobFailure::Content(format!(
            "要下载的 {} 个文件共 {needed} 字节，超过空间的存储上限",
            missing.len()
        )));
    }
    let mut downloaded = 0u64;
    let mut bytes = 0u64;
    let mut manifest_bytes = Some(manifest_bytes);
    for (index, item) in missing.iter().enumerate() {
        let source = if item.purpose == UploadPurpose::Bundle {
            Feed::Memory(manifest_bytes.take().unwrap_or_default())
        } else {
            match sources.get(item.sha256) {
                Some(Source::Url(url)) => Feed::Url(url),
                Some(Source::Zip(members)) => Feed::Zip(members),
                None => {
                    return Err(JobFailure::Content(format!(
                        "文件 {} 空间里没有，来源表也没给",
                        item.path
                    )))
                }
            }
        };
        store_file(runner, grant, job, fence, fetcher, item, source).await?;
        downloaded += 1;
        bytes += item.size;
        let progress = json!({
            "stage": "files",
            "filesTotal": wanted.len(),
            "filesDownloaded": index + 1,
            "filesMissing": missing.len(),
        });
        if !repo
            .job_progress(&runner.background, fence, &progress)
            .await?
        {
            return Err(JobFailure::LeaseLost);
        }
    }
    let report = json!({
        "total": wanted.len(),
        "reused": wanted.len() as u64 - downloaded,
        "downloaded": downloaded,
        "bytes": bytes,
    });
    tracing::info!(space = %job.space_id, job = %job.id, files = %report, "部署配置种子：文件已备齐");
    Ok(report)
}

/// 文件内容从哪里来。
enum Feed<'a> {
    /// 已经在内存里（清单本身）。
    Memory(Vec<u8>),
    Url(&'a url::Url),
    Zip(&'a [crate::demo_seed::sources::ZipMember]),
}

/// 下载一个文件进本任务的上传会话（编号由任务和哈希算出，重做时接着用），核对并登记成资源。
async fn store_file(
    runner: &Arc<Runner>,
    grant: &Grant,
    job: &metaverse_core::model::Job,
    fence: &JobFence,
    fetcher: &Fetcher,
    item: &Wanted<'_>,
    feed: Feed<'_>,
) -> Result<(), JobFailure> {
    let repo = &runner.state.repo;
    let upload_id = seed_upload_id(&job.id, item.sha256);
    let mut upload = match repo.upload(grant, &upload_id).await? {
        Some(upload) if matches!(upload.status, UploadStatus::Failed | UploadStatus::Expired) => {
            repo.remove_dead_upload(grant, &upload_id).await?;
            None
        }
        other => other,
    };
    if upload.is_none() {
        let fresh = new_upload(grant, &upload_id, item)?;
        match repo.insert_upload(grant, &fresh).await {
            Ok(()) => upload = Some(fresh),
            Err(RepoError::Duplicate) => upload = repo.upload(grant, &upload_id).await?,
            Err(error) => return Err(error.into()),
        }
    }
    let upload =
        upload.ok_or_else(|| JobFailure::Transient("上传会话刚建好又不见了".to_owned()))?;
    if upload.sha256 != item.sha256 || upload.size != item.size {
        return Err(JobFailure::Content(format!(
            "上传会话 {upload_id} 与 {} 对不上",
            item.path
        )));
    }
    if upload.status == UploadStatus::Open {
        let mut writer = PartWriter::new(repo, grant, &upload);
        match feed {
            Feed::Memory(bytes) => writer.push(&bytes).await?,
            Feed::Url(url) => {
                let mut download = fetcher
                    .open(url, item.path, item.size)
                    .await
                    .map_err(fetch_failure)?;
                while let Some(part) = download.next().await.map_err(fetch_failure)? {
                    writer.push(&part).await?;
                }
                download.finish(item.sha256).map_err(fetch_failure)?;
            }
            Feed::Zip(members) => {
                let mut builder = ZipBuilder::default();
                for member in members {
                    let label = format!("{} 的成员 {}", item.path, member.name);
                    let data = fetcher
                        .fetch_bytes(&member.url, &label, &member.sha256, member.size)
                        .await
                        .map_err(fetch_failure)?;
                    // CRC 在阻塞线程池里算（成员最大 128 MiB）。
                    let (crc, data) =
                        tokio::task::spawn_blocking(move || (pack::crc32(&data), data))
                            .await
                            .map_err(|_| {
                                JobFailure::Transient("计算 CRC 的线程异常退出".to_owned())
                            })?;
                    let header = builder
                        .member_with_crc(&member.name, crc, data.len() as u64)
                        .map_err(JobFailure::Content)?;
                    writer.push(&header).await?;
                    writer.push(&data).await?;
                }
                let directory = builder.finish().map_err(JobFailure::Content)?;
                writer.push(&directory).await?;
            }
        }
        writer.finish().await?;
        if !repo.complete_upload_inline(grant, &upload, now()?).await? {
            return Err(JobFailure::Transient(format!(
                "{} 的上传会话已经不是 open，退回队列重做",
                item.path
            )));
        }
    }
    let current = repo.upload(grant, &upload_id).await?.ok_or_else(|| {
        JobFailure::Transient("上传会话不见了（被清理？），退回队列重做".to_owned())
    })?;
    match upload_verify::verify(
        runner,
        grant,
        &current,
        fence,
        Mode::CheckLease,
        Some(item.path),
    )
    .await
    {
        Ok(()) => {
            tracing::info!(space = %job.space_id, job = %job.id, file = %item.path, bytes = item.size, "部署配置种子：文件已下载、核对并登记");
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn new_upload(grant: &Grant, id: &str, item: &Wanted<'_>) -> Result<Upload, JobFailure> {
    let now = now()?;
    Ok(Upload {
        id: id.to_owned(),
        space_id: grant.space_id().to_owned(),
        owner: grant.owner().clone(),
        scope: PathScope::Rebuild,
        purpose: item.purpose,
        declared_format: item.format,
        status: UploadStatus::Open,
        size: item.size,
        sha256: item.sha256.to_owned(),
        part_size: PART_SIZE,
        part_count: item.size.div_ceil(PART_SIZE),
        parts: BTreeMap::new(),
        header_checked: false,
        actor: RequestActor {
            sub: OPERATOR_SEED_SUBJECT.to_owned(),
            nyx_service_id: String::new(),
        },
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
    })
}

/// 把字节流按分片写进上传会话的数据块：攒够一片（8 MiB）就写，内存里最多一片。
struct PartWriter<'a> {
    repo: &'a Repo,
    grant: &'a Grant,
    upload: &'a Upload,
    buffer: Vec<u8>,
    next_part: u64,
    written: u64,
}

impl<'a> PartWriter<'a> {
    fn new(repo: &'a Repo, grant: &'a Grant, upload: &'a Upload) -> Self {
        Self {
            repo,
            grant,
            upload,
            buffer: Vec::with_capacity(upload.part_size.min(upload.size) as usize),
            next_part: 0,
            written: 0,
        }
    }

    async fn push(&mut self, mut data: &[u8]) -> Result<(), JobFailure> {
        while !data.is_empty() {
            let room = self.upload.part_size as usize - self.buffer.len();
            let take = room.min(data.len());
            self.buffer.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.buffer.len() as u64 == self.upload.part_size {
                self.flush().await?;
            }
        }
        Ok(())
    }

    async fn flush(&mut self) -> Result<(), JobFailure> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let length = self.buffer.len() as u64;
        if self.written + length > self.upload.size || self.next_part >= self.upload.part_count {
            return Err(JobFailure::Content(format!(
                "内容比声明的 {} 字节大",
                self.upload.size
            )));
        }
        let part = UploadPart {
            size: length,
            sha256: sha256_hex(&self.buffer),
        };
        match self
            .repo
            .write_upload_part(
                self.grant,
                self.upload,
                self.next_part,
                &self.buffer,
                part,
                now()?,
            )
            .await?
        {
            PartWrite::Stored => {}
            PartWrite::NotOpen => {
                return Err(JobFailure::Transient(
                    "上传会话已经不是 open（过期或被清理），退回队列重做".to_owned(),
                ))
            }
        }
        self.written += length;
        self.next_part += 1;
        self.buffer.clear();
        Ok(())
    }

    async fn finish(mut self) -> Result<(), JobFailure> {
        self.flush().await?;
        if self.written != self.upload.size {
            return Err(JobFailure::Content(format!(
                "内容只有 {} 字节，声明的是 {}",
                self.written, self.upload.size
            )));
        }
        Ok(())
    }
}

/// 第 4 步：发布。冲突时自动在最新版本上重放；提交带 `jobId`，任务完成在同一个事务里。
async fn publish_seed(
    runner: &Arc<Runner>,
    fence: &JobFence,
    grant: &Grant,
    params: &Params,
    draft: DraftDoc,
    summary: Value,
) -> Result<(), JobFailure> {
    let repo = &runner.state.repo;
    let suffix = format!("（部署配置种子第 {} 版）", params.revision);
    let note = draft.default_message.clone().unwrap_or_default();
    let room = MAX_MESSAGE_CHARS.saturating_sub(suffix.chars().count());
    let message: String = note.chars().take(room).collect::<String>() + &suffix;
    let options = PublishOptions {
        message: Some(message),
        // 种子没有人工确认这一步，内容由部署配置钉死：遇到冲突直接在最新版本上重放。
        replay: true,
        expected_rev: Some(draft.rev),
        observed_at: None,
        script_ref: None,
        limits: runner.state.ingest.config.upload_limits(),
        job: Some(JobPublish {
            fence: fence.clone(),
            result: summary,
        }),
    };
    let publisher = Publisher::system(OPERATOR_SEED_SUBJECT);
    match publish(repo, grant, &publisher, &draft, &options, now()?).await {
        Ok(PublishOutcome::Committed(outcome)) => {
            runner.state.public.cache.invalidate_space(grant.space_id());
            tracing::info!(target: "audit", space = %grant.space_id(), job = %fence.job_id, seq = outcome.seq, commit = %outcome.commit_id, "部署配置种子：已发布");
            Ok(())
        }
        Ok(PublishOutcome::Unchanged { seq }) => {
            tracing::info!(space = %grant.space_id(), job = %fence.job_id, seq, "部署配置种子：内容与最新版本相同，没写提交");
            Ok(())
        }
        Err(PublishError::LeaseLost) => Err(JobFailure::LeaseLost),
        Err(PublishError::Api(error)) if error.code == "draft_changed" => Err(
            JobFailure::Transient(format!("发布时草稿变了，退回队列：{}", error.detail)),
        ),
        Err(PublishError::Api(error)) => Err(error.into()),
        Err(PublishError::Conflicts { keys, .. }) => Err(JobFailure::Transient(format!(
            "发布时冲突（{}），退回队列重做",
            keys.join("、")
        ))),
        Err(PublishError::OutOfScope(error)) => {
            Err(JobFailure::Content(format!("按最新的区域和地块，{error}")))
        }
        Err(PublishError::ReplayFailed(error)) => Err(JobFailure::Content(format!(
            "在最新版本上重放失败：{error}"
        ))),
        Err(PublishError::BrokenTemplates(broken)) => Err(JobFailure::Content(format!(
            "按最新版本合并以后有 {} 处模板引用找不到同一层的模板",
            broken.len()
        ))),
        Err(PublishError::AssetsGone(gone)) => Err(JobFailure::Transient(format!(
            "发布时 {} 个资源已经被清理，退回队列重新下载",
            gone.len()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_follow_the_command_line() {
        assert_eq!(
            format_of(FilePurpose::Scan, "scan/scan.zip"),
            Some(UploadFormat::Zip)
        );
        assert_eq!(
            format_of(FilePurpose::Scan, "scan/mesh.DRC"),
            Some(UploadFormat::Drc)
        );
        assert_eq!(
            format_of(FilePurpose::Webmodel, "web/scan-0.glb"),
            Some(UploadFormat::Glb)
        );
        assert_eq!(format_of(FilePurpose::Model, "models/a.obj"), None);
        assert_eq!(
            format_of(FilePurpose::Texture, "textures/a.jpeg"),
            Some(UploadFormat::Jpeg)
        );
        assert_eq!(format_of(FilePurpose::Texture, "textures/a.gif"), None);
        assert_eq!(
            format_of(FilePurpose::Script, "notes.md"),
            Some(UploadFormat::Text)
        );
    }

    #[test]
    fn ids_are_stable_per_job() {
        assert_eq!(seed_draft_id("job_a"), seed_draft_id("job_a"));
        assert_ne!(seed_draft_id("job_a"), seed_draft_id("job_b"));
        assert!(seed_draft_id("job_a").starts_with("d_"));
        let sha = "a".repeat(64);
        assert_eq!(seed_upload_id("job_a", &sha), seed_upload_id("job_a", &sha));
        assert_ne!(seed_upload_id("job_a", &sha), seed_upload_id("job_b", &sha));
        assert!(metaverse_core::ids::is_object_id(&seed_upload_id(
            "job_a", &sha
        )));
    }
}
