//! 上传、任务、事件、组合用到的配置和进程内状态（与路由、数据访问分开，便于测试）。
//!
//! 各用途的上限（docs/design/server-slim.md 4.4、4.9；默认值取核心库 `metaverse_core::limits`）：
//!
//! | 变量 | 默认 | 说明 |
//! |---|---|---|
//! | `UPLOAD_MAX_SCAN_BYTES` | 1 GiB | 原始扫描（只经重建路径上传；旧的扫描导入删掉之前实体区路径照旧收） |
//! | `UPLOAD_MAX_WEBMODEL_BYTES` | 64 MiB | 网页用模型（glb） |
//! | `UPLOAD_WEBMODEL_MAX_TRIANGLES` | 500000 | 网页用模型的三角形数 |
//! | `UPLOAD_WEBMODEL_MAX_TEXTURE_SIDE` | 4096 | 网页用模型里单张贴图的边长 |
//! | `UPLOAD_WEBMODEL_MAX_TEXTURE_PIXELS` | 2 × 4096² | 网页用模型里全部贴图的像素合计 |
//! | `UPLOAD_MAX_MODEL_BYTES` | 50 MiB | 物件模型（glb） |
//! | `UPLOAD_MODEL_MAX_TRIANGLES` | 100000 | 物件模型的三角形数（含义从"重新导出的上限"变成"接受的上限"） |
//! | `UPLOAD_MODEL_MAX_TEXTURE_SIDE` | 2048 | 物件模型里单张贴图的边长 |
//! | `UPLOAD_MODEL_MAX_TEXTURE_PIXELS` | 4 × 2048² | 物件模型里全部贴图的像素合计 |
//! | `UPLOAD_MAX_TEXTURE_BYTES` | 50 MiB | 单张贴图的文件大小 |
//! | `UPLOAD_MAX_TEXTURE_SIDE` | 4096 | 贴图单边像素上限（很多手机的贴图上限；收到第 0 片时按文件头检查，读不到的留给后台核对） |
//! | `UPLOAD_MAX_TEXTURE_PIXELS` | 4096² | 贴图像素上限 |
//! | `UPLOAD_MAX_OPS_BYTES` | 64 MiB | 大批量操作（NDJSON，可 gzip）；不能超过 `MAX_OPS_FILE_BYTES`（64 MiB），否则启动失败 |
//! | `UPLOAD_MAX_SCRIPT_BYTES` | 4 MiB | 建造脚本、建模记录（纯文本） |
//! | `UPLOAD_MAX_BUNDLE_BYTES` | 16 MiB | 重建包清单（JSON） |
//! | `UPLOAD_SCAN_FORMATS` | `glb,drc,obj,zip` | 扫描用途接受的格式（zip = 模型 + 贴图，例如 Scaniverse 导出） |
//! | `UPLOAD_MODEL_FORMATS` | `glb` | 物件模型用途接受的格式：只能是 `glb` |
//! | `UPLOAD_TEXTURE_FORMATS` | `png,jpeg,webp` | 贴图用途接受的格式 |
//! | `UPLOAD_MAX_OPEN_PER_SPACE` | 16 | 每个空间同时进行中的上传数，超过返回 429 |
//! | `UPLOAD_MAX_CONCURRENT_PARTS` | 8 | 本进程同时处理的分片数（每片最多 32MiB 在内存里；部署时写 4） |
//! | `JOB_MAX_PENDING_PER_SPACE` | 8 | 每个空间同时排队和运行的任务数，超过返回 429 |
//!
//! ops 用途固定接受 `ndjson`、`gzip`，script 用途固定接受 `text`，网页用模型固定接受 `glb`，
//! 重建包清单固定接受 `json`。glb JSON 块、zip 中央目录的上限和坐标上限是核心库常量，不开放配置。

use std::sync::Arc;
use std::time::Duration;

use metaverse_core::authored::MAX_AUTHORED_BYTES;
use metaverse_core::limits::{
    GlbLimits, ImageLimits, SizeLimit, UploadLimits, DEFAULT_MAX_BUNDLE_BYTES,
    DEFAULT_MAX_SCAN_BYTES, DEFAULT_MAX_SCRIPT_BYTES, DEFAULT_MODEL, DEFAULT_TEXTURE,
    DEFAULT_WEBMODEL, UPLOAD_LIMITS_VERSION,
};
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
    pub max_webmodel_bytes: u64,
    pub webmodel_max_triangles: u64,
    pub webmodel_max_texture_side: u64,
    pub webmodel_max_texture_pixels: u64,
    pub max_model_bytes: u64,
    pub model_max_triangles: u64,
    pub model_max_texture_side: u64,
    pub model_max_texture_pixels: u64,
    pub max_texture_bytes: u64,
    pub max_texture_side: u64,
    pub max_texture_pixels: u64,
    pub max_ops_bytes: u64,
    pub max_script_bytes: u64,
    pub max_bundle_bytes: u64,
    pub scan_formats: Vec<UploadFormat>,
    pub model_formats: Vec<UploadFormat>,
    pub texture_formats: Vec<UploadFormat>,
    pub max_open_uploads_per_space: u64,
    pub max_concurrent_parts: usize,
    pub max_pending_jobs_per_space: u64,
}

