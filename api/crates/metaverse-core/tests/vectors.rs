//! 跨语言测试向量（SHAPES 6）。
//!
//! - 平时运行（`cargo test`）：读取 `tests/vectors/*.json`，用 Rust 实现逐条核对，
//!   保证向量和实现没有走样；
//! - 设置 `METAVERSE_WRITE_VECTORS=1` 运行：按下面定义的用例重新生成全部向量文件。
//!
//! 向量格式见 `tests/vectors/README.md`。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use metaverse_core::canonical::{canonicalize_text, CanonicalError};
use metaverse_core::chunk::{cell_index, Chunk, CHUNK_SIZE};
use metaverse_core::record::{record_hash, RecordKind};
use metaverse_core::sha256_hex;
use metaverse_core::shape::Shape;
use serde_json::{json, Value};

/// 包围盒比较的绝对误差。
const BOUNDS_TOLERANCE: f64 = 1e-9;

fn vectors_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors")
}

// ---------------------------------------------------------------------------
// 区块
// ---------------------------------------------------------------------------

fn build_chunk(vector: &Value) -> Chunk {
    let mut chunk = Chunk::empty();
    for fill in vector["fills"].as_array().into_iter().flatten() {
        let min = coords(&fill["min"]);
        let max = coords(&fill["max"]);
        let block = fill["block"].as_u64().unwrap() as u16;
        for y in min[1]..max[1] {
            for z in min[2]..max[2] {
                for x in min[0]..max[0] {
                    chunk.set(x, y, z, block).unwrap();
                }
            }
        }
    }
    for cell in vector["cells"].as_array().into_iter().flatten() {
        let [x, y, z] = [&cell["x"], &cell["y"], &cell["z"]].map(|v| v.as_u64().unwrap() as usize);
        chunk
            .set(x, y, z, cell["block"].as_u64().unwrap() as u16)
            .unwrap();
    }
    chunk
}

fn coords(value: &Value) -> [usize; 3] {
    let items = value.as_array().unwrap();
    [0, 1, 2].map(|i| items[i].as_u64().unwrap() as usize)
}

fn chunk_vector(name: &str, description: &str, fills: Value, cells: Vec<[u64; 4]>) -> Value {
    let cells: Vec<Value> = cells
        .into_iter()
        .map(|[x, y, z, block]| {
            json!({"x": x, "y": y, "z": z, "block": block,
                "index": cell_index(x as usize, y as usize, z as usize).unwrap()})
        })
        .collect();
    let mut vector = json!({
        "kind": "chunk",
        "name": name,
        "description": description,
        "fills": fills,
        "cells": cells,
    });
    let chunk = build_chunk(&vector);
    let bytes = chunk.canonical_bytes();
    // 每个单独列出的格子都核对它在规范字节里的两个字节（小端）。
    let byte_checks: Vec<Value> = vector["cells"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|cell| {
            let offset = cell["index"].as_u64().unwrap() as usize * 2;
            [
                json!({"offset": offset, "value": bytes[offset]}),
                json!({"offset": offset + 1, "value": bytes[offset + 1]}),
            ]
        })
        .collect();
    vector["byteLength"] = json!(bytes.len());
    vector["byteChecks"] = json!(byte_checks);
    vector["nonZeroCount"] = json!(chunk.non_zero_count());
    vector["isEmpty"] = json!(chunk.is_empty());
    vector["canonicalBytesSha256"] = json!(sha256_hex(&bytes));
    vector["hash"] = json!(chunk.hash());
    vector["compressedBase64"] = json!(STANDARD.encode(chunk.compress()));
    vector
}

