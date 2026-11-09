//! 草稿（设计 5.6）：追加操作、预览状态、发布。
//!
//! **追加**：在"基础版本 + 草稿已有结果"的工作状态上逐条检查范围并作用（地块路径下每个操作都要
//! 落在地块内，实体区路径只能改实体区），把结果区块写进 `draftChunks`、结果记录写进 `records`，
//! 草稿文档按 `rev` 条件保存（`rev` 加一，旧的预览令牌随之失效）。
//!
//! **发布**：
//! 1. 取 (baseSeq, head] 各次提交的变化，和草稿碰过的键（区块、物件、锚点）求交集；
//! 2. 没有交集：按最新的区域和地块重新校验全部操作的范围（影子重放），把草稿结果叠加到最新版本上；
//!    草稿新增的方块按最新的方块表分配正式编号，编号变了就改写草稿区块；
//! 3. 有交集：默认返回 409 并列出冲突的键；调用方要求时在最新版本上重放全部操作；
//! 4. 写提交（`head.seq` 条件），时间线又前进了就从第 1 步重来（最多 3 次）。
//!
//! 只是重新重建了实体区、草稿只改扩展层的情况不算冲突：区块的键带图层，重建层的物件
//! 编号也不会和扩展层相同。

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;

use metaverse_core::chunk::{Chunk, ChunkKey};
use metaverse_core::model::{
    ActorKind, Author, ChunkChange, Commit, DraftChunk, IdChange, Touched,
};
use metaverse_core::ops::{Op, OpError, PaletteBlock, TouchedSet};
use metaverse_core::record::{EntityBody, RecordKind};
use metaverse_core::replay::StateManifest;
use metaverse_core::scope::{AllowedArea, PathScope, ScopeError};
use metaverse_core::Timestamp;
use serde_json::{json, Value};

use super::palette::{assign_final_ids, palette_value, parse_palette};
use super::snapshot::{assemble, Audience};
use super::state::{check_scope_only, ops_cells, ApplyError, Workspace};
use super::views::SnapshotView;
use super::writer::{actor, attach_keyframe, commit, entity_asset_roles, entity_assets, record_of};
use crate::auth::{Caller, Grant};
use crate::error::ApiError;
use crate::repo::{
    AssetRole, CommitError, CommitOutcome, CommitPlan, DraftDoc, DraftStatus, OpsAsset, OpsRef,
    ProvisionalBlock, Repo, UnusableAsset, MISSING_ASSET,
};

/// 一个草稿最多的操作条数（内联 + 上传）。
pub const MAX_DRAFT_OPS: u64 = 100_000;
/// 草稿里内联操作的总字节数上限（超出提示改走上传）。
pub const MAX_INLINE_OPS_BYTES: usize = 4 * 1024 * 1024;
/// 提交里内联操作的上限（设计 5.2：约 1MB，超出就存成资源）。
pub const MAX_COMMIT_INLINE_OPS_BYTES: usize = 1024 * 1024;
/// ops 文件（可能 gzip 压缩）的大小上限：接口服务处理时整份读入内存。ops 用途的上传上限
/// `UPLOAD_MAX_OPS_BYTES` 不能超过它（配置校验），所以传得上去的文件都能应用。
pub const MAX_OPS_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// ops 文件解压后的大小上限。
pub const MAX_OPS_FILE_DECOMPRESSED: u64 = 256 * 1024 * 1024;
/// 发布时时间线前进导致重算的次数上限。
const PUBLISH_ATTEMPTS: usize = 3;
/// 一次内联追加（≤ 200 条）的计算量上限（格数）：单条操作最多 4M 格，200 条复制区域就是
/// 十几亿格的纯计算，一个请求就能占满接口服务的 CPU。
pub const MAX_APPEND_CELLS: u64 = 1 << 24;
/// 一个草稿全部操作的计算量上限（格数）：ops-from-upload 和发布时的重放都要把它们算一遍。
pub const MAX_DRAFT_CELLS: u64 = 1 << 26;
/// 一个草稿最多引用几个 ops 文件（预览、发布时每个都要重新解压解析）。
pub const MAX_DRAFT_OPS_REFS: usize = 20;

fn too_large(detail: impl Into<String>) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::PAYLOAD_TOO_LARGE,
        "request_too_large",
        detail.into(),
    )
}

/// 追加的操作从哪里来。
#[derive(Debug, Clone)]
pub enum OpsSource {
    Inline,
    Upload(String),
}

fn json_size<T: serde::Serialize>(value: &T) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

/// ops 文件一行的长度上限（字节）。
pub const MAX_OPS_LINE_BYTES: usize = 64 * 1024;

/// 解析 ops 文件：NDJSON（每行一个操作），可以 gzip 压缩。
///
/// 流式逐行解析：解压后的文本不整份留在内存里（只有压缩原文和解析出的操作），每行不超过
/// [`MAX_OPS_LINE_BYTES`]，解压后总共不超过 [`MAX_OPS_FILE_DECOMPRESSED`]。纯计算，调用方在
/// 阻塞线程上执行（[`parse_ops_file_blocking`]）。
pub fn parse_ops_file(bytes: &[u8], max_ops: u64) -> Result<Vec<Op>, String> {
    parse_ops_with_limit(bytes, max_ops, MAX_OPS_FILE_DECOMPRESSED)
}

