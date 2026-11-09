"""重建工作台的渲染（views、compare 并排图、place 对比图）。没有 node / three / Playwright / Chromium
时跳过。"""

from __future__ import annotations

import json

import pytest
from PIL import Image

from metaverse_worker.recon import compare as cp
from metaverse_worker.recon import env
from metaverse_worker.recon import views as vw
from metaverse_worker.recon.cli import build_parser, main
from metaverse_worker.recon.library import place as pl
from metaverse_worker.recon.render import available
from recon_support import chair_mesh_raw, chair_scene, make_base, object_body, write_candidate

pytestmark = pytest.mark.skipif(not available(), reason="没有渲染工具（metaverse-recon doctor 查看缺什么）")


@pytest.fixture
def base(tmp_path):
    return make_base(
        tmp_path,
        chair_scene(30.0, (2.0, 0.0, 3.0)),
        {"chair-01": object_body("chair-01", [1.6, 0.0, 2.6], [2.4, 0.98, 3.4])},
    )


def test_views_writes_images_and_pixel_mapping(tmp_path, base):
    out = tmp_path / "views"
    args = build_parser().parse_args(
        [
            "views",
            "--base",
            str(base),
            "--object",
            "chair-01",
            "--out",
            str(out),
            "--only",
            "front,top",
            "--cam",
            "low:200,15",
            "--size",
            "480x360",
        ]
    )
    summary = vw.cmd_views(args)
    names = [v["name"] for v in summary["views"]]
    assert names == ["front", "top", "low"]
    for v in summary["views"]:
        with Image.open(v["file"]) as im:
            assert im.size == (480, 360)
    front = summary["views"][0]["pixelToWorld"]
    assert front["pxx"]["axis"] == "X" and front["pxy"]["axis"] == "Y" and front["pxy"]["perPixel"] < 0
    assert not (out / "_scan_crop.glb").exists()


def test_compare_and_place_render_sheets(tmp_path, base):
    shape = {
        "entityId": "chair-01",
        "layer": "rebuilt",
        "kind": "object",
        "shape": {
            "type": "group",
            "transform": {"position": [2, 0, 3], "yaw": 30},
            "children": [
                {
                    "type": "box",
                    "size": [0.5, 0.08, 0.5],
                    "transform": {"position": [0, 0.45, 0]},
                    "material": {"color": [190, 160, 120], "opacity": 0.6},
                },
                {
                    "type": "hull",
                    "points": [
                        [-0.25, 0.53, -0.25],
                        [0.25, 0.53, -0.25],
                        [-0.25, 0.98, -0.25],
                        [0.25, 0.98, -0.25],
                        [0, 0.75, -0.19],
                    ],
                },
            ],
        },
    }
    model = tmp_path / "m.json"
    model.write_text(json.dumps(shape))
    out = tmp_path / "cmp"
    args = build_parser().parse_args(
        [
            "compare",
            "--base",
            str(base),
            "--model",
            str(model),
            "--out",
            str(out),
            "--color-parts",
            "--cell",
            "320x240",
        ]
    )
    res = cp.cmd_compare(args)
    assert res["rendered"]
    with Image.open(res["images"]["compare"]) as im:
        assert im.size[0] == 3 * 324 + 4
    V, F = chair_mesh_raw()
    side = write_candidate(tmp_path, V, F)
    pargs = build_parser().parse_args(
        [
            "place",
            "--base",
            str(base),
            "--object",
            "chair-01",
            "--candidate",
            str(side),
            "--out",
            str(tmp_path / "place"),
            "--up",
            "+z",
            "--yaw",
            "30",
            "--cell",
            "320x240",
        ]
    )
    rep = pl.cmd_place(pargs)
    assert set(rep["images"]) == {"place", "error"}
    with Image.open(rep["images"]["place"]) as im:
        assert im.size[0] == 2 * 324 + 4


def test_doctor_reports_tools(capsys):
    assert main(["doctor"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["render"] == "可用" and data["three"] == env.find_three()
