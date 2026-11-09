//! 路径范围与"请求内容必须与路径一致"（设计 9.4）。
//!
//! 决定"能不能做"的信息（空间、地块、数据源）一律放在路径里，NyxID 的操作范围
//! 按路径参数限制 agent key；服务端再保证请求内容没有越出路径给定的范围：
//!
//! - 地块路径下的每个操作都必须落在该地块内；实体区路径下的操作只能改实体区；
//! - 事件路径里的 `source` 就是事件的数据源，请求体里不能另填；
//! - 上传的用途由路径决定，地块路径下不能上传扫描；
//! - 草稿属于创建时的路径范围，追加操作、预览、发布都必须走同一范围。

use std::fmt;
use std::str::FromStr;

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::grid::{covered_by, GridBox};
use crate::ids::is_object_id;
use crate::model::{Plot, Region, RegionKind};
use crate::ops::Footprint;

/// 路径给出的作用范围，存储和传输时写成 `physical`、`plot:<编号>`、`source:<名称>`。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PathScope {
    Physical,
    Plot(String),
    Source(String),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ScopeError {
    #[error("作用范围格式不对")]
    Format,
    #[error("地块 {0} 不存在")]
    UnknownPlot(String),
    #[error("这个路径范围不能修改几何内容")]
    NoGeometry,
    #[error("操作超出了路径范围 {0}")]
    OutOfScope(String),
    #[error("请求体里不能填写 source，数据源由路径决定")]
    SourceInBody,
    #[error("地块路径下不能上传扫描")]
    ScanOutsidePhysical,
    #[error("地块路径下不能上传 AI 物件集（它写重建层，只经实体区路径导入）")]
    AuthoredOutsidePhysical,
    #[error("草稿属于 {draft}，不能经 {path} 路径操作")]
    DraftScopeMismatch { draft: String, path: String },
}

impl fmt::Display for PathScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PathScope::Physical => f.write_str("physical"),
            PathScope::Plot(id) => write!(f, "plot:{id}"),
            PathScope::Source(name) => write!(f, "source:{name}"),
        }
    }
}

impl FromStr for PathScope {
    type Err = ScopeError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value == "physical" {
            return Ok(PathScope::Physical);
        }
        let (kind, id) = value.split_once(':').ok_or(ScopeError::Format)?;
        if !is_object_id(id) {
            return Err(ScopeError::Format);
        }
        match kind {
            "plot" => Ok(PathScope::Plot(id.into())),
            "source" => Ok(PathScope::Source(id.into())),
            _ => Err(ScopeError::Format),
        }
    }
}

impl Serialize for PathScope {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for PathScope {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(de::Error::custom)
    }
}

/// 某个路径范围允许修改的格子范围。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowedArea {
    scope: PathScope,
    boxes: Vec<GridBox>,
}

impl AllowedArea {
    /// 实体区路径 → 所有实体区的盒子；地块路径 → 该地块的盒子；数据源路径不能改几何。
    pub fn for_scope(
        scope: &PathScope,
        regions: &[Region],
        plots: &[Plot],
    ) -> Result<Self, ScopeError> {
        let boxes = match scope {
            PathScope::Physical => regions
                .iter()
                .filter(|region| region.kind == RegionKind::Physical)
                .flat_map(|region| region.boxes.iter().copied())
                .collect(),
            PathScope::Plot(id) => plots
                .iter()
                .find(|plot| &plot.id == id)
                .ok_or_else(|| ScopeError::UnknownPlot(id.clone()))?
                .boxes
                .clone(),
            PathScope::Source(_) => return Err(ScopeError::NoGeometry),
        };
        Ok(Self {
            scope: scope.clone(),
            boxes,
        })
    }

    pub fn scope(&self) -> &PathScope {
        &self.scope
    }

    pub fn boxes(&self) -> &[GridBox] {
        &self.boxes
    }

    /// 一个操作的影响范围是否完全落在允许的范围内。
    /// 空间级的影响（`_space` 锚点）只允许实体区路径。
    pub fn check(&self, footprint: &Footprint) -> Result<(), ScopeError> {
        let out_of_scope = || ScopeError::OutOfScope(self.scope.to_string());
        if footprint.space_wide && self.scope != PathScope::Physical {
            return Err(out_of_scope());
        }
        if footprint
            .cells
            .iter()
            .all(|cells| covered_by(cells, &self.boxes))
        {
            Ok(())
        } else {
            Err(out_of_scope())
        }
    }
}

/// 事件路径：请求体里的事件对象不能带 `source` 字段。
pub fn check_event_body_has_no_source(event: &Value) -> Result<(), ScopeError> {
    match event {
        Value::Object(map) if map.contains_key("source") => Err(ScopeError::SourceInBody),
        _ => Ok(()),
    }
}

