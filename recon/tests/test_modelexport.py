"""外部模型的读入与重新导出（processing/modelexport.py）：多材质各自的贴图、平铺贴图按重复采样、节点变换、
减面不跨材质也不跨贴图块、贴图上限、透明、调色、逐字节确定，以及该拒绝的输入。"""

from __future__ import annotations

import io
import json
import math
import struct

import numpy as np
import pytest
from PIL import Image

from metaverse_recon.errors import InputRejected
from metaverse_recon.processing import modelexport as mx
from metaverse_recon.processing.glb import read_glb_json


def png(color, size=(8, 8), mode="RGB") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, color).save(buf, format="PNG")
    return buf.getvalue()


class Gltf:
    """测试用的小 glb 构造器。"""

    def __init__(self) -> None:
        self.doc: dict = {
            "asset": {"version": "2.0"},
            "accessors": [],
            "bufferViews": [],
            "meshes": [],
            "nodes": [],
        }
        self.bin = bytearray()

    def view(self, data: bytes) -> int:
        while len(self.bin) % 4:
            self.bin.append(0)
        self.doc["bufferViews"].append({"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)})
        self.bin += data
        return len(self.doc["bufferViews"]) - 1

    def accessor(self, arr: np.ndarray, ctype: int, kind: str, bounds: bool = False) -> int:
        entry = {
            "bufferView": self.view(arr.tobytes()),
            "componentType": ctype,
            "count": len(arr),
            "type": kind,
        }
        if bounds:
            entry["min"] = arr.min(0).tolist()
            entry["max"] = arr.max(0).tolist()
        self.doc["accessors"].append(entry)
        return len(self.doc["accessors"]) - 1

    def image(self, data: bytes, wrap=10497) -> int:
        self.doc.setdefault("images", []).append({"bufferView": self.view(data), "mimeType": "image/png"})
        self.doc.setdefault("samplers", []).append({"wrapS": wrap, "wrapT": wrap})
        self.doc.setdefault("textures", []).append(
            {"source": len(self.doc["images"]) - 1, "sampler": len(self.doc["samplers"]) - 1}
        )
        return len(self.doc["textures"]) - 1

    def material(self, **m) -> int:
        self.doc.setdefault("materials", []).append(m)
        return len(self.doc["materials"]) - 1

    def mesh(self, positions, faces, *, uv=None, normals=None, material=None) -> int:
        attrs = {"POSITION": self.accessor(np.asarray(positions, np.float32), 5126, "VEC3", True)}
        if uv is not None:
            attrs["TEXCOORD_0"] = self.accessor(np.asarray(uv, np.float32), 5126, "VEC2")
        if normals is not None:
            attrs["NORMAL"] = self.accessor(np.asarray(normals, np.float32), 5126, "VEC3")
        prim = {
            "attributes": attrs,
            "indices": self.accessor(np.asarray(faces, np.uint16).reshape(-1), 5123, "SCALAR"),
        }
        if material is not None:
            prim["material"] = material
        self.doc["meshes"].append({"primitives": [prim]})
        return len(self.doc["meshes"]) - 1

    def node(self, **n) -> int:
        self.doc["nodes"].append(n)
        return len(self.doc["nodes"]) - 1

    def glb(self, roots=None) -> bytes:
        doc = dict(self.doc)
        doc["scenes"] = [{"nodes": roots if roots is not None else list(range(len(doc["nodes"])))}]
        doc["scene"] = 0
        doc["buffers"] = [{"byteLength": len(self.bin)}]
        text = json.dumps(doc).encode()
        text += b" " * (-len(text) % 4)
        binary = bytes(self.bin) + b"\x00" * (-len(self.bin) % 4)
        total = 12 + 8 + len(text) + 8 + len(binary)
        return (
            struct.pack("<III", 0x46546C67, 2, total)
            + struct.pack("<II", len(text), 0x4E4F534A)
            + text
            + struct.pack("<II", len(binary), 0x004E4942)
            + binary
        )


QUAD = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]
QUAD_FACES = [[0, 2, 1], [0, 3, 2]]


def two_material_model(tmp_path) -> str:
    """两块：坐垫（红贴图，平铺到 u = 40）、腿（蓝贴图）；坐垫节点绕 x 转 90°。"""
    g = Gltf()
    red = g.material(pbrMetallicRoughness={"baseColorTexture": {"index": g.image(png((200, 30, 30)))}})
    blue = g.material(
        pbrMetallicRoughness={
            "baseColorTexture": {"index": g.image(png((30, 30, 200)))},
            "roughnessFactor": 0.4,
        },
        doubleSided=True,
    )
    seat = g.mesh(
        QUAD, QUAD_FACES, uv=[[0, 0], [40, 0], [40, 1], [0, 1]], normals=[[0, 1, 0]] * 4, material=red
    )
    legs = g.mesh(
        [[p[0] + 2, p[1], p[2]] for p in QUAD], QUAD_FACES, uv=[[0, 0], [1, 0], [1, 1], [0, 1]], material=blue
    )
    s = math.sqrt(0.5)
    g.node(mesh=seat, rotation=[s, 0, 0, s])  # 绕 x 转 90°：+y → +z
    g.node(mesh=legs, translation=[0, 1, 0])
    path = tmp_path / "m.glb"
    path.write_bytes(g.glb())
    return str(path)


def read(path):
    return mx.read_model(path, max_triangles=100_000, max_pixels=1 << 24)


def export(model, **kw):
    args = dict(
        max_triangles=100_000,
        max_texture_side=2048,
        max_texture_pixels=4 * 2048 * 2048,
        max_decode_pixels=1 << 24,
    )
    args.update(kw)
    return mx.export_model(model, **args)


def glb_doc(data: bytes) -> dict:
    return read_glb_json(data)


def test_read_keeps_materials_apart_and_applies_node_transforms(tmp_path):
    model = read(two_material_model(tmp_path))
    assert len(model.primitives) == 2 and len(model.materials) == 2
    seat, legs = model.primitives
    # 绕 x 转 90°：原来 z 方向的边转到 -y；法线 +y → +z（法线按逆转置变换）
    assert np.allclose(seat.positions[:, 1], [0, 0, -1, -1], atol=1e-6)
    assert np.allclose(seat.normals, [[0, 0, 1]] * 4, atol=1e-6)
    assert np.allclose(legs.positions[:, 1], 1.0)
    # 平铺的贴图坐标原样保留，不压进 0–1
    assert seat.uv[:, 0].max() == pytest.approx(40)
    assert model.materials[1].roughness == pytest.approx(0.4) and model.materials[1].double_sided


def test_export_keeps_each_material_texture_and_repeat_sampling(tmp_path):
    out = export(read(two_material_model(tmp_path)))
    doc = glb_doc(out.data)
    assert out.materials == 2 and len(doc["images"]) == 2 and len(doc["meshes"][0]["primitives"]) == 2
    textures = {m["pbrMetallicRoughness"]["baseColorTexture"]["index"] for m in doc["materials"]}
    assert textures == {0, 1}  # 各用各的贴图，没有拼成图集
    assert all(s["wrapS"] == 10497 and s["wrapT"] == 10497 for s in doc["samplers"])
    assert doc["nodes"] == [{"mesh": 0, "name": "model"}]  # 一个节点，单位变换
    assert all(m["pbrMetallicRoughness"]["metallicFactor"] == 0.0 for m in doc["materials"])
    # 平铺的贴图坐标照样写出（u 到 40）
    uv_acc = doc["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"]
    assert doc["accessors"][uv_acc]["count"] == 4
    # 原点在包围盒的底面中心
    lo, hi = np.asarray(out.bounds["min"]), np.asarray(out.bounds["max"])
    assert lo[1] == pytest.approx(0, abs=1e-6)
    assert (lo[0] + hi[0]) / 2 == pytest.approx(0, abs=1e-6) and (lo[2] + hi[2]) / 2 == pytest.approx(
        0, abs=1e-6
    )
    # 逐字节确定
    assert export(read(two_material_model(tmp_path))).data == out.data


def test_tint_goes_into_base_color_and_scale_is_baked(tmp_path):
    out = export(read(two_material_model(tmp_path)), linear=np.diag([2.0, 1.0, 1.0]), tint=[128, 255, 255])
    doc = glb_doc(out.data)
    k = ((128 / 255 + 0.055) / 1.055) ** 2.4
    for m in doc["materials"]:
        assert m["pbrMetallicRoughness"]["baseColorFactor"][:3] == pytest.approx([k, 1.0, 1.0], abs=1e-5)
    assert out.bounds["max"][0] - out.bounds["min"][0] == pytest.approx(6.0, abs=1e-5)  # x 方向 3 米 × 2
    with pytest.raises(InputRejected, match="1000"):
        export(read(two_material_model(tmp_path)), linear=np.eye(3) * 2000)


def test_texture_limits_side_and_total_pixels(tmp_path):
    g = Gltf()
    mats = [
        g.material(
            pbrMetallicRoughness={"baseColorTexture": {"index": g.image(png((i * 60, 100, 100), (512, 256)))}}
        )
        for i in range(3)
    ]
    for i, mat in enumerate(mats):
        g.node(
            mesh=g.mesh(
                [[p[0] + 2 * i, p[1], p[2]] for p in QUAD],
                QUAD_FACES,
                uv=[[0, 0], [1, 0], [1, 1], [0, 1]],
                material=mat,
            )
        )
    path = tmp_path / "t.glb"
    path.write_bytes(g.glb())
    out = export(read(str(path)), max_texture_side=256, max_texture_pixels=3 * 128 * 64)
    assert all(max(t) <= 256 for t in out.textures)
    assert out.texture_pixels <= 3 * 128 * 64
    assert mx.texture_scales([(512, 256)], 256, 1 << 30) == [0.5]


def test_alpha_textures_keep_png_only_when_material_is_transparent(tmp_path):
    g = Gltf()
    leaf = g.image(png((10, 200, 10, 0), mode="RGBA"))
    cut = g.material(
        pbrMetallicRoughness={"baseColorTexture": {"index": leaf}}, alphaMode="MASK", alphaCutoff=0.3
    )
    g.node(mesh=g.mesh(QUAD, QUAD_FACES, uv=[[0, 0], [1, 0], [1, 1], [0, 1]], material=cut))
    path = tmp_path / "a.glb"
    path.write_bytes(g.glb())
    doc = glb_doc(export(read(str(path))).data)
    assert doc["images"][0]["mimeType"] == "image/png"
    assert doc["materials"][0]["alphaMode"] == "MASK" and doc["materials"][0]["alphaCutoff"] == 0.3
    g.doc["materials"][0] = {"pbrMetallicRoughness": {"baseColorTexture": {"index": leaf}}}
    path.write_bytes(g.glb())
    assert glb_doc(export(read(str(path))).data)["images"][0]["mimeType"] == "image/jpeg"


def test_texture_transform_extension_is_applied_to_uv(tmp_path):
    g = Gltf()
    tex = g.image(png((100, 100, 100)))
    mat = g.material(
        pbrMetallicRoughness={
            "baseColorTexture": {
                "index": tex,
                "extensions": {"KHR_texture_transform": {"scale": [4, 2], "offset": [0.5, 0]}},
            }
        }
    )
    g.node(mesh=g.mesh(QUAD, QUAD_FACES, uv=[[0, 0], [1, 0], [1, 1], [0, 1]], material=mat))
    path = tmp_path / "x.glb"
    path.write_bytes(g.glb())
    uv = read(str(path)).primitives[0].uv
    assert np.allclose(uv, [[0.5, 0], [4.5, 0], [4.5, 2], [0.5, 2]])


def grid_model(n: int) -> mx.SourceModel:
    """n×n 的起伏网格，左右两半两种材质；右半另有一条贴图接缝（同一位置两份顶点、贴图坐标不同）。"""
    prims = []
    for half, u0 in ((0, 0.0), (1, 100.0)):
        xs = np.linspace(half, half + 1, n + 1)
        zs = np.linspace(0, 1, n + 1)
        X, Z = np.meshgrid(xs, zs)
        Y = 0.05 * np.sin(6 * X) * np.cos(5 * Z)
        pos = np.c_[X.ravel(), Y.ravel(), Z.ravel()]
        uv = np.c_[u0 + 10 * (X.ravel() - half), Z.ravel()]
        idx = np.arange((n + 1) * (n + 1)).reshape(n + 1, n + 1)
        a, b, c, d = idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel(), idx[1:, 1:].ravel(), idx[1:, :-1].ravel()
        faces = np.r_[np.c_[a, c, b], np.c_[a, d, c]]
        prims.append(mx.Primitive(pos, faces, half, None, uv, None))
    mats = [mx.Material(image=0), mx.Material(image=0)]
    return mx.SourceModel(prims, mats, [png((128, 128, 128))])


def test_simplify_keeps_material_and_texture_islands():
    model = grid_model(40)  # 6400 个三角形
    out = mx.simplified(model, 1500)
    assert sum(len(p.faces) for p in out.primitives) <= 1500
    assert sorted(p.material for p in out.primitives) == [0, 1]
    for p in out.primitives:
        # 每个面的贴图坐标都来自自己那块：左半 u ∈ [0, 10]，右半 u ∈ [100, 110]
        lo = 0.0 if p.material == 0 else 100.0
        assert p.uv[:, 0].min() >= lo - 1e-6 and p.uv[:, 0].max() <= lo + 10 + 1e-6
        # 面没有跨到另一半（材质分界在焊接后是内部边，折叠可能让它挪动几个网格间距）
        assert p.positions[:, 0].min() >= p.material - 0.1 and p.positions[:, 0].max() <= p.material + 1.1
    # 外形没塌：起伏的最高、最低点还在
    ys = np.concatenate([p.positions[:, 1] for p in out.primitives])
    assert ys.max() > 0.045 and ys.min() < -0.045
    # 没超过上限时原样返回
    assert mx.simplified(model, 10_000) is model


def test_transfer_attributes_interpolates_on_the_same_island():
    verts = np.array([[0, 0, 0], [1, 0, 0], [0, 0, 1], [5, 0, 5], [6, 0, 5], [5, 0, 6]], float)
    faces = np.array([[0, 2, 1], [3, 5, 4]])
    comp = np.array([0, 0, 0, 1, 1, 1])
    uv = np.array([[0, 0], [10, 0], [0, 10], [50, 50], [60, 50], [50, 60]], float)
    (got,) = mx.transfer_attributes(
        np.array([[0.5, 0, 0.25], [5.2, 0, 5.2]]),
        np.array([0, 1]),
        verts,
        faces,
        comp,
        [uv],
        np.array([0, 3]),
    )
    assert np.allclose(got, [[5, 2.5], [52, 52]])
    # 附近没有同一块的三角形：用给的后备顶点，不跨到别的块
    (got,) = mx.transfer_attributes(
        np.array([[0.5, 0, 0.25]]), np.array([7]), verts, faces, comp, [uv], np.array([1]), k=2
    )
    assert np.allclose(got, [[10, 0]])


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda d: d.update(extensionsRequired=["KHR_draco_mesh_compression"]), "不支持的扩展"),
        (lambda d: d["nodes"].append({"children": [0]}) or d["nodes"][0].update(children=[1]), "成环"),
        (lambda d: d["nodes"][0].update(skin=0), "骨骼"),
        (lambda d: d["accessors"][0].update(sparse={"count": 1}), "稀疏"),
    ],
)
def test_rejected_inputs(tmp_path, mutate, message):
    g = Gltf()
    g.node(mesh=g.mesh(QUAD, QUAD_FACES))
    mutate(g.doc)
    path = tmp_path / "bad.glb"
    path.write_bytes(g.glb(roots=[0]))
    with pytest.raises(InputRejected, match=message):
        read(str(path))


def test_triangle_limit_is_checked_before_decoding(tmp_path):
    g = Gltf()
    g.node(mesh=g.mesh(QUAD, QUAD_FACES))
    path = tmp_path / "m.glb"
    path.write_bytes(g.glb())
    with pytest.raises(InputRejected, match="三角形数 2 超过上限 1"):
        mx.read_model(str(path), max_triangles=1, max_pixels=1 << 20)


def test_variant_key_ignores_nothing_that_changes_the_mesh():
    caps = {"triangles": 100_000, "side": 2048, "pixels": 1 << 24}
    a = mx.variant_key("s", np.eye(3), None, caps)
    assert a == mx.variant_key("s", np.eye(3), None, dict(caps))
    assert a != mx.variant_key("s", np.diag([2.0, 1, 1]), None, caps)
    assert a != mx.variant_key("s", np.eye(3), [1, 2, 3], caps)
    assert a != mx.variant_key("s", np.eye(3), None, {**caps, "side": 1024})
