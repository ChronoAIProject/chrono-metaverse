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
from dataclasses import dataclass

import numpy as np
from PIL import Image

from ..errors import InputRejected
from .glb import GlbMesh, vertex_normals, write_glb
from .scan import ScanMesh, inspect_glb, inspect_image, load_draco, sniff_file
from .webmodel import shrink_texture, simplify_mesh

Image.MAX_IMAGE_PIXELS = None


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


def load_model(
    model_path: str,
    texture_path: str | None,
    *,
    max_triangles: int,
    max_texture_pixels: int,
) -> tuple[ScanMesh, np.ndarray | None, tuple[float, float, float, float]]:
    """读模型：返回 (网格 + 可选贴图, 顶点颜色 (N,4) uint8 或 None, 材质底色)。"""
    import trimesh

    fmt = sniff_file(model_path)
    colors = None
    base = (1.0, 1.0, 1.0, 1.0)
    if fmt == "draco":
        vertices, faces, uv = load_draco(model_path, max_triangles)
        texture = None
        if texture_path is not None:
            inspect_image(texture_path, max_texture_pixels)
            with Image.open(texture_path) as img:
                texture = np.asarray(img.convert("RGBA" if "A" in img.getbands() else "RGB"))
        mesh = ScanMesh(vertices, faces, uv, texture)
    elif fmt in ("glb", "obj"):
        if fmt == "glb":
            inspect_glb(model_path, max_triangles, max_texture_pixels)
        elif _count_obj_faces(model_path) > max_triangles:
            raise InputRejected(f"三角形数超过上限 {max_triangles}")
        loaded = trimesh.load(model_path, file_type=fmt, process=False, force="mesh")
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
            image = getattr(material, "baseColorTexture", None) or getattr(material, "image", None)
            if visual.uv is not None and (image is not None or texture_path is not None):
                uv = np.asarray(visual.uv, np.float64).copy()
                uv[:, 1] = 1.0 - uv[:, 1]  # trimesh 内部是左下角原点
                if image is not None:
                    texture = np.asarray(image.convert("RGBA" if "A" in image.getbands() else "RGB"))
                else:
                    inspect_image(texture_path, max_texture_pixels)
                    with Image.open(texture_path) as img:
                        texture = np.asarray(img.convert("RGB"))
            else:
                factor = getattr(material, "baseColorFactor", None)
                if factor is None:
                    factor = getattr(material, "main_color", None)
                if factor is not None:
                    f = np.asarray(factor, np.float64).reshape(-1)
                    if f.max() > 1.0:
                        f = f / 255.0
                    alpha = float(f[3]) if len(f) > 3 else 1.0
                    base = (float(f[0]), float(f[1]), float(f[2]), alpha)
        elif isinstance(visual, trimesh.visual.ColorVisuals) and visual.kind == "vertex":
            colors = np.asarray(visual.vertex_colors, np.uint8)
        mesh = ScanMesh(vertices, faces, uv, texture)
    else:
        raise InputRejected("物件模型只接受 glb、obj、drc")
    if not np.all(np.isfinite(mesh.vertices)):
        raise InputRejected("顶点坐标含非有限值")
    if mesh.faces.min() < 0 or mesh.faces.max() >= len(mesh.vertices):
        raise InputRejected("三角面引用了不存在的顶点")
    if np.abs(mesh.vertices).max() > 1000:
        raise InputRejected("模型坐标超出 ±1000 米，单位可能不是米")
    if mesh.uv is not None and len(mesh.uv) != len(mesh.vertices):
        mesh.uv = None
    return mesh, colors, base


def _encode_texture(texture: np.ndarray) -> tuple[bytes, str]:
    buf = io.BytesIO()
    img = Image.fromarray(texture)
    if img.mode == "RGBA" and np.asarray(img)[..., 3].min() < 255:
        img.save(buf, format="PNG", optimize=True)
        return buf.getvalue(), "image/png"
    img.convert("RGB").save(buf, format="JPEG", quality=90, optimize=True, progressive=False)
    return buf.getvalue(), "image/jpeg"


def export_model(
    mesh: ScanMesh,
    colors: np.ndarray | None,
    base_color: tuple[float, float, float, float],
    *,
    max_triangles: int,
    max_texture_side: int,
) -> ImportedModel:
    source_triangles = mesh.triangle_count
    if colors is not None and mesh.triangle_count > max_triangles:
        # 减面不处理顶点颜色：借贴图坐标的位置记下顶点编号，减面后再取回颜色
        index_uv = np.stack(
            [np.arange(len(mesh.vertices), dtype=np.float64), np.zeros(len(mesh.vertices))], 1
        )
        tagged = simplify_mesh(ScanMesh(mesh.vertices, mesh.faces, index_uv, None), max_triangles)
        colors = colors[tagged.uv[:, 0].astype(np.int64)]
        mesh = ScanMesh(tagged.vertices, tagged.faces, None, None)
    else:
        mesh = simplify_mesh(mesh, max_triangles)
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
