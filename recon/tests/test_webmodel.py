"""glb 写出器与网页用模型（共同约定第 4 条）。"""

import io
import struct

import numpy as np
import pytest
import trimesh
from PIL import Image

from conftest import png_bytes, scan_glb
from metaverse_recon.processing.glb import GlbMesh, read_glb_json, vertex_normals, write_glb
from metaverse_recon.processing.scan import ScanMesh, load_scan
from metaverse_recon.processing.webmodel import (
    WEB_MODEL_LEVELS,
    WebModelLevel,
    _corner_uv_sources,
    build_web_model,
    build_web_models,
    fill_unused,
    prepare_texture,
    shrink_texture,
    shrink_used,
    simplify_mesh,
    uv_coverage,
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


def chart_plane(n: int = 40, k: int = 4) -> ScanMesh:
    """n×n 格的起伏平面（4 米见方），分成 k×k 块贴图：块与块之间接缝上的顶点各有一份（位置相同、贴图坐标
    不同），和 Scaniverse 的扫描一样接缝在网格里是开放边界。块 (ci, cj) 的贴图坐标在图集第 ci 列、第 cj 行
    那一格里（四周各留 5% 空白）。"""
    m = n // k
    verts, uvs, faces = [], [], []
    for ci in range(k):
        for cj in range(k):
            i, j = np.meshgrid(np.arange(m + 1) + ci * m, np.arange(m + 1) + cj * m, indexing="ij")
            x, z = i.ravel() * 4 / n, j.ravel() * 4 / n
            base = sum(len(v) for v in verts)
            verts.append(np.stack([x, 0.05 * np.sin(x * 3) * np.cos(z * 2), z], 1))
            fu, fv = (i.ravel() - ci * m) / m, (j.ravel() - cj * m) / m
            uvs.append(np.stack([(ci + 0.05 + 0.9 * fu) / k, (cj + 0.05 + 0.9 * fv) / k], 1))
            idx = base + np.arange((m + 1) ** 2).reshape(m + 1, m + 1)
            a, b = idx[:-1, :-1].ravel(), idx[1:, :-1].ravel()
            c, d = idx[1:, 1:].ravel(), idx[:-1, 1:].ravel()
            faces += [np.stack([a, c, b], 1), np.stack([a, d, c], 1)]
    return ScanMesh(np.concatenate(verts), np.concatenate(faces), np.concatenate(uvs), None)


def uncovered(mesh: ScanMesh, step: float = 0.05, margin: float = 0.5) -> np.ndarray:
    """平面内部（离外边 margin 以内的不算，减面可以切掉外边的角）按网格取点，
    返回俯视时不落在任何三角形里的点。接缝裂开就会有这样的点。"""
    g = np.arange(margin, 4 - margin + 1e-9, step)
    p = np.stack(np.meshgrid(g, g, indexing="ij"), -1).reshape(-1, 2)
    t = mesh.vertices[mesh.faces][:, :, [0, 2]]
    a, b, c = t[:, 0], t[:, 1], t[:, 2]
    det = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])
    a, b, c, det = a[det != 0], b[det != 0], c[det != 0], det[det != 0]  # 俯视退化成线的面不算
    dx, dz = p[:, None, 0] - a[None, :, 0], p[:, None, 1] - a[None, :, 1]
    s1 = (dx * (c[:, 1] - a[:, 1]) - dz * (c[:, 0] - a[:, 0])) / det
    s2 = ((b[:, 0] - a[:, 0]) * dz - (b[:, 1] - a[:, 1]) * dx) / det
    inside = (s1 >= -1e-9) & (s2 >= -1e-9) & (s1 + s2 <= 1 + 1e-9)
    return p[~inside.any(1)]


def assert_no_cracks(mesh: ScanMesh) -> None:
    holes = uncovered(mesh)
    assert len(holes) == 0, f"{len(holes)} 个点没被三角形盖住（接缝裂开了），例如 {holes[:3].tolist()}"


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


def test_simplify_keeps_seams_closed_and_uv_inside_charts():
    """减到很低（第二步：焊接后减面）：接缝不裂开，每个面的三个贴图坐标都在同一块贴图里。"""
    mesh = chart_plane(40, 4)
    assert mesh.triangle_count == 3200
    assert_no_cracks(mesh)
    small = simplify_mesh(mesh, 300)
    assert 0 < small.triangle_count <= 300
    assert small.uv is not None and len(small.uv) == len(small.vertices)
    assert_no_cracks(small)
    cell = np.floor(small.uv[small.faces] * 4).astype(int)  # 每个角落在图集的哪一格
    assert (cell == cell[:, :1]).all()
    # 顶点位置都是原始顶点的位置
    orig = {tuple(p) for p in mesh.vertices}
    assert all(tuple(p) in orig for p in small.vertices)
    # 接缝两侧都还有面
    centers = small.vertices[small.faces].mean(1)
    assert (centers[:, 0] < 2).any() and (centers[:, 0] > 2).any()


