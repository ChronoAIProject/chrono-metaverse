"""物体重建：测量和拟合能从合成数据恢复参数；整条流水线的输出都是合法的物件记录。

合成数据用本模块自己的形状网格生成（`shape_mesh`）造：已知参数的圆角盒、圆柱、带圆弧的挤出、椅子、
桌子，表面按面积均匀采样当作"扫描点"；端到端测试把这些形状放进 `synthetic.room_mesh` 的房间里，
拼成带贴图的扫描网格。
"""

from __future__ import annotations

import hashlib
import math

import numpy as np
import pytest

from metaverse_worker import shapes as sh
from metaverse_worker.processing import fit_measure as fm
from metaverse_worker.processing import fit_templates as ft
from metaverse_worker.processing.objects import _textured, parse_hints, reconstruct_objects
from metaverse_worker.processing.scan import ScanMesh
from metaverse_worker.processing.shape_mesh import build_parts, expand_outline, merge_meshes, shape_mesh
from metaverse_worker.processing.structure import extract_structure
from metaverse_worker.records import validate_entity_body
from synthetic import room_mesh

# ---------------------------------------------------------------------------- 合成数据


def sample_shape(shape, density: float = 20_000.0, seed: int = 0):
    """形状表面按面积均匀采样：返回 (点, 法线)。"""
    mesh = shape_mesh(shape)
    tri = mesh.triangles()
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area = np.linalg.norm(cross, axis=1) / 2
    normal = cross / np.maximum(2 * area[:, None], 1e-12)
    rng = np.random.default_rng(seed)
    idx = np.repeat(np.arange(len(tri)), rng.poisson(area * density))
    r1, r2 = rng.random(len(idx)), rng.random(len(idx))
    s = np.sqrt(r1)
    w = np.c_[1 - s, s * (1 - r2), s * r2]
    return np.einsum("ni,nij->nj", w, tri[idx]), normal[idx]


def local_of(shape, density: float = 20_000.0) -> ft.Local:
    P, N = sample_shape(shape, density)
    return ft.Local(P, N, np.full((len(P), 3), 120, np.uint8))


def visible_boxes(boxes: list[dict], density: float = 20_000.0) -> ft.Local:
    """几个只平移的盒子拼成的物体：去掉落在别的盒子里面的采样点（真实扫描看不到被挡住的内表面）。"""
    out_p, out_n = [], []
    for k, box in enumerate(boxes):
        P, N = sample_shape(box, density, seed=k)
        keep = np.ones(len(P), bool)
        for j, b in enumerate(boxes):
            if j == k:
                continue
            w, h, d = b["size"]
            x, y, z = b["transform"]["position"]
            e = 1e-6  # 贴在别的盒子表面上（被盖住）的点也去掉
            inside = (np.abs(P[:, 0] - x) <= w / 2 + e) & (P[:, 1] >= y - e) & (P[:, 1] <= y + h + e)
            keep &= ~(inside & (np.abs(P[:, 2] - z) <= d / 2 + e))
        out_p.append(P[keep])
        out_n.append(N[keep])
    P, N = np.concatenate(out_p), np.concatenate(out_n)
    return ft.Local(P, N, np.full((len(P), 3), 120, np.uint8))


def contour_points(outline, spacing: float = 0.005) -> np.ndarray:
    pts, _, _ = expand_outline(outline, True)
    return fm.smooth_contour(np.asarray(pts), spacing, 1)


def chair_shape(seat_h: float = 0.46, top: float = 0.82) -> dict:
    """座面 + 弧形靠背（截面放样）+ 4 条腿，正面朝 +z。"""
    band = ft._band_outline((0.0, 0.0), 0.24, 0.04, -1.6, 1.6)
    back = {"type": "loft", "sections": [{"y": seat_h - 0.03, "outline": band}, {"y": top, "outline": band}]}
    seat = sh.extrude(
        sh.outline(
            [(-0.22, -0.2), (0.22, -0.2), (0.22, 0.22), (-0.22, 0.22)],
            fillets=[{"at": i, "radius": 0.06} for i in range(4)],
        ),
        0.06,
        xf=sh.transform(position=[0, seat_h - 0.06, 0]),
    )
    legs = [
        {
            "type": "sweep",
            "path": [[sx * 0.2, 0, sz * 0.18], [sx * 0.18, seat_h - 0.06, sz * 0.16]],
            "section": {"circle": 0.015},
        }
        for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))
    ]
    return sh.group([back, seat, *legs])


