"""查看用的 glb：把物件记录（SHAPES 形状 + 贴图）按网站同样的网格生成写成 glTF 2.0 二进制。

只用于本地查看和渲染对比（`scripts/reconstruct_lobby.py`），不进提交。每个物件一个节点（名字是 entityId），
每种材质一个图元；贴图原样嵌入 JPEG；颜色写成线性空间的 baseColorFactor。
glTF 的贴图坐标原点在左上角，这里的 v 向上，所以写出 1 − v。
"""

from __future__ import annotations

import json
import struct
from collections.abc import Mapping
from typing import Any

import numpy as np

from .shape_mesh import build_parts, merged_by_material


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
        self.tex_index: dict[str, int] = {}
        self.mat_index: dict[str, int] = {}

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
        pbr: dict[str, Any] = {"metallicFactor": 0.0, "roughnessFactor": 0.9}
        h = mat.get("texture")
        if h is not None and h in self.textures:
            if h not in self.tex_index:
                self.images.append({"bufferView": self.view(self.textures[h]), "mimeType": "image/jpeg"})
                self.tex_index[h] = len(self.images) - 1
            pbr["baseColorTexture"] = {"index": self.tex_index[h]}
            if mat.get("tint"):
                pbr["baseColorFactor"] = [*(_srgb_to_linear(c) for c in mat["tint"]), 1.0]
        else:
            rgb = mat.get("color") or mat.get("tint") or [200, 200, 200]
            pbr["baseColorFactor"] = [*(_srgb_to_linear(c) for c in rgb), 1.0]
        m: dict[str, Any] = {"pbrMetallicRoughness": pbr, "doubleSided": False}
        if self.unlit:
            m["extensions"] = {"KHR_materials_unlit": {}}
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
    if w.images:
        doc["images"] = w.images
        doc["textures"] = [{"source": i, "sampler": 0} for i in range(len(w.images))]
        doc["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
    if unlit:
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
