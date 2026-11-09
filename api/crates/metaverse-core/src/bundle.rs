//! 重建包清单（docs/SHAPES.md 第 7 节，docs/design/server-slim.md 6.2–6.4）。
//!
//! 清单与托管位置无关：只有相对路径、用途、sha256、大小，不写任何下载地址；同一个包在本地、
//! 命令行推送和部署种子里是同一份字节、同一个哈希。
//!
//! **解析方式是"外层带类型、记录逐条"**：`rebuilt.templates`、`rebuilt.entities`、`anchors` 先解析成
//! 原始 JSON 片段（[`RawValue`]，借用清单原文，不展开），再一条一条解析成记录、校验；展开成操作时
//! 再逐条解析一遍，交给回调。内存里不会出现整份清单的通用 JSON 树，同时留在内存里的只有本包的模板。
//!
//! [`Bundle::parse`] 做 6.3 的全部校验（文件表、引用、每条记录按 SHAPES），[`Bundle::for_each_op`]
//! 按 6.4 展开成操作。展开只在 Rust 实现：接口服务的交包和部署种子共用；命令行（TypeScript）只做
//! 结构校验，本地工具（Python）只在生成时守住上限。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};

use crate::canonical::canonical_json_of;
use crate::ids::{is_object_id, is_space_id, SPACE_ANCHOR_ID};
use crate::is_sha256_hex;
use crate::limits::{UploadLimits, MAX_RECORD_BYTES};
use crate::model::Layer;
use crate::ops::{Op, ScanSpec};
use crate::record::{is_rebuilt_id, AnchorBody, EntityBody, EntityKind, REBUILT_ID_PREFIX};
use crate::scope::UploadPurpose;
use crate::shape::{Shape, TemplateSource};
use crate::Timestamp;

/// 清单的 `format`。
pub const BUNDLE_FORMAT: &str = "chrono-metaverse-rebuild-bundle";
/// 清单的 `version`。以后加字段就升版本：不认识的字段一律拒绝。
pub const BUNDLE_VERSION: u64 = 1;
/// 物件、模板、锚点、`remove`、文件的个数上限。
pub const MAX_BUNDLE_ENTITIES: usize = 2000;
pub const MAX_BUNDLE_TEMPLATES: usize = 200;
pub const MAX_BUNDLE_ANCHORS: usize = 2000;
pub const MAX_BUNDLE_REMOVE: usize = 2000;
pub const MAX_BUNDLE_FILES: usize = 4096;
/// `files[].path` 的字符数上限。
pub const MAX_FILE_PATH_CHARS: usize = 200;
/// `note` 的字符数上限（规则同提交说明）。
pub const MAX_NOTE_CHARS: usize = 2000;
/// `tool.name`、`tool.version` 的字符数上限。
pub const MAX_TOOL_TEXT_CHARS: usize = 64;
/// `report` 规范化后的字节数上限。
pub const MAX_REPORT_BYTES: usize = 64 * 1024;
/// `report` 原文（可能带缩进）超过这个字节数就不解析，直接拒绝。
const MAX_REPORT_RAW_BYTES: usize = 1024 * 1024;

/// 清单不合规：出错的字段（JSON 路径）和说明。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{field}：{message}")]
pub struct BundleError {
    pub field: String,
    pub message: String,
}

fn fail<T>(field: impl Into<String>, message: impl Into<String>) -> Result<T, BundleError> {
    Err(BundleError {
        field: field.into(),
        message: message.into(),
    })
}

/// 生成清单的工具。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tool {
    pub name: String,
    pub version: String,
    /// `git:` 加 40 位小写十六进制的提交哈希。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// 包基于哪个空间的第几版（命令行拿它当草稿的基础版本；种子不用）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Base {
    pub space_id: String,
    pub seq: u64,
}

/// 清单里的扫描：字段规则同 `setScan`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleScan {
    pub asset_hash: String,
    pub web_model_hashes: Vec<String>,
    pub transform: [f64; 16],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alignment: Option<Map<String, Value>>,
}

impl BundleScan {
    fn spec(&self) -> ScanSpec {
        ScanSpec {
            asset_hash: self.asset_hash.clone(),
            web_model_hashes: self.web_model_hashes.clone(),
            transform: self.transform,
            alignment: self.alignment.clone(),
        }
    }
}

/// 重建层怎么改。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RebuiltMode {
    /// 重建层整体换成这一份（展开成 `clearRebuilt` + 全部物件）。
    Replace,
    /// 只放、改列出的物件，再删 `remove` 里的编号。
    Merge,
}

