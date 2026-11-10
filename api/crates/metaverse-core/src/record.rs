//! 物件和锚点记录（设计 4.4、SHAPES 3）。
//!
//! 两者都按"版本记录 + 当前状态"存储：`records { _id: 内容哈希, kind, spaceId, body }`。
//! 内容哈希 = `{"body": …, "kind": …, "spaceId": …}` 的规范化 JSON 的 sha256，
//! 把空间编号算进去，同样的 body 在不同空间里是不同的记录。

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::canonical::{canonical_json_of, content_hash, CanonicalError};
use crate::grid::{Aabb, GridBox};
use crate::ids::{is_object_id, SPACE_ANCHOR_ID};
use crate::is_sha256_hex;
use crate::model::{DataVisibility, Layer};
use crate::shape::{Shading, Shape, TemplateSource, Transform};

/// 物件 `props` 规范化后的最大字节数。
pub const MAX_PROPS_BYTES: usize = 16 * 1024;
/// 标签最大字符数。
pub const MAX_LABEL_CHARS: usize = 200;
/// 声明的包围盒允许比计算结果小这么多（米），用来吸收浮点误差。
pub const BOUNDS_TOLERANCE: f64 = 1e-6;
/// 重建层新放的物件（含模板）编号的前缀；扩展层新放的物件不能用它（docs/design/server-slim.md
/// 2.5 第 1 条）。物件和模板共用一个编号空间，两层各用一段，地块合作方抢不走重建包要用的编号。
pub const REBUILT_ID_PREFIX: &str = "rb.";

/// 编号是不是重建层的编号（以 [`REBUILT_ID_PREFIX`] 开头）。
pub fn is_rebuilt_id(id: &str) -> bool {
    id.starts_with(REBUILT_ID_PREFIX)
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RecordError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Shape(#[from] crate::shape::ShapeError),
    #[error(transparent)]
    Canonical(#[from] CanonicalError),
}

fn invalid(message: impl Into<String>) -> RecordError {
    RecordError::Invalid(message.into())
}

/// 物件类型。结构元素（墙、地面、玻璃）也是物件；模板也存成物件。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntityKind {
    Structure,
    Object,
    Template,
}

/// 拟合质量（可选）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fit {
    pub mean_cm: f64,
    pub p90_cm: f64,
    pub coverage3cm: f64,
}

/// 外部模型的可选库（SHAPES 3）。
pub const SOURCE_LIBRARIES: [&str; 3] = ["polyhaven", "objaverse", "sketchfab"];
/// 外部模型允许的许可：明确可商用、不传染（NC、ND、SA 一律排除）。
pub const SOURCE_LICENSES: [&str; 3] = ["CC0-1.0", "CC-BY-4.0", "CC-BY-3.0"];
/// 来源里编号、作者、标题的最大字符数。
pub const MAX_SOURCE_TEXT_CHARS: usize = 200;
/// 来源页地址的最大字符数。
pub const MAX_SOURCE_URL_CHARS: usize = 2000;

/// 外部模型的来源（`props.source` 是对象时），网站据此显示署名。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelSource {
    pub library: String,
    pub id: String,
    /// 来源页（https 地址）。
    pub page: String,
    pub author: String,
    /// SPDX 风格的许可名，只能是 [`SOURCE_LICENSES`] 之一。
    pub license: String,
    pub title: String,
}

impl ModelSource {
    pub fn validate(&self) -> Result<(), RecordError> {
        if !SOURCE_LIBRARIES.contains(&self.library.as_str()) {
            return Err(invalid(
                "props.source.library 只能是 polyhaven、objaverse 或 sketchfab",
            ));
        }
        if !SOURCE_LICENSES.contains(&self.license.as_str()) {
            return Err(invalid(
                "props.source.license 只能是 CC0-1.0、CC-BY-4.0 或 CC-BY-3.0（可商用、不传染）",
            ));
        }
        for (name, text) in [
            ("id", &self.id),
            ("author", &self.author),
            ("title", &self.title),
        ] {
            let chars = text.chars().count();
            if chars == 0 || chars > MAX_SOURCE_TEXT_CHARS || text.chars().any(char::is_control) {
                return Err(invalid(format!(
                    "props.source.{name} 必须是 1 到 200 个字符，不含控制字符"
                )));
            }
        }
        if !is_https_url(&self.page) {
            return Err(invalid(
                "props.source.page 必须是 https 地址（不超过 2000 个字符，不含空白和控制字符）",
            ));
        }
        Ok(())
    }
}

