"""体素化（设计 4.2、4.3）、重建层整理（设计 6.3）、物件模型导出（设计 6.1）。"""

import hashlib
import io
import zipfile
from pathlib import Path

import numpy as np
import pytest
import trimesh

from conftest import jpeg_bytes, scan_glb
from metaverse_worker.chunk import FIRST_PALETTE_BLOCK, decompress
from metaverse_worker.errors import InputRejected, PermanentJobError
from metaverse_worker.handlers.voxelize import palette_size_of
from metaverse_worker.processing.glb import GlbMesh, read_glb_json, write_glb
from metaverse_worker.processing.rebuild import body_textures, load_objects_impl, rebuild, structure_entities
from metaverse_worker.processing.scan import ScanMesh
from metaverse_worker.processing.structure import extract_structure
from metaverse_worker.processing.tasks import (
    grid_cells_inside,
    jsonable,
    model_task,
    scan_task,
    voxelize_task,
)
from metaverse_worker.processing.voxelize import assign_blocks, encode_chunks, in_boxes, voxelize_mesh
from metaverse_worker.records import validate_entity_body
from synthetic import room_mesh

LIMITS = {
    "max_scan_bytes": 1 << 28,
    "max_triangles": 1_000_000,
    "max_texture_pixels": 1 << 26,
    "max_grid_cells": 400_000_000,
    "max_model_bytes": 1 << 26,
    "model_max_triangles": 500,
    "model_max_texture_side": 64,
}
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


@pytest.fixture(scope="module")
def room():
    return room_mesh()


# ---------------------------------------------------------------------------- 体素化


def test_voxelize_room_colors_and_reserved_ids(room):
    vox = voxelize_mesh(room, palette_size=8)
    assert len(vox.cells) > 5000
    assert vox.cells[:, 1].min() >= -1 and vox.cells[:, 1].max() <= 52
    assert 1 <= len(vox.colors) <= 8
    blocks, ids = assign_blocks([], vox.colors)
    assert ids.min() >= FIRST_PALETTE_BLOCK and [b["id"] for b in blocks] == list(range(2, 2 + len(blocks)))
    assert all(b["kind"] == "solid" and b["tags"] == ["scan"] for b in blocks)
    chunks = encode_chunks(vox.cells, ids[vox.labels])
    assert chunks
    for (_cx, _cy, _cz), (h, data) in chunks.items():
        arr = decompress(data)
        assert arr.any() and set(np.unique(arr)) - {0} <= set(ids.tolist())
        assert len(h) == 64
    # 同样的输入得到同样的结果（固定随机种子）
    again = voxelize_mesh(room, palette_size=8)
    assert np.array_equal(again.cells, vox.cells) and np.array_equal(again.colors, vox.colors)


def test_voxelize_clips_to_physical_region(room):
    boxes = [[0, 0, 0, 40, 60, 40]]  # x、z 只保留 0–2 米
    vox = voxelize_mesh(room, palette_size=4, physical_boxes=boxes)
    assert len(vox.cells) and in_boxes(vox.cells, boxes).all()
    assert vox.cells[:, 0].max() < 40 and vox.cells[:, 2].max() < 40
    empty = voxelize_mesh(room, palette_size=4, physical_boxes=[[500, 0, 500, 510, 10, 510]])
    assert len(empty.cells) == 0 and len(empty.colors) == 0
    with pytest.raises(InputRejected):
        voxelize_mesh(room, max_cells=10)


@pytest.mark.parametrize(
    ("style", "size"),
    [(None, 64), ("default", 64), ("coarse", 16), ("fine", 256), ({}, 64), ({"paletteSize": 1024}, 1024)],
)
def test_voxelize_style_to_palette_size(style, size):
    assert palette_size_of(style) == size


@pytest.mark.parametrize(
    "style",
    ["", "Default", "watercolor", 64, True, ["coarse"], {"paletteSize": 0}, {"paletteSize": 1025},
     {"paletteSize": True}, {"paletteSize": 8.0}, {"paletteSize": 8, "dither": 1}],
)  # fmt: skip
def test_voxelize_style_rejected(style):
    with pytest.raises(PermanentJobError):
        palette_size_of(style)