def table_shape() -> dict:
    """跑道形台面（1.6 × 0.8，高 0.75）+ 圆柱底座。"""
    top = sh.extrude(
        sh.outline(
            [(-0.8, -0.4), (0.8, -0.4), (0.8, 0.4), (-0.8, 0.4)],
            fillets=[{"at": i, "radius": 0.4} for i in range(4)],
        ),
        0.04,
        xf=sh.transform(position=[0, 0.71, 0]),
    )
    return sh.group([top, sh.cylinder(0.12, 0.71, segments=24)])


# ---------------------------------------------------------------------------- 测量


def test_min_area_rect_recovers_rotated_rectangle():
    rng = np.random.default_rng(1)
    loc = np.c_[rng.uniform(-0.6, 0.6, 3000), rng.uniform(-0.25, 0.25, 3000)]
    world = fm.yaw_rotate(loc, 30.0) + np.array([2.0, 3.0])
    rect = fm.min_area_rect(world)
    assert rect.size[0] == pytest.approx(1.2, abs=0.02)
    assert rect.size[1] == pytest.approx(0.5, abs=0.02)
    assert ((rect.yaw - 30.0 + 90) % 180) - 90 == pytest.approx(0.0, abs=1.0)
    assert np.allclose(rect.center, [2.0, 3.0], atol=0.02)


def test_fit_outline_rounded_rect_and_circle():
    rr = sh.outline(
        [(-0.6, -0.3), (0.6, -0.3), (0.6, 0.3), (-0.6, 0.3)],
        fillets=[{"at": i, "radius": 0.1} for i in range(4)],
    )
    fit = fm.fit_outline(contour_points(rr), 0.01)
    assert fit.kind == "rect"
    assert fit.info["half"][0] == pytest.approx(0.6, abs=0.01)
    assert fit.info["half"][1] == pytest.approx(0.3, abs=0.01)
    assert fit.info["radius"] == pytest.approx(0.1, abs=0.02)
    t = np.linspace(0, 2 * math.pi, 400, endpoint=False)
    circle = np.c_[0.5 + 0.3 * np.cos(t), -0.2 + 0.3 * np.sin(t)]
    fit = fm.fit_outline(circle, 0.01)
    assert fit.kind == "circle"
    assert fit.info["radius"] == pytest.approx(0.3, abs=0.005)
    sh.validate_shape(sh.extrude(fit.outline, 0.4))


def test_poly_outline_recovers_arc():
    """一边是外凸圆弧的挤出轮廓（前台的弧形立面）：拟合结果带一段凸度接近的圆弧。"""
    ol = sh.outline([(-0.8, -0.3), (0.8, -0.3), (0.8, 0.3), (-0.8, 0.3)], arcs=[{"from": 2, "bulge": 0.25}])
    fit = fm.fit_footprint(contour_points(ol), 0.01)
    arcs = fit.outline.get("arcs") or []
    assert arcs, fit.outline
    assert max(abs(a["bulge"]) for a in arcs) == pytest.approx(0.25, abs=0.08)
    assert fit.info["iou"] > 0.9
    sh.validate_shape(sh.extrude(fit.outline, 1.0))


# ---------------------------------------------------------------------------- 拟合模板


def _box_of(group: dict) -> dict:
    kids = [c for c in group["children"] if c["type"] == "box"]
    assert kids, group
    return kids[0]


def test_fit_box_recovers_rounded_box():
    o = local_of(sh.box([0.9, 0.7, 0.5], fillet=0.05))
    box = _box_of(ft.fit_box(o))
    assert box["size"] == pytest.approx([0.9, 0.7, 0.5], abs=0.02)
    assert 0.02 <= box["fillet"] <= 0.09


def test_fit_box_complexity_prefers_simple_outline_for_piles():
    """桌上的一堆东西（平放的书 + 立着的盒子 + 杯子）：顶点代价调高后轮廓明显更简单。"""
    o = visible_boxes(
        [
            sh.box([0.40, 0.04, 0.30], xf=sh.transform(position=[0.0, 0.0, 0.0])),
            sh.box([0.12, 0.25, 0.12], xf=sh.transform(position=[0.24, 0.0, -0.08])),
            sh.box([0.10, 0.12, 0.10], xf=sh.transform(position=[-0.05, 0.0, 0.2])),
        ]
    )

    def n_points(g):
        leaf = g["children"][0]
        return len(leaf["outline"]["points"]) if leaf["type"] == "extrude" else 4

    assert n_points(ft.fit_box(o, complexity=0.015)) <= n_points(ft.fit_box(o)) - 3


