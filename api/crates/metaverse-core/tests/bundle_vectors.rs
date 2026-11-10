//! 重建包清单的跨语言测试向量（docs/SHAPES.md 第 7 节；格式见 `tests/vectors/README.md` 第 8 节）。
//!
//! Rust 实现生成每个清单的期望：合法还是不合法（不合法时出错的字段）、引用到的资源、展开成的操作，
//! 部分向量还给出在一个基础状态上作用一次、两次的结果（"合并包推两次"第二次没有变化）。
//! 命令行（TypeScript）只跑结构校验（合法、不合法和出错的字段），不展开。
//!
//! - 平时运行（`cargo test`）：读取 `tests/vectors/bundle/*.json`，用 Rust 实现逐条核对；
//! - 设置 `METAVERSE_WRITE_VECTORS=1` 运行：按下面定义的用例重新生成这个目录下的全部文件。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use metaverse_core::bundle::{Bundle, SpaceTemplates};
use metaverse_core::limits::UploadLimits;
use metaverse_core::model::{Plot, Region};
use metaverse_core::ops::{ScopeKind, TouchedSet, WorkingState};
use metaverse_core::record::{record_hash, AnchorBody, EntityBody, RecordKind};
use metaverse_core::scope::{AllowedArea, PathScope};
use metaverse_core::shape::Shape;
use serde_json::{json, Value};

const SPACE_ID: &str = "vec-space";

fn vectors_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/bundle")
}

fn hex(c: char) -> String {
    c.to_string().repeat(64)
}

// ---------------------------------------------------------------------------
// 期望
// ---------------------------------------------------------------------------

fn limits_of(vector: &Value) -> UploadLimits {
    match &vector["limits"] {
        Value::Null => UploadLimits::default(),
        value => serde_json::from_value(value.clone()).unwrap(),
    }
}

fn space_templates_of(vector: &Value) -> Option<BTreeMap<String, Shape>> {
    match &vector["spaceTemplates"] {
        Value::Null => None,
        value => Some(serde_json::from_value(value.clone()).unwrap()),
    }
}

fn record_list<T: serde::Serialize>(kind: RecordKind, map: &BTreeMap<String, T>) -> Vec<Value> {
    map.iter()
        .map(|(id, body)| json!({"id": id, "hash": record_hash(kind, SPACE_ID, body).unwrap()}))
        .collect()
}

fn touched_json(touched: &TouchedSet) -> Value {
    json!({
        "entities": touched.entities,
        "anchors": touched.anchors,
        "scan": touched.scan,
        "rebuiltLayer": touched.rebuilt_layer,
        "skippedAnchors": touched
            .skipped_anchors
            .iter()
            .map(|(id, reason)| json!({"id": id, "reason": reason}))
            .collect::<Vec<_>>(),
    })
}