/// 清单里的文件用途（上传用途的子集）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FilePurpose {
    Scan,
    Webmodel,
    Model,
    Texture,
    Script,
}

impl FilePurpose {
    pub fn upload_purpose(self) -> UploadPurpose {
        match self {
            FilePurpose::Scan => UploadPurpose::Scan,
            FilePurpose::Webmodel => UploadPurpose::WebModel,
            FilePurpose::Model => UploadPurpose::Model,
            FilePurpose::Texture => UploadPurpose::Texture,
            FilePurpose::Script => UploadPurpose::Script,
        }
    }

    pub fn name(self) -> &'static str {
        self.upload_purpose().name()
    }
}

/// `files[]` 的一项：相对路径、用途、sha256、大小。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleFile {
    pub path: String,
    pub purpose: FilePurpose,
    pub sha256: String,
    pub size: u64,
}

#[derive(Deserialize)]
struct Header {
    #[serde(default)]
    format: Option<Value>,
    #[serde(default)]
    version: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawRebuilt<'a> {
    mode: RebuiltMode,
    #[serde(default, borrow)]
    templates: Vec<&'a RawValue>,
    #[serde(default, borrow)]
    entities: Vec<&'a RawValue>,
    #[serde(default)]
    remove: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawManifest<'a> {
    #[allow(dead_code)]
    format: String,
    #[allow(dead_code)]
    version: u64,
    tool: Tool,
    note: String,
    created_at: String,
    #[serde(default)]
    base: Option<Base>,
    #[serde(default)]
    scan: Option<BundleScan>,
    #[serde(default, borrow)]
    rebuilt: Option<RawRebuilt<'a>>,
    #[serde(default, borrow)]
    anchors: Vec<&'a RawValue>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default, borrow)]
    report: Option<&'a RawValue>,
    files: Vec<BundleFile>,
}

/// 校验过的重建层部分：记录还是原始片段。
#[derive(Debug, Clone)]
pub struct BundleRebuilt<'a> {
    pub mode: RebuiltMode,
    templates: Vec<&'a RawValue>,
    entities: Vec<&'a RawValue>,
    pub remove: Vec<String>,
}

impl BundleRebuilt<'_> {
    pub fn template_count(&self) -> usize {
        self.templates.len()
    }

    pub fn entity_count(&self) -> usize {
        self.entities.len()
    }
}

/// 校验过的清单（6.3 全部通过）。记录留着原始片段，展开时再逐条解析。
#[derive(Debug, Clone)]
pub struct Bundle<'a> {
    pub tool: Tool,
    pub note: String,
    pub created_at: Timestamp,
    pub base: Option<Base>,
    pub scan: Option<BundleScan>,
    pub rebuilt: Option<BundleRebuilt<'a>>,
    anchors: Vec<&'a RawValue>,
    pub notes: Option<String>,
    pub report: Option<Map<String, Value>>,
    pub files: Vec<BundleFile>,
    /// 记录里引用到的全部资源（哈希 → 用途），都在 `files` 里、用途对得上。
    pub references: BTreeMap<String, FilePurpose>,
}

/// 交包时目标空间重建层已有的模板。只在 `merge` 模式下可以引用（`replace` 先清空重建层）。
pub struct SpaceTemplates<'t>(pub &'t dyn TemplateSource);

/// 两个模板表叠起来查：先本包，再目标空间。
struct Templates<'t> {
    bundle: &'t BTreeMap<String, Shape>,
    space: Option<&'t dyn TemplateSource>,
}

impl TemplateSource for Templates<'_> {
    fn template(&self, id: &str) -> Option<&Shape> {
        self.bundle
            .get(id)
            .or_else(|| self.space.and_then(|space| space.template(id)))
    }
}

fn check_plain_text(field: &str, value: &str, max: usize) -> Result<(), BundleError> {
    let count = value.chars().count();
    if count == 0 || count > max || value.chars().any(char::is_control) {
        return fail(field, format!("必须是 1 到 {max} 个字符，不含控制字符"));
    }
    Ok(())
}

/// 提交说明的规则：去掉空白后不能是空的，不超过 2000 字，不含换行以外的控制字符。
pub fn check_note(value: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.chars().count() > MAX_NOTE_CHARS
        || value.chars().any(|c| c.is_control() && c != '\n')
    {
        return Err("必须是 1 到 2000 字，不含换行以外的控制字符".into());
    }
    Ok(())
}

