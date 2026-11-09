//! 各用途的上传上限（docs/SHAPES.md 第 8 节，docs/design/server-slim.md 4.4、4.9）。
//!
//! 这里只有默认值和形状：接口服务的配置项（`UPLOAD_MAX_*`、`UPLOAD_*_MAX_*`）以这些值为默认，
//! `GET /api/v1/spaces/{space_id}` 的 `uploadLimits` 按 [`UploadLimits`] 的形状返回当前生效的值，
//! 命令行写进工作区的 `limits.json`，本地工具和命令行据此提前检查。没有 `limits.json` 时，
//! 本地工具和命令行用与这里相同的默认值（TypeScript `sdk/typescript/src/core/limits.ts`，向量
//! `tests/vectors/bundle/limits_default.json` 核对两边一致）。
//!
//! glb 的 JSON 块上限、zip 中央目录的上限、glb 各数组的长度上限是固定常量，不开放配置。

use serde::{Deserialize, Serialize};

use crate::scope::UploadPurpose;

const KIB: u64 = 1024;
const MIB: u64 = 1024 * KIB;
const GIB: u64 = 1024 * MIB;

/// `uploadLimits` 的格式版本。
pub const UPLOAD_LIMITS_VERSION: u32 = 1;

/// 只有大小上限的用途（扫描、操作文件、建模记录、重建包清单）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SizeLimit {
    pub max_bytes: u64,
}

/// glb 的上限（网页用模型、物件模型）：大小、三角形数、单张贴图边长、全部贴图像素合计、
/// 坐标绝对值（米，按实测的世界包围盒查）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlbLimits {
    pub max_bytes: u64,
    pub max_triangles: u64,
    pub max_texture_side: u32,
    pub max_texture_pixels: u64,
    pub max_coord: f64,
}

/// 贴图的上限：大小、边长、像素数。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageLimits {
    pub max_bytes: u64,
    pub max_side: u32,
    pub max_pixels: u64,
}

/// 各用途的上限（`uploadLimits`、工作区的 `limits.json`）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadLimits {
    /// 格式版本，目前是 1。
    pub v: u32,
    pub scan: SizeLimit,
    pub webmodel: GlbLimits,
    pub model: GlbLimits,
    pub texture: ImageLimits,
    pub ops: SizeLimit,
    pub script: SizeLimit,
    pub bundle: SizeLimit,
}

/// 原始扫描：1 GiB。
pub const DEFAULT_MAX_SCAN_BYTES: u64 = GIB;
/// 网页用模型：64 MiB、50 万个三角形、贴图边长 4096、像素合计 2 × 4096²、坐标 ≤ 100000 米（保持扫描原坐标）。
pub const DEFAULT_WEBMODEL: GlbLimits = GlbLimits {
    max_bytes: 64 * MIB,
    max_triangles: 500_000,
    max_texture_side: 4096,
    max_texture_pixels: 2 * 4096 * 4096,
    max_coord: 100_000.0,
};
/// 物件模型：50 MiB、10 万个三角形、贴图边长 2048、像素合计 4 × 2048²、坐标 ≤ 1000 米。
pub const DEFAULT_MODEL: GlbLimits = GlbLimits {
    max_bytes: 50 * MIB,
    max_triangles: 100_000,
    max_texture_side: 2048,
    max_texture_pixels: 4 * 2048 * 2048,
    max_coord: 1000.0,
};
/// 贴图：50 MiB、边长 4096（很多手机的贴图上限）、像素 4096²。
pub const DEFAULT_TEXTURE: ImageLimits = ImageLimits {
    max_bytes: 50 * MIB,
    max_side: 4096,
    max_pixels: 4096 * 4096,
};
/// 操作文件（压缩后）：64 MiB。
pub const DEFAULT_MAX_OPS_BYTES: u64 = 64 * MIB;
/// 建模记录等文本：4 MiB。
pub const DEFAULT_MAX_SCRIPT_BYTES: u64 = 4 * MIB;
/// 重建包清单：16 MiB。
pub const DEFAULT_MAX_BUNDLE_BYTES: u64 = 16 * MIB;

/// 操作文件解压后的上限：256 MiB。
pub const MAX_OPS_INFLATED_BYTES: u64 = 256 * MIB;
/// 操作文件、重建包清单里每行 / 每条记录的上限：64 KiB。
pub const MAX_RECORD_BYTES: usize = 64 * 1024;

/// glb JSON 块的上限：扫描 8 MiB、网页用模型 4 MiB、物件模型 2 MiB。
pub const GLB_JSON_SCAN_BYTES: u64 = 8 * MIB;
pub const GLB_JSON_WEBMODEL_BYTES: u64 = 4 * MIB;
pub const GLB_JSON_MODEL_BYTES: u64 = 2 * MIB;