fn chunk_cases() -> Vec<(String, Value)> {
    let full = CHUNK_SIZE as u64;
    vec![
        (
            "chunk_empty".into(),
            chunk_vector(
                "empty",
                "全 0 区块：不进清单，但哈希仍然有定义",
                json!([]),
                vec![],
            ),
        ),
        (
            "chunk_single_origin".into(),
            chunk_vector(
                "single-origin",
                "原点一个方块，编号 2（方块表第一个编号）",
                json!([]),
                vec![[0, 0, 0, 2]],
            ),
        ),
        (
            "chunk_axis_order".into(),
            chunk_vector(
                "axis-order",
                "沿 x、z、y 各走一格：下标分别是 1、32、1024，核对 index = x + 32·(z + 32·y)",
                json!([]),
                vec![[1, 0, 0, 2], [0, 0, 1, 3], [0, 1, 0, 4]],
            ),
        ),
        (
            "chunk_byte_order".into(),
            chunk_vector(
                "byte-order",
                "小端字节序：0x0102 写成 02 01，最后一格 0xABCD 写成 CD AB",
                json!([]),
                vec![[0, 0, 0, 0x0102], [31, 31, 31, 0xABCD]],
            ),
        ),
        (
            "chunk_air_override".into(),
            chunk_vector(
                "air-override",
                "扩展层：1 表示空气覆盖（删掉下层方块），与普通方块混合",
                json!([]),
                vec![[5, 0, 5, 1], [6, 0, 5, 1], [7, 0, 5, 9], [5, 3, 7, 300]],
            ),
        ),
        (
            "chunk_floor_and_wall".into(),
            chunk_vector(
                "floor-and-wall",
                "y = 0 整层铺 2，x = 0 一面墙铺 3（后写的覆盖先写的），再单独放一格",
                json!([
                    {"min": [0, 0, 0], "max": [full, 1, full], "block": 2},
                    {"min": [0, 0, 0], "max": [1, 8, full], "block": 3}
                ]),
                vec![[16, 1, 16, 7]],
            ),
        ),
        (
            "chunk_full".into(),
            chunk_vector(
                "full",
                "整块填满 65535（u16 最大值）",
                json!([{"min": [0, 0, 0], "max": [full, full, full], "block": 65535}]),
                vec![],
            ),
        ),
    ]
}

