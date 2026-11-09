"""网页用模型（设计 6.3 第 8 步、共同约定第 4 条）。

两档 glb，坐标保持扫描原坐标（提交里的 `scan.transform` 把它变到空间坐标）：

| 档 | 三角形上限 | 贴图上限 | 用途 |
|---|---|---|---|
| `[0]` | 30 万 | 4096² | 默认版本，网页加载这一档 |
| `[1]` | 6 万 | 1024² | 低细节版本 |

- **减面**：`fast-simplification`（二次误差边折叠）。它不处理贴图坐标，所以只取它的折叠历史，按并查集找出
  每个输出顶点对应的原始顶点（被折叠的顶点并到保留下来的那个），沿用那个原始顶点的位置和贴图坐标。
  扫描网格按贴图分块，块边界是开放边界，两侧各自简化，低细节档在块缝处可能有细缝。
- **贴图**：缩小到上限以内（只缩不放），JPEG 质量 85（低细节档 80）。
- 三角形数本来就不超过上限时不减面，原样写出。
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image

from .glb import GlbMesh, vertex_normals, write_glb
from .scan import ScanMesh


@dataclass(frozen=True)
class WebModelLevel:
    max_triangles: int
    max_texture_side: int
    jpeg_quality: int


WEB_MODEL_LEVELS = (
    WebModelLevel(300_000, 4096, 85),
    WebModelLevel(60_000, 1024, 80),
)


@dataclass
class WebModel:
    data: bytes
    triangles: int
    vertices: int
    texture_side: int  # 贴图较长边的像素数；没有贴图时为 0


def _roots(n: int, collapses: np.ndarray) -> np.ndarray:
    """并查集：`collapses[i] = [保留, 被折叠]`，返回每个原始顶点最终并入的顶点。"""
    parent = np.arange(n, dtype=np.int64)
    for keep, gone in np.asarray(collapses, np.int64).reshape(-1, 2):
        parent[gone] = keep
    # 路径压缩：反复取 parent[parent] 直到不变（折叠链长度有限）
    while True:
        nxt = parent[parent]
        if np.array_equal(nxt, parent):
            return parent
        parent = nxt


def simplify_mesh(mesh: ScanMesh, max_triangles: int) -> ScanMesh:
    """减面到不超过 `max_triangles` 个三角形，保留贴图坐标（见模块说明）。

    只用减面库给出的折叠历史：每个原始顶点并到它的根，三角面换成根的编号，去掉退化的面
    （实测与减面库自己的输出是同一组面）。顶点位置取根的原始位置（不用减面库挪过的"最优位置"）：
    这样贴图坐标和位置始终对应，也不会出现减面库在块边界上把顶点挪出几十厘米形成的尖刺。
    """
    if mesh.triangle_count <= max_triangles:
        return mesh
    import fast_simplification

    vertices = np.ascontiguousarray(mesh.vertices, np.float64)
    faces = np.ascontiguousarray(mesh.faces, np.int64)
    target = max(4, int(max_triangles * 0.98))  # 留一点余量
    _, _, collapses = fast_simplification.simplify(
        vertices, faces, target_count=min(target, len(faces) - 1), return_collapses=True
    )
    roots = _roots(len(vertices), collapses)
    rf = roots[faces]
    keep = (rf[:, 0] != rf[:, 1]) & (rf[:, 1] != rf[:, 2]) & (rf[:, 0] != rf[:, 2])
    rf = rf[keep]
    if len(rf) > max_triangles:
        # 极少数情况下停在目标之上：再按面数截一次（保留面积最大的面）
        a = vertices[rf]
        area = np.linalg.norm(np.cross(a[:, 1] - a[:, 0], a[:, 2] - a[:, 0]), axis=1)
        rf = rf[np.sort(np.argsort(-area, kind="stable")[:max_triangles])]
    used = np.unique(rf)
    return ScanMesh(
        vertices[used],
        np.searchsorted(used, rf),
        None if mesh.uv is None else mesh.uv[used],
        mesh.texture,
    )


def shrink_texture(texture: np.ndarray, max_side: int) -> np.ndarray:
    """按比例缩小到长边不超过 max_side（只缩不放）。"""
    h, w = texture.shape[:2]
    scale = max_side / max(h, w)
    if scale >= 1:
        return texture
    img = Image.fromarray(texture)
    factor = int(1 / scale)
    if factor >= 2 and max(h, w) // factor >= max_side and max(h, w) % factor == 0:
        img = img.reduce(factor)  # 整数倍缩小：快、等价于盒式滤波
    else:
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.LANCZOS)
    return np.asarray(img)


def encode_jpeg(texture: np.ndarray, quality: int) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.asarray(texture, np.uint8)).convert("RGB").save(
        buf, format="JPEG", quality=quality, optimize=True, progressive=False
    )
    return buf.getvalue()


def encode_web_model(simple: ScanMesh, level: WebModelLevel, name: str = "scan") -> WebModel:
    """把（已经减过面的）网格写成 glb：贴图缩到这一档的上限，JPEG 编码后内嵌。"""
    image = None
    side = 0
    if simple.texture is not None and simple.uv is not None:
        tex = shrink_texture(simple.texture, level.max_texture_side)
        side = int(max(tex.shape[:2]))
        image = encode_jpeg(tex, level.jpeg_quality)
    glb = GlbMesh(
        positions=simple.vertices,
        faces=simple.faces,
        normals=vertex_normals(simple.vertices, simple.faces),
        uv=simple.uv if image is not None else None,
        image=image,
        base_color=(1.0, 1.0, 1.0, 1.0) if image is not None else (0.63, 0.63, 0.63, 1.0),
        name=name,
    )
    return WebModel(write_glb(glb), len(simple.faces), len(simple.vertices), side)


def build_web_model(mesh: ScanMesh, level: WebModelLevel, name: str = "scan") -> WebModel:
    return encode_web_model(simplify_mesh(mesh, level.max_triangles), level, name)


def build_web_models(mesh: ScanMesh) -> list[WebModel]:
    """按 `WEB_MODEL_LEVELS` 生成两档。低细节档从默认档继续减面（更快，结果相近）；贴图都从原图缩小。"""
    out: list[WebModel] = []
    source = mesh
    for index, level in enumerate(WEB_MODEL_LEVELS):
        source = simplify_mesh(source, level.max_triangles)
        out.append(encode_web_model(source, level, name=f"scan-lod{index}"))
    return out