fn parse_ops_with_limit(
    bytes: &[u8],
    max_ops: u64,
    max_decompressed: u64,
) -> Result<Vec<Op>, String> {
    use std::io::BufRead;
    let reader: Box<dyn Read + '_> = if bytes.starts_with(&[0x1f, 0x8b]) {
        Box::new(flate2::read::GzDecoder::new(bytes))
    } else {
        Box::new(bytes)
    };
    let mut reader = std::io::BufReader::new(reader.take(max_decompressed + 1));
    let mut ops = Vec::new();
    let mut line = Vec::new();
    let mut total = 0u64;
    let mut number = 0usize;
    loop {
        line.clear();
        number += 1;
        let read = (&mut reader)
            .take(MAX_OPS_LINE_BYTES as u64 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| "gzip 数据无法解压".to_owned())?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > max_decompressed {
            return Err(format!("解压后超过 {max_decompressed} 字节"));
        }
        if line.len() > MAX_OPS_LINE_BYTES {
            return Err(format!("第 {number} 行超过 {MAX_OPS_LINE_BYTES} 字节"));
        }
        let text =
            std::str::from_utf8(&line).map_err(|_| "ops 文件必须是 UTF-8 文本".to_owned())?;
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if ops.len() as u64 >= max_ops {
            return Err(format!("一个草稿最多 {max_ops} 条操作"));
        }
        let op: Op = serde_json::from_str(text)
            .map_err(|error| format!("第 {number} 行不是合法的操作：{error}"))?;
        ops.push(op);
    }
    Ok(ops)
}

/// 在阻塞线程上解析 ops 文件（解压、逐行解析都是纯计算，不能占着异步工作线程）。
pub async fn parse_ops_file_blocking(bytes: Vec<u8>, max_ops: u64) -> Result<Vec<Op>, String> {
    tokio::task::spawn_blocking(move || parse_ops_file(&bytes, max_ops))
        .await
        .map_err(|_| "解析操作文件的线程异常退出".to_owned())?
}

/// 把逐条解析的操作列表变成 `Op`，错误带下标。
pub fn parse_op_values(values: &[Value]) -> Result<Vec<Op>, ApiError> {
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            serde_json::from_value::<Op>(value.clone()).map_err(|error| {
                ApiError::new(
                    axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                    "invalid_op",
                    format!("第 {index} 条操作格式不对：{error}"),
                )
            })
        })
        .collect()
}

/// 当前区域和地块下，草稿范围允许修改的格子。
async fn allowed_area(
    repo: &Repo,
    grant: &Grant,
    scope: &PathScope,
) -> Result<AllowedArea, ApiError> {
    let space = repo.space(grant).await?.ok_or_else(ApiError::not_found)?;
    AllowedArea::for_scope(scope, &space.regions, &space.plots).map_err(|error| match error {
        ScopeError::UnknownPlot(_) => ApiError::conflict("草稿所属的地块已经不存在"),
        other => ApiError::invalid(other.to_string()),
    })
}

/// 草稿新增方块的临时定义。
fn provisional_list(
    blocks: &BTreeMap<String, (u16, metaverse_core::ops::BlockDef)>,
) -> Vec<ProvisionalBlock> {
    let mut list: Vec<ProvisionalBlock> = blocks
        .iter()
        .map(|(name, (id, block))| ProvisionalBlock {
            name: name.clone(),
            id: *id,
            block: block.clone(),
        })
        .collect();
    list.sort_by_key(|block| block.id);
    list
}

fn block_textures(block: &metaverse_core::ops::BlockDef, into: &mut BTreeSet<(String, AssetRole)>) {
    if let Some(texture) = &block.texture {
        for hash in [&texture.top, &texture.side, &texture.bottom] {
            into.insert((hash.clone(), AssetRole::Texture));
        }
    }
}

