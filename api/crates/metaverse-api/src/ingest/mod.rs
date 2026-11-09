//! 上传、任务、事件、组合用到的配置和进程内状态（与路由、数据访问分开，便于测试）。
//!
//! | 变量 | 默认 | 说明 |
//! |---|---|---|
//! | `UPLOAD_MAX_SCAN_BYTES` | 1 GiB | 扫描（设计 6.1） |
//! | `UPLOAD_MAX_MODEL_BYTES` | 50 MiB | 物件模型 |
//! | `UPLOAD_MAX_TEXTURE_BYTES` | 50 MiB | 单张贴图的文件大小（与处理服务的上限相同） |
//! | `UPLOAD_MAX_OPS_BYTES` | 64 MiB | 大批量操作（NDJSON，可 gzip）；不能超过接口服务处理时整份读入的上限 `MAX_OPS_FILE_BYTES`（64 MiB），否则启动失败 |
//! | `UPLOAD_MAX_SCRIPT_BYTES` | 4 MiB | 建造脚本（纯文本） |
//! | `UPLOAD_MAX_TEXTURE_SIDE` | 8192 | 图片单边像素上限（收到第 0 片时按文件头检查） |
//! | `UPLOAD_SCAN_FORMATS` | `glb,drc,obj,zip` | 扫描用途接受的格式（zip = 模型 + 贴图，例如 Scaniverse 导出；单独的贴图走 texture 用途） |
//! | `UPLOAD_MODEL_FORMATS` | `glb,drc,obj,zip` | 物件模型用途接受的格式 |
//! | `UPLOAD_TEXTURE_FORMATS` | `png,jpeg,webp` | 贴图用途接受的格式 |
//! | `UPLOAD_MAX_OPEN_PER_SPACE` | 16 | 每个空间同时进行中的上传数，超过返回 429 |
//! | `UPLOAD_MAX_CONCURRENT_PARTS` | 8 | 本进程同时处理的分片数（每片最多 32MiB 在内存里） |
//! | `JOB_MAX_PENDING_PER_SPACE` | 8 | 每个空间同时排队和运行的任务数，超过返回 429 |
//!
//! ops 用途固定接受 `ndjson`、`gzip`，script 用途固定接受 `text`。

use std::sync::Arc;
use std::time::Duration;

use metaverse_core::authored::MAX_AUTHORED_BYTES;
use metaverse_core::limits::{DEFAULT_MAX_BUNDLE_BYTES, DEFAULT_WEBMODEL};
use metaverse_core::model::UploadFormat;
use metaverse_core::scope::UploadPurpose;
use tokio::sync::Semaphore;

use crate::config::ConfigError;
use crate::timeline::drafts::MAX_OPS_FILE_BYTES;

pub mod formats;
pub mod head_cache;
pub mod schema;
pub mod state;

/// 各用途的大小上限和格式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngestConfig {
    pub max_scan_bytes: u64,
    pub max_model_bytes: u64,
    pub max_texture_bytes: u64,
    pub max_ops_bytes: u64,
    pub max_script_bytes: u64,
    pub max_texture_side: u64,
    pub scan_formats: Vec<UploadFormat>,
    pub model_formats: Vec<UploadFormat>,
    pub texture_formats: Vec<UploadFormat>,
    pub max_open_uploads_per_space: u64,
    pub max_concurrent_parts: usize,
    pub max_pending_jobs_per_space: u64,
}

/// 模型和贴图只接受这几种格式（设计 6.1；zip 是模型 + 贴图的打包，与处理服务相同）。
const MEDIA_FORMATS: [UploadFormat; 7] = [
    UploadFormat::Glb,
    UploadFormat::Drc,
    UploadFormat::Obj,
    UploadFormat::Zip,
    UploadFormat::Png,
    UploadFormat::Jpeg,
    UploadFormat::Webp,
];

/// 扫描和物件模型的默认格式（处理服务接受的）。
const MODEL_FORMATS: [UploadFormat; 4] = [
    UploadFormat::Glb,
    UploadFormat::Drc,
    UploadFormat::Obj,
    UploadFormat::Zip,
];

impl Default for IngestConfig {
    fn default() -> Self {
        Self {
            max_scan_bytes: 1 << 30,
            max_model_bytes: 50 << 20,
            max_texture_bytes: 50 << 20,
            // 处理时整份读入内存（解压后另有 256 MiB 上限），上传上限不能比它大。
            max_ops_bytes: MAX_OPS_FILE_BYTES,
            max_script_bytes: 4 << 20,
            max_texture_side: 8192,
            scan_formats: MODEL_FORMATS.to_vec(),
            model_formats: MODEL_FORMATS.to_vec(),
            texture_formats: vec![UploadFormat::Png, UploadFormat::Jpeg, UploadFormat::Webp],
            max_open_uploads_per_space: 16,
            max_concurrent_parts: 8,
            max_pending_jobs_per_space: 8,
        }
    }
}

