"""查看和渲染用的 glb：物件记录（形状 + 材质）按网站同样的网格生成写成 glb。

与 `processing.preview_glb` 的区别：逐个材质写 `opacity`（半透明：`alphaMode: BLEND`）和 `unlit`
（`KHR_materials_unlit`），可以按部件着色，可以把外部模型物件按 transform 合并进来（整房预览）。
带贴图的材质不打光（扫描烘焙的贴图自带光照；外部模型的贴图带 `lit` 标记、`shading: "albedo"` 的贴图是
固有色，照常打光），纯色材质由渲染页按网站的灯光着色。平铺、法线、粗糙度的写法与 `preview_glb` 相同
（SHAPES 2"glb 导出"）。
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

import numpy as np

from ..processing import shape_mesh as sm
from ..processing.preview_glb import _srgb_to_linear, _Writer
from .core import PALETTE, glb_bytes
from .shapes_ext import build_parts


class Writer(_Writer):
    def material(self, mat: Mapping[str, Any]) -> int:
        key = json.dumps(mat, sort_keys=True)
        if key in self.mat_index:
            return self.mat_index[key]
        pbr: dict[str, Any] = {"metallicFactor": 0.0, "roughnessFactor": 0.9}
        h = mat.get("texture")
        opacity = float(mat.get("opacity", 1.0))
        textured = h is not None and h in self.textures
        if textured:
            pbr["baseColorTexture"] = {
                "index": self.texture_index(
                    h, self.textures[h], mat.get("tile") is not None or bool(mat.get("repeat"))
                )
            }
            tint = mat.get("tint") or [255, 255, 255]
            pbr["baseColorFactor"] = [*(_srgb_to_linear(c) for c in tint), opacity]
        else:
            rgb = mat.get("color") or mat.get("tint") or [200, 200, 200]
            pbr["baseColorFactor"] = [*(_srgb_to_linear(c) for c in rgb), opacity]
        m: dict[str, Any] = {"pbrMetallicRoughness": pbr, "doubleSided": True}
        if opacity < 0.999:
            m["alphaMode"] = "BLEND"
        # 扫描烘焙的贴图自带光照，不打光；模型库的贴图（材质带 lit）和 albedo 的贴图是固有色，要打光
        if (textured and not mat.get("lit") and mat.get("shading") != "albedo") or mat.get("unlit"):
            m["extensions"] = {"KHR_materials_unlit": {}}
        else:
            self.lit_maps(mat, m, pbr)
        self.materials.append(m)
        self.mat_index[key] = len(self.materials) - 1
        return self.mat_index[key]


def _merged(parts: list[sm.Part], color_parts: bool, offset: int):
    """按材质合并网格；按部件着色时每个部件一种颜色（材质换成调色板颜色，保留透明度）。"""
    if not color_parts:
        return sm.merged_by_material(parts)
    out = []
    for i, p in enumerate(parts):
        mat = dict(p.material or {})
        mat = {"color": list(PALETTE[(i + offset) % len(PALETTE)]), "opacity": mat.get("opacity", 1.0)}
        out.append((mat, p.mesh))
    return out


def export_glb(
    entities: Mapping[str, Mapping[str, Any]],
    templates: Mapping[str, Any],
    textures: Mapping[str, bytes],
    path: str,
    *,
    extra_parts: Mapping[str, list[sm.Part]] | None = None,
    color_parts: bool = False,
    material_override: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, int]:
    """形状物件 → glb（每个物件一个节点）。`extra_parts`：额外的网格块（外部模型，已在空间坐标里）；
    `material_override`：部件路径（如 `counter-01$.children[2]`）→ 预览材质（烘焙指令的预览色）。"""
    w = Writer(textures, False)
    meshes: list[dict[str, Any]] = []
    nodes: list[dict[str, Any]] = []
    tris = 0
    k = 0
    items: list[tuple[str, list[sm.Part]]] = []
    for eid, body in entities.items():
        if body.get("kind") == "template" or body.get("shape") is None:
            continue
        parts = build_parts(body["shape"], templates)
        if material_override:
            parts = [
                sm.Part(p.mesh, dict(material_override.get(f"{eid}{p.path[1:]}", p.material) or {}), p.path)
                for p in parts
            ]
        items.append((eid, parts))
    for eid, parts in (extra_parts or {}).items():
        items.append((eid, parts))
    for eid, parts in items:
        prims = []
        for mat, mesh in _merged(parts, color_parts, k):
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
        k += len(parts)
        if prims:
            meshes.append({"name": eid, "primitives": prims})
            nodes.append({"name": eid, "mesh": len(meshes) - 1})
    doc: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": "metaverse-recon"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": w.materials,
        "accessors": w.accessors,
        "bufferViews": w.views,
        "buffers": [{"byteLength": w.offset}],
        "extensionsUsed": ["KHR_materials_unlit"],
    }
    w.write_textures(doc)
    data = glb_bytes(doc, w.chunks)
    with open(path, "wb") as fh:
        fh.write(data)
    return {"triangles": tris, "bytes": len(data), "nodes": len(nodes)}