/// 给草稿追加操作并保存。返回保存后的草稿。
pub async fn append_ops(
    repo: &Repo,
    grant: &Grant,
    mut draft: DraftDoc,
    ops: Vec<Op>,
    source: OpsSource,
    now: Timestamp,
) -> Result<DraftDoc, ApplyError> {
    if draft.status != DraftStatus::Open {
        return Err(ApiError::conflict("草稿已经发布，不能再追加操作").into());
    }
    if ops.is_empty() {
        return Err(ApiError::invalid("没有要追加的操作").into());
    }
    if draft.op_count() + ops.len() as u64 > MAX_DRAFT_OPS {
        return Err(too_large(format!("一个草稿最多 {MAX_DRAFT_OPS} 条操作")).into());
    }
    if matches!(source, OpsSource::Inline)
        && json_size(&draft.ops) + json_size(&ops) > MAX_INLINE_OPS_BYTES
    {
        return Err(too_large(
            "草稿里内联的操作已超过 4MB，请把操作写成 NDJSON 文件分片上传，再调用 ops-from-upload",
        )
        .into());
    }
    if matches!(source, OpsSource::Upload(_)) && draft.ops_refs.len() >= MAX_DRAFT_OPS_REFS {
        return Err(too_large(format!(
            "一个草稿最多引用 {MAX_DRAFT_OPS_REFS} 个操作文件，请合并成更大的文件或另建草稿"
        ))
        .into());
    }
    // 计算量：先按几何算好，超出上限就不开始算。
    let cells = ops_cells(&ops);
    if matches!(source, OpsSource::Inline) && cells > MAX_APPEND_CELLS {
        return Err(too_large(format!(
            "这一批操作要处理 {cells} 格，超过单次追加的上限 {MAX_APPEND_CELLS} 格；请拆成几批，或把操作写成文件走 ops-from-upload"
        ))
        .into());
    }
    if draft.work_cells.saturating_add(cells) > MAX_DRAFT_CELLS {
        return Err(too_large(format!(
            "草稿的操作累计要处理超过 {MAX_DRAFT_CELLS} 格（发布时可能要全部重放），请先发布这个草稿，再建新草稿继续"
        ))
        .into());
    }
    let area = allowed_area(repo, grant, &draft.scope).await?;
    let mut workspace = Workspace::for_draft(repo, grant, &draft).await?;
    let touched = workspace.apply_ops(repo, grant, &ops, &area, 0).await?;

    // 结果区块。
    let mut results: BTreeMap<ChunkKey, String> = draft
        .result_chunks
        .iter()
        .map(|c| {
            (
                ChunkKey {
                    layer: c.layer,
                    cx: c.cx,
                    cy: c.cy,
                    cz: c.cz,
                },
                c.hash.clone(),
            )
        })
        .collect();
    let mut new_chunks = Vec::new();
    for key in &touched.chunks {
        match workspace.chunk_result(key) {
            Some((hash, data)) => {
                results.insert(*key, hash.clone());
                new_chunks.push((hash, data));
            }
            None => {
                results.remove(key);
            }
        }
    }
    // 结果记录。
    let mut records = Vec::new();
    let mut assets: BTreeSet<(String, AssetRole)> = BTreeSet::new();
    let mut entity_results: BTreeMap<String, Option<String>> = draft
        .result_entities
        .iter()
        .map(|c| (c.id.clone(), c.hash.clone()))
        .collect();
    for id in &touched.entities {
        let hash = match workspace.state.entities.get(id) {
            Some(body) => {
                entity_asset_roles(body, &mut assets);
                let (hash, value) = record_of(RecordKind::Entity, grant.space_id(), body)?;
                records.push((hash.clone(), "entity", value));
                Some(hash)
            }
            None => None,
        };
        entity_results.insert(id.clone(), hash);
    }
    let mut anchor_results: BTreeMap<String, Option<String>> = draft
        .result_anchors
        .iter()
        .map(|c| (c.id.clone(), c.hash.clone()))
        .collect();
    for id in &touched.anchors {
        let hash = match workspace.state.anchors.get(id) {
            Some(body) => {
                let (hash, value) = record_of(RecordKind::Anchor, grant.space_id(), body)?;
                records.push((hash.clone(), "anchor", value));
                Some(hash)
            }
            None => None,
        };
        anchor_results.insert(id.clone(), hash);
    }
    let provisional = provisional_list(&workspace.state.provisional_blocks);
    for block in &provisional {
        block_textures(&block.block, &mut assets);
    }
    // 物件模型和贴图只能按用途引用本空间的资源（发布后登记到 assetRefs、公开可读）：物件模型
    // 必须是 model_import 处理后的版本，贴图必须是贴图。这一批碰过的物件和新增方块都重新检查
    // （同一个哈希以前按别的用途引用过也一样）。
    let wanted: Vec<(String, AssetRole)> = assets.iter().cloned().collect();
    let unusable = repo.unusable_assets(grant, &wanted).await?;
    if !unusable.is_empty() {
        return Err(ApiError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "unknown_asset",
            format!(
                "引用的资源不能这样用：{}",
                unusable
                    .iter()
                    .map(UnusableAsset::describe)
                    .collect::<Vec<_>>()
                    .join("；")
            ),
        )
        .into());
    }
    let new_assets: Vec<String> = assets.into_iter().map(|(hash, _)| hash).collect();
    // 清理的栅栏（处理服务 `jobs/cleanup.py`）：写下记录（`body.assetHash` / `textures`）和草稿
    // （`assets`、`opsRefs`）这些引用之前，先刷新这一批引用的全部资源的 touchedAt 并确认都还在。
    // 刷新之后清理的条件删除就删不掉它们；刷新不到说明刚被清理删掉，整批不生效，让调用方重新上传。
    let mut fenced = new_assets.clone();
    if let OpsSource::Upload(hash) = &source {
        fenced.push(hash.clone());
    }
    let gone = repo.touch_assets(grant, &fenced).await?;
    if !gone.is_empty() {
        tracing::info!(space = %grant.space_id(), draft = %draft.id, assets = ?gone, "追加时引用的资源刚被清理");
        let describe = |hash: &String| match &source {
            OpsSource::Upload(file) if file == hash => format!("操作文件 {hash}：{MISSING_ASSET}"),
            _ => format!("{hash}：{MISSING_ASSET}"),
        };
        return Err(ApiError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "unknown_asset",
            format!(
                "引用的资源不能这样用：{}",
                gone.iter().map(describe).collect::<Vec<_>>().join("；")
            ),
        )
        .into());
    }

    repo.put_draft_chunks(grant, &draft.id, &new_chunks, draft.expires_at)
        .await?;
    repo.put_records(grant, &records).await?;

    let expected_rev = draft.rev;
    let mut all_touched = TouchedSet {
        chunks: draft.touched.chunks.iter().copied().collect(),
        entities: draft.touched.entities.iter().cloned().collect(),
        anchors: draft.touched.anchors.iter().cloned().collect(),
        palette: draft.touched.palette,
        scan: draft.touched.scan,
        rebuilt_layer: draft.touched.rebuilt_layer,
        ..TouchedSet::default()
    };
    all_touched.merge(touched);
    draft.touched = Touched {
        regions: false,
        plots: false,
        ..all_touched.to_model()
    };
    draft.result_chunks = results
        .into_iter()
        .map(|(key, hash)| DraftChunk {
            layer: key.layer,
            cx: key.cx,
            cy: key.cy,
            cz: key.cz,
            hash,
        })
        .collect();
    draft.result_entities = entity_results
        .into_iter()
        .map(|(id, hash)| IdChange { id, hash })
        .collect();
    draft.result_anchors = anchor_results
        .into_iter()
        .map(|(id, hash)| IdChange { id, hash })
        .collect();
    draft.provisional_blocks = provisional;
    draft.assets.extend(new_assets);
    draft.assets.sort();
    draft.assets.dedup();
    match source {
        OpsSource::Inline => draft.ops.extend(ops),
        OpsSource::Upload(asset_hash) => draft.ops_refs.push(OpsRef {
            asset_hash,
            after: draft.ops.len() as u64,
            count: ops.len() as u64,
        }),
    }
    draft.work_cells = draft.work_cells.saturating_add(cells);
    draft.rev += 1;
    draft.updated_at = now;
    if !repo.save_draft(grant, &draft, expected_rev).await? {
        return Err(ApiError::conflict("草稿在处理期间被修改或已发布，请重新读取后再试").into());
    }
    Ok(draft)
}

