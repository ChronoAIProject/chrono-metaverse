//! 路径范围与"请求内容必须与路径一致"（设计 9.4）。
//!
//! 决定"能不能做"的信息（空间、地块、数据源）一律放在路径里，NyxID 的操作范围
//! 按路径参数限制 agent key；服务端再保证请求内容没有越出路径给定的范围：
//!
//! - 地块路径下的每个操作都必须落在该地块内；实体区路径和重建路径下的操作只能改实体区
//!   （空间没有定义实体区时，是"不与任何虚拟区、地块相交"的地方）；
//! - 事件路径里的 `source` 就是事件的数据源，请求体里不能另填；
//! - 上传的用途由路径决定：扫描、网页用模型、重建包只能经重建路径上传；
//! - 草稿属于创建时的路径范围，追加操作、预览、发布都必须走同一范围。

use std::fmt;
use std::str::FromStr;

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::grid::{covered_by, GridBox};
use crate::ids::is_object_id;
use crate::model::{Plot, Region, RegionKind};
use crate::ops::Footprint;

/// 路径给出的作用范围，存储和传输时写成 `physical`、`plot:<编号>`、`source:<名称>`、`rebuild`。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PathScope {
    Physical,
    Plot(String),
    Source(String),
    /// 重建路径（`/api/v1/spaces/{space_id}/rebuild/`）：只写重建层和扫描，重建草稿只收重建包
    /// （docs/design/server-slim.md 2.3）。
    Rebuild,
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
    #[error("扫描改经重建路径上传（/rebuild/uploads/scan）")]
    ScanOutsideRebuild,
    #[error("用途 {0} 只能经重建路径上传")]
    RebuildPurposeOutsideRebuild(UploadPurpose),
    #[error("用途 {0} 不能经重建路径上传（重建草稿只收重建包）")]
    PurposeNotForRebuild(UploadPurpose),
    #[error("AI 物件集已经不能上传：物件集只在本地，打成重建包后经重建路径上传")]
    AuthoredRetired,
    #[error("草稿属于 {draft}，不能经 {path} 路径操作")]
    DraftScopeMismatch { draft: String, path: String },
}

impl fmt::Display for PathScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PathScope::Physical => f.write_str("physical"),
            PathScope::Plot(id) => write!(f, "plot:{id}"),
            PathScope::Source(name) => write!(f, "source:{name}"),
            PathScope::Rebuild => f.write_str("rebuild"),
        }
    }
}

impl FromStr for PathScope {
    type Err = ScopeError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "physical" => return Ok(PathScope::Physical),
            "rebuild" => return Ok(PathScope::Rebuild),
            _ => {}
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

/// 允许范围的两种写法。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AreaMode {
    /// 只能改落在这些盒子里的格子。
    Within(Vec<GridBox>),
    /// "除去"模式：不能碰这些盒子，其余地方都可以改。空间没有定义实体区时，实体区路径和
    /// 重建路径用它：允许范围是"不与任何虚拟区、地块的盒子相交"的地方
    /// （docs/design/server-slim.md 2.5 第 6 条）。
    Except(Vec<GridBox>),
}

/// 某个路径范围允许修改的格子范围。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowedArea {
    scope: PathScope,
    mode: AreaMode,
}

impl AllowedArea {
    /// 实体区路径、重建路径 → 所有实体区的盒子；空间没有定义实体区时 → 除去所有虚拟区和地块的盒子。
    /// 地块路径 → 该地块的盒子；数据源路径不能改几何。
    pub fn for_scope(
        scope: &PathScope,
        regions: &[Region],
        plots: &[Plot],
    ) -> Result<Self, ScopeError> {
        let mode = match scope {
            PathScope::Physical | PathScope::Rebuild => {
                if regions
                    .iter()
                    .any(|region| region.kind == RegionKind::Physical)
                {
                    AreaMode::Within(
                        regions
                            .iter()
                            .filter(|region| region.kind == RegionKind::Physical)
                            .flat_map(|region| region.boxes.iter().copied())
                            .collect(),
                    )
                } else {
                    AreaMode::Except(
                        regions
                            .iter()
                            .flat_map(|region| region.boxes.iter().copied())
                            .chain(plots.iter().flat_map(|plot| plot.boxes.iter().copied()))
                            .collect(),
                    )
                }
            }
            PathScope::Plot(id) => AreaMode::Within(
                plots
                    .iter()
                    .find(|plot| &plot.id == id)
                    .ok_or_else(|| ScopeError::UnknownPlot(id.clone()))?
                    .boxes
                    .clone(),
            ),
            PathScope::Source(_) => return Err(ScopeError::NoGeometry),
        };
        Ok(Self {
            scope: scope.clone(),
            mode,
        })
    }

