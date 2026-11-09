//! 形状词表（SHAPES 2）：数据类型、校验、包围盒。
//!
//! 每个形状是一个 JSON 对象，`type` 决定其余字段；所有形状都可以带
//! `transform` 和 `material`。这里不生成网格（网格由网站和处理服务生成），
//! 只做结构校验和包围盒计算；材质的平铺（`tile`、`offset`、`rotate`）只校验取值，
//! 贴图坐标由网站和处理服务算（测试向量 `uv/`）。
//!
//! **包围盒规则**（三种语言必须一致，测试向量 `shape_*.json` 按此生成）：
//!
//! 1. 先求形状在自身局部坐标里的包围盒：
//!    - `box`：`[-w/2, 0, -d/2]`–`[w/2, h, d/2]`（圆角、倒角只会缩小，忽略）；
//!    - `cylinder`：半径取 `max(radius, radiusTop)`，按解析圆计算（与分段数无关）；
//!    - `cone`：按解析圆计算；
//!    - `extrude`：轮廓的二维包围盒（含圆弧的极值点，忽略圆角）× `[0, height]`；
//!    - `lathe`：`r` 的最大值决定 x、z 范围（不管 `angle` 是多少，一律按整圈算），
//!      y 取轮廓的最小、最大值；
//!    - `sweep`：路径点的包围盒向各个方向扩出截面的外接半径
//!      （圆：`r`；矩形：`√(w²+h²)/2`；忽略 `smooth`）；
//!    - `loft`：各截面轮廓包围盒的并 × `[第一个 y, 最后一个 y]`；
//!    - `plate`：多边形各点 `Pᵢ` 和它们沿 −法向平移厚度后的点 `Pᵢ − t·n` 的包围盒
//!      （法向见 [`plate_frame`]）；
//!    - `hull`：全部点的包围盒（凸包的顶点都取自这些点，包围盒相同）；
//!    - `group`：各子形状（含子形状自己的 `transform`）包围盒的并；
//!    - `instance`：模板形状（含模板自己的 `transform`）的包围盒。
//! 2. 再用本形状的 `transform` 变换局部包围盒的 8 个角点，取这些点的包围盒。
//!    变换顺序是 缩放 → 翻滚 → 俯仰 → 偏航 → 平移，即
//!    `M = T · Ry(yaw) · Rx(pitch) · Rz(roll) · S`，角度单位是度。
//!    角度是 90° 的整数倍时，正弦和余弦取精确的 0、±1。
//!
//! 二维轮廓的点写作 `[x, z]`，按数学上的 (u, v) = (x, z) 平面理解：`points` 逆时针
//! 排列（有向面积为正）；`bulge` = tan(圆心角 / 4)，正值表示从第 i 点到第 i+1 点
//! 逆时针转的圆弧，对逆时针轮廓来说就是向外凸。
//!
//! **板（`plate`）和凸包（`hull`）的判定**（三种语言用同样的公式和比较顺序，结果一致）：
//!
//! - 板：中心 `c` 是各点的平均；Newell 法向 `N = Σ (Pᵢ − c) × (Pᵢ₊₁ − c)`，面积 = `|N| / 2`，
//!   单位法向 `n = N / |N|`（点按右手定则排列，从 `n` 一侧看是逆时针）。最佳拟合平面取过 `c`、
//!   法向为 `n` 的平面，每个点到它的距离 `|(Pᵢ − c)·n|` 不超过 1 毫米。简单多边形的检查在投影
//!   平面上做：去掉 `|n|` 最大的那个坐标轴（并列时先去 x、再 y），相邻两点不能重合，相邻两条边
//!   不能折回，不相邻的边不能相交（含接触）。
//! - 凸包：`a` = 第 0 点；`b` = 离 `a` 最远的点；`c` = 离直线 `ab` 最远的点；`d` = 离平面 `abc`
//!   最远的点（都取第一个最大值）。三个距离任何一个不超过 1 毫米就是重合、共线或共面，无效。

use std::collections::{BTreeMap, BTreeSet};
use std::f64::consts::{FRAC_PI_2, PI, TAU};

use serde::{de, ser, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::grid::Aabb;
use crate::ids::is_object_id;
use crate::is_sha256_hex;

/// 一个形状（含所有子形状）最多的节点数。
pub const MAX_SHAPE_NODES: usize = 4096;
/// 组合和模板实例的最大嵌套深度。
pub const MAX_SHAPE_DEPTH: usize = 16;
/// 轮廓、路径、旋转体轮廓的最大点数。
pub const MAX_POINTS: usize = 1024;
/// 圆周分段数上限。
pub const MAX_SEGMENTS: u32 = 256;
/// 圆角分段数上限。
pub const MAX_FILLET_SEGMENTS: u32 = 32;
/// 坐标、尺寸的绝对值上限（米）。
pub const MAX_COORD: f64 = 100_000.0;
/// 缩放分量的绝对值上限。
pub const MAX_SCALE: f64 = 1000.0;
/// 角度的绝对值上限（度）。
pub const MAX_ANGLE: f64 = 3600.0;
/// `bulge` 的绝对值上限（1000 约等于 359.8° 的圆弧）。
pub const MAX_BULGE: f64 = 1000.0;
/// 放样截面数范围。
pub const MIN_LOFT_SECTIONS: usize = 2;
pub const MAX_LOFT_SECTIONS: usize = 8;
/// 板的点数范围。
pub const MIN_PLATE_POINTS: usize = 3;
pub const MAX_PLATE_POINTS: usize = 64;
/// 板厚上限（米）。
pub const MAX_PLATE_THICKNESS: f64 = 1.0;
/// 板的最小面积（平方米，1 平方毫米）。
pub const MIN_PLATE_AREA: f64 = 1e-6;
/// 相邻两点至少相距这么远（米），否则算重合。
pub const MIN_EDGE_LENGTH: f64 = 1e-6;
/// 平面度、凸包退化的容差（米，1 毫米）。
pub const FLAT_TOLERANCE: f64 = 0.001;
/// 凸包的点数范围。
pub const MIN_HULL_POINTS: usize = 4;
pub const MAX_HULL_POINTS: usize = 256;
/// 材质 `tile`（贴图每重复一次的实际尺寸）每个分量的上限（米）；下限是大于 0。
pub const MAX_TILE: f64 = 100.0;
/// 材质 `offset`（贴图坐标的平移）每个分量的绝对值上限（米）。
pub const MAX_UV_OFFSET: f64 = 1000.0;
/// 材质 `rotate`（贴图在表面上逆时针转的角度）的绝对值上限（度）。
pub const MAX_UV_ROTATE: f64 = 360.0;
/// 材质 `normalScale`（法线贴图强度）的上限；下限是 0。
pub const MAX_NORMAL_SCALE: f64 = 4.0;

/// 校验或计算失败：`path` 是 JSON 路径，例如 `$.children[2].outline.points[3]`。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{path}: {message}")]
pub struct ShapeError {
    pub path: String,
    pub message: String,
}

impl ShapeError {
    fn new(path: &str, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }
}

/// 变换。所有字段可省略：位置默认原点，角度默认 0，缩放默认 1。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transform {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yaw: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pitch: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roll: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<[f64; 3]>,
}

/// 角度的正弦和余弦；90° 的整数倍取精确值，保证各语言结果一致。
pub fn sin_cos_degrees(degrees: f64) -> (f64, f64) {
    let reduced = degrees.rem_euclid(360.0);
    if reduced == 0.0 {
        (0.0, 1.0)
    } else if reduced == 90.0 {
        (1.0, 0.0)
    } else if reduced == 180.0 {
        (0.0, -1.0)
    } else if reduced == 270.0 {
        (-1.0, 0.0)
    } else {
        let radians = degrees.to_radians();
        (radians.sin(), radians.cos())
    }
}

impl Transform {
    /// `M · p`，其中 `M = T · Ry(yaw) · Rx(pitch) · Rz(roll) · S`。
    pub fn apply(&self, point: [f64; 3]) -> [f64; 3] {
        let scale = self.scale.unwrap_or([1.0; 3]);
        let [mut x, mut y, mut z] = [
            point[0] * scale[0],
            point[1] * scale[1],
            point[2] * scale[2],
        ];
        if let Some(roll) = self.roll {
            let (s, c) = sin_cos_degrees(roll);
            (x, y) = (x * c - y * s, x * s + y * c);
        }
        if let Some(pitch) = self.pitch {
            let (s, c) = sin_cos_degrees(pitch);
            (y, z) = (y * c - z * s, y * s + z * c);
        }
        if let Some(yaw) = self.yaw {
            let (s, c) = sin_cos_degrees(yaw);
            (x, z) = (x * c + z * s, -x * s + z * c);
        }
        let position = self.position.unwrap_or([0.0; 3]);
        [x + position[0], y + position[1], z + position[2]]
    }