/// 在基础状态上按重建范围作用展开的操作，连续 `runs` 次（每次以上一次的结果为基础，
/// 锚点历史加上已经出现过的锚点）。
fn apply_runs(apply: &Value, ops: &[metaverse_core::ops::Op]) -> Value {
    let base = &apply["base"];
    let regions: Vec<Region> = serde_json::from_value(base["regions"].clone()).unwrap_or_default();
    let plots: Vec<Plot> = serde_json::from_value(base["plots"].clone()).unwrap_or_default();
    let area = AllowedArea::for_scope(&PathScope::Rebuild, &regions, &plots).unwrap();
    let mut state = WorkingState::with_kind(ScopeKind::Rebuild);
    for entity in base["entities"].as_array().into_iter().flatten() {
        let body: EntityBody = serde_json::from_value(entity.clone()).unwrap();
        state.entities.insert(body.entity_id.clone(), body);
    }
    for anchor in base["anchors"].as_array().into_iter().flatten() {
        let body: AnchorBody = serde_json::from_value(anchor.clone()).unwrap();
        state.anchors.insert(body.anchor_id.clone(), body);
    }
    let mut history: BTreeSet<String> =
        serde_json::from_value(base["anchorHistory"].clone()).unwrap_or_default();
    let mut runs = Vec::new();
    for _ in 0..apply["runs"].as_u64().unwrap() {
        history.extend(state.anchors.keys().cloned());
        let before_entities = record_list(RecordKind::Entity, &state.entities);
        let before_anchors = record_list(RecordKind::Anchor, &state.anchors);
        // 每次都是新的重建草稿：没有 setScan。
        state.scan = None;
        state.anchor_history = history.clone();
        let mut touched = TouchedSet::default();
        for (index, op) in ops.iter().enumerate() {
            let footprint = state
                .footprint(op)
                .unwrap_or_else(|e| panic!("{index}: {e}"));
            area.check(&footprint)
                .unwrap_or_else(|e| panic!("{index}: {e}"));
            touched.merge(state.apply(op).unwrap_or_else(|e| panic!("{index}: {e}")));
        }
        let entities = record_list(RecordKind::Entity, &state.entities);
        let anchors = record_list(RecordKind::Anchor, &state.anchors);
        runs.push(json!({
            "touched": touched_json(&touched),
            "entities": entities,
            "anchors": anchors,
            "brokenTemplateRefs": state.broken_template_refs().into_iter()
                .map(|(entity, template)| json!({"entityId": entity, "template": template}))
                .collect::<Vec<_>>(),
            "unchanged": entities == before_entities && anchors == before_anchors,
        }));
    }
    json!(runs)
}