/// 草稿的全部操作（内联操作和上传的操作按追加顺序穿插）。
pub async fn draft_ops(repo: &Repo, grant: &Grant, draft: &DraftDoc) -> Result<Vec<Op>, ApiError> {
    let mut refs: Vec<&OpsRef> = draft.ops_refs.iter().collect();
    refs.sort_by_key(|r| r.after);
    let mut ops = Vec::with_capacity(draft.op_count() as usize);
    let mut inline = draft.ops.iter();
    let mut taken = 0u64;
    for reference in refs {
        while taken < reference.after {
            match inline.next() {
                Some(op) => ops.push(op.clone()),
                None => break,
            }
            taken += 1;
        }
        let bytes = match repo
            .read_ops_asset(grant, &reference.asset_hash, MAX_OPS_FILE_BYTES)
            .await?
        {
            OpsAsset::Bytes(bytes) => bytes,
            OpsAsset::Missing => {
                return Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "asset_gone",
                    format!(
                        "草稿引用的操作文件 {} 已经被清理，请重新上传同一个文件（哈希不变）后再试",
                        reference.asset_hash
                    ),
                ))
            }
            OpsAsset::TooLarge(_) => {
                return Err(ApiError::conflict(format!(
                    "草稿引用的操作文件 {} 已经不可用",
                    reference.asset_hash
                )))
            }
        };
        let parsed = parse_ops_file_blocking(bytes, MAX_DRAFT_OPS)
            .await
            .map_err(|error| {
                tracing::error!(asset = %reference.asset_hash, error = %error, "草稿引用的操作文件无法解析");
                ApiError::internal()
            })?;
        ops.extend(parsed);
    }
    ops.extend(inline.cloned());
    Ok(ops)
}

/// 草稿叠加到基础版本上的状态清单。
fn draft_manifest(base: &StateManifest, draft: &DraftDoc) -> StateManifest {
    let mut manifest = base.clone();
    let results: BTreeMap<ChunkKey, &String> = draft
        .result_chunks
        .iter()
        .map(|c| {
            (
                ChunkKey {
                    layer: c.layer,
                    cx: c.cx,
                    cy: c.cy,
                    cz: c.cz,
                },
                &c.hash,
            )
        })
        .collect();
    for key in &draft.touched.chunks {
        match results.get(key) {
            Some(hash) => manifest.chunks.insert(*key, (*hash).clone()),
            None => manifest.chunks.remove(key),
        };
    }
    for (map, changes) in [
        (&mut manifest.entities, &draft.result_entities),
        (&mut manifest.anchors, &draft.result_anchors),
    ] {
        for change in changes {
            match &change.hash {
                Some(hash) => map.insert(change.id.clone(), hash.clone()),
                None => map.remove(&change.id),
            };
        }
    }
    manifest
}

/// 预览：基础版本叠加草稿结果，按公开接口的规则投影（只显示公开锚点）。
pub async fn preview_snapshot(
    repo: &Repo,
    grant: &Grant,
    draft: &DraftDoc,
) -> Result<SnapshotView, ApiError> {
    let base = repo.manifest_at(grant, draft.base_seq).await?;
    let manifest = draft_manifest(&base, draft);
    let extra: Vec<PaletteBlock> = draft
        .provisional_blocks
        .iter()
        .map(|block| PaletteBlock {
            id: block.id,
            name: block.name.clone(),
            kind: block.block.kind,
            color: block.block.color,
            texture: block.block.texture.clone(),
            tags: block.block.tags.clone(),
        })
        .collect();
    let draft_anchors: std::collections::BTreeSet<String> = draft
        .result_anchors
        .iter()
        .map(|change| change.id.clone())
        .collect();
    assemble(
        repo,
        grant,
        draft.base_seq,
        draft.updated_at,
        &manifest,
        &extra,
        &draft_anchors,
        Audience::Preview,
    )
    .await
}

/// 发布选项。
#[derive(Debug, Clone, Default)]
pub struct PublishOptions {
    pub message: String,
    /// 有冲突时在最新版本上重放草稿的全部操作。
    pub replay: bool,
    /// 调用方看到的草稿版本；给了就必须一致。
    pub expected_rev: Option<u64>,
    pub observed_at: Option<Timestamp>,
    pub script_ref: Option<String>,
}

