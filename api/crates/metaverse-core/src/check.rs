//! 资源核对记录（GridFS `metadata.check`）与按角色判断（docs/SHAPES.md 第 8 节，
//! docs/design/server-slim.md 4.6）。
//!
//! `check` 由服务端在上传核对时从文件内容实测得到，只取决于文件内容，谁算都一样。引用一个资源时，
//! 先要属于本空间，再看它的 `check` 是否满足这个**角色**的条件（[`fits`]），不看第一次登记时记的
//! `metadata.kind`——别的空间可以抢先用别的用途登记同一份字节。上限按**当前配置**判断：调低上限
//! 以后，旧资源也可能不能再被新引用（已有提交不受影响）。
//!
//! 这里只有类型和判断；读文件、算 `check` 的检查器在接口服务（`runner/verify/`）。

use serde::{Deserialize, Serialize};

use crate::grid::Aabb;
use crate::limits::{GlbLimits, UploadLimits, GLB_EXTENSIONS_USED};

/// `check` 的格式版本。
pub const CHECK_VERSION: u32 = 1;

/// 模型与物件 `bounds` 的边长允许相差的绝对值（米）。
pub const MODEL_FIT_ABS: f64 = 0.02;
/// 模型与物件 `bounds` 的边长允许相差的比例（按物件 `bounds` 的边长）。
pub const MODEL_FIT_REL: f64 = 0.01;
/// 模型原点离底面中心的允许偏差（米）。
pub const MODEL_ORIGIN_TOLERANCE: f64 = 0.02;

/// glb 里的一张图片。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GlbImage {
    pub w: u32,
    pub h: u32,
    /// `image/png` 或 `image/jpeg`。
    pub mime: String,
}

/// glb 的核对记录。扫描用途的 glb 只做轻量检查，`triangles`、`bounds` 为空，因而不能当网页用模型或
/// 物件模型引用。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlbCheck {
    /// 场景里的三角形数（同一个网格被几个节点引用就算几次）。
    #[serde(default)]
    pub triangles: Option<u64>,
    pub nodes: u32,
    pub meshes: u32,
    pub materials: u32,
    #[serde(default)]
    pub images: Vec<GlbImage>,
    /// 单张图片的最大边长（没有图片时为 0）。
    #[serde(default)]
    pub max_texture_side: u32,
    /// 全部图片像素合计。
    #[serde(default)]
    pub texture_pixels: u64,
    /// `extensionsUsed`。
    #[serde(default)]
    pub extensions: Vec<String>,
    /// 实测的世界包围盒（米）。
    #[serde(default)]
    pub bounds: Option<Aabb>,
}

/// 图片（png、jpeg、webp）的核对记录。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageCheck {
    pub width: u32,
    pub height: u32,
}

/// 扫描 zip 的核对记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZipCheck {
    /// 唯一的网格成员（glb、drc、obj）的名称。
    pub mesh: String,
    /// 成员数（含忽略的 `__MACOSX/`、`.DS_Store`）。
    pub members: u32,
}

/// 各格式的核对内容，按 `format` 区分。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "format", rename_all = "lowercase")]
pub enum CheckBody {
    Glb(GlbCheck),
    Png(ImageCheck),
    Jpeg(ImageCheck),
    Webp(ImageCheck),
    Zip(ZipCheck),
    Drc {},
    Obj {},
    Ndjson {},
    /// gzip 压缩的 NDJSON（操作文件）。
    Gzip {},
    Text {},
    Json {},
}

impl CheckBody {
    pub fn format(&self) -> &'static str {
        match self {
            CheckBody::Glb(_) => "glb",
            CheckBody::Png(_) => "png",
            CheckBody::Jpeg(_) => "jpeg",
            CheckBody::Webp(_) => "webp",
            CheckBody::Zip(_) => "zip",
            CheckBody::Drc {} => "drc",
            CheckBody::Obj {} => "obj",
            CheckBody::Ndjson {} => "ndjson",
            CheckBody::Gzip {} => "gzip",
            CheckBody::Text {} => "text",
            CheckBody::Json {} => "json",
        }
    }
}

/// `metadata.check`：`{v, format, …}`。存储文档，读的时候容忍不认识的字段（先扩后收）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssetCheck {
    pub v: u32,
    #[serde(flatten)]
    pub body: CheckBody,
}

impl AssetCheck {
    pub fn new(body: CheckBody) -> Self {
        Self {
            v: CHECK_VERSION,
            body,
        }
    }
}

