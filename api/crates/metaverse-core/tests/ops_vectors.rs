//! 高层操作的跨语言测试向量（设计 8.3；格式见 `tests/vectors/README.md` 第 4 节）。
//!
//! 命令行（TypeScript）在本地应用操作，用于 dev / shot / diff / check；这里用 Rust 实现
//! 生成同一批用例的期望结果（区块哈希、物件和锚点记录哈希、影响范围、碰过的键），
//! TypeScript 测试读同一批文件核对。
//!
//! - 平时运行（`cargo test`）：读取 `tests/vectors/ops/*.json`，用 Rust 实现逐条核对；
//! - 设置 `METAVERSE_WRITE_VECTORS=1` 运行：按下面定义的用例重新生成这个目录下的全部文件。
//!
//! 文件放在子目录 `ops/` 里：`tests/vectors.rs` 会把 `tests/vectors/` 顶层的每个
//! `.json` 都当作区块、规范化或形状向量来核对，并在重新生成时删掉顶层的全部 `.json`。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use metaverse_core::chunk::{locate_cell, ChunkKey};
use metaverse_core::grid::GridBox;
use metaverse_core::model::{Layer, Plot, Region};
use metaverse_core::ops::{Footprint, Op, OpError, PaletteBlock, TouchedSet, WorkingState};
use metaverse_core::record::{record_hash, AnchorBody, EntityBody, RecordKind};
use metaverse_core::scope::{AllowedArea, PathScope};
use serde_json::{json, Value};

const SPACE_ID: &str = "vec-space";

fn vectors_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/ops")
}

// ---------------------------------------------------------------------------
// 基础状态
// ---------------------------------------------------------------------------

struct Base {
    state: WorkingState,
    regions: Vec<Region>,
    plots: Vec<Plot>,
}

fn build_base(base: &Value) -> Base {
    let mut state = WorkingState {
        palette: serde_json::from_value::<Vec<PaletteBlock>>(base["palette"].clone()).unwrap(),
        ..WorkingState::default()
    };
    for fill in base["fills"].as_array().into_iter().flatten() {
        let layer: Layer = serde_json::from_value(fill["layer"].clone()).unwrap();
        let region: GridBox = serde_json::from_value(fill["box"].clone()).unwrap();
        let block = fill["block"].as_u64().unwrap() as u16;
        for y in region.min[1]..region.max[1] {
            for z in region.min[2]..region.max[2] {
                for x in region.min[0]..region.max[0] {
                    let (chunk, [lx, ly, lz]) = locate_cell([x, y, z]);
                    let key = ChunkKey {
                        layer,
                        cx: chunk[0],
                        cy: chunk[1],
                        cz: chunk[2],
                    };
                    state
                        .chunks
                        .entry(key)
                        .or_default()
                        .set(lx, ly, lz, block)
                        .unwrap();
                }
            }
        }
    }
    for entity in base["entities"].as_array().into_iter().flatten() {
        let body: EntityBody = serde_json::from_value(entity.clone()).unwrap();
        state.entities.insert(body.entity_id.clone(), body);
    }
    for anchor in base["anchors"].as_array().into_iter().flatten() {
        let body: AnchorBody = serde_json::from_value(anchor.clone()).unwrap();
        state.anchors.insert(body.anchor_id.clone(), body);
    }
    Base {
        state,
        regions: serde_json::from_value(base["regions"].clone()).unwrap_or_default(),
        plots: serde_json::from_value(base["plots"].clone()).unwrap_or_default(),
    }
}

fn chunk_hashes(state: &WorkingState) -> BTreeMap<ChunkKey, String> {
    state
        .chunks
        .iter()
        .filter(|(_, chunk)| !chunk.is_empty())
        .map(|(key, chunk)| (*key, chunk.hash()))
        .collect()
}

fn key_json(key: &ChunkKey) -> Value {
    json!({"layer": key.layer, "cx": key.cx, "cy": key.cy, "cz": key.cz})
}

fn footprint_json(footprint: &Footprint) -> Value {
    json!({"cells": footprint.cells, "spaceWide": footprint.space_wide})
}

fn touched_json(touched: &TouchedSet) -> Value {
    json!({
        "chunks": touched.chunks.iter().map(key_json).collect::<Vec<_>>(),
        "entities": touched.entities,
        "anchors": touched.anchors,
        "palette": touched.palette,
    })
}

fn error_json(kind: &str, index: usize, error: &OpError) -> Value {
    let message = match error {
        OpError::Invalid { message, .. } => format!("第 {index} 条操作：{message}"),
        OpError::Scope { source, .. } => format!("第 {index} 条操作：{source}"),
        OpError::TooManyOps => error.to_string(),
    };
    json!({"kind": kind, "index": index, "message": message})
}