/// 来源页地址：`https://` 开头、后面至少一个字符，不超过 2000 个字符，不含空白和控制字符。
pub fn is_https_url(url: &str) -> bool {
    url.len() > "https://".len()
        && url.starts_with("https://")
        && url.chars().count() <= MAX_SOURCE_URL_CHARS
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// `props` 里有结构的键：`source` 是对象时按 [`ModelSource`] 校验。
/// 不是对象的 `source`（旧数据里识别来源的字符串 `hint` / `rules`）照旧当不透明的值。
pub fn validate_props(props: &Map<String, Value>) -> Result<(), RecordError> {
    if let Some(source @ Value::Object(_)) = props.get("source") {
        let source: ModelSource = serde_json::from_value(source.clone())
            .map_err(|error| invalid(format!("props.source 格式不对：{error}")))?;
        source.validate()?;
    }
    Ok(())
}

/// 物件模型（`assetHash`）整体的外观：调色、半透明、不受光照、着色方式（SHAPES 3）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelMaterial {
    /// 整个模型乘上这个颜色（sRGB 0–255）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<[u8; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlit: Option<bool>,
    /// 网站怎么画模型里的材质：`baked`（不给时，扫描切出来的模型）按扫描烘焙的看法，`albedo`
    /// （模型库的模型）按 glb 里的材质原样完整受光。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shading: Option<Shading>,
}

/// 物件记录的 body。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityBody {
    pub entity_id: String,
    pub layer: Layer,
    pub kind: EntityKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_id: Option<String>,
    /// 参数化定义（基本形体、轮廓放样、模板实例）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<Shape>,
    /// 处理服务校验并重新导出的模型。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_hash: Option<String>,
    /// 模型（`assetHash`）整体的调色、半透明、不受光照、着色方式；只能和 `assetHash` 一起给。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<ModelMaterial>,
    /// 模型（`assetHash`）绕自己的原点转的角度：只有 `yaw`、`pitch`、`roll`，只能和 `assetHash` 一起给。
    /// 位置由 `bounds` 定，缩放烘进模型（SHAPES 3"引用外部模型的物件"）。同一个模型摆几个朝向时
    /// 只要导出一份 glb。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<Transform>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub textures: Option<Vec<String>>,
    /// 由生成方计算，用于权限范围检查和网站裁剪。
    pub bounds: Aabb,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit: Option<Fit>,
    /// 不透明的键值，网站只在信息面板里按纯文本列出。
    #[serde(default)]
    pub props: Map<String, Value>,
}

impl EntityBody {
    /// 结构校验，并核对声明的包围盒包住了按形状算出的包围盒。
    pub fn validate(&self, templates: &dyn TemplateSource) -> Result<(), RecordError> {
        if !is_object_id(&self.entity_id) || self.entity_id.starts_with('_') {
            return Err(invalid("entityId 格式不对"));
        }
        if let Some(label) = &self.label {
            check_label(label)?;
        }
        for (name, id) in [("anchorId", &self.anchor_id), ("regionId", &self.region_id)] {
            if id.as_deref().is_some_and(|id| !is_object_id(id)) {
                return Err(invalid(format!("{name} 格式不对")));
            }
        }
        if self.shape.is_none() && self.asset_hash.is_none() {
            return Err(invalid("物件至少要有 shape 或 assetHash"));
        }
        if self.kind == EntityKind::Template && self.shape.is_none() {
            return Err(invalid("模板必须给出 shape"));
        }
        if self
            .asset_hash
            .as_deref()
            .is_some_and(|hash| !is_sha256_hex(hash))
        {
            return Err(invalid("assetHash 必须是 64 位小写十六进制"));
        }
        if let Some(material) = &self.material {
            if self.asset_hash.is_none() {
                return Err(invalid("material 只用于模型，必须和 assetHash 一起给"));
            }
            crate::shape::validate_opacity("material.opacity", material.opacity)?;
        }
        if let Some(transform) = &self.transform {
            if self.asset_hash.is_none() {
                return Err(invalid("transform 只用于模型，必须和 assetHash 一起给"));
            }
            if transform.position.is_some() || transform.scale.is_some() {
                return Err(invalid(
                    "模型的 transform 只能有 yaw、pitch、roll（位置由 bounds 定，缩放烘进模型）",
                ));
            }
            transform.validate("transform")?;
        }
        if self
            .textures
            .iter()
            .flatten()
            .any(|hash| !is_sha256_hex(hash))
            || self.textures.as_ref().is_some_and(|t| t.len() > 64)
        {
            return Err(invalid("textures 必须是至多 64 个资源哈希"));
        }
        if !self.bounds.is_valid() {
            return Err(invalid("bounds 必须是有限值且 min ≤ max"));
        }
        if let Some(fit) = &self.fit {
            if ![fit.mean_cm, fit.p90_cm, fit.coverage3cm]
                .iter()
                .all(|v| v.is_finite() && *v >= 0.0)
                || fit.coverage3cm > 1.0
            {
                return Err(invalid("fit 取值不合法"));
            }
        }
        if canonical_json_of(&self.props)?.len() > MAX_PROPS_BYTES {
            return Err(invalid("props 超过 16KB"));
        }
        validate_props(&self.props)?;
        if let Some(shape) = &self.shape {
            shape.validate()?;
            let computed = shape.bounds(templates)?;
            if !self.bounds.contains(&computed, BOUNDS_TOLERANCE) {
                return Err(invalid("bounds 没有包住形状的实际范围"));
            }
        }
        Ok(())
    }