/// 资源被引用时的角色。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetRole {
    /// `setScan.scan.assetHash`。
    Scan,
    /// `setScan.scan.webModelHashes[]`。
    WebModel,
    /// 物件的 `assetHash`、事件显示的 `entityAsset`。
    Model,
    /// 形状材质的 `texture`、`normalMap`、`roughnessMap`，物件的 `textures`，方块贴图。
    Texture,
    /// 提交的 `scriptRef`、重建包的 `notes`（UTF-8 文本）。
    Script,
    /// 重建包清单（JSON）。
    Bundle,
    /// 操作文件（NDJSON，可 gzip）。
    Ops,
}

impl AssetRole {
    /// 上传用途按哪个角色检查上限（上传核对和"创建上传时直接复用"都用）。旧用途 `authored` 没有角色。
    pub fn for_purpose(purpose: crate::scope::UploadPurpose) -> Option<Self> {
        use crate::scope::UploadPurpose;
        match purpose {
            UploadPurpose::Scan => Some(AssetRole::Scan),
            UploadPurpose::WebModel => Some(AssetRole::WebModel),
            UploadPurpose::Model => Some(AssetRole::Model),
            UploadPurpose::Texture => Some(AssetRole::Texture),
            UploadPurpose::Ops => Some(AssetRole::Ops),
            UploadPurpose::Script => Some(AssetRole::Script),
            UploadPurpose::Bundle => Some(AssetRole::Bundle),
            UploadPurpose::Authored => None,
        }
    }
}

/// 资源的核对记录不合这个角色。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct CheckMismatch(pub String);

fn mismatch(message: impl Into<String>) -> Result<(), CheckMismatch> {
    Err(CheckMismatch(message.into()))
}

/// 一个核对记录能不能当某个角色用（docs/design/server-slim.md 4.6 的表）。
pub fn fits(
    role: AssetRole,
    check: &AssetCheck,
    limits: &UploadLimits,
) -> Result<(), CheckMismatch> {
    let format = check.body.format();
    match (role, &check.body) {
        (AssetRole::Scan, CheckBody::Glb(_) | CheckBody::Drc {} | CheckBody::Obj {}) => Ok(()),
        (AssetRole::Scan, CheckBody::Zip(zip)) if !zip.mesh.is_empty() => Ok(()),
        (AssetRole::Scan, _) => mismatch(format!(
            "{format} 不能当原始扫描（要 glb、drc、obj 或带网格的 zip）"
        )),
        (AssetRole::WebModel, CheckBody::Glb(glb)) => glb_fits(glb, &limits.webmodel, "网页用模型"),
        (AssetRole::Model, CheckBody::Glb(glb)) => glb_fits(glb, &limits.model, "物件模型"),
        (AssetRole::WebModel | AssetRole::Model, _) => {
            mismatch(format!("{format} 不能当模型（要 glb）"))
        }
        (
            AssetRole::Texture,
            CheckBody::Png(image) | CheckBody::Jpeg(image) | CheckBody::Webp(image),
        ) => {
            let texture = &limits.texture;
            if image.width.max(image.height) > texture.max_side {
                return mismatch(format!(
                    "贴图 {}×{} 超过边长上限 {}",
                    image.width, image.height, texture.max_side
                ));
            }
            if u64::from(image.width) * u64::from(image.height) > texture.max_pixels {
                return mismatch(format!(
                    "贴图 {}×{} 超过像素上限 {}",
                    image.width, image.height, texture.max_pixels
                ));
            }
            Ok(())
        }
        (AssetRole::Texture, _) => mismatch(format!("{format} 不能当贴图（要 png、jpeg 或 webp）")),
        (AssetRole::Script, CheckBody::Text {}) => Ok(()),
        (AssetRole::Script, _) => mismatch(format!("{format} 不能当文本")),
        (AssetRole::Bundle, CheckBody::Json {}) => Ok(()),
        (AssetRole::Bundle, _) => mismatch(format!("{format} 不能当重建包清单")),
        (AssetRole::Ops, CheckBody::Ndjson {} | CheckBody::Gzip {}) => Ok(()),
        (AssetRole::Ops, _) => mismatch(format!("{format} 不能当操作文件")),
    }
}

