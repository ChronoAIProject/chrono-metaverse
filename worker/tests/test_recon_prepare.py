"""重建工作台 prepare 与处理服务 scan_import 坐标一致；reframe 在两种对齐之间换算。"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from conftest import jpeg_bytes, scan_zip, upload_asset
from metaverse_worker.processing import tasks
from metaverse_worker.processing.align import auto_align
from metaverse_worker.processing.scan import compute_alignment, rotation_y
from metaverse_worker.recon import core as wc
from metaverse_worker.recon import reframe as rf
from metaverse_worker.recon.cli import build_parser
from metaverse_worker.recon.prepare import cmd_prepare, default_limits
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


@pytest.mark.mongo
def test_prepare_matches_real_scan_import_commit(tmp_path, scan_file, store, db_config, monkeypatch):
    """真实的 scan_import 任务（首次导入）写进提交的变换和重建层物件，与 prepare 完全一致。"""
    from conftest import make_space
    from metaverse_worker.handlers import scan as scan_handlers
    from metaverse_worker.runner import Runner
    from test_pipeline_mongo import run_job

    monkeypatch.setattr(scan_handlers, "OBJECTS_TARGET", FAKE)
    make_space(store)
    runner = Runner(db_config, store, isolate=False, on_stall=lambda: None)
    asset = upload_asset(store, scan_file.read_bytes(), "scan")
    doc = run_job(runner, store, "scan_import", {"assetHash": asset})
    assert doc["status"] == "done", doc.get("lastError")
    commit = store.commits.find_one({"jobId": doc["_id"]})
    out = prepare(tmp_path, scan_file)
    transform = json.loads((out / "transform.json").read_text())
    assert commit["scan"]["transform"] == transform["transform"]
    ids = {c["id"] for c in commit["changedEntities"]}
    base_ids = set(json.loads((out / "structure.json").read_text())) | set(
        json.loads((out / "objects.json").read_text())
    )
    assert ids == base_ids


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
    from metaverse_worker.processing.shape_mesh import transform_matrix

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
    from metaverse_worker.processing.shape_mesh import transform_matrix

    for yaw, pitch, roll in ((30, 10, -5), (-120, 0, 0), (0, -90, 0), (45, 20, 170)):
        R = transform_matrix({"yaw": yaw, "pitch": pitch, "roll": roll})[:3, :3]
        y, p, r = rf.euler_yxz(R)
        assert np.allclose(transform_matrix({"yaw": y, "pitch": p, "roll": r})[:3, :3], R, atol=1e-9)
