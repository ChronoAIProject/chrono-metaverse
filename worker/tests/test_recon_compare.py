"""重建工作台 compare：偏差数字、排除框、结构背景、形状和外部模型物件的校验（不渲染）。"""

from __future__ import annotations

import json

import pytest

from metaverse_worker.recon import compare as cp
from metaverse_worker.recon import models as md
from metaverse_worker.recon.cli import build_parser
from recon_support import box_planes, make_base, object_body
from synthetic import _Builder


def box_shape(lo, hi, color=(200, 60, 60)):
    size = [h - low for low, h in zip(lo, hi, strict=True)]
    return {
        "type": "box",
        "size": size,
        "transform": {"position": [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2]},
        "material": {"color": list(color)},
    }


@pytest.fixture
def base(tmp_path):
    b = _Builder()
    b.plane([-1, 0, -1], [0, 0, 4], [4, 0, 0], (150, 120, 90), cell=0.25)
    box_planes(b, [0.5, 0.0, 0.5], [1.5, 0.8, 1.1], (200, 60, 60))
    box_planes(b, [1.7, 0.0, 0.5], [1.9, 0.3, 0.7], (60, 60, 200))  # 旁边的小东西
    objs = {"box-01": object_body("box-01", [0.5, 0.0, 0.5], [1.4, 0.8, 1.1], "cabinet")}
    return make_base(tmp_path, b.build(), objs)


def run(tmp_path, base, model: dict, *extra):
    path = tmp_path / "model.json"
    path.write_text(json.dumps(model))
    out = tmp_path / "cmp"
    args = build_parser().parse_args(
        ["compare", "--base", str(base), "--model", str(path), "--out", str(out), "--no-render", *extra]
    )
    return cp.cmd_compare(args)


def test_exact_box_fits_and_shift_shows(tmp_path, base):
    good = {
        "entityId": "box-01",
        "layer": "rebuilt",
        "kind": "object",
        "shape": box_shape([0.5, 0, 0.5], [1.5, 0.8, 1.1]),
    }
    rng = ["--box", "0.45,0,0.45,1.55,0.85,1.15", "--base-id", "box-01"]
    res = run(tmp_path, base, good, *rng)
    assert res["validation"][0]["ok"]
    assert res["new"]["scanToModel"]["meanCm"] < 0.5
    assert res["new"]["scanToModel"]["coverage3cm"] > 0.98
    # 现有算法的盒子短了 10 厘米：偏差更大；新模型没有漏建
    assert res["base"]["scanToModel"]["meanCm"] > res["new"]["scanToModel"]["meanCm"]
    assert res["missingFromNew"] == []
    assert not res["rendered"] and (tmp_path / "cmp" / "compare_error.jpg").exists()
    # 逐件的写回 fit（与处理服务写进记录的同一个函数）：新模型几乎为零，现有算法短了 10 厘米
    new_fit, base_fit = res["new"]["entities"]["box-01"]["fit"], res["base"]["entities"]["box-01"]["fit"]
    assert new_fit["meanCm"] < 0.3 and new_fit["coverage3cm"] > 0.98
    assert base_fit["meanCm"] > new_fit["meanCm"] and res["new"]["entities"]["box-01"]["fitPoints"] > 1000

    shifted = {**good, "shape": box_shape([0.55, 0, 0.5], [1.55, 0.8, 1.1])}
    res2 = run(tmp_path, base, shifted, *rng)
    assert res2["new"]["scanToModel"]["meanCm"] > res["new"]["scanToModel"]["meanCm"] + 0.3
    assert res2["missingFromNew"] == [] or res2["missingFromNew"][0]["meanDistCm"] < 6


def test_exclude_removes_neighbour_points(tmp_path, base):
    body = {"entityId": "box-01", "shape": box_shape([0.5, 0, 0.5], [1.5, 0.8, 1.1])}
    wide = "0.4,0,0.4,2.0,0.9,1.2"
    a = run(tmp_path, base, body, "--box", wide, "--base-id", "box-01")
    b = run(tmp_path, base, body, "--box", wide, "--base-id", "box-01", "--exclude", "1.6,0,0.4,2.0,0.5,0.8")
    assert b["scanPoints"] < a["scanPoints"]
    assert b["new"]["scanToModel"]["meanCm"] < a["new"]["scanToModel"]["meanCm"]
    assert any(m["max"][0] > 1.6 for m in a["missingFromNew"])  # 没排除时，旁边的小盒子是"漏建"
    # 写回的 fit 不看 --box、--exclude（处理服务写回时也不知道这些框）
    assert a["new"]["entities"]["box-01"]["fit"] == b["new"]["entities"]["box-01"]["fit"]
    assert "layer" in a["validation"][0]["filled"]  # 缺的字段按默认补上并提示