/// 扫描接受的格式（zip 是模型 + 贴图的打包）。
const SCAN_FORMATS: [UploadFormat; 4] = [
    UploadFormat::Glb,
    UploadFormat::Drc,
    UploadFormat::Obj,
    UploadFormat::Zip,
];

/// 贴图接受的格式。
const TEXTURE_FORMATS: [UploadFormat; 3] =
    [UploadFormat::Png, UploadFormat::Jpeg, UploadFormat::Webp];

impl Default for IngestConfig {
    fn default() -> Self {
        Self {
            max_scan_bytes: DEFAULT_MAX_SCAN_BYTES,
            max_webmodel_bytes: DEFAULT_WEBMODEL.max_bytes,
            webmodel_max_triangles: DEFAULT_WEBMODEL.max_triangles,
            webmodel_max_texture_side: u64::from(DEFAULT_WEBMODEL.max_texture_side),
            webmodel_max_texture_pixels: DEFAULT_WEBMODEL.max_texture_pixels,
            max_model_bytes: DEFAULT_MODEL.max_bytes,
            model_max_triangles: DEFAULT_MODEL.max_triangles,
            model_max_texture_side: u64::from(DEFAULT_MODEL.max_texture_side),
            model_max_texture_pixels: DEFAULT_MODEL.max_texture_pixels,
            max_texture_bytes: DEFAULT_TEXTURE.max_bytes,
            max_texture_side: u64::from(DEFAULT_TEXTURE.max_side),
            max_texture_pixels: DEFAULT_TEXTURE.max_pixels,
            // 处理时整份读入内存（解压后另有 256 MiB 上限），上传上限不能比它大。
            max_ops_bytes: MAX_OPS_FILE_BYTES,
            max_script_bytes: DEFAULT_MAX_SCRIPT_BYTES,
            max_bundle_bytes: DEFAULT_MAX_BUNDLE_BYTES,
            scan_formats: SCAN_FORMATS.to_vec(),
            model_formats: vec![UploadFormat::Glb],
            texture_formats: TEXTURE_FORMATS.to_vec(),
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
        let formats = |name: &'static str, default: &[UploadFormat], allowed: &[UploadFormat]| {
            match optional(name) {
                None => Ok(default.to_vec()),
                Some(text) => {
                    let mut list = Vec::new();
                    for item in text.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                        let format = UploadFormat::from_name(item)
                            .filter(|format| allowed.contains(format))
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
            }
        };
        const TIB: u64 = 1 << 40;
        const SIDE: u64 = 1 << 16;
        const PIXELS: u64 = 1 << 32;
        Ok(Self {
            max_scan_bytes: number("UPLOAD_MAX_SCAN_BYTES", defaults.max_scan_bytes, 1, TIB)?,
            max_webmodel_bytes: number(
                "UPLOAD_MAX_WEBMODEL_BYTES",
                defaults.max_webmodel_bytes,
                1,
                TIB,
            )?,
            webmodel_max_triangles: number(
                "UPLOAD_WEBMODEL_MAX_TRIANGLES",
                defaults.webmodel_max_triangles,
                1,
                1 << 32,
            )?,
            webmodel_max_texture_side: number(
                "UPLOAD_WEBMODEL_MAX_TEXTURE_SIDE",
                defaults.webmodel_max_texture_side,
                1,
                SIDE,
            )?,
            webmodel_max_texture_pixels: number(
                "UPLOAD_WEBMODEL_MAX_TEXTURE_PIXELS",
                defaults.webmodel_max_texture_pixels,
                1,
                PIXELS,
            )?,
            max_model_bytes: number("UPLOAD_MAX_MODEL_BYTES", defaults.max_model_bytes, 1, TIB)?,
            model_max_triangles: number(
                "UPLOAD_MODEL_MAX_TRIANGLES",
                defaults.model_max_triangles,
                1,
                1 << 32,
            )?,
            model_max_texture_side: number(
                "UPLOAD_MODEL_MAX_TEXTURE_SIDE",
                defaults.model_max_texture_side,
                1,
                SIDE,
            )?,
            model_max_texture_pixels: number(
                "UPLOAD_MODEL_MAX_TEXTURE_PIXELS",
                defaults.model_max_texture_pixels,
                1,
                PIXELS,
            )?,
            max_texture_bytes: number(
                "UPLOAD_MAX_TEXTURE_BYTES",
                defaults.max_texture_bytes,
                1,
                TIB,
            )?,
            max_texture_side: number(
                "UPLOAD_MAX_TEXTURE_SIDE",
                defaults.max_texture_side,
                1,
                SIDE,
            )?,
            max_texture_pixels: number(
                "UPLOAD_MAX_TEXTURE_PIXELS",
                defaults.max_texture_pixels,
                1,
                PIXELS,
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
            max_bundle_bytes: number(
                "UPLOAD_MAX_BUNDLE_BYTES",
                defaults.max_bundle_bytes,
                1,
                DEFAULT_MAX_BUNDLE_BYTES,
            )?,
            scan_formats: formats("UPLOAD_SCAN_FORMATS", &defaults.scan_formats, &SCAN_FORMATS)?,
            // 物件模型只收 glb（docs/design/server-slim.md 2.2）：这个配置项保留，但只能写 glb。
            model_formats: formats(
                "UPLOAD_MODEL_FORMATS",
                &defaults.model_formats,
                &[UploadFormat::Glb],
            )?,
            texture_formats: formats(
                "UPLOAD_TEXTURE_FORMATS",
                &defaults.texture_formats,
                &TEXTURE_FORMATS,
            )?,
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
            UploadPurpose::WebModel => self.max_webmodel_bytes,
            UploadPurpose::Model => self.max_model_bytes,
            UploadPurpose::Texture => self.max_texture_bytes,
            UploadPurpose::Ops => self.max_ops_bytes,
            UploadPurpose::Script => self.max_script_bytes,
            UploadPurpose::Bundle => self.max_bundle_bytes,
            UploadPurpose::Authored => MAX_AUTHORED_BYTES,
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

    /// 当前生效的各用途上限（核对上传、按角色判断引用、`uploadLimits` 都用这一份）。坐标上限是
    /// 核心库常量。
    pub fn upload_limits(&self) -> UploadLimits {
        let side = |value: u64| u32::try_from(value).unwrap_or(u32::MAX);
        UploadLimits {
            v: UPLOAD_LIMITS_VERSION,
            scan: SizeLimit {
                max_bytes: self.max_scan_bytes,
            },
            webmodel: GlbLimits {
                max_bytes: self.max_webmodel_bytes,
                max_triangles: self.webmodel_max_triangles,
                max_texture_side: side(self.webmodel_max_texture_side),
                max_texture_pixels: self.webmodel_max_texture_pixels,
                max_coord: DEFAULT_WEBMODEL.max_coord,
            },
            model: GlbLimits {
                max_bytes: self.max_model_bytes,
                max_triangles: self.model_max_triangles,
                max_texture_side: side(self.model_max_texture_side),
                max_texture_pixels: self.model_max_texture_pixels,
                max_coord: DEFAULT_MODEL.max_coord,
            },
            texture: ImageLimits {
                max_bytes: self.max_texture_bytes,
                max_side: side(self.max_texture_side),
                max_pixels: self.max_texture_pixels,
            },
            ops: SizeLimit {
                max_bytes: self.max_ops_bytes,
            },
            script: SizeLimit {
                max_bytes: self.max_script_bytes,
            },
            bundle: SizeLimit {
                max_bytes: self.max_bundle_bytes,
            },
        }
    }
}

/// 路径里的用途名。
pub fn purpose_from_path(value: &str) -> Option<UploadPurpose> {
    UploadPurpose::from_name(value)
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
        // 默认值与核心库的默认上限一致（命令行没有 limits.json 时用的也是这一份）。
        assert_eq!(config.upload_limits(), UploadLimits::default());
        assert_eq!(config.max_texture_side, 4096);
        assert_eq!(config.formats(UploadPurpose::Model), [UploadFormat::Glb]);
        assert_eq!(config.formats(UploadPurpose::WebModel), [UploadFormat::Glb]);
        assert_eq!(config.max_bytes(UploadPurpose::WebModel), 64 << 20);
        assert_eq!(config.max_bytes(UploadPurpose::Bundle), 16 << 20);
    }

    #[test]
    fn upload_limits_follow_the_configuration() {
        let config = load(&[
            ("UPLOAD_MODEL_MAX_TRIANGLES", "5000"),
            ("UPLOAD_WEBMODEL_MAX_TEXTURE_SIDE", "2048"),
            ("UPLOAD_MAX_TEXTURE_PIXELS", "1000"),
            ("UPLOAD_MAX_BUNDLE_BYTES", "1024"),
        ])
        .unwrap();
        let limits = config.upload_limits();
        assert_eq!(limits.model.max_triangles, 5000);
        assert_eq!(limits.webmodel.max_texture_side, 2048);
        assert_eq!(limits.texture.max_pixels, 1000);
        assert_eq!(limits.bundle.max_bytes, 1024);
        for (name, value) in [
            // 物件模型只收 glb。
            ("UPLOAD_MODEL_FORMATS", "glb,drc"),
            ("UPLOAD_MODEL_FORMATS", "zip"),
            ("UPLOAD_MODEL_MAX_TRIANGLES", "0"),
            // 清单的上限不能比核心库的 16 MiB 大（交包时整份读入）。
            ("UPLOAD_MAX_BUNDLE_BYTES", "16777217"),
        ] {
            assert!(
                matches!(load(&[(name, value)]), Err(ConfigError::Invalid(n, _)) if n == name),
                "{name}={value}"
            );
        }
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
        for name in [
            "scan", "webmodel", "model", "texture", "ops", "script", "bundle", "authored",
        ] {
            assert_eq!(purpose_name(purpose_from_path(name).unwrap()), name);
        }
        assert!(purpose_from_path("exe").is_none());
    }
}