    /// 物件在格子坐标下占的范围（权限检查用）。
    pub fn footprint(&self) -> Result<GridBox, RecordError> {
        self.bounds
            .grid_cover()
            .map_err(|error| invalid(format!("bounds 无法换算成格子：{error}")))
    }
}

/// 锚点类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnchorKind {
    Table,
    Seat,
    Zone,
    Door,
    Camera,
    Counter,
    Space,
}

/// 锚点记录的 body。位置用盒子（格）或点（米）表示，二选一；
/// 空间级锚点 `_space` 没有位置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnchorBody {
    pub anchor_id: String,
    pub kind: AnchorKind,
    #[serde(rename = "box", default, skip_serializing_if = "Option::is_none")]
    pub grid_box: Option<GridBox>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub visibility: DataVisibility,
}

/// 锚点占的范围。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnchorFootprint {
    /// 空间级锚点，涉及整个空间。
    SpaceWide,
    Cells(GridBox),
}

impl AnchorBody {
    pub fn validate(&self) -> Result<(), RecordError> {
        let reserved = self.anchor_id == SPACE_ANCHOR_ID;
        if !is_object_id(&self.anchor_id) || (self.anchor_id.starts_with('_') && !reserved) {
            return Err(invalid("anchorId 格式不对（以 _ 开头的编号保留）"));
        }
        if reserved != (self.kind == AnchorKind::Space) {
            return Err(invalid("只有 _space 锚点的类型是 space"));
        }
        if let Some(label) = &self.label {
            check_label(label)?;
        }
        match (self.kind, &self.grid_box, &self.position) {
            (AnchorKind::Space, None, None) => {}
            (AnchorKind::Space, _, _) => return Err(invalid("_space 锚点没有位置")),
            (_, Some(_), None) => {}
            (_, None, Some(position)) => {
                if !position.iter().all(|v| v.is_finite() && v.abs() <= 1e5) {
                    return Err(invalid("position 必须是有限值"));
                }
            }
            _ => return Err(invalid("锚点必须且只能给出 box 或 position")),
        }
        Ok(())
    }

    pub fn footprint(&self) -> Result<AnchorFootprint, RecordError> {
        match (&self.grid_box, &self.position) {
            (Some(grid_box), _) => Ok(AnchorFootprint::Cells(*grid_box)),
            (None, Some(position)) => Aabb {
                min: *position,
                max: *position,
            }
            .grid_cover()
            .map(AnchorFootprint::Cells)
            .map_err(|error| invalid(format!("position 无法换算成格子：{error}"))),
            (None, None) => Ok(AnchorFootprint::SpaceWide),
        }
    }
}

fn check_label(label: &str) -> Result<(), RecordError> {
    if label.chars().count() > MAX_LABEL_CHARS || label.chars().any(char::is_control) {
        return Err(invalid("label 太长或含控制字符"));
    }
    Ok(())
}

/// 记录类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordKind {
    Entity,
    Anchor,
}