/// `files[].path`：`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`，不超过 200 个字符，没有 `.`、`..` 段。
pub fn is_bundle_path(path: &str) -> bool {
    path.len() <= MAX_FILE_PATH_CHARS
        && path.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        })
}

/// `report` 里的字符串（键和值）不能像本地路径：不以 `/`、`~`、`file:` 开头，也不是 `C:\` 这样的盘符路径。
pub fn looks_like_local_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    text.starts_with('/')
        || text.starts_with('~')
        || text.starts_with("file:")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/'))
}

fn check_report_strings(value: &Value, path: &str) -> Result<(), BundleError> {
    match value {
        Value::String(text) if looks_like_local_path(text) => {
            fail(path, "不能写本地路径（以 /、~、file: 开头或盘符路径）")
        }
        Value::Array(items) => items
            .iter()
            .enumerate()
            .try_for_each(|(index, item)| check_report_strings(item, &format!("{path}[{index}]"))),
        Value::Object(map) => map.iter().try_for_each(|(key, item)| {
            if looks_like_local_path(key) {
                return fail(path, "键不能写本地路径");
            }
            check_report_strings(item, &format!("{path}.{key}"))
        }),
        _ => Ok(()),
    }
}

fn parse_record<'a, T: Deserialize<'a>>(raw: &'a RawValue, field: &str) -> Result<T, BundleError> {
    if raw.get().len() > MAX_RECORD_BYTES {
        return fail(field, "单条记录的原始 JSON 超过 64 KiB");
    }
    serde_json::from_str(raw.get()).or_else(|error| fail(field, format!("格式不对：{error}")))
}

/// 收集引用：哈希 → 用途。同一哈希按两种用途引用时报错。
struct References<'f> {
    files: &'f BTreeMap<&'f str, FilePurpose>,
    found: BTreeMap<String, FilePurpose>,
}

impl References<'_> {
    fn add(&mut self, field: &str, hash: &str, purpose: FilePurpose) -> Result<(), BundleError> {
        match self.files.get(hash) {
            Some(listed) if *listed == purpose => {
                self.found.insert(hash.to_owned(), purpose);
                Ok(())
            }
            Some(listed) => fail(
                field,
                format!(
                    "引用的 {hash} 在 files 里的用途是 {}，这里要 {}",
                    listed.name(),
                    purpose.name()
                ),
            ),
            None => fail(
                field,
                format!("引用的 {hash} 不在 files 里（包要完整：引用的每个文件都要列出）"),
            ),
        }
    }

    fn entity(&mut self, field: &str, entity: &EntityBody) -> Result<(), BundleError> {
        if let Some(hash) = &entity.asset_hash {
            self.add(&format!("{field}.assetHash"), hash, FilePurpose::Model)?;
        }
        if let Some(shape) = &entity.shape {
            for hash in shape.texture_refs() {
                self.add(&format!("{field}.shape"), &hash, FilePurpose::Texture)?;
            }
        }
        for (index, hash) in entity.textures.iter().flatten().enumerate() {
            self.add(
                &format!("{field}.textures[{index}]"),
                hash,
                FilePurpose::Texture,
            )?;
        }
        Ok(())
    }
}