fn check_chunk(name: &str, vector: &Value) {
    let chunk = build_chunk(vector);
    let bytes = chunk.canonical_bytes();
    assert_eq!(
        bytes.len() as u64,
        vector["byteLength"].as_u64().unwrap(),
        "{name}"
    );
    for check in vector["byteChecks"].as_array().unwrap() {
        let offset = check["offset"].as_u64().unwrap() as usize;
        assert_eq!(
            u64::from(bytes[offset]),
            check["value"].as_u64().unwrap(),
            "{name}"
        );
    }
    for cell in vector["cells"].as_array().unwrap() {
        let [x, y, z] = [&cell["x"], &cell["y"], &cell["z"]].map(|v| v.as_u64().unwrap() as usize);
        assert_eq!(
            cell_index(x, y, z).unwrap() as u64,
            cell["index"].as_u64().unwrap(),
            "{name}"
        );
    }
    assert_eq!(
        chunk.non_zero_count() as u64,
        vector["nonZeroCount"].as_u64().unwrap(),
        "{name}"
    );
    assert_eq!(
        chunk.is_empty(),
        vector["isEmpty"].as_bool().unwrap(),
        "{name}"
    );
    assert_eq!(sha256_hex(&bytes), vector["canonicalBytesSha256"], "{name}");
    assert_eq!(chunk.hash(), vector["hash"], "{name}");
    let compressed = STANDARD
        .decode(vector["compressedBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(Chunk::decompress(&compressed).unwrap(), chunk, "{name}");
}

// ---------------------------------------------------------------------------
// 规范化 JSON
// ---------------------------------------------------------------------------

fn canonical_vector(name: &str, description: &str, input: &str) -> Value {
    let mut vector = json!({
        "kind": "canonical",
        "name": name,
        "description": description,
        "input": input,
    });
    match canonicalize_text(input) {
        Ok(canonical) => {
            vector["sha256"] = json!(sha256_hex(canonical.as_bytes()));
            vector["canonical"] = json!(canonical);
        }
        Err(CanonicalError::UnsafeInteger) => vector["error"] = json!("unsafe_integer"),
        Err(other) => panic!("{name}: {other}"),
    }
    vector
}

fn record_vector(
    name: &str,
    description: &str,
    kind: RecordKind,
    space_id: &str,
    body: &str,
) -> Value {
    let mut vector = canonical_vector(name, description, body);
    let parsed: Value = serde_json::from_str(body).unwrap();
    vector["record"] = json!({
        "kind": kind,
        "spaceId": space_id,
        "hash": record_hash(kind, space_id, &parsed).unwrap(),
    });
    vector
}

fn canonical_cases() -> Vec<(String, Value)> {
    vec![
        (
            "canonical_key_order".into(),
            canonical_vector(
                "key-order",
                "嵌套对象的键按码点排序，数组保持原顺序",
                r#"{"z": 1, "a": {"y": [3, 1, 2], "b": null}, "m": true}"#,
            ),
        ),
        (
            "canonical_code_point_order".into(),
            canonical_vector(
                "code-point-order",
                "按 Unicode 码点排序而不是 UTF-16 码元：U+FF61 排在 U+1F600 前面（JavaScript 默认排序会反过来）",
                "{\"\u{1f600}\": 1, \"\u{ff61}\": 2, \"a\": 3, \"A\": 4, \"\u{e9}\": 5, \"aa\": 6, \"\": 7}",
            ),
        ),
        (
            "canonical_numbers".into(),
            canonical_vector(
                "numbers",
                "数字的最短往返表示，与 ECMAScript Number.prototype.toString 一致",
                "[1.0, -0, 0.1, 0.30000000000000004, 100, 1e2, 1e16, 1e20, 1e21, 1.5e300, 1e-6, 1e-7, -1.25e-7, 123456789012, -42, 2.5, 5e-324, 1.7976931348623157e308, 9007199254740991]",
            ),
        ),
        (
            "canonical_strings".into(),
            canonical_vector(
                "strings",
                "字符串只转义引号、反斜杠和 U+0000–U+001F；/、DEL、非 ASCII、U+2028 原样输出",
                "[\"quote \\\" backslash \\\\ slash \\/\", \"\\b\\f\\n\\r\\t\", \"\\u0000\\u0001\\u001f\\u007f\", \"\\u00e9\\u4e2d\\ud83d\\ude00\\u2028\"]",
            ),
        ),
        (
            "canonical_whitespace".into(),
            canonical_vector(
                "whitespace",
                "去掉所有格式化空白，但字符串里的空格保留",
                "{\n  \"label\" : \"前 台 \",\n  \"size\" : [ 2.4 , 1.1 , 0.6 ]\n}\n",
            ),
        ),
        (
            "canonical_literals".into(),
            canonical_vector(
                "literals",
                "空对象、空数组、空字符串和字面量",
                r#"[{}, [], "", null, true, false, {"": {}}]"#,
            ),
        ),
        (
            "canonical_unsafe_integer".into(),
            canonical_vector(
                "unsafe-integer",
                "超出 ±(2^53 − 1) 的整数必须拒绝（JavaScript 无法精确表示）",
                "{\"n\": 9007199254740992}",
            ),
        ),
        (
            "canonical_entity_record".into(),
            record_vector(
                "entity-record",
                "SHAPES 3 的物件记录示例；record.hash 是 records._id 的算法：{body, kind, spaceId} 规范化后的 sha256",
                RecordKind::Entity,
                "front-hall",
                r#"{ "entityId": "counter-01", "layer": "rebuilt", "kind": "object",
  "label": "前台", "anchorId": "counter-01",
  "shape": { "type": "box", "size": [2.4, 1.1, 0.6], "fillet": 0.02,
             "transform": { "position": [3, 0, 1.5] },
             "material": { "color": [182, 140, 96] } },
  "bounds": { "min": [1.8, 0, 1.2], "max": [4.2, 1.1, 1.8] },
  "fit": { "meanCm": 1.8, "p90Cm": 4.2, "coverage3cm": 0.81 },
  "props": { } }"#,
            ),
        ),
        (
            "canonical_entity_model_source".into(),
            record_vector(
                "entity-model-source",
                "引用外部模型的物件（SHAPES 3）：只有 assetHash，material 给整个模型调色，props.source 是署名",
                RecordKind::Entity,
                "front-hall",
                r#"{ "entityId": "sofa-01", "layer": "rebuilt", "kind": "object", "label": "沙发",
  "assetHash": "4b1e0a3f5c6d8e7b9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d9f2c7d",
  "material": { "tint": [214, 196, 176] },
  "bounds": { "min": [1.1, 0, 2.4], "max": [3.0, 0.82, 3.3] },
  "props": { "source": { "library": "polyhaven", "id": "example_sofa", "page": "https://polyhaven.com/a/example_sofa",
                         "author": "示例作者", "license": "CC0-1.0", "title": "示例沙发" } } }"#,
            ),
        ),
        (
            "canonical_anchor_record".into(),
            record_vector(
                "anchor-record",
                "锚点记录（设计 4.4）的内容哈希",
                RecordKind::Anchor,
                "front-hall",
                r#"{"anchorId": "t1", "kind": "table", "box": [10, 0, 10, 26, 15, 20], "label": "1 号桌", "visibility": "public"}"#,
            ),
        ),
    ]
}

fn check_canonical(name: &str, vector: &Value) {
    let input = vector["input"].as_str().unwrap();
    match canonicalize_text(input) {
        Ok(canonical) => {
            assert_eq!(canonical, vector["canonical"], "{name}");
            assert_eq!(sha256_hex(canonical.as_bytes()), vector["sha256"], "{name}");
        }
        Err(CanonicalError::UnsafeInteger) => {
            assert_eq!(vector["error"], "unsafe_integer", "{name}")
        }
        Err(other) => panic!("{name}: {other}"),
    }
    if let Some(record) = vector.get("record") {
        let kind: RecordKind = serde_json::from_value(record["kind"].clone()).unwrap();
        let body: Value = serde_json::from_str(input).unwrap();
        assert_eq!(
            record_hash(kind, record["spaceId"].as_str().unwrap(), &body).unwrap(),
            record["hash"],
            "{name}"
        );
    }
}

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

