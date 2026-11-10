"""查看用的 glb：把物件记录（SHAPES 形状 + 贴图）按网站同样的网格生成写成 glTF 2.0 二进制。

只用于本地查看和渲染对比（`scripts/reconstruct_lobby.py`），不进提交。每个物件一个节点（名字是 entityId），
每种材质一个图元；贴图原样嵌入 JPEG；颜色写成线性空间的 baseColorFactor。
glTF 的贴图坐标原点在左上角，这里的 v 向上，所以写出 1 − v。

材质的 `opacity` < 1 写成 `alphaMode: "BLEND"`（透明度放进 baseColorFactor 的第四个分量，双面）；
`unlit` 为真（或整份导出要求不打光）时写 `KHR_materials_unlit`。

平铺、法线、粗糙度按 SHAPES 2"glb 导出"：贴图坐标已经算进 `TEXCOORD_0`；给了 `tile` 的材质用重复采样，
其余钳边，`textures` 按（图片，采样器）去重；受光照的材质写 `roughnessFactor`、`metallicFactor`，`normalMap`
写成 `normalTexture`，`roughnessMap` 另做一张 R = 255、G = 原图 G 通道、B = 255 的 PNG 当
`metallicRoughnessTexture`；webp 图片转成 PNG（glTF 只认 png、jpeg）。
"""

from __future__ import annotations

import io
import json
import struct
from collections.abc import Mapping
from typing import Any

import numpy as np
from PIL import Image

from .shape_mesh import build_parts, merged_by_material