impl<'a> Bundle<'a> {
    /// 解析并校验清单（6.3）。`limits` 给出各用途的大小上限和清单本身的上限；`space_templates` 是
    /// 目标空间重建层已有的模板（只在 `merge` 模式下可以引用；结构校验时没有就传 `None`）。
    pub fn parse(
        text: &'a str,
        limits: &UploadLimits,
        space_templates: Option<SpaceTemplates<'_>>,
    ) -> Result<Self, BundleError> {
        if text.len() as u64 > limits.bundle.max_bytes {
            return fail("$", format!("清单超过 {} 字节", limits.bundle.max_bytes));
        }
        // serde 也能把 JSON 数组读成结构体，这里先确认是对象（与命令行相同）。
        if !text.trim_start().starts_with('{') {
            return fail("$", "清单必须是 JSON 对象");
        }
        let header: Header = serde_json::from_str(text)
            .or_else(|error| fail("$", format!("清单必须是 JSON 对象：{error}")))?;
        if header.format.as_ref().and_then(Value::as_str) != Some(BUNDLE_FORMAT) {
            return fail("format", format!("必须是 {BUNDLE_FORMAT}"));
        }
        if header.version.as_ref().and_then(Value::as_u64) != Some(BUNDLE_VERSION) {
            return fail("version", "只认版本 1");
        }
        let raw: RawManifest<'a> =
            serde_json::from_str(text).or_else(|error| fail("$", format!("格式不对：{error}")))?;

        // 工具、说明、时间、基础版本。
        check_plain_text("tool.name", &raw.tool.name, MAX_TOOL_TEXT_CHARS)?;
        check_plain_text("tool.version", &raw.tool.version, MAX_TOOL_TEXT_CHARS)?;
        if let Some(source) = &raw.tool.source {
            let ok = source.strip_prefix("git:").is_some_and(|commit| {
                commit.len() == 40
                    && commit
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            });
            if !ok {
                return fail("tool.source", "只能是 git: 加 40 位小写十六进制");
            }
        }
        check_note(&raw.note).or_else(|message| fail("note", message))?;
        let created_at = Timestamp::parse_rfc3339(&raw.created_at)
            .or_else(|_| fail("createdAt", "必须是 RFC 3339 时间"))?;
        if let Some(base) = &raw.base {
            if !is_space_id(&base.space_id) {
                return fail("base.spaceId", "空间编号格式不对");
            }
            if base.seq < 1 {
                return fail("base.seq", "必须 ≥ 1");
            }
        }

        // 文件表。
        if raw.files.len() > MAX_BUNDLE_FILES {
            return fail("files", format!("最多 {MAX_BUNDLE_FILES} 项"));
        }
        let mut files: BTreeMap<&str, FilePurpose> = BTreeMap::new();
        let mut paths = BTreeSet::new();
        for (index, file) in raw.files.iter().enumerate() {
            let field = format!("files[{index}]");
            if !is_bundle_path(&file.path) {
                return fail(
                    format!("{field}.path"),
                    "必须是相对路径（字母、数字、. _ -，用 / 分段，没有 . 和 .. 段，不超过 200 个字符）",
                );
            }
            if !paths.insert(file.path.as_str()) {
                return fail(format!("{field}.path"), "路径重复");
            }
            if !is_sha256_hex(&file.sha256) {
                return fail(format!("{field}.sha256"), "必须是 64 位小写十六进制");
            }
            if files.insert(file.sha256.as_str(), file.purpose).is_some() {
                return fail(format!("{field}.sha256"), "同一哈希只能出现一次");
            }
            let max = limits.max_bytes(file.purpose.upload_purpose()).unwrap_or(0);
            if file.size < 1 || file.size > max {
                return fail(
                    format!("{field}.size"),
                    format!(
                        "必须在 1 到 {max} 字节之间（{} 用途的上限）",
                        file.purpose.name()
                    ),
                );
            }
        }
        let mut references = References {
            files: &files,
            found: BTreeMap::new(),
        };

        // 扫描。
        if let Some(scan) = &raw.scan {
            scan.spec()
                .validate()
                .or_else(|error| fail("scan", strip_index(&error.to_string())))?;
            references.add("scan.assetHash", &scan.asset_hash, FilePurpose::Scan)?;
            for (index, hash) in scan.web_model_hashes.iter().enumerate() {
                references.add(
                    &format!("scan.webModelHashes[{index}]"),
                    hash,
                    FilePurpose::Webmodel,
                )?;
            }
        }

        // 重建层。
        let mut ids = BTreeSet::new();
        if let Some(rebuilt) = &raw.rebuilt {
            if rebuilt.templates.len() > MAX_BUNDLE_TEMPLATES {
                return fail(
                    "rebuilt.templates",
                    format!("最多 {MAX_BUNDLE_TEMPLATES} 个模板"),
                );
            }
            if rebuilt.entities.len() > MAX_BUNDLE_ENTITIES {
                return fail(
                    "rebuilt.entities",
                    format!("最多 {MAX_BUNDLE_ENTITIES} 个物件"),
                );
            }
            if rebuilt.mode == RebuiltMode::Replace && !rebuilt.remove.is_empty() {
                return fail("rebuilt.remove", "只在 merge 模式下能给");
            }
            if rebuilt.remove.len() > MAX_BUNDLE_REMOVE {
                return fail("rebuilt.remove", format!("最多 {MAX_BUNDLE_REMOVE} 个编号"));
            }
            // 模板先解析：物件按模板算包围盒。
            let mut templates: BTreeMap<String, Shape> = BTreeMap::new();
            let mut template_bodies = Vec::with_capacity(rebuilt.templates.len());
            for (index, raw_template) in rebuilt.templates.iter().enumerate() {
                let field = format!("rebuilt.templates[{index}]");
                let body: EntityBody = parse_record(raw_template, &field)?;
                check_rebuilt_entity(&field, &body, &mut ids)?;
                if body.kind != EntityKind::Template {
                    return fail(format!("{field}.kind"), "模板的 kind 必须是 template");
                }
                if let Some(shape) = &body.shape {
                    templates.insert(body.entity_id.clone(), shape.clone());
                }
                template_bodies.push(body);
            }
            let space = match (&space_templates, rebuilt.mode) {
                (Some(SpaceTemplates(space)), RebuiltMode::Merge) => Some(*space),
                _ => None,
            };
            let lookup = Templates {
                bundle: &templates,
                space,
            };
            for (index, body) in template_bodies.iter().enumerate() {
                let field = format!("rebuilt.templates[{index}]");
                body.validate(&lookup)
                    .or_else(|error| fail(&field, error.to_string()))?;
                references.entity(&field, body)?;
            }
            drop(template_bodies);
            for (index, raw_entity) in rebuilt.entities.iter().enumerate() {
                let field = format!("rebuilt.entities[{index}]");
                let body: EntityBody = parse_record(raw_entity, &field)?;
                check_rebuilt_entity(&field, &body, &mut ids)?;
                if body.kind == EntityKind::Template {
                    return fail(format!("{field}.kind"), "模板写在 rebuilt.templates 里");
                }
                body.validate(&lookup)
                    .or_else(|error| fail(&field, error.to_string()))?;
                references.entity(&field, &body)?;
            }
            let mut removed = BTreeSet::new();
            for (index, id) in rebuilt.remove.iter().enumerate() {
                let field = format!("rebuilt.remove[{index}]");
                if !is_object_id(id) || id.starts_with('_') {
                    return fail(field, "编号格式不对");
                }
                if ids.contains(id) {
                    return fail(field, "不能与 templates、entities 的编号重复");
                }
                if !removed.insert(id.as_str()) {
                    return fail(field, "编号重复");
                }
            }
        }

        // 锚点。
        if raw.anchors.len() > MAX_BUNDLE_ANCHORS {
            return fail("anchors", format!("最多 {MAX_BUNDLE_ANCHORS} 个锚点"));
        }
        let mut anchor_ids = BTreeSet::new();
        for (index, raw_anchor) in raw.anchors.iter().enumerate() {
            let field = format!("anchors[{index}]");
            let body: AnchorBody = parse_record(raw_anchor, &field)?;
            if body.anchor_id == SPACE_ANCHOR_ID {
                return fail(format!("{field}.anchorId"), "不能是 _space");
            }
            body.validate()
                .or_else(|error| fail(&field, error.to_string()))?;
            if !anchor_ids.insert(body.anchor_id) {
                return fail(format!("{field}.anchorId"), "编号重复");
            }
        }

        // 建模记录、报告。
        if let Some(notes) = &raw.notes {
            if !is_sha256_hex(notes) {
                return fail("notes", "必须是 64 位小写十六进制");
            }
            references.add("notes", notes, FilePurpose::Script)?;
        }
        let report = match raw.report {
            None => None,
            Some(raw_report) => {
                if raw_report.get().len() > MAX_REPORT_RAW_BYTES {
                    return fail("report", "太大");
                }
                let value: Value = serde_json::from_str(raw_report.get())
                    .or_else(|error| fail("report", format!("格式不对：{error}")))?;
                let Value::Object(map) = value else {
                    return fail("report", "必须是 JSON 对象");
                };
                let bytes = canonical_json_of(&map)
                    .or_else(|error| fail("report", format!("无法规范化：{error}")))?
                    .len();
                if bytes > MAX_REPORT_BYTES {
                    return fail("report", "规范化后超过 64 KiB");
                }
                check_report_strings(&Value::Object(map.clone()), "report")?;
                Some(map)
            }
        };

        if raw.scan.is_none() && raw.rebuilt.is_none() && raw.anchors.is_empty() {
            return fail("$", "scan、rebuilt、anchors 至少给一个");
        }
        let references = references.found;
        Ok(Bundle {
            tool: raw.tool,
            note: raw.note,
            created_at,
            base: raw.base,
            scan: raw.scan,
            rebuilt: raw.rebuilt.map(|rebuilt| BundleRebuilt {
                mode: rebuilt.mode,
                templates: rebuilt.templates,
                entities: rebuilt.entities,
                remove: rebuilt.remove,
            }),
            anchors: raw.anchors,
            notes: raw.notes,
            report,
            files: raw.files,
            references,
        })
    }