/// 按向量的规则逐条作用：先按当前状态算影响范围；给了范围就检查；再作用。
/// 返回 (每条的影响范围, 结果状态与碰过的键 或 错误)。
fn run(
    base: &Base,
    ops: &[Op],
    area: Option<&AllowedArea>,
) -> (Vec<Value>, Result<(WorkingState, TouchedSet), Value>) {
    let mut state = base.state.clone();
    let mut touched = TouchedSet::default();
    let mut footprints = Vec::new();
    for (index, op) in ops.iter().enumerate() {
        let footprint = match state.footprint(op) {
            Ok(footprint) => footprint,
            Err(error) => return (footprints, Err(error_json("invalid", index, &error))),
        };
        footprints.push(footprint_json(&footprint));
        if let Some(area) = area {
            if let Err(source) = area.check(&footprint) {
                let error = OpError::Scope { index, source };
                return (footprints, Err(error_json("scope", index, &error)));
            }
        }
        match state.apply(op) {
            Ok(more) => touched.merge(more),
            Err(error) => return (footprints, Err(error_json("invalid", index, &error))),
        }
    }
    (footprints, Ok((state, touched)))
}

fn probe_json(state: &WorkingState, cells: &Value) -> Vec<Value> {
    cells
        .as_array()
        .into_iter()
        .flatten()
        .map(|cell| {
            let cell: [i64; 3] = serde_json::from_value(cell.clone()).unwrap();
            json!({
                "cell": cell,
                "ext": state.block_at(Layer::Ext, cell),
                "rebuilt": state.block_at(Layer::Rebuilt, cell),
                "effective": state.effective_block(cell),
            })
        })
        .collect()
}

