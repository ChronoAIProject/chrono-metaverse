"""记录校验与接口服务 `metaverse-core/src/record.rs` 一致：标签不能含控制字符，锚点 body 的规则。"""

import pytest

from metaverse_worker import shapes as sh
from metaverse_worker.records import (
    RecordError,
    check_label,
    entity_body,
    is_https_url,
    model_source,
    validate_anchor_body,
    validate_model_source,
    validate_props,
)

BOX = sh.box([1.0, 0.75, 0.8])


@pytest.mark.parametrize("label", ["前台", "会议桌 A-3", "x" * 200, "带 不换行空格", "表情😀"])
def test_label_accepted(label):
    check_label(label)
    entity_body(entity_id="table-01", kind="object", shape=BOX, label=label)


@pytest.mark.parametrize(
    "label",
    ["x" * 201, "两行\n标签", "制表\t符", "回车\r", "\x00", "删除\x7f", "C1 控制符\x85", 12, None],
)
def test_label_rejected(label):
    with pytest.raises(RecordError):
        check_label(label)
    if isinstance(label, str):
        with pytest.raises(RecordError):
            entity_body(entity_id="table-01", kind="object", shape=BOX, label=label)


def test_anchor_body_rules():
    ok = [
        {"anchorId": "t1", "kind": "table", "box": [0, 0, 0, 10, 15, 10], "visibility": "public"},
        {"anchorId": "_space", "kind": "space", "visibility": "public"},
        {
            "anchorId": "door",
            "kind": "door",
            "position": [0.12, 0, 0],
            "visibility": "internal",
            "label": "门",
        },
    ]
    for body in ok:
        validate_anchor_body(body)
    bad = [
        {"anchorId": "_x", "kind": "table", "position": [0, 0, 0], "visibility": "public"},
        {"anchorId": "t1", "kind": "space", "visibility": "public"},
        {"anchorId": "_space", "kind": "zone", "visibility": "public"},
        {"anchorId": "t1", "kind": "table", "visibility": "public"},
        {
            "anchorId": "t1",
            "kind": "table",
            "box": [0, 0, 0, 1, 1, 1],
            "position": [0, 0, 0],
            "visibility": "public",
        },
        {"anchorId": "t1", "kind": "table", "box": [0, 0, 0, 0, 1, 1], "visibility": "public"},
        {"anchorId": "t1", "kind": "table", "box": [0, 0, 0, 1.5, 1, 1], "visibility": "public"},
        {"anchorId": "t1", "kind": "table", "position": [0, float("nan"), 0], "visibility": "public"},
        {"anchorId": "t1", "kind": "table", "position": [0, 0, 0], "visibility": "secret"},
        {"anchorId": "t1", "kind": "sofa", "position": [0, 0, 0], "visibility": "public"},
        {"anchorId": "t1", "kind": "table", "position": [0, 0, 0], "visibility": "public", "label": "a\nb"},
        {"anchorId": "t1", "kind": "table", "position": [0, 0, 0], "visibility": "public", "extra": 1},
    ]
    for body in bad:
        with pytest.raises(RecordError):
            validate_anchor_body(body)


SOURCE = {
    "library": "objaverse",
    "id": "0123abcd",
    "page": "https://sketchfab.com/3d-models/0123abcd",
    "author": "某作者",
    "license": "CC-BY-4.0",
    "title": "布艺沙发",
}
MODEL = "ab" * 32
MODEL_BOUNDS = {"min": [0, 0, 0], "max": [2, 0.8, 0.9]}


def _model(**extra):
    args = {
        "entity_id": "sofa-01",
        "kind": "object",
        "asset_hash": MODEL,
        "bounds": MODEL_BOUNDS,
        "props": {"source": dict(SOURCE)},
    }
    args.update(extra)
    return entity_body(**args)


def test_model_entity_with_source_and_tint():
    body = _model(material={"tint": [214, 196, 176], "opacity": 1})
    assert body["material"] == {"tint": [214, 196, 176], "opacity": 1}
    assert model_source(**SOURCE) == SOURCE
    # 旧数据里 source 是识别来源的字符串，照旧当不透明的值。
    _model(props={"source": "hint"})
    validate_props({"category": "chair"})


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("license", "CC-BY-NC-4.0"),
        ("license", "CC-BY-SA-4.0"),
        ("license", "CC-BY-ND-4.0"),
        ("library", "thingiverse"),
        ("page", "javascript:alert(1)"),
        ("page", "http://example.com/x"),
        ("page", "https://example.com/a b"),
        ("page", "https://example.com/a b"),
        ("page", "https://"),
        ("page", "https://a.b/" + "x" * 2000),
        ("author", ""),
        ("title", "a\x07b"),
        ("title", "x" * 201),
        ("id", 7),
        ("extra", "x"),
    ],
)
def test_model_source_rejected(key, value):
    source = {**SOURCE, key: value}
    with pytest.raises(RecordError):
        _model(props={"source": source})
    with pytest.raises(RecordError):
        validate_model_source(source)


def test_model_material_rules():
    missing = dict(SOURCE)
    del missing["author"]
    with pytest.raises(RecordError):
        _model(props={"source": missing})
    with pytest.raises(RecordError):
        validate_model_source([SOURCE])
    with pytest.raises(RecordError, match="assetHash"):
        entity_body(entity_id="sofa-01", kind="object", shape=BOX, material={"tint": [1, 2, 3]})
    for bad in ({"opacity": 2}, {"color": [1, 2, 3]}, {"tint": [1, 2]}, {"unlit": 1}, []):
        with pytest.raises(RecordError):
            _model(material=bad)
    assert is_https_url("https://polyhaven.com/a/sofa")
    assert not is_https_url(None)
