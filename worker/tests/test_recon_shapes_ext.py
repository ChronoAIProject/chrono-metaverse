"""重建工作台的形状兼容层：plate、hull、opacity、unlit、bake（按 SHAPES 新增的规定）。"""

from __future__ import annotations

import numpy as np
import pytest

from metaverse_worker.processing import shape_mesh as sm
from metaverse_worker.recon import shapes_ext as sx
from metaverse_worker.shapes import ShapeError

# 斜着的四边形（法向朝 +y 偏 +z），从法向一侧看逆时针
SLOPE = [[0, 0.5, 0.5], [1.0, 0.5, 0.5], [1.0, 1.0, 0], [0, 1.0, 0]]


def plate(points=None, t=0.04, **extra):
    return {"type": "plate", "points": points or SLOPE, "thickness": t, **extra}


def test_plate_normal_bounds_and_mesh():
    shape = plate()
    sx.validate_shape(shape)
    n = sx.newell_normal(np.array(SLOPE, float))
    assert n[1] > 0 and n[2] > 0  # 右手定则：逆时针给出朝上、朝 +z 的法向
    b = sx.shape_bounds(shape)
    off = -n * 0.04  # 板沿 −法向延伸
    assert b["min"][1] == pytest.approx(0.5 + off[1])
    assert b["min"][2] == pytest.approx(min(0, off[2]))
    assert b["max"][2] == pytest.approx(0.5)
    mesh = sx.plate_mesh(shape)
    # 封闭：顶面 + 底面 + 4 个侧面，体积 = 面积 × 厚度
    area = np.linalg.norm(np.cross(np.array(SLOPE[1]) - SLOPE[0], np.array(SLOPE[3]) - SLOPE[0]))
    tri = mesh.triangles()
    vol = np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum() / 6
    assert vol == pytest.approx(area * 0.04, rel=1e-6)


@pytest.mark.parametrize(
    ("shape", "message"),
    [
        (plate(t=0), "厚度"),
        (plate(t=1.5), "厚度"),
        (plate(points=[[0, 0, 0], [1, 0, 0]]), "3 到 64"),
        (plate(points=[[0, 0, 0], [1, 0, 0], [1, 0.01, 1], [0, 0, 1]]), "平面"),
        (plate(points=[[0, 0, 0], [2, 0, 0], [2, 0, 2], [1, 0, -1], [0, 0, 2]]), "自相交"),
        (plate(points=[[0, 0, 0], [1, 0, 0], [2, 0, 0]]), "共线"),
        (plate(extra=1), "不认识"),
        ({"type": "hull", "points": [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]]}, "共面"),
        ({"type": "hull", "points": [[0, 0, 0], [1, 0, 0], [0, 1, 0]]}, "4 到 256"),
    ],
)
def test_invalid_ext_shapes(shape, message):
    with pytest.raises(ShapeError, match=message):
        sx.validate_shape({"type": "group", "children": [shape]})


def test_plate_planarity_tolerance_is_one_millimetre():
    ok = [[0, 0, 0], [1, 0, 0], [1, 0.0009, 1], [0, 0, 1]]
    sx.validate_shape(plate(points=ok))


def test_hull_mesh_is_closed_convex_and_outward():
    pts = [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1], [0.5, 0.8, 0.5], [0.5, 0.2, 0.5]]  # 最后一点在里面
    shape = {"type": "hull", "points": pts}
    sx.validate_shape(shape)
    mesh = sx.hull_mesh(shape)
    tri = mesh.triangles()
    vol = np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum() / 6
    assert vol == pytest.approx(1 * 1 * 0.8 / 3)  # 四棱锥，法向朝外时体积为正
    assert sx.shape_bounds(shape) == {"min": [0, 0, 0], "max": [1, 0.8, 1]}


def test_material_extras_validation_and_parts():
    good = {
        "type": "group",
        "children": [
            {"type": "box", "size": [1, 1, 1], "material": {"color": [10, 20, 30], "opacity": 0.4}},
            {"type": "box", "size": [1, 1, 1], "material": {"color": [255, 255, 255], "unlit": True}},
            plate(material={"bake": "planar"}),
            {
                "type": "hull",
                "points": [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
                "transform": {"position": [2, 0, 0]},
            },
        ],
    }
    sx.validate_shape(good)
    parts = sx.build_parts(good)
    assert len(parts) == 4
    assert parts[0].material["opacity"] == 0.4 and parts[1].material["unlit"] is True
    assert parts[2].material["bake"] == "planar" and parts[2].material["color"] == sx.PREVIEW_COLOR
    lo, hi = parts[3].mesh.bounds()
    assert lo[0] == pytest.approx(2) and hi[0] == pytest.approx(3)
    for bad, msg in (
        ({"color": [1, 2, 3], "opacity": 2}, "opacity"),
        ({"color": [1, 2, 3], "unlit": 1}, "unlit"),
        ({"bake": "mesh"}, "bake"),
        ({"texture": "a" * 64, "uv": "box", "bake": "box"}, "texture"),
    ):
        with pytest.raises(ShapeError, match=msg):
            sx.validate_shape({"type": "box", "size": [1, 1, 1], "material": bad})


def test_build_parts_matches_processing_for_existing_types():
    shape = {
        "type": "group",
        "transform": {"position": [1, 0, 2], "yaw": 30},
        "children": [
            {"type": "box", "size": [1, 0.5, 0.4], "fillet": 0.05, "material": {"color": [200, 10, 10]}},
            {"type": "cylinder", "radius": 0.2, "height": 0.7},
        ],
    }
    ours = sx.build_parts(shape)
    theirs = sm.build_parts(shape)
    assert len(ours) == len(theirs)
    for a, b in zip(ours, theirs, strict=True):
        assert np.allclose(a.mesh.positions, b.mesh.positions) and a.material == b.material


def test_uses_ext_lists_new_features():
    assert sx.uses_ext(
        {"type": "group", "children": [plate(material={"color": [1, 1, 1], "opacity": 0.5})]}
    ) == [
        "opacity",
        "plate",
    ]