impl IngestConfig {
    pub fn from_lookup(lookup: &impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let defaults = Self::default();
        let optional = |name: &str| {
            lookup(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let number = |name: &'static str, default: u64, min: u64, max: u64| match optional(name) {
            None => Ok(default),
            Some(text) => text
                .parse::<u64>()
                .ok()
                .filter(|value| (min..=max).contains(value))
                .ok_or(ConfigError::Invalid(name, text)),
        };
        let formats = |name: &'static str, default: &[UploadFormat]| match optional(name) {
            None => Ok(default.to_vec()),
            Some(text) => {
                let mut list = Vec::new();
                for item in text.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                    let format = UploadFormat::from_name(item)
                        .filter(|format| MEDIA_FORMATS.contains(format))
                        .ok_or_else(|| ConfigError::Invalid(name, text.clone()))?;
                    if !list.contains(&format) {
                        list.push(format);
                    }
                }
                if list.is_empty() {
                    return Err(ConfigError::Invalid(name, text));
                }
                Ok(list)
            }
        };
        const TIB: u64 = 1 << 40;
        Ok(Self {
            max_scan_bytes: number("UPLOAD_MAX_SCAN_BYTES", defaults.max_scan_bytes, 1, TIB)?,
            max_model_bytes: number("UPLOAD_MAX_MODEL_BYTES", defaults.max_model_bytes, 1, TIB)?,
            max_texture_bytes: number(
                "UPLOAD_MAX_TEXTURE_BYTES",
                defaults.max_texture_bytes,
                1,
                TIB,
            )?,
            // 超过处理时的上限就能传上去却应用不了（ops-from-upload 和草稿展开都会失败），
            // 所以配置大了直接启动失败。
            max_ops_bytes: number(
                "UPLOAD_MAX_OPS_BYTES",
                defaults.max_ops_bytes,
                1,
                MAX_OPS_FILE_BYTES,
            )?,
            max_script_bytes: number("UPLOAD_MAX_SCRIPT_BYTES", defaults.max_script_bytes, 1, TIB)?,
            max_texture_side: number(
                "UPLOAD_MAX_TEXTURE_SIDE",
                defaults.max_texture_side,
                1,
                1 << 20,
            )?,
            scan_formats: formats("UPLOAD_SCAN_FORMATS", &defaults.scan_formats)?,
            model_formats: formats("UPLOAD_MODEL_FORMATS", &defaults.model_formats)?,
            texture_formats: formats("UPLOAD_TEXTURE_FORMATS", &defaults.texture_formats)?,
            max_open_uploads_per_space: number(
                "UPLOAD_MAX_OPEN_PER_SPACE",
                defaults.max_open_uploads_per_space,
                1,
                10_000,
            )?,
            max_concurrent_parts: number(
                "UPLOAD_MAX_CONCURRENT_PARTS",
                defaults.max_concurrent_parts as u64,
                1,
                256,
            )? as usize,
            max_pending_jobs_per_space: number(
                "JOB_MAX_PENDING_PER_SPACE",
                defaults.max_pending_jobs_per_space,
                1,
                10_000,
            )?,
        })
    }

    /// 某用途的大小上限。
    pub fn max_bytes(&self, purpose: UploadPurpose) -> u64 {
        match purpose {
            UploadPurpose::Scan => self.max_scan_bytes,
            UploadPurpose::Model => self.max_model_bytes,
            UploadPurpose::Texture => self.max_texture_bytes,
            UploadPurpose::Ops => self.max_ops_bytes,
            UploadPurpose::Script => self.max_script_bytes,
            UploadPurpose::Authored => MAX_AUTHORED_BYTES,
            // 重建路径的两种用途：加上它们的配置项之前，先用核心库的默认上限。
            UploadPurpose::WebModel => DEFAULT_WEBMODEL.max_bytes,
            UploadPurpose::Bundle => DEFAULT_MAX_BUNDLE_BYTES,
        }
    }

    /// 某用途接受的格式。
    pub fn formats(&self, purpose: UploadPurpose) -> &[UploadFormat] {
        match purpose {
            UploadPurpose::Scan => &self.scan_formats,
            UploadPurpose::Model => &self.model_formats,
            UploadPurpose::Texture => &self.texture_formats,
            UploadPurpose::Ops => &[UploadFormat::Ndjson, UploadFormat::Gzip],
            UploadPurpose::Script => &[UploadFormat::Text],
            UploadPurpose::Authored | UploadPurpose::Bundle => &[UploadFormat::Json],
            UploadPurpose::WebModel => &[UploadFormat::Glb],
        }
    }
}

/// 路径里的用途名。
pub fn purpose_from_path(value: &str) -> Option<UploadPurpose> {
    match value {
        "scan" => Some(UploadPurpose::Scan),
        "model" => Some(UploadPurpose::Model),
        "texture" => Some(UploadPurpose::Texture),
        "ops" => Some(UploadPurpose::Ops),
        "script" => Some(UploadPurpose::Script),
        "authored" => Some(UploadPurpose::Authored),
        _ => None,
    }
}