    /// 变换包围盒的 8 个角点，再取包围盒。
    pub fn apply_aabb(&self, aabb: &Aabb) -> Aabb {
        Aabb::from_points(aabb.corners().map(|corner| self.apply(corner)))
            .expect("8 个角点不会为空")
    }

    fn validate(&self, path: &str) -> Result<(), ShapeError> {
        if let Some(position) = self.position {
            coords(&format!("{path}.position"), &position)?;
        }
        for (name, value) in [
            ("yaw", self.yaw),
            ("pitch", self.pitch),
            ("roll", self.roll),
        ] {
            if let Some(value) = value {
                if !value.is_finite() || value.abs() > MAX_ANGLE {
                    return Err(ShapeError::new(
                        &format!("{path}.{name}"),
                        "角度必须是有限值且绝对值不超过 3600",
                    ));
                }
            }
        }
        if let Some(scale) = self.scale {
            for (axis, value) in scale.iter().enumerate() {
                if !value.is_finite() || *value == 0.0 || value.abs() > MAX_SCALE {
                    return Err(ShapeError::new(
                        &format!("{path}.scale[{axis}]"),
                        "缩放必须是非零有限值且绝对值不超过 1000",
                    ));
                }
            }
        }
        Ok(())
    }
}

/// 贴图坐标的生成方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UvMode {
    Box,
    Planar,
    Cylindrical,
    Mesh,
}

/// 着色方式（SHAPES 2"着色、法线、粗糙度"）。不给时按 `baked`。
///
/// 只影响贴图材质（以及物件模型，SHAPES 3）：`baked` 是扫描烘焙贴图的看法，贴图里已经带了光照；
/// `albedo` 是固有色、完整受光。颜色材质两种取值画法一样。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Shading {
    Baked,
    Albedo,
}

/// 材质：`{ "color": [r,g,b] }`，或 `{ "texture": "<资源哈希>", "uv": …, "tint"?: [r,g,b] }`。
/// 两种都可以带 `opacity`（0–1，默认 1，小于 1 时半透明，用于玻璃）和 `unlit`
/// （默认 false，为真时不受光照，用于屏幕、灯箱），以及平铺、着色方式、法线和粗糙度
/// （SHAPES 2"贴图坐标的平铺、着色、法线与粗糙度"）。新字段都不给时与旧数据完全相同。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Material {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<[u8; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uv: Option<UvMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<[u8; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlit: Option<bool>,
    /// 贴图在表面上每重复一次的实际尺寸 `[u, v]`（米，0 < x ≤ 100）：给了就按米算贴图坐标、
    /// 重复采样；不给就是旧的按包围盒归一化。只用于有贴图坐标的材质。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile: Option<[f64; 2]>,
    /// 贴图坐标的平移 `[u, v]`（米，绝对值 ≤ 1000），只能和 `tile` 一起给。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<[f64; 2]>,
    /// 贴图在表面上逆时针转的角度（度，−360 到 360），只能和 `tile` 一起给。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shading: Option<Shading>,
    /// 切线空间法线贴图（资源哈希，OpenGL 约定，与 glTF 相同）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normal_map: Option<String>,
    /// 法线贴图的强度（0 到 4，默认 1），只能和 `normalMap` 一起给。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normal_scale: Option<f64>,
    /// 粗糙度贴图（资源哈希，灰度，白 = 粗糙）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roughness_map: Option<String>,
    /// 粗糙度（0 到 1）；和 `roughnessMap` 一起给时是乘数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roughness: Option<f64>,
    /// 金属度（0 到 1），只有标量。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metalness: Option<f64>,
}

/// 不透明度必须是 0 到 1 之间的有限值。
pub fn validate_opacity(path: &str, opacity: Option<f64>) -> Result<(), ShapeError> {
    match opacity {
        Some(value) if !(value.is_finite() && (0.0..=1.0).contains(&value)) => {
            Err(ShapeError::new(path, "不透明度必须在 0 到 1 之间"))
        }
        _ => Ok(()),
    }
}

/// 可选的数是 `[min, max]` 之内的有限值，否则在 `{path}.{name}` 报 `message`。
fn in_range(
    path: &str,
    name: &str,
    value: Option<f64>,
    [min, max]: [f64; 2],
    message: &str,
) -> Result<(), ShapeError> {
    match value {
        Some(value) if !(value.is_finite() && min <= value && value <= max) => {
            Err(ShapeError::new(&format!("{path}.{name}"), message))
        }
        _ => Ok(()),
    }
}

/// 可选的资源哈希必须是 64 位小写十六进制。
fn asset_hash(path: &str, name: &str, value: Option<&String>) -> Result<(), ShapeError> {
    match value {
        Some(hash) if !is_sha256_hex(hash) => Err(ShapeError::new(
            &format!("{path}.{name}"),
            format!("{name} 必须是 64 位小写十六进制的资源哈希"),
        )),
        _ => Ok(()),
    }
}

impl Material {
    /// 带了法线贴图或粗糙度贴图（颜色材质这时也要有贴图坐标）。
    fn has_maps(&self) -> bool {
        self.normal_map.is_some() || self.roughness_map.is_some()
    }

    /// 材质引用的贴图资源：`texture`、`normalMap`、`roughnessMap`（SHAPES 2"资源引用"）。
    pub fn texture_refs(&self) -> impl Iterator<Item = &str> {
        [&self.texture, &self.normal_map, &self.roughness_map]
            .into_iter()
            .flatten()
            .map(String::as_str)
    }

    fn validate(&self, path: &str) -> Result<(), ShapeError> {
        validate_opacity(&format!("{path}.opacity"), self.opacity)?;
        self.validate_mapping(path)?;
        if self.normal_scale.is_some() && self.normal_map.is_none() {
            return Err(ShapeError::new(
                &format!("{path}.normalScale"),
                "normalScale 只能和 normalMap 一起给",
            ));
        }
        in_range(
            path,
            "normalScale",
            self.normal_scale,
            [0.0, MAX_NORMAL_SCALE],
            "normalScale 必须在 0 到 4 之间",
        )?;
        in_range(
            path,
            "roughness",
            self.roughness,
            [0.0, 1.0],
            "roughness 必须在 0 到 1 之间",
        )?;
        in_range(
            path,
            "metalness",
            self.metalness,
            [0.0, 1.0],
            "metalness 必须在 0 到 1 之间",
        )?;
        asset_hash(path, "normalMap", self.normal_map.as_ref())?;
        asset_hash(path, "roughnessMap", self.roughness_map.as_ref())?;
        match (&self.color, &self.texture) {
            (Some(_), None) => {
                if self.tint.is_some() || (self.uv.is_some() && !self.has_maps()) {
                    return Err(ShapeError::new(path, "纯色材质不能带 uv 或 tint"));
                }
                if self.has_maps() && self.uv.is_none() {
                    return Err(ShapeError::new(
                        path,
                        "颜色材质带 normalMap 或 roughnessMap 时必须给出 uv",
                    ));
                }
            }
            (None, Some(texture)) => {
                if !is_sha256_hex(texture) {
                    return Err(ShapeError::new(
                        &format!("{path}.texture"),
                        "贴图必须是 64 位小写十六进制的资源哈希",
                    ));
                }
                if self.uv.is_none() {
                    return Err(ShapeError::new(path, "贴图材质必须给出 uv"));
                }
            }
            _ => return Err(ShapeError::new(path, "材质必须且只能给出 color 或 texture")),
        }
        // 上面已经保证：有 uv 的只有贴图材质和带法线、粗糙度贴图的颜色材质。
        if self.tile.is_some() && self.uv.is_none() {
            return Err(ShapeError::new(
                &format!("{path}.tile"),
                "tile、offset、rotate 只用于有贴图坐标（uv）的材质",
            ));
        }
        Ok(())
    }

