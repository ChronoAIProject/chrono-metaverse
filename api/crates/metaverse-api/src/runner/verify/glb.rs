//! glb 的核对（docs/design/server-slim.md 4.5）。不解码网格、不解码图片。
//!
//! glb 的头和 JSON 块在文件开头，访问器的数据和图片在 BIN 块里的位置都能由 JSON 算出来，所以整个
//! 检查跟着哈希的流式读取一次做完：
//!
//! 1. **头**：魔数 `glTF`、版本 2、头里的总长度等于文件大小；第一个块是 JSON（不超过这个用途的
//!    上限），第二个块（可选）是 `BIN`，没有别的块；
//! 2. **JSON**：带类型的结构解析（不认识的字段跳过、不建通用 JSON 树），数组长度有上限；另走一遍
//!    只收集 `extensions` 键的扫描（同样不建树），对象级扩展也按白名单查；
//! 3. **三角形数**：从场景的根节点往下走，节点不能成环、不能有两个父节点；
//! 4. **实测包围盒**：流式读到 `POSITION` 访问器的数据时逐个元素解码，累计每个访问器的实际最小、
//!    最大值；与声明的 `min`、`max` 相差超过 max(1e-4 × |值|, 1e-6) 就拒绝；世界包围盒是各访问器
//!    盒子的 8 个角点经节点世界变换后的外包；
//! 5. **图片头**：按 JSON 算出每张图片在文件里的位置，流式读到时解析宽高，魔数必须与 `mimeType` 一致。
//!
//! 扫描用途只做轻量检查：头、JSON 的结构、没有外部引用；不算三角形和包围盒（核对记录里这两项为空），
//! 也不限扩展（扫描可能用 Draco 压缩），因而不能当网页用模型或物件模型引用。

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::marker::PhantomData;

use metaverse_core::check::{GlbCheck, GlbImage};
use metaverse_core::grid::Aabb;
use metaverse_core::limits::{
    GLB_EXTENSIONS_REQUIRED, GLB_EXTENSIONS_USED, GLB_MAX_ACCESSORS, GLB_MAX_BUFFER_VIEWS,
    GLB_MAX_IMAGES, GLB_MAX_MATERIALS, GLB_MAX_MESHES, GLB_MAX_NODES, GLB_MAX_PRIMITIVES_PER_MESH,
    GLB_MAX_SCENES, GLB_MAX_TEXTURES,
};
use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

use super::image::{ImageInfo, ImageKind, ImageProbe};
use super::Reject;

fn reject(code: &'static str, message: impl Into<String>) -> Reject {
    Reject::new(code, message)
}

// ---------------------------------------------------------------------------
// 带上限的数组和 JSON 结构
// ---------------------------------------------------------------------------

/// 最多 `N` 项的数组：超过就在解析时报错，不会先分配一大片内存。
#[derive(Debug, Clone)]
struct Limited<T, const N: usize>(Vec<T>);

impl<T, const N: usize> Default for Limited<T, N> {
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl<'de, T: Deserialize<'de>, const N: usize> Deserialize<'de> for Limited<T, N> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Items<T, const N: usize>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>, const N: usize> Visitor<'de> for Items<T, N> {
            type Value = Limited<T, N>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                write!(f, "最多 {N} 项的数组")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    if items.len() >= N {
                        return Err(de::Error::custom(format!("数组超过 {N} 项")));
                    }
                    items.push(item);
                }
                Ok(Limited(items))
            }
        }
        deserializer.deserialize_seq(Items(PhantomData))
    }
}

#[derive(Deserialize)]
struct Asset {
    version: String,
}