/// 记录的内容哈希（`records._id`）。
pub fn record_hash<T: Serialize>(
    kind: RecordKind,
    space_id: &str,
    body: &T,
) -> Result<String, RecordError> {
    let body = serde_json::to_value(body)
        .map_err(|error| RecordError::Canonical(CanonicalError::Serialize(error.to_string())))?;
    Ok(content_hash(&json!({
        "body": body,
        "kind": kind,
        "spaceId": space_id,
    }))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shape::NoTemplates;

    fn entity(value: Value) -> EntityBody {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn shapes_example_record_validates() {
        let body = entity(json!({
            "entityId": "counter-01", "layer": "rebuilt", "kind": "object",
            "label": "前台", "anchorId": "counter-01",
            "shape": {"type": "box", "size": [2.4, 1.1, 0.6], "fillet": 0.02,
                      "transform": {"position": [3, 0, 1.5]}},
            "bounds": {"min": [1.8, 0, 1.2], "max": [4.2, 1.1, 1.8]},
            "fit": {"meanCm": 1.8, "p90Cm": 4.2, "coverage3cm": 0.81},
            "props": {}
        }));
        body.validate(&NoTemplates).unwrap();
        assert_eq!(
            body.footprint().unwrap(),
            GridBox::from_array([36, 0, 24, 84, 22, 36]).unwrap()
        );
    }

    #[test]
    fn declared_bounds_must_cover_shape() {
        let body = entity(json!({
            "entityId": "lamp", "layer": "ext", "kind": "object",
            "shape": {"type": "cylinder", "radius": 0.2, "height": 1},
            "bounds": {"min": [-0.1, 0, -0.2], "max": [0.2, 1, 0.2]}
        }));
        assert!(body.validate(&NoTemplates).is_err());
    }

    fn model_entity(extra: Value) -> Value {
        let mut body = json!({
            "entityId": "sofa-01", "layer": "rebuilt", "kind": "object",
            "assetHash": "ab".repeat(32),
            "bounds": {"min": [0, 0, 0], "max": [2, 0.8, 0.9]},
            "props": {"source": {"library": "objaverse", "id": "0123abcd",
                "page": "https://sketchfab.com/3d-models/0123abcd", "author": "某作者",
                "license": "CC-BY-4.0", "title": "布艺沙发"}}
        });
        for (key, value) in extra.as_object().unwrap() {
            if value.is_null() {
                body.as_object_mut().unwrap().remove(key);
            } else {
                body[key] = value.clone();
            }
        }
        body
    }

    #[test]
    fn model_entities_with_rotation() {
        // 只有旋转：同一个模型摆几个朝向，只导出一份 glb
        let body = entity(model_entity(json!({"transform": {"yaw": 6.84}})));
        body.validate(&NoTemplates).unwrap();
        let back = serde_json::to_value(&body).unwrap();
        assert_eq!(back["transform"], json!({"yaw": 6.84}));
        entity(model_entity(
            json!({"transform": {"yaw": -90, "pitch": 0, "roll": 180}}),
        ))
        .validate(&NoTemplates)
        .unwrap();
        // 位置、缩放不收；角度按形状变换的规则（|x| ≤ 3600）
        for bad in [
            json!({"position": [1, 0, 0]}),
            json!({"scale": [1, 1, 1]}),
            json!({"yaw": 3601}),
        ] {
            let body = entity(model_entity(json!({"transform": bad.clone()})));
            assert!(body.validate(&NoTemplates).is_err(), "{bad}");
        }
        // 不认识的字段在反序列化时就拒绝
        assert!(serde_json::from_value::<EntityBody>(model_entity(
            json!({"transform": {"heading": 90}})
        ))
        .is_err());
        // 只能和 assetHash 一起给
        let shape_only = entity(json!({
            "entityId": "box", "layer": "ext", "kind": "object",
            "shape": {"type": "box", "size": [1, 1, 1]},
            "transform": {"yaw": 90},
            "bounds": {"min": [-0.5, 0, -0.5], "max": [0.5, 1, 0.5]}
        }));
        assert!(shape_only.validate(&NoTemplates).is_err());
    }

    #[test]
    fn model_entities_with_source_and_material() {
        let valid = entity(model_entity(json!({"material": {"tint": [200, 190, 180]}})));
        valid.validate(&NoTemplates).unwrap();
        // 着色方式：模型库的模型写 albedo，不给时按 baked；只认这两个值。
        for shading in ["albedo", "baked"] {
            let body = entity(model_entity(
                json!({"material": {"tint": [200, 190, 180], "shading": shading}}),
            ));
            body.validate(&NoTemplates).unwrap();
            let back = serde_json::to_value(&body).unwrap();
            assert_eq!(back["material"]["shading"], json!(shading));
        }
        assert_eq!(
            entity(model_entity(json!({"material": {"shading": "albedo"}})))
                .material
                .and_then(|m| m.shading),
            Some(Shading::Albedo)
        );
        for bad in [json!("pbr"), json!("Albedo"), json!(true)] {
            assert!(
                serde_json::from_value::<EntityBody>(model_entity(
                    json!({"material": {"shading": bad.clone()}})
                ))
                .is_err(),
                "{bad}"
            );
        }
        // 形状材质的平铺、法线、粗糙度不能写在模型的 material 上。
        for field in ["tile", "normalMap", "roughness"] {
            assert!(
                serde_json::from_value::<EntityBody>(model_entity(
                    json!({"material": {field: [1, 1]}})
                ))
                .is_err(),
                "{field}"
            );
        }
        // 只有 assetHash 的物件才有 material，带着色方式也一样。
        let shape_only = entity(model_entity(json!({
            "assetHash": null, "material": {"shading": "albedo"},
            "shape": {"type": "box", "size": [2, 0.8, 0.9], "transform": {"position": [1, 0, 0.45]}}
        })));
        assert!(shape_only.validate(&NoTemplates).is_err());
        // 旧数据里 source 是识别来源的字符串，照旧当不透明的值。
        entity(model_entity(json!({"props": {"source": "hint"}})))
            .validate(&NoTemplates)
            .unwrap();
        let source = |field: &str, value: Value| {
            let mut body = model_entity(json!({}));
            body["props"]["source"][field] = value;
            entity(body)
        };
        for (field, value) in [
            ("license", json!("CC-BY-NC-4.0")),
            ("license", json!("CC-BY-SA-4.0")),
            ("library", json!("thingiverse")),
            ("page", json!("javascript:alert(1)")),
            ("page", json!("http://example.com/x")),
            ("page", json!("https://example.com/a b")),
            ("author", json!("")),
            ("title", json!("a\u{7}b")),
            ("id", json!(7)),
            ("extra", json!("x")),
        ] {
            assert!(
                source(field, value.clone()).validate(&NoTemplates).is_err(),
                "{field} = {value}"
            );
        }
        let mut missing = model_entity(json!({}));
        missing["props"]["source"]
            .as_object_mut()
            .unwrap()
            .remove("author");
        assert!(entity(missing).validate(&NoTemplates).is_err());
        // material 只能和 assetHash 一起给；opacity 在 0–1 之间。
        let shape_only = entity(model_entity(json!({
            "assetHash": null, "material": {"tint": [1, 2, 3]},
            "shape": {"type": "box", "size": [2, 0.8, 0.9], "transform": {"position": [1, 0, 0.45]}}
        })));
        assert!(shape_only.validate(&NoTemplates).is_err());
        let opaque = entity(model_entity(json!({"material": {"opacity": 2}})));
        assert!(opaque.validate(&NoTemplates).is_err());
        assert!(serde_json::from_value::<EntityBody>(model_entity(
            json!({"material": {"color": [1, 2, 3]}})
        ))
        .is_err());
    }

    #[test]
    fn https_urls() {
        assert!(is_https_url("https://polyhaven.com/a/sofa"));
        assert!(!is_https_url("https://"));
        assert!(!is_https_url("HTTPS://polyhaven.com"));
        assert!(!is_https_url(&format!("https://a.b/{}", "x".repeat(2000))));
    }

    #[test]
    fn anchor_rules() {
        let anchor = |value: Value| serde_json::from_value::<AnchorBody>(value).unwrap();
        anchor(
            json!({"anchorId":"t1","kind":"table","box":[0,0,0,10,15,10],"visibility":"public"}),
        )
        .validate()
        .unwrap();
        anchor(json!({"anchorId":"_space","kind":"space","visibility":"public"}))
            .validate()
            .unwrap();
        for bad in [
            json!({"anchorId":"_x","kind":"table","position":[0,0,0],"visibility":"public"}),
            json!({"anchorId":"t1","kind":"space","visibility":"public"}),
            json!({"anchorId":"t1","kind":"table","visibility":"public"}),
            json!({"anchorId":"t1","kind":"table","box":[0,0,0,1,1,1],"position":[0,0,0],"visibility":"public"}),
        ] {
            assert!(anchor(bad.clone()).validate().is_err(), "{bad}");
        }
        assert_eq!(
            anchor(json!({"anchorId":"door","kind":"door","position":[0.12,0,0],"visibility":"internal"}))
                .footprint()
                .unwrap(),
            AnchorFootprint::Cells(GridBox::from_array([2, 0, 0, 3, 1, 1]).unwrap())
        );
    }

    #[test]
    fn record_hash_depends_on_space() {
        let body = json!({"anchorId":"t1"});
        let a = record_hash(RecordKind::Anchor, "space-a", &body).unwrap();
        let b = record_hash(RecordKind::Anchor, "space-b", &body).unwrap();
        assert_ne!(a, b);
        assert_eq!(
            a,
            crate::sha256_hex(br#"{"body":{"anchorId":"t1"},"kind":"anchor","spaceId":"space-a"}"#)
        );
    }
}
