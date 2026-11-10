//! 资源核对（docs/design/server-slim.md 4.3–4.6）：按用途检查文件内容，得出只取决于内容的核对记录
//! `metadata.check`。
//!
//! **不解码网格、不解码图片**：只读文件头、glb 的 JSON 块、`POSITION` 访问器的数据（算真实的包围盒）
//! 和图片头；唯一要解压的是操作文件的 gzip。全部检查跟着哈希的流式读取一次做完：
//! [`inspect`] 按序号一批批读出数据块（一批 4 MiB），在阻塞线程池里算哈希、喂给检查器
//! （[`Inspector`]），内存只有一批数据块加上检查器留的少量状态（glb 的 JSON 块、zip 的中央目录、
//! 清单原文）。
//!
//! | 用途 | 格式 | 检查器 |
//! |---|---|---|
//! | `scan` | glb（轻量）、drc、obj、zip | [`glb`]、[`text::DrcStream`]、[`text::ObjStream`]、[`zip`] |
//! | `webmodel`、`model` | glb（完整） | [`glb`] |
//! | `texture` | png、jpeg、webp | [`image`] |
//! | `ops` | ndjson、gzip | [`ndjson`] |
//! | `script` | text | [`text::Utf8Stream`] |
//! | `bundle` | json | [`text::JsonStream`] |
//!
//! 检查通过以后再按用途的上限判断（[`metaverse_core::check::fits`]，与引用时按角色判断是同一个函数）。

use metaverse_core::check::{fits, AssetCheck, AssetRole, CheckBody, ImageCheck};
use metaverse_core::limits::{
    UploadLimits, GLB_JSON_MODEL_BYTES, GLB_JSON_SCAN_BYTES, GLB_JSON_WEBMODEL_BYTES,
};
use metaverse_core::model::{UploadFormat, ASSET_CHUNK_SIZE};
use metaverse_core::scope::UploadPurpose;
use sha2::{Digest, Sha256};

use crate::repo::{ChunkSource, Repo, RepoError};

pub mod glb;
pub mod image;
pub mod ndjson;
pub mod text;
pub mod zip;

/// 内容不合格：拒绝码（`tests/vectors/check/expected.json` 用同一套）和给人看的说明。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reject {
    pub code: &'static str,
    pub message: String,
}

impl Reject {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for Reject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}（{}）", self.message, self.code)
    }
}

/// 一批读多少个数据块（16 × 256 KiB = 4 MiB）。
pub const BATCH_CHUNKS: u64 = 16;

/// 按用途和格式选出的检查器。
pub enum Inspector {
    Glb(Box<glb::GlbStream>),
    Zip(Box<zip::ZipStream>),
    Image(image::ImageProbe),
    Ops {
        stream: Box<ndjson::NdjsonStream<ndjson::CheckLines>>,
        gzip: bool,
    },
    Text(text::Utf8Stream),
    Obj(text::ObjStream),
    Drc(text::DrcStream),
    Bundle(text::JsonStream),
}

/// 检查器需要先读文件末尾（zip 的中央目录）。
pub fn needs_tail(format: UploadFormat) -> bool {
    format == UploadFormat::Zip
}

impl Inspector {
    /// 按用途和格式选检查器。`tail` 是 zip 的文件末尾（见 [`zip::tail_length`]），别的格式为空。
    pub fn new(
        purpose: UploadPurpose,
        format: UploadFormat,
        size: u64,
        tail: Option<&[u8]>,
    ) -> Result<Self, Reject> {
        let wrong = || {
            Reject::new(
                "format_mismatch",
                format!("{} 用途不收 {} 格式", purpose.name(), format.name()),
            )
        };
        Ok(match (purpose, format) {
            (UploadPurpose::Scan, UploadFormat::Glb) => Inspector::Glb(Box::new(
                glb::GlbStream::new(glb::Depth::Light, size, GLB_JSON_SCAN_BYTES),
            )),
            (UploadPurpose::Scan, UploadFormat::Drc) => Inspector::Drc(text::DrcStream::default()),
            (UploadPurpose::Scan, UploadFormat::Obj) => Inspector::Obj(text::ObjStream::default()),
            (UploadPurpose::Scan, UploadFormat::Zip) => {
                let tail = tail.ok_or_else(|| Reject::new("zip_structure", "缺少 zip 的末尾"))?;
                Inspector::Zip(Box::new(zip::ZipStream::from_tail(tail, size)?))
            }
            (UploadPurpose::WebModel, UploadFormat::Glb) => Inspector::Glb(Box::new(
                glb::GlbStream::new(glb::Depth::Full, size, GLB_JSON_WEBMODEL_BYTES),
            )),
            (UploadPurpose::Model, UploadFormat::Glb) => Inspector::Glb(Box::new(
                glb::GlbStream::new(glb::Depth::Full, size, GLB_JSON_MODEL_BYTES),
            )),
            (UploadPurpose::Texture, UploadFormat::Png) => {
                Inspector::Image(image::ImageProbe::new(Some(image::ImageKind::Png)))
            }
            (UploadPurpose::Texture, UploadFormat::Jpeg) => {
                Inspector::Image(image::ImageProbe::new(Some(image::ImageKind::Jpeg)))
            }
            (UploadPurpose::Texture, UploadFormat::Webp) => {
                Inspector::Image(image::ImageProbe::new(Some(image::ImageKind::Webp)))
            }
            (UploadPurpose::Ops, UploadFormat::Ndjson | UploadFormat::Gzip) => {
                let gzip = format == UploadFormat::Gzip;
                Inspector::Ops {
                    stream: Box::new(ndjson::NdjsonStream::new(Some(gzip), ndjson::CheckLines)),
                    gzip,
                }
            }
            (UploadPurpose::Script, UploadFormat::Text) => {
                Inspector::Text(text::Utf8Stream::default())
            }
            (UploadPurpose::Bundle, UploadFormat::Json) => {
                Inspector::Bundle(text::JsonStream::new(size))
            }
            _ => return Err(wrong()),
        })
    }