    pub fn anchor_count(&self) -> usize {
        self.anchors.len()
    }

    /// 按 6.4 展开成操作，一条一条交给 `emit`（记录在这里逐条再解析一遍）：
    ///
    /// 1. 有 `scan`：`setScan`；
    /// 2. `replace`：`clearRebuilt`；
    /// 3. 每个模板、每个物件（按清单顺序）：`placeEntity`；
    /// 4. `merge`：每个 `remove` 编号 `removeEntity`（带 `ifPresent`）；
    /// 5. 每个锚点：`createAnchor`（带 `ifNew`）。
    pub fn for_each_op<E>(&self, mut emit: impl FnMut(Op) -> Result<(), E>) -> Result<(), E>
    where
        E: From<BundleError>,
    {
        if let Some(scan) = &self.scan {
            emit(Op::SetScan {
                scan: scan.spec(),
                observed_at: scan.observed_at,
            })?;
        }
        if let Some(rebuilt) = &self.rebuilt {
            if rebuilt.mode == RebuiltMode::Replace {
                emit(Op::ClearRebuilt {})?;
            }
            for (list, name) in [
                (&rebuilt.templates, "rebuilt.templates"),
                (&rebuilt.entities, "rebuilt.entities"),
            ] {
                for (index, raw) in list.iter().enumerate() {
                    let entity: EntityBody = parse_record(raw, &format!("{name}[{index}]"))?;
                    emit(Op::PlaceEntity {
                        entity: Box::new(entity),
                    })?;
                }
            }
            if rebuilt.mode == RebuiltMode::Merge {
                for id in &rebuilt.remove {
                    emit(Op::RemoveEntity {
                        entity_id: id.clone(),
                        if_present: Some(true),
                    })?;
                }
            }
        }
        for (index, raw) in self.anchors.iter().enumerate() {
            let anchor: AnchorBody = parse_record(raw, &format!("anchors[{index}]"))?;
            emit(Op::CreateAnchor {
                anchor,
                if_new: Some(true),
            })?;
        }
        Ok(())
    }

