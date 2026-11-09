"""物件模型的校验与重新导出（设计 4.4、6.1）。

"放物件"只能引用处理服务重新导出的模型。输入是 glb、obj、drc（或含它们的 zip），输出一律是受限的 glb：

- 三角形数超过上限（默认 10 万）就减面（同网页用模型的做法，保留贴图坐标）；
- 贴图长边超过上限（默认 2048）就缩小；有透明通道的贴图存 PNG，否则存 JPEG（质量 90）；
- 没有贴图时保留顶点颜色或材质底色；
- 坐标原样保留（模型自己的局部坐标，单位按米理解），不做任何对齐；
- 法线重新计算，材质不受光照影响的声明不加（物件模型由网站正常打光）。

输出逐字节确定，同样的输入得到同样的资源哈希。
"""

from __future__ import annotations

import io
import json
import os
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote, urlsplit

import numpy as np
from PIL import Image

from ..errors import InputRejected
from .glb import GlbMesh, vertex_normals, write_glb
from .scan import (
    ScanMesh,
    decoded_image,
    guard_pixels,
    inspect_glb,
    inspect_image,
    load_draco,
    sniff_file,
)
from .webmodel import shrink_texture, simplify_mesh


@dataclass
class ImportedModel:
    data: bytes
    triangles: int
    vertices: int
    texture_side: int
    source_triangles: int
    bounds: dict


def _count_obj_faces(path: str) -> int:
    """解析前检查：流式数 obj 的面（多边形按扇形三角化计数）。"""
    total = 0
    with open(path, "rb") as fh:
        for line in fh:
            if line.startswith(b"f "):
                total += max(1, len(line.split()) - 3)
    return total


# gltf 的必需扩展只放行材质和贴图坐标类；几何压缩（Draco、meshopt）等 trimesh 读不了的直接拒绝
_GLTF_EXTENSION_PREFIXES = ("KHR_materials_", "KHR_texture_transform", "KHR_mesh_quantization")
MAX_GLTF_JSON_BYTES = 16 << 20


def _gltf_file(base_dir: str, uri: Any, what: str) -> str:
    """gltf 里的 uri 必须是同一目录树里的相对文件（不接受 data:、http:、绝对路径、..）。"""
    if not isinstance(uri, str) or not uri:
        raise InputRejected(f"gltf 里{what}的 uri 不合法")
    if urlsplit(uri).scheme or uri.startswith(("/", "\\")):
        raise InputRejected(f"gltf 里{what}只能引用相对路径的文件")
    rel = unquote(uri)
    root = os.path.realpath(base_dir)
    path = os.path.realpath(os.path.join(root, rel))
    if not path.startswith(root + os.sep) or not os.path.isfile(path):
        raise InputRejected(f"gltf 里{what}引用的文件 {rel!r} 不在模型目录里")
    return path


def inspect_gltf(path: str, max_triangles: int, max_pixels: int) -> int:
    """解析前检查 gltf（json + 外部文件）：引用的文件都在模型目录里、三角形数、贴图像素、必需扩展。"""
    if os.path.getsize(path) > MAX_GLTF_JSON_BYTES:
        raise InputRejected("gltf 文件超过 16MB")
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (UnicodeDecodeError, ValueError) as error:
        raise InputRejected(f"gltf 不是合法的 JSON：{error}") from error
    if not isinstance(doc, dict):
        raise InputRejected("gltf 不是 JSON 对象")
    base = os.path.dirname(path)
    for ext in doc.get("extensionsRequired") or []:
        if not (isinstance(ext, str) and ext.startswith(_GLTF_EXTENSION_PREFIXES)):
            raise InputRejected(f"gltf 需要不支持的扩展 {ext}（请换不压缩几何的版本）")
    for i, buffer in enumerate(doc.get("buffers") or []):
        if isinstance(buffer, dict) and "uri" in buffer:
            _gltf_file(base, buffer["uri"], f"第 {i} 个 buffer")
    for i, image in enumerate(doc.get("images") or []):
        if isinstance(image, dict) and "uri" in image:
            inspect_image(_gltf_file(base, image["uri"], f"第 {i} 张图片"), max_pixels)
    accessors = doc.get("accessors") or []
    meshes = doc.get("meshes") or []

    def mesh_triangles(index: Any) -> int:
        if not isinstance(index, int) or not 0 <= index < len(meshes) or not isinstance(meshes[index], dict):
            raise InputRejected("gltf 里网格的编号不合法")
        total = 0
        for prim in meshes[index].get("primitives") or []:
            if not isinstance(prim, dict) or prim.get("mode", 4) != 4:
                continue
            ref = prim.get("indices", (prim.get("attributes") or {}).get("POSITION"))
            if isinstance(ref, int) and 0 <= ref < len(accessors) and isinstance(accessors[ref], dict):
                count = accessors[ref].get("count")
                total += count // 3 if isinstance(count, int) and count > 0 else 0
        return total

    nodes = [n for n in doc.get("nodes") or [] if isinstance(n, dict) and "mesh" in n]
    total = (
        sum(mesh_triangles(n["mesh"]) for n in nodes)
        if nodes
        else sum(mesh_triangles(i) for i in range(len(meshes)))
    )
    if total > max_triangles:
        raise InputRejected(f"三角形数 {total} 超过上限 {max_triangles}")
    return total