def test_simplify_inside_keeps_every_seam_vertex():
    """减得不多（第一步就够）：接缝和外边界上的顶点一个不动，顶点的位置和贴图坐标都原样来自输入。"""
    mesh = chart_plane(40, 4)
    small = simplify_mesh(mesh, 1500)
    assert 0 < small.triangle_count <= 1500
    assert_no_cracks(small)
    pairs = {(*p, *t) for p, t in zip(mesh.vertices, mesh.uv, strict=True)}
    assert all((*p, *t) in pairs for p, t in zip(small.vertices, small.uv, strict=True))

    def on_chart_edge(v: np.ndarray) -> np.ndarray:  # 块边在整米处
        return (np.abs(v[:, 0] - np.round(v[:, 0])) < 1e-9) | (np.abs(v[:, 2] - np.round(v[:, 2])) < 1e-9)

    assert on_chart_edge(small.vertices).sum() == on_chart_edge(mesh.vertices).sum()  # 块边上的顶点一个不少


def test_simplify_without_uv():
    """没有贴图坐标的网格两步都能走：结果没有贴图坐标、不裂开。"""
    mesh = chart_plane(40, 4)
    plain = ScanMesh(mesh.vertices, mesh.faces, None, None)
    for limit in (1500, 300):
        small = simplify_mesh(plain, limit)
        assert 0 < small.triangle_count <= limit and small.uv is None
        assert_no_cracks(small)


def test_corner_uv_sources_follow_chart():
    """折叠跨过接缝时沿折叠链退回本块的最后一个顶点；同一块里有几份时取贴图坐标最近的。"""
    # 原始顶点：0、1 在块 0，2、3 在块 1；1 和 2 位置相同（焊接顶点 1），0 → 焊接 0，3 → 焊接 2
    weld = np.array([0, 1, 1, 2])
    comp = np.array([0, 0, 1, 1])
    uv = np.array([[0.1, 0.5], [0.4, 0.5], [0.6, 0.5], [0.9, 0.5]])
    parent = np.array([1, 2, 2])  # 焊接 0 并到 1，1 再并到 2（块 0 里没有 2）
    got = _corner_uv_sources(np.array([0, 3]), np.array([2, 2]), weld, parent, comp, uv)
    assert got.tolist() == [1, 3]
    # 一块贴图自己接上自己（圆筒展开）：同一位置在块里有两份，取离这个角原来的贴图坐标近的那份
    weld = np.array([0, 0, 1, 2])
    comp = np.zeros(4, np.int64)
    uv = np.array([[0.0, 0.5], [1.0, 0.5], [0.95, 0.5], [0.05, 0.5]])
    got = _corner_uv_sources(np.array([2, 3]), np.array([0, 0]), weld, np.array([0, 0, 0]), comp, uv)
    assert got.tolist() == [1, 0]


def islands_on_black():
    """64² 的黑底贴图上两块岛（红、蓝），各由两个三角形贴上；岛的边不在 2 的倍数上。"""
    tex = np.zeros((64, 64, 3), np.uint8)
    tex[5:27, 7:31] = (220, 40, 30)
    tex[37:59, 33:59] = (30, 60, 210)
    rects = [(7, 5, 31, 27), (33, 37, 59, 59)]  # (左, 上, 右, 下)，纹素边界
    verts, faces, uv = [], [], []
    for k, (x0, y0, x1, y1) in enumerate(rects):
        verts += [[k * 2, 0, 0], [k * 2 + 1, 0, 0], [k * 2 + 1, 0, 1], [k * 2, 0, 1]]
        uv += [[x0 / 64, y0 / 64], [x1 / 64, y0 / 64], [x1 / 64, y1 / 64], [x0 / 64, y1 / 64]]
        faces += [[4 * k, 4 * k + 2, 4 * k + 1], [4 * k, 4 * k + 3, 4 * k + 2]]
    return ScanMesh(np.array(verts, float), np.array(faces), np.array(uv), tex), rects


def test_uv_coverage_marks_island_texels():
    mesh, rects = islands_on_black()
    used = uv_coverage(mesh.uv, mesh.faces, (64, 64))
    # 岛的边正好在纹素边界上：用到的纹素正好是这两个矩形
    for x0, y0, x1, y1 in rects:
        assert used[y0:y1, x0:x1].all()
    assert used.sum() == sum((x1 - x0) * (y1 - y0) for x0, y0, x1, y1 in rects)
    # 贴图坐标不是有限值的面跳过
    bad = mesh.uv.copy()
    bad[0] = np.nan
    assert uv_coverage(bad, mesh.faces[1:2], (64, 64)).sum() == 0
    # 三角形在贴图上铺得异常大：不算（返回 None），贴图只缩小、不补边
    assert uv_coverage(mesh.uv, mesh.faces, (64, 64), max_spans=10) is None
    assert np.array_equal(prepare_texture(mesh.texture, None, 32), shrink_texture(mesh.texture, 32))