#[derive(Deserialize, Default)]
struct Scene {
    #[serde(default)]
    nodes: Limited<usize, GLB_MAX_NODES>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Node {
    #[serde(default)]
    children: Limited<usize, GLB_MAX_NODES>,
    mesh: Option<usize>,
    matrix: Option<[f64; 16]>,
    translation: Option<[f64; 3]>,
    rotation: Option<[f64; 4]>,
    scale: Option<[f64; 3]>,
    skin: Option<IgnoredAny>,
    camera: Option<IgnoredAny>,
}

#[derive(Deserialize)]
struct Primitive {
    #[serde(default)]
    attributes: BTreeMap<String, usize>,
    indices: Option<usize>,
    mode: Option<u32>,
    targets: Option<IgnoredAny>,
}

#[derive(Deserialize)]
struct Mesh {
    #[serde(default)]
    primitives: Limited<Primitive, GLB_MAX_PRIMITIVES_PER_MESH>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Accessor {
    buffer_view: Option<usize>,
    #[serde(default)]
    byte_offset: u64,
    component_type: u32,
    #[serde(default)]
    normalized: bool,
    count: u64,
    #[serde(rename = "type")]
    kind: String,
    min: Option<Limited<f64, 16>>,
    max: Option<Limited<f64, 16>>,
    sparse: Option<IgnoredAny>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BufferView {
    buffer: usize,
    #[serde(default)]
    byte_offset: u64,
    byte_length: u64,
    byte_stride: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Buffer {
    byte_length: u64,
    uri: Option<IgnoredAny>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Image {
    uri: Option<IgnoredAny>,
    buffer_view: Option<usize>,
    mime_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Gltf {
    asset: Asset,
    scene: Option<usize>,
    #[serde(default)]
    scenes: Limited<Scene, GLB_MAX_SCENES>,
    #[serde(default)]
    nodes: Limited<Node, GLB_MAX_NODES>,
    #[serde(default)]
    meshes: Limited<Mesh, GLB_MAX_MESHES>,
    #[serde(default)]
    accessors: Limited<Accessor, GLB_MAX_ACCESSORS>,
    #[serde(default)]
    buffer_views: Limited<BufferView, GLB_MAX_BUFFER_VIEWS>,
    #[serde(default)]
    buffers: Limited<Buffer, 16>,
    #[serde(default)]
    images: Limited<Image, GLB_MAX_IMAGES>,
    #[serde(default)]
    materials: Limited<IgnoredAny, GLB_MAX_MATERIALS>,
    /// 只为数组长度的上限（内容不看）。
    #[serde(default, rename = "textures")]
    _textures: Limited<IgnoredAny, GLB_MAX_TEXTURES>,
    // 下面几项只看有没有；元素是零大小的类型，多长都不占内存。
    #[serde(default)]
    skins: Vec<IgnoredAny>,
    #[serde(default)]
    animations: Vec<IgnoredAny>,
    #[serde(default)]
    cameras: Vec<IgnoredAny>,
    #[serde(default)]
    extensions_used: Limited<String, 64>,
    #[serde(default)]
    extensions_required: Limited<String, 64>,
}

// ---------------------------------------------------------------------------
// extensions 键的扫描（不建通用 JSON 树）
// ---------------------------------------------------------------------------

/// 走一遍整个 JSON，收集所有对象上 `extensions` 对象的键。
struct ExtensionScan<'a>(&'a mut BTreeSet<String>);

impl<'de> DeserializeSeed<'de> for ExtensionScan<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for ExtensionScan<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("JSON")
    }
    fn visit_bool<E>(self, _: bool) -> Result<(), E> {
        Ok(())
    }
    fn visit_i64<E>(self, _: i64) -> Result<(), E> {
        Ok(())
    }
    fn visit_u64<E>(self, _: u64) -> Result<(), E> {
        Ok(())
    }
    fn visit_f64<E>(self, _: f64) -> Result<(), E> {
        Ok(())
    }
    fn visit_str<E>(self, _: &str) -> Result<(), E> {
        Ok(())
    }
    fn visit_unit<E>(self) -> Result<(), E> {
        Ok(())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let found = self.0;
        while seq.next_element_seed(ExtensionScan(found))?.is_some() {}
        Ok(())
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let found = self.0;
        while let Some(key) = map.next_key::<String>()? {
            if key == "extensions" {
                map.next_value_seed(ExtensionKeys(found))?;
            } else {
                map.next_value_seed(ExtensionScan(found))?;
            }
        }
        Ok(())
    }
}

/// `extensions` 对象：记下每个键，键的值里也可能还有对象级扩展。
struct ExtensionKeys<'a>(&'a mut BTreeSet<String>);

impl<'de> DeserializeSeed<'de> for ExtensionKeys<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for ExtensionKeys<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("extensions 对象")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let found = self.0;
        while let Some(key) = map.next_key::<String>()? {
            if found.len() < 256 {
                found.insert(key);
            }
            map.next_value_seed(ExtensionScan(found))?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 计划：解析 JSON 以后算出要在 BIN 块里看哪些字节
// ---------------------------------------------------------------------------

/// 检查的深浅。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Depth {
    /// 扫描用途：头、JSON 结构、没有外部引用。
    Light,
    /// 网页用模型、物件模型：4.5 全部。
    Full,
}

/// 一个 `POSITION` 访问器在文件里的数据。
#[derive(Debug, Clone)]
struct PositionScan {
    accessor: usize,
    /// 第一个元素在文件里的偏移。
    start: u64,
    stride: u64,
    count: u64,
    component: Component,
    normalized: bool,
    declared_min: [f64; 3],
    declared_max: [f64; 3],
    /// 下一个要解码的元素。
    next: u64,
    /// 跨数据块的半个元素。
    carry: Vec<u8>,
    min: [f64; 3],
    max: [f64; 3],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Component {
    F32,
    I8,
    U8,
    I16,
    U16,
}

impl Component {
    fn from_code(code: u32) -> Option<Self> {
        match code {
            5126 => Some(Component::F32),
            5120 => Some(Component::I8),
            5121 => Some(Component::U8),
            5122 => Some(Component::I16),
            5123 => Some(Component::U16),
            _ => None,
        }
    }

    fn size(self) -> u64 {
        match self {
            Component::F32 => 4,
            Component::I8 | Component::U8 => 1,
            Component::I16 | Component::U16 => 2,
        }
    }