def load_model(
    model_path: str,
    texture_path: str | None,
    *,
    max_triangles: int,
    max_texture_pixels: int,
) -> tuple[ScanMesh, np.ndarray | None, tuple[float, float, float, float]]:
    """读模型：返回 (网格 + 可选贴图, 顶点颜色 (N,4) uint8 或 None, 材质底色)。

    像素上限在任何解码之前检查：单独给的贴图在加载模型之前（obj 的材质可能引用同一张图），glb 内嵌的贴图
    由 `inspect_glb` 读文件头，trimesh 打开的贴图在转换成数组之前再按尺寸查一次。
    """
    import trimesh

    guard_pixels(max_texture_pixels)
    if texture_path is not None:
        inspect_image(texture_path, max_texture_pixels)
    fmt = "gltf" if model_path.lower().endswith(".gltf") else sniff_file(model_path)
    colors = None
    base = (1.0, 1.0, 1.0, 1.0)
    if fmt == "draco":
        vertices, faces, uv = load_draco(model_path, max_triangles)
        texture = None
        if texture_path is not None:
            with Image.open(texture_path) as img:
                texture = decoded_image(img, max_texture_pixels, _texture_mode(img))
        mesh = ScanMesh(vertices, faces, uv, texture)
    elif fmt in ("glb", "obj", "gltf"):
        if fmt == "glb":
            inspect_glb(model_path, max_triangles, max_texture_pixels)
        elif fmt == "gltf":
            inspect_gltf(model_path, max_triangles, max_texture_pixels)
        elif _count_obj_faces(model_path) > max_triangles:
            raise InputRejected(f"三角形数超过上限 {max_triangles}")
        loaded = _load_trimesh(model_path, fmt)
        if not isinstance(loaded, trimesh.Trimesh) or len(loaded.faces) == 0:
            raise InputRejected("模型里没有三角网格")
        if len(loaded.faces) > max_triangles:
            raise InputRejected(f"三角形数 {len(loaded.faces)} 超过上限 {max_triangles}")
        vertices = np.asarray(loaded.vertices, np.float64)
        faces = np.asarray(loaded.faces, np.int64)
        uv = None
        texture = None
        visual = loaded.visual
        if isinstance(visual, trimesh.visual.TextureVisuals):
            material = visual.material
            # 压缩包里单独给的贴图优先（obj 的 mtl 被改了名，trimesh 找不到时会给一张 2×2 的默认图）
            image = None if texture_path is not None else _material_image(material)
            if visual.uv is not None and (image is not None or texture_path is not None):
                uv = np.asarray(visual.uv, np.float64).copy()
                uv[:, 1] = 1.0 - uv[:, 1]  # trimesh 内部是左下角原点
                if image is not None:
                    texture = decoded_image(image, max_texture_pixels, _texture_mode(image))
                else:
                    with Image.open(texture_path) as img:
                        texture = decoded_image(img, max_texture_pixels, "RGB")
            else:
                vertex_colors = (getattr(visual, "vertex_attributes", None) or {}).get("color")
                if vertex_colors is not None and len(vertex_colors) == len(vertices):
                    colors = _rgba_u8(vertex_colors)
                base = _base_color(material) or base
        elif isinstance(visual, trimesh.visual.ColorVisuals) and visual.kind == "vertex":
            colors = _rgba_u8(visual.vertex_colors)
        mesh = ScanMesh(vertices, faces, uv, texture)
    else:
        raise InputRejected("物件模型只接受 glb、gltf、obj、drc")
    if not np.all(np.isfinite(mesh.vertices)):
        raise InputRejected("顶点坐标含非有限值")
    if mesh.faces.min() < 0 or mesh.faces.max() >= len(mesh.vertices):
        raise InputRejected("三角面引用了不存在的顶点")
    if np.abs(mesh.vertices).max() > 1000:
        raise InputRejected("模型坐标超出 ±1000 米，单位可能不是米")
    if mesh.uv is not None and len(mesh.uv) != len(mesh.vertices):
        mesh.uv = None
    return mesh, colors, base