def test_fit_round_recovers_cylinder():
    o = local_of(sh.cylinder(0.25, 0.5, segments=48))
    lathe = ft.fit_round(o)["children"][0]
    assert lathe["type"] == "lathe"
    rs = [p[0] for p in lathe["profile"]]
    ys = [p[1] for p in lathe["profile"]]
    assert max(rs) == pytest.approx(0.25, abs=0.015)
    assert max(ys) == pytest.approx(0.5, abs=0.02)


def test_fit_table_recovers_top_and_pedestal():
    o = local_of(table_shape())
    g = ft.fit_table(o, 0.75, 0.04)
    top = g["children"][0]
    assert top["type"] == "extrude"
    assert top["transform"]["position"][1] + top["height"] == pytest.approx(0.75, abs=0.01)
    poly = fm.outline_polygon(top["outline"])
    assert np.ptp(poly[:, 0]) == pytest.approx(1.6, abs=0.04)
    assert np.ptp(poly[:, 1]) == pytest.approx(0.8, abs=0.04)
    # 两头是半圆：圆角半径接近半宽
    radii = [f["radius"] for f in top["outline"].get("fillets") or []]
    assert radii and max(radii) == pytest.approx(0.4, abs=0.06)
    bases = [c for c in g["children"][1:] if c["type"] in ("cylinder", "extrude", "box")]
    assert bases


def test_fit_chair_recovers_seat_and_curved_back():
    o = local_of(chair_shape(0.46, 0.82))
    g = ft.fit_chair(o)
    kinds = [c["type"] for c in g["children"]]
    assert "loft" in kinds and "extrude" in kinds
    seat = next(c for c in g["children"] if c["_part"]["name"] == "seat")
    assert seat["transform"]["position"][1] + seat["height"] == pytest.approx(0.46, abs=0.03)
    back = next(c for c in g["children"] if c["type"] == "loft")
    assert back["sections"][-1]["y"] == pytest.approx(0.82, abs=0.04)
    # 靠背是弧形：截面带圆弧
    assert back["sections"][-1]["outline"].get("arcs")
    legs = [c for c in g["children"] if c["type"] == "sweep"]
    assert len(legs) == 4
    for c in g["children"]:
        c.pop("_part")
    sh.validate_shape(g)


def test_fit_sofa_finds_seat_back_and_arms():
    base = sh.box([2.0, 0.28, 0.9], xf=sh.transform(position=[0, 0.0, 0]))
    seat = sh.box([1.5, 0.14, 0.62], xf=sh.transform(position=[0, 0.28, 0.14]))
    back = sh.box([1.5, 0.5, 0.25], xf=sh.transform(position=[0, 0.28, -0.32]))
    arms = [sh.box([0.25, 0.4, 0.9], xf=sh.transform(position=[s * 0.875, 0.28, 0])) for s in (-1, 1)]
    o = visible_boxes([base, seat, back, *arms])
    g = ft.fit_sofa(o)
    names = [c["_part"]["name"] for c in g["children"]]
    assert {"base", "back-1", "back-2", "arm-left", "arm-right"} <= set(names)
    # 坐垫按长度分成两个圆角盒，座高 0.42
    seats = [c for c in g["children"] if c["_part"]["name"].startswith("seat-")]
    assert len(seats) == 2
    for s in seats:
        assert s["type"] == "box" and s["fillet"] > 0
        assert s["transform"]["position"][1] + s["size"][1] == pytest.approx(0.42, abs=0.03)
    # 靠背垫、扶手是侧面轮廓的挤出，轮廓带圆弧（靠背顶、扶手前上角），挤出两端倒圆边
    for name in ("back-1", "back-2", "arm-left", "arm-right"):
        c = next(c for c in g["children"] if c["_part"]["name"] == name)
        assert c["type"] == "extrude" and c["outline"].get("arcs") and c["fillet"] > 0
    arm = next(c for c in g["children"] if c["_part"]["name"] == "arm-left")
    assert sh.shape_bounds(arm)["max"][1] == pytest.approx(0.68, abs=0.04)
    # 同一种面料：一个材质组
    assert {c["_part"].get("group") for c in g["children"]} == {"upholstery"}
    for c in g["children"]:
        c.pop("_part")
    sh.validate_shape(g)


# ---------------------------------------------------------------------------- 只看到两个面的高柜