    /// 原始值（不归一化）。
    fn read(self, bytes: &[u8]) -> f64 {
        match self {
            Component::F32 => {
                f64::from(f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            }
            Component::I8 => f64::from(bytes[0] as i8),
            Component::U8 => f64::from(bytes[0]),
            Component::I16 => f64::from(i16::from_le_bytes([bytes[0], bytes[1]])),
            Component::U16 => f64::from(u16::from_le_bytes([bytes[0], bytes[1]])),
        }
    }

    /// 按 glTF 规范把归一化的整数还原成浮点数。
    fn normalize(self, raw: f64) -> f64 {
        match self {
            Component::F32 => raw,
            Component::I8 => (raw / 127.0).max(-1.0),
            Component::U8 => raw / 255.0,
            Component::I16 => (raw / 32767.0).max(-1.0),
            Component::U16 => raw / 65535.0,
        }
    }
}

impl PositionScan {
    fn element_size(&self) -> u64 {
        3 * self.component.size()
    }

    fn decode(&mut self, bytes: &[u8]) -> Result<(), Reject> {
        let size = self.component.size() as usize;
        for axis in 0..3 {
            let value = self.component.read(&bytes[axis * size..]);
            if !value.is_finite() {
                return Err(reject(
                    "glb_accessor",
                    format!("访问器 {} 里有不是有限数的坐标", self.accessor),
                ));
            }
            self.min[axis] = self.min[axis].min(value);
            self.max[axis] = self.max[axis].max(value);
        }
        self.next += 1;
        Ok(())
    }

    /// 喂入文件的 `[at, at + data.len())`。
    fn feed(&mut self, at: u64, data: &[u8]) -> Result<(), Reject> {
        let end = at + data.len() as u64;
        let size = self.element_size();
        while self.next < self.count {
            let element = self.start + self.next * self.stride;
            if element >= end {
                return Ok(());
            }
            let element_end = element + size;
            let from = element.max(at);
            let to = element_end.min(end);
            let slice = &data[(from - at) as usize..(to - at) as usize];
            if self.carry.is_empty() && element >= at && element_end <= end {
                self.decode(slice)?;
                continue;
            }
            self.carry.extend_from_slice(slice);
            if element_end > end {
                return Ok(());
            }
            let carried = std::mem::take(&mut self.carry);
            self.decode(&carried)?;
        }
        Ok(())
    }