    /// `tile`、`offset`、`rotate` 的取值和搭配。
    fn validate_mapping(&self, path: &str) -> Result<(), ShapeError> {
        if let Some(tile) = self.tile {
            if !tile
                .iter()
                .all(|x| x.is_finite() && *x > 0.0 && *x <= MAX_TILE)
            {
                return Err(ShapeError::new(
                    &format!("{path}.tile"),
                    "tile 的两个数都必须大于 0、不超过 100（米）",
                ));
            }
        }
        for (name, given) in [
            ("offset", self.offset.is_some()),
            ("rotate", self.rotate.is_some()),
        ] {
            if given && self.tile.is_none() {
                return Err(ShapeError::new(
                    &format!("{path}.{name}"),
                    "offset、rotate 只能和 tile 一起给",
                ));
            }
        }
        if let Some(offset) = self.offset {
            if !offset
                .iter()
                .all(|x| x.is_finite() && x.abs() <= MAX_UV_OFFSET)
            {
                return Err(ShapeError::new(
                    &format!("{path}.offset"),
                    "offset 的两个数绝对值都不能超过 1000（米）",
                ));
            }
        }
        in_range(
            path,
            "rotate",
            self.rotate,
            [-MAX_UV_ROTATE, MAX_UV_ROTATE],
            "rotate 必须在 −360 到 360 度之间",
        )
    }
}

/// 轮廓里第 `from` 点到下一点之间的圆弧。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutlineArc {
    pub from: usize,
    pub bulge: f64,
}

/// 轮廓第 `at` 个顶点处的圆角。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutlineFillet {
    pub at: usize,
    pub radius: f64,
}

/// 二维轮廓，点是 `[x, z]`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Outline {
    pub points: Vec<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arcs: Option<Vec<OutlineArc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fillets: Option<Vec<OutlineFillet>>,
}

impl Outline {
    fn validate(&self, path: &str) -> Result<(), ShapeError> {
        if self.closed == Some(false) {
            return Err(ShapeError::new(
                &format!("{path}.closed"),
                "拉伸和放样的轮廓必须闭合",
            ));
        }
        let count = self.points.len();
        if !(3..=MAX_POINTS).contains(&count) {
            return Err(ShapeError::new(
                &format!("{path}.points"),
                "轮廓需要 3 到 1024 个点",
            ));
        }
        for (index, point) in self.points.iter().enumerate() {
            coords(&format!("{path}.points[{index}]"), point)?;
        }
        if signed_area(&self.points) <= 0.0 {
            return Err(ShapeError::new(
                &format!("{path}.points"),
                "轮廓的点必须逆时针排列（有向面积为正）",
            ));
        }
        let mut seen = BTreeSet::new();
        for (index, arc) in self.arcs.iter().flatten().enumerate() {
            let at = format!("{path}.arcs[{index}]");
            if arc.from >= count || !seen.insert(arc.from) {
                return Err(ShapeError::new(&at, "from 超出点数或重复"));
            }
            if !arc.bulge.is_finite() || arc.bulge.abs() > MAX_BULGE {
                return Err(ShapeError::new(
                    &at,
                    "bulge 必须是有限值且绝对值不超过 1000",
                ));
            }
        }
        let mut seen = BTreeSet::new();
        for (index, fillet) in self.fillets.iter().flatten().enumerate() {
            let at = format!("{path}.fillets[{index}]");
            if fillet.at >= count || !seen.insert(fillet.at) {
                return Err(ShapeError::new(&at, "at 超出点数或重复"));
            }
            positive(&format!("{at}.radius"), fillet.radius)?;
        }
        Ok(())
    }

    /// 二维包围盒 `(min, max)`，含圆弧极值点，忽略圆角。
    pub fn bounds_2d(&self) -> ([f64; 2], [f64; 2]) {
        let mut min = self.points[0];
        let mut max = self.points[0];
        let mut include = |p: [f64; 2]| {
            for axis in 0..2 {
                min[axis] = min[axis].min(p[axis]);
                max[axis] = max[axis].max(p[axis]);
            }
        };
        for point in &self.points {
            include(*point);
        }
        let count = self.points.len();
        for arc in self.arcs.iter().flatten() {
            let start = self.points[arc.from];
            let end = self.points[(arc.from + 1) % count];
            for point in arc_extremes(start, end, arc.bulge) {
                include(point);
            }
        }
        (min, max)
    }
}

/// 有向面积（逆时针为正）。
pub fn signed_area(points: &[[f64; 2]]) -> f64 {
    let count = points.len();
    (0..count)
        .map(|i| {
            let a = points[i];
            let b = points[(i + 1) % count];
            a[0] * b[1] - b[0] * a[1]
        })
        .sum::<f64>()
        / 2.0
}

/// 从 `start` 到 `end`、凸度为 `bulge` 的圆弧上，落在 u、v 轴向极值处的点。
///
/// 圆心 = 弦中点 + 弦的左法向 × `c(1 − b²) / (4b)`，半径 = `c(1 + b²) / (4|b|)`，
/// 圆心角 = `4·atan(b)`（正值逆时针）。极值点用圆心 ± 半径沿坐标轴给出。
pub fn arc_extremes(start: [f64; 2], end: [f64; 2], bulge: f64) -> Vec<[f64; 2]> {
    let du = end[0] - start[0];
    let dv = end[1] - start[1];
    let chord = (du * du + dv * dv).sqrt();
    if bulge == 0.0 || chord == 0.0 {
        return Vec::new();
    }
    let left = [-dv / chord, du / chord];
    let offset = chord * (1.0 - bulge * bulge) / (4.0 * bulge);
    let center = [
        (start[0] + end[0]) / 2.0 + left[0] * offset,
        (start[1] + end[1]) / 2.0 + left[1] * offset,
    ];
    let radius = chord * (1.0 + bulge * bulge) / (4.0 * bulge.abs());
    let sweep = 4.0 * bulge.atan();
    let begin = (start[1] - center[1]).atan2(start[0] - center[0]);
    [
        (0.0, [1.0, 0.0]),
        (FRAC_PI_2, [0.0, 1.0]),
        (PI, [-1.0, 0.0]),
        (3.0 * FRAC_PI_2, [0.0, -1.0]),
    ]
    .into_iter()
    .filter(|(angle, _)| {
        let delta = if sweep > 0.0 {
            (angle - begin).rem_euclid(TAU)
        } else {
            (begin - angle).rem_euclid(TAU)
        };
        delta <= sweep.abs()
    })
    .map(|(_, direction)| {
        [
            center[0] + radius * direction[0],
            center[1] + radius * direction[1],
        ]
    })
    .collect()
}

/// 扫掠截面：`{ "circle": r }` 或 `{ "rect": [w, h] }`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", deny_unknown_fields)]
pub enum Section {
    Circle(f64),
    Rect([f64; 2]),
}

impl Section {
    /// 截面的外接半径。
    pub fn reach(&self) -> f64 {
        match self {
            Section::Circle(radius) => *radius,
            Section::Rect([width, height]) => (width * width + height * height).sqrt() / 2.0,
        }
    }
}

/// 放样截面。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoftSection {
    pub y: f64,
    pub outline: Outline,
}

/// 形状类型及其专属字段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ShapeKind {
    #[serde(rename = "box")]
    Cuboid {
        size: [f64; 3],
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fillet: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        chamfer: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        segments: Option<u32>,
    },
    Cylinder {
        radius: f64,
        height: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        radius_top: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        segments: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fillet: Option<f64>,
    },
    Cone {
        radius: f64,
        height: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        segments: Option<u32>,
    },
    Extrude {
        outline: Outline,
        height: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fillet: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        chamfer: Option<f64>,
    },
    Lathe {
        profile: Vec<[f64; 2]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        segments: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        angle: Option<f64>,
    },
    Sweep {
        path: Vec<[f64; 3]>,
        section: Section,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        smooth: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        caps: Option<bool>,
    },
    Loft {
        sections: Vec<LoftSection>,
    },
    /// 平面多边形沿 −法向 加厚成的板（斜面折板、台面）。
    Plate {
        points: Vec<[f64; 3]>,
        thickness: f64,
    },
    /// 点的凸包实体（楔形、船头这类凸多面体）。
    Hull {
        points: Vec<[f64; 3]>,
    },
    Group {
        children: Vec<Shape>,
    },
    Instance {
        template: String,
    },
}

impl ShapeKind {
    pub fn type_name(&self) -> &'static str {
        match self {
            ShapeKind::Cuboid { .. } => "box",
            ShapeKind::Cylinder { .. } => "cylinder",
            ShapeKind::Cone { .. } => "cone",
            ShapeKind::Extrude { .. } => "extrude",
            ShapeKind::Lathe { .. } => "lathe",
            ShapeKind::Sweep { .. } => "sweep",
            ShapeKind::Loft { .. } => "loft",
            ShapeKind::Plate { .. } => "plate",
            ShapeKind::Hull { .. } => "hull",
            ShapeKind::Group { .. } => "group",
            ShapeKind::Instance { .. } => "instance",
        }
    }
}

