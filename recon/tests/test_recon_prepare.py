"""重建工作台 prepare 与本地重建编排（`bundle.rebuild`）坐标、物件一致；reframe 在两种对齐之间换算。"""

from __future__ import annotations

import json
import math
import os

import numpy as np
import pytest

from conftest import jpeg_bytes, scan_zip
from metaverse_recon.bench import core as wc
from metaverse_recon.bench import reframe as rf
from metaverse_recon.bench.cli import build_parser
from metaverse_recon.bench.prepare import candidate_list, cmd_prepare
from metaverse_recon.bundle.rebuild import rebuild_scan
from metaverse_recon.processing import limits as lim
from metaverse_recon.processing import tasks
from metaverse_recon.processing.align import auto_align
from metaverse_recon.processing.limits import default_limits
from metaverse_recon.processing.scan import compute_alignment, rotation_y
from recon_support import object_body
from synthetic import room_mesh

FAKE = "fake_objects:reconstruct_objects"


def tilted_room():
    """扫描坐标里的房间：绕竖直轴转 25°、平移，地面略倾斜（两种对齐就会不一样）。"""
    mesh = room_mesh()
    tilt = math.radians(0.4)
    rx = np.array([[1, 0, 0], [0, math.cos(tilt), -math.sin(tilt)], [0, math.sin(tilt), math.cos(tilt)]])
    rot = rotation_y(math.radians(25)) @ rx
    mesh.vertices = mesh.vertices @ rot.T + np.array([1.3, -0.7, 2.1])
    return mesh


@pytest.fixture
def scan_file(tmp_path):
    path = tmp_path / "scan.zip"
    path.write_bytes(scan_zip(tilted_room()))
    return path


def prepare(tmp_path, scan, *extra):
    out = tmp_path / "base"
    args = build_parser().parse_args(
        ["prepare", "--scan", str(scan), "--out", str(out), "--objects-target", FAKE, *extra]
    )
    cmd_prepare(args)
    return out


def test_prepare_matches_scan_task_and_auto_align(tmp_path, scan_file):
    out = prepare(tmp_path, scan_file)
    transform = json.loads((out / "transform.json").read_text())
    work = tmp_path / "work"
    res = tasks.scan_task(
        scan_path=str(scan_file),
        workdir=str(work),
        limits=default_limits(),
        web_models=False,
        do_rebuild=True,
        objects_target=FAKE,
    )
    assert transform["transform"] == res["transform"]
    mesh = tasks.read_scan(str(scan_file), str(tmp_path / "w2"), default_limits())
    assert transform["transform"] == auto_align(mesh).column_major()
    structure = json.loads((out / "structure.json").read_text())
    objects = json.loads((out / "objects.json").read_text())
    assert set(structure) == set(res["rebuild"]["structureIds"])
    assert set(objects) == set(res["rebuild"]["entities"]) - set(structure)
    # 对齐后的扫描 = 原始扫描 × 变换
    scan = wc.load_scan(str(out / "scan.glb"))
    M = np.array(transform["transform"]).reshape(4, 4).T
    assert np.allclose(scan.V, mesh.vertices @ M[:3, :3].T + M[:3, 3], atol=1e-4)
    cands = json.loads((out / "candidates.json").read_text())["objects"]
    assert {c["id"] for c in cands} == {k for k, b in objects.items() if b["kind"] == "object"}
    chairs = [c for c in cands if c["category"] == "chair"]
    assert chairs and all(c["suggest"] == "search" and c["sameAs"] for c in chairs)
    manifest = json.loads((out / "base.json").read_text())
    assert manifest["source"]["processedAs"] == "zip" or manifest["source"]["processedAs"]


def test_candidates_show_detection_source_for_new_and_old_records():
    """候选清单列出识别来源：新数据读 props.detectedBy，旧数据读字符串 props.source；署名对象不算。"""
    objs = {
        "chair-01": object_body("chair-01", [0, 0, 0], [0.5, 0.9, 0.5]),
        "table-01": object_body("table-01", [1, 0, 0], [2.6, 0.75, 0.8], "table", "会议桌"),
        "sofa-01": object_body("sofa-01", [3, 0, 0], [4.8, 0.8, 0.9], "sofa", "沙发"),
    }
    objs["chair-01"]["props"]["detectedBy"] = "hint"
    objs["table-01"]["props"]["source"] = "rules"  # 旧数据
    objs["sofa-01"]["props"]["source"] = {"library": "polyhaven", "id": "x"}  # 署名，不是识别来源
    got = {c["id"]: c["detectedBy"] for c in candidate_list(objs, {})}
    assert got == {"chair-01": "hint", "table-01": "rules", "sofa-01": None}


def test_prepare_drc_with_texture_is_zipped_like_the_seed(tmp_path):
    import DracoPy

    mesh = tilted_room()
    drc = tmp_path / "mesh.drc"
    drc.write_bytes(
        DracoPy.encode(
            np.asarray(mesh.vertices, np.float32),
            np.asarray(mesh.faces, np.uint32),
            quantization_bits=16,
            tex_coord=np.asarray(mesh.uv, np.float64),
            preserve_order=True,
        )
    )
    tex = tmp_path / "tex.jpg"
    tex.write_bytes(jpeg_bytes(mesh.texture))
    out = prepare(tmp_path, drc, "--texture", str(tex))
    manifest = json.loads((out / "base.json").read_text())
    assert manifest["source"]["processedAs"] == "zip"
    assert wc.load_scan(str(out / "scan.glb")).image is not None