def test_fit_faces_box_ignores_mirror_points():
    """高柜只扫到两个相邻的面（x = −0.6 朝 −x，z = 0.6 朝 +z），镜子的虚像点散在外面：
    盒子只按两个面定尺寸，没看到的两侧取看到的面沿边的范围。"""
    rng = np.random.default_rng(4)
    n = 4000
    f1 = np.c_[np.full(n, -0.6), rng.uniform(0, 2.3, n), rng.uniform(-0.8, 0.6, n)]
    f2 = np.c_[rng.uniform(-0.6, 1.0, n), rng.uniform(0, 2.3, n), np.full(n, 0.6)]
    ghost = np.c_[rng.uniform(-1.5, 0.5, 1500), rng.uniform(0, 1.0, 1500), rng.uniform(-1.5, 1.4, 1500)]
    P = np.concatenate([f1, f2, ghost])
    N = np.concatenate(
        [np.tile([-1.0, 0, 0], (n, 1)), np.tile([0, 0, 1.0], (n, 1)), rng.normal(size=(1500, 3))]
    )
    N /= np.linalg.norm(N, axis=1, keepdims=True)
    o = ft.Local(P, N, np.full((len(P), 3), 30, np.uint8))
    g = ft.fit_faces_box(o)
    assert g is not None
    box = g["children"][0]
    w, h, d = box["size"]
    x, _, z = box["transform"]["position"]
    assert x - w / 2 == pytest.approx(-0.6, abs=0.02) and x + w / 2 == pytest.approx(1.0, abs=0.04)
    assert z + d / 2 == pytest.approx(0.6, abs=0.02) and z - d / 2 == pytest.approx(-0.8, abs=0.04)
    assert h == pytest.approx(2.3, abs=0.05)


def test_fit_faces_box_needs_two_perpendicular_faces():
    """只有一个面（贴墙的薄板）或者太矮：不用这个拟合。"""
    rng = np.random.default_rng(5)
    P = np.c_[rng.uniform(-1, 1, 3000), rng.uniform(0, 2.2, 3000), np.zeros(3000)]
    N = np.tile([0, 0, 1.0], (3000, 1))
    assert ft.fit_faces_box(ft.Local(P, N, np.zeros((3000, 3), np.uint8))) is None
    P2 = P * [1, 0.4, 1]
    assert ft.fit_faces_box(ft.Local(P2, N, np.zeros((3000, 3), np.uint8))) is None


# ---------------------------------------------------------------------------- 端到端


