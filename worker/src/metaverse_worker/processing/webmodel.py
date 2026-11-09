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
- **贴图补边**：先按原始网格的贴图坐标三角形光栅化出"用到的纹素"（`uv_coverage`，纹素中心在三角形里），
  缩小时只平均用到的纹素（`shrink_used`，和先补边再缩小等价，原图分辨率上只按行分段算），缩小后没用到的
  纹素都换成离它最近的用到的纹素的颜色（`fill_unused`）：块与块之间的空白（Scaniverse 填的是深灰色）不会
  再被双线性过滤、逐级缩小的贴图（mipmap）和减面后略微越过块边的三角形采到。只缩不放，JPEG 质量 85
  （低细节档 80）。
- 三角形数本来就不超过上限时不减面，原样写出（贴图照样补边）。
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image
from scipy import ndimage, sparse
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


def _row_spans(
    x: np.ndarray, y: np.ndarray, r0: np.ndarray, n: np.ndarray, w: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """三角形在纹素行中心线上覆盖的纹素区间，返回 (行, 起始列, 结束列)。

    x、y 的每一行是一个三角形三个角的纹素角坐标；第 k 个三角形从第 r0[k] 行起共 n[k] 行。
    """
    tri = np.repeat(np.arange(len(x)), n)
    row = r0[tri] + np.arange(len(tri)) - np.repeat(np.cumsum(n) - n, n)
    yc = row + 0.5
    xl = np.full(len(tri), np.inf)
    xr = np.full(len(tri), -np.inf)
    for i, j in ((0, 1), (1, 2), (2, 0)):
        xa, xb, ya, yb = x[tri, i], x[tri, j], y[tri, i], y[tri, j]
        hit = (yc >= np.minimum(ya, yb)) & (yc <= np.maximum(ya, yb)) & (ya != yb)
        xi = xa + (yc - ya) * (xb - xa) / np.where(ya != yb, yb - ya, 1.0)
        xl = np.where(hit, np.minimum(xl, xi), xl)
        xr = np.where(hit, np.maximum(xr, xi), xr)
    cs = np.clip(np.ceil(xl - 0.5), 0, w)
    ce = np.clip(np.floor(xr - 0.5), -1, w - 1)
    ok = cs <= ce
    return row[ok].astype(np.int32), cs[ok].astype(np.int32), ce[ok].astype(np.int32)


def uv_coverage(
    uv: np.ndarray,
    faces: np.ndarray,
    shape: tuple[int, int],
    *,
    chunk: int = 200_000,
    band: int = 256,
    max_spans: int = 50_000_000,
) -> np.ndarray | None:
    """贴图上中心落在某个三角形（按贴图坐标）里的纹素（H×W 布尔），即"用到的纹素"。

    纹素 (列, 行) 的中心在 ((列 + 0.5) / W, (行 + 0.5) / H)。只压到边、中心在三角形外的纹素不算：它们的原色
    多半是块外的底色，双线性过滤在三角形边上会采到它们，要和块外的空白一起补成块里的颜色。做法是扫描线：
    每个三角形在每个纹素行的中心线上求出覆盖的列区间（numpy 向量化），再按行分段用差分累加标出来。
    面积为 0 或贴图坐标不是有限值的面跳过。三角形在贴图上铺得异常大（行区间总数超过 `max_spans`，正常扫描
    远不到）时返回 None，调用方就不补边。
    """
    h, w = shape
    t = np.asarray(uv, np.float64)[np.asarray(faces, np.int64)] * (w, h)
    x, y = t[..., 0], t[..., 1]
    area = (x[:, 1] - x[:, 0]) * (y[:, 2] - y[:, 0]) - (x[:, 2] - x[:, 0]) * (y[:, 1] - y[:, 0])
    ok = np.isfinite(t).all(axis=(1, 2)) & (area != 0)
    x, y = x[ok], y[ok]
    r0 = np.clip(np.ceil(y.min(1) - 0.5), 0, h).astype(np.int64)
    n = np.maximum(np.clip(np.floor(y.max(1) - 0.5), -1, h - 1).astype(np.int64) - r0 + 1, 0)
    if n.sum() > max_spans:
        return None
    mask = np.zeros((h, w), bool)
    parts = [
        _row_spans(x[i : i + chunk], y[i : i + chunk], r0[i : i + chunk], n[i : i + chunk], w)
        for i in range(0, len(x), chunk)
    ]
    if not parts:
        return mask
    row, cs, ce = (np.concatenate(p) for p in zip(*parts, strict=True))
    order = np.argsort(row, kind="stable")
    row, cs, ce = row[order], cs[order], ce[order]
    bounds = np.searchsorted(row, np.arange(0, h + band, band))
    for k, b0 in enumerate(range(0, h, band)):
        lo, hi = bounds[k], bounds[k + 1]
        if lo == hi:
            continue
        nb = min(band, h - b0)
        base = (row[lo:hi].astype(np.int64) - b0) * (w + 1)
        diff = np.bincount(base + cs[lo:hi], minlength=nb * (w + 1))
        diff -= np.bincount(base + ce[lo:hi] + 1, minlength=nb * (w + 1))
        mask[b0 : b0 + nb] = np.cumsum(diff.reshape(nb, w + 1), axis=1)[:, :w] > 0
    return mask


def shrink_used(
    texture: np.ndarray, used: np.ndarray, max_side: int, band: int = 256
) -> tuple[np.ndarray, np.ndarray]:
    """按比例缩小到长边不超过 max_side，只平均用到的纹素（盒式滤波）。

    返回 (颜色 float32 h×w×3, 权重 float32 h×w)：权重是每个新纹素里用到的原纹素占比，为 0 的纹素颜色无意义。
    按输出行分段做，原图分辨率上只有一段的浮点数组。
    """
    H, W = used.shape
    scale = max_side / max(H, W)
    if scale >= 1:
        return texture.astype(np.float32), used.astype(np.float32)
    tw, th = max(1, round(W * scale)), max(1, round(H * scale))
    sy = H / th
    color = np.empty((th, tw, 3), np.float32)
    weight = np.empty((th, tw), np.float32)
    box_filter = Image.Resampling.BOX
    for r0 in range(0, th, band):
        r1 = min(th, r0 + band)
        y0, y1 = int(np.floor(r0 * sy)), min(H, int(np.ceil(r1 * sy)))
        box = (0.0, r0 * sy - y0, float(W), r1 * sy - y0)
        m = used[y0:y1].astype(np.float32)
        weight[r0:r1] = np.asarray(Image.fromarray(m).resize((tw, r1 - r0), box_filter, box=box))
        for c in range(3):
            ch = texture[y0:y1, :, c].astype(np.float32)
            ch *= m
            color[r0:r1, :, c] = np.asarray(Image.fromarray(ch).resize((tw, r1 - r0), box_filter, box=box))
    color /= np.maximum(weight, 1e-12)[..., None]
    return color, weight


def fill_unused(color: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """把没用到的纹素（`valid` 为 False）都换成离它最近的用到的纹素的颜色（补边），返回 uint8。

    用欧氏距离变换找最近的用到的纹素：块边外面不管多远都是块自己边上的颜色，双线性过滤、逐级缩小的贴图和
    略微越过块边的三角形采到的都是块里的颜色，不会是底色，也不会混进远处别的块（推拉金字塔按粗格子取平均，
    块边外几个纹素就会混进同一个粗格子里别的块的颜色）。`color` 是 float32 时就地改写。用到的纹素保持原色；
    一个都没用到时原样返回。
    """
    color = np.asarray(color, np.float32)
    if valid.any() and not valid.all():
        hole = ~valid
        rows, cols = ndimage.distance_transform_edt(hole, return_distances=False, return_indices=True)
        color[hole] = color[rows[hole], cols[hole]]
    np.rint(color, out=color)
    return np.clip(color, 0, 255).astype(np.uint8)


def prepare_texture(texture: np.ndarray, used: np.ndarray | None, max_side: int) -> np.ndarray:
    """网页用模型的贴图：缩小到上限以内，`used` 给出时只用用到的纹素，空白处补边（见模块说明）。"""
    if used is None or used.shape != texture.shape[:2] or not used.any():
        return shrink_texture(texture, max_side)
    color, weight = shrink_used(texture, used, max_side)
    return fill_unused(color, weight > 0)


def encode_jpeg(texture: np.ndarray, quality: int) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.asarray(texture, np.uint8)).convert("RGB").save(
        buf, format="JPEG", quality=quality, optimize=True, progressive=False
    )
    return buf.getvalue()


# ---------------------------------------------------------------------------- 写出


def texture_usage(mesh: ScanMesh) -> np.ndarray | None:
    """原始网格用到的纹素（没有贴图或贴图坐标、或者贴图坐标异常时为 None，见 `uv_coverage`）。"""
    if mesh.texture is None or mesh.uv is None:
        return None
    return uv_coverage(mesh.uv, mesh.faces, mesh.texture.shape[:2])


def encode_web_model(
    simple: ScanMesh, level: WebModelLevel, name: str = "scan", used: np.ndarray | None = None
) -> WebModel:
    """把（已经减过面的）网格写成 glb：贴图缩到这一档的上限、补边，JPEG 编码后内嵌。

    `used` 是原始网格用到的纹素（`texture_usage`）；为 None 时只缩小、不补边。
    """
    image = None
    side = 0
    if simple.texture is not None and simple.uv is not None:
        tex = prepare_texture(simple.texture, used, level.max_texture_side)
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
    return encode_web_model(simplify_mesh(mesh, level.max_triangles), level, name, texture_usage(mesh))


def build_web_models(mesh: ScanMesh) -> list[WebModel]:
    """按 `WEB_MODEL_LEVELS` 生成两档。低细节档从默认档继续减面（更快，结果相近）；贴图都从原图缩小，
    用到的纹素都按原始网格算。"""
    used = texture_usage(mesh)
    out: list[WebModel] = []
    source = mesh
    for index, level in enumerate(WEB_MODEL_LEVELS):
        source = simplify_mesh(source, level.max_triangles)
        out.append(encode_web_model(source, level, name=f"scan-lod{index}", used=used))
    return out