fn expect(vector: &Value) -> Value {
    let base = build_base(&vector["base"]);
    let ops: Vec<Op> = serde_json::from_value(vector["ops"].clone()).unwrap();
    let area = vector["scope"].as_str().map(|scope| {
        let scope: PathScope = scope.parse().unwrap();
        AllowedArea::for_scope(&scope, &base.regions, &base.plots).unwrap()
    });
    let base_hashes = chunk_hashes(&base.state);
    let (footprints, outcome) = run(&base, &ops, area.as_ref());

    // 有范围时，结果必须和接口服务实际用的 `apply_in_scope` 一致。
    if let Some(area) = &area {
        let mut scoped = base.state.clone();
        match (&outcome, scoped.apply_in_scope(&ops, area)) {
            (Ok((state, _)), Ok(_)) => assert_eq!(chunk_hashes(state), chunk_hashes(&scoped)),
            (Err(expected), Err(actual)) => {
                let index = match actual {
                    OpError::Invalid { index, .. } | OpError::Scope { index, .. } => index,
                    OpError::TooManyOps => 0,
                };
                assert_eq!(expected["index"], json!(index), "{}", vector["name"]);
                assert_eq!(scoped.chunks, base.state.chunks, "失败时状态必须不变");
            }
            (left, right) => panic!("{}: {left:?} / {right:?}", vector["name"]),
        }
    }

    let mut result = json!({
        "baseChunks": base_hashes
            .iter()
            .map(|(key, hash)| {
                let mut value = key_json(key);
                value["hash"] = json!(hash);
                value
            })
            .collect::<Vec<_>>(),
        "footprints": footprints,
    });
    match outcome {
        Err(error) => {
            result["ok"] = json!(false);
            result["error"] = error;
        }
        Ok((state, touched)) => {
            result["ok"] = json!(true);
            result["touched"] = touched_json(&touched);
            result["chunkChanges"] = json!(state.chunk_changes(&base_hashes, &touched.chunks));
            result["chunks"] = json!(state
                .chunks
                .iter()
                .filter(|(_, chunk)| !chunk.is_empty())
                .map(|(key, chunk)| {
                    let mut value = key_json(key);
                    value["hash"] = json!(chunk.hash());
                    value["nonZeroCount"] = json!(chunk.non_zero_count());
                    value
                })
                .collect::<Vec<_>>());
            result["entities"] = json!(state
                .entities
                .iter()
                .map(|(id, body)| json!({"id": id, "hash": record_hash(RecordKind::Entity, SPACE_ID, body).unwrap()}))
                .collect::<Vec<_>>());
            result["anchors"] = json!(state
                .anchors
                .iter()
                .map(|(id, body)| json!({"id": id, "hash": record_hash(RecordKind::Anchor, SPACE_ID, body).unwrap()}))
                .collect::<Vec<_>>());
            let mut provisional: Vec<_> = state
                .provisional_blocks
                .iter()
                .map(|(name, (id, _))| json!({"name": name, "id": id}))
                .collect();
            provisional.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            result["provisionalBlocks"] = json!(provisional);
            result["probes"] = json!(probe_json(&state, &vector["probeCells"]));
        }
    }
    result
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

fn palette() -> Value {
    json!([
        {"id": 2, "name": "stone", "kind": "solid", "color": [128, 128, 128], "tags": []},
        {"id": 3, "name": "oak", "kind": "solid", "color": [160, 120, 70], "tags": ["wood"]},
        {"id": 7, "name": "glass", "kind": "glass", "color": [200, 230, 255], "tags": []}
    ])
}

/// 实体区 hall：[0,0,0]–[100,60,100]；虚拟区 garden：[100,0,0]–[200,60,100]；
/// 地块 p1：[100,0,0]–[140,40,40]（2 × 2 × 1.2 米）。
fn layout() -> (Value, Value) {
    (
        json!([
            {"id": "hall", "kind": "physical", "boxes": [[0, 0, 0, 100, 60, 100]]},
            {"id": "garden", "kind": "virtual", "boxes": [[100, 0, 0, 200, 60, 100]]}
        ]),
        json!([{"id": "p1", "regionId": "garden", "boxes": [[100, 0, 0, 140, 40, 40]]}]),
    )
}

struct Case {
    file: &'static str,
    description: &'static str,
    fills: Value,
    entities: Value,
    anchors: Value,
    scope: Option<&'static str>,
    ops: Value,
    probes: Value,
}

impl Case {
    fn new(file: &'static str, description: &'static str, ops: Value) -> Self {
        Self {
            file,
            description,
            fills: json!([]),
            entities: json!([]),
            anchors: json!([]),
            scope: None,
            ops,
            probes: json!([]),
        }
    }

    fn fills(mut self, fills: Value) -> Self {
        self.fills = fills;
        self
    }

    fn entities(mut self, entities: Value) -> Self {
        self.entities = entities;
        self
    }

    fn anchors(mut self, anchors: Value) -> Self {
        self.anchors = anchors;
        self
    }

    fn scope(mut self, scope: &'static str) -> Self {
        self.scope = Some(scope);
        self
    }

    fn probes(mut self, probes: Value) -> Self {
        self.probes = probes;
        self
    }

    fn vector(self) -> (String, Value) {
        let (regions, plots) = layout();
        let name = self.file.trim_start_matches("ops_").replace('_', "-");
        let mut vector = json!({
            "kind": "ops",
            "name": name,
            "description": self.description,
            "spaceId": SPACE_ID,
            "base": {
                "palette": palette(),
                "fills": self.fills,
                "entities": self.entities,
                "anchors": self.anchors,
                "regions": regions,
                "plots": plots,
            },
            "scope": self.scope,
            "ops": self.ops,
            "probeCells": self.probes,
        });
        vector["expect"] = expect(&vector);
        (self.file.to_owned(), vector)
    }
}

fn chair_template() -> Value {
    json!({"entityId": "chair-a", "layer": "ext", "kind": "template",
        "shape": {"type": "group", "children": [
            {"type": "box", "size": [0.45, 0.04, 0.45], "transform": {"position": [0, 0.43, 0]}, "fillet": 0.01},
            {"type": "box", "size": [0.45, 0.4, 0.03], "transform": {"position": [0, 0.47, -0.21]}},
            {"type": "sweep", "path": [[-0.2, 0.015, -0.2], [-0.2, 0.43, -0.2]], "section": {"circle": 0.015}},
            {"type": "sweep", "path": [[0.2, 0.015, -0.2], [0.2, 0.43, -0.2]], "section": {"circle": 0.015}},
            {"type": "sweep", "path": [[-0.2, 0.015, 0.2], [-0.2, 0.43, 0.2]], "section": {"circle": 0.015}},
            {"type": "sweep", "path": [[0.2, 0.015, 0.2], [0.2, 0.43, 0.2]], "section": {"circle": 0.015}}
        ]},
        "bounds": {"min": [-0.225, 0, -0.225], "max": [0.225, 0.87, 0.225]}})
}

fn chair_at(id: &str, x: f64, z: f64) -> Value {
    json!({"entityId": id, "layer": "ext", "kind": "object",
        "shape": {"type": "instance", "template": "chair-a", "transform": {"position": [x, 0, z]}},
        "bounds": {"min": [x - 0.225, 0.0, z - 0.225], "max": [x + 0.225, 0.87, z + 0.225]}})
}

fn cases() -> Vec<Case> {
    vec![
        Case::new(
            "ops_fill_across_chunks",
            "填充跨两个区块（x = 31 | 32）：两个区块都碰到，都有新哈希",
            json!([{"op": "fill", "box": [30, 0, 0, 34, 1, 1], "block": 2}]),
        )
        .probes(json!([[29, 0, 0], [30, 0, 0], [31, 0, 0], [32, 0, 0], [33, 0, 0], [34, 0, 0]])),
        Case::new(
            "ops_fill_negative",
            "负坐标按向下取整定位区块：-1 落在区块 -1 的第 31 格",
            json!([{"op": "fill", "box": [-3, -2, -1, 2, 1, 1], "block": 3},
                   {"op": "fill", "box": [-33, 0, 0, -32, 1, 1], "block": 2}]),
        )
        .probes(json!([[-1, -1, -1], [-3, -2, -1], [1, 0, 0], [2, 0, 0], [-33, 0, 0], [-32, 0, 0]])),
        Case::new(
            "ops_fill_clear_deletes",
            "扩展层原有内容被写成 0（不覆盖）后整块为空：变化记为删除（hash = null）；从未有内容的区块写 0 不算变化",
            json!([{"op": "fill", "box": [0, 0, 0, 4, 4, 4], "block": 0},
                   {"op": "fill", "box": [40, 0, 0, 41, 1, 1], "block": 0}]),
        )
        .fills(json!([{"layer": "ext", "box": [0, 0, 0, 4, 4, 4], "block": 2}]))
        .probes(json!([[0, 0, 0], [40, 0, 0]])),
        Case::new(
            "ops_hollow_box",
            "空心盒：默认壁厚 1，只写外壳；壁厚 2 的 6×6×6；壁厚超过一半时整盒填满",
            json!([{"op": "hollowBox", "box": [0, 0, 0, 5, 5, 5], "block": 2},
                   {"op": "hollowBox", "box": [10, 0, 0, 16, 6, 6], "block": 3, "thickness": 2},
                   {"op": "hollowBox", "box": [20, 0, 0, 24, 4, 4], "block": 7, "thickness": 3}]),
        )
        .probes(json!([[0, 0, 0], [2, 2, 2], [4, 2, 2], [11, 2, 2], [12, 2, 2], [13, 3, 3], [21, 1, 1], [22, 2, 2]])),
        Case::new(
            "ops_replace_layers",
            "替换看的是有效方块（扩展层优先，空气覆盖算空），写到扩展层：把重建层的石头换成空气覆盖，把空格换成橡木",
            json!([{"op": "replace", "box": [0, 0, 0, 4, 1, 4], "from": 2, "to": 1},
                   {"op": "replace", "box": [0, 1, 0, 4, 2, 4], "from": 0, "to": 3},
                   {"op": "replace", "box": [0, 0, 0, 4, 2, 4], "from": 1, "to": 7}]),
        )
        .fills(json!([
            {"layer": "rebuilt", "box": [0, 0, 0, 4, 1, 4], "block": 2},
            {"layer": "rebuilt", "box": [0, 1, 0, 2, 2, 2], "block": 7},
            {"layer": "ext", "box": [3, 0, 3, 4, 1, 4], "block": 3}
        ]))
        .probes(json!([[0, 0, 0], [3, 0, 3], [0, 1, 0], [3, 1, 3]])),
        Case::new(
            "ops_copy_region_overlap",
            "复制只取扩展层（含 0），源和目标重叠时按复制前的内容",
            json!([{"op": "copyRegion", "source": [0, 0, 0, 4, 1, 1], "to": [2, 0, 0]},
                   {"op": "copyRegion", "source": [0, 0, 0, 2, 2, 2], "to": [30, 5, 30]}]),
        )
        .fills(json!([
            {"layer": "ext", "box": [0, 0, 0, 1, 1, 1], "block": 2},
            {"layer": "ext", "box": [1, 0, 0, 2, 1, 1], "block": 3},
            {"layer": "ext", "box": [3, 0, 0, 4, 1, 1], "block": 7},
            {"layer": "rebuilt", "box": [0, 1, 0, 2, 2, 2], "block": 2}
        ]))
        .probes(json!([[2, 0, 0], [3, 0, 0], [4, 0, 0], [5, 0, 0], [30, 5, 30], [31, 5, 30], [30, 6, 30], [33, 6, 31]])),
        Case::new(
            "ops_add_block_temp_names",
            "新增方块用临时名称引用，临时编号从现有最大编号 + 1 开始",
            json!([
                {"op": "addBlock", "block": {"name": "brick", "kind": "solid", "color": [180, 60, 40]}},
                {"op": "addBlock", "block": {"name": "tile", "kind": "solid",
                    "texture": {"top": "9f2c7d4b1e0a3f5c6d8e7b9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
                                "side": "9f2c7d4b1e0a3f5c6d8e7b9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
                                "bottom": "9f2c7d4b1e0a3f5c6d8e7b9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d"},
                    "tags": ["floor"]}},
                {"op": "fill", "box": [0, 0, 0, 3, 1, 3], "block": "brick"},
                {"op": "hollowBox", "box": [0, 1, 0, 3, 4, 3], "block": "tile"},
                {"op": "fill", "box": [1, 1, 1, 2, 2, 2], "block": 9}
            ]),
        )
        .probes(json!([[0, 0, 0], [0, 1, 0], [1, 2, 1], [1, 1, 1]])),
        Case::new(
            "ops_place_entities_in_plot",
            "地块路径：放模板和两把实例椅子，再放一盏带圆弧轮廓、旋转体和标签的灯；记录哈希按服务端的存法（null 可选字段去掉，props 缺省为 {}）",
            json!([
                {"op": "placeEntity", "entity": chair_template()},
                {"op": "placeEntity", "entity": chair_at("chair-1", 5.5, 0.5)},
                {"op": "placeEntity", "entity": chair_at("chair-2", 6.5, 1.25)},
                {"op": "placeEntity", "entity": {"entityId": "lamp-1", "layer": "ext", "kind": "object",
                    "label": "落地灯 🌙", "anchorId": null,
                    "shape": {"type": "group", "transform": {"position": [6, 0, 0.6], "yaw": 30}, "children": [
                        {"type": "lathe", "profile": [[0, 0], [0.18, 0], [0.18, 0.03], [0.02, 0.05], [0.02, 1.4], [0, 1.4]], "segments": 24},
                        {"type": "extrude", "height": 0.3, "transform": {"position": [0, 1.3, 0]},
                         "outline": {"points": [[-0.15, -0.15], [0.15, -0.15], [0.15, 0.15], [-0.15, 0.15]],
                                     "arcs": [{"from": 1, "bulge": 0.4}], "fillets": [{"at": 0, "radius": 0.02}]}}
                    ]},
                    "bounds": {"min": [5.7, 0, 0.3], "max": [6.4, 1.6, 0.95]},
                    "props": {"watts": 12, "note": null, "tags": ["a", "b"]}}}
            ]),
        )
        .scope("plot:p1"),
        Case::new(
            "ops_replace_entity_footprint",
            "同编号再放一次：影响范围包括旧位置和新位置；删除物件的范围是它原来的位置",
            json!([
                {"op": "placeEntity", "entity": {"entityId": "box-1", "layer": "ext", "kind": "object",
                    "shape": {"type": "box", "size": [0.5, 0.5, 0.5], "material": {"color": [10, 20, 30]}, "transform": {"position": [1, 0, 1]}},
                    "bounds": {"min": [0.75, 0, 0.75], "max": [1.25, 0.5, 1.25]}}},
                {"op": "placeEntity", "entity": {"entityId": "box-1", "layer": "ext", "kind": "object",
                    "shape": {"type": "box", "size": [0.5, 0.5, 0.5], "transform": {"position": [2.03, 0.1, 1]}},
                    "bounds": {"min": [1.78, 0.1, 0.75], "max": [2.28, 0.6, 1.25]}}},
                {"op": "removeEntity", "entityId": "old-1"}
            ]),
        )
        .entities(json!([{"entityId": "old-1", "layer": "ext", "kind": "object",
            "assetHash": "9f2c7d4b1e0a3f5c6d8e7b9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
            "bounds": {"min": [3, 0, 3], "max": [3.2, 0.5, 3.2]}}]))
        .scope("physical"),
        Case::new(
            "ops_anchors_lifecycle",
            "锚点：新建（盒子 / 点）、移动、改标签和可见级别、删除；_space 锚点的影响范围是整个空间（实体区路径允许）",
            json!([
                {"op": "createAnchor", "anchor": {"anchorId": "t1", "kind": "table", "box": [10, 0, 10, 26, 15, 20], "label": "1 号桌", "visibility": "public"}},
                {"op": "createAnchor", "anchor": {"anchorId": "door-1", "kind": "door", "position": [0.12, 0, 2.49], "visibility": "internal"}},
                {"op": "moveAnchor", "anchorId": "t1", "position": [1.5, 0.75, 1.0]},
                {"op": "updateAnchor", "anchorId": "door-1", "label": "正门", "visibility": "public"},
                {"op": "updateAnchor", "anchorId": "_space", "label": "营业中的店"},
                {"op": "removeAnchor", "anchorId": "cam-1"}
            ]),
        )
        .anchors(json!([
            {"anchorId": "_space", "kind": "space", "visibility": "public"},
            {"anchorId": "cam-1", "kind": "camera", "position": [4, 2.5, 4], "visibility": "internal"}
        ]))
        .scope("physical"),
        Case::new(
            "ops_scope_atomic",
            "地块路径下第 3 条把锚点移出地块：整批失败（kind = scope，index = 2），前两条也不生效",
            json!([
                {"op": "fill", "box": [100, 0, 0, 104, 4, 4], "block": 2},
                {"op": "createAnchor", "anchor": {"anchorId": "t9", "kind": "table", "box": [101, 0, 1, 103, 2, 3], "visibility": "public"}},
                {"op": "moveAnchor", "anchorId": "t9", "box": [139, 0, 39, 141, 2, 41]}
            ]),
        )
        .scope("plot:p1"),
        Case::new(
            "ops_scope_copy_out",
            "复制的目标落到地块外：超出范围",
            json!([{"op": "copyRegion", "source": [100, 0, 0, 104, 4, 4], "to": [138, 0, 0]}]),
        )
        .scope("plot:p1"),
        Case::new(
            "ops_scope_template_users",
            "改模板等于改所有用到它的物件：有一把椅子在地块外，改模板就超出范围",
            json!([{"op": "placeEntity", "entity": chair_template()}]),
        )
        .entities(json!([chair_template(), chair_at("chair-in", 5.5, 0.5), chair_at("chair-out", 9.0, 0.5)]))
        .scope("plot:p1"),
        Case::new(
            "ops_scope_space_wide",
            "地块路径不能改 _space 锚点（影响整个空间）",
            json!([{"op": "updateAnchor", "anchorId": "_space", "visibility": "internal"}]),
        )
        .anchors(json!([{"anchorId": "_space", "kind": "space", "visibility": "public"}]))
        .scope("plot:p1"),
        Case::new(
            "ops_scope_physical_rejects_virtual",
            "实体区路径不能改虚拟区",
            json!([{"op": "fill", "box": [98, 0, 0, 102, 1, 1], "block": 2}]),
        )
        .scope("physical"),
        Case::new(
            "ops_invalid_rebuilt_entity",
            "操作只能放扩展层的物件",
            json!([{"op": "placeEntity", "entity": {"entityId": "wall", "layer": "rebuilt", "kind": "structure",
                "shape": {"type": "box", "size": [1, 1, 1]}, "bounds": {"min": [-0.5, 0, -0.5], "max": [0.5, 1, 0.5]}}}]),
        ),
        Case::new(
            "ops_invalid_unknown_block",
            "方块表里没有的编号",
            json!([{"op": "fill", "box": [0, 0, 0, 1, 1, 1], "block": 2}, {"op": "fill", "box": [0, 0, 0, 1, 1, 1], "block": 9}]),
        ),
        Case::new(
            "ops_invalid_bounds",
            "声明的 bounds 没有包住形状（圆柱半径 0.2，bounds 只到 x = 0.1）",
            json!([{"op": "placeEntity", "entity": {"entityId": "lamp", "layer": "ext", "kind": "object",
                "shape": {"type": "cylinder", "radius": 0.2, "height": 1}, "bounds": {"min": [-0.1, 0, -0.2], "max": [0.2, 1, 0.2]}}}]),
        ),
        Case::new(
            "ops_invalid_thickness",
            "壁厚必须在 1 到 64 之间",
            json!([{"op": "hollowBox", "box": [0, 0, 0, 4, 4, 4], "block": 2, "thickness": 0}]),
        ),
        Case::new(
            "ops_invalid_template_in_use",
            "模板仍被物件使用时不能删除",
            json!([{"op": "removeEntity", "entityId": "chair-a"}]),
        )
        .entities(json!([chair_template(), chair_at("chair-1", 1.0, 1.0)])),
        Case::new(
            "ops_invalid_missing_entity",
            "删除不存在的物件：在算影响范围时就失败",
            json!([{"op": "removeEntity", "entityId": "ghost"}]),
        ),
        Case::new(
            "ops_invalid_rebuilt_overwrite",
            "同编号的重建层物件只能由任务修改",
            json!([{"op": "placeEntity", "entity": {"entityId": "wall-1", "layer": "ext", "kind": "structure",
                "shape": {"type": "box", "size": [1, 1, 1]}, "bounds": {"min": [-0.5, 0, -0.5], "max": [0.5, 1, 0.5]}}}]),
        )
        .entities(json!([{"entityId": "wall-1", "layer": "rebuilt", "kind": "structure",
            "shape": {"type": "box", "size": [4, 3, 0.1]}, "bounds": {"min": [-2, 0, -0.05], "max": [2, 3, 0.05]}}])),
        Case::new(
            "ops_invalid_anchor_update_empty",
            "修改锚点至少要给出一个字段",
            json!([{"op": "updateAnchor", "anchorId": "t1"}]),
        )
        .anchors(json!([{"anchorId": "t1", "kind": "table", "box": [0, 0, 0, 2, 2, 2], "visibility": "public"}])),
        Case::new(
            "ops_invalid_duplicate_anchor",
            "锚点编号已存在",
            json!([{"op": "createAnchor", "anchor": {"anchorId": "t1", "kind": "seat", "position": [0, 0, 0], "visibility": "public"}}]),
        )
        .anchors(json!([{"anchorId": "t1", "kind": "table", "box": [0, 0, 0, 2, 2, 2], "visibility": "public"}])),
        Case::new(
            "ops_invalid_space_anchor_move",
            "空间级锚点不能移动（给了位置，校验失败）",
            json!([{"op": "moveAnchor", "anchorId": "_space", "box": [0, 0, 0, 1, 1, 1]}]),
        )
        .anchors(json!([{"anchorId": "_space", "kind": "space", "visibility": "public"}]))
        .scope("physical"),
    ]
}

/// 结构检查：每条输入是否应当被服务端接受（`serde` 反序列化成 `Op`）。
fn parse_vector() -> (String, Value) {
    let inputs = vec![
        json!({"op": "fill", "box": [0, 0, 0, 2, 2, 2], "block": 2}),
        json!({"op": "fill", "box": [0, 0, 0, 2, 2, 2], "block": "brick"}),
        json!({"op": "fill", "box": [0, 0, 0, 2, 2, 2], "block": 65535}),
        json!({"op": "fill", "box": [0, 0, 0, 2, 2, 2], "block": 65536}),
        json!({"op": "fill", "box": [0, 0, 0, 2, 2, 2], "block": -1}),
        json!({"op": "fill", "box": [0, 0, 0, 2, 2, 2], "block": 2.5}),
        json!({"op": "fill", "box": [0, 0, 0, 0, 2, 2], "block": 2}),
        json!({"op": "fill", "box": [0, 0, 0, 2, 2], "block": 2}),
        json!({"op": "fill", "box": [0, 0, 0, 1073741825, 2, 2], "block": 2}),
        json!({"op": "fill", "box": [0, 0, 0, 2, 2, 2], "block": 2, "extra": 1}),
        json!({"op": "fill", "box": [0, 0, 0, 2, 2, 2]}),
        json!({"op": "explode"}),
        json!({"box": [0, 0, 0, 2, 2, 2], "block": 2}),
        json!({"op": "hollowBox", "box": [0, 0, 0, 4, 4, 4], "block": 2, "thickness": 2}),
        json!({"op": "hollowBox", "box": [0, 0, 0, 4, 4, 4], "block": 2, "thickness": null}),
        json!({"op": "hollowBox", "box": [0, 0, 0, 4, 4, 4], "block": 2, "thickness": -1}),
        json!({"op": "replace", "box": [0, 0, 0, 4, 4, 4], "from": 2, "to": "brick"}),
        json!({"op": "copyRegion", "source": [0, 0, 0, 4, 4, 4], "to": [1, 2, 3]}),
        json!({"op": "copyRegion", "source": [0, 0, 0, 4, 4, 4], "to": [1.5, 2, 3]}),
        json!({"op": "copy_region", "source": [0, 0, 0, 4, 4, 4], "to": [1, 2, 3]}),
        json!({"op": "addBlock", "block": {"name": "brick", "kind": "solid", "color": [1, 2, 3]}}),
        json!({"op": "addBlock", "block": {"name": "brick", "kind": "metal", "color": [1, 2, 3]}}),
        json!({"op": "addBlock", "block": {"name": "brick", "kind": "solid", "color": [1, 2, 300]}}),
        json!({"op": "addBlock", "block": {"name": "brick", "kind": "solid", "colour": [1, 2, 3]}}),
        json!({"op": "removeEntity", "entityId": "x"}),
        json!({"op": "removeEntity", "entity_id": "x"}),
        json!({"op": "placeEntity", "entity": {"entityId": "a", "layer": "ext", "kind": "object",
            "shape": {"type": "box", "size": [1, 1, 1]}, "bounds": {"min": [0, 0, 0], "max": [1, 1, 1]}}}),
        json!({"op": "placeEntity", "entity": {"entityId": "a", "layer": "ext", "kind": "object",
            "shape": {"type": "box", "size": [1, 1, 1]}, "bounds": {"min": [0, 0, 0], "max": [1, 1, 1]}, "color": [1, 2, 3]}}),
        json!({"op": "placeEntity", "entity": {"entityId": "a", "layer": "ext", "kind": "object",
            "shape": {"type": "box", "size": [1, 1, 1], "colour": [1, 2, 3]}, "bounds": {"min": [0, 0, 0], "max": [1, 1, 1]}}}),
        json!({"op": "placeEntity", "entity": {"entityId": "a", "layer": "ext", "kind": "object",
            "shape": {"type": "box", "size": [1, 1, 1]}}}),
        json!({"op": "placeEntity", "entity": {"entityId": "a", "layer": "ext", "kind": "furniture",
            "shape": {"type": "box", "size": [1, 1, 1]}, "bounds": {"min": [0, 0, 0], "max": [1, 1, 1]}}}),
        json!({"op": "createAnchor", "anchor": {"anchorId": "t1", "kind": "table", "box": [0, 0, 0, 1, 1, 1], "visibility": "public"}}),
        json!({"op": "createAnchor", "anchor": {"anchorId": "t1", "kind": "bar", "box": [0, 0, 0, 1, 1, 1], "visibility": "public"}}),
        json!({"op": "createAnchor", "anchor": {"anchorId": "t1", "kind": "table", "box": [0, 0, 0, 1, 1, 1]}}),
        json!({"op": "moveAnchor", "anchorId": "t1", "position": [1, 0, 1]}),
        json!({"op": "moveAnchor", "anchorId": "t1", "box": [0, 0, 0, 1, 1, 1], "position": null}),
        json!({"op": "moveAnchor", "anchorId": "t1", "position": [1, 0]}),
        json!({"op": "updateAnchor", "anchorId": "t1", "visibility": "secret"}),
        json!({"op": "updateAnchor", "anchorId": "t1", "label": "1 号桌", "kind": "counter"}),
        json!({"op": "removeAnchor", "anchorId": "t1"}),
        json!({"op": "removeAnchor"}),
    ];
    let cases: Vec<Value> = inputs
        .into_iter()
        .map(|input| {
            let valid = serde_json::from_value::<Op>(input.clone()).is_ok();
            json!({"input": input, "valid": valid})
        })
        .collect();
    (
        "ops_parse".into(),
        json!({
            "kind": "ops-parse",
            "name": "parse",
            "description": "结构检查：字段名、类型、未知字段、方块编号范围、盒子是否合法。valid = false 的输入必须在解析阶段被拒绝",
            "cases": cases,
        }),
    )
}

fn all_vectors() -> Vec<(String, Value)> {
    let mut vectors: Vec<_> = cases().into_iter().map(Case::vector).collect();
    vectors.push(parse_vector());
    vectors
}

fn check_parse(name: &str, vector: &Value) {
    for case in vector["cases"].as_array().unwrap() {
        let valid = serde_json::from_value::<Op>(case["input"].clone()).is_ok();
        assert_eq!(json!(valid), case["valid"], "{name}: {}", case["input"]);
    }
}

#[test]
fn ops_vectors_match_rust_implementation() {
    let dir = vectors_dir();
    let writing = std::env::var("METAVERSE_WRITE_VECTORS").as_deref() == Ok("1");
    let generated = all_vectors();
    if writing {
        fs::create_dir_all(&dir).unwrap();
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "json") {
                fs::remove_file(path).unwrap();
            }
        }
        for (file, vector) in &generated {
            let mut text = serde_json::to_string_pretty(vector).unwrap();
            text.push('\n');
            fs::write(dir.join(format!("{file}.json")), text).unwrap();
        }
    }
    let mut files: Vec<_> = fs::read_dir(&dir)
        .unwrap_or_else(|_| {
            panic!(
                "缺少 {}：请用 METAVERSE_WRITE_VECTORS=1 生成",
                dir.display()
            )
        })
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    assert_eq!(
        files.len(),
        generated.len(),
        "向量文件数与用例数不一致：请用 METAVERSE_WRITE_VECTORS=1 重新生成"
    );
    let expected: BTreeMap<_, _> = generated.into_iter().collect();
    for path in files {
        let file = path.file_stem().unwrap().to_string_lossy().into_owned();
        let actual: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        match actual["kind"].as_str().unwrap() {
            "ops" => assert_eq!(
                actual["expect"],
                expect(&actual),
                "{file}.json 与 Rust 实现不一致"
            ),
            "ops-parse" => check_parse(&file, &actual),
            other => panic!("{file}: 未知的向量类型 {other}"),
        }
        assert_eq!(
            Some(&actual),
            expected.get(&file),
            "{file}.json 已过期：请用 METAVERSE_WRITE_VECTORS=1 重新生成"
        );
    }
}