def test_prepare_matches_the_local_rebuild(tmp_path, scan_file):
    """本地重建编排（原来处理服务首次导入扫描的那条路径）得到的变换和重建层物件，与 prepare 完全一致。"""
    res = rebuild_scan(str(scan_file), str(tmp_path / "work"), objects_target=FAKE, web_models=False)
    out = prepare(tmp_path, scan_file)
    transform = json.loads((out / "transform.json").read_text())
    assert res["transform"] == transform["transform"]
    structure = json.loads((out / "structure.json").read_text())
    objects = json.loads((out / "objects.json").read_text())
    assert {k: v for k, v in res["entities"].items() if k in res["structureIds"]} == structure
    assert {k: v for k, v in res["entities"].items() if k not in res["structureIds"]} == objects


def test_default_limits_keep_the_old_service_defaults():
    """解析上限从处理服务的配置搬到 processing.limits，数值不变（同一份扫描算出同样的结果）。"""
    assert default_limits() == {
        "max_scan_bytes": 1 << 30,
        "max_zip_bytes": 2 << 30,
        "max_triangles": 5_000_000,
        "max_texture_pixels": 8192 * 8192,
        "max_texture_side": 8192,
        "max_grid_cells": 400_000_000,
        "max_ops_bytes": 256 << 20,
        "max_model_bytes": 50 << 20,
        "model_max_triangles": 100_000,
        "model_max_texture_side": 2048,
        "model_max_texture_pixels": 4 * 2048 * 2048,
    }
    first = default_limits()
    first["max_triangles"] = 1
    assert default_limits()["max_triangles"] == lim.MAX_TRIANGLES == 5_000_000


def test_reframe_compute_to_scan_import(tmp_path, scan_file):
    mesh = tasks.read_scan(str(scan_file), str(tmp_path / "w"), default_limits())
    M_c = compute_alignment(mesh.vertices, mesh.faces).matrix
    M_a = auto_align(mesh).matrix
    C = M_a @ np.linalg.inv(M_c)
    body = {
        "entityId": "b",
        "layer": "rebuilt",
        "kind": "object",
        "shape": {"type": "box", "size": [1, 1, 1], "transform": {"position": [2, 0, 1], "yaw": 10}},
    }
    src = tmp_path / "in.json"
    src.write_text(json.dumps([body]))
    out = tmp_path / "out.json"
    args = build_parser().parse_args(
        [
            "reframe",
            "--scan",
            str(scan_file),
            "--from",
            "compute",
            "--to",
            "scan_import",
            "--in",
            str(src),
            "--out",
            str(out),
            "--max-tilt",
            "0",
        ]
    )
    res = rf.cmd_reframe(args)
    assert res["change"]["tiltDeg"] > 0.3
    new = json.loads(out.read_text())[0]
    xf = new["shape"]["transform"]
    # 精确合成：新的变换 = C · 旧的变换
    from metaverse_recon.processing.shape_mesh import transform_matrix

    expect = C @ transform_matrix(body["shape"]["transform"])
    assert np.allclose(transform_matrix(xf), expect, atol=1e-4)
    assert new["bounds"]["min"][1] == pytest.approx(
        min((expect @ [x, y, z, 1])[1] for x in (-0.5, 0.5) for y in (0, 1) for z in (-0.5, 0.5)), abs=1e-3
    )
    # 倾斜在 --max-tilt 以内：只改偏航和位置
    args2 = build_parser().parse_args(
        [
            "reframe",
            "--scan",
            str(scan_file),
            "--in",
            str(src),
            "--out",
            str(tmp_path / "o2.json"),
            "--max-tilt",
            "5",
        ]
    )
    rf.cmd_reframe(args2)
    xf2 = json.loads((tmp_path / "o2.json").read_text())[0]["shape"]["transform"]
    assert set(xf2) == {"position", "yaw"}
    assert xf2["position"] == pytest.approx(list((C @ [2, 0, 1, 1])[:3]), abs=1e-4)


def test_euler_yxz_roundtrip():
    from metaverse_recon.processing.shape_mesh import transform_matrix

    for yaw, pitch, roll in ((30, 10, -5), (-120, 0, 0), (0, -90, 0), (45, 20, 170)):
        R = transform_matrix({"yaw": yaw, "pitch": pitch, "roll": roll})[:3, :3]
        y, p, r = rf.euler_yxz(R)
        assert np.allclose(transform_matrix({"yaw": y, "pitch": p, "roll": r})[:3, :3], R, atol=1e-9)


def test_reframe_many_files_with_the_same_name_do_not_overwrite(tmp_path, scan_file):
    """`--in models/*/model.json --out 目录`：同名文件按上一级目录分开放。"""
    paths = []
    for name, x in (("counter-01", 1.0), ("sofa-01", 3.0)):
        body = {
            "entityId": name,
            "layer": "rebuilt",
            "kind": "object",
            "shape": {"type": "box", "size": [1, 1, 1], "transform": {"position": [x, 0, 1]}},
        }
        d = tmp_path / "models" / name
        d.mkdir(parents=True)
        (d / "model.json").write_text(json.dumps(body))
        paths.append(str(d / "model.json"))
    out = tmp_path / "out"
    args = build_parser().parse_args(
        ["reframe", "--scan", str(scan_file), "--from", "compute", "--in", *paths, "--out", str(out)]
    )
    res = rf.cmd_reframe(args)
    assert sorted(os.path.relpath(p, out) for p in res["outputs"]) == [
        "counter-01/model.json",
        "sofa-01/model.json",
    ]
    assert json.loads((out / "sofa-01" / "model.json").read_text())["entityId"] == "sofa-01"