/// 一个形状：类型字段 + 可选的变换和材质。
#[derive(Debug, Clone, PartialEq)]
pub struct Shape {
    pub kind: ShapeKind,
    pub transform: Option<Transform>,
    pub material: Option<Material>,
}

impl Serialize for Shape {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut value = serde_json::to_value(&self.kind).map_err(ser::Error::custom)?;
        let map = value
            .as_object_mut()
            .ok_or_else(|| ser::Error::custom("形状必须序列化成对象"))?;
        if let Some(transform) = &self.transform {
            map.insert(
                "transform".into(),
                serde_json::to_value(transform).map_err(ser::Error::custom)?,
            );
        }
        if let Some(material) = &self.material {
            map.insert(
                "material".into(),
                serde_json::to_value(material).map_err(ser::Error::custom)?,
            );
        }
        value.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Shape {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut map = Map::<String, Value>::deserialize(deserializer)?;
        let transform = map
            .remove("transform")
            .map(Transform::deserialize)
            .transpose()
            .map_err(|error| de::Error::custom(format!("transform: {error}")))?;
        let material = map
            .remove("material")
            .map(Material::deserialize)
            .transpose()
            .map_err(|error| de::Error::custom(format!("material: {error}")))?;
        let kind = ShapeKind::deserialize(Value::Object(map)).map_err(de::Error::custom)?;
        Ok(Shape {
            kind,
            transform,
            material,
        })
    }
}

fn sub3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// 板的中心、单位法向和面积。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlateFrame {
    /// 各点的平均。
    pub center: [f64; 3],
    /// Newell 法向（单位向量）：点从这一侧看是逆时针。
    pub normal: [f64; 3],
    /// 多边形面积（平方米）。
    pub area: f64,
}

/// 板的中心和 Newell 法向：`N = Σ (Pᵢ − c) × (Pᵢ₊₁ − c)`，面积 = `|N| / 2`。
/// 面积小于 [`MIN_PLATE_AREA`]（点几乎共线）时返回 `None`。
pub fn plate_frame(points: &[[f64; 3]]) -> Option<PlateFrame> {
    if points.len() < MIN_PLATE_POINTS {
        return None;
    }
    let count = points.len() as f64;
    let mut sum = [0.0; 3];
    for p in points {
        for axis in 0..3 {
            sum[axis] += p[axis];
        }
    }
    let center = [sum[0] / count, sum[1] / count, sum[2] / count];
    let mut newell = [0.0; 3];
    for (i, p) in points.iter().enumerate() {
        let q = points[(i + 1) % points.len()];
        let c = cross3(sub3(*p, center), sub3(q, center));
        for axis in 0..3 {
            newell[axis] += c[axis];
        }
    }
    let length = dot3(newell, newell).sqrt();
    let area = length / 2.0;
    if area.is_nan() || area < MIN_PLATE_AREA {
        return None;
    }
    Some(PlateFrame {
        center,
        normal: [newell[0] / length, newell[1] / length, newell[2] / length],
        area,
    })
}

/// 简单多边形检查用的投影：去掉法向分量绝对值最大的坐标轴（并列时先去 x、再 y），
/// 返回剩下两个坐标轴的下标（从小到大）。
pub fn plate_projection_axes(normal: [f64; 3]) -> [usize; 2] {
    let [x, y, z] = normal.map(f64::abs);
    if x >= y && x >= z {
        [1, 2]
    } else if y >= z {
        [0, 2]
    } else {
        [0, 1]
    }
}

fn orient2(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// `p` 落在线段 `ab` 的外包矩形里（已知三点共线时就是落在线段上）。
fn within(a: [f64; 2], b: [f64; 2], p: [f64; 2]) -> bool {
    a[0].min(b[0]) <= p[0]
        && p[0] <= a[0].max(b[0])
        && a[1].min(b[1]) <= p[1]
        && p[1] <= a[1].max(b[1])
}

/// 两条线段是否相交（含端点接触、共线重叠）。
pub fn segments_intersect(p1: [f64; 2], p2: [f64; 2], p3: [f64; 2], p4: [f64; 2]) -> bool {
    let d1 = orient2(p3, p4, p1);
    let d2 = orient2(p3, p4, p2);
    let d3 = orient2(p1, p2, p3);
    let d4 = orient2(p1, p2, p4);
    let straddle = |a: f64, b: f64| (a > 0.0 && b < 0.0) || (a < 0.0 && b > 0.0);
    if straddle(d1, d2) && straddle(d3, d4) {
        return true;
    }
    (d1 == 0.0 && within(p3, p4, p1))
        || (d2 == 0.0 && within(p3, p4, p2))
        || (d3 == 0.0 && within(p1, p2, p3))
        || (d4 == 0.0 && within(p1, p2, p4))
}

fn validate_plate(path: &str, points: &[[f64; 3]], thickness: f64) -> Result<(), ShapeError> {
    let at = format!("{path}.points");
    if !(MIN_PLATE_POINTS..=MAX_PLATE_POINTS).contains(&points.len()) {
        return Err(ShapeError::new(&at, "板需要 3 到 64 个点"));
    }
    for (index, point) in points.iter().enumerate() {
        coords(&format!("{at}[{index}]"), point)?;
    }
    if !(thickness.is_finite() && thickness > 0.0 && thickness <= MAX_PLATE_THICKNESS) {
        return Err(ShapeError::new(
            &format!("{path}.thickness"),
            "厚度必须大于 0 且不超过 1 米",
        ));
    }
    let count = points.len();
    for (index, point) in points.iter().enumerate() {
        let edge = sub3(points[(index + 1) % count], *point);
        if dot3(edge, edge) <= MIN_EDGE_LENGTH * MIN_EDGE_LENGTH {
            return Err(ShapeError::new(&format!("{at}[{index}]"), "与下一点重合"));
        }
    }
    let frame =
        plate_frame(points).ok_or_else(|| ShapeError::new(&at, "面积太小（点几乎共线）"))?;
    for (index, point) in points.iter().enumerate() {
        if dot3(sub3(*point, frame.center), frame.normal).abs() > FLAT_TOLERANCE {
            return Err(ShapeError::new(
                &format!("{at}[{index}]"),
                "离最佳拟合平面超过 1 毫米",
            ));
        }
    }
    let [u, v] = plate_projection_axes(frame.normal);
    let flat: Vec<[f64; 2]> = points.iter().map(|p| [p[u], p[v]]).collect();
    for index in 0..count {
        let here = flat[index];
        let prev = flat[(index + count - 1) % count];
        let next = flat[(index + 1) % count];
        let a = [prev[0] - here[0], prev[1] - here[1]];
        let b = [next[0] - here[0], next[1] - here[1]];
        if a[0] * b[1] - a[1] * b[0] == 0.0 && a[0] * b[0] + a[1] * b[1] > 0.0 {
            return Err(ShapeError::new(
                &format!("{at}[{index}]"),
                "相邻两条边在这一点折回",
            ));
        }
    }
    for i in 0..count {
        for j in i + 2..count {
            if i == 0 && j == count - 1 {
                continue;
            }
            if segments_intersect(flat[i], flat[i + 1], flat[j], flat[(j + 1) % count]) {
                return Err(ShapeError::new(&at, "多边形自相交"));
            }
        }
    }
    Ok(())
}

/// 凸包退化判定（见模块文档）：点重合、共线或共面时返回说明。
pub fn hull_degeneracy(points: &[[f64; 3]]) -> Result<(), &'static str> {
    let Some(&a) = points.first() else {
        return Err("没有点");
    };
    let tolerance = FLAT_TOLERANCE * FLAT_TOLERANCE;
    // 第一个取到最大值的点和这个最大值。
    let farthest = |measure: &dyn Fn([f64; 3]) -> f64| {
        let mut best = (0usize, f64::NEG_INFINITY);
        for (index, point) in points.iter().enumerate() {
            let value = measure(*point);
            if value > best.1 {
                best = (index, value);
            }
        }
        best
    };
    let (b, spread) = farthest(&|p| {
        let d = sub3(p, a);
        dot3(d, d)
    });
    if spread <= tolerance {
        return Err("点全部重合（容差 1 毫米）");
    }
    let axis = sub3(points[b], a);
    let axis_sq = dot3(axis, axis);
    let (c, offset) = farthest(&|p| {
        let c = cross3(sub3(p, a), axis);
        dot3(c, c) / axis_sq
    });
    if offset <= tolerance {
        return Err("点全部共线（容差 1 毫米）");
    }
    let normal = cross3(axis, sub3(points[c], a));
    let normal_sq = dot3(normal, normal);
    let (_, height) = farthest(&|p| {
        let h = dot3(sub3(p, a), normal);
        h * h / normal_sq
    });
    if height <= tolerance {
        return Err("点全部共面（容差 1 毫米）");
    }
    Ok(())
}