/// 发布失败的原因。
#[derive(Debug)]
pub enum PublishError {
    Api(ApiError),
    /// 与 (baseSeq, head] 的变化有交集。
    Conflicts {
        keys: Vec<String>,
        head_seq: u64,
    },
    /// 按最新的区域和地块，操作超出了草稿范围。
    OutOfScope(OpError),
    /// 在最新版本上重放失败。
    ReplayFailed(OpError),
    /// 草稿或提交引用的资源已经被处理服务的定期清理删掉（升序去重的哈希）。重新上传同一内容
    /// （哈希不变）后可以再发布。
    AssetsGone(Vec<String>),
}

impl From<ApiError> for PublishError {
    fn from(error: ApiError) -> Self {
        PublishError::Api(error)
    }
}

impl From<crate::repo::RepoError> for PublishError {
    fn from(error: crate::repo::RepoError) -> Self {
        PublishError::Api(error.into())
    }
}

fn chunk_key_text(key: &ChunkKey) -> String {
    let layer = match key.layer {
        metaverse_core::model::Layer::Rebuilt => "rebuilt",
        metaverse_core::model::Layer::Ext => "ext",
    };
    format!("chunk:{layer}:{},{},{}", key.cx, key.cy, key.cz)
}

/// 草稿碰过的键与 (baseSeq, head] 的变化的交集。
fn conflict_keys(draft: &DraftDoc, commits: &[Commit]) -> Vec<String> {
    let mut chunks = BTreeSet::new();
    let mut entities = BTreeSet::new();
    let mut anchors = BTreeSet::new();
    for commit in commits {
        for change in &commit.changed_chunks {
            chunks.insert(ChunkKey {
                layer: change.layer,
                cx: change.cx,
                cy: change.cy,
                cz: change.cz,
            });
        }
        entities.extend(commit.changed_entities.iter().map(|c| c.id.clone()));
        anchors.extend(commit.changed_anchors.iter().map(|c| c.id.clone()));
    }
    let mut keys: Vec<String> = draft
        .touched
        .chunks
        .iter()
        .filter(|key| chunks.contains(key))
        .map(chunk_key_text)
        .collect();
    keys.extend(
        draft
            .touched
            .entities
            .iter()
            .filter(|id| entities.contains(*id))
            .map(|id| format!("entity:{id}")),
    );
    keys.extend(
        draft
            .touched
            .anchors
            .iter()
            .filter(|id| anchors.contains(*id))
            .map(|id| format!("anchor:{id}")),
    );
    keys
}