fn shape_vector(name: &str, description: &str, shape: Value, templates: Value) -> Value {
    let mut vector = json!({
        "kind": "shape",
        "name": name,
        "description": description,
        "shape": shape,
        "templates": templates,
    });
    let parsed: Result<Shape, _> = serde_json::from_value(vector["shape"].clone());
    let outcome = parsed
        .map_err(|error| (None, error.to_string()))
        .and_then(|shape| {
            shape
                .validate()
                .map_err(|error| (Some(error.path.clone()), error.to_string()))?;
            let templates = parse_templates(&vector["templates"]);
            shape
                .bounds(&templates)
                .map_err(|error| (Some(error.path.clone()), error.to_string()))
        });
    match outcome {
        Ok(bounds) => {
            vector["valid"] = json!(true);
            vector["bounds"] = json!({"min": bounds.min, "max": bounds.max});
            vector["tolerance"] = json!(BOUNDS_TOLERANCE);
            // 板的三角形数按规则算：顶面、底面各 n − 2，侧面每条边 2 个，共 4n − 4。
            if vector["shape"]["type"] == "plate" {
                let n = vector["shape"]["points"].as_array().unwrap().len() as u64;
                vector["triangles"] = json!(4 * n - 4);
            }
        }
        Err((path, message)) => {
            vector["valid"] = json!(false);
            vector["errorPath"] = json!(path);
            vector["errorMessage"] = json!(message);
        }
    }
    vector
}

fn parse_templates(value: &Value) -> BTreeMap<String, Shape> {
    value
        .as_object()
        .into_iter()
        .flatten()
        .map(|(id, shape)| (id.clone(), serde_json::from_value(shape.clone()).unwrap()))
        .collect()
}