    pub fn feed(&mut self, data: &[u8]) -> Result<(), Reject> {
        match self {
            Inspector::Glb(stream) => stream.feed(data),
            Inspector::Zip(stream) => stream.feed(data),
            Inspector::Image(probe) => probe.feed(data),
            Inspector::Ops { stream, .. } => stream.feed(data),
            Inspector::Text(stream) => stream.feed(data),
            Inspector::Obj(stream) => stream.feed(data),
            Inspector::Drc(stream) => stream.feed(data),
            Inspector::Bundle(stream) => stream.feed(data),
        }
    }

    pub fn finish(self) -> Result<AssetCheck, Reject> {
        let body = match self {
            Inspector::Glb(stream) => CheckBody::Glb(stream.finish()?),
            Inspector::Zip(stream) => CheckBody::Zip(stream.finish()?),
            Inspector::Image(probe) => {
                let info = probe.finish()?;
                let check = ImageCheck {
                    width: info.width,
                    height: info.height,
                };
                match info.kind {
                    image::ImageKind::Png => CheckBody::Png(check),
                    image::ImageKind::Jpeg => CheckBody::Jpeg(check),
                    image::ImageKind::Webp => CheckBody::Webp(check),
                }
            }
            Inspector::Ops { stream, gzip } => {
                stream.finish()?;
                if gzip {
                    CheckBody::Gzip {}
                } else {
                    CheckBody::Ndjson {}
                }
            }
            Inspector::Text(stream) => {
                stream.finish()?;
                CheckBody::Text {}
            }
            Inspector::Obj(stream) => {
                stream.finish()?;
                CheckBody::Obj {}
            }
            Inspector::Drc(stream) => {
                stream.finish()?;
                CheckBody::Drc {}
            }
            Inspector::Bundle(stream) => {
                stream.finish()?;
                CheckBody::Json {}
            }
        };
        Ok(AssetCheck::new(body))
    }
}

/// 检查通过以后按用途的上限判断（与引用时按角色判断是同一个函数）。
pub fn within_limits(
    purpose: UploadPurpose,
    check: &AssetCheck,
    limits: &UploadLimits,
) -> Result<(), Reject> {
    match AssetRole::for_purpose(purpose) {
        Some(role) => fits(role, check, limits).map_err(|error| Reject::new("over_limit", error.0)),
        None => Ok(()),
    }
}

/// 一次完整的读取：内容哈希和核对记录。
#[derive(Debug, Clone)]
pub struct Inspected {
    pub sha256: String,
    pub check: AssetCheck,
}

/// 读取失败的原因。
#[derive(Debug)]
pub enum InspectError {
    /// 内容不合格（哈希、数据块布局、格式）。
    Rejected(Reject),
    /// 数据库暂时不可用。
    Repo(RepoError),
}

impl From<Reject> for InspectError {
    fn from(reject: Reject) -> Self {
        InspectError::Rejected(reject)
    }
}

impl From<RepoError> for InspectError {
    fn from(error: RepoError) -> Self {
        InspectError::Repo(error)
    }
}