fn glb_fits(glb: &GlbCheck, limits: &GlbLimits, what: &str) -> Result<(), CheckMismatch> {
    let (Some(triangles), Some(bounds)) = (glb.triangles, glb.bounds) else {
        return mismatch(format!(
            "这个 glb 只做过扫描用途的轻量检查（没有三角形数和包围盒），不能当{what}"
        ));
    };
    if triangles > limits.max_triangles {
        return mismatch(format!(
            "{what}有 {triangles} 个三角形，超过上限 {}",
            limits.max_triangles
        ));
    }
    if glb.max_texture_side > limits.max_texture_side {
        return mismatch(format!(
            "{what}的贴图边长 {} 超过上限 {}",
            glb.max_texture_side, limits.max_texture_side
        ));
    }
    if glb.texture_pixels > limits.max_texture_pixels {
        return mismatch(format!(
            "{what}的贴图像素合计 {} 超过上限 {}",
            glb.texture_pixels, limits.max_texture_pixels
        ));
    }
    if !bounds.is_valid()
        || bounds
            .min
            .iter()
            .chain(bounds.max.iter())
            .any(|v| v.abs() > limits.max_coord)
    {
        return mismatch(format!("{what}的坐标超出 ±{} 米", limits.max_coord));
    }
    if let Some(extension) = glb
        .extensions
        .iter()
        .find(|name| !GLB_EXTENSIONS_USED.contains(&name.as_str()))
    {
        return mismatch(format!("{what}用了不支持的扩展 {extension}"));
    }
    Ok(())
}