fn shape_cases() -> Vec<(String, Value)> {
    let none = json!({});
    let mut cases = vec![
        (
            "shape_box",
            "box：原点在底面中心，向 +y 延伸",
            json!({"type":"box","size":[2,1,4]}),
            none.clone(),
        ),
        (
            "shape_box_fillet_ignored",
            "box 的圆角和倒角不改变包围盒",
            json!({"type":"box","size":[0.6,0.45,0.5],"fillet":0.04,"chamfer":0.01,"segments":6,"material":{"color":[90,90,96]}}),
            none.clone(),
        ),
        (
            "shape_box_yaw90_translate",
            "偏航 90°（精确的 sin/cos）后平移：x' = z，z' = −x",
            json!({"type":"box","size":[1,0.5,2],"transform":{"position":[3,0,1],"yaw":90}}),
            none.clone(),
        ),
        (
            "shape_box_yaw30",
            "非 90° 整数倍的偏航，用浮点 sin/cos",
            json!({"type":"box","size":[1,1,1],"transform":{"yaw":30}}),
            none.clone(),
        ),
        (
            "shape_box_full_transform",
            "缩放 → 翻滚 → 俯仰 → 偏航 → 平移的完整顺序",
            json!({"type":"box","size":[1,2,3],"transform":{"position":[0.5,1,-2],"yaw":30,"pitch":20,"roll":10,"scale":[1,0.5,2]}}),
            none.clone(),
        ),
        (
            "shape_box_mirror",
            "负缩放（镜像）",
            json!({"type":"box","size":[1,1,1],"transform":{"position":[0,0,5],"scale":[-1,1,2]}}),
            none.clone(),
        ),
        (
            "shape_cylinder",
            "圆柱：按解析圆，与分段数无关",
            json!({"type":"cylinder","radius":0.3,"height":0.75,"segments":12}),
            none.clone(),
        ),
        (
            "shape_cylinder_frustum",
            "圆台：半径取 max(radius, radiusTop)",
            json!({"type":"cylinder","radius":0.2,"radiusTop":0.5,"height":1,"fillet":0.01}),
            none.clone(),
        ),
        (
            "shape_cone",
            "圆锥",
            json!({"type":"cone","radius":0.15,"height":0.4,"transform":{"position":[1,0.8,1]}}),
            none.clone(),
        ),
        (
            "shape_extrude_polygon",
            "拉伸：轮廓 [x, z] 在 xz 平面，沿 +y",
            json!({"type":"extrude","height":0.75,"outline":{"points":[[0,0],[1.6,0],[1.6,0.8],[0,0.8]],"closed":true}}),
            none.clone(),
        ),
        (
            "shape_extrude_semicircle",
            "bulge = 1 的半圆向外凸，包围盒包括圆弧最低点",
            json!({"type":"extrude","height":0.1,"outline":{"points":[[-1,0],[1,0],[1,2],[-1,2]],"arcs":[{"from":0,"bulge":1}]}}),
            none.clone(),
        ),
        (
            "shape_extrude_arc_quarter",
            "小于半圆的弧：跨过坐标轴方向时才产生极值点",
            json!({"type":"extrude","height":0.5,"outline":{"points":[[0,0],[2,0],[2,1],[0,1]],"arcs":[{"from":1,"bulge":0.41421356237309503},{"from":3,"bulge":-0.3}],"fillets":[{"at":0,"radius":0.1}]},"chamfer":0.02}),
            none.clone(),
        ),
        (
            "shape_extrude_closing_arc",
            "最后一点回到第一点的边也可以是圆弧（from = n − 1）",
            json!({"type":"extrude","height":1,"outline":{"points":[[0,0],[1,0],[1,1],[0,1]],"arcs":[{"from":3,"bulge":0.5}]}}),
            none.clone(),
        ),
        (
            "shape_lathe",
            "旋转体：x、z 取最大 r，y 取轮廓范围",
            json!({"type":"lathe","profile":[[0,0],[0.35,0],[0.05,0.1],[0.05,0.7],[0.4,0.72],[0,0.74]],"segments":48}),
            none.clone(),
        ),
        (
            "shape_lathe_partial",
            "部分旋转（angle < 360）也一律按整圈算包围盒",
            json!({"type":"lathe","profile":[[0.1,0],[0.3,0.5]],"angle":90}),
            none.clone(),
        ),
        (
            "shape_sweep_circle",
            "扫掠圆截面（椅腿）：路径包围盒向各方向扩 r",
            json!({"type":"sweep","path":[[0,0,0],[0,0.4,0.02],[0.05,0.45,0.1]],"section":{"circle":0.015},"smooth":0.03,"caps":true}),
            none.clone(),
        ),
        (
            "shape_sweep_rect",
            "扫掠矩形截面：扩出 √(w²+h²)/2",
            json!({"type":"sweep","path":[[0,0,0],[1,0,0],[1,0,1]],"section":{"rect":[0.06,0.08]}}),
            none.clone(),
        ),
        (
            "shape_loft",
            "放样：各截面轮廓包围盒的并 × [第一个 y, 最后一个 y]",
            json!({"type":"loft","sections":[
            {"y":0,"outline":{"points":[[-0.3,-0.3],[0.3,-0.3],[0.3,0.3],[-0.3,0.3]]}},
            {"y":0.4,"outline":{"points":[[-0.2,-0.25],[0.25,-0.25],[0.25,0.2],[-0.2,0.2]],"arcs":[{"from":0,"bulge":0.2}]}},
            {"y":0.9,"outline":{"points":[[-0.1,-0.1],[0.1,-0.1],[0.1,0.1],[-0.1,0.1]]}}]}),
            none.clone(),
        ),
        (
            "shape_group_nested",
            "组合嵌套：子形状先用自己的变换，组合再整体变换",
            json!({"type":"group","transform":{"position":[2,0,0],"yaw":90},"children":[
            {"type":"box","size":[0.5,0.05,0.5],"transform":{"position":[0,0.45,0]}},
            {"type":"group","transform":{"roll":15},"children":[
                {"type":"cylinder","radius":0.02,"height":0.45,"transform":{"position":[0.2,0,0.2]}},
                {"type":"cylinder","radius":0.02,"height":0.45,"transform":{"position":[-0.2,0,0.2],"pitch":-5}}]}]}),
            none.clone(),
        ),
    ];
    let templates = json!({
        "chair-a": {"type":"group","children":[
            {"type":"box","size":[0.5,0.05,0.5],"transform":{"position":[0,0.45,0]}},
            {"type":"box","size":[0.5,0.45,0.05],"transform":{"position":[0,0.5,-0.225]}}]},
        "row": {"type":"group","children":[
            {"type":"instance","template":"chair-a","transform":{"position":[-0.6,0,0]}},
            {"type":"instance","template":"chair-a","transform":{"position":[0.6,0,0],"yaw":180}}]}
    });
    cases.push(("shape_instance", "模板实例：取模板（含模板自己的变换）的包围盒再变换；实例的 material 覆盖模板颜色", json!({"type":"instance","template":"chair-a","transform":{"position":[3,0,4],"yaw":45},"material":{"color":[30,60,200]}}), templates.clone()));
    cases.push((
        "shape_instance_nested",
        "模板里再引用模板",
        json!({"type":"instance","template":"row","transform":{"position":[0,0,2]}}),
        templates,
    ));
    cases.push(("shape_textured", "贴图材质：texture 是资源哈希，uv 必填", json!({"type":"box","size":[4,3,0.1],"material":{"texture":"9f2c7d4b1e0a3f5c6d8e7b9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d","uv":"planar","tint":[255,250,240]}}), none.clone()));
    cases.push((
        "shape_invalid_zero_size",
        "尺寸必须大于 0",
        json!({"type":"box","size":[1,0,1]}),
        none.clone(),
    ));
    cases.push((
        "shape_invalid_clockwise",
        "轮廓必须逆时针排列",
        json!({"type":"extrude","height":1,"outline":{"points":[[0,0],[0,1],[1,1],[1,0]]}}),
        none.clone(),
    ));
    cases.push((
        "shape_invalid_unknown_field",
        "拼错的字段（radius_top）必须拒绝",
        json!({"type":"cylinder","radius":1,"height":1,"radius_top":0.5}),
        none.clone(),
    ));
    cases.push((
        "shape_invalid_missing_template",
        "引用不存在的模板",
        json!({"type":"instance","template":"ghost"}),
        none.clone(),
    ));
    cases.push((
        "shape_invalid_loft_order",
        "放样截面的 y 必须递增",
        json!({"type":"loft","sections":[
            {"y":0.5,"outline":{"points":[[0,0],[1,0],[0,1]]}},
            {"y":0.5,"outline":{"points":[[0,0],[1,0],[0,1]]}}]}),
        none.clone(),
    ));
    cases.push((
        "shape_invalid_material",
        "材质只能二选一：color 或 texture",
        json!({"type":"box","size":[1,1,1],"material":{"color":[1,2,3],"uv":"box"}}),
        none.clone(),
    ));
    cases.extend(plate_hull_material_cases());
    // 凸包的三角形数 = 2V − 4（V 是凸包顶点数），只在点处于一般位置（没有四点共面）时有定义，
    // 由用例作者给出（已用 scipy 的 ConvexHull 核对过）。
    let hull_triangles: BTreeMap<&str, u64> = [
        ("shape_hull_tetra", 4),
        ("shape_hull_bow", 10),
        ("shape_hull_interior_point", 4),
    ]
    .into_iter()
    .collect();
    cases
        .into_iter()
        .map(|(file, description, shape, templates)| {
            let name = file.trim_start_matches("shape_").replace('_', "-");
            let mut vector = shape_vector(&name, description, shape, templates);
            if let Some(triangles) = hull_triangles.get(file) {
                assert_eq!(vector["valid"], json!(true), "{file} 应当合法");
                vector["triangles"] = json!(triangles);
            }
            (file.to_owned(), vector)
        })
        .collect()
}