    pub fn scope(&self) -> &PathScope {
        &self.scope
    }

    pub fn mode(&self) -> &AreaMode {
        &self.mode
    }

    /// 一块格子是否完全在允许范围内。
    pub fn allows(&self, cells: &GridBox) -> bool {
        match &self.mode {
            AreaMode::Within(boxes) => covered_by(cells, boxes),
            AreaMode::Except(boxes) => !boxes.iter().any(|excluded| excluded.intersects(cells)),
        }
    }

    /// 一个操作的影响范围是否完全落在允许的范围内。
    /// 空间级的影响（`_space` 锚点）只允许实体区路径。
    pub fn check(&self, footprint: &Footprint) -> Result<(), ScopeError> {
        let out_of_scope = || ScopeError::OutOfScope(self.scope.to_string());
        if footprint.space_wide && self.scope != PathScope::Physical {
            return Err(out_of_scope());
        }
        if footprint.cells.iter().all(|cells| self.allows(cells)) {
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

/// 上传用途（写在路径 `.../uploads/{purpose}` 里，存储时也是这个名字）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UploadPurpose {
    /// 原始扫描（只经重建路径）。
    Scan,
    /// 网页用模型（glb，只经重建路径）。路径和存储里写 `webmodel`。
    WebModel,
    Model,
    Texture,
    Ops,
    Script,
    /// 重建包清单（JSON，只经重建路径，docs/SHAPES.md 第 7 节）。
    Bundle,
    /// AI 物件集：不能再新建，只留着读旧的上传记录。
    Authored,
}

impl UploadPurpose {
    pub const ALL: [UploadPurpose; 8] = [
        UploadPurpose::Scan,
        UploadPurpose::WebModel,
        UploadPurpose::Model,
        UploadPurpose::Texture,
        UploadPurpose::Ops,
        UploadPurpose::Script,
        UploadPurpose::Bundle,
        UploadPurpose::Authored,
    ];

    /// 路径和存储里的名字。
    pub fn name(self) -> &'static str {
        match self {
            UploadPurpose::Scan => "scan",
            UploadPurpose::WebModel => "webmodel",
            UploadPurpose::Model => "model",
            UploadPurpose::Texture => "texture",
            UploadPurpose::Ops => "ops",
            UploadPurpose::Script => "script",
            UploadPurpose::Bundle => "bundle",
            UploadPurpose::Authored => "authored",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|purpose| purpose.name() == name)
    }
}

impl fmt::Display for UploadPurpose {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// 上传用途与路径范围（docs/design/server-slim.md 2.9）：
///
/// - 实体区、地块路径：`model`、`texture`、`ops`、`script`；
/// - 重建路径：`scan`、`webmodel`、`model`、`texture`、`script`、`bundle`；
/// - 数据源路径不能上传；`authored` 不能再新建。
pub fn check_upload_purpose(scope: &PathScope, purpose: UploadPurpose) -> Result<(), ScopeError> {
    use UploadPurpose as P;
    match (scope, purpose) {
        (PathScope::Source(_), _) => Err(ScopeError::NoGeometry),
        (_, P::Authored) => Err(ScopeError::AuthoredRetired),
        (PathScope::Rebuild, P::Ops) => Err(ScopeError::PurposeNotForRebuild(purpose)),
        (PathScope::Rebuild, _) => Ok(()),
        (_, P::Scan) => Err(ScopeError::ScanOutsideRebuild),
        (_, P::WebModel | P::Bundle) => Err(ScopeError::RebuildPurposeOutsideRebuild(purpose)),
        (PathScope::Physical | PathScope::Plot(_), P::Model | P::Texture | P::Ops | P::Script) => {
            Ok(())
        }
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
        for text in ["physical", "plot:p1", "source:pos", "rebuild"] {
            let scope: PathScope = text.parse().unwrap();
            assert_eq!(scope.to_string(), text);
            assert_eq!(serde_json::to_value(&scope).unwrap(), json!(text));
        }
        for bad in [
            "plot:",
            "plot:a:b",
            "zone:x",
            "physical:x",
            "plot:a/b",
            "rebuild:x",
            "Rebuild",
        ] {
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
    fn rebuild_area_is_physical_without_space_wide() {
        let (regions, plots) = layout();
        let rebuild = AllowedArea::for_scope(&PathScope::Rebuild, &regions, &plots).unwrap();
        assert_eq!(
            rebuild.mode(),
            &AreaMode::Within(vec![gb([0, 0, 0, 100, 60, 100])])
        );
        assert!(rebuild
            .check(&Footprint::cells(vec![gb([0, 0, 0, 10, 10, 10])]))
            .is_ok());
        assert!(rebuild
            .check(&Footprint::cells(vec![gb([101, 0, 0, 110, 5, 5])]))
            .is_err());
        // 空间级锚点只允许实体区路径。
        assert_eq!(
            rebuild.check(&Footprint::space_wide()),
            Err(ScopeError::OutOfScope("rebuild".into()))
        );
    }

    #[test]
    fn without_physical_regions_everything_outside_virtual_and_plots() {
        let (regions, plots) = layout();
        // 只留虚拟区和地块：实体区路径、重建路径都是"除去"模式。
        let virtual_only: Vec<Region> = regions
            .into_iter()
            .filter(|region| region.kind == RegionKind::Virtual)
            .collect();
        for scope in [PathScope::Physical, PathScope::Rebuild] {
            let area = AllowedArea::for_scope(&scope, &virtual_only, &plots).unwrap();
            assert!(matches!(area.mode(), AreaMode::Except(boxes) if boxes.len() == 2));
            assert!(area
                .check(&Footprint::cells(vec![gb([-500, -10, -500, 100, 60, 100])]))
                .is_ok());
            // 只碰到边界不算相交。
            assert!(area
                .check(&Footprint::cells(vec![gb([90, 0, 0, 100, 10, 10])]))
                .is_ok());
            assert!(area
                .check(&Footprint::cells(vec![gb([99, 0, 0, 101, 10, 10])]))
                .is_err());
            assert!(area
                .check(&Footprint::cells(vec![gb([150, 0, 0, 160, 10, 10])]))
                .is_err());
        }
        // 什么区域都没有：除了空间级锚点只限实体区路径，哪里都可以。
        let empty = AllowedArea::for_scope(&PathScope::Physical, &[], &[]).unwrap();
        assert_eq!(empty.mode(), &AreaMode::Except(vec![]));
        assert!(empty.check(&Footprint::space_wide()).is_ok());
        assert!(empty
            .check(&Footprint::cells(vec![gb([0, 0, 0, 1, 1, 1])]))
            .is_ok());
        let rebuild = AllowedArea::for_scope(&PathScope::Rebuild, &[], &[]).unwrap();
        assert!(rebuild.check(&Footprint::space_wide()).is_err());
        // 地块路径不受影响。
        assert!(
            AllowedArea::for_scope(&PathScope::Plot("p1".into()), &virtual_only, &plots)
                .unwrap()
                .check(&Footprint::cells(vec![gb([0, 0, 0, 1, 1, 1])]))
                .is_err()
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
        use UploadPurpose as P;
        for scope in [PathScope::Physical, plot.clone()] {
            for purpose in [P::Model, P::Texture, P::Ops, P::Script] {
                assert!(
                    check_upload_purpose(&scope, purpose).is_ok(),
                    "{scope} {purpose}"
                );
            }
            assert_eq!(
                check_upload_purpose(&scope, P::Scan),
                Err(ScopeError::ScanOutsideRebuild)
            );
            for purpose in [P::WebModel, P::Bundle] {
                assert_eq!(
                    check_upload_purpose(&scope, purpose),
                    Err(ScopeError::RebuildPurposeOutsideRebuild(purpose))
                );
            }
            assert_eq!(
                check_upload_purpose(&scope, P::Authored),
                Err(ScopeError::AuthoredRetired)
            );
        }
        for purpose in [
            P::Scan,
            P::WebModel,
            P::Model,
            P::Texture,
            P::Script,
            P::Bundle,
        ] {
            assert!(check_upload_purpose(&PathScope::Rebuild, purpose).is_ok());
        }
        assert!(check_upload_purpose(&PathScope::Rebuild, P::Ops).is_err());
        assert!(check_upload_purpose(&PathScope::Rebuild, P::Authored).is_err());
        assert!(check_upload_purpose(&PathScope::Source("pos".into()), P::Model).is_err());
        assert!(check_draft_scope(&plot, &plot).is_ok());
        assert!(check_draft_scope(&plot, &PathScope::Physical).is_err());
        assert!(check_draft_scope(&PathScope::Rebuild, &PathScope::Physical).is_err());
    }

    #[test]
    fn purpose_names() {
        for purpose in UploadPurpose::ALL {
            assert_eq!(UploadPurpose::from_name(purpose.name()), Some(purpose));
            assert_eq!(
                serde_json::to_value(purpose).unwrap(),
                json!(purpose.name())
            );
        }
        assert_eq!(UploadPurpose::from_name("webModel"), None);
        assert_eq!(UploadPurpose::from_name("web_model"), None);
    }
}