# 9729 = LINEAR，9987 = LINEAR_MIPMAP_LINEAR；33071 = CLAMP_TO_EDGE（没给 tile），10497 = REPEAT（给了 tile）
SAMPLERS = [
    {"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071},
    {"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497},
]
# 没给 roughness 时的粗糙度（SHAPES 2"粗糙度和金属度"：glb 默认 0.9；给了粗糙度贴图时是乘数，默认 1）
DEFAULT_ROUGHNESS = 0.9


def gltf_image(data: bytes) -> tuple[bytes, str]:
    """图片 → (glTF 能嵌入的字节, mimeType)：png、jpeg 原样，webp 转成 PNG。"""
    if data[:4] == b"\x89PNG":
        return data, "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        out = io.BytesIO()
        with Image.open(io.BytesIO(data)) as img:
            img.save(out, "PNG")
        return out.getvalue(), "image/png"
    return data, "image/jpeg"


def roughness_png(data: bytes) -> bytes:
    """粗糙度贴图 → `metallicRoughnessTexture` 用的 PNG：R = 255（不用），G = 原图的 G 通道（白 = 粗糙），
    B = 255（金属度全由 `metallicFactor` 决定）。灰度图三个通道相同，透明通道忽略。"""
    with Image.open(io.BytesIO(data)) as img:
        green = img.convert("RGB").getchannel("G")
    full = Image.new("L", green.size, 255)
    out = io.BytesIO()
    Image.merge("RGB", (full, green, full)).save(out, "PNG")
    return out.getvalue()


def _srgb_to_linear(c: float) -> float:
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


class _Writer:
    def __init__(self, textures: Mapping[str, bytes], unlit: bool) -> None:
        self.textures = textures
        self.unlit = unlit
        self.chunks: list[bytes] = []
        self.offset = 0
        self.views: list[dict[str, Any]] = []
        self.accessors: list[dict[str, Any]] = []
        self.materials: list[dict[str, Any]] = []
        self.images: list[dict[str, Any]] = []
        self.tex_index: dict[str, int] = {}  # 图片的键（贴图哈希，粗糙度贴图另加前缀）→ images 下标
        self.slots: dict[tuple[int, int], int] = {}  # （图片，采样器）→ textures 下标
        self.mat_index: dict[str, int] = {}
        self.used_unlit = False

    def texture_index(self, key: str, data: bytes, repeat: bool) -> int:
        """嵌入图片（同一张只嵌一次），返回（图片，采样器）对应的 textures 下标。"""
        if key not in self.tex_index:
            data, mime = gltf_image(data)
            self.images.append({"bufferView": self.view(data), "mimeType": mime})
            self.tex_index[key] = len(self.images) - 1
        return self.slots.setdefault((self.tex_index[key], 1 if repeat else 0), len(self.slots))

    def lit_maps(self, mat: Mapping[str, Any], m: dict[str, Any], pbr: dict[str, Any]) -> None:
        """受光照的材质：粗糙度、金属度，法线贴图和粗糙度贴图（与主贴图共用贴图坐标和采样方式）。"""
        repeat = mat.get("tile") is not None
        rough = mat.get("roughnessMap")
        default = 1.0 if rough is not None else DEFAULT_ROUGHNESS
        pbr["roughnessFactor"] = float(mat["roughness"]) if mat.get("roughness") is not None else default
        pbr["metallicFactor"] = float(mat.get("metalness") or 0.0)
        normal = mat.get("normalMap")
        if normal is not None and normal in self.textures:
            m["normalTexture"] = {"index": self.texture_index(normal, self.textures[normal], repeat)}
            if mat.get("normalScale") is not None:
                m["normalTexture"]["scale"] = float(mat["normalScale"])
        if rough is not None and rough in self.textures:
            index = self.texture_index(f"roughness:{rough}", roughness_png(self.textures[rough]), repeat)
            pbr["metallicRoughnessTexture"] = {"index": index}

    def write_textures(self, doc: dict[str, Any]) -> None:
        if self.images:
            doc["images"] = self.images
            doc["textures"] = [{"source": image, "sampler": sampler} for image, sampler in self.slots]
            doc["samplers"] = SAMPLERS

    def view(self, data: bytes, target: int | None = None) -> int:
        pad = (-len(data)) % 4
        v: dict[str, Any] = {"buffer": 0, "byteOffset": self.offset, "byteLength": len(data)}
        if target:
            v["target"] = target
        self.views.append(v)
        self.chunks.append(data + b"\0" * pad)
        self.offset += len(data) + pad
        return len(self.views) - 1

    def accessor(self, arr: np.ndarray, ctype: int, kind: str, target: int, minmax: bool = False) -> int:
        acc: dict[str, Any] = {
            "bufferView": self.view(arr.tobytes(), target),
            "componentType": ctype,
            "count": int(arr.shape[0]),
            "type": kind,
        }
        if minmax:
            acc["min"] = [float(v) for v in arr.min(0)]
            acc["max"] = [float(v) for v in arr.max(0)]
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def material(self, mat: Mapping[str, Any]) -> int:
        key = json.dumps(mat, sort_keys=True)
        if key in self.mat_index:
            return self.mat_index[key]
        pbr: dict[str, Any] = {"metallicFactor": 0.0, "roughnessFactor": DEFAULT_ROUGHNESS}
        opacity = float(mat.get("opacity", 1.0))
        h = mat.get("texture")
        if h is not None and h in self.textures:
            index = self.texture_index(h, self.textures[h], mat.get("tile") is not None)
            pbr["baseColorTexture"] = {"index": index}
            if mat.get("tint") or opacity < 1:
                pbr["baseColorFactor"] = [
                    *(_srgb_to_linear(c) for c in mat.get("tint") or (255, 255, 255)),
                    1.0,
                ]
        else:
            rgb = mat.get("color") or mat.get("tint") or [200, 200, 200]
            pbr["baseColorFactor"] = [*(_srgb_to_linear(c) for c in rgb), 1.0]
        m: dict[str, Any] = {"pbrMetallicRoughness": pbr, "doubleSided": False}
        if opacity < 1:
            pbr["baseColorFactor"][3] = opacity
            m["alphaMode"] = "BLEND"
            m["doubleSided"] = True
        if self.unlit or mat.get("unlit") is True:
            m["extensions"] = {"KHR_materials_unlit": {}}
            self.used_unlit = True
        else:
            self.lit_maps(mat, m, pbr)
        self.materials.append(m)
        self.mat_index[key] = len(self.materials) - 1
        return self.mat_index[key]


def export_glb(
    entities: Mapping[str, Mapping[str, Any]],
    textures: Mapping[str, bytes],
    path: str,
    *,
    unlit: bool = True,
) -> dict[str, int]:
    templates = {k: b["shape"] for k, b in entities.items() if b.get("kind") == "template" and "shape" in b}
    w = _Writer(textures, unlit)
    meshes: list[dict[str, Any]] = []
    nodes: list[dict[str, Any]] = []
    tris = 0
    for eid, body in entities.items():
        if body.get("kind") == "template" or "shape" not in body:
            continue
        prims = []
        for mat, mesh in merged_by_material(build_parts(body["shape"], templates)):
            if len(mesh.indices) == 0:
                continue
            uv = np.c_[mesh.uvs[:, 0], 1.0 - mesh.uvs[:, 1]].astype(np.float32)
            attrs = {
                "POSITION": w.accessor(mesh.positions.astype(np.float32), 5126, "VEC3", 34962, True),
                "NORMAL": w.accessor(mesh.normals.astype(np.float32), 5126, "VEC3", 34962),
                "TEXCOORD_0": w.accessor(uv, 5126, "VEC2", 34962),
            }
            idx = mesh.indices.astype(np.uint32).reshape(-1)
            prims.append(
                {
                    "attributes": attrs,
                    "indices": w.accessor(idx, 5125, "SCALAR", 34963),
                    "material": w.material(mat),
                }
            )
            tris += len(mesh.indices)
        if prims:
            meshes.append({"name": eid, "primitives": prims})
            nodes.append({"name": eid, "mesh": len(meshes) - 1})
    doc: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": "metaverse-worker preview"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": w.materials,
        "accessors": w.accessors,
        "bufferViews": w.views,
        "buffers": [{"byteLength": w.offset}],
    }
    w.write_textures(doc)
    if w.used_unlit:
        doc["extensionsUsed"] = ["KHR_materials_unlit"]
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    binary = b"".join(w.chunks)
    total = 12 + 8 + len(js) + 8 + len(binary)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<4sII", b"glTF", 2, total))
        fh.write(struct.pack("<I4s", len(js), b"JSON"))
        fh.write(js)
        fh.write(struct.pack("<I4s", len(binary), b"BIN\0"))
        fh.write(binary)
    return {"triangles": tris, "bytes": total, "nodes": len(nodes)}