def _scene(objects: list[tuple[dict, tuple[int, int, int]]]) -> ScanMesh:
    """房间 + 物体（SHAPES 形状，各自一种颜色）拼成一个带贴图的扫描网格。"""
    room = room_mesh(diagonal=False)
    H0, W = room.texture.shape[:2]
    tile = 32
    rows = math.ceil(len(objects) / (W // tile))
    tex = np.zeros((H0 + rows * tile, W, 3), np.uint8)
    tex[:H0] = room.texture
    V = [room.vertices]
    F = [room.faces]
    uv0 = room.uv.copy()
    uv0[:, 1] *= H0 / tex.shape[0]
    UV = [uv0]
    n = len(room.vertices)
    for k, (shape, color) in enumerate(objects):
        mesh = shape_mesh(shape)
        r, c = divmod(k, W // tile)
        tex[H0 + r * tile : H0 + (r + 1) * tile, c * tile : (c + 1) * tile] = color
        V.append(mesh.positions)
        F.append(mesh.indices + n)
        uv = np.tile(
            [(c * tile + tile / 2) / W, (H0 + r * tile + tile / 2) / tex.shape[0]], (len(mesh.positions), 1)
        )
        UV.append(uv)
        n += len(mesh.positions)
    return ScanMesh(np.concatenate(V), np.concatenate(F), np.concatenate(UV), tex)


@pytest.fixture(scope="module")
def scene_result():
    chair = chair_shape()
    objects = [
        (sh.group([table_shape()], xf=sh.transform(position=[1.5, 0, 1.6])), (180, 140, 100)),
        (sh.group([chair], xf=sh.transform(position=[1.5, 0, 0.75])), (60, 60, 70)),
        (sh.group([chair], xf=sh.transform(position=[1.5, 0, 2.45], yaw=180)), (60, 60, 70)),
        (sh.box([0.8, 1.0, 0.45], fillet=0.03, xf=sh.transform(position=[4.0, 0, 0.6])), (200, 200, 190)),
        (sh.cylinder(0.25, 0.5, segments=48, xf=sh.transform(position=[4.0, 0, 3.0])), (150, 90, 60)),
    ]
    mesh = _scene(objects)
    structure = extract_structure(mesh)
    return reconstruct_objects(mesh, structure)


def test_end_to_end_records_are_valid(scene_result):
    res = scene_result
    templates = {k: b["shape"] for k, b in res.entities.items() if b["kind"] == "template"}
    assert res.entities
    for eid, body in res.entities.items():
        assert body["entityId"] == eid
        assert body["layer"] == "rebuilt"
        assert body["kind"] in ("object", "template")
        validate_entity_body(body, templates)
        b = sh.shape_bounds(body["shape"], templates)
        assert all(body["bounds"]["min"][k] <= b["min"][k] + 1e-6 for k in range(3))
        assert all(body["bounds"]["max"][k] >= b["max"][k] - 1e-6 for k in range(3))
        # 生成的网格也落在包围盒里
        mesh = merge_meshes([p.mesh for p in build_parts(body["shape"], templates)])
        assert np.all(mesh.positions.min(0) >= np.array(body["bounds"]["min"]) - 1e-4)
        assert np.all(mesh.positions.max(0) <= np.array(body["bounds"]["max"]) + 1e-4)
        for t in body.get("textures", []):
            assert t in res.textures
    for h, data in res.textures.items():
        assert hashlib.sha256(data).hexdigest() == h
        assert data[:3] == b"\xff\xd8\xff"  # JPEG


def test_end_to_end_recognizes_and_fits(scene_result):
    res = scene_result
    objs = {k: b for k, b in res.entities.items() if b["kind"] == "object"}
    cats = sorted(b["props"]["category"] for b in objs.values())
    assert cats.count("chair") == 2, cats
    assert "table" in cats
    assert len(objs) == 5, cats
    # 同款的两把椅子合并成一个模板，各自用实例摆放（偏航是连续值）
    chairs = [b for b in objs.values() if b["props"]["category"] == "chair"]
    assert all(b["shape"]["type"] == "instance" for b in chairs)
    assert len({b["shape"]["template"] for b in chairs}) == 1
    yaws = sorted(((b["shape"]["transform"].get("yaw", 0.0)) % 360) for b in chairs)
    assert abs(((yaws[1] - yaws[0]) % 360) - 180) < 15
    for b in objs.values():
        assert b["fit"]["meanCm"] < 2.5, (b["entityId"], b["fit"])
    assert res.metrics["furnitureMeanCm"] < 2.5
    assert res.metrics["templates"] == 1


def test_clutter_and_small_cabinets_use_plain_colors():
    """杂物和最长边不到 0.8 米的小柜子只用纯色（贴上去的多半是反光和粘连进来的表面）；
    大柜子、边几（大理石台面是真的图案）照旧可以烘焙贴图。"""
    assert not _textured("clutter", 2.0)
    assert not _textured("cabinet", 0.6)
    assert _textured("cabinet", 1.2)
    assert _textured("table", 0.6)


def test_hints_override_kind_and_label():
    hints = parse_hints(
        {
            "objects": [
                {"center": [4.0, 0.5, 0.6], "label": "文件柜", "kind": "shelf", "size": [1, 1.1, 0.6]},
                {"center": "bad"},
                {"kind": "chair"},
            ]
        }
    )
    assert hints == [
        {"center": [4.0, 0.5, 0.6], "kind": "cabinet", "label": "文件柜", "size": [1.0, 1.1, 0.6]}
    ]
    mesh = _scene(
        [(sh.box([0.8, 1.0, 0.45], fillet=0.03, xf=sh.transform(position=[4.0, 0, 0.6])), (90, 120, 200))]
    )
    res = reconstruct_objects(mesh, extract_structure(mesh), params={"objects": hints})
    objs = [b for b in res.entities.values() if b["kind"] == "object"]
    assert len(objs) == 1
    assert objs[0]["label"] == "文件柜"
    assert objs[0]["props"]["category"] == "cabinet"
    assert objs[0]["props"]["source"] == "hint"
    color = objs[0]["shape"]["children"][0]["material"]
    assert "color" in color and np.allclose(color["color"], [90, 120, 200], atol=12)


def test_reconstruction_is_deterministic():
    """同一份扫描重跑，物件记录和贴图完全相同（内容哈希不变，重扫没有变化时不会产生新的提交内容）。"""
    shape = sh.box([0.9, 0.8, 0.5], fillet=0.04, xf=sh.transform(position=[2.5, 0, 2.0], yaw=20))
    mesh = _scene([(shape, (150, 100, 60))])
    structure = extract_structure(mesh)
    a = reconstruct_objects(mesh, structure)
    b = reconstruct_objects(mesh, structure)
    assert a.entities == b.entities
    assert a.textures.keys() == b.textures.keys()