fn validate_hull(path: &str, points: &[[f64; 3]]) -> Result<(), ShapeError> {
    let at = format!("{path}.points");
    if !(MIN_HULL_POINTS..=MAX_HULL_POINTS).contains(&points.len()) {
        return Err(ShapeError::new(&at, "凸包需要 4 到 256 个点"));
    }
    for (index, point) in points.iter().enumerate() {
        coords(&format!("{at}[{index}]"), point)?;
    }
    hull_degeneracy(points).map_err(|message| ShapeError::new(&at, message))
}

/// 按编号查模板（模板是空间里 `kind: "template"` 的物件）。
pub trait TemplateSource {
    fn template(&self, id: &str) -> Option<&Shape>;
}

impl TemplateSource for BTreeMap<String, Shape> {
    fn template(&self, id: &str) -> Option<&Shape> {
        self.get(id)
    }
}

/// 不提供任何模板；遇到 `instance` 就报错。
pub struct NoTemplates;

impl TemplateSource for NoTemplates {
    fn template(&self, _id: &str) -> Option<&Shape> {
        None
    }
}

fn finite(path: &str, value: f64) -> Result<(), ShapeError> {
    if value.is_finite() && value.abs() <= MAX_COORD {
        Ok(())
    } else {
        Err(ShapeError::new(path, "必须是有限值且绝对值不超过 100000"))
    }
}

fn positive(path: &str, value: f64) -> Result<(), ShapeError> {
    finite(path, value)?;
    if value > 0.0 {
        Ok(())
    } else {
        Err(ShapeError::new(path, "必须大于 0"))
    }
}

fn non_negative(path: &str, value: f64) -> Result<(), ShapeError> {
    finite(path, value)?;
    if value >= 0.0 {
        Ok(())
    } else {
        Err(ShapeError::new(path, "不能小于 0"))
    }
}

fn coords(path: &str, values: &[f64]) -> Result<(), ShapeError> {
    for (index, value) in values.iter().enumerate() {
        finite(&format!("{path}[{index}]"), *value)?;
    }
    Ok(())
}

fn segments(path: &str, value: Option<u32>, min: u32, max: u32) -> Result<(), ShapeError> {
    match value {
        Some(value) if !(min..=max).contains(&value) => Err(ShapeError::new(
            path,
            format!("分段数必须在 {min} 到 {max} 之间"),
        )),
        _ => Ok(()),
    }
}

fn optional(
    path: &str,
    value: Option<f64>,
    check: fn(&str, f64) -> Result<(), ShapeError>,
) -> Result<(), ShapeError> {
    value.map_or(Ok(()), |value| check(path, value))
}

impl Shape {
    /// 结构校验：字段取值、点数、嵌套深度、节点数。不解析模板引用。
    pub fn validate(&self) -> Result<(), ShapeError> {
        let mut nodes = 0;
        self.validate_at("$", 0, &mut nodes)
    }

    fn validate_at(&self, path: &str, depth: usize, nodes: &mut usize) -> Result<(), ShapeError> {
        *nodes += 1;
        if *nodes > MAX_SHAPE_NODES {
            return Err(ShapeError::new(path, "形状节点数超过 4096"));
        }
        if depth > MAX_SHAPE_DEPTH {
            return Err(ShapeError::new(path, "形状嵌套超过 16 层"));
        }
        if let Some(transform) = &self.transform {
            transform.validate(&format!("{path}.transform"))?;
        }
        if let Some(material) = &self.material {
            material.validate(&format!("{path}.material"))?;
        }
        match &self.kind {
            ShapeKind::Cuboid {
                size,
                fillet,
                chamfer,
                segments: count,
            } => {
                for (axis, value) in size.iter().enumerate() {
                    positive(&format!("{path}.size[{axis}]"), *value)?;
                }
                optional(&format!("{path}.fillet"), *fillet, non_negative)?;
                optional(&format!("{path}.chamfer"), *chamfer, non_negative)?;
                segments(&format!("{path}.segments"), *count, 1, MAX_FILLET_SEGMENTS)?;
            }
            ShapeKind::Cylinder {
                radius,
                height,
                radius_top,
                segments: count,
                fillet,
            } => {
                positive(&format!("{path}.radius"), *radius)?;
                positive(&format!("{path}.height"), *height)?;
                optional(&format!("{path}.radiusTop"), *radius_top, non_negative)?;
                segments(&format!("{path}.segments"), *count, 3, MAX_SEGMENTS)?;
                optional(&format!("{path}.fillet"), *fillet, non_negative)?;
            }
            ShapeKind::Cone {
                radius,
                height,
                segments: count,
            } => {
                positive(&format!("{path}.radius"), *radius)?;
                positive(&format!("{path}.height"), *height)?;
                segments(&format!("{path}.segments"), *count, 3, MAX_SEGMENTS)?;
            }
            ShapeKind::Extrude {
                outline,
                height,
                fillet,
                chamfer,
            } => {
                outline.validate(&format!("{path}.outline"))?;
                positive(&format!("{path}.height"), *height)?;
                optional(&format!("{path}.fillet"), *fillet, non_negative)?;
                optional(&format!("{path}.chamfer"), *chamfer, non_negative)?;
            }
            ShapeKind::Lathe {
                profile,
                segments: count,
                angle,
            } => {
                if !(2..=MAX_POINTS).contains(&profile.len()) {
                    return Err(ShapeError::new(
                        &format!("{path}.profile"),
                        "旋转体轮廓需要 2 到 1024 个点",
                    ));
                }
                for (index, [r, y]) in profile.iter().enumerate() {
                    non_negative(&format!("{path}.profile[{index}][0]"), *r)?;
                    finite(&format!("{path}.profile[{index}][1]"), *y)?;
                }
                if profile.iter().all(|[r, _]| *r == 0.0) {
                    return Err(ShapeError::new(
                        &format!("{path}.profile"),
                        "旋转体轮廓至少要有一个点不在轴上",
                    ));
                }
                segments(&format!("{path}.segments"), *count, 3, MAX_SEGMENTS)?;
                if let Some(angle) = angle {
                    if !(angle.is_finite() && *angle > 0.0 && *angle <= 360.0) {
                        return Err(ShapeError::new(
                            &format!("{path}.angle"),
                            "旋转角度必须在 (0, 360] 之间",
                        ));
                    }
                }
            }
            ShapeKind::Sweep {
                path: points,
                section,
                smooth,
                caps: _,
            } => {
                if !(2..=MAX_POINTS).contains(&points.len()) {
                    return Err(ShapeError::new(
                        &format!("{path}.path"),
                        "扫掠路径需要 2 到 1024 个点",
                    ));
                }
                for (index, point) in points.iter().enumerate() {
                    coords(&format!("{path}.path[{index}]"), point)?;
                }
                match section {
                    Section::Circle(radius) => {
                        positive(&format!("{path}.section.circle"), *radius)?
                    }
                    Section::Rect([width, height]) => {
                        positive(&format!("{path}.section.rect[0]"), *width)?;
                        positive(&format!("{path}.section.rect[1]"), *height)?;
                    }
                }
                optional(&format!("{path}.smooth"), *smooth, non_negative)?;
            }
            ShapeKind::Loft { sections } => {
                if !(MIN_LOFT_SECTIONS..=MAX_LOFT_SECTIONS).contains(&sections.len()) {
                    return Err(ShapeError::new(
                        &format!("{path}.sections"),
                        "放样需要 2 到 8 个截面",
                    ));
                }
                for (index, section) in sections.iter().enumerate() {
                    let at = format!("{path}.sections[{index}]");
                    finite(&format!("{at}.y"), section.y)?;
                    if index > 0 && section.y <= sections[index - 1].y {
                        return Err(ShapeError::new(&format!("{at}.y"), "截面的 y 必须递增"));
                    }
                    section.outline.validate(&format!("{at}.outline"))?;
                }
            }
            ShapeKind::Plate { points, thickness } => {
                validate_plate(path, points, *thickness)?;
            }
            ShapeKind::Hull { points } => {
                validate_hull(path, points)?;
            }
            ShapeKind::Group { children } => {
                if children.is_empty() {
                    return Err(ShapeError::new(
                        &format!("{path}.children"),
                        "组合至少要有一个子形状",
                    ));
                }
                for (index, child) in children.iter().enumerate() {
                    child.validate_at(&format!("{path}.children[{index}]"), depth + 1, nodes)?;
                }
            }
            ShapeKind::Instance { template } => {
                if !is_object_id(template) {
                    return Err(ShapeError::new(
                        &format!("{path}.template"),
                        "模板编号格式不对",
                    ));
                }
            }
        }
        Ok(())
    }