/// glb JSON 里各数组的长度上限（带类型解析时检查）。
pub const GLB_MAX_NODES: usize = 10_000;
pub const GLB_MAX_MESHES: usize = 1000;
pub const GLB_MAX_PRIMITIVES_PER_MESH: usize = 256;
pub const GLB_MAX_ACCESSORS: usize = 20_000;
pub const GLB_MAX_BUFFER_VIEWS: usize = 20_000;
pub const GLB_MAX_MATERIALS: usize = 256;
pub const GLB_MAX_TEXTURES: usize = 256;
pub const GLB_MAX_IMAGES: usize = 64;
pub const GLB_MAX_SCENES: usize = 16;

/// zip（扫描）中央目录的上限：≤ 1 MiB、≤ 64 个成员，不收 zip64。
pub const ZIP_MAX_CENTRAL_DIRECTORY_BYTES: u64 = MIB;
pub const ZIP_MAX_MEMBERS: usize = 64;

/// glb 允许的扩展（`extensionsUsed`、各对象上的 `extensions` 键）。
pub const GLB_EXTENSIONS_USED: [&str; 4] = [
    "KHR_texture_transform",
    "KHR_mesh_quantization",
    "KHR_materials_unlit",
    "KHR_materials_emissive_strength",
];
/// glb 允许的 `extensionsRequired`。
pub const GLB_EXTENSIONS_REQUIRED: [&str; 2] = ["KHR_texture_transform", "KHR_mesh_quantization"];

impl Default for UploadLimits {
    fn default() -> Self {
        Self {
            v: UPLOAD_LIMITS_VERSION,
            scan: SizeLimit {
                max_bytes: DEFAULT_MAX_SCAN_BYTES,
            },
            webmodel: DEFAULT_WEBMODEL,
            model: DEFAULT_MODEL,
            texture: DEFAULT_TEXTURE,
            ops: SizeLimit {
                max_bytes: DEFAULT_MAX_OPS_BYTES,
            },
            script: SizeLimit {
                max_bytes: DEFAULT_MAX_SCRIPT_BYTES,
            },
            bundle: SizeLimit {
                max_bytes: DEFAULT_MAX_BUNDLE_BYTES,
            },
        }
    }
}

impl UploadLimits {
    /// 某用途的大小上限；`authored` 不能再上传，返回 `None`。
    pub fn max_bytes(&self, purpose: UploadPurpose) -> Option<u64> {
        match purpose {
            UploadPurpose::Scan => Some(self.scan.max_bytes),
            UploadPurpose::WebModel => Some(self.webmodel.max_bytes),
            UploadPurpose::Model => Some(self.model.max_bytes),
            UploadPurpose::Texture => Some(self.texture.max_bytes),
            UploadPurpose::Ops => Some(self.ops.max_bytes),
            UploadPurpose::Script => Some(self.script.max_bytes),
            UploadPurpose::Bundle => Some(self.bundle.max_bytes),
            UploadPurpose::Authored => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_the_design() {
        let limits = UploadLimits::default();
        assert_eq!(limits.max_bytes(UploadPurpose::Scan), Some(1 << 30));
        assert_eq!(limits.max_bytes(UploadPurpose::WebModel), Some(64 << 20));
        assert_eq!(limits.max_bytes(UploadPurpose::Model), Some(50 << 20));
        assert_eq!(limits.max_bytes(UploadPurpose::Texture), Some(50 << 20));
        assert_eq!(limits.max_bytes(UploadPurpose::Ops), Some(64 << 20));
        assert_eq!(limits.max_bytes(UploadPurpose::Script), Some(4 << 20));
        assert_eq!(limits.max_bytes(UploadPurpose::Bundle), Some(16 << 20));
        assert_eq!(limits.max_bytes(UploadPurpose::Authored), None);
        assert_eq!(limits.texture.max_side, 4096);
        assert_eq!(limits.webmodel.max_texture_pixels, 2 * 4096 * 4096);
        assert_eq!(limits.model.max_texture_pixels, 4 * 2048 * 2048);
    }

    #[test]
    fn json_shape() {
        let value = serde_json::to_value(UploadLimits::default()).unwrap();
        assert_eq!(value["v"], 1);
        assert_eq!(value["webmodel"]["maxTriangles"], 500_000);
        assert_eq!(value["model"]["maxCoord"], json!(1000.0));
        assert_eq!(value["texture"]["maxPixels"], 4096 * 4096);
        assert_eq!(value["bundle"], json!({"maxBytes": 16 << 20}));
        let back: UploadLimits = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(back, UploadLimits::default());
        let mut extra = value;
        extra["scan"]["maxTriangles"] = json!(1);
        assert!(serde_json::from_value::<UploadLimits>(extra).is_err());
    }
}