    /// 展开成操作列表（测试和小包用；接口服务用 [`Bundle::for_each_op`] 边展开边写）。
    pub fn to_ops(&self) -> Result<Vec<Op>, BundleError> {
        let mut ops = Vec::new();
        self.for_each_op(|op| {
            ops.push(op);
            Ok::<(), BundleError>(())
        })?;
        Ok(ops)
    }
}

/// 重建层记录的共同规则：`layer` 是 `rebuilt`，编号以 `rb.` 开头、不重复（模板和物件共用编号空间）。
fn check_rebuilt_entity(
    field: &str,
    body: &EntityBody,
    ids: &mut BTreeSet<String>,
) -> Result<(), BundleError> {
    if body.layer != Layer::Rebuilt {
        return fail(format!("{field}.layer"), "必须是 rebuilt");
    }
    if !is_rebuilt_id(&body.entity_id) {
        return fail(
            format!("{field}.entityId"),
            format!("必须以 {REBUILT_ID_PREFIX} 开头"),
        );
    }
    if !ids.insert(body.entity_id.clone()) {
        return fail(format!("{field}.entityId"), "编号重复");
    }
    Ok(())
}

/// 操作错误的说明去掉"第 0 条操作："。
fn strip_index(message: &str) -> String {
    message
        .split_once('：')
        .map_or(message, |(_, rest)| rest)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hex(c: char) -> String {
        c.to_string().repeat(64)
    }

    fn manifest() -> Value {
        json!({
            "format": BUNDLE_FORMAT, "version": 1,
            "tool": {"name": "metaverse-recon", "version": "0.2.0",
                     "source": "git:0123456789abcdef0123456789abcdef01234567"},
            "note": "前厅第 4 版", "createdAt": "2026-11-20T08:00:00.000Z",
            "base": {"spaceId": "chronoai-lobby", "seq": 4},
            "scan": {"assetHash": hex('1'), "webModelHashes": [hex('2')],
                     "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
                     "observedAt": "2026-10-20T00:00:00.000Z", "alignment": {"method": "given"}},
            "rebuilt": {"mode": "replace",
                "templates": [{"entityId": "rb.chair-a", "layer": "rebuilt", "kind": "template",
                    "shape": {"type": "box", "size": [0.5, 0.9, 0.5],
                              "material": {"texture": hex('3'), "uv": "box"}},
                    "bounds": {"min": [-0.25, 0, -0.25], "max": [0.25, 0.9, 0.25]}}],
                "entities": [{"entityId": "rb.chair-01", "layer": "rebuilt", "kind": "object",
                    "shape": {"type": "instance", "template": "rb.chair-a", "transform": {"position": [1, 0, 1]}},
                    "bounds": {"min": [0.75, 0, 0.75], "max": [1.25, 0.9, 1.25]}, "anchorId": "seat-1"},
                    {"entityId": "rb.sofa", "layer": "rebuilt", "kind": "object", "assetHash": hex('4'),
                     "bounds": {"min": [2, 0, 2], "max": [3, 0.8, 3]}}],
                "remove": []},
            "anchors": [{"anchorId": "seat-1", "kind": "seat", "position": [1, 0, 1], "visibility": "public"}],
            "notes": hex('5'),
            "report": {"fit": {"meanCm": 4.31}, "entities": 2},
            "files": [
                {"path": "scan/scan.zip", "purpose": "scan", "sha256": hex('1'), "size": 5_901_234},
                {"path": "web/scan-0.glb", "purpose": "webmodel", "sha256": hex('2'), "size": 13_800_000},
                {"path": "textures/333.jpg", "purpose": "texture", "sha256": hex('3'), "size": 51_234},
                {"path": "models/444.glb", "purpose": "model", "sha256": hex('4'), "size": 412_345},
                {"path": "notes.md", "purpose": "script", "sha256": hex('5'), "size": 9_876}
            ]
        })
    }

    fn parse(value: &Value) -> Result<Vec<Op>, BundleError> {
        let text = serde_json::to_string(value).unwrap();
        Bundle::parse(&text, &UploadLimits::default(), None)?.to_ops()
    }

    #[test]
    fn expands_in_order() {
        let ops = parse(&manifest()).unwrap();
        let names: Vec<_> = ops.iter().map(Op::name).collect();
        assert_eq!(
            names,
            [
                "setScan",
                "clearRebuilt",
                "placeEntity",
                "placeEntity",
                "placeEntity",
                "createAnchor"
            ]
        );
        assert!(matches!(
            &ops[5],
            Op::CreateAnchor {
                if_new: Some(true),
                ..
            }
        ));
        let text = serde_json::to_string(&manifest()).unwrap();
        let bundle = Bundle::parse(&text, &UploadLimits::default(), None).unwrap();
        assert_eq!(bundle.references.len(), 5);
        assert_eq!(bundle.rebuilt.as_ref().unwrap().entity_count(), 2);
    }

    #[test]
    fn merge_removes_with_if_present() {
        let mut value = manifest();
        value["rebuilt"]["mode"] = json!("merge");
        value["rebuilt"]["remove"] = json!(["wall-01", "rb.old"]);
        let ops = parse(&value).unwrap();
        assert!(!ops.iter().any(|op| matches!(op, Op::ClearRebuilt {})));
        let removes: Vec<_> = ops
            .iter()
            .filter_map(|op| match op {
                Op::RemoveEntity {
                    entity_id,
                    if_present: Some(true),
                } => Some(entity_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(removes, ["wall-01", "rb.old"]);
    }

    #[test]
    fn rejects() {
        type Change = Box<dyn Fn(&mut Value)>;
        let cases: Vec<(&str, Change)> = vec![
            ("format", Box::new(|v| v["format"] = json!("other"))),
            ("version", Box::new(|v| v["version"] = json!(2))),
            ("$", Box::new(|v| v["chunks"] = json!([]))),
            ("$", Box::new(|v| v["rebuilt"]["chunks"] = json!([]))),
            (
                "tool.source",
                Box::new(|v| v["tool"]["source"] = json!("git:ABC")),
            ),
            ("note", Box::new(|v| v["note"] = json!("  "))),
            ("createdAt", Box::new(|v| v["createdAt"] = json!("昨天"))),
            ("base.seq", Box::new(|v| v["base"]["seq"] = json!(0))),
            (
                "files[0].path",
                Box::new(|v| v["files"][0]["path"] = json!("../scan.zip")),
            ),
            (
                "files[0].path",
                Box::new(|v| v["files"][0]["path"] = json!("/abs/scan.zip")),
            ),
            (
                "files[1].path",
                Box::new(|v| v["files"][1]["path"] = json!("scan/scan.zip")),
            ),
            (
                "files[0].size",
                Box::new(|v| v["files"][0]["size"] = json!(0)),
            ),
            (
                "files[1].size",
                Box::new(|v| v["files"][1]["size"] = json!(65 << 20)),
            ),
            (
                "rebuilt.remove",
                Box::new(|v| v["rebuilt"]["remove"] = json!(["x"])),
            ),
            (
                "rebuilt.entities[1].entityId",
                Box::new(|v| v["rebuilt"]["entities"][1]["entityId"] = json!("sofa")),
            ),
            (
                "rebuilt.entities[1].layer",
                Box::new(|v| v["rebuilt"]["entities"][1]["layer"] = json!("ext")),
            ),
            (
                "rebuilt.entities[1].entityId",
                Box::new(|v| v["rebuilt"]["entities"][1]["entityId"] = json!("rb.chair-01")),
            ),
            (
                "rebuilt.entities[1].assetHash",
                Box::new(|v| v["rebuilt"]["entities"][1]["assetHash"] = json!(hex('9'))),
            ),
            (
                "rebuilt.entities[1].assetHash",
                Box::new(|v| v["rebuilt"]["entities"][1]["assetHash"] = json!(hex('3'))),
            ),
            (
                "anchors[0].anchorId",
                Box::new(|v| {
                    v["anchors"][0] =
                        json!({"anchorId": "_space", "kind": "space", "visibility": "public"})
                }),
            ),
            ("notes", Box::new(|v| v["notes"] = json!(hex('3')))),
            (
                "report.path",
                Box::new(|v| v["report"]["path"] = json!("/Users/me/scan")),
            ),
            (
                "report.win",
                Box::new(|v| v["report"]["win"] = json!("C:\\scan")),
            ),
            (
                "$",
                Box::new(|v| {
                    let map = v.as_object_mut().unwrap();
                    map.remove("scan");
                    map.remove("rebuilt");
                    map.remove("anchors");
                }),
            ),
        ];
        for (field, change) in cases {
            let mut value = manifest();
            change(&mut value);
            let error = parse(&value).unwrap_err();
            assert_eq!(error.field, field, "{error}");
        }
    }

    #[test]
    fn merge_may_use_space_templates() {
        let mut value = manifest();
        value["rebuilt"]["mode"] = json!("merge");
        value["rebuilt"]["templates"] = json!([]);
        let text = serde_json::to_string(&value).unwrap();
        // 没有空间的模板：引用不到。
        assert!(Bundle::parse(&text, &UploadLimits::default(), None).is_err());
        let mut space: BTreeMap<String, Shape> = BTreeMap::new();
        space.insert(
            "rb.chair-a".into(),
            serde_json::from_value(json!({"type": "box", "size": [0.5, 0.9, 0.5]})).unwrap(),
        );
        Bundle::parse(
            &text,
            &UploadLimits::default(),
            Some(SpaceTemplates(&space)),
        )
        .unwrap();
        // replace 模式先清空重建层，不能引用空间里的模板。
        value["rebuilt"]["mode"] = json!("replace");
        let text = serde_json::to_string(&value).unwrap();
        assert!(Bundle::parse(
            &text,
            &UploadLimits::default(),
            Some(SpaceTemplates(&space))
        )
        .is_err());
    }

    #[test]
    fn paths_and_local_strings() {
        for ok in ["notes.md", "scan/scan.zip", "a/b.c/d_e-f", "x..y"] {
            assert!(is_bundle_path(ok), "{ok}");
        }
        for bad in [
            "",
            "/a",
            "a/",
            "a//b",
            "./a",
            "a/../b",
            "a b",
            "a\\b",
            &"x".repeat(201),
        ] {
            assert!(!is_bundle_path(bad), "{bad}");
        }
        for local in ["/home/x", "~/x", "file:///x", "C:\\x", "d:/x"] {
            assert!(looks_like_local_path(local), "{local}");
        }
        for fine in ["4.31", "rb.chair", "https://example.com", "C:x", "a/b"] {
            assert!(!looks_like_local_path(fine), "{fine}");
        }
        // 清单必须是 JSON 对象（serde 也能把数组读成结构体，这里与命令行一样报在 $ 上）。
        for text in [r#"["chrono-metaverse-rebuild-bundle", 1]"#, r#""x""#, "{"] {
            let error = Bundle::parse(text, &UploadLimits::default(), None).unwrap_err();
            assert_eq!(error.field, "$", "{text}");
        }
    }
}
