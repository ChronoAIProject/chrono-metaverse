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
use crate::shape::{Shape, TemplateSource};

/// 物件 `props` 规范化后的最大字节数。
pub const MAX_PROPS_BYTES: usize = 16 * 1024;
/// 标签最大字符数。
pub const MAX_LABEL_CHARS: usize = 200;
/// 声明的包围盒允许比计算结果小这么多（米），用来吸收浮点误差。
pub const BOUNDS_TOLERANCE: f64 = 1e-6;

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
