"""形状包围盒与校验（SHAPES 2）。期望值与接口服务生成的测试向量相同（内联一份）。"""

import pytest

from metaverse_worker import shapes as sh
from metaverse_worker.records import RecordError, entity_body

INLINE = [
    (
        {"size": [1, 1, 1], "transform": {"yaw": 30}, "type": "box"},
        [-0.6830127018922193, 0.0, -0.6830127018922193],
        [0.6830127018922193, 1.0, 0.6830127018922193],
    ),
    (
        {
            "chamfer": 0.02,
            "height": 0.5,
            "outline": {
                "arcs": [{"bulge": 0.41421356237309503, "from": 1}, {"bulge": -0.3, "from": 3}],
                "fillets": [{"at": 0, "radius": 0.1}],
                "points": [[0, 0], [2, 0], [2, 1], [0, 1]],
            },
            "type": "extrude",
        },
        [0.0, 0.0, 0.0],
        [2.2071067811865475, 0.5, 1.0],
    ),
    (
        {"path": [[0, 0, 0], [1, 0, 0], [1, 0, 1]], "section": {"rect": [0.06, 0.08]}, "type": "sweep"},
        [-0.05, -0.05, -0.05],
        [1.05, 0.05, 1.05],
    ),
    (
        {
            "size": [1, 2, 3],
            "transform": {"pitch": 20, "position": [0.5, 1, -2], "roll": 10, "scale": [1, 0.5, 2], "yaw": 30},
            "type": "box",
        },
        [-1.3508209908085553, -0.10764838556027367, -4.661877849313062],
        [2.3688493020448522, 3.033064963958597, 1.040400155682855],
    ),
]


@pytest.mark.parametrize(("shape", "lo", "hi"), INLINE)
def test_inline_bounds(shape, lo, hi):
    sh.validate_shape(shape)
    b = sh.shape_bounds(shape)
    assert b["min"] == pytest.approx(lo, abs=1e-9)
    assert b["max"] == pytest.approx(hi, abs=1e-9)


def test_instance_uses_template_bounds():
    templates = {
        "chair-a": {
            "type": "group",
            "children": [
                {"size": [0.5, 0.05, 0.5], "transform": {"position": [0, 0.45, 0]}, "type": "box"},
                {"size": [0.5, 0.45, 0.05], "transform": {"position": [0, 0.5, -0.225]}, "type": "box"},
            ],
        }
    }
    shape = {
        "material": {"color": [30, 60, 200]},
        "template": "chair-a",
        "transform": {"position": [3, 0, 4], "yaw": 45},
        "type": "instance",
    }
    b = sh.shape_bounds(shape, templates)
    assert b["min"] == pytest.approx([2.646446609406726, 0.45, 3.646446609406726], abs=1e-9)
    assert b["max"] == pytest.approx([3.353553390593274, 0.95, 4.353553390593274], abs=1e-9)
    with pytest.raises(sh.ShapeError):
        sh.shape_bounds({"type": "instance", "template": "ghost"})
    loop = {"a": {"type": "instance", "template": "b"}, "b": {"type": "instance", "template": "a"}}
    with pytest.raises(sh.ShapeError):
        sh.shape_bounds({"type": "instance", "template": "a"}, loop)


@pytest.mark.parametrize(
    "shape",
    [
        {"type": "cylinder", "radius": 1, "height": 1, "radius_top": 0.5},  # 拼错的字段
        {"type": "box", "size": [1, 1, 1], "material": {"color": [1, 2, 3], "uv": "box"}},
        {"type": "box", "size": [1, 0, 1]},
        {"type": "extrude", "height": 1, "outline": {"points": [[0, 0], [0, 1], [1, 1], [1, 0]]}},  # 顺时针
        {"type": "box", "size": [1, 1, 1], "material": {"texture": "abc", "uv": "box"}},
        {"type": "group", "children": []},
        {"type": "sphere", "radius": 1},
    ],
)
def test_invalid_shapes_rejected(shape):
    with pytest.raises(sh.ShapeError):
        sh.validate_shape(shape)


def test_builders_produce_valid_records():
    tex = "ab" * 32
    shape = sh.box(
        [4.0, 2.6, 0.1],
        xf=sh.transform(position=[1.23456789, 0, 2], yaw=-61.2345678),
        material=sh.texture_material(tex, "planar"),
    )
    assert shape["transform"]["position"] == [1.2346, 0, 2]
    body = entity_body(entity_id="wall-1", kind="structure", shape=shape, textures=[tex], props={"a": 1})
    b = sh.shape_bounds(shape)
    for k in range(3):
        assert body["bounds"]["min"][k] <= b["min"][k]
        assert body["bounds"]["max"][k] >= b["max"][k]
    with pytest.raises(RecordError):
        entity_body(
            entity_id="wall-1",
            kind="structure",
            shape=shape,
            bounds={"min": [0, 0, 0], "max": [0.1, 0.1, 0.1]},
        )
    with pytest.raises(RecordError):
        entity_body(entity_id="_reserved", kind="structure", shape=shape)


def test_exact_quarter_turns():
    assert sh.sin_cos_degrees(90) == (1.0, 0.0)
    assert sh.sin_cos_degrees(-90) == (-1.0, 0.0)
    assert sh.sin_cos_degrees(720) == (0.0, 1.0)
    assert sh.apply_transform({"yaw": 90, "position": [1, 0, 0]}, [1, 0, 0]) == [1.0, 0.0, -1.0]