/// 板、凸包和材质新字段（opacity、unlit）的用例。
fn plate_hull_material_cases() -> Vec<(&'static str, &'static str, Value, Value)> {
    let none = json!({});
    vec![
        (
            "shape_plate_slanted",
            "plate：斜放的矩形板（前台立面），沿 −法向 加厚；包围盒取各点和加厚后的点",
            json!({"type":"plate","points":[[0,0,0],[2,0,0],[2,0.9,0.3],[0,0.9,0.3]],"thickness":0.02}),
            none.clone(),
        ),
        (
            "shape_plate_concave",
            "plate：L 形台面（凹多边形），法向 +y，板向下加厚；带变换和颜色",
            json!({"type":"plate","points":[[0,0,0],[0,0,2],[2,0,2],[2,0,1.4],[0.6,0,1.4],[0.6,0,0]],"thickness":0.04,
                "transform":{"position":[1,0.75,-0.5],"yaw":30},"material":{"color":[180,150,110]}}),
            none.clone(),
        ),
        (
            "shape_plate_collinear_point",
            "plate：一条边上多一个共线点，仍是简单多边形，三角形数仍按 4n − 4",
            json!({"type":"plate","points":[[0,0,0],[0.5,0,0],[1,0,0],[1,1,0],[0,1,0]],"thickness":0.01}),
            none.clone(),
        ),
        (
            "shape_plate_within_tolerance",
            "plate：有一个点离平面 0.4 毫米（不超过 1 毫米的平面度容差）；半透明玻璃材质",
            json!({"type":"plate","points":[[0,0,0],[1.2,0,0],[1.2,2.1,0.0004],[0,2.1,0]],"thickness":0.012,
                "material":{"color":[200,225,235],"opacity":0.3}}),
            none.clone(),
        ),
        (
            "shape_plate_triangle_transformed",
            "plate：三角形板，完整变换；从法向一侧看逆时针",
            json!({"type":"plate","points":[[0,0,0],[0.4,0.1,0],[0.1,0.5,0.2]],"thickness":0.03,
                "transform":{"position":[0.5,1,-2],"yaw":30,"pitch":20,"roll":10,"scale":[1,0.5,2]}}),
            none.clone(),
        ),
        (
            "shape_invalid_plate_not_flat",
            "plate：有一个点离最佳拟合平面超过 1 毫米",
            json!({"type":"plate","points":[[0,0,0],[1,0,0],[1,1,0.01],[0,1,0]],"thickness":0.02}),
            none.clone(),
        ),
        (
            "shape_invalid_plate_self_intersecting",
            "plate：蝴蝶结形（自相交）",
            json!({"type":"plate","points":[[0,0,0],[2,0,1],[2,0,0],[0,0,2]],"thickness":0.02}),
            none.clone(),
        ),
        (
            "shape_invalid_plate_folded",
            "plate：相邻两条边折回（第 1 点）",
            json!({"type":"plate","points":[[0,0,0],[1,0,0],[0.5,0,0],[0.5,0,1]],"thickness":0.02}),
            none.clone(),
        ),
        (
            "shape_invalid_plate_collinear",
            "plate：点全部共线，没有面积",
            json!({"type":"plate","points":[[0,0,0],[1,0,0],[2,0,0]],"thickness":0.02}),
            none.clone(),
        ),
        (
            "shape_invalid_plate_thickness",
            "plate：厚度超过 1 米",
            json!({"type":"plate","points":[[0,0,0],[1,0,0],[0,1,0]],"thickness":1.5}),
            none.clone(),
        ),
        (
            "shape_invalid_plate_too_many_points",
            "plate：超过 64 个点",
            json!({"type":"plate","points":(0..65).map(|i| {
                let a = f64::from(i) * std::f64::consts::TAU / 65.0;
                json!([a.cos(), 0, -a.sin()])
            }).collect::<Vec<_>>(),"thickness":0.02}),
            none.clone(),
        ),
        (
            "shape_hull_tetra",
            "hull：四面体（4 个点都在凸包上，三角形数 4）",
            json!({"type":"hull","points":[[0,0,0],[1,0,0.1],[0.2,0.9,0.3],[0.3,0.1,1.1]]}),
            none.clone(),
        ),
        (
            "shape_hull_bow",
            "hull：船头形的 7 个点（一般位置，三角形数 2V − 4 = 10）；带变换和贴图",
            json!({"type":"hull","points":[[0,0,0],[0.82,0.03,0.11],[0.79,0.62,0.07],[0.04,0.58,-0.21],
                [0.43,0.05,0.93],[0.36,0.66,0.84],[0.4,0.3,1.42]],
                "transform":{"position":[2,0,1],"yaw":-45},
                "material":{"texture":"9f2c7d4b1e0a3f5c6d8e7b9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d","uv":"box"}}),
            none.clone(),
        ),
        (
            "shape_hull_interior_point",
            "hull：有一个点在凸包内部，不是凸包顶点（V = 4，三角形数 4）；包围盒仍取全部点",
            json!({"type":"hull","points":[[0,0,0],[1.2,0.02,0.1],[0.3,1.1,0.2],[0.25,0.15,0.95],[0.4,0.3,0.3]]}),
            none.clone(),
        ),
        (
            "shape_hull_wedge",
            "hull：楔形（三棱柱，侧面四点共面，不是一般位置，不给三角形数）",
            json!({"type":"hull","points":[[0,0,0],[1.6,0,0],[0,0.9,0],[0,0,0.6],[1.6,0,0.6],[0,0.9,0.6]],
                "transform":{"position":[0,0,3],"roll":90}}),
            none.clone(),
        ),
        (
            "shape_invalid_hull_coplanar",
            "hull：点全部共面（容差 1 毫米）",
            json!({"type":"hull","points":[[0,0,0],[1,0,0],[1,0,1],[0,0,1],[0.5,0.0005,0.5]]}),
            none.clone(),
        ),
        (
            "shape_invalid_hull_collinear",
            "hull：点全部共线",
            json!({"type":"hull","points":[[0,0,0],[1,1,1],[2,2,2],[3,3,3]]}),
            none.clone(),
        ),
        (
            "shape_invalid_hull_too_few",
            "hull：少于 4 个点",
            json!({"type":"hull","points":[[0,0,0],[1,0,0],[0,1,0]]}),
            none.clone(),
        ),
        (
            "shape_material_glass",
            "材质 opacity < 1：半透明（玻璃）",
            json!({"type":"box","size":[2,1.2,0.012],"material":{"color":[210,230,240],"opacity":0.25}}),
            none.clone(),
        ),
        (
            "shape_material_unlit_texture",
            "贴图材质也可以带 opacity 和 unlit（屏幕、灯箱）",
            json!({"type":"box","size":[3,1.7,0.05],"material":{"texture":"9f2c7d4b1e0a3f5c6d8e7b9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d","uv":"planar","unlit":true,"opacity":1}}),
            none.clone(),
        ),
        (
            "shape_invalid_material_opacity",
            "opacity 必须在 0 到 1 之间",
            json!({"type":"box","size":[1,1,1],"material":{"color":[1,2,3],"opacity":1.5}}),
            none.clone(),
        ),
        (
            "shape_invalid_material_unlit_type",
            "unlit 必须是布尔值",
            json!({"type":"box","size":[1,1,1],"material":{"color":[1,2,3],"unlit":"yes"}}),
            none,
        ),
    ]
}