/// 只有模型、没有形状的物件：模型的实测包围盒与物件 `bounds` 一致（docs/design/server-slim.md
/// 2.5 第 5 条）。三边长之差不超过 max(2 厘米, 物件边长的 1%)，模型原点在底面中心
/// （`|min.y|`、x 和 z 的中点都不超过 2 厘米）。网站按 `bounds` 的底面中心摆放只有模型的物件，
/// 这条保证摆出来和记录一致，范围检查用的 `bounds` 也就是真实的。
pub fn model_fits_bounds(model: &Aabb, entity: &Aabb) -> Result<(), CheckMismatch> {
    for axis in 0..3 {
        let model_side = model.max[axis] - model.min[axis];
        let entity_side = entity.max[axis] - entity.min[axis];
        let tolerance = MODEL_FIT_ABS.max(MODEL_FIT_REL * entity_side.abs());
        if (model_side - entity_side).abs() > tolerance {
            return mismatch(format!(
                "模型的实测尺寸 {:.3} 米与物件 bounds 的 {:.3} 米相差超过 {:.3} 米（第 {} 轴）",
                model_side,
                entity_side,
                tolerance,
                ["x", "y", "z"][axis]
            ));
        }
    }
    let center_x = (model.min[0] + model.max[0]) / 2.0;
    let center_z = (model.min[2] + model.max[2]) / 2.0;
    if model.min[1].abs() > MODEL_ORIGIN_TOLERANCE
        || center_x.abs() > MODEL_ORIGIN_TOLERANCE
        || center_z.abs() > MODEL_ORIGIN_TOLERANCE
    {
        return mismatch("模型的原点要在底面中心（导出时把节点变换烘进顶点，原点放在底面中心）");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn glb(extra: serde_json::Value) -> AssetCheck {
        let mut value = json!({"v": 1, "format": "glb", "triangles": 1200, "nodes": 3, "meshes": 1,
            "materials": 1, "images": [{"w": 1024, "h": 512, "mime": "image/png"}],
            "maxTextureSide": 1024, "texturePixels": 524288, "extensions": ["KHR_texture_transform"],
            "bounds": {"min": [-0.5, 0, -0.4], "max": [0.5, 0.9, 0.4]}});
        for (key, item) in extra.as_object().unwrap() {
            value[key] = item.clone();
        }
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn check_documents_round_trip() {
        for value in [
            json!({"v": 1, "format": "png", "width": 4096, "height": 2048}),
            json!({"v": 1, "format": "zip", "mesh": "mesh.drc", "members": 3}),
            json!({"v": 1, "format": "drc"}),
            json!({"v": 1, "format": "text"}),
            json!({"v": 1, "format": "glb", "triangles": null, "nodes": 1, "meshes": 1,
                "materials": 0, "images": [], "maxTextureSide": 0, "texturePixels": 0,
                "extensions": [], "bounds": null}),
        ] {
            let check: AssetCheck = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(&check).unwrap(), value);
        }
        // 新版本写的字段，旧版本也能读。
        let newer: AssetCheck =
            serde_json::from_value(json!({"v": 2, "format": "text", "encoding": "utf-8"})).unwrap();
        assert_eq!(newer.body, CheckBody::Text {});
        assert!(serde_json::from_value::<AssetCheck>(json!({"v": 1, "format": "gif"})).is_err());
    }

    #[test]
    fn roles() {
        let limits = UploadLimits::default();
        let model = glb(json!({}));
        assert!(fits(AssetRole::Model, &model, &limits).is_ok());
        assert!(fits(AssetRole::WebModel, &model, &limits).is_ok());
        assert!(fits(AssetRole::Scan, &model, &limits).is_ok());
        assert!(fits(AssetRole::Texture, &model, &limits).is_err());
        // 网页用模型的上限比物件模型宽。
        let big = glb(json!({"triangles": 300_000}));
        assert!(fits(AssetRole::WebModel, &big, &limits).is_ok());
        assert!(fits(AssetRole::Model, &big, &limits).is_err());
        let far = glb(json!({"bounds": {"min": [-5000, 0, 0], "max": [0, 1, 1]}}));
        assert!(fits(AssetRole::WebModel, &far, &limits).is_ok());
        assert!(fits(AssetRole::Model, &far, &limits).is_err());
        for bad in [
            json!({"maxTextureSide": 4096}),
            json!({"texturePixels": 4 * 2048 * 2048 + 1}),
            json!({"extensions": ["KHR_lights_punctual"]}),
            json!({"triangles": null}),
            json!({"bounds": null}),
        ] {
            assert!(
                fits(AssetRole::Model, &glb(bad.clone()), &limits).is_err(),
                "{bad}"
            );
        }
        // 扫描用途的轻量检查（没有三角形和包围盒）只能当扫描。
        let light = glb(json!({"triangles": null, "bounds": null}));
        assert!(fits(AssetRole::Scan, &light, &limits).is_ok());
        assert!(fits(AssetRole::WebModel, &light, &limits).is_err());
        let image = |w: u32, h: u32| {
            AssetCheck::new(CheckBody::Webp(ImageCheck {
                width: w,
                height: h,
            }))
        };
        assert!(fits(AssetRole::Texture, &image(4096, 4096), &limits).is_ok());
        assert!(fits(AssetRole::Texture, &image(4097, 16), &limits).is_err());
        assert!(fits(AssetRole::Model, &image(16, 16), &limits).is_err());
        let zip = AssetCheck::new(CheckBody::Zip(ZipCheck {
            mesh: "mesh.drc".into(),
            members: 2,
        }));
        assert!(fits(AssetRole::Scan, &zip, &limits).is_ok());
        assert!(fits(AssetRole::Model, &zip, &limits).is_err());
        let text = AssetCheck::new(CheckBody::Text {});
        assert!(fits(AssetRole::Script, &text, &limits).is_ok());
        assert!(fits(AssetRole::Bundle, &text, &limits).is_err());
        assert!(fits(
            AssetRole::Bundle,
            &AssetCheck::new(CheckBody::Json {}),
            &limits
        )
        .is_ok());
        assert!(fits(
            AssetRole::Ops,
            &AssetCheck::new(CheckBody::Gzip {}),
            &limits
        )
        .is_ok());
        assert!(fits(AssetRole::Ops, &text, &limits).is_err());
        // 调低上限以后，旧资源不能再被新引用。
        let mut strict = limits;
        strict.texture.max_side = 2048;
        assert!(fits(AssetRole::Texture, &image(4096, 16), &strict).is_err());
    }

    #[test]
    fn model_bounds_consistency() {
        let entity = Aabb {
            min: [1.0, 0.0, 2.0],
            max: [3.0, 0.8, 3.0],
        };
        let model = |min: [f64; 3], max: [f64; 3]| Aabb { min, max };
        assert!(model_fits_bounds(&model([-1.0, 0.0, -0.5], [1.0, 0.8, 0.5]), &entity).is_ok());
        // 差 2 厘米以内可以，超过不行（2 米边长的 1% 也是 2 厘米）。
        assert!(model_fits_bounds(&model([-1.0, 0.0, -0.5], [1.0, 0.819, 0.5]), &entity).is_ok());
        assert!(model_fits_bounds(&model([-1.0, 0.0, -0.5], [1.0, 0.83, 0.5]), &entity).is_err());
        // 原点不在底面中心。
        assert!(model_fits_bounds(&model([0.0, 0.0, -0.5], [2.0, 0.8, 0.5]), &entity).is_err());
        assert!(model_fits_bounds(&model([-1.0, 0.1, -0.5], [1.0, 0.9, 0.5]), &entity).is_err());
        // 大物件按 1% 算：10 米的墙差 8 厘米可以。
        let wall = Aabb {
            min: [0.0, 0.0, 0.0],
            max: [10.0, 3.0, 0.2],
        };
        assert!(model_fits_bounds(&model([-5.04, 0.0, -0.1], [5.04, 3.0, 0.1]), &wall).is_ok());
        assert!(model_fits_bounds(&model([-5.06, 0.0, -0.1], [5.06, 3.0, 0.1]), &wall).is_err());
    }
}