    /// 读完以后：核对声明的 `min`、`max`，返回还原后的盒子（没有元素时为空）。
    fn measured(&self) -> Result<Option<Aabb>, Reject> {
        if self.count == 0 {
            return Ok(None);
        }
        if self.next != self.count {
            return Err(reject(
                "glb_accessor",
                format!("访问器 {} 的数据没有读完整", self.accessor),
            ));
        }
        for axis in 0..3 {
            for (measured, declared) in [
                (self.min[axis], self.declared_min[axis]),
                (self.max[axis], self.declared_max[axis]),
            ] {
                let tolerance = (1e-4 * declared.abs()).max(1e-6);
                if (measured - declared).abs() > tolerance {
                    return Err(reject(
                        "glb_bounds_mismatch",
                        format!(
                            "访问器 {} 声明的 min/max 与数据不符（第 {} 轴：声明 {declared}，实际 {measured}）",
                            self.accessor,
                            ["x", "y", "z"][axis]
                        ),
                    ));
                }
            }
        }
        let normalize = |raw: f64| {
            if self.normalized {
                self.component.normalize(raw)
            } else {
                raw
            }
        };
        Ok(Some(Aabb {
            min: self.min.map(normalize),
            max: self.max.map(normalize),
        }))
    }
}

/// 一张图片在文件里的位置。
#[derive(Debug, Clone)]
struct ImageScan {
    start: u64,
    end: u64,
    probe: ImageProbe,
}

/// 解析 JSON 之后的计划。
#[derive(Debug)]
struct Plan {
    nodes: u32,
    meshes: u32,
    materials: u32,
    extensions: Vec<String>,
    triangles: Option<u64>,
    /// JSON 里缓冲区的长度（不能比 BIN 块长）。
    buffer_length: Option<u64>,
    /// 按第一个元素的位置排好序。
    positions: Vec<PositionScan>,
    /// 场景里引用网格的节点：（网格，世界变换）。
    instances: Vec<(usize, [f64; 16])>,
    /// 每个网格各图元的 `POSITION` 访问器。
    mesh_positions: BTreeMap<usize, Vec<usize>>,
    images: Vec<ImageScan>,
}

// ---------------------------------------------------------------------------
// 矩阵
// ---------------------------------------------------------------------------

const IDENTITY: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

/// 列主序矩阵相乘 `a × b`。
fn multiply(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    let mut out = [0.0; 16];
    for column in 0..4 {
        for row in 0..4 {
            out[column * 4 + row] = (0..4).map(|k| a[k * 4 + row] * b[column * 4 + k]).sum();
        }
    }
    out
}

fn local_matrix(node: &Node) -> Result<[f64; 16], Reject> {
    if let Some(matrix) = node.matrix {
        if matrix.iter().any(|v| !v.is_finite()) {
            return Err(reject("glb_json", "节点矩阵里有不是有限数的值"));
        }
        return Ok(matrix);
    }
    let t = node.translation.unwrap_or([0.0; 3]);
    let [x, y, z, w] = node.rotation.unwrap_or([0.0, 0.0, 0.0, 1.0]);
    let s = node.scale.unwrap_or([1.0; 3]);
    if t.iter()
        .chain(s.iter())
        .chain([x, y, z, w].iter())
        .any(|v| !v.is_finite())
    {
        return Err(reject("glb_json", "节点变换里有不是有限数的值"));
    }
    // 旋转矩阵（四元数 x, y, z, w），列主序；再乘缩放、加平移。
    let rotation = [
        1.0 - 2.0 * (y * y + z * z),
        2.0 * (x * y + z * w),
        2.0 * (x * z - y * w),
        2.0 * (x * y - z * w),
        1.0 - 2.0 * (x * x + z * z),
        2.0 * (y * z + x * w),
        2.0 * (x * z + y * w),
        2.0 * (y * z - x * w),
        1.0 - 2.0 * (x * x + y * y),
    ];
    let mut out = IDENTITY;
    for column in 0..3 {
        for row in 0..3 {
            out[column * 4 + row] = rotation[column * 3 + row] * s[column];
        }
    }
    out[12] = t[0];
    out[13] = t[1];
    out[14] = t[2];
    Ok(out)
}

fn transform_point(m: &[f64; 16], p: [f64; 3]) -> [f64; 3] {
    let w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    let w = if w.abs() > 1e-12 { w } else { 1.0 };
    [
        (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w,
        (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w,
        (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) / w,
    ]
}

// ---------------------------------------------------------------------------
// 流式核对
// ---------------------------------------------------------------------------

/// 文件头和块头的读取进度。
#[derive(Debug)]
enum Stage {
    /// 收集头（12 字节）和 JSON 块头（8 字节）。
    Header,
    /// 收集 JSON 块。
    Json { length: u64 },
    /// JSON 之后：可选的 BIN 块头、BIN 数据。
    Body,
}

/// glb 的流式核对。
#[derive(Debug)]
pub struct GlbStream {
    depth: Depth,
    total: u64,
    json_limit: u64,
    stage: Stage,
    head: Vec<u8>,
    json: Vec<u8>,
    /// 已喂入的字节数。
    position: u64,
    /// JSON 块结束的位置（BIN 块头从这里开始）。
    json_end: u64,
    bin_start: u64,
    bin_length: u64,
    bin_header: Vec<u8>,
    plan: Option<Plan>,
}

impl GlbStream {
    pub fn new(depth: Depth, total: u64, json_limit: u64) -> Self {
        Self {
            depth,
            total,
            json_limit,
            stage: Stage::Header,
            head: Vec::with_capacity(20),
            json: Vec::new(),
            position: 0,
            json_end: 0,
            bin_start: 0,
            bin_length: 0,
            bin_header: Vec::new(),
            plan: None,
        }
    }

    pub fn feed(&mut self, data: &[u8]) -> Result<(), Reject> {
        let mut data = data;
        while !data.is_empty() {
            match self.stage {
                Stage::Header => {
                    let take = (20 - self.head.len()).min(data.len());
                    self.head.extend_from_slice(&data[..take]);
                    self.position += take as u64;
                    data = &data[take..];
                    if self.head.len() == 20 {
                        let length = self.parse_header()?;
                        self.json = Vec::with_capacity(length as usize);
                        self.stage = Stage::Json { length };
                    }
                }
                Stage::Json { length } => {
                    let take = ((length - self.json.len() as u64) as usize).min(data.len());
                    self.json.extend_from_slice(&data[..take]);
                    self.position += take as u64;
                    data = &data[take..];
                    if self.json.len() as u64 == length {
                        self.json_end = self.position;
                        let json = std::mem::take(&mut self.json);
                        self.plan = Some(self.parse_json(&json)?);
                        self.stage = Stage::Body;
                    }
                }
                Stage::Body => {
                    let at = self.position;
                    self.position += data.len() as u64;
                    self.body(at, data)?;
                    data = &[];
                }
            }
        }
        Ok(())
    }

    /// 头：魔数、版本、总长度、JSON 块头。返回 JSON 块的长度。
    fn parse_header(&self) -> Result<u64, Reject> {
        let head = &self.head;
        if &head[..4] != b"glTF" {
            return Err(reject("glb_header", "不是 glb 文件（缺少 glTF 魔数）"));
        }
        let version = u32::from_le_bytes([head[4], head[5], head[6], head[7]]);
        if version != 2 {
            return Err(reject(
                "glb_header",
                format!("只接受 glb 版本 2，这个是 {version}"),
            ));
        }
        let length = u64::from(u32::from_le_bytes([head[8], head[9], head[10], head[11]]));
        if length != self.total {
            return Err(reject(
                "glb_header",
                format!("glb 头里的总长度 {length} 与文件大小 {} 不一致", self.total),
            ));
        }
        let json_length = u64::from(u32::from_le_bytes([head[12], head[13], head[14], head[15]]));
        if &head[16..20] != b"JSON" {
            return Err(reject("glb_header", "glb 的第一个块不是 JSON"));
        }
        if json_length > self.json_limit {
            return Err(reject(
                "glb_json",
                format!(
                    "glb 的 JSON 块 {json_length} 字节，超过这个用途的上限 {}",
                    self.json_limit
                ),
            ));
        }
        if 20 + json_length > self.total {
            return Err(reject("glb_header", "glb 的 JSON 块超出了文件"));
        }
        Ok(json_length)
    }

    /// JSON 之后的字节：先是可选的 BIN 块头，再是 BIN 数据。
    fn body(&mut self, at: u64, data: &[u8]) -> Result<(), Reject> {
        let mut at = at;
        let mut data = data;
        if self.bin_start == 0 {
            let take = (8 - self.bin_header.len()).min(data.len());
            self.bin_header.extend_from_slice(&data[..take]);
            at += take as u64;
            data = &data[take..];
            if self.bin_header.len() < 8 {
                return Ok(());
            }
            let header = &self.bin_header;
            let length = u64::from(u32::from_le_bytes([
                header[0], header[1], header[2], header[3],
            ]));
            if &header[4..8] != b"BIN\0" {
                return Err(reject("glb_header", "glb 的第二个块不是 BIN"));
            }
            if self.json_end + 8 + length != self.total {
                return Err(reject(
                    "glb_header",
                    "glb 的块长度与文件大小不一致（只能有 JSON 和 BIN 两个块）",
                ));
            }
            self.bin_start = self.json_end + 8;
            self.bin_length = length;
            self.check_bin()?;
        }
        if data.is_empty() {
            return Ok(());
        }
        let plan = self.plan.as_mut().expect("JSON 之后一定有计划");
        for scan in &mut plan.positions {
            scan.feed(at, data)?;
        }
        let end = at + data.len() as u64;
        for image in &mut plan.images {
            if image.probe.is_done() || image.start >= end || image.end <= at {
                continue;
            }
            let from = image.start.max(at);
            let to = image.end.min(end);
            image
                .probe
                .feed(&data[(from - at) as usize..(to - at) as usize])?;
        }
        Ok(())
    }

    /// 解析 JSON，做结构检查，算出计划。
    fn parse_json(&mut self, json: &[u8]) -> Result<Plan, Reject> {
        let gltf: Gltf = serde_json::from_slice(json)
            .map_err(|error| reject("glb_json", format!("glb 的 JSON 不合规：{error}")))?;
        let mut extension_keys = BTreeSet::new();
        let mut deserializer = serde_json::Deserializer::from_slice(json);
        ExtensionScan(&mut extension_keys)
            .deserialize(&mut deserializer)
            .map_err(|error| reject("glb_json", format!("glb 的 JSON 不合规：{error}")))?;
        if gltf.asset.version != "2.0" {
            return Err(reject("glb_json", "glb 的 asset.version 必须是 2.0"));
        }
        // 没有外部引用：缓冲区就是 BIN 块，图片都在缓冲区里。
        if gltf.buffers.0.len() > 1 {
            return Err(reject("glb_external_ref", "glb 只能有一个缓冲区（BIN 块）"));
        }
        if gltf.buffers.0.iter().any(|buffer| buffer.uri.is_some()) {
            return Err(reject("glb_external_ref", "glb 的缓冲区不能引用外部文件"));
        }
        for image in &gltf.images.0 {
            if image.uri.is_some() || image.buffer_view.is_none() {
                return Err(reject(
                    "glb_external_ref",
                    "glb 的图片只能放在缓冲区里（不能用 uri，外部地址和 data: 都不行）",
                ));
            }
        }
        let used: Vec<String> = gltf.extensions_used.0.clone();
        if self.depth == Depth::Full {
            for name in used.iter().chain(extension_keys.iter()) {
                if !GLB_EXTENSIONS_USED.contains(&name.as_str()) {
                    return Err(reject(
                        "glb_extension",
                        format!("glb 用了不支持的扩展 {name}"),
                    ));
                }
            }
            for name in &gltf.extensions_required.0 {
                if !GLB_EXTENSIONS_REQUIRED.contains(&name.as_str()) {
                    return Err(reject(
                        "glb_extension",
                        format!("glb 要求了不支持的扩展 {name}"),
                    ));
                }
            }
            if !gltf.skins.is_empty() || gltf.nodes.0.iter().any(|node| node.skin.is_some()) {
                return Err(reject("glb_unsupported", "glb 不能带骨骼"));
            }
            if !gltf.animations.is_empty() {
                return Err(reject("glb_unsupported", "glb 不能带动画"));
            }
            if !gltf.cameras.is_empty() || gltf.nodes.0.iter().any(|node| node.camera.is_some()) {
                return Err(reject("glb_unsupported", "glb 不能带相机"));
            }
        }
        let plan = Plan {
            nodes: gltf.nodes.0.len() as u32,
            meshes: gltf.meshes.0.len() as u32,
            materials: gltf.materials.0.len() as u32,
            extensions: used,
            triangles: None,
            buffer_length: gltf.buffers.0.first().map(|buffer| buffer.byte_length),
            positions: Vec::new(),
            instances: Vec::new(),
            mesh_positions: BTreeMap::new(),
            images: Vec::new(),
        };
        let plan = self.plan_data(&gltf, plan)?;
        Ok(plan)
    }

    /// 缓冲区视图的范围、访问器、场景图、图片位置。
    fn plan_data(&self, gltf: &Gltf, mut plan: Plan) -> Result<Plan, Reject> {
        let buffer_length = gltf.buffers.0.first().map(|buffer| buffer.byte_length);
        for view in &gltf.buffer_views.0 {
            let Some(length) = buffer_length.filter(|_| view.buffer == 0) else {
                return Err(reject("glb_accessor", "缓冲区视图引用了不存在的缓冲区"));
            };
            if view
                .byte_offset
                .checked_add(view.byte_length)
                .is_none_or(|end| end > length)
            {
                return Err(reject("glb_accessor", "缓冲区视图超出了缓冲区"));
            }
            if let Some(stride) = view.byte_stride {
                if !(4..=252).contains(&stride) {
                    return Err(reject("glb_accessor", "缓冲区视图的步长不对"));
                }
            }
        }
        // 图片：位置在 BIN 块里（BIN 块的起点要等读到块头才知道，先记相对位置）。
        for image in &gltf.images.0 {
            let view = image
                .buffer_view
                .and_then(|index| gltf.buffer_views.0.get(index))
                .ok_or_else(|| reject("glb_image", "图片引用了不存在的缓冲区视图"))?;
            let kind = match image.mime_type.as_deref().and_then(ImageKind::from_mime) {
                Some(kind @ (ImageKind::Png | ImageKind::Jpeg)) => kind,
                _ => {
                    return Err(reject(
                        "glb_image",
                        "glb 里的图片 mimeType 只能是 image/png 或 image/jpeg",
                    ))
                }
            };
            if self.depth == Depth::Full {
                plan.images.push(ImageScan {
                    start: view.byte_offset,
                    end: view.byte_offset + view.byte_length,
                    probe: ImageProbe::new(Some(kind)),
                });
            }
        }
        if self.depth == Depth::Light {
            return Ok(plan);
        }
        // 场景图：每个节点至多一个父节点，不能成环（不在场景里的节点也查）。
        let nodes = &gltf.nodes.0;
        let mut parent: Vec<Option<usize>> = vec![None; nodes.len()];
        for (index, node) in nodes.iter().enumerate() {
            for &child in &node.children.0 {
                if child >= nodes.len() {
                    return Err(reject("glb_node_graph", "节点引用了不存在的子节点"));
                }
                if parent[child].is_some() {
                    return Err(reject("glb_node_graph", "glb 的节点有两个父节点"));
                }
                if child == index {
                    return Err(reject("glb_node_graph", "glb 的节点成环"));
                }
                parent[child] = Some(index);
            }
        }
        // 沿父节点往上走：0 = 没看过，1 = 正在走的这条路上，2 = 已确认能走到根。
        let mut state = vec![0u8; nodes.len()];
        for start in 0..nodes.len() {
            let mut path = Vec::new();
            let mut current = Some(start);
            while let Some(index) = current {
                match state[index] {
                    2 => break,
                    1 => return Err(reject("glb_node_graph", "glb 的节点成环")),
                    _ => {
                        state[index] = 1;
                        path.push(index);
                        current = parent[index];
                    }
                }
            }
            for index in path {
                state[index] = 2;
            }
        }
        let scene_index = gltf.scene.unwrap_or(0);
        let scene = gltf
            .scenes
            .0
            .get(scene_index)
            .ok_or_else(|| reject("glb_empty", "glb 里没有场景（scene）"))?;
        // 从根节点往下走，算世界变换；访问过的节点再遇到说明成环。
        let mut visited = vec![false; nodes.len()];
        let mut stack: Vec<(usize, [f64; 16])> = Vec::new();
        for &root in scene.nodes.0.iter().rev() {
            if root >= nodes.len() || parent[root].is_some() {
                return Err(reject("glb_node_graph", "场景的根节点不存在或有父节点"));
            }
            stack.push((root, IDENTITY));
        }
        let mut triangles = 0u64;
        while let Some((index, parent_world)) = stack.pop() {
            if std::mem::replace(&mut visited[index], true) {
                return Err(reject("glb_node_graph", "glb 的场景重复引用了同一个节点"));
            }
            let node = &nodes[index];
            let world = multiply(&parent_world, &local_matrix(node)?);
            if let Some(mesh_index) = node.mesh {
                let mesh = gltf
                    .meshes
                    .0
                    .get(mesh_index)
                    .ok_or_else(|| reject("glb_json", "节点引用了不存在的网格"))?;
                // 同一个网格被几个节点引用就算几次。
                let mut accessors = Vec::with_capacity(mesh.primitives.0.len());
                for primitive in &mesh.primitives.0 {
                    triangles += self.primitive(gltf, primitive)?;
                    accessors.push(primitive.attributes["POSITION"]);
                }
                plan.mesh_positions.entry(mesh_index).or_insert(accessors);
                plan.instances.push((mesh_index, world));
            }
            for &child in node.children.0.iter().rev() {
                stack.push((child, world));
            }
        }
        let used: BTreeSet<usize> = plan.mesh_positions.values().flatten().copied().collect();
        if used.is_empty() {
            return Err(reject("glb_empty", "glb 的场景里没有网格"));
        }
        plan.triangles = Some(triangles);
        for accessor_index in used {
            plan.positions
                .push(self.position_scan(gltf, accessor_index)?);
        }
        plan.positions.sort_by_key(|scan| scan.start);
        Ok(plan)
    }

    /// 一个图元：只收三角形、`POSITION` 的规则、三角形数。
    fn primitive(&self, gltf: &Gltf, primitive: &Primitive) -> Result<u64, Reject> {
        if primitive.mode.is_some_and(|mode| mode != 4) {
            return Err(reject(
                "glb_unsupported",
                "glb 的图元只能是三角形（mode 4）",
            ));
        }
        if primitive.targets.is_some() {
            return Err(reject("glb_unsupported", "glb 不能带变形目标"));
        }
        let position = *primitive
            .attributes
            .get("POSITION")
            .ok_or_else(|| reject("glb_accessor", "图元没有 POSITION"))?;
        let accessor = gltf
            .accessors
            .0
            .get(position)
            .ok_or_else(|| reject("glb_accessor", "POSITION 引用了不存在的访问器"))?;
        let counted = match primitive.indices {
            Some(index) => {
                let indices = gltf
                    .accessors
                    .0
                    .get(index)
                    .ok_or_else(|| reject("glb_accessor", "indices 引用了不存在的访问器"))?;
                if indices.kind != "SCALAR" || ![5121, 5123, 5125].contains(&indices.component_type)
                {
                    return Err(reject("glb_accessor", "indices 必须是无符号整数的标量"));
                }
                if indices.sparse.is_some() {
                    return Err(reject("glb_unsupported", "glb 不能用稀疏访问器"));
                }
                indices.count
            }
            None => accessor.count,
        };
        if counted % 3 != 0 {
            return Err(reject(
                "glb_triangles",
                format!("图元的顶点数或索引数 {counted} 不是 3 的倍数"),
            ));
        }
        Ok(counted / 3)
    }

    fn position_scan(&self, gltf: &Gltf, index: usize) -> Result<PositionScan, Reject> {
        let accessor = &gltf.accessors.0[index];
        if accessor.kind != "VEC3" {
            return Err(reject("glb_accessor", "POSITION 必须是 VEC3"));
        }
        if accessor.sparse.is_some() {
            return Err(reject("glb_unsupported", "glb 不能用稀疏访问器"));
        }
        let component = Component::from_code(accessor.component_type)
            .ok_or_else(|| reject("glb_accessor", "POSITION 的分量类型不对"))?;
        let quantized = component != Component::F32;
        if quantized
            && !gltf
                .extensions_used
                .0
                .iter()
                .any(|name| name == "KHR_mesh_quantization")
        {
            return Err(reject(
                "glb_accessor",
                "POSITION 不是浮点数时要声明 KHR_mesh_quantization",
            ));
        }
        if !quantized && accessor.normalized {
            return Err(reject("glb_accessor", "浮点数的 POSITION 不能 normalized"));
        }
        let bound = |value: &Option<Limited<f64, 16>>| -> Result<[f64; 3], Reject> {
            match value {
                Some(Limited(values))
                    if values.len() == 3 && values.iter().all(|v| v.is_finite()) =>
                {
                    Ok([values[0], values[1], values[2]])
                }
                _ => Err(reject(
                    "glb_accessor",
                    "POSITION 必须有 3 个有限数的 min 和 max",
                )),
            }
        };
        let declared_min = bound(&accessor.min)?;
        let declared_max = bound(&accessor.max)?;
        let view = accessor
            .buffer_view
            .and_then(|view| gltf.buffer_views.0.get(view))
            .ok_or_else(|| reject("glb_accessor", "POSITION 没有缓冲区视图"))?;
        let element = 3 * component.size();
        let stride = view.byte_stride.unwrap_or(element);
        if stride < element {
            return Err(reject("glb_accessor", "缓冲区视图的步长比元素还小"));
        }
        if accessor.count > 0 {
            let last = accessor
                .byte_offset
                .checked_add((accessor.count - 1).saturating_mul(stride))
                .and_then(|v| v.checked_add(element));
            if last.is_none_or(|end| end > view.byte_length) {
                return Err(reject("glb_accessor", "访问器的数据超出了缓冲区视图"));
            }
        }
        Ok(PositionScan {
            accessor: index,
            // 先记相对缓冲区的位置，读到 BIN 块头以后加上 BIN 的起点。
            start: view.byte_offset + accessor.byte_offset,
            stride,
            count: accessor.count,
            component,
            normalized: accessor.normalized,
            declared_min,
            declared_max,
            next: 0,
            carry: Vec::new(),
            min: [f64::INFINITY; 3],
            max: [f64::NEG_INFINITY; 3],
        })
    }

    /// 读到 BIN 块头以后：缓冲区不能比 BIN 块长；把相对位置换成文件里的位置。
    fn check_bin(&mut self) -> Result<(), Reject> {
        let bin_start = self.bin_start;
        let bin_length = self.bin_length;
        let plan = self.plan.as_mut().expect("JSON 之后一定有计划");
        if plan.buffer_length.is_some_and(|length| length > bin_length) {
            return Err(reject("glb_accessor", "glb 的缓冲区比 BIN 块长"));
        }
        let needed = plan
            .positions
            .iter()
            .map(|scan| {
                if scan.count == 0 {
                    0
                } else {
                    scan.start + (scan.count - 1) * scan.stride + scan.element_size()
                }
            })
            .chain(plan.images.iter().map(|image| image.end))
            .max()
            .unwrap_or(0);
        if needed > bin_length {
            return Err(reject("glb_accessor", "glb 的数据超出了 BIN 块"));
        }
        for scan in &mut plan.positions {
            scan.start += bin_start;
        }
        for image in &mut plan.images {
            image.start += bin_start;
            image.end += bin_start;
        }
        Ok(())
    }

    /// 读完：块结构完整；轻量检查到此为止；完整检查核对访问器、图片，算世界包围盒。
    pub fn finish(self) -> Result<GlbCheck, Reject> {
        if self.position != self.total || !matches!(self.stage, Stage::Body) {
            return Err(reject("glb_header", "glb 不完整"));
        }
        let mut plan = self.plan.expect("读完 JSON 一定有计划");
        let buffer_needed = !plan.positions.is_empty() || !plan.images.is_empty();
        if self.json_end != self.total && self.bin_start == 0 {
            return Err(reject("glb_header", "glb 的 BIN 块头不完整"));
        }
        if buffer_needed && self.bin_start == 0 {
            return Err(reject(
                "glb_accessor",
                "glb 没有 BIN 块，却引用了缓冲区里的数据",
            ));
        }
        let mut images = Vec::with_capacity(plan.images.len());
        let mut max_side = 0u32;
        let mut pixels = 0u64;
        for image in std::mem::take(&mut plan.images) {
            let ImageInfo {
                kind,
                width,
                height,
            } = image.probe.finish().map_err(|error| {
                Reject::new("glb_image", format!("glb 里的图片：{}", error.message))
            })?;
            max_side = max_side.max(width.max(height));
            pixels += u64::from(width) * u64::from(height);
            images.push(GlbImage {
                w: width,
                h: height,
                mime: kind.mime().to_owned(),
            });
        }
        let bounds = if self.depth == Depth::Full {
            let mut measured: BTreeMap<usize, Aabb> = BTreeMap::new();
            for scan in &plan.positions {
                if let Some(local) = scan.measured()? {
                    measured.insert(scan.accessor, local);
                }
            }
            let mut world: Option<Aabb> = None;
            for (mesh, matrix) in &plan.instances {
                let accessors = plan.mesh_positions.get(mesh).map_or(&[][..], Vec::as_slice);
                for local in accessors.iter().filter_map(|index| measured.get(index)) {
                    for corner in 0..8 {
                        let point = [
                            if corner & 1 == 0 {
                                local.min[0]
                            } else {
                                local.max[0]
                            },
                            if corner & 2 == 0 {
                                local.min[1]
                            } else {
                                local.max[1]
                            },
                            if corner & 4 == 0 {
                                local.min[2]
                            } else {
                                local.max[2]
                            },
                        ];
                        let p = transform_point(matrix, point);
                        if p.iter().any(|v| !v.is_finite()) {
                            return Err(reject("glb_coords", "glb 的世界坐标不是有限数"));
                        }
                        let current = world.get_or_insert(Aabb { min: p, max: p });
                        for (axis, value) in p.iter().enumerate() {
                            current.min[axis] = current.min[axis].min(*value);
                            current.max[axis] = current.max[axis].max(*value);
                        }
                    }
                }
            }
            Some(world.ok_or_else(|| reject("glb_empty", "glb 的网格没有顶点"))?)
        } else {
            None
        };
        Ok(GlbCheck {
            triangles: plan.triangles,
            nodes: plan.nodes,
            meshes: plan.meshes,
            materials: plan.materials,
            images,
            max_texture_side: max_side,
            texture_pixels: pixels,
            extensions: plan.extensions,
            bounds,
        })
    }
}
