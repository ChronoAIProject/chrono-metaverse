"""前台多面体拟合：合成数据上恢复轮廓、外壳折面、台面和工作台面。"""

from __future__ import annotations

import numpy as np
import pytest

from metaverse_worker import shapes as sh
from metaverse_worker.processing import fit_counter as fc
from metaverse_worker.processing import fit_templates as ft
from test_objects import sample_shape

# ---------------------------------------------------------------------------- 规整多边形


def test_regular_polygon_snaps_l_shape():
    """带噪声、角上圆滑的 L 形轮廓 → 6 个顶点，直边取正，角点落在真实角点上。"""
    corners = np.array([(0, 0), (2, 0), (2, 1), (1, 1), (1, 2), (0, 2)], float)
    pts = []
    for a, b in zip(corners, np.roll(corners, -1, axis=0), strict=True):
        t = np.linspace(0, 1, 80, endpoint=False)[:, None]
        pts.append(a + t * (b - a))
    contour = np.concatenate(pts)
    rng = np.random.default_rng(1)
    contour = contour + rng.normal(0, 0.004, contour.shape)
    poly = fc.regular_polygon(contour, 0.03)
    assert poly is not None and len(poly) == 6
    for c in corners:
        assert np.hypot(*(poly - c).T).min() < 0.02
    # 直边取正：每条边要么水平要么竖直
    d = np.roll(poly, -1, axis=0) - poly
    assert np.all(np.minimum(np.abs(d[:, 0]), np.abs(d[:, 1])) < 1e-9)


def test_regular_polygon_rejects_tiny_contour():
    assert fc.regular_polygon(np.array([(0, 0), (1, 0), (1, 1)], float), 0.02) is None


# ---------------------------------------------------------------------------- 剖面和相似变换


def test_fit_profile_finds_crease():
    """折面立面：0–0.5 米外扩 8 厘米，0.5–1.1 米收回 10 厘米 → 三点折线，折点在 0.5 附近。"""
    rng = np.random.default_rng(2)
    y = rng.uniform(0, 1.1, 3000)
    s = np.where(y < 0.5, -0.08 + 0.16 * y, 0.0 - (y - 0.5) / 0.6 * 0.1) + rng.normal(0, 0.004, len(y))
    knots = fc.fit_profile(y, s, 0.0, 1.1)
    assert len(knots) == 3
    assert knots[1][0] == pytest.approx(0.5, abs=0.06)
    assert knots[1][1] == pytest.approx(0.0, abs=0.015)
    assert knots[0][1] == pytest.approx(-0.08, abs=0.015)
    assert knots[2][1] == pytest.approx(-0.1, abs=0.015)


def test_fit_profile_straight_face_stays_two_points():
    rng = np.random.default_rng(3)
    y = rng.uniform(0, 1.0, 2000)
    s = -0.05 * y + rng.normal(0, 0.003, len(y))
    assert len(fc.fit_profile(y, s, 0.0, 1.0)) == 2


def test_similarity_moves_three_faces_equally():
    """三条边（斜边、正面、侧面）的带：相似变换后三条边的直线都向外平移 s，截面形状相似（点一一对应）。"""
    poly = np.array([(-1.0, -1.0), (2.0, -1.0), (2.0, 1.0), (0.0, 1.0), (-1.0, 0.2)])
    edges = fc._edge_frame(poly)
    ids = [1, 2, 3]
    g = np.array([0.5, 0.0])
    for s in (-0.1, 0.07):
        lam, t = fc.similarity_for(edges, ids, g, s)
        for i in ids:
            e = edges[i]
            a2 = fc.transform_polygon(e.a[None], g, lam, t)[0]
            assert float((a2 - e.a) @ e.n) == pytest.approx(s, abs=1e-6)


# ---------------------------------------------------------------------------- 整个前台


def counter_shape() -> dict:
    """2 × 1.8 米的前台：右侧和后侧是 L 形外壳（厚 0.25，顶高 1.1），立面在 0.5 米处折一下
    （地面和顶上比轮廓收进 8 厘米）；里面一块 0.75 米高的工作台面。"""

    def section(s: float, y: float) -> dict:
        pts = [(1 + s, -0.9), (1 + s, 0.9 + s), (-1, 0.9 + s), (-1, 0.65), (0.75, 0.65), (0.75, -0.9)]
        return {"y": y, "outline": sh.outline(pts)}

    shell = {"type": "loft", "sections": [section(-0.08, 0.0), section(0.0, 0.5), section(-0.08, 1.1)]}
    desk = sh.extrude(
        sh.outline([(-1, -0.9), (0.76, -0.9), (0.76, 0.66), (-1, 0.66)]),
        0.03,
        xf=sh.transform(position=[0, 0.72, 0]),
    )
    return sh.group([shell, desk])


def test_fit_counter_recovers_creased_shell_and_desk():
    P, N = sample_shape(counter_shape(), 12_000)
    o = ft.Local(P, N, np.full((len(P), 3), 200, np.uint8))
    g = fc.fit_counter(o)
    assert g is not None
    parts = {c["_part"]["name"]: c for c in g["children"]}
    facade = parts["shell-1-facade"]
    assert facade["type"] == "loft"
    ys = [s["y"] for s in facade["sections"]]
    assert len(ys) == 3 and ys[1] == pytest.approx(0.5, abs=0.08)
    # 截面相似：折线处的截面比上下大一圈，点数相同
    sizes = [np.ptp(np.array(s["outline"]["points"]), axis=0).max() for s in facade["sections"]]
    assert sizes[1] > sizes[0] + 0.05 and sizes[1] > sizes[2] + 0.05
    assert len({len(s["outline"]["points"]) for s in facade["sections"]}) == 1
    top = parts["shell-1-top"]
    assert top["transform"]["position"][1] + top["height"] == pytest.approx(1.1, abs=0.03)
    assert top["_part"]["group"] == "shell" and top["_part"]["albedo"] == "bright"
    desk = parts["desk"]
    assert desk["transform"]["position"][1] + desk["height"] == pytest.approx(0.75, abs=0.02)
    for c in g["children"]:
        c.pop("_part")
    sh.validate_shape(g)


def test_fit_counter_without_shell_returns_none():
    """一块矮台子（没有高出台面的外壳）：量不出外壳，交给分层挤出。"""
    P, N = sample_shape(sh.box([2.0, 0.75, 0.8]), 8000)
    o = ft.Local(P, N, np.full((len(P), 3), 120, np.uint8))
    assert fc.fit_counter(o) is None
