"""网页用模型（设计 6.3 第 8 步、共同约定第 4 条）。

两档 glb，坐标保持扫描原坐标（提交里的 `scan.transform` 把它变到空间坐标）：

| 档 | 三角形上限 | 贴图上限 | 用途 |
|---|---|---|---|
| `[0]` | 30 万 | 4096² | 默认版本，网页加载这一档 |
| `[1]` | 6 万 | 1024² | 低细节版本 |

- **减面**：`fast-simplification`（二次误差边折叠），只用它的折叠历史：按并查集找出每个顶点最终并入的
  顶点，位置和贴图坐标都取原始顶点的（不用减面库挪过的"最优位置"）。扫描网格按贴图分块，块与块之间的接缝
  顶点各有一份（位置相同、贴图坐标不同），接缝在网格里是开放边界；接缝两侧各自简化时边界走向对不上，会
  裂出很多三角形的小洞（网页上地面的黑斑就是从这些洞里透出的背景）。所以分两步：
  1. 边界上的顶点都不动（`preserve_border`），只合并块内部的顶点：接缝两侧都不动，不会裂开，每次折叠都在
     同一块里，贴图坐标不变。前厅扫描的默认档（33.6 万 → 29.4 万）这一步就够了。
  2. 边界顶点太多、第一步减不到上限时（低细节档就是这样），把位置相同的顶点焊成一个再减面：接缝成了内部边，
     两侧共用同一组顶点，也不会裂开。贴图坐标按"面的角"分别取（见 `_corner_uv_sources`）：面原来属于哪一块
     贴图，就取并入顶点在这一块里的那一份；并入顶点不在这一块里（折叠跨过了接缝），就沿折叠链往回找，取
     还在这一块里的最后一个顶点的。每个面的三个贴图坐标都在自己那块贴图里，不会跨到别的块上；代价是跨过
     接缝的大三角形上贴图有拉伸（低细节档的地面能看出来，但没有洞）。
- **贴图**：缩小到上限以内（只缩不放），JPEG 质量 85（低细节档 80）。
- 三角形数本来就不超过上限时不减面，原样写出。
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image
from scipy import sparse
from scipy.sparse import csgraph

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


# ---------------------------------------------------------------------------- 减面


def _collapse_parents(n: int, collapses: np.ndarray) -> np.ndarray:
    """`collapses[i] = [保留, 被折叠]`：返回每个顶点被折叠进的顶点（没被折叠的指向自己）。"""
    parent = np.arange(n, dtype=np.int64)
    c = np.asarray(collapses, np.int64).reshape(-1, 2)
    parent[c[:, 1]] = c[:, 0]  # 每个顶点最多被折叠一次
    return parent


def _roots(parent: np.ndarray) -> np.ndarray:
    """并查集的根：反复取 parent[parent] 直到不变（折叠链长度有限）。"""
    while True:
        nxt = parent[parent]
        if np.array_equal(nxt, parent):
            return parent
        parent = nxt


def _nondegenerate(f: np.ndarray) -> np.ndarray:
    return (f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])


def _components(n: int, faces: np.ndarray) -> np.ndarray:
    """未焊接网格按共用顶点连起来的块（一块贴图坐标连续），返回每个顶点的块编号。"""
    a = np.concatenate([faces[:, 0], faces[:, 1]])
    b = np.concatenate([faces[:, 1], faces[:, 2]])
    graph = sparse.coo_matrix((np.ones(len(a), np.int8), (a, b)), shape=(n, n))
    return csgraph.connected_components(graph, directed=False)[1].astype(np.int64)


def _corner_uv_sources(
    corners: np.ndarray,
    targets: np.ndarray,
    weld: np.ndarray,
    parent: np.ndarray,
    comp: np.ndarray,
    uv: np.ndarray,
) -> np.ndarray:
    """每个面的角取哪个原始顶点的贴图坐标。

    `corners`：这个角原来的（未焊接）顶点；`targets`：它最终并入的焊接顶点；`weld`：原始顶点 → 焊接顶点；
    `parent`：焊接顶点的折叠历史；`comp`：原始顶点所在的贴图块。

    取法：并入的焊接顶点在这个角原来那块贴图里有一份，就用那一份；否则沿折叠链从原来的顶点往上走，
    停在还在这块贴图里的最后一个顶点。同一块里有几份时（块自己和自己接上的接缝），取贴图坐标离这个角
    原来的贴图坐标最近的那份。
    """
    ncomp = int(comp.max()) + 1
    keys = weld * ncomp + comp
    order = np.argsort(keys, kind="stable")
    sorted_keys = keys[order]

    def present(w: np.ndarray, c: np.ndarray) -> np.ndarray:
        k = w * ncomp + c
        i = np.minimum(np.searchsorted(sorted_keys, k), len(sorted_keys) - 1)
        return sorted_keys[i] == k

    c = comp[corners]
    anchor = targets.copy()
    walk = np.nonzero(~present(targets, c))[0]
    cur, cw = weld[corners[walk]], c[walk]
    active = np.arange(len(walk))
    while len(active):
        nxt = parent[cur[active]]
        ok = (nxt != cur[active]) & present(nxt, cw[active])
        cur[active[ok]] = nxt[ok]
        active = active[ok]
    anchor[walk] = cur

    k = anchor * ncomp + c
    lo = np.searchsorted(sorted_keys, k, "left")
    count = np.searchsorted(sorted_keys, k, "right") - lo
    best = order[lo]
    if count.max() > 1:
        dist = np.square(uv[best] - uv[corners]).sum(1)
        for j in range(1, int(count.max())):
            more = np.nonzero(count > j)[0]
            cand = order[lo[more] + j]
            d = np.square(uv[cand] - uv[corners[more]]).sum(1)
            better = d < dist[more]
            best[more[better]] = cand[better]
            dist[more[better]] = d[better]
    return best


def _inside_floor(n: int, faces: np.ndarray) -> int:
    """边界顶点都不动时三角形数的下限：每一块至少有"边界顶点数 − 2"个面，合起来是 边界顶点数 − 2 × 块数。"""
    e = np.sort(faces[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2), axis=1)
    keys, count = np.unique(e[:, 0] * n + e[:, 1], return_counts=True)
    border = keys[count == 1]
    border_vertices = len(np.unique(np.concatenate([border // n, border % n])))
    return border_vertices - 2 * (int(_components(n, faces).max()) + 1)


def _simplify_inside(mesh: ScanMesh, target: int) -> ScanMesh:
    """第一步：边界上的顶点（接缝两侧和扫描本身的洞边）都不动，只合并块内部的顶点。

    接缝两侧都不动就不会裂开；每次折叠都在同一块里，贴图坐标直接取根的那一份。
    """
    import fast_simplification

    vertices = np.ascontiguousarray(mesh.vertices, np.float64)
    faces = np.ascontiguousarray(mesh.faces, np.int64)
    _, _, collapses = fast_simplification.simplify(
        vertices, faces, target_count=min(target, len(faces) - 1), return_collapses=True, preserve_border=True
    )
    rf = _roots(_collapse_parents(len(vertices), collapses))[faces]
    rf = rf[_nondegenerate(rf)]
    used = np.unique(rf)
    uv = None if mesh.uv is None else np.asarray(mesh.uv, np.float64)[used]
    return ScanMesh(vertices[used], np.searchsorted(used, rf), uv, mesh.texture)


def _simplify_welded(mesh: ScanMesh, max_triangles: int, target: int) -> ScanMesh:
    """第二步：位置相同的顶点焊成一个再减面，接缝成了内部边，两侧共用顶点，不会裂开（见模块说明）。"""
    import fast_simplification

    vertices = np.ascontiguousarray(mesh.vertices, np.float64)
    faces = np.ascontiguousarray(mesh.faces, np.int64)
    points, weld = np.unique(vertices, axis=0, return_inverse=True)
    weld = weld.reshape(-1).astype(np.int64)
    welded = weld[faces]
    source = np.nonzero(_nondegenerate(welded))[0]  # 焊接后退化的面（两个角在同一位置）直接去掉
    welded = np.ascontiguousarray(welded[source])
    parent = np.arange(len(points), dtype=np.int64)
    if len(welded) > target:
        _, _, collapses = fast_simplification.simplify(
            points, welded, target_count=target, return_collapses=True
        )
        parent = _collapse_parents(len(points), collapses)
    rf = _roots(parent)[welded]
    keep = _nondegenerate(rf)
    rf, source = rf[keep], source[keep]
    if len(rf) > max_triangles:
        # 极少数情况下停在目标之上：再按面数截一次（保留面积最大的面）
        a = points[rf]
        area = np.linalg.norm(np.cross(a[:, 1] - a[:, 0], a[:, 2] - a[:, 0]), axis=1)
        pick = np.sort(np.argsort(-area, kind="stable")[:max_triangles])
        rf, source = rf[pick], source[pick]
    if mesh.uv is None:
        used = np.unique(rf)
        return ScanMesh(points[used], np.searchsorted(used, rf), None, mesh.texture)
    uv = np.asarray(mesh.uv, np.float64)
    corners = faces[source].reshape(-1)
    comp = _components(len(vertices), faces)
    uv_src = _corner_uv_sources(corners, rf.reshape(-1), weld, parent, comp, uv)
    # 输出顶点按（焊接顶点，贴图坐标取自的原始顶点）拆开：接缝处位置相同、贴图坐标各取各块的
    pairs, inverse = np.unique(np.stack([rf.reshape(-1), uv_src], 1), axis=0, return_inverse=True)
    new_faces = inverse.reshape(-1, 3).astype(np.int64)
    return ScanMesh(points[pairs[:, 0]], new_faces, uv[pairs[:, 1]], mesh.texture)


def simplify_mesh(mesh: ScanMesh, max_triangles: int) -> ScanMesh:
    """减面到不超过 `max_triangles` 个三角形，保留贴图坐标（见模块说明）。

    两步都只用减面库给出的折叠历史：每个顶点并到它的根，三角面换成根的编号，去掉退化的面（与减面库自己的
    输出是同一组面）。顶点位置取根的原始位置（不用减面库挪过的"最优位置"），不会出现减面库在边界上把
    顶点挪出几十厘米形成的尖刺。先试第一步（只合并块内部，贴图坐标完全不变）：边界顶点太多、明显减不到
    上限（`_inside_floor`）或者试了减不到时，改用第二步（焊接后减面）从输入网格重新减。
    """
    if mesh.triangle_count <= max_triangles:
        return mesh
    target = max(4, int(max_triangles * 0.98))  # 留一点余量
    if target >= _inside_floor(len(mesh.vertices), np.asarray(mesh.faces, np.int64)):
        inside = _simplify_inside(mesh, target)
        if inside.triangle_count <= max_triangles:
            return inside
    return _simplify_welded(mesh, max_triangles, target)


# ---------------------------------------------------------------------------- 贴图


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
