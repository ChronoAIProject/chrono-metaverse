"""重建工作台 measure：合成网格上的平面拟合、截面、高度图、外接框。"""

from __future__ import annotations

import json

import numpy as np
import pytest

from metaverse_worker.recon import measure as ms
from metaverse_worker.recon.cli import build_parser
from recon_support import box_planes, make_base, object_body
from synthetic import _Builder


def test_fit_plane_slope_azimuth_and_corners():
    rng = np.random.default_rng(0)
    # 坡度 30°、法向朝 +x 的斜面，加 3 毫米噪声
    u = rng.uniform(-0.5, 0.5, (2000, 2))
    n = np.array([np.sin(np.radians(30)), np.cos(np.radians(30)), 0])
    a = np.array([np.cos(np.radians(30)), -np.sin(np.radians(30)), 0])
    P = u[:, :1] * a + u[:, 1:] * np.array([0, 0, 1.0]) + rng.normal(0, 0.003, (2000, 1)) * n
    fit = ms.fit_plane(P)
    assert fit["slopeDeg"] == pytest.approx(30, abs=0.5)
    assert fit["azimuthDeg"] == pytest.approx(90, abs=0.5)  # 法向水平分量朝 +x = SHAPES 偏航 90
    assert fit["rmsCm"] < 0.5
    corners = np.array(fit["rectCorners"])
    # 角点从法向一侧看逆时针：右手定则给出的法向与拟合的法向同向
    assert np.cross(corners[1] - corners[0], corners[2] - corners[0]) @ np.array(fit["normal"]) > 0
    assert fit["extent"][0] * fit["extent"][1] == pytest.approx(1.0, rel=0.05)


def test_fit_plane_ignores_a_second_surface():
    rng = np.random.default_rng(1)
    top = np.c_[rng.uniform(0, 1, 1500), np.full(1500, 0.8), rng.uniform(0, 1, 1500)]
    side = np.c_[np.full(500, 1.0), rng.uniform(0, 0.8, 500), rng.uniform(0, 1, 500)]
    fit = ms.fit_plane(np.vstack([top, side]))
    assert fit["slopeDeg"] < 0.5 and fit["inlierShare"] == pytest.approx(0.75, abs=0.02)


def test_heightmap_table():
    P = np.array(
        [[0.02, 0.5, 0.02], [0.02, 0.7, 0.02], [0.12, 0.3, 0.02], [0.02, 0.4, 0.12], [0.19, 0.1, 0.19]]
    )
    hm = ms.heightmap_table(P, 0.0, 1.0, [0, 0, 0.2, 0.2], 0.1, "top")
    assert hm["cols"] == 2 and hm["rows"] == 2
    assert hm["heights"] == [[0.7, 0.3], [0.4, 0.1]]
    low = ms.heightmap_table(P, 0.0, 1.0, [0, 0, 0.2, 0.2], 0.1, "bottom")
    assert low["heights"][0][0] == 0.5
    big = ms.heightmap_table(
        np.c_[np.linspace(0, 10, 50), np.ones(50), np.zeros(50)], 0, 2, None, 0.05, "top"
    )
    assert big["cols"] <= 48 and "自动放大" in big["note"]


def scene(tmp_path):
    b = _Builder()
    b.plane([-1, 0, -1], [0, 0, 4], [4, 0, 0], (150, 120, 90), cell=0.25)
    box_planes(b, [0.5, 0.0, 0.5], [1.5, 0.8, 1.1], (200, 60, 60))
    base = make_base(
        tmp_path, b.build(), {"box-01": object_body("box-01", [0.5, 0.0, 0.5], [1.5, 0.8, 1.1], "cabinet")}
    )
    return base


def test_cmd_measure_on_box(tmp_path, capsys):
    base = scene(tmp_path)
    out = tmp_path / "m" / "m.json"
    args = build_parser().parse_args(
        [
            "measure",
            "--base",
            str(base),
            "--object",
            "box-01",
            "--out",
            str(out),
            "--plane",
            "top=0.5,0.7,0.5,1.5,0.9,1.1",
            "--heightmap",
            "0.1:1.0",
            "--hm-cell",
            "0.25",
            "--vslice",
            "x=1.0",
            "--color",
            "c=0.5,0,0.5,1.5,0.8,1.1",
        ]
    )
    res = ms.cmd_measure(args)
    data = json.loads(out.read_text())
    assert data["bbox"]["size"][0] == pytest.approx(1.0, abs=0.02)
    assert data["bbox"]["max"][1] == pytest.approx(0.8, abs=0.01)
    rect = data["minRect"]["hull"]
    assert sorted(rect["size"]) == pytest.approx([0.6, 1.0], abs=0.02)
    top = data["planes"][0]
    assert top["slopeDeg"] < 0.5 and top["centroid"][1] == pytest.approx(0.8, abs=0.005)
    # 水平截面：盒子的外轮廓（填充后面积约 1.0 × 0.6）
    assert any(f["area"] == pytest.approx(0.6, rel=0.08) for s in data["hslices"] for f in s["footprint"])
    # 竖直截面 x=1.0：交线顶点落在 z 0.5–1.1、y ≤ 0.8
    pts = np.array([p for c in data["vslices"][0]["chains"] for p in c["points"]])
    assert pts[:, 0].min() == pytest.approx(0.5, abs=0.01) and pts[:, 1].max() == pytest.approx(0.8, abs=0.01)
    hm = data["heightmaps"][0]
    filled = [v for row in hm["heights"] for v in row if v is not None]
    assert max(filled) == pytest.approx(0.8, abs=0.01)
    assert data["colors"]["boxes"][0]["median"][0] > 150
    assert res["points"] > 1000 and "高度图" in capsys.readouterr().out


def test_cmd_measure_exclude_and_frame(tmp_path):
    base = scene(tmp_path)
    out = tmp_path / "m2" / "m.json"
    args = build_parser().parse_args(
        [
            "measure",
            "--base",
            str(base),
            "--object",
            "box-01",
            "--out",
            str(out),
            "--exclude",
            "1.0,0,0,2,1,2",
            "--frame",
            "0.5,0,0.5,0",
        ]
    )
    data = ms.cmd_measure(args)
    # 排除了 x ≥ 1.0 的一半；局部坐标原点在盒子的一角
    assert data["bbox"]["max"][0] == pytest.approx(0.5, abs=0.02)
    assert data["bbox"]["min"][0] == pytest.approx(0.0, abs=0.02)