    /// 引用到的全部模板编号（不展开模板本身）。
    pub fn template_refs(&self) -> BTreeSet<String> {
        let mut refs = BTreeSet::new();
        self.collect_refs(&mut refs);
        refs
    }

    fn collect_refs(&self, refs: &mut BTreeSet<String>) {
        match &self.kind {
            ShapeKind::Group { children } => children.iter().for_each(|c| c.collect_refs(refs)),
            ShapeKind::Instance { template } => {
                refs.insert(template.clone());
            }
            _ => {}
        }
    }

    /// 引用到的全部贴图资源：本形状和全部子形状（含模板实例自己的材质，不展开模板本身）材质里的
    /// `texture`、`normalMap`、`roughnessMap`（SHAPES 2"资源引用"）。
    pub fn texture_refs(&self) -> BTreeSet<String> {
        let mut refs = BTreeSet::new();
        self.collect_texture_refs(&mut refs);
        refs
    }

    fn collect_texture_refs(&self, refs: &mut BTreeSet<String>) {
        if let Some(material) = &self.material {
            refs.extend(material.texture_refs().map(str::to_owned));
        }
        if let ShapeKind::Group { children } = &self.kind {
            children
                .iter()
                .for_each(|child| child.collect_texture_refs(refs));
        }
    }

    /// 包围盒（含本形状自己的 `transform`），规则见模块文档。
    /// 模板的包围盒只算一次并缓存；模板循环引用或嵌套过深时报错。
    pub fn bounds(&self, templates: &dyn TemplateSource) -> Result<Aabb, ShapeError> {
        let mut cache = BoundsCache::default();
        self.bounds_at("$", 0, templates, &mut cache)
    }

    fn bounds_at(
        &self,
        path: &str,
        depth: usize,
        templates: &dyn TemplateSource,
        cache: &mut BoundsCache,
    ) -> Result<Aabb, ShapeError> {
        if depth > MAX_SHAPE_DEPTH {
            return Err(ShapeError::new(path, "形状嵌套超过 16 层"));
        }
        let local = match &self.kind {
            ShapeKind::Cuboid { size, .. } => Aabb {
                min: [-size[0] / 2.0, 0.0, -size[2] / 2.0],
                max: [size[0] / 2.0, size[1], size[2] / 2.0],
            },
            ShapeKind::Cylinder {
                radius,
                height,
                radius_top,
                ..
            } => {
                let r = radius.max(radius_top.unwrap_or(*radius));
                Aabb {
                    min: [-r, 0.0, -r],
                    max: [r, *height, r],
                }
            }
            ShapeKind::Cone { radius, height, .. } => Aabb {
                min: [-radius, 0.0, -radius],
                max: [*radius, *height, *radius],
            },
            ShapeKind::Extrude {
                outline, height, ..
            } => {
                let (min, max) = outline.bounds_2d();
                Aabb {
                    min: [min[0], 0.0, min[1]],
                    max: [max[0], *height, max[1]],
                }
            }
            ShapeKind::Lathe { profile, .. } => {
                let reach = profile.iter().map(|[r, _]| *r).fold(0.0, f64::max);
                let low = profile
                    .iter()
                    .map(|[_, y]| *y)
                    .fold(f64::INFINITY, f64::min);
                let high = profile
                    .iter()
                    .map(|[_, y]| *y)
                    .fold(f64::NEG_INFINITY, f64::max);
                Aabb {
                    min: [-reach, low, -reach],
                    max: [reach, high, reach],
                }
            }
            ShapeKind::Sweep {
                path: points,
                section,
                ..
            } => {
                let reach = section.reach();
                let mut aabb = Aabb::from_points(points.iter().copied())
                    .ok_or_else(|| ShapeError::new(path, "扫掠路径为空"))?;
                for axis in 0..3 {
                    aabb.min[axis] -= reach;
                    aabb.max[axis] += reach;
                }
                aabb
            }
            ShapeKind::Loft { sections } => {
                let first = sections
                    .first()
                    .ok_or_else(|| ShapeError::new(path, "放样没有截面"))?;
                let last = sections.last().expect("至少一个截面");
                let mut min2 = [f64::INFINITY; 2];
                let mut max2 = [f64::NEG_INFINITY; 2];
                for section in sections {
                    let (min, max) = section.outline.bounds_2d();
                    for axis in 0..2 {
                        min2[axis] = min2[axis].min(min[axis]);
                        max2[axis] = max2[axis].max(max[axis]);
                    }
                }
                Aabb {
                    min: [min2[0], first.y, min2[1]],
                    max: [max2[0], last.y, max2[1]],
                }
            }
            ShapeKind::Plate { points, thickness } => {
                let frame = plate_frame(points)
                    .ok_or_else(|| ShapeError::new(path, "板的面积太小（点几乎共线）"))?;
                let back = points.iter().map(|p| {
                    [
                        p[0] - thickness * frame.normal[0],
                        p[1] - thickness * frame.normal[1],
                        p[2] - thickness * frame.normal[2],
                    ]
                });
                Aabb::from_points(points.iter().copied().chain(back))
                    .ok_or_else(|| ShapeError::new(path, "板没有点"))?
            }
            ShapeKind::Hull { points } => Aabb::from_points(points.iter().copied())
                .ok_or_else(|| ShapeError::new(path, "凸包没有点"))?,
            ShapeKind::Group { children } => {
                let mut result: Option<Aabb> = None;
                for (index, child) in children.iter().enumerate() {
                    let bounds = child.bounds_at(
                        &format!("{path}.children[{index}]"),
                        depth + 1,
                        templates,
                        cache,
                    )?;
                    result = Some(match result {
                        Some(current) => current.union(&bounds),
                        None => bounds,
                    });
                }
                result.ok_or_else(|| ShapeError::new(path, "组合没有子形状"))?
            }
            ShapeKind::Instance { template } => {
                cache.template_bounds(template, path, depth, templates)?
            }
        };
        Ok(match &self.transform {
            Some(transform) => transform.apply_aabb(&local),
            None => local,
        })
    }
}

#[derive(Default)]
struct BoundsCache {
    done: BTreeMap<String, Aabb>,
    visiting: BTreeSet<String>,
}