/// 按序号读出全部数据块：核对序号连续、除最后一块外每块 256 KiB、总长度等于 `size`；边读边算哈希，
/// 同时交给检查器。检查器出错就停（不再读剩下的数据）。`make` 在读完 zip 末尾之后构造检查器。
pub async fn inspect(
    repo: &Repo,
    source: &ChunkSource<'_>,
    size: u64,
    format: UploadFormat,
    make: impl FnOnce(Option<&[u8]>) -> Result<Inspector, Reject>,
) -> Result<Inspected, InspectError> {
    let chunk = ASSET_CHUNK_SIZE;
    let count = size.div_ceil(chunk);
    let tail = if needs_tail(format) && size > 0 {
        let length = zip::tail_length(size);
        let first = (size - length) / chunk;
        let mut bytes = Vec::with_capacity((size - first * chunk) as usize);
        let mut next = first;
        while next < count {
            let batch = repo.read_chunks(source, next, BATCH_CHUNKS).await?;
            if batch.is_empty() {
                break;
            }
            for (n, data) in batch {
                if n != next {
                    return Err(
                        chunk_layout(format!("数据块序号不连续：期望 {next}，实际 {n}")).into(),
                    );
                }
                bytes.extend_from_slice(&data);
                next += 1;
            }
        }
        let skip = (size - length - first * chunk) as usize;
        if bytes.len() < skip + length as usize {
            return Err(chunk_layout("文件末尾的数据块不完整").into());
        }
        Some(bytes[skip..skip + length as usize].to_vec())
    } else {
        None
    };
    let mut inspector = make(tail.as_deref())?;
    drop(tail);
    let mut hasher = Sha256::new();
    let mut next = 0u64;
    let mut total = 0u64;
    while next < count {
        let batch = repo.read_chunks(source, next, BATCH_CHUNKS).await?;
        if batch.is_empty() {
            return Err(chunk_layout(format!("数据不完整：{total} / {size} 字节")).into());
        }
        for (n, data) in &batch {
            if *n != next {
                return Err(
                    chunk_layout(format!("数据块序号不连续：期望 {next}，实际 {n}")).into(),
                );
            }
            let expected = if next + 1 == count {
                size - next * chunk
            } else {
                chunk
            };
            if data.len() as u64 != expected {
                return Err(chunk_layout(format!(
                    "第 {n} 块应为 {expected} 字节，实际 {}",
                    data.len()
                ))
                .into());
            }
            next += 1;
            total += expected;
        }
        // 哈希和检查都是纯计算，放到阻塞线程池里，不占异步工作线程。
        let (back_inspector, back_hasher, outcome) = tokio::task::spawn_blocking(move || {
            let mut inspector = inspector;
            let mut hasher = hasher;
            let mut outcome = Ok(());
            for (_, data) in &batch {
                hasher.update(data);
                if outcome.is_ok() {
                    outcome = inspector.feed(data);
                }
            }
            (inspector, hasher, outcome)
        })
        .await
        .map_err(|_| InspectError::Repo(RepoError::Unavailable))?;
        inspector = back_inspector;
        hasher = back_hasher;
        outcome?;
    }
    if total != size {
        return Err(chunk_layout(format!("数据不完整：{total} / {size} 字节")).into());
    }
    // 多出来的数据块（序号超过声明的大小）。
    if !repo.read_chunks(source, count, 1).await?.is_empty() {
        return Err(chunk_layout("数据块比声明的大小多").into());
    }
    let sha256 = metaverse_core::to_hex(&hasher.finalize());
    let check = tokio::task::spawn_blocking(move || inspector.finish())
        .await
        .map_err(|_| InspectError::Repo(RepoError::Unavailable))??;
    Ok(Inspected { sha256, check })
}

fn chunk_layout(message: impl Into<String>) -> Reject {
    Reject::new("chunk_layout", message)
}

/// 按文件开头的魔数猜格式（后台迁移给没有声明格式的旧资源补核对记录时用）。
pub fn sniff_format(head: &[u8]) -> Option<UploadFormat> {
    if head.starts_with(b"glTF") {
        Some(UploadFormat::Glb)
    } else if head.starts_with(b"DRACO") {
        Some(UploadFormat::Drc)
    } else if head.starts_with(b"PK\x03\x04") {
        Some(UploadFormat::Zip)
    } else {
        match image::sniff(head) {
            Some(image::ImageKind::Png) => Some(UploadFormat::Png),
            Some(image::ImageKind::Jpeg) => Some(UploadFormat::Jpeg),
            Some(image::ImageKind::Webp) => Some(UploadFormat::Webp),
            None if !head.contains(&0) => Some(UploadFormat::Obj),
            None => None,
        }
    }
}

/// 把一段完整的字节交给检查器（测试和样本用）。
pub fn inspect_bytes(
    purpose: UploadPurpose,
    format: UploadFormat,
    bytes: &[u8],
    step: usize,
) -> Result<AssetCheck, Reject> {
    let size = bytes.len() as u64;
    let tail = needs_tail(format).then(|| &bytes[(size - zip::tail_length(size)) as usize..]);
    let mut inspector = Inspector::new(purpose, format, size, tail)?;
    for part in bytes.chunks(step.max(1)) {
        inspector.feed(part)?;
    }
    inspector.finish()
}
