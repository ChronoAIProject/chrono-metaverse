"""重建工作台 place：合成扫描里摆着一把已知偏航、位置的椅子，候选是同一把椅子但单位是厘米、+z 向上，
place 要还原向上轴、缩放、偏航、位置，输出合格的外部模型物件记录。"""

from __future__ import annotations

import json

import numpy as np
import pytest

from metaverse_recon.bench import models as md
from metaverse_recon.bench.cli import build_parser
from metaverse_recon.bench.library import place as pl
from recon_support import chair_mesh_raw, chair_scene, make_base, object_body, write_candidate

YAW, POS = 30.0, (2.0, 0.0, 3.0)


@pytest.fixture
def setup(tmp_path):
    scan = chair_scene(YAW, POS)
    base = make_base(tmp_path, scan, {"chair-01": object_body("chair-01", [1.6, 0.0, 2.6], [2.4, 0.98, 3.4])})
    V, F = chair_mesh_raw(scale=100.0, up="+z")
    side = write_candidate(tmp_path, V, F)
    return base, side


def test_kabsch_yaw_recovers_rotation():
    rng = np.random.default_rng(0)
    src = rng.uniform(-1, 1, (200, 3))
    dst = src @ pl.ry(25).T + np.array([0.3, 0, -0.2])
    yaw, t = pl.kabsch_yaw(src, dst)
    assert yaw == pytest.approx(25, abs=1e-6) and t == pytest.approx([0.3, 0, -0.2], abs=1e-9)


def test_up_rotations_map_axis_to_y():
    for up, axis in {
        "+y": [0, 1, 0],
        "+z": [0, 0, 1],
        "-z": [0, 0, -1],
        "+x": [1, 0, 0],
        "-x": [-1, 0, 0],
        "-y": [0, -1, 0],
    }.items():
        assert pl.up_rotation(up) @ np.array(axis, float) == pytest.approx([0, 1, 0], abs=1e-9)
    assert pl.raw_scale(pl.up_rotation("+z"), np.array([1.0, 2.0, 3.0])) == [1.0, 3.0, 2.0]


def test_tint_only_darkens():
    tint = pl.tint_suggestion(np.array([100, 80, 60]), np.array([200, 200, 200]))
    assert all(0 <= c <= 255 for c in tint["tint"]) and tint["note"] is None
    near = pl.tint_suggestion(np.array([120, 110, 100]), np.array([110, 110, 110]))
    assert max(near["tint"]) == 255 and "色相" in near["note"]
    dark = pl.tint_suggestion(np.array([200, 200, 200]), np.array([50, 50, 50]))
    assert dark["tint"] is None and "换颜色" in dark["note"]


def test_place_recovers_pose_scale_and_up(tmp_path, setup):
    base, side = setup
    out = tmp_path / "place"
    args = build_parser().parse_args(
        [
            "place",
            "--base",
            str(base),
            "--object",
            "chair-01",
            "--candidate",
            str(side),
            "--out",
            str(out),
            "--no-render",
            "--yaw-steps",
            "12",
            "--tint",
        ]
    )
    rep = pl.cmd_place(args)
    body = json.loads((out / "entity.json").read_text())
    xf = body["transform"]
    assert rep["chosen"]["up"] == "+z"
    assert xf["pitch"] == -90 and xf["roll"] == 0
    assert ((xf["yaw"] - YAW + 180) % 360) - 180 == pytest.approx(0, abs=2.0)
    assert xf["scale"] == pytest.approx([0.01, 0.01, 0.01], rel=0.03)
    assert xf["position"][0] == pytest.approx(POS[0], abs=0.03) and xf["position"][2] == pytest.approx(
        POS[2], abs=0.03
    )
    assert xf["position"][1] == pytest.approx(0.0, abs=0.01)  # 落地
    assert body["fit"]["meanCm"] < 1.5
    # 外部模型物件记录：模型来源、署名、包围盒、tint；和 compare 的校验规则一致
    assert body["model"]["format"] == "glb" and body["props"]["source"]["license"] == "CC-BY-4.0"
    assert body["props"]["category"] == "chair" and body["label"] == "椅子"
    assert set(body["material"]) == {"tint"}
    errors, _ = md.check_model_entity(body)
    assert errors == []
    m = md.load_model_file(str(side.parent / "model.glb"))
    assert md.world_bounds(body, m) == body["bounds"]
    assert body["bounds"]["max"][1] == pytest.approx(0.98, abs=0.02)


def test_place_axis_scale_is_limited(tmp_path, setup):
    base, _ = setup
    V, F = chair_mesh_raw(scale=100.0, up="+z")
    V = V * np.array([1.4, 1.0, 1.0])  # 模型比扫描宽 40%：逐轴缩放只能修正到 ±15%
    side = write_candidate(tmp_path / "wide", V, F)
    out = tmp_path / "place-axis"
    args = build_parser().parse_args(
        [
            "place",
            "--base",
            str(base),
            "--object",
            "chair-01",
            "--candidate",
            str(side),
            "--out",
            str(out),
            "--no-render",
            "--up",
            "+z",
            "--yaw",
            "30",
            "--scale",
            "axis",
        ]
    )
    pl.cmd_place(args)
    xf = json.loads((out / "entity.json").read_text())["transform"]
    s = np.array(xf["scale"])
    assert s[0] < s[1]  # 宽度方向缩得更多
    assert s.max() / s.min() <= 1.15 / 0.85 + 1e-6