fn expect(vector: &Value) -> Value {
    let text = serde_json::to_string(&vector["manifest"]).unwrap();
    let limits = limits_of(vector);
    let templates = space_templates_of(vector);
    let parsed = Bundle::parse(
        &text,
        &limits,
        templates.as_ref().map(|t| SpaceTemplates(t)),
    );
    match parsed {
        Err(error) => json!({"valid": false, "field": error.field, "message": error.message}),
        Ok(bundle) => {
            let ops = bundle.to_ops().unwrap();
            let mut result = json!({
                "valid": true,
                "references": bundle.references,
                "ops": ops,
            });
            if !vector["apply"].is_null() {
                result["runs"] = apply_runs(&vector["apply"], &ops);
            }
            result
        }
    }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/// 一份完整的清单：扫描、整体替换（一个模板、一个实例、一个外部模型物件、一面带贴图的墙）、锚点、
/// 建模记录、报告。
fn full() -> Value {
    json!({
        "format": "chrono-metaverse-rebuild-bundle",
        "version": 1,
        "tool": {"name": "metaverse-recon", "version": "0.2.0",
                 "source": "git:0123456789abcdef0123456789abcdef01234567"},
        "note": "前厅第 4 版：AI 物件集，结构按实测替换",
        "createdAt": "2026-11-20T08:00:00.000Z",
        "base": {"spaceId": "chronoai-lobby", "seq": 4},
        "scan": {
            "assetHash": hex('1'),
            "webModelHashes": [hex('2')],
            "transform": [0.5, 0, -0.8660254037844386, 0, 0, 1, 0, 0, 0.8660254037844386, 0, 0.5, 0, 3.25, -0.01, 7.5, 1],
            "observedAt": "2026-10-20T00:00:00.000Z",
            "alignment": {"method": "given", "rotationDeg": -60, "tiltDeg": 0.09}
        },
        "rebuilt": {
            "mode": "replace",
            "templates": [{"entityId": "rb.chair-a", "layer": "rebuilt", "kind": "template",
                "shape": {"type": "group", "children": [
                    {"type": "box", "size": [0.45, 0.04, 0.45], "transform": {"position": [0, 0.43, 0]},
                     "material": {"texture": hex('3'), "uv": "box", "tile": [0.5, 0.5]}},
                    {"type": "box", "size": [0.45, 0.4, 0.03], "transform": {"position": [0, 0.47, -0.21]},
                     "material": {"color": [90, 70, 50], "normalMap": hex('6'), "uv": "box"}}]},
                "bounds": {"min": [-0.225, 0.41, -0.225], "max": [0.225, 0.87, 0.225]}}],
            "entities": [
                {"entityId": "rb.chair-01", "layer": "rebuilt", "kind": "object", "anchorId": "seat-1",
                 "shape": {"type": "instance", "template": "rb.chair-a", "transform": {"position": [1, 0, 1], "yaw": 90}},
                 "bounds": {"min": [0.775, 0.41, 0.775], "max": [1.225, 0.87, 1.225]},
                 "fit": {"meanCm": 1.8, "p90Cm": 4.2, "coverage3cm": 0.81}},
                {"entityId": "rb.sofa-01", "layer": "rebuilt", "kind": "object", "label": "沙发",
                 "assetHash": hex('4'), "material": {"tint": [214, 196, 176], "shading": "albedo"},
                 "bounds": {"min": [2, 0, 2], "max": [3.9, 0.82, 2.9]},
                 "props": {"source": {"library": "polyhaven", "id": "sofa_02",
                     "page": "https://polyhaven.com/a/sofa_02", "author": "某作者",
                     "license": "CC0-1.0", "title": "布艺沙发"}}},
                {"entityId": "rb.wall-01", "layer": "rebuilt", "kind": "structure",
                 "shape": {"type": "box", "size": [4, 3, 0.1], "transform": {"position": [2, 0, 4.9]},
                           "material": {"texture": hex('3'), "uv": "planar", "tile": [1, 1]}},
                 "bounds": {"min": [0, 0, 4.85], "max": [4, 3, 4.95]}}
            ],
            "remove": []
        },
        "anchors": [
            {"anchorId": "seat-1", "kind": "seat", "position": [1, 0, 1], "label": "座位", "visibility": "public"},
            {"anchorId": "sofa-01", "kind": "zone", "box": [40, 0, 40, 78, 17, 58], "visibility": "internal"}
        ],
        "notes": hex('5'),
        "report": {"fit": {"meanCm": 4.31, "p90Cm": 8.71, "within3cm": 0.67}, "entities": 3},
        "files": [
            {"path": "scan/scan.zip", "purpose": "scan", "sha256": hex('1'), "size": 5_901_234},
            {"path": "web/scan-0.glb", "purpose": "webmodel", "sha256": hex('2'), "size": 13_800_000},
            {"path": "textures/333333333333.jpg", "purpose": "texture", "sha256": hex('3'), "size": 51_234},
            {"path": "textures/666666666666.png", "purpose": "texture", "sha256": hex('6'), "size": 81_920},
            {"path": "models/444444444444.glb", "purpose": "model", "sha256": hex('4'), "size": 412_345},
            {"path": "notes.md", "purpose": "script", "sha256": hex('5'), "size": 9_876}
        ]
    })
}

/// 最小的清单：只有一个锚点（不合法的用例都从它改一处）。
fn minimal() -> Value {
    json!({
        "format": "chrono-metaverse-rebuild-bundle",
        "version": 1,
        "tool": {"name": "metaverse-recon", "version": "0.2.0"},
        "note": "只加锚点",
        "createdAt": "2026-11-20T16:00:00+08:00",
        "anchors": [{"anchorId": "counter-01", "kind": "counter", "box": [100, 0, 100, 140, 25, 180], "visibility": "public"}],
        "files": []
    })
}

/// 处理服务写的旧重建层（旧编号、旧模板和实例）、一个扩展层的灯、两个锚点。
fn legacy_base() -> Value {
    json!({
        "regions": [{"id": "hall", "kind": "physical", "boxes": [[0, 0, 0, 200, 80, 200]]}],
        "plots": [],
        "entities": [
            {"entityId": "wall-01", "layer": "rebuilt", "kind": "structure",
             "shape": {"type": "box", "size": [4, 3, 0.1], "transform": {"position": [2, 0, 0.05]}},
             "bounds": {"min": [0, 0, 0], "max": [4, 3, 0.1]}},
            {"entityId": "chair-a", "layer": "rebuilt", "kind": "template",
             "shape": {"type": "box", "size": [0.4, 0.8, 0.4]}, "bounds": {"min": [-0.2, 0, -0.2], "max": [0.2, 0.8, 0.2]}},
            {"entityId": "chair-01", "layer": "rebuilt", "kind": "object",
             "shape": {"type": "instance", "template": "chair-a", "transform": {"position": [2, 0, 2]}},
             "bounds": {"min": [1.8, 0, 1.8], "max": [2.2, 0.8, 2.2]}},
            {"entityId": "lamp", "layer": "ext", "kind": "object",
             "shape": {"type": "cylinder", "radius": 0.2, "height": 1.5, "transform": {"position": [3, 0, 3]}},
             "bounds": {"min": [2.8, 0, 2.8], "max": [3.2, 1.5, 3.2]}}
        ],
        "anchors": [
            {"anchorId": "_space", "kind": "space", "visibility": "public"},
            {"anchorId": "counter-01", "kind": "counter", "box": [100, 0, 100, 140, 25, 180], "visibility": "public"}
        ],
        "anchorHistory": ["sofa-01", "counter-01"]
    })
}

struct Case {
    file: &'static str,
    description: &'static str,
    manifest: Value,
    limits: Option<Value>,
    space_templates: Option<Value>,
    apply: Option<Value>,
}

impl Case {
    fn new(file: &'static str, description: &'static str, manifest: Value) -> Self {
        Self {
            file,
            description,
            manifest,
            limits: None,
            space_templates: None,
            apply: None,
        }
    }

    /// 从最小的清单改一处。
    fn changed(file: &'static str, description: &'static str, change: impl Fn(&mut Value)) -> Self {
        let mut manifest = minimal();
        change(&mut manifest);
        Self::new(file, description, manifest)
    }

    /// 从完整的清单改一处。
    fn changed_full(
        file: &'static str,
        description: &'static str,
        change: impl Fn(&mut Value),
    ) -> Self {
        let mut manifest = full();
        change(&mut manifest);
        Self::new(file, description, manifest)
    }

    fn limits(mut self, limits: Value) -> Self {
        self.limits = Some(limits);
        self
    }

    fn space_templates(mut self, templates: Value) -> Self {
        self.space_templates = Some(templates);
        self
    }

    fn apply(mut self, base: Value, runs: u64) -> Self {
        self.apply = Some(json!({"base": base, "runs": runs}));
        self
    }

    fn vector(self) -> (String, Value) {
        let name = self.file.trim_start_matches("bundle_").replace('_', "-");
        let mut vector = json!({
            "kind": "bundle",
            "name": name,
            "description": self.description,
            "manifest": self.manifest,
            "limits": self.limits,
            "spaceTemplates": self.space_templates,
            "apply": self.apply,
        });
        vector["expect"] = expect(&vector);
        (self.file.to_owned(), vector)
    }
}

fn remove_key(value: &mut Value, key: &str) {
    value.as_object_mut().unwrap().remove(key);
}

fn cases() -> Vec<Case> {
    vec![
        Case::new(
            "bundle_valid_full_replace",
            "完整的清单：扫描、整体替换重建层（模板、实例、外部模型物件、带贴图的墙）、锚点、建模记录、报告。展开成 setScan、clearRebuilt、按清单顺序放模板和物件、带 ifNew 的锚点；在处理服务写的旧重建层上推两次，第二次没有变化",
            full(),
        )
        .apply(legacy_base(), 2),
        Case::changed_full(
            "bundle_valid_merge_twice",
            "合并包：只放、改列出的物件，再删 remove 里的编号（旧编号 wall-01 和不存在的 rb.ghost，都带 ifPresent）；推两次，第二次删不存在的编号什么都不做、锚点按 ifNew 跳过，没有变化",
            |m| {
                remove_key(m, "scan");
                m["rebuilt"]["mode"] = json!("merge");
                m["rebuilt"]["remove"] = json!(["wall-01", "rb.ghost"]);
                m["anchors"] = json!([{"anchorId": "seat-1", "kind": "seat", "position": [1, 0, 1], "visibility": "public"}]);
            },
        )
        .apply(legacy_base(), 2),
        Case::changed(
            "bundle_valid_anchors_only",
            "只有锚点：已有的 counter-01 跳过（exists），曾经有过的 sofa-01 跳过（existed），新的 door-1 新建；时区偏移写法的 createdAt 也收",
            |m| {
                m["anchors"] = json!([
                    {"anchorId": "counter-01", "kind": "counter", "box": [0, 0, 0, 10, 25, 10], "visibility": "public"},
                    {"anchorId": "sofa-01", "kind": "zone", "box": [40, 0, 40, 78, 17, 58], "visibility": "public"},
                    {"anchorId": "door-1", "kind": "door", "position": [0.5, 0, 9.5], "visibility": "internal"}
                ]);
            },
        )
        .apply(legacy_base(), 1),
        Case::changed(
            "bundle_valid_scan_only",
            "只有扫描：两档网页用模型，不带拍摄时间和对齐信息",
            |m| {
                remove_key(m, "anchors");
                m["scan"] = json!({"assetHash": hex('1'), "webModelHashes": [hex('2'), hex('7')],
                    "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]});
                m["files"] = json!([
                    {"path": "scan/scan.zip", "purpose": "scan", "sha256": hex('1'), "size": 1_003_301},
                    {"path": "web/scan-0.glb", "purpose": "webmodel", "sha256": hex('2'), "size": 13_800_000},
                    {"path": "web/scan-1.glb", "purpose": "webmodel", "sha256": hex('7'), "size": 3_400_000}
                ]);
            },
        ),
        Case::changed_full(
            "bundle_valid_merge_space_template",
            "合并包可以引用目标空间重建层已有的模板（spaceTemplates 给出）",
            |m| {
                remove_key(m, "scan");
                m["rebuilt"]["mode"] = json!("merge");
                m["rebuilt"]["templates"] = json!([]);
                m["rebuilt"]["entities"] = json!([m["rebuilt"]["entities"][0].clone()]);
                m["anchors"] = json!([]);
                remove_key(m, "notes");
                m["files"] = json!([
                    {"path": "textures/333333333333.jpg", "purpose": "texture", "sha256": hex('3'), "size": 51_234}
                ]);
            },
        )
        .space_templates(json!({"rb.chair-a": {"type": "box", "size": [0.45, 0.46, 0.45], "transform": {"position": [0, 0.41, 0]}}})),
        Case::changed(
            "bundle_invalid_version",
            "version 只认 1（以后加字段就升版本）",
            |m| m["version"] = json!(2),
        ),
        Case::changed_full(
            "bundle_invalid_chunks",
            "重建包第一版不写方块：rebuilt 里出现 chunks 按不认识的字段拒绝",
            |m| m["rebuilt"]["chunks"] = json!([]),
        ),
        Case::changed_full(
            "bundle_invalid_missing_file",
            "包要完整：外部模型物件引用的 glb 不在 files 里",
            |m| m["files"].as_array_mut().unwrap().retain(|f| f["purpose"] != "model"),
        ),
        Case::changed_full(
            "bundle_invalid_purpose_mismatch",
            "引用的用途要与 files 里的一致：贴图的哈希当成物件模型引用",
            |m| m["rebuilt"]["entities"][1]["assetHash"] = json!(hex('3')),
        ),
        Case::changed_full(
            "bundle_invalid_path",
            "files[].path 只能是相对路径，不能有 .. 段",
            |m| m["files"][0]["path"] = json!("../scan.zip"),
        ),
        Case::changed_full(
            "bundle_invalid_duplicate_hash",
            "同一哈希在 files 里只能出现一次",
            |m| {
                let copy = m["files"][2].clone();
                m["files"].as_array_mut().unwrap().push(json!({
                    "path": "textures/copy.jpg", "purpose": copy["purpose"], "sha256": copy["sha256"], "size": copy["size"]}));
            },
        ),
        Case::changed_full(
            "bundle_invalid_size",
            "files[].size 不能超过该用途的上传上限（这里把贴图上限调成 1 MiB）",
            |_| {},
        )
        .limits(json!({
            "v": 1,
            "scan": {"maxBytes": 1u64 << 30},
            "webmodel": {"maxBytes": 64u64 << 20, "maxTriangles": 500000, "maxTextureSide": 4096, "maxTexturePixels": 33554432, "maxCoord": 100000.0},
            "model": {"maxBytes": 50u64 << 20, "maxTriangles": 100000, "maxTextureSide": 2048, "maxTexturePixels": 16777216, "maxCoord": 1000.0},
            "texture": {"maxBytes": 65536, "maxSide": 4096, "maxPixels": 16777216},
            "ops": {"maxBytes": 64u64 << 20},
            "script": {"maxBytes": 4u64 << 20},
            "bundle": {"maxBytes": 16u64 << 20}
        })),
        Case::changed_full(
            "bundle_invalid_entity_prefix",
            "重建层的编号必须以 rb. 开头",
            |m| m["rebuilt"]["entities"][2]["entityId"] = json!("wall-01"),
        ),
        Case::changed_full(
            "bundle_invalid_entity_layer",
            "rebuilt 里的记录 layer 必须是 rebuilt",
            |m| m["rebuilt"]["entities"][2]["layer"] = json!("ext"),
        ),
        Case::changed_full(
            "bundle_invalid_entity_bounds",
            "每条记录按 SHAPES 校验：bounds 没有包住墙的形状",
            |m| m["rebuilt"]["entities"][2]["bounds"]["max"] = json!([3, 3, 4.95]),
        ),
        Case::changed_full(
            "bundle_invalid_template_kind",
            "rebuilt.templates 里只能放 kind = template 的记录",
            |m| m["rebuilt"]["templates"][0]["kind"] = json!("object"),
        ),
        Case::changed_full(
            "bundle_invalid_remove_in_replace",
            "remove 只在 merge 模式下能给",
            |m| m["rebuilt"]["remove"] = json!(["wall-01"]),
        ),
        Case::changed_full(
            "bundle_invalid_remove_overlap",
            "remove 不能与 templates、entities 的编号重复",
            |m| {
                m["rebuilt"]["mode"] = json!("merge");
                m["rebuilt"]["remove"] = json!(["rb.sofa-01"]);
            },
        ),
        Case::changed_full(
            "bundle_invalid_replace_space_template",
            "整体替换先清空重建层：只能引用本包的模板，不能引用目标空间已有的模板",
            |m| m["rebuilt"]["templates"] = json!([]),
        )
        .space_templates(json!({"rb.chair-a": {"type": "box", "size": [0.45, 0.46, 0.45], "transform": {"position": [0, 0.41, 0]}}})),
        Case::changed(
            "bundle_invalid_space_anchor",
            "锚点不能是 _space",
            |m| m["anchors"] = json!([{"anchorId": "_space", "kind": "space", "visibility": "public"}]),
        ),
        Case::changed(
            "bundle_invalid_duplicate_anchor",
            "锚点编号不能重复",
            |m| {
                let anchor = m["anchors"][0].clone();
                m["anchors"].as_array_mut().unwrap().push(anchor);
            },
        ),
        Case::changed_full(
            "bundle_invalid_scan_transform",
            "scan.transform 的规则同 setScan：镜像变换不收",
            |m| m["scan"]["transform"][5] = json!(-1),
        ),
        Case::changed_full(
            "bundle_invalid_notes_purpose",
            "notes 必须是 files 里用途为 script 的文件",
            |m| m["notes"] = json!(hex('3')),
        ),
        Case::changed_full(
            "bundle_invalid_report_local_path",
            "report 里的字符串不能像本地路径",
            |m| m["report"]["source"] = json!("/Users/me/lobby/scan.zip"),
        ),
        Case::changed(
            "bundle_invalid_tool_source",
            "tool.source 只能是 git: 加 40 位小写十六进制",
            |m| m["tool"]["source"] = json!("git:main"),
        ),
        Case::changed(
            "bundle_invalid_empty",
            "scan、rebuilt、anchors 至少给一个",
            |m| remove_key(m, "anchors"),
        ),
        Case::changed(
            "bundle_invalid_created_at",
            "createdAt 必须是 RFC 3339 时间",
            |m| m["createdAt"] = json!("2026-11-20 08:00"),
        ),
        Case::changed_full(
            "bundle_invalid_record_too_large",
            "每条记录的原始 JSON 不超过 64 KiB（逐条解析的上限）",
            |m| {
                let children: Vec<Value> = (0..1200)
                    .map(|i| json!({"type": "box", "size": [0.01, 0.01, 0.01],
                        "transform": {"position": [f64::from(i % 40) * 0.02, 0.0, f64::from(i / 40) * 0.02]}}))
                    .collect();
                m["rebuilt"]["entities"][2]["shape"] = json!({"type": "group", "children": children});
                m["rebuilt"]["entities"][2]["bounds"] = json!({"min": [-0.01, 0, -0.01], "max": [0.8, 0.01, 0.6]});
            },
        ),
    ]
}

/// 各用途的默认上限：命令行和本地工具没有 `limits.json` 时用的值必须与服务端相同。
fn limits_vector() -> (String, Value) {
    (
        "bundle_limits_default".into(),
        json!({
            "kind": "bundle-limits",
            "name": "limits-default",
            "description": "各用途的默认上传上限（uploadLimits 的形状和默认值）。命令行、本地工具没有 limits.json 时用同样的值",
            "limits": UploadLimits::default(),
        }),
    )
}

fn all_vectors() -> Vec<(String, Value)> {
    let mut vectors: Vec<_> = cases().into_iter().map(Case::vector).collect();
    vectors.push(limits_vector());
    vectors
}

#[test]
fn bundle_vectors_match_rust_implementation() {
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
            "bundle" => assert_eq!(
                actual["expect"],
                expect(&actual),
                "{file}.json 与 Rust 实现不一致"
            ),
            "bundle-limits" => assert_eq!(
                serde_json::from_value::<UploadLimits>(actual["limits"].clone()).unwrap(),
                UploadLimits::default()
            ),
            other => panic!("{file}: 未知的向量类型 {other}"),
        }
        assert_eq!(
            Some(&actual),
            expected.get(&file),
            "{file}.json 已过期：请用 METAVERSE_WRITE_VECTORS=1 重新生成"
        );
    }
}

/// 合法的用例必须真的合法、不合法的必须真的被拒（防止改了清单却没改说明）。
#[test]
fn case_names_match_outcomes() {
    for (file, vector) in all_vectors() {
        if vector["kind"] != "bundle" {
            continue;
        }
        let valid = vector["expect"]["valid"].as_bool().unwrap();
        assert_eq!(
            valid,
            file.starts_with("bundle_valid_"),
            "{file}: {}",
            vector["expect"]
        );
        if let Some(runs) = vector["expect"]["runs"].as_array() {
            // 第二次推同一个包没有变化；第一次作用后完整性检查通过。
            assert!(
                runs[0]["brokenTemplateRefs"].as_array().unwrap().is_empty(),
                "{file}"
            );
            if runs.len() > 1 {
                assert_eq!(runs[1]["unchanged"], true, "{file}");
            }
        }
    }
}