pub fn purpose_name(purpose: UploadPurpose) -> &'static str {
    purpose.name()
}

/// 进程内状态：分片并发上限、`/head` 的短缓存。
pub struct IngestRuntime {
    pub config: IngestConfig,
    parts: Arc<Semaphore>,
    pub head_cache: head_cache::HeadCache,
}

/// 等分片名额的最长时间，超过就返回 503，让客户端稍后重试。
pub const PART_PERMIT_WAIT: Duration = Duration::from_secs(20);

impl IngestRuntime {
    pub fn new(config: IngestConfig) -> Self {
        let parts = Arc::new(Semaphore::new(config.max_concurrent_parts));
        Self {
            config,
            parts,
            head_cache: head_cache::HeadCache::new(),
        }
    }

    /// 取一个分片处理名额（读请求体之前取，限制内存占用）。
    pub async fn part_permit(&self) -> Option<tokio::sync::OwnedSemaphorePermit> {
        tokio::time::timeout(PART_PERMIT_WAIT, self.parts.clone().acquire_owned())
            .await
            .ok()
            .and_then(Result::ok)
    }
}

/// 新编号：前缀 + 128 位随机数（十六进制）。
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn load(values: &[(&str, &str)]) -> Result<IngestConfig, ConfigError> {
        let map: BTreeMap<String, String> = values
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        IngestConfig::from_lookup(&|name: &str| map.get(name).cloned())
    }

    #[test]
    fn defaults_follow_the_design() {
        let config = load(&[]).unwrap();
        assert_eq!(config, IngestConfig::default());
        assert_eq!(config.max_bytes(UploadPurpose::Scan), 1 << 30);
        assert_eq!(config.max_bytes(UploadPurpose::Model), 50 << 20);
        // ops 的上传上限等于处理时整份读入的上限（64 MiB）。
        assert_eq!(config.max_bytes(UploadPurpose::Ops), 64 << 20);
        assert_eq!(config.max_bytes(UploadPurpose::Ops), MAX_OPS_FILE_BYTES);
        assert_eq!(
            config.formats(UploadPurpose::Ops),
            [UploadFormat::Ndjson, UploadFormat::Gzip]
        );
        assert_eq!(config.formats(UploadPurpose::Script), [UploadFormat::Text]);
        assert_eq!(
            config.formats(UploadPurpose::Authored),
            [UploadFormat::Json]
        );
        assert_eq!(
            config.max_bytes(UploadPurpose::Authored),
            MAX_AUTHORED_BYTES
        );
    }

    #[test]
    fn overrides_and_rejections() {
        let config = load(&[
            ("UPLOAD_MAX_SCAN_BYTES", "2048"),
            ("UPLOAD_MODEL_FORMATS", "glb, glb"),
            ("JOB_MAX_PENDING_PER_SPACE", "3"),
        ])
        .unwrap();
        assert_eq!(config.max_scan_bytes, 2048);
        assert_eq!(config.model_formats, [UploadFormat::Glb]);
        assert_eq!(config.max_pending_jobs_per_space, 3);
        // 调小可以。
        let config = load(&[("UPLOAD_MAX_OPS_BYTES", "67108864")]).unwrap();
        assert_eq!(config.max_ops_bytes, MAX_OPS_FILE_BYTES);
        let config = load(&[("UPLOAD_MAX_OPS_BYTES", "1048576")]).unwrap();
        assert_eq!(config.max_ops_bytes, 1 << 20);
        for (name, value) in [
            ("UPLOAD_MAX_SCAN_BYTES", "0"),
            ("UPLOAD_MAX_SCAN_BYTES", "lots"),
            ("UPLOAD_MODEL_FORMATS", "glb,exe"),
            // 模型用途不能接受 ops 的格式。
            ("UPLOAD_MODEL_FORMATS", "ndjson"),
            ("UPLOAD_TEXTURE_FORMATS", " , "),
            ("UPLOAD_MAX_CONCURRENT_PARTS", "0"),
            // 超过处理时的上限（原来的 256 MiB 默认值）：传得上去却应用不了，启动失败。
            ("UPLOAD_MAX_OPS_BYTES", "268435456"),
            ("UPLOAD_MAX_OPS_BYTES", "67108865"),
        ] {
            assert!(
                matches!(load(&[(name, value)]), Err(ConfigError::Invalid(n, _)) if n == name),
                "{name}={value}"
            );
        }
    }

    #[test]
    fn purposes_round_trip() {
        for name in ["scan", "model", "texture", "ops", "script", "authored"] {
            assert_eq!(purpose_name(purpose_from_path(name).unwrap()), name);
        }
        assert!(purpose_from_path("exe").is_none());
    }
}