/// 上传用途（写在路径 `.../uploads/{purpose}` 里）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UploadPurpose {
    Scan,
    Model,
    Texture,
    Ops,
    Script,
    /// AI 物件集（JSON，设计 6.3）：交给 scan_import / rebuild 写进重建层。
    Authored,
}

/// 扫描和 AI 物件集只能经实体区路径上传。
pub fn check_upload_purpose(scope: &PathScope, purpose: UploadPurpose) -> Result<(), ScopeError> {
    match (scope, purpose) {
        (PathScope::Physical, _) => Ok(()),
        (PathScope::Plot(_), UploadPurpose::Scan) => Err(ScopeError::ScanOutsidePhysical),
        (PathScope::Plot(_), UploadPurpose::Authored) => Err(ScopeError::AuthoredOutsidePhysical),
        (PathScope::Plot(_), _) => Ok(()),
        (PathScope::Source(_), _) => Err(ScopeError::NoGeometry),
    }
}

/// 草稿只能经创建它的那个路径范围操作。
pub fn check_draft_scope(draft: &PathScope, path: &PathScope) -> Result<(), ScopeError> {
    if draft == path {
        Ok(())
    } else {
        Err(ScopeError::DraftScopeMismatch {
            draft: draft.to_string(),
            path: path.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn gb(v: [i64; 6]) -> GridBox {
        GridBox::from_array(v).unwrap()
    }

    fn layout() -> (Vec<Region>, Vec<Plot>) {
        (
            vec![
                Region {
                    id: "hall".into(),
                    kind: RegionKind::Physical,
                    boxes: vec![gb([0, 0, 0, 100, 60, 100])],
                    name: None,
                },
                Region {
                    id: "garden".into(),
                    kind: RegionKind::Virtual,
                    boxes: vec![gb([100, 0, 0, 200, 60, 100])],
                    name: None,
                },
            ],
            vec![Plot {
                id: "p1".into(),
                region_id: "garden".into(),
                boxes: vec![gb([100, 0, 0, 120, 20, 20])],
                name: None,
            }],
        )
    }

    #[test]
    fn scope_strings() {
        for text in ["physical", "plot:p1", "source:pos"] {
            let scope: PathScope = text.parse().unwrap();
            assert_eq!(scope.to_string(), text);
            assert_eq!(serde_json::to_value(&scope).unwrap(), json!(text));
        }
        for bad in ["plot:", "plot:a:b", "zone:x", "physical:x", "plot:a/b"] {
            assert!(bad.parse::<PathScope>().is_err(), "{bad}");
        }
    }

    #[test]
    fn plot_and_physical_areas() {
        let (regions, plots) = layout();
        let plot = AllowedArea::for_scope(&PathScope::Plot("p1".into()), &regions, &plots).unwrap();
        let inside = Footprint::cells(vec![gb([101, 0, 0, 110, 5, 5])]);
        let crossing = Footprint::cells(vec![gb([115, 0, 0, 125, 5, 5])]);
        assert!(plot.check(&inside).is_ok());
        assert!(plot.check(&crossing).is_err());
        assert!(plot.check(&Footprint::space_wide()).is_err());
        let physical = AllowedArea::for_scope(&PathScope::Physical, &regions, &plots).unwrap();
        assert!(physical.check(&inside).is_err());
        assert!(physical
            .check(&Footprint::cells(vec![gb([0, 0, 0, 10, 10, 10])]))
            .is_ok());
        assert!(physical.check(&Footprint::space_wide()).is_ok());
        assert_eq!(
            AllowedArea::for_scope(&PathScope::Plot("p9".into()), &regions, &plots),
            Err(ScopeError::UnknownPlot("p9".into()))
        );
        assert_eq!(
            AllowedArea::for_scope(&PathScope::Source("pos".into()), &regions, &plots),
            Err(ScopeError::NoGeometry)
        );
    }

    #[test]
    fn body_and_purpose_rules() {
        assert!(check_event_body_has_no_source(&json!({"type":"x"})).is_ok());
        assert_eq!(
            check_event_body_has_no_source(&json!({"type":"x","source":"pos"})),
            Err(ScopeError::SourceInBody)
        );
        let plot = PathScope::Plot("p1".into());
        assert!(check_upload_purpose(&PathScope::Physical, UploadPurpose::Scan).is_ok());
        assert!(check_upload_purpose(&plot, UploadPurpose::Scan).is_err());
        assert!(check_upload_purpose(&plot, UploadPurpose::Model).is_ok());
        assert!(check_upload_purpose(&PathScope::Physical, UploadPurpose::Authored).is_ok());
        assert!(check_upload_purpose(&plot, UploadPurpose::Authored).is_err());
        assert!(check_draft_scope(&plot, &plot).is_ok());
        assert!(check_draft_scope(&plot, &PathScope::Physical).is_err());
    }
}