impl BoundsCache {
    fn template_bounds(
        &mut self,
        id: &str,
        path: &str,
        depth: usize,
        templates: &dyn TemplateSource,
    ) -> Result<Aabb, ShapeError> {
        if let Some(bounds) = self.done.get(id) {
            return Ok(*bounds);
        }
        if !self.visiting.insert(id.to_owned()) {
            return Err(ShapeError::new(path, format!("模板 {id} 循环引用")));
        }
        let shape = templates
            .template(id)
            .ok_or_else(|| ShapeError::new(path, format!("找不到模板 {id}")))?;
        let bounds = shape.bounds_at(&format!("{path}<{id}>"), depth + 1, templates, self)?;
        self.visiting.remove(id);
        self.done.insert(id.to_owned(), bounds);
        Ok(bounds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn shape(value: Value) -> Shape {
        serde_json::from_value(value).unwrap()
    }

    fn close(a: &Aabb, min: [f64; 3], max: [f64; 3]) {
        for axis in 0..3 {
            assert!((a.min[axis] - min[axis]).abs() < 1e-9, "{a:?} vs {min:?}");
            assert!((a.max[axis] - max[axis]).abs() < 1e-9, "{a:?} vs {max:?}");
        }
    }

    #[test]
    fn json_round_trip_keeps_only_given_fields() {
        let value = json!({"type":"box","size":[1,2,3],"fillet":0.05,
            "transform":{"position":[1,0,0],"yaw":90},"material":{"color":[200,10,0]}});
        let canonical = |v: &Value| crate::canonical::canonical_json(v).unwrap();
        let parsed = shape(value.clone());
        parsed.validate().unwrap();
        assert_eq!(
            canonical(&serde_json::to_value(&parsed).unwrap()),
            canonical(&value)
        );
        let cylinder = json!({"type":"cylinder","radius":0.3,"height":0.7,"radiusTop":0.2});
        assert_eq!(
            serde_json::to_value(shape(cylinder.clone())).unwrap(),
            cylinder
        );
    }

    #[test]
    fn unknown_or_misspelled_fields_are_rejected() {
        for bad in [
            json!({"type":"box","size":[1,1,1],"colour":[1,2,3]}),
            json!({"type":"cylinder","radius":1,"height":1,"radius_top":0.5}),
            json!({"type":"sphere","radius":1}),
            json!({"size":[1,1,1]}),
            json!({"type":"box","size":[1,1,1],"transform":{"rotation":[0,0,0]}}),
            json!({"type":"sweep","path":[[0,0,0],[0,1,0]],"section":{"circle":0.1,"rect":[1,1]}}),
        ] {
            assert!(
                serde_json::from_value::<Shape>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn validation_reports_paths() {
        let bad = shape(json!({"type":"group","children":[
            {"type":"box","size":[1,1,1]},
            {"type":"extrude","height":1,"outline":{"points":[[0,0],[0,1],[1,0]]}}
        ]}));
        let error = bad.validate().unwrap_err();
        assert_eq!(error.path, "$.children[1].outline.points");
        let bad = shape(json!({"type":"box","size":[1,0,1]}));
        assert_eq!(bad.validate().unwrap_err().path, "$.size[1]");
        let bad =
            shape(json!({"type":"box","size":[1,1,1],"material":{"color":[1,1,1],"texture":"x"}}));
        assert_eq!(bad.validate().unwrap_err().path, "$.material");
        let bad = shape(json!({"type":"loft","sections":[
            {"y":0,"outline":{"points":[[0,0],[1,0],[0,1]]}},
            {"y":0,"outline":{"points":[[0,0],[1,0],[0,1]]}}]}));
        assert_eq!(bad.validate().unwrap_err().path, "$.sections[1].y");
    }

    #[test]
    fn primitive_bounds() {
        let b = shape(json!({"type":"box","size":[2,1,4]}))
            .bounds(&NoTemplates)
            .unwrap();
        close(&b, [-1.0, 0.0, -2.0], [1.0, 1.0, 2.0]);
        let b = shape(json!({"type":"cylinder","radius":0.2,"radiusTop":0.5,"height":1}))
            .bounds(&NoTemplates)
            .unwrap();
        close(&b, [-0.5, 0.0, -0.5], [0.5, 1.0, 0.5]);
        let b = shape(json!({"type":"lathe","profile":[[0,0],[0.3,0.1],[0.1,0.9]],"angle":90}))
            .bounds(&NoTemplates)
            .unwrap();
        close(&b, [-0.3, 0.0, -0.3], [0.3, 0.9, 0.3]);
        let b = shape(
            json!({"type":"sweep","path":[[0,0,0],[0,1,0],[1,1,0]],"section":{"rect":[0.06,0.08]}}),
        )
        .bounds(&NoTemplates)
        .unwrap();
        close(&b, [-0.05, -0.05, -0.05], [1.05, 1.05, 0.05]);
    }

    #[test]
    fn transform_order_is_scale_roll_pitch_yaw_translate() {
        let t = Transform {
            position: Some([10.0, 0.0, 0.0]),
            yaw: Some(90.0),
            pitch: None,
            roll: None,
            scale: Some([2.0, 1.0, 1.0]),
        };
        // 先把 (1,0,0) 缩放成 (2,0,0)，再绕 y 转 90° 得到 (0,0,-2)，最后平移。
        assert_eq!(t.apply([1.0, 0.0, 0.0]), [10.0, 0.0, -2.0]);
        let roll = Transform {
            roll: Some(90.0),
            ..Transform::default()
        };
        assert_eq!(roll.apply([1.0, 0.0, 0.0]), [0.0, 1.0, 0.0]);
        let pitch = Transform {
            pitch: Some(90.0),
            ..Transform::default()
        };
        assert_eq!(pitch.apply([0.0, 1.0, 0.0]), [0.0, 0.0, 1.0]);
    }

    #[test]
    fn arcs_extend_outline_bounds() {
        // 底边换成向外（-z 方向）凸的半圆。
        let outline: Outline = serde_json::from_value(json!({
            "points": [[-1,0],[1,0],[1,2],[-1,2]],
            "arcs": [{"from":0,"bulge":1}]
        }))
        .unwrap();
        outline.validate("$").unwrap();
        let (min, max) = outline.bounds_2d();
        assert!((min[1] + 1.0).abs() < 1e-12, "{min:?}");
        assert_eq!(max, [1.0, 2.0]);
        // 负 bulge 向内凹，不扩大包围盒。
        assert!(arc_extremes([-1.0, 0.0], [1.0, 0.0], -1.0)
            .iter()
            .all(|p| p[1] >= 0.0));
        // 小于半圆的弧只有在跨过坐标轴方向时才产生极值点。
        assert!(arc_extremes([0.0, -1.0], [1.0, 0.0], 0.1).is_empty());
    }

    #[test]
    fn instances_resolve_templates_with_cycle_detection() {
        let mut templates = BTreeMap::new();
        templates.insert(
            "chair".to_owned(),
            shape(json!({"type":"group","children":[{"type":"box","size":[0.5,0.9,0.5]}]})),
        );
        let instance = shape(json!({"type":"instance","template":"chair",
            "transform":{"position":[2,0,0]}}));
        let b = instance.bounds(&templates).unwrap();
        close(&b, [1.75, 0.0, -0.25], [2.25, 0.9, 0.25]);
        assert!(instance.bounds(&NoTemplates).is_err());
        templates.insert(
            "loop".to_owned(),
            shape(json!({"type":"instance","template":"loop"})),
        );
        let looped = shape(json!({"type":"instance","template":"loop"}));
        assert!(looped.bounds(&templates).is_err());
    }

    #[test]
    fn plate_normal_follows_right_hand_rule_and_bounds_extend_backwards() {
        // 从 +y 往下看是逆时针 → 法向 +y，板向下加厚。
        let plate = shape(json!({"type":"plate","thickness":0.1,
            "points":[[0,1,0],[0,1,2],[3,1,2],[3,1,0]]}));
        plate.validate().unwrap();
        let ShapeKind::Plate { points, .. } = &plate.kind else {
            unreachable!()
        };
        let frame = plate_frame(points).unwrap();
        assert_eq!(frame.normal, [0.0, 1.0, 0.0]);
        assert!((frame.area - 6.0).abs() < 1e-12);
        close(
            &plate.bounds(&NoTemplates).unwrap(),
            [0.0, 0.9, 0.0],
            [3.0, 1.0, 2.0],
        );
        // 反过来排列，法向朝下，板向上加厚。
        let flipped = shape(json!({"type":"plate","thickness":0.1,
            "points":[[3,1,0],[3,1,2],[0,1,2],[0,1,0]]}));
        close(
            &flipped.bounds(&NoTemplates).unwrap(),
            [0.0, 1.0, 0.0],
            [3.0, 1.1, 2.0],
        );
    }

    #[test]
    fn plate_validation_paths() {
        let path = |value: Value| shape(value).validate().unwrap_err().path;
        assert_eq!(
            path(json!({"type":"plate","thickness":0,"points":[[0,0,0],[1,0,0],[0,1,0]]})),
            "$.thickness"
        );
        assert_eq!(
            path(json!({"type":"plate","thickness":0.1,"points":[[0,0,0],[1,0,0]]})),
            "$.points"
        );
        assert_eq!(
            path(
                json!({"type":"plate","thickness":0.1,"points":[[0,0,0],[1,0,0],[1,0,0],[0,1,0]]})
            ),
            "$.points[1]"
        );
        assert_eq!(
            path(json!({"type":"plate","thickness":0.1,
                "points":[[0,0,0],[1,0,0],[1,1,0.01],[0,1,0]]})),
            "$.points[0]"
        );
        // 不相邻的边只在一点接触也算自相交。
        let touching = json!({"type":"plate","thickness":0.1,
            "points":[[0,0,0],[2,0,0],[2,2,0],[1,0,0],[0,2,0]]});
        assert_eq!(path(touching), "$.points");
        assert!(serde_json::from_value::<Shape>(
            json!({"type":"plate","points":[[0,0,0],[1,0,0],[0,1,0]]})
        )
        .is_err());
    }

    #[test]
    fn segment_intersection_cases() {
        let hit = |a, b, c, d| segments_intersect(a, b, c, d);
        assert!(hit([0.0, 0.0], [2.0, 2.0], [0.0, 2.0], [2.0, 0.0]));
        assert!(!hit([0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]));
        assert!(hit([0.0, 0.0], [2.0, 0.0], [1.0, 0.0], [1.0, 1.0]));
        assert!(hit([0.0, 0.0], [2.0, 0.0], [1.0, 0.0], [3.0, 0.0]));
        assert!(!hit([0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]));
        assert_eq!(plate_projection_axes([0.0, 0.0, -1.0]), [0, 1]);
        assert_eq!(plate_projection_axes([0.6, 0.6, 0.1]), [1, 2]);
        assert_eq!(plate_projection_axes([0.1, 0.6, 0.6]), [0, 2]);
    }

    #[test]
    fn hull_degeneracy_uses_one_millimetre() {
        let ok = |points: &[[f64; 3]]| hull_degeneracy(points);
        assert!(ok(&[[0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]).is_ok());
        assert!(ok(&[
            [0.0; 3],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.5, 0.5, 0.002]
        ])
        .is_ok());
        assert_eq!(
            ok(&[
                [0.0; 3],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.5, 0.5, 0.0009]
            ]),
            Err("点全部共面（容差 1 毫米）")
        );
        assert_eq!(
            ok(&[
                [0.0; 3],
                [1.0, 0.0, 0.0],
                [2.0, 0.0005, 0.0],
                [3.0, 0.0, 0.0]
            ]),
            Err("点全部共线（容差 1 毫米）")
        );
        assert_eq!(ok(&[[0.0; 3]; 4]), Err("点全部重合（容差 1 毫米）"));
        let hull = shape(
            json!({"type":"hull","points":[[0,0,0],[1,0,0],[0,2,0],[0,0,3],[0.1,0.1,0.1]],
            "transform":{"position":[1,1,1]}}),
        );
        hull.validate().unwrap();
        close(
            &hull.bounds(&NoTemplates).unwrap(),
            [1.0, 1.0, 1.0],
            [2.0, 3.0, 4.0],
        );
        let many = json!({"type":"hull","points":vec![json!([0,0,0]); MAX_HULL_POINTS + 1]});
        assert_eq!(shape(many).validate().unwrap_err().path, "$.points");
    }

    #[test]
    fn material_opacity_and_unlit() {
        let glass = json!({"type":"box","size":[1,1,0.01],
            "material":{"color":[200,220,230],"opacity":0.3,"unlit":false}});
        let parsed = shape(glass.clone());
        parsed.validate().unwrap();
        let canonical = |v: &Value| crate::canonical::canonical_json(v).unwrap();
        assert_eq!(
            canonical(&serde_json::to_value(&parsed).unwrap()),
            canonical(&glass)
        );
        for opacity in [-0.1, 1.01] {
            let bad = shape(json!({"type":"box","size":[1,1,1],
                "material":{"color":[1,1,1],"opacity":opacity}}));
            assert_eq!(bad.validate().unwrap_err().path, "$.material.opacity");
        }
        assert!(serde_json::from_value::<Shape>(
            json!({"type":"box","size":[1,1,1],"material":{"color":[1,1,1],"unlit":1}})
        )
        .is_err());
    }

    #[test]
    fn material_tiling_shading_and_maps_round_trip() {
        let hash = |c: char| c.to_string().repeat(64);
        let value = json!({"type":"box","size":[2,1,0.5],"material":{
            "texture":hash('a'),"uv":"box","tile":[0.5,0.25],"offset":[0.1,-0.2],"rotate":30,
            "shading":"albedo","normalMap":hash('b'),"normalScale":1.5,"roughnessMap":hash('c'),
            "roughness":0.9,"metalness":0}});
        let parsed = shape(value.clone());
        parsed.validate().unwrap();
        let material = parsed.material.as_ref().unwrap();
        assert_eq!(material.shading, Some(Shading::Albedo));
        assert_eq!(material.tile, Some([0.5, 0.25]));
        let canonical = |v: &Value| crate::canonical::canonical_json(v).unwrap();
        assert_eq!(
            canonical(&serde_json::to_value(&parsed).unwrap()),
            canonical(&value)
        );
        // 字段名是 camelCase，下划线写法不认。
        assert!(
            serde_json::from_value::<Shape>(json!({"type":"box","size":[1,1,1],
            "material":{"color":[1,2,3],"uv":"box","normal_map":hash('b')}}))
            .is_err()
        );
        // 都不给时与旧数据相同（不多出任何字段）。
        let old =
            json!({"type":"box","size":[1,1,1],"material":{"texture":hash('a'),"uv":"planar"}});
        assert_eq!(
            canonical(&serde_json::to_value(shape(old.clone())).unwrap()),
            canonical(&old)
        );
    }

    #[test]
    fn material_maps_and_tiling_rules() {
        let hash = |c: char| c.to_string().repeat(64);
        let box_with =
            |material: Value| shape(json!({"type":"box","size":[1,1,1],"material":material}));
        // 合法：颜色材质带粗糙度贴图（必须有 uv，可以平铺）、边界值、颜色材质只带标量。
        for material in [
            json!({"color":[1,2,3],"uv":"planar","roughnessMap":hash('c'),"tile":[1,1],"rotate":360}),
            json!({"color":[1,2,3],"uv":"box","normalMap":hash('b'),"normalScale":0}),
            json!({"texture":hash('a'),"uv":"mesh","tile":[0.001,100],"offset":[1000,-1000],"rotate":-360}),
            json!({"color":[1,2,3],"roughness":0,"metalness":1,"shading":"baked"}),
            json!({"texture":hash('a'),"uv":"box","unlit":true,"shading":"albedo","roughness":1}),
        ] {
            box_with(material.clone())
                .validate()
                .unwrap_or_else(|error| panic!("{material}: {error}"));
        }
        // 不合法：路径指向出错的字段。
        for (material, path) in [
            (
                json!({"texture":hash('a'),"uv":"box","roughnessMap":"C".repeat(64)}),
                "$.material.roughnessMap",
            ),
            (
                json!({"color":[1,2,3],"uv":"box","roughnessMap":hash('c'),"tint":[1,1,1]}),
                "$.material",
            ),
            (
                json!({"color":[1,2,3],"roughnessMap":hash('c')}),
                "$.material",
            ),
            (
                json!({"texture":hash('a'),"uv":"box","tile":[-1,1]}),
                "$.material.tile",
            ),
            (
                json!({"texture":hash('a'),"uv":"box","tile":[1,1],"rotate":-360.5}),
                "$.material.rotate",
            ),
            (
                json!({"texture":hash('a'),"uv":"box","tile":[1,1],"offset":[0,-1001]}),
                "$.material.offset",
            ),
            (
                json!({"texture":hash('a'),"uv":"box","normalMap":hash('b'),"normalScale":-0.1}),
                "$.material.normalScale",
            ),
            (
                json!({"color":[1,2,3],"metalness":1.5}),
                "$.material.metalness",
            ),
        ] {
            assert_eq!(
                box_with(material.clone()).validate().unwrap_err().path,
                path,
                "{material}"
            );
        }
        // 外链对象只有 AI 物件集收，形状里在解析阶段就拒绝；着色方式只认两个值。
        for material in [
            json!({"texture":hash('a'),"uv":"box","normalMap":{"url":"https://x.org/n.png","sha256":hash('b'),"size":1}}),
            json!({"color":[1,2,3],"shading":"unlit"}),
            json!({"texture":hash('a'),"uv":"box","tile":[1,1,1]}),
        ] {
            assert!(
                serde_json::from_value::<Shape>(
                    json!({"type":"box","size":[1,1,1],"material":material})
                )
                .is_err(),
                "{material}"
            );
        }
    }

    #[test]
    fn texture_refs_cover_every_material_field() {
        let hash = |c: char| c.to_string().repeat(64);
        let tree = shape(
            json!({"type":"group","material":{"color":[1,2,3],"uv":"box","normalMap":hash('a')},
            "children":[
                {"type":"box","size":[1,1,1],"material":{"texture":hash('b'),"uv":"box","roughnessMap":hash('c')}},
                {"type":"group","children":[
                    {"type":"instance","template":"chair","material":{"texture":hash('d'),"uv":"mesh","normalMap":hash('a')}},
                    {"type":"box","size":[1,1,1],"material":{"color":[1,2,3]}}
                ]}
            ]}),
        );
        tree.validate().unwrap();
        let expected: BTreeSet<String> = ['a', 'b', 'c', 'd'].map(hash).into_iter().collect();
        assert_eq!(tree.texture_refs(), expected);
        assert!(shape(json!({"type":"box","size":[1,1,1]}))
            .texture_refs()
            .is_empty());
    }

    #[test]
    fn node_and_depth_limits() {
        let mut nested = json!({"type":"box","size":[1,1,1]});
        for _ in 0..=MAX_SHAPE_DEPTH {
            nested = json!({"type":"group","children":[nested]});
        }
        assert!(shape(nested).validate().is_err());
        let wide = json!({"type":"group","children":vec![json!({"type":"box","size":[1,1,1]}); MAX_SHAPE_NODES]});
        assert!(shape(wide).validate().is_err());
    }
}