def test_scene_mode_per_entity_and_plate(tmp_path, base):
    top = {
        "type": "plate",
        "points": [[0.5, 0.8, 1.1], [1.5, 0.8, 1.1], [1.5, 0.8, 0.5], [0.5, 0.8, 0.5]],
        "thickness": 0.8,
        "material": {"color": [200, 60, 60], "opacity": 0.9},
    }
    model = {
        "version": 1,
        "templates": [],
        "entities": [
            {"entityId": "box-01", "layer": "rebuilt", "kind": "object", "shape": top},
            {
                "entityId": "small",
                "layer": "rebuilt",
                "kind": "object",
                "shape": box_shape([1.7, 0, 0.5], [1.9, 0.3, 0.7]),
            },
        ],
        "structure": "keep",
    }
    res = run(tmp_path, base, model, "--scene")
    checks = {c["entityId"]: c for c in res["validation"]}
    assert checks["box-01"]["ok"] and checks["box-01"]["uses"] == ["opacity", "plate"]
    assert checks["box-01"]["computedBounds"]["min"][1] == pytest.approx(0.0, abs=1e-4)
    assert set(res["new"]["entities"]) == {"box-01", "small"}
    assert res["new"]["scanToModel"]["meanCm"] < 0.5
    assert res["baseIds"] == ["box-01"]


def test_invalid_shape_is_reported(tmp_path, base):
    bad = {
        "entityId": "box-01",
        "shape": {
            "type": "plate",
            "points": [[0, 0, 0], [1, 0, 0], [1, 0.1, 1], [0, 0, 1]],
            "thickness": 0.05,
        },
    }
    res = run(tmp_path, base, bad, "--object", "box-01")
    assert not res["validation"][0]["ok"] and "平面" in res["validation"][0]["errors"][0]


def model_body(**over):
    body = {
        "entityId": "sofa-01",
        "layer": "rebuilt",
        "kind": "object",
        "model": {
            "url": "https://dl.polyhaven.org/file/x.gltf",
            "sha256": "a" * 64,
            "size": 10,
            "format": "gltf",
            "files": {"x.bin": {"url": "https://dl.polyhaven.org/file/x.bin", "sha256": "b" * 64, "size": 5}},
        },
        "transform": {"position": [0, 0, 0], "yaw": 10, "scale": [1, 1, 1]},
        "bounds": {"min": [0, 0, 0], "max": [1, 1, 1]},
        "props": {
            "source": {
                "library": "polyhaven",
                "id": "x",
                "page": "https://polyhaven.com/a/x",
                "author": "a",
                "license": "CC0-1.0",
                "title": "X",
            }
        },
    }
    body.update(over)
    return body


@pytest.mark.parametrize(
    ("over", "message"),
    [
        ({}, None),
        (
            {
                "model": {
                    "url": "http://dl.polyhaven.org/x.glb",
                    "sha256": "a" * 64,
                    "size": 1,
                    "format": "glb",
                }
            },
            "https",
        ),
        (
            {"model": {"url": "https://evil.example/x.glb", "sha256": "a" * 64, "size": 1, "format": "glb"}},
            "主机",
        ),
        (
            {"model": {"url": "https://huggingface.co/x.glb", "sha256": "xyz", "size": 1, "format": "glb"}},
            "sha256",
        ),
        (
            {
                "model": {
                    "url": "https://huggingface.co/x.glb",
                    "sha256": "a" * 64,
                    "size": 0,
                    "format": "glb",
                }
            },
            "size",
        ),
        (
            {
                "model": {
                    "url": "https://huggingface.co/x.glb",
                    "sha256": "a" * 64,
                    "size": 1,
                    "format": "fbx",
                }
            },
            "format",
        ),
        (
            {
                "model": {
                    "url": "https://huggingface.co/x.gltf",
                    "sha256": "a" * 64,
                    "size": 1,
                    "format": "gltf",
                }
            },
            "files",
        ),
        ({"transform": {"yaw": "x"}}, "transform"),
        ({"material": {"tint": [300, 0, 0]}}, "tint"),
        ({"material": {"color": [1, 2, 3]}}, "material"),
        ({"material": {"tint": [1, 2, 3], "opacity": 0.5, "unlit": True}}, None),
        ({"material": {"opacity": 2}}, "opacity"),
        ({"assetHash": "c" * 64}, "assetHash"),
        ({"props": {}}, "props.source"),
        (
            {
                "model": {
                    "url": "https://dl.polyhaven.org/file/x.gltf",
                    "sha256": "a" * 64,
                    "size": 10,
                    "format": "gltf",
                    "files": {"x.bin": {"url": "https://evil.example/x.bin", "sha256": "b" * 64, "size": 5}},
                }
            },
            "主机",
        ),
        (
            {
                "props": {
                    "source": {
                        "library": "objaverse",
                        "id": "u",
                        "page": "https://sketchfab.com/u",
                        "author": "a",
                        "license": "CC-BY-NC-4.0",
                        "title": "t",
                    }
                }
            },
            "许可",
        ),
        (
            {
                "props": {
                    "source": {
                        "library": "turbosquid",
                        "id": "u",
                        "page": "https://x.com",
                        "author": "a",
                        "license": "CC0-1.0",
                        "title": "t",
                    }
                }
            },
            "library",
        ),
    ],
)
def test_model_entity_checks(over, message):
    errors, _ = md.check_model_entity(model_body(**over))
    if message is None:
        assert errors == []
    else:
        assert any(message in e for e in errors), errors


def test_missing_clusters_groups_far_points():
    import numpy as np

    rng = np.random.default_rng(0)
    near = rng.uniform(0, 1, (500, 3))
    blob = rng.uniform(0, 0.2, (200, 3)) + np.array([3, 0, 0])
    P = np.vstack([near, blob])
    d = np.r_[np.full(500, 0.01), np.full(200, 0.2)]
    out = cp.missing_clusters(P, d)
    assert len(out) == 1 and out[0]["points"] == 200 and out[0]["min"][0] >= 3