def test_uv_coverage_matches_texel_center_test():
    """随机三角形（两种绕向、跨出贴图范围的也有）：和逐纹素中心逐三角形判断的结果一致。"""
    rng = np.random.default_rng(7)
    uv = rng.random((60, 2)) * 1.2 - 0.1
    faces = rng.integers(0, 60, (40, 3))
    h, w = 37, 53
    got = uv_coverage(uv, faces, (h, w), chunk=7, band=5)
    cy, cx = np.mgrid[0:h, 0:w]
    px, py = cx + 0.5, cy + 0.5
    want = np.zeros((h, w), bool)
    for f in faces:
        t = uv[f] * (w, h)
        edge = [
            (t[j, 0] - t[i, 0]) * (py - t[i, 1]) - (t[j, 1] - t[i, 1]) * (px - t[i, 0])
            for i, j in ((0, 1), (1, 2), (2, 0))
        ]
        want |= np.all([e >= 0 for e in edge], 0) | np.all([e <= 0 for e in edge], 0)
    assert got.any() and np.array_equal(got, want)


@pytest.mark.parametrize("side", [64, 32, 16, 24])
def test_padding_fills_black_background(side):
    """补边后：岛外的纹素都不是黑色，岛边外一圈是岛自己的颜色；岛内颜色不变。旧做法缩小后边缘会发暗。"""
    mesh, rects = islands_on_black()
    used = uv_coverage(mesh.uv, mesh.faces, (64, 64))
    out = prepare_texture(mesh.texture, used, side).astype(int)
    assert out.shape[:2] == (side, side)
    assert out.sum(-1).min() > 150  # 没有黑色纹素
    s = side / 64
    for (x0, y0, x1, y1), color in zip(rects, [(220, 40, 30), (30, 60, 210)], strict=True):
        # 岛内（离边 1 个纹素以上）原色
        inner = out[int(np.ceil(y0 * s)) + 1 : int(y1 * s) - 1, int(np.ceil(x0 * s)) + 1 : int(x1 * s) - 1]
        assert np.abs(inner - color).max() <= 1
        # 岛边上和岛外 2 个纹素以内（缩小后）：接近岛的颜色
        ring = out[max(0, int(y0 * s) - 2) : int(np.ceil(y1 * s)) + 2, int(x1 * s) : int(np.ceil(x1 * s)) + 2]
        assert np.abs(ring - color).max(-1).mean() < 40
    if side < 64:
        old = shrink_texture(mesh.texture, side).astype(int)
        assert old.sum(-1).min() == 0  # 只缩小不补边：岛外还是黑的


def test_shrink_used_is_masked_box_average():
    rng = np.random.default_rng(3)
    tex = rng.integers(0, 256, (48, 64, 3), dtype=np.uint8)
    used = rng.random((48, 64)) < 0.3
    color, weight = shrink_used(tex, used, 16, band=5)
    assert color.shape == (12, 16, 3) and weight.shape == (12, 16)
    w = used.reshape(12, 4, 16, 4).sum((1, 3))
    s = (tex * used[..., None]).reshape(12, 4, 16, 4, 3).sum((1, 3))
    np.testing.assert_allclose(weight, w / 16, atol=1e-5)
    ok = w > 0
    np.testing.assert_allclose(color[ok], (s / np.maximum(w, 1)[..., None])[ok], atol=1e-3)
    # 非整数倍：形状对、权重在 [0, 1]
    color, weight = shrink_used(tex, used, 20)
    assert color.shape == (15, 20, 3) and weight.min() >= 0 and weight.max() <= 1 + 1e-6
    # 不用缩小：原样
    color, weight = shrink_used(tex, used, 64)
    assert np.array_equal(color, tex) and np.array_equal(weight > 0, used)


def test_fill_unused_edge_cases():
    tex = np.full((5, 7, 3), 100.4, np.float32)
    assert (fill_unused(tex.copy(), np.ones((5, 7), bool)) == 100).all()
    assert (fill_unused(tex.copy(), np.zeros((5, 7), bool)) == 100).all()
    valid = np.zeros((5, 7), bool)
    valid[2, 3] = True
    tex[2, 3] = (10, 200, 30)
    out = fill_unused(tex, valid)
    assert out.shape == (5, 7, 3) and (np.abs(out.astype(int) - (10, 200, 30)).max(-1) <= 1).all()


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


def test_web_model_texture_has_no_black_gaps():
    """整条流程：两块岛的黑底贴图，写出的 JPEG 贴图里没有黑色纹素。"""
    mesh, _ = islands_on_black()
    model = build_web_model(mesh, WebModelLevel(100, 32, 90))
    doc = read_glb_json(model.data)
    view = doc["bufferViews"][doc["images"][0]["bufferView"]]
    start = 20 + struct.unpack_from("<I", model.data, 12)[0] + 8 + view["byteOffset"]
    with Image.open(io.BytesIO(model.data[start : start + view["byteLength"]])) as im:
        tex = np.asarray(im.convert("RGB")).astype(int)
    assert tex.shape[:2] == (32, 32)
    assert tex.sum(-1).min() > 120


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