fn check_shape(name: &str, vector: &Value) {
    let parsed: Result<Shape, _> = serde_json::from_value(vector["shape"].clone());
    let templates = parse_templates(&vector["templates"]);
    let outcome = parsed.ok().and_then(|shape| {
        shape.validate().ok()?;
        shape.bounds(&templates).ok()
    });
    if vector["valid"] == json!(false) {
        assert!(outcome.is_none(), "{name} 应当被拒绝");
        return;
    }
    let bounds = outcome.unwrap_or_else(|| panic!("{name} 应当合法"));
    let tolerance = vector["tolerance"].as_f64().unwrap();
    for (key, actual) in [("min", bounds.min), ("max", bounds.max)] {
        for (axis, value) in actual.iter().enumerate() {
            let expected = vector["bounds"][key][axis].as_f64().unwrap();
            assert!(
                (value - expected).abs() <= tolerance,
                "{name} {key}[{axis}]: {value} vs {expected}"
            );
        }
    }
}

// ---------------------------------------------------------------------------

fn all_cases() -> Vec<(String, Value)> {
    let mut cases = chunk_cases();
    cases.extend(canonical_cases());
    cases.extend(shape_cases());
    cases
}

#[test]
fn vectors_match_rust_implementation() {
    let dir = vectors_dir();
    if std::env::var("METAVERSE_WRITE_VECTORS").as_deref() == Ok("1") {
        fs::create_dir_all(&dir).unwrap();
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "json") {
                fs::remove_file(path).unwrap();
            }
        }
        for (file, vector) in all_cases() {
            let mut text = serde_json::to_string_pretty(&vector).unwrap();
            text.push('\n');
            fs::write(dir.join(format!("{file}.json")), text).unwrap();
        }
    }
    let mut seen = 0;
    let mut files: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    for path in files {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let vector: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        match vector["kind"].as_str().unwrap() {
            "chunk" => check_chunk(&name, &vector),
            "canonical" => check_canonical(&name, &vector),
            "shape" => check_shape(&name, &vector),
            other => panic!("{name}: 未知的向量类型 {other}"),
        }
        seen += 1;
    }
    assert_eq!(
        seen,
        all_cases().len(),
        "向量文件数与用例数不一致：请用 METAVERSE_WRITE_VECTORS=1 重新生成"
    );
}

#[test]
fn generated_vectors_are_current() {
    // 除压缩字节外，重新生成的内容必须与仓库里的文件完全一致。
    // 正在重新生成时由另一个测试负责写文件，这里跳过，避免并行读写。
    if std::env::var("METAVERSE_WRITE_VECTORS").as_deref() == Ok("1") {
        return;
    }
    for (file, mut expected) in all_cases() {
        let path = vectors_dir().join(format!("{file}.json"));
        let mut actual: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap_or_else(|_| {
                panic!("缺少 {file}.json：请用 METAVERSE_WRITE_VECTORS=1 生成")
            }))
            .unwrap();
        for value in [&mut expected, &mut actual] {
            if let Some(map) = value.as_object_mut() {
                map.remove("compressedBase64");
            }
        }
        assert_eq!(
            actual, expected,
            "{file}.json 已过期：请用 METAVERSE_WRITE_VECTORS=1 重新生成"
        );
    }
}