def test_assign_blocks_is_append_only():
    existing = [
        {"id": 2, "name": "石", "kind": "solid", "color": [128, 128, 128], "tags": ["stone"]},
        {"id": 7, "name": "扫描色", "kind": "solid", "color": [10, 20, 30], "tags": ["scan"]},
    ]
    colors = np.array([[10, 20, 30], [128, 128, 128], [1, 2, 3]], np.uint8)
    blocks, ids = assign_blocks(existing, colors)
    assert ids.tolist() == [7, 8, 9]  # 扫描色复用；通用方块颜色相同也不复用；新颜色追加
    assert blocks[:2] == existing and [b["id"] for b in blocks[2:]] == [8, 9]
    again, ids2 = assign_blocks(blocks, colors)
    assert again == blocks and ids2.tolist() == ids.tolist()


def test_voxelize_task_end_to_end(tmp_path, room):
    path = tmp_path / "room.glb"
    path.write_bytes(scan_glb(room))
    out = voxelize_task(
        scan_path=str(path),
        workdir=str(tmp_path),
        limits=LIMITS,
        transform=IDENTITY,
        palette_size=16,
        existing_blocks=[],
    )
    assert out["paletteChanged"] and out["chunks"] and out["stats"]["cells"] > 0
    *_, h, data = out["chunks"][0]
    assert isinstance(h, str) and isinstance(data, bytes)


# ---------------------------------------------------------------------------- 重建层


def test_structure_entities_are_valid_records(room):
    structure = extract_structure(room)
    bodies, textures = structure_entities(structure)
    assert "floor" in bodies and len(bodies) == len(structure.elements)
    for body in bodies.values():
        validate_entity_body(body)
        assert body["layer"] == "rebuilt" and body["kind"] == "structure"
        (tex,) = body["textures"]
        assert tex in textures and hashlib.sha256(textures[tex]).hexdigest() == tex
        assert body_textures(body) == {tex}
        if body["props"]["structure"] == "floor":
            assert body["shape"]["material"]["texture"] == tex
        else:  # 墙：贴图面板 + 纯色墙体
            face, wall = body["shape"]["children"]
            assert face["material"]["texture"] == tex and "color" in wall["material"]


def test_rebuild_with_fake_objects(room):
    out = rebuild(room, hints={"note": "测试"}, objects_target="fake_objects:reconstruct_objects")
    assert out.objects_skipped is None
    assert set(out.object_ids) == {"chair-a", "chair-01", "chair-02", "table-01"}
    assert out.metrics["objects"]["hints"] == {"note": "测试"}
    assert out.metrics["structure"]["walls"] >= 4
    table = out.entities["table-01"]
    assert table["shape"]["material"]["texture"] in out.textures


def test_rebuild_skips_objects_when_module_missing(room):
    out = rebuild(room, objects_target="metaverse_worker.processing.no_such_module:reconstruct_objects")
    assert out.objects_skipped and "导入失败" in out.objects_skipped
    assert out.object_ids == [] and out.structure_ids
    func, reason = load_objects_impl(None)
    assert func is None and reason


def test_rebuild_rejects_bad_object_results(room):
    with pytest.raises(PermanentJobError, match="layer=rebuilt"):
        rebuild(room, objects_target="fake_objects:broken_objects")
    with pytest.raises(RuntimeError, match="内部出错"):
        rebuild(room, objects_target="fake_objects:raising_objects")


def test_scan_task_auto_and_given(tmp_path, room):
    path = tmp_path / "room.glb"
    path.write_bytes(scan_glb(room))
    out = scan_task(
        scan_path=str(path),
        workdir=str(tmp_path),
        limits=LIMITS,
        objects_target="fake_objects:reconstruct_objects",
    )
    assert out["needsAlignment"] is False
    assert out["alignment"]["method"] == "auto" and len(out["transform"]) == 16
    assert [m["triangles"] for m in out["webModels"]] == [room.triangle_count] * 2
    assert all(Path(m["path"]).read_bytes()[:4] == b"glTF" for m in out["webModels"])
    assert set(out["rebuild"]["objectIds"]) >= {"table-01"}
    assert out["timings"]["total"] >= 0
    given = scan_task(
        scan_path=str(path),
        workdir=str(tmp_path / "g"),
        limits=LIMITS,
        transform=IDENTITY,
        web_models=False,
        do_rebuild=False,
    )
    assert given["alignment"]["method"] == "given" and "webModels" not in given and "rebuild" not in given
    with pytest.raises(InputRejected, match="格"):
        scan_task(
            scan_path=str(path),
            workdir=str(tmp_path / "h"),
            limits={**LIMITS, "max_grid_cells": 1000},
            transform=IDENTITY,
            web_models=False,
            do_rebuild=False,
        )