def _load_trimesh(path: str, fmt: str):
    """只有一个网格、一个节点时直接取那个网格（套上节点变换），保留顶点颜色等属性；
    多个网格时让 trimesh 合并（贴图会被拼成图集，顶点颜色可能丢失）。"""
    import trimesh

    loaded = trimesh.load(path, file_type=fmt, process=False)
    if isinstance(loaded, trimesh.Scene):
        nodes = loaded.graph.nodes_geometry
        if len(loaded.geometry) == 1 and len(nodes) == 1:
            matrix, name = loaded.graph[nodes[0]]
            mesh = loaded.geometry[name]  # 不复制：trimesh 的 copy 会丢掉顶点颜色
            if not np.allclose(matrix, np.eye(4)):
                mesh.vertices = trimesh.transform_points(mesh.vertices, matrix)
            return mesh
        return loaded.to_geometry() if hasattr(loaded, "to_geometry") else loaded.dump(concatenate=True)
    return loaded


def _texture_mode(image) -> str:
    return "RGBA" if "A" in image.getbands() else "RGB"


def _material_image(material):
    return getattr(material, "baseColorTexture", None) or getattr(material, "image", None)


def _base_color(material) -> tuple[float, float, float, float] | None:
    factor = getattr(material, "baseColorFactor", None)
    if factor is None:
        factor = getattr(material, "main_color", None)
    if factor is None:
        return None
    f = np.asarray(factor, np.float64).reshape(-1)
    if f.max() > 1.0:
        f = f / 255.0
    alpha = float(f[3]) if len(f) > 3 else 1.0
    return (float(f[0]), float(f[1]), float(f[2]), alpha)


def _rgba_u8(colors) -> np.ndarray:
    c = np.asarray(colors)
    if c.dtype.kind == "f":
        c = np.clip(np.round(c * 255.0), 0, 255)
    c = c.astype(np.uint8)
    if c.shape[1] == 3:
        c = np.concatenate([c, np.full((len(c), 1), 255, np.uint8)], axis=1)
    return c


def _encode_texture(texture: np.ndarray) -> tuple[bytes, str]:
    buf = io.BytesIO()
    img = Image.fromarray(texture)
    if img.mode == "RGBA" and np.asarray(img)[..., 3].min() < 255:
        img.save(buf, format="PNG", optimize=True)
        return buf.getvalue(), "image/png"
    img.convert("RGB").save(buf, format="JPEG", quality=90, optimize=True, progressive=False)
    return buf.getvalue(), "image/jpeg"


def simplify_for_export(
    mesh: ScanMesh, colors: np.ndarray | None, max_triangles: int
) -> tuple[ScanMesh, np.ndarray | None]:
    """减面到上限以内（保留贴图坐标；有顶点颜色时借贴图坐标记下顶点编号，减面后再取回颜色）。"""
    if colors is not None and mesh.triangle_count > max_triangles:
        index_uv = np.stack(
            [np.arange(len(mesh.vertices), dtype=np.float64), np.zeros(len(mesh.vertices))], 1
        )
        tagged = simplify_mesh(ScanMesh(mesh.vertices, mesh.faces, index_uv, None), max_triangles)
        colors = colors[tagged.uv[:, 0].astype(np.int64)]
        return ScanMesh(tagged.vertices, tagged.faces, None, None), colors
    return simplify_mesh(mesh, max_triangles), colors


def write_model(
    mesh: ScanMesh,
    colors: np.ndarray | None,
    base_color: tuple[float, float, float, float],
    *,
    max_texture_side: int,
    source_triangles: int,
) -> ImportedModel:
    """（已减面的）网格写成 glb：贴图缩到上限以内，没有贴图时保留顶点颜色或材质底色。"""
    image = None
    mime = "image/jpeg"
    side = 0
    if mesh.texture is not None and mesh.uv is not None:
        tex = shrink_texture(mesh.texture, max_texture_side)
        side = int(max(tex.shape[:2]))
        image, mime = _encode_texture(tex)
    glb = GlbMesh(
        positions=mesh.vertices,
        faces=mesh.faces,
        normals=vertex_normals(mesh.vertices, mesh.faces),
        uv=mesh.uv if image is not None else None,
        colors=colors if image is None else None,
        image=image,
        image_mime=mime,
        base_color=base_color if image is None else (1.0, 1.0, 1.0, 1.0),
        name="model",
        unlit=False,
    )
    lo, hi = mesh.vertices.min(axis=0), mesh.vertices.max(axis=0)
    return ImportedModel(
        write_glb(glb),
        len(mesh.faces),
        len(mesh.vertices),
        side,
        int(source_triangles),
        {"min": [float(x) for x in lo], "max": [float(x) for x in hi]},
    )


def export_model(
    mesh: ScanMesh,
    colors: np.ndarray | None,
    base_color: tuple[float, float, float, float],
    *,
    max_triangles: int,
    max_texture_side: int,
) -> ImportedModel:
    source_triangles = mesh.triangle_count
    mesh, colors = simplify_for_export(mesh, colors, max_triangles)
    return write_model(
        mesh, colors, base_color, max_texture_side=max_texture_side, source_triangles=source_triangles
    )
