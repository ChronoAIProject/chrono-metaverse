"""glb 写出器与网页用模型（共同约定第 4 条）。"""

import io
import struct

import numpy as np
import pytest
import trimesh
from PIL import Image

from conftest import png_bytes, scan_glb
from metaverse_worker.processing.glb import GlbMesh, read_glb_json, vertex_normals, write_glb
from metaverse_worker.processing.scan import ScanMesh, load_scan
from metaverse_worker.processing.webmodel import (
    WEB_MODEL_LEVELS,
    WebModelLevel,
    build_web_model,
    build_web_models,
    shrink_texture,
    simplify_mesh,
)
from synthetic import room_mesh


def dense_plane(n: int = 120) -> ScanMesh:
    """n×n 格的起伏平面（2n² 个三角形），贴图坐标 = 归一化平面坐标。"""
    us, vs = np.meshgrid(np.linspace(0, 1, n + 1), np.linspace(0, 1, n + 1), indexing="ij")
    verts = np.stack(
        [us.ravel() * 4, 0.05 * np.sin(us.ravel() * 9) * np.cos(vs.ravel() * 7), vs.ravel() * 4], 1
    )
    idx = np.arange((n + 1) ** 2).reshape(n + 1, n + 1)
    a, b, c, d = idx[:-1, :-1].ravel(), idx[1:, :-1].ravel(), idx[1:, 1:].ravel(), idx[:-1, 1:].ravel()
    faces = np.concatenate([np.stack([a, c, b], 1), np.stack([a, d, c], 1)])
    uv = np.stack([us.ravel(), vs.ravel()], 1)
    tex = np.zeros((64, 64, 3), np.uint8)
    tex[..., 0] = np.linspace(0, 255, 64)[None, :]
    tex[..., 1] = np.linspace(0, 255, 64)[:, None]
    return ScanMesh(verts, faces, uv, tex)


def test_glb_is_deterministic_and_parses():
    mesh = room_mesh()
    data = scan_glb(mesh)
    assert data == scan_glb(mesh)
    magic, version, length = struct.unpack_from("<4sII", data)
    assert (magic, version, length) == (b"glTF", 2, len(data))
    doc = read_glb_json(data)
    prim = doc["meshes"][0]["primitives"][0]
    assert set(prim["attributes"]) == {"POSITION", "NORMAL", "TEXCOORD_0"}
    assert doc["images"][0]["mimeType"] == "image/png"
    assert "extensionsUsed" in doc and "KHR_materials_unlit" in doc["extensionsUsed"]
    assert not any("draco" in e.lower() or "meshopt" in e.lower() for e in doc.get("extensionsUsed", []))
    loaded = trimesh.load(io.BytesIO(data), file_type="glb", force="mesh", process=False)
    assert len(loaded.faces) == len(mesh.faces)
    np.testing.assert_allclose(loaded.vertices.min(0), mesh.vertices.min(0), atol=1e-5)


def test_glb_uv_roundtrip_through_loader(tmp_path):
    """写出的贴图坐标是左上角原点；按扫描读取函数读回来要一致（它会抵消 trimesh 的翻转）。"""
    mesh = room_mesh()
    path = tmp_path / "room.glb"
    path.write_bytes(scan_glb(mesh))
    back = load_scan(str(path))
    assert back.texture is not None and back.texture.shape == mesh.texture.shape
    # 顶点顺序不变：直接比较贴图坐标
    np.testing.assert_allclose(back.uv, mesh.uv, atol=1e-6)


def test_glb_vertex_colors_and_validation():
    v = np.array([[0, 0, 0], [1, 0, 0], [0, 0, 1]], float)
    f = np.array([[0, 2, 1]])
    data = write_glb(
        GlbMesh(v, f, colors=np.array([[255, 0, 0], [0, 255, 0], [0, 0, 255]], np.uint8), unlit=False)
    )
    doc = read_glb_json(data)
    assert "COLOR_0" in doc["meshes"][0]["primitives"][0]["attributes"]
    assert "extensionsUsed" not in doc
    with pytest.raises(ValueError):
        write_glb(GlbMesh(v, np.array([[0, 1, 5]])))
    with pytest.raises(ValueError):
        write_glb(GlbMesh(np.zeros((0, 3)), f))
    n = vertex_normals(v, f)
    np.testing.assert_allclose(n, [[0, 1, 0]] * 3, atol=1e-9)


def test_simplify_keeps_uv_consistent_with_positions():
    mesh = dense_plane(120)
    assert mesh.triangle_count == 28_800
    small = simplify_mesh(mesh, 3000)
    assert 0 < small.triangle_count <= 3000
    assert small.uv is not None and len(small.uv) == len(small.vertices)
    # 顶点取的是原始顶点：位置和贴图坐标都能在原网格里找到同一个顶点
    np.testing.assert_allclose(small.vertices[:, 0] / 4, small.uv[:, 0], atol=1e-9)
    np.testing.assert_allclose(small.vertices[:, 2] / 4, small.uv[:, 1], atol=1e-9)
    assert small.faces.max() < len(small.vertices)
    # 不超过上限时原样返回
    assert simplify_mesh(mesh, 30_000) is mesh


def test_shrink_texture():
    tex = np.zeros((300, 200, 3), np.uint8)
    assert shrink_texture(tex, 400) is tex
    assert shrink_texture(tex, 150).shape[:2] == (150, 100)
    big = np.zeros((512, 512, 3), np.uint8)
    assert shrink_texture(big, 128).shape[:2] == (128, 128)


def test_web_model_levels_respect_limits():
    mesh = dense_plane(120)
    level = WebModelLevel(5000, 32, 80)
    model = build_web_model(mesh, level)
    assert model.triangles <= 5000
    assert model.texture_side == 32
    doc = read_glb_json(model.data)
    img = doc["images"][0]
    assert img["mimeType"] == "image/jpeg"
    view = doc["bufferViews"][img["bufferView"]]
    start = 20 + struct.unpack_from("<I", model.data, 12)[0] + 8 + view["byteOffset"]
    with Image.open(io.BytesIO(model.data[start : start + view["byteLength"]])) as im:
        assert im.size == (32, 32)
    assert WEB_MODEL_LEVELS[0].max_triangles == 300_000 and WEB_MODEL_LEVELS[0].max_texture_side == 4096
    assert WEB_MODEL_LEVELS[1].max_triangles == 60_000 and WEB_MODEL_LEVELS[1].max_texture_side == 1024


def test_build_web_models_two_levels_without_texture():
    mesh = room_mesh()
    mesh = ScanMesh(mesh.vertices, mesh.faces, None, None)
    models = build_web_models(mesh)
    assert len(models) == 2
    for m in models:
        assert m.texture_side == 0
        doc = read_glb_json(m.data)
        assert "images" not in doc
        assert doc["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"][3] == 1.0


def test_png_helper_roundtrip():
    tex = np.full((4, 4, 3), 7, np.uint8)
    with Image.open(io.BytesIO(png_bytes(tex))) as im:
        assert im.size == (4, 4)