/// 发布结果在最新版本上的变化（区块、记录、方块表）。
struct Changes {
    chunks: Vec<ChunkChange>,
    chunk_data: Vec<(String, Vec<u8>)>,
    entities: Vec<IdChange>,
    anchors: Vec<IdChange>,
    entity_bodies: BTreeMap<String, Value>,
    anchor_bodies: BTreeMap<String, Value>,
    records: Vec<(String, &'static str, Value)>,
    new_blocks: Vec<PaletteBlock>,
    assets: BTreeSet<String>,
}

fn id_diff(head: &BTreeMap<String, String>, id: &str, result: Option<&String>) -> Option<IdChange> {
    (head.get(id) != result).then(|| IdChange {
        id: id.to_owned(),
        hash: result.cloned(),
    })
}

fn remap_chunk(data: &[u8], mapping: &BTreeMap<u16, u16>) -> Result<(String, Vec<u8>), ApiError> {
    let mut chunk = Chunk::decompress(data).map_err(|_| ApiError::internal())?;
    for cell in chunk.cells_mut() {
        if let Some(final_id) = mapping.get(cell) {
            *cell = *final_id;
        }
    }
    Ok((chunk.hash(), chunk.compress()))
}

/// 没有冲突：把草稿结果叠加到最新版本上。
async fn overlay_changes(
    repo: &Repo,
    grant: &Grant,
    draft: &DraftDoc,
    head: &StateManifest,
    head_palette: &[PaletteBlock],
) -> Result<Changes, PublishError> {
    let (new_blocks, mapping) =
        assign_final_ids(head_palette, &draft.provisional_blocks).map_err(|names| {
            PublishError::Conflicts {
                keys: names.into_iter().map(|n| format!("palette:{n}")).collect(),
                head_seq: 0,
            }
        })?;
    let remap: BTreeMap<u16, u16> = mapping.into_iter().filter(|(a, b)| a != b).collect();
    let results: BTreeMap<ChunkKey, &String> = draft
        .result_chunks
        .iter()
        .map(|c| {
            (
                ChunkKey {
                    layer: c.layer,
                    cx: c.cx,
                    cy: c.cy,
                    cz: c.cz,
                },
                &c.hash,
            )
        })
        .collect();
    let hashes: Vec<&str> = results.values().map(|h| h.as_str()).collect();
    let stored = repo.draft_chunk_data(grant, &draft.id, &hashes).await?;
    let mut changes = Changes {
        chunks: Vec::new(),
        chunk_data: Vec::new(),
        entities: Vec::new(),
        anchors: Vec::new(),
        entity_bodies: BTreeMap::new(),
        anchor_bodies: BTreeMap::new(),
        records: Vec::new(),
        new_blocks,
        assets: BTreeSet::new(),
    };
    for key in &draft.touched.chunks {
        let result = match results.get(key) {
            Some(hash) => {
                let data = stored.get(*hash).ok_or_else(|| {
                    tracing::error!(draft = %draft.id, chunk = %hash, "草稿区块不存在");
                    ApiError::internal()
                })?;
                Some(if remap.is_empty() {
                    ((*hash).clone(), data.clone())
                } else {
                    remap_chunk(data, &remap)?
                })
            }
            None => None,
        };
        let hash = result.as_ref().map(|(hash, _)| hash.clone());
        if head.chunks.get(key) != hash.as_ref() {
            changes.chunks.push(ChunkChange {
                layer: key.layer,
                cx: key.cx,
                cy: key.cy,
                cz: key.cz,
                hash,
            });
            if let Some(result) = result {
                changes.chunk_data.push(result);
            }
        }
    }
    for change in &draft.result_entities {
        if let Some(diff) = id_diff(&head.entities, &change.id, change.hash.as_ref()) {
            changes.entities.push(diff);
        }
    }
    for change in &draft.result_anchors {
        if let Some(diff) = id_diff(&head.anchors, &change.id, change.hash.as_ref()) {
            changes.anchors.push(diff);
        }
    }
    let wanted: Vec<&str> = changes
        .entities
        .iter()
        .chain(changes.anchors.iter())
        .filter_map(|c| c.hash.as_deref())
        .collect();
    let bodies = repo.record_bodies(grant, &wanted).await?;
    for (list, out, is_entity) in [
        (&changes.entities, &mut changes.entity_bodies, true),
        (&changes.anchors, &mut changes.anchor_bodies, false),
    ] {
        for change in list {
            if let Some(hash) = &change.hash {
                let body = bodies.get(hash).ok_or_else(|| {
                    tracing::error!(record = %hash, "草稿结果记录不存在");
                    ApiError::internal()
                })?;
                if is_entity {
                    if let Ok(entity) = serde_json::from_value::<EntityBody>(body.clone()) {
                        entity_assets(&entity, &mut changes.assets);
                    }
                }
                out.insert(change.id.clone(), body.clone());
            }
        }
    }
    Ok(changes)
}

/// 有冲突且调用方要求：在最新版本上重放全部操作。
async fn replay_changes(
    repo: &Repo,
    grant: &Grant,
    draft: &DraftDoc,
    head_seq: u64,
    area: &AllowedArea,
) -> Result<Changes, PublishError> {
    let ops = draft_ops(repo, grant, draft).await?;
    // 旧草稿没有记录计算量：按实际操作再核对一次总量。
    let cells = ops_cells(&ops);
    if cells > MAX_DRAFT_CELLS {
        return Err(ApiError::new(
            axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            "replay_too_large",
            format!("重放这个草稿要处理 {cells} 格，超过上限 {MAX_DRAFT_CELLS} 格；请不带 replay 解决冲突，或把改动拆成几个草稿"),
        )
        .into());
    }
    let mut workspace = Workspace::at_seq(repo, grant, head_seq).await?;
    let touched = match workspace.apply_ops(repo, grant, &ops, area, 0).await {
        Ok(touched) => touched,
        Err(ApplyError::Api(error)) => return Err(error.into()),
        Err(ApplyError::Op(error @ OpError::Scope { .. })) => {
            return Err(PublishError::OutOfScope(error))
        }
        Err(ApplyError::Op(error)) => return Err(PublishError::ReplayFailed(error)),
    };
    let head = workspace.manifest.clone();
    let mut changes = Changes {
        chunks: Vec::new(),
        chunk_data: Vec::new(),
        entities: Vec::new(),
        anchors: Vec::new(),
        entity_bodies: BTreeMap::new(),
        anchor_bodies: BTreeMap::new(),
        records: Vec::new(),
        new_blocks: Vec::new(),
        assets: BTreeSet::new(),
    };
    for key in &touched.chunks {
        let result = workspace.chunk_result(key);
        let hash = result.as_ref().map(|(hash, _)| hash.clone());
        if head.chunks.get(key) != hash.as_ref() {
            changes.chunks.push(ChunkChange {
                layer: key.layer,
                cx: key.cx,
                cy: key.cy,
                cz: key.cz,
                hash,
            });
            if let Some(result) = result {
                changes.chunk_data.push(result);
            }
        }
    }
    for id in &touched.entities {
        let result = match workspace.state.entities.get(id) {
            Some(body) => {
                let (hash, value) = record_of(RecordKind::Entity, grant.space_id(), body)?;
                Some((hash, value, body))
            }
            None => None,
        };
        if let Some(diff) = id_diff(&head.entities, id, result.as_ref().map(|(h, _, _)| h)) {
            if let Some((hash, value, body)) = result {
                entity_assets(body, &mut changes.assets);
                changes.records.push((hash, "entity", value.clone()));
                changes.entity_bodies.insert(id.clone(), value);
            }
            changes.entities.push(diff);
        }
    }
    for id in &touched.anchors {
        let result = match workspace.state.anchors.get(id) {
            Some(body) => Some(record_of(RecordKind::Anchor, grant.space_id(), body)?),
            None => None,
        };
        if let Some(diff) = id_diff(&head.anchors, id, result.as_ref().map(|(h, _)| h)) {
            if let Some((hash, value)) = result {
                changes.records.push((hash, "anchor", value.clone()));
                changes.anchor_bodies.insert(id.clone(), value);
            }
            changes.anchors.push(diff);
        }
    }
    // 重放时新增方块的编号是按最新方块表分配的，就是正式编号。
    changes.new_blocks = provisional_list(&workspace.state.provisional_blocks)
        .into_iter()
        .map(|block| PaletteBlock {
            id: block.id,
            name: block.name,
            kind: block.block.kind,
            color: block.block.color,
            texture: block.block.texture,
            tags: block.block.tags,
        })
        .collect();
    Ok(changes)
}

/// 发布时附带的 `scriptRef`：必须是本空间的脚本资源（script 用途上传并经处理服务校验，
/// `metadata.kind = script`）。提交引用它，清理就不会删它，所以不能拿别的空间的资源或不存在的
/// 哈希充数。
async fn check_script_ref(repo: &Repo, grant: &Grant, hash: &str) -> Result<(), ApiError> {
    let reason = match repo.space_owned_asset(grant, hash).await? {
        Some(meta) if meta.kind.as_deref() == Some("script") => return Ok(()),
        Some(_) => "不是脚本（只能引用 script 用途上传的资源）".to_owned(),
        None => format!("{MISSING_ASSET}，或不属于本空间"),
    };
    Err(ApiError::new(
        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        "unknown_asset",
        format!("scriptRef {hash}：{reason}"),
    ))
}

/// 草稿操作在提交里的存法：内联（≤ 1MB）、原上传文件，或者合并写成一个 NDJSON 资源。
async fn commit_ops(
    repo: &Repo,
    grant: &Grant,
    draft: &DraftDoc,
) -> Result<(Option<Vec<Op>>, Option<String>), ApiError> {
    if draft.ops_refs.is_empty() && json_size(&draft.ops) <= MAX_COMMIT_INLINE_OPS_BYTES {
        return Ok((Some(draft.ops.clone()), None));
    }
    if draft.ops.is_empty() && draft.ops_refs.len() == 1 {
        return Ok((None, Some(draft.ops_refs[0].asset_hash.clone())));
    }
    let ops = draft_ops(repo, grant, draft).await?;
    let mut ndjson = Vec::new();
    for op in &ops {
        serde_json::to_writer(&mut ndjson, op).map_err(|_| ApiError::internal())?;
        ndjson.push(b'\n');
    }
    let hash = repo
        .put_asset_bytes(grant, &ndjson, "application/x-ndjson", "ops")
        .await?;
    Ok((None, Some(hash)))
}

/// 发布草稿（设计 5.6）。成功后草稿标记为已发布，预览令牌和草稿区块作废。
pub async fn publish(
    repo: &Repo,
    grant: &Grant,
    caller: &Caller,
    draft: &DraftDoc,
    options: &PublishOptions,
    now: Timestamp,
) -> Result<CommitOutcome, PublishError> {
    if draft.status != DraftStatus::Open {
        return Err(ApiError::conflict(format!(
            "草稿已经发布（提交 {}）",
            draft.commit_id.as_deref().unwrap_or("?")
        ))
        .into());
    }
    if options.expected_rev.is_some_and(|rev| rev != draft.rev) {
        return Err(ApiError::conflict("草稿已经被修改，请重新读取后再发布").into());
    }
    if draft.op_count() == 0 {
        return Err(ApiError::invalid("草稿里还没有任何操作").into());
    }
    if let Some(script) = &options.script_ref {
        check_script_ref(repo, grant, script).await?;
    }
    // 事务前先确认一次：草稿引用的操作文件和脚本都还在（并刷新 touchedAt），缺了就不必算下去。
    // 物件模型、贴图由提交事务里的栅栏确认（见 `Repo::write_commit`）。
    let mut fenced: Vec<String> = draft
        .ops_refs
        .iter()
        .map(|reference| reference.asset_hash.clone())
        .collect();
    fenced.extend(options.script_ref.iter().cloned());
    let gone = repo.touch_assets(grant, &fenced).await?;
    if !gone.is_empty() {
        return Err(PublishError::AssetsGone(gone));
    }
    let (ops, ops_ref) = commit_ops(repo, grant, draft).await?;
    let kind = match draft.scope {
        PathScope::Plot(_) => ActorKind::Plot,
        _ => ActorKind::Physical,
    };
    for _ in 0..PUBLISH_ATTEMPTS {
        let space = repo.space(grant).await?.ok_or_else(ApiError::not_found)?;
        let head_seq = space.head.seq;
        let area = AllowedArea::for_scope(&draft.scope, &space.regions, &space.plots).map_err(
            |error| match error {
                ScopeError::UnknownPlot(_) => {
                    PublishError::Api(ApiError::conflict("草稿所属的地块已经不存在"))
                }
                other => PublishError::Api(ApiError::invalid(other.to_string())),
            },
        )?;
        let commits = repo
            .commits_between(grant, draft.base_seq, head_seq)
            .await?;
        let conflicts = conflict_keys(draft, &commits);
        let head_manifest = repo.manifest_at(grant, head_seq).await?;
        let head_palette = parse_palette(
            &repo
                .palette_blocks(grant, head_manifest.palette_hash.as_deref())
                .await?,
        )
        .map_err(|_| ApiError::internal())?;
        let changes = if conflicts.is_empty() {
            // 按最新的区域和地块重新校验全部操作（影子重放，不碰区块）。
            let ops = draft_ops(repo, grant, draft).await?;
            let mut base = Workspace::at_seq(repo, grant, draft.base_seq).await?;
            check_scope_only(&mut base.state, &ops, &area).map_err(|error| match error {
                OpError::Scope { .. } => PublishError::OutOfScope(error),
                other => PublishError::ReplayFailed(other),
            })?;
            match overlay_changes(repo, grant, draft, &head_manifest, &head_palette).await {
                // 新增方块与最新方块表重名：同样按冲突处理。
                Err(PublishError::Conflicts { .. }) if options.replay => {
                    replay_changes(repo, grant, draft, head_seq, &area).await?
                }
                Err(PublishError::Conflicts { keys, .. }) => {
                    return Err(PublishError::Conflicts { keys, head_seq })
                }
                other => other?,
            }
        } else if options.replay {
            replay_changes(repo, grant, draft, head_seq, &area).await?
        } else {
            return Err(PublishError::Conflicts {
                keys: conflicts,
                head_seq,
            });
        };

        repo.put_chunks(grant, &changes.chunk_data, now).await?;
        repo.put_records(grant, &changes.records).await?;
        let mut plan = CommitPlan::new(
            head_seq,
            actor(caller, draft.scope.clone(), kind),
            options.message.clone(),
        );
        if draft.created_by.sub != caller.subject {
            plan.author = Some(Author {
                sub: draft.created_by.sub.clone(),
            });
        }
        plan.observed_at = options.observed_at;
        plan.script_ref = options.script_ref.clone();
        plan.draft_id = Some(draft.id.clone());
        plan.draft_rev = Some(draft.rev);
        plan.ops = ops.clone();
        plan.ops_ref = ops_ref.clone();
        plan.changed_chunks = changes.chunks;
        plan.changed_entities = changes.entities;
        plan.changed_anchors = changes.anchors;
        plan.entity_bodies = changes.entity_bodies;
        plan.anchor_bodies = changes.anchor_bodies;
        let mut assets = changes.assets;
        if !changes.new_blocks.is_empty() {
            let mut blocks = head_palette.clone();
            for block in &changes.new_blocks {
                if let Some(texture) = &block.texture {
                    assets.insert(texture.top.clone());
                    assets.insert(texture.side.clone());
                    assets.insert(texture.bottom.clone());
                }
            }
            blocks.extend(changes.new_blocks);
            plan.palette_hash = Some(repo.put_palette(grant, &palette_value(&blocks)).await?);
        }
        plan.asset_refs = assets.into_iter().collect();
        attach_keyframe(repo, grant, &mut plan, &head_manifest).await?;
        match commit(repo, grant, &plan, now).await {
            Ok(outcome) => {
                if let Err(error) = repo.clear_published_draft(grant, &draft.id).await {
                    // 提交和草稿状态已经写成；预览令牌和草稿区块留给过期清理。
                    tracing::warn!(space = %grant.space_id(), draft = %draft.id, error = %error, "清理已发布草稿的预览和区块失败");
                }
                return Ok(outcome);
            }
            Err(CommitError::HeadMoved) => continue,
            Err(CommitError::DraftChanged) => {
                return Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "draft_changed",
                    "草稿在发布期间被追加、丢弃或已被发布；请重新读取草稿后再发布",
                )
                .into())
            }
            Err(CommitError::Missing) => return Err(ApiError::not_found().into()),
            Err(CommitError::AssetsGone(gone)) => return Err(PublishError::AssetsGone(gone)),
            Err(CommitError::Repo(error)) => return Err(error.into()),
        }
    }
    Err(ApiError::conflict("时间线前进太快，发布没能完成，请重试").into())
}