def test_grid_cells_inside():
    lo, hi = np.array([0.0, 0.0, 0.0]), np.array([1.0, 1.0, 1.0])
    assert grid_cells_inside(lo, hi, None) == 20**3
    assert grid_cells_inside(lo, hi, [[0, 0, 0, 10, 10, 10]]) == 1000
    assert grid_cells_inside(lo, hi, [[100, 0, 0, 110, 10, 10]]) == 0


def test_jsonable():
    out = jsonable({"a": np.float32(1.5), "b": (np.int64(2), np.array([1, 2])), "c": float("nan"), 3: b"x"})
    assert out == {"a": 1.5, "b": [2, [1, 2]], "c": None, "3": b"x"}


# ---------------------------------------------------------------------------- 物件模型


def dense_box_glb(n: int = 20) -> bytes:
    box = trimesh.creation.box((0.4, 0.8, 0.4))
    for _ in range(3):
        box = box.subdivide()
    v, f = box.vertices + np.array([0, 0.4, 0]), box.faces
    colors = np.tile(np.array([[200, 30, 30, 255]], np.uint8), (len(v), 1))
    return write_glb(GlbMesh(v, f, colors=colors, unlit=False))


def test_model_task_reduces_and_keeps_colors(tmp_path):
    src = tmp_path / "chair.glb"
    src.write_bytes(dense_box_glb())
    out = model_task(path=str(src), workdir=str(tmp_path), limits=LIMITS)
    assert out["sourceTriangles"] > 500 and out["triangles"] <= 500
    data = Path(out["path"]).read_bytes()
    doc = read_glb_json(data)
    assert "COLOR_0" in doc["meshes"][0]["primitives"][0]["attributes"]
    assert out["bounds"]["min"][1] == pytest.approx(0, abs=1e-6)
    # 确定性：同样的输入同样的输出
    out2 = model_task(path=str(src), workdir=str(tmp_path / "2"), limits=LIMITS)
    assert Path(out2["path"]).read_bytes() == data


def test_model_task_textured_obj_zip(tmp_path):
    tex = np.zeros((128, 128, 3), np.uint8)
    tex[:, :64] = [255, 0, 0]
    obj = b"mtllib m.mtl\nv 0 0 0\nv 1 0 0\nv 0 0 1\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl a\nf 1/1 2/2 3/3\n"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("m.obj", obj)
        zf.writestr("m.mtl", "newmtl a\nmap_Kd tex.jpg\n")
        zf.writestr("tex.jpg", jpeg_bytes(tex))
    src = tmp_path / "m.zip"
    src.write_bytes(buf.getvalue())
    out = model_task(path=str(src), workdir=str(tmp_path), limits=LIMITS)
    assert out["triangles"] == 1 and out["textureSide"] == 64
    doc = read_glb_json(Path(out["path"]).read_bytes())
    assert doc["images"][0]["mimeType"] == "image/jpeg"


def test_model_task_rejects(tmp_path):
    src = tmp_path / "x.glb"
    src.write_bytes(dense_box_glb())
    with pytest.raises(InputRejected, match="三角形数"):
        model_task(path=str(src), workdir=str(tmp_path), limits={**LIMITS, "max_triangles": 100})
    far = write_glb(GlbMesh(np.array([[0, 0, 0], [5000, 0, 0], [0, 0, 1]], float), np.array([[0, 2, 1]])))
    src.write_bytes(far)
    with pytest.raises(InputRejected, match="1000"):
        model_task(path=str(src), workdir=str(tmp_path), limits=LIMITS)
    src.write_bytes(b"hello world")
    with pytest.raises(InputRejected):
        model_task(path=str(src), workdir=str(tmp_path), limits=LIMITS)


def test_scanmesh_without_texture_zip_glb(tmp_path):
    mesh = ScanMesh(room_mesh().vertices, room_mesh().faces)
    data = write_glb(GlbMesh(mesh.vertices, mesh.faces))
    src = tmp_path / "plain.glb"
    src.write_bytes(data)
    out = scan_task(scan_path=str(src), workdir=str(tmp_path), limits=LIMITS, do_rebuild=False)
    assert all(m["textureSide"] == 0 for m in out["webModels"])
