"""逐件偏差的口径（`processing/object_fit.py`）：物件自身朝向的范围、背景、距离上限、证据；写回路径与重建工作台
compare 在同一份合成场景上算出同样的数字。"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from metaverse_worker import shapes as sh
from metaverse_worker.authored import parse_authored
from metaverse_worker.processing.authored_build import authored_rebuild
from metaverse_worker.processing.bake import FaceTable
from metaverse_worker.processing.object_fit import (
    FIT_MARGIN,
    FIT_VERTICAL,
    background_meshes,
    entity_fit,
    fit_region,
    footprint_yaw,
)
from metaverse_worker.processing.scan import ScanMesh
from metaverse_worker.processing.shape_mesh import build_parts
from metaverse_worker.recon import compare as cp
from metaverse_worker.recon import core as wc
from metaverse_worker.recon.cli import build_parser
from recon_support import box_planes, make_base, ry
from synthetic import _Builder, box_mesh, merged, room_mesh

LIMITS = {
    "max_triangles": 1_000_000,
    "max_texture_pixels": 1 << 26,
    "max_model_bytes": 1 << 26,
    "model_max_triangles": 5000,
    "model_max_texture_side": 256,
}


def meshes_of(shape) -> list:
    return [p.mesh for p in build_parts(shape)]


# ---------------------------------------------------------------------------- 范围


@pytest.mark.parametrize("deg", [0.0, 20.0, 35.0, 70.0, -30.0])
def test_footprint_yaw_follows_the_rectangle(deg):
    """水平投影的最小外接矩形：转了多少（模 90°）就是多少；轴对齐的是 0。"""
    shape = sh.box([1.2, 2.0, 0.08], xf=sh.transform(position=[1, 0, 1], yaw=deg))
    pts = np.concatenate([m.positions for m in meshes_of(shape)])
    yaw = footprint_yaw(pts[:, [0, 2]])
    # 本地 x 轴转到 (cos, −sin)：朝向是 −deg（模 90°）
    want = math.radians(-deg) % (math.pi / 2)
    want = 0.0 if want > math.pi / 2 - 1e-6 else want
    assert yaw == pytest.approx(want, abs=1e-6)


def test_footprint_yaw_degenerate_inputs():
    assert footprint_yaw(np.array([[1.0, 2.0]])) == 0.0
    line = np.array([[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]])  # 竖着的零厚度薄片：沿着那条线
    assert footprint_yaw(line) == pytest.approx(math.pi / 4)


def test_region_is_oriented_and_bounded_vertically():
    """斜放薄板的范围：贴着板的点在里面，轴对齐包围盒角落里的点不在；竖直方向只多 2 厘米。"""
    shape = sh.box([1.2, 2.1, 0.08], xf=sh.transform(position=[2.5, 0, 2.0], yaw=35))
    region = fit_region(meshes_of(shape))
    R = ry(35)
    on_face = R @ np.array([0.3, 1.0, 0.04 + FIT_MARGIN - 0.01]) + [2.5, 0, 2.0]
    corner = np.array([2.85, 1.0, 2.3])  # 轴对齐包围盒里、离板 40 厘米
    lo, hi = sh.shape_bounds(shape, {})["min"], sh.shape_bounds(shape, {})["max"]
    assert np.all((np.array(lo) <= corner) & (corner <= np.array(hi)))
    top = R @ np.array([0.0, 2.1 + FIT_VERTICAL - 0.005, 0.0]) + [2.5, 0, 2.0]
    above = R @ np.array([0.0, 2.1 + FIT_VERTICAL + 0.005, 0.0]) + [2.5, 0, 2.0]
    below = R @ np.array([0.0, -FIT_VERTICAL - 0.005, 0.0]) + [2.5, 0, 2.0]
    inside = region.contains(np.array([on_face, corner, top, above, below]))
    assert inside.tolist() == [True, False, True, False, False]
    # 外包盒是范围四个角的轴对齐外包
    wlo, whi = region.world_box()
    assert np.all(wlo <= on_face) and np.all(on_face <= whi)


def test_big_scan_triangles_crossing_the_region_are_sampled():
    """扫描的大三角形中心在范围外、但穿过范围时也要采到（只看面中心会漏掉）。"""
    b = _Builder()
    b.plane([-2, 0, -2], [0, 0, 4], [4, 0, 0], (150, 120, 90), cell=4.0)  # 一块 4×4 米、两个三角形的地面
    table = FaceTable(b.build())
    stone = sh.box([0.2, 0.2, 0.2], xf=sh.transform(position=[0, 0, 0]))
    region = fit_region(meshes_of(stone))
    lo, hi = region.world_box()
    assert len(table.faces_in_box(lo, hi)) == 0
    assert len(table.faces_touching(lo, hi)) == 2
    fit, points = entity_fit(meshes_of(stone), table, "stone")
    # 没有背景：石头周围一圈（外扩 5 厘米）的地面点照常算
    assert points > 100 and fit is not None and fit["p90Cm"] <= FIT_MARGIN * 100 + 0.5


# ---------------------------------------------------------------------------- 背景、距离上限、证据


def south_wall_and_floor():
    wall = sh.box([5.0, 2.6, 0.01], xf=sh.transform(position=[2.5, 0, -0.01]))
    floor = sh.box([5.0, 0.01, 4.0], xf=sh.transform(position=[2.5, -0.01, 2.0]))
    return {
        "wall-south": {"kind": "structure", "props": {"structure": "wall"}, "shape": wall},
        "floor": {"kind": "structure", "props": {"structure": "floor"}, "shape": floor},
        "desk": {"kind": "object", "shape": sh.box([1, 1, 1])},
    }


def test_wall_and_floor_points_count_against_the_background():
    """离南墙 4 厘米的矮柜：范围里的墙面和地面扫描点算到背景上（与工作台 compare 相同），相邻物件不当背景。"""
    cabinet = sh.box([1.0, 0.75, 0.56], xf=sh.transform(position=[1.5, 0, 0.32]))
    scan = merged(room_mesh(), box_mesh([1.0, 0, 0.04], [2.0, 0.75, 0.6]))
    background = background_meshes(south_wall_and_floor(), {})
    assert len(background) == 2  # 墙和地面；物体不当背景
    table = FaceTable(scan)
    alone, n = entity_fit(meshes_of(cabinet), table, "cabinet")
    with_bg, n2 = entity_fit(meshes_of(cabinet), table, "cabinet", background)
    assert n2 >= n > 1000
    assert alone["meanCm"] > with_bg["meanCm"] + 0.2 and alone["coverage3cm"] < 0.95
    assert with_bg["meanCm"] < 0.3 and with_bg["coverage3cm"] > 0.99


def test_no_fit_without_evidence_of_the_object():
    """扫描里没有这件物件：范围里只有墙和地面，全部算到背景上，不写 fit（不能是"完美贴合"）。"""
    cabinet = sh.box([1.0, 0.75, 0.56], xf=sh.transform(position=[1.5, 0, 0.32]))
    table = FaceTable(room_mesh())
    fit, points = entity_fit(
        meshes_of(cabinet), table, "cabinet", background_meshes(south_wall_and_floor(), {})
    )
    assert fit is None and points > 100
    # 没有背景时墙面的点离柜子背面 4 厘米，周围一圈地面离柜子 0–5 厘米，照常算
    alone, _ = entity_fit(meshes_of(cabinet), table, "cabinet")
    assert alone is not None and alone["meanCm"] > 2 and alone["coverage3cm"] < 0.6


def test_points_far_from_object_and_background_are_not_counted():
    """L 形桌子范围里的椅子（离桌子 20 厘米以上）不算这件物件的偏差。"""
    desk = {
        "type": "group",
        "children": [
            sh.box([1.6, 0.75, 0.6], xf=sh.transform(position=[1.8, 0, 1.3])),
            sh.box([0.6, 0.75, 1.0], xf=sh.transform(position=[1.3, 0, 2.1])),
        ],
    }
    b = _Builder()
    box_planes(b, [1.0, 0, 1.0], [2.6, 0.75, 1.6], (120, 90, 60))
    box_planes(b, [1.0, 0, 1.6], [1.6, 0.75, 2.6], (120, 90, 60))
    plain = b.build()
    box_planes(b, [2.0, 0, 2.0], [2.4, 0.9, 2.4], (60, 60, 160))  # L 的内角里一把"椅子"
    cluttered = b.build()
    clean, n = entity_fit(meshes_of(desk), FaceTable(plain), "desk")
    busy, n2 = entity_fit(meshes_of(desk), FaceTable(cluttered), "desk")
    assert clean["meanCm"] < 0.3 and busy["meanCm"] < 0.6 and busy["p90Cm"] < 2.0
    assert n2 - n < 0.05 * n  # 椅子的点几乎都没计入


# ---------------------------------------------------------------------------- 与工作台 compare 一致


def room_builder(height: float) -> _Builder:
    b = _Builder(tiles_per_row=3)
    b.plane([0, 0, 0], [0, 0, 4], [5, 0, 0], (150, 120, 90))
    b.plane([0, height, 0], [5, 0, 0], [0, 0, 4], (230, 230, 230))  # 天花板：不是结构
    up = np.array([0, height, 0.0])
    for (x0, z0), (x1, z1) in [((0, 0), (5, 0)), ((5, 0), (5, 4)), ((5, 4), (0, 4)), ((0, 4), (0, 0))]:
        b.plane([x0, 0, z0], np.array([x1 - x0, 0, z1 - z0], float), up, (200, 60, 60))
    return b


def structure_entities(height: float) -> list[dict]:
    def box(eid, kind, lo, hi):
        size = [h - low for low, h in zip(lo, hi, strict=True)]
        position = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2]
        return {
            "entityId": eid,
            "kind": "structure",
            "shape": sh.box(size, xf=sh.transform(position=position)),
            "props": {"structure": kind},
        }

    return [
        box("floor", "floor", [0, -0.05, 0], [5, 0, 4]),
        box("wall-s", "wall", [0, 0, -0.05], [5, height, 0]),
        box("wall-n", "wall", [0, 0, 4], [5, height, 4.05]),
        box("wall-w", "wall", [-0.05, 0, 0], [0, height, 4]),
        box("wall-e", "wall", [5, 0, 0], [5.05, height, 4]),
    ]


def door_frame_scene():
    """斜放 35° 的入口门框（薄板）；轴对齐包围盒的角落里有门外走廊的一块隔板（不在物件集里）。"""
    b = room_builder(2.6)
    box_planes(b, [-0.6, 0, -0.04], [0.6, 2.1, 0.04], (120, 90, 60), ry(35), (2.5, 0, 2.0))
    box_planes(b, [-0.2, 0, -0.02], [0.2, 2.0, 0.02], (90, 90, 90), np.eye(3), (2.85, 0, 2.3))
    shape = sh.box([1.2, 2.1, 0.08], xf=sh.transform(position=[2.5, 0, 2.0], yaw=35))
    return b, 2.6, {"entityId": "door-frame", "kind": "object", "label": "入口门框", "shape": shape}


def ceiling_sign_scene():
    """斜放 30° 的吊挂灯箱，顶面离天花板只有 1 厘米。"""
    b = room_builder(2.51)
    box_planes(b, [-0.8, 1.9, -0.04], [0.8, 2.5, 0.04], (40, 40, 40), ry(30), (2.5, 0, 2.0))
    shape = sh.box([1.6, 0.6, 0.08], xf=sh.transform(position=[2.5, 1.9, 2.0], yaw=30))
    return b, 2.51, {"entityId": "sign", "kind": "object", "label": "灯箱", "shape": shape}


@pytest.mark.parametrize("scene", [door_frame_scene, ceiling_sign_scene])
def test_writeback_fit_matches_workbench_compare(tmp_path, scene):
    """斜放薄板、贴天花物件：写回路径写进记录的 fit 很小（轴对齐包围盒的口径会被走廊、天花拉到 8–10 厘米），
    与工作台 compare 的逐件 fit 完全相同。"""
    builder, height, entity = scene()
    built = builder.build()
    base = make_base(tmp_path, built)
    loaded = wc.load_scan(str(base / "scan.glb"))  # 两边用同一份扫描（glb 里是 float32）
    mesh = ScanMesh(loaded.V, loaded.F)

    # 写回路径：结构用物件集里的（replace），背景是墙和地面
    parsed = parse_authored(
        {
            "version": 1,
            "templates": [],
            "entities": [*structure_entities(height), entity],
            "structure": "replace",
        }
    )
    out = authored_rebuild(mesh, parsed, {}, workdir=str(tmp_path / "w"), limits=LIMITS)
    fit = out["entities"][entity["entityId"]]["fit"]
    assert fit["meanCm"] < 0.5 and fit["coverage3cm"] > 0.95, fit

    # 工作台：基线的结构就是写回的结构，记录里只有这件物件
    structure = {e: out["entities"][e] for e in out["structureIds"]}
    (base / "structure.json").write_text(json.dumps(structure, ensure_ascii=False))
    model = tmp_path / "model.json"
    model.write_text(json.dumps({"version": 1, "templates": [], "entities": [entity], "structure": "keep"}))
    out_dir = tmp_path / "cmp"
    args = build_parser().parse_args(
        [
            "compare",
            "--base",
            str(base),
            "--model",
            str(model),
            "--out",
            str(out_dir),
            "--scene",
            "--no-render",
        ]
    )
    res = cp.cmd_compare(args)
    got = res["new"]["entities"][entity["entityId"]]
    assert got["fit"] == fit
    points = {f["entityId"]: f["points"] for f in out["fit"]}
    assert got["fitPoints"] == points[entity["entityId"]]