/// ops-from-upload 的后台处理结果（任务的 `result`）。
pub fn ops_job_result(draft: &DraftDoc, applied: usize) -> Value {
    json!({
        "draftId": draft.id,
        "rev": draft.rev,
        "opsApplied": applied,
        "opsTotal": draft.op_count(),
        "touched": {
            "chunks": draft.touched.chunks.len(),
            "entities": draft.touched.entities.len(),
            "anchors": draft.touched.anchors.len(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn ops_files_are_ndjson_optionally_gzipped() {
        let text = "{\"op\":\"fill\",\"box\":[0,0,0,1,1,1],\"block\":2}\n\n{\"op\":\"removeAnchor\",\"anchorId\":\"t1\"}\n";
        assert_eq!(parse_ops_file(text.as_bytes(), 10).unwrap().len(), 2);
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(text.as_bytes()).unwrap();
        let gz = encoder.finish().unwrap();
        assert_eq!(parse_ops_file(&gz, 10).unwrap().len(), 2);
        assert!(parse_ops_file(text.as_bytes(), 1).is_err());
        let error = parse_ops_file(b"{\"op\":\"explode\"}", 10).unwrap_err();
        assert!(error.contains("第 1 行"), "{error}");
        assert!(parse_ops_file(&[0xff, 0xfe], 10).is_err());
        // 行太长、解压后太大都拒绝（流式解析，不整份解压进内存）。
        let long = format!("{}\n", " ".repeat(MAX_OPS_LINE_BYTES + 10));
        assert!(parse_ops_file(long.as_bytes(), 10)
            .unwrap_err()
            .contains("超过"));
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(text.as_bytes()).unwrap();
        encoder.write_all(&vec![b'\n'; 4 << 20]).unwrap();
        let bomb = encoder.finish().unwrap();
        assert!(bomb.len() < 64 << 10, "压缩后很小");
        assert!(parse_ops_with_limit(&bomb, 10, 1 << 20)
            .unwrap_err()
            .contains("解压后超过"));
        assert_eq!(parse_ops_with_limit(&bomb, 10, 8 << 20).unwrap().len(), 2);
    }

    #[test]
    fn chunk_remap_changes_hash_only_when_needed() {
        let mut chunk = Chunk::empty();
        chunk.set(0, 0, 0, 30).unwrap();
        chunk.set(1, 0, 0, 2).unwrap();
        let data = chunk.compress();
        let (hash, remapped) = remap_chunk(&data, &BTreeMap::from([(30, 31)])).unwrap();
        let back = Chunk::decompress(&remapped).unwrap();
        assert_eq!(back.get(0, 0, 0).unwrap(), 31);
        assert_eq!(back.get(1, 0, 0).unwrap(), 2);
        assert_eq!(hash, back.hash());
        assert_ne!(hash, chunk.hash());
    }
}
