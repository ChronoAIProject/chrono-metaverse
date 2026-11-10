"""前台（接待台）的多面体拟合（设计 6.3 第 3 步"大棱角和弧度"）。

前台在扫描里是一圈外壳（白色的折面立面，顶上一块台面）围着里面的工作台面。这里不再按高度堆盒子，
而是按设计师画前台的方式：

1. **俯视轮廓**：整个前台俯视占用的外轮廓，道格拉斯–普克简化后逐边拟直线，接近坐标轴的取正，
   几乎共线的合并，太短的边去掉，顶点取相邻两条直线的交点（角点干净）；
2. **立面**：每条边外侧朝外的点（水平法线与边的外法线一致）给出这条边立面的顶高和剖面
   （各高度上相对轮廓的外扩量）；顶高明显高于工作台面的边是外壳，相邻、顶高相近的边连成一段
   （例如左侧矮的翼、右侧高的主体）；
3. **外壳**：每段是一条带状多边形（外边沿轮廓，内边向里收进外壳的厚度），在地面、折线、顶面几个高度上
   按剖面整体外扩或内收，用截面点一一对应的 `loft` 放样，倾斜的折面自然出来；
   底部颜色明显更深的（踢脚线）单独一段；
4. **台面**：外壳顶上单独一块薄的 `extrude`，带小圆角，略微挑出；
5. **工作台面**：外壳里面朝上的点最多的高度上的一块薄板（轮廓同样规整）；
6. **剩下的东西**（工作区里的显示器、椅子、打印机）：离以上模型远、又不在外壳带里的点连成块，
   大的几块各用一个圆角盒。

每段都偏向纯色（部件声明 `prefer: color`）：前台主体是白色的，只有确实有图案的面才会烘焙贴图。
拟合不出外壳（没有明显高于工作台面的立面）时返回 None，由调用方退回分层挤出。
"""

from __future__ import annotations

import itertools
import json
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy import ndimage

from .. import shapes as sh
from .fit_measure import (
    Mask2D,
    _dp,
    _inset,
    height_peaks,
    largest,
    min_area_rect,
    occupancy,
    smooth_contour,
    trace_contour,
    yaw_rotate,
)
from .fit_segment import voxel_components
from .fit_templates import Local, part
from .fit_texture import SurfaceIndex, luminance, strip_parts
from .shape_mesh import build_parts, merge_meshes

# ---------------------------------------------------------------------------- 规整的多边形


def _line_fit(pts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """总体最小二乘直线：返回 (线上一点, 单位方向)。"""
    c = pts.mean(0)
    _, _, vt = np.linalg.svd(pts - c, full_matrices=False)
    return c, vt[0]


def _intersect(p1, d1, p2, d2) -> np.ndarray | None:
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(den) < 1e-9:
        return None
    t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den
    return np.asarray(p1) + t * np.asarray(d1)


def _angle_between(d1, d2) -> float:
    """两条直线的夹角（度，0–90，不分方向）。"""
    c = abs(float(np.dot(d1, d2)))
    return math.degrees(math.acos(min(1.0, c)))


def regular_polygon(
    contour: np.ndarray, tol: float, *, snap_deg: float = 5.0, merge_deg: float = 8.0, min_edge: float = 0.08
) -> np.ndarray | None:
    """闭合轮廓 → 规整的多边形（逆时针）：道格拉斯–普克找角点，每条边对它覆盖的轮廓点拟合直线，
    接近坐标轴（`snap_deg` 以内）的取正，相邻夹角小于 `merge_deg` 的合并，短于 `min_edge` 的边去掉，
    顶点是相邻直线的交点。结果不是简单多边形时返回 None。"""
    pts = np.asarray(contour, float)
    n = len(pts)
    if n < 8:
        return None
    # 从离重心最远的点切开（一定是角点附近），简化结果不依赖轮廓的起点
    k0 = int(np.argmax(np.hypot(*(pts - pts.mean(0)).T)))
    pts = np.roll(pts, -k0, axis=0)
    loop = np.vstack([pts, pts[:1]])
    keep = _dp(loop, tol)
    if len(keep) < 4:
        return None
    # 每条边：覆盖的轮廓点（去掉两头各 15%，角上的圆滑过渡不参与）拟合直线
    lines = []
    for a, b in itertools.pairwise(keep):
        seg = loop[a : b + 1]
        m = len(seg)
        lo, hi = int(0.15 * m), max(int(0.85 * m), int(0.15 * m) + 2)
        core = seg[lo:hi] if hi - lo >= 2 else seg
        c, d = _line_fit(core)
        if np.dot(d, seg[-1] - seg[0]) < 0:
            d = -d
        lines.append([c, d, float(np.hypot(*(seg[-1] - seg[0])))])
    for ln in lines:
        ang = math.degrees(math.atan2(ln[1][1], ln[1][0]))
        for axis in (0.0, 90.0, 180.0, -90.0, -180.0):
            if abs(ang - axis) < snap_deg:
                r = math.radians(axis)
                ln[1] = np.array([math.cos(r), math.sin(r)])
                break

    def vertices(ls):
        out = []
        for i in range(len(ls)):
            p = _intersect(ls[i - 1][0], ls[i - 1][1], ls[i][0], ls[i][1])
            out.append(p)
        return out

    changed = True
    guard = 0
    while changed and len(lines) >= 3 and guard < 50:
        guard += 1
        changed = False
        # 几乎共线的相邻边合并（按长度加权的方向，过两条线的加权中点）
        for i in range(len(lines)):
            a, b = lines[i - 1], lines[i]
            if _angle_between(a[1], b[1]) < merge_deg and np.dot(a[1], b[1]) > 0:
                w = a[2] + b[2]
                d = a[1] * a[2] + b[1] * b[2]
                d = d / np.hypot(*d)
                c = (a[0] * a[2] + b[0] * b[2]) / w
                lines[i - 1] = [c, d, w]
                del lines[i]
                changed = True
                break
        if changed or len(lines) < 3:
            continue
        vs = vertices(lines)
        if any(v is None for v in vs):
            return None
        lens = [float(np.hypot(*(vs[(i + 1) % len(vs)] - vs[i]))) for i in range(len(vs))]
        # 边 i 是从顶点 i（线 i−1 与线 i 的交点）到顶点 i+1：短边去掉
        for i, ln in enumerate(lens):
            if ln < min_edge:
                del lines[i]
                changed = True
                break
    if len(lines) < 3:
        return None
    vs = vertices(lines)
    if any(v is None for v in vs):
        return None
    poly = np.array(vs)
    if not _simple(poly) or sh.signed_area(poly.tolist()) <= 0:
        return None
    # 交点跑得太远（几乎平行的相邻边）：不规整
    span = np.ptp(pts, axis=0).max()
    if np.abs(poly - pts.mean(0)).max() > span:
        return None
    return poly


def _simple(poly: np.ndarray) -> bool:
    """多边形不自交（非相邻边两两不相交）。"""
    n = len(poly)

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            c, d = poly[j], poly[(j + 1) % n]
            d1, d2 = cross(a, b, c), cross(a, b, d)
            d3, d4 = cross(c, d, a), cross(c, d, b)
            if d1 * d2 < 0 and d3 * d4 < 0:
                return False
    return True


def mask_polygon(m: Mask2D, tol: float, **kw) -> np.ndarray | None:
    cont = trace_contour(m)
    if cont is None or len(cont) < 8:
        return None
    sc = _inset(smooth_contour(cont, m.cell, 3), m.cell / 2)
    return regular_polygon(sc, tol, **kw)


# ---------------------------------------------------------------------------- 立面


@dataclass
class Edge:
    a: np.ndarray
    b: np.ndarray
    n: np.ndarray  # 外法线
    count: int = 0
    top: float = 0.0
    cover: float = 0.0  # 立面上半部分（顶高一半以上）的点沿边铺开的比例（10 格里有点的格数）
    t: np.ndarray = field(default_factory=lambda: np.zeros(0))  # 立面点沿边的位置（0–1）
    y: np.ndarray = field(default_factory=lambda: np.zeros(0))
    s: np.ndarray = field(default_factory=lambda: np.zeros(0))
    lum: np.ndarray = field(default_factory=lambda: np.zeros(0))

    @property
    def length(self) -> float:
        return float(np.hypot(*(self.b - self.a)))


def _edge_frame(poly: np.ndarray) -> list[Edge]:
    out = []
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        d = (b - a) / max(np.hypot(*(b - a)), 1e-9)
        out.append(Edge(a, b, np.array([d[1], -d[0]])))
    return out


def facade_points(o: Local, e: Edge, reach: float = 0.3) -> np.ndarray:
    """这条边外侧朝外的点：水平法线与外法线夹角 40° 以内，离边 `reach` 以内，在边的中间 90% 范围里。"""
    ab = e.b - e.a
    t = ((o.xz - e.a) @ ab) / max(ab @ ab, 1e-12)
    s = (o.xz - e.a) @ e.n
    nh = o.N[:, [0, 2]]
    ln = np.hypot(nh[:, 0], nh[:, 1])
    facing = (nh @ e.n) > 0.75 * np.maximum(ln, 1e-9)
    return (t > 0.05) & (t < 0.95) & (np.abs(s) < reach) & (ln > 0.6) & facing


def measure_edges(o: Local, poly: np.ndarray) -> list[Edge]:
    edges = _edge_frame(poly)
    lum = luminance(o.C)
    for e in edges:
        m = facade_points(o, e)
        e.count = int(m.sum())
        if e.count:
            ab = e.b - e.a
            e.t = ((o.xz[m] - e.a) @ ab) / max(ab @ ab, 1e-12)
            e.y = o.y[m]
            e.s = (o.xz[m] - e.a) @ e.n
            e.lum = lum[m]
            e.top = float(np.percentile(e.y, 99))
            upper = e.y > 0.5 * e.top
            hist, _ = np.histogram(e.t[upper], bins=10, range=(0.0, 1.0))
            e.cover = float((hist >= 3).mean())
    return edges


# ---------------------------------------------------------------------------- 外壳


@dataclass
class Run:
    """外壳的一段：轮廓上连续的几条边（下标），顶高相近。"""

    edges: list[int]
    top: float


def shell_runs(
    edges: list[Edge],
    desk: float | None,
    *,
    min_rise: float = 0.1,
    split: float = 0.1,
    min_length: float = 0.5,
) -> list[Run]:
    """顶高明显高于工作台面、立面点够多、而且立面沿边铺开（上半部分的点覆盖六成以上的长度，
    外壳端头的截面落在相邻边上不算）的边是外壳；相邻的连成一段，顶高与这一段的平均相差超过 `split`
    的分开；总长不到 `min_length` 的段（工作区里的打印机、柜子露出来的一条边）不算外壳。"""
    floor_top = (desk if desk is not None else 0.0) + min_rise
    shell = [
        e.count >= max(40, 60 * e.length)
        and e.top >= max(0.5, floor_top)
        and e.length >= 0.2
        and e.cover >= 0.6
        for e in edges
    ]
    n = len(edges)
    if not any(shell):
        return []
    # 从一条非外壳边之后开始数，环上的段不会被起点切断
    start = 0 if all(shell) else next(i for i in range(n) if not shell[i - 1] and shell[i])
    groups: list[list[int]] = []
    cur: list[int] = []
    for k in range(n):
        i = (start + k) % n
        if not shell[i]:
            if cur:
                groups.append(cur)
                cur = []
            continue
        if cur and abs(edges[i].top - float(np.mean([edges[j].top for j in cur]))) > split:
            groups.append(cur)
            cur = []
        cur.append(i)
    if cur:
        groups.append(cur)
    runs = []
    for g in groups:
        if sum(edges[i].length for i in g) < min_length:
            continue
        w = np.array([edges[i].count for i in g], float)
        runs.append(Run(g, float(np.average([edges[i].top for i in g], weights=w))))
    return runs


def _cap_dir(edges: list[Edge], i_edge: int, at_start: bool, neighbor_shell: bool) -> np.ndarray:
    """段端头截面线的方向（过端点）：挨着另一段外壳时取角平分线；挨着普通边、夹角超过 30° 时沿那条边；
    否则垂直于本段的边。"""
    e = edges[i_edge]
    d = (e.b - e.a) / e.length
    nb = edges[(i_edge - 1) % len(edges)] if at_start else edges[(i_edge + 1) % len(edges)]
    dn = (nb.b - nb.a) / max(nb.length, 1e-9)
    if neighbor_shell:
        m = e.n + nb.n
        if np.hypot(*m) > 1e-6:
            return m / np.hypot(*m)
    ang = math.degrees(math.acos(min(1.0, abs(float(d @ dn)))))
    if not neighbor_shell and ang > 30:
        return dn
    return e.n.copy()


def strip_polygon(edges: list[Edge], run: Run, depth: float, shell_flags: list[bool]) -> np.ndarray | None:
    """一段外壳的带状多边形（逆时针）：外边是轮廓上的这几条边，内边是它们向里平移 depth 的直线，
    端头按 `_cap_dir`。"""
    n = len(edges)
    ids = run.edges
    outer = [edges[ids[0]].a] + [edges[i].b for i in ids]
    lines = [(edges[i].a - depth * edges[i].n, (edges[i].b - edges[i].a) / edges[i].length) for i in ids]
    inner = [_intersect(outer[0], _cap_dir(edges, ids[0], True, shell_flags[(ids[0] - 1) % n]), *lines[0])]
    for k in range(len(ids) - 1):
        inner.append(_intersect(*lines[k], *lines[k + 1]))
    inner.append(
        _intersect(outer[-1], _cap_dir(edges, ids[-1], False, shell_flags[(ids[-1] + 1) % n]), *lines[-1])
    )
    if any(q is None for q in inner):
        return None
    pts = np.array(outer + inner[::-1])
    # 端头截面线和内边几乎平行时交点会跑很远
    if (
        np.hypot(*(pts - pts.mean(0)).T).max()
        > 2 * np.hypot(*(np.array(outer) - np.mean(outer, 0)).T).max() + depth
    ):
        return None
    if not _simple(pts) or sh.signed_area(pts.tolist()) <= 0:
        return None
    return pts


def similarity_for(
    edges: list[Edge], ids: list[int], center: np.ndarray, s: float
) -> tuple[float, np.ndarray]:
    """让这几条边的直线都向外平移 s 的相似变换 X → g + λ(X − g) + t（不转动，所以放样的各截面形状相似，
    点一一对应，不会扭）：解 (λ−1)·c_j + n_j·t = s，c_j 是 g 到第 j 条直线的距离；
    一两条边时 λ 取 1（纯平移），三条边正好解出，更多时最小二乘。"""
    A = np.array([[float(edges[i].n @ (edges[i].a - center)), edges[i].n[0], edges[i].n[1]] for i in ids])
    b = np.full(len(ids), s)
    if len(ids) <= 2:
        t, *_ = np.linalg.lstsq(A[:, 1:], b, rcond=None)
        return 1.0, t
    u, *_ = np.linalg.lstsq(A, b, rcond=None)
    return 1.0 + float(u[0]), u[1:]


def transform_polygon(pts: np.ndarray, center: np.ndarray, lam: float, t: np.ndarray) -> np.ndarray:
    return center + lam * (pts - center) + t


def fit_profile(y: np.ndarray, s: np.ndarray, y0: float, y1: float) -> list[tuple[float, float]]:
    """立面剖面：s(y) 用连续的折线拟合（两点或三点），中间的折点在 y0–y1 之间搜索；截尾最小二乘。
    折线比直线好得不多（平均残差改善不到 20% 或折点处偏离直线不到 1.5 厘米）时用直线。"""

    def solve(knots):
        knots = np.asarray(knots, float)
        B = np.zeros((len(y), len(knots)))
        for k in range(len(knots)):
            if k > 0:
                a, c = knots[k - 1], knots[k]
                m = (y >= a) & (y <= c)
                B[m, k] = (y[m] - a) / (c - a)
            if k < len(knots) - 1:
                a, c = knots[k], knots[k + 1]
                m = (y >= a) & (y <= c)
                B[m, k] = (c - y[m]) / (c - a)
        B[y < knots[0], 0] = 1.0
        B[y > knots[-1], -1] = 1.0
        w = np.ones(len(y))
        coef = np.zeros(len(knots))
        for _ in range(4):
            Bw = B * w[:, None]
            coef = np.linalg.solve(Bw.T @ B + 1e-6 * np.eye(len(knots)), Bw.T @ s)
            r = np.abs(B @ coef - s)
            cut = max(0.01, float(np.percentile(r, 80)))
            w = np.where(r <= cut, 1.0, cut / np.maximum(r, 1e-9))
        r = np.abs(B @ coef - s)
        return coef, float(np.mean(np.minimum(r, 0.05)))

    line, e_line = solve([y0, y1])
    best = ([(y0, float(line[0])), (y1, float(line[1]))], e_line)
    for yk in np.arange(y0 + 0.12, y1 - 0.12 + 1e-9, 0.02):
        coef, e = solve([y0, yk, y1])
        mid_line = line[0] + (line[1] - line[0]) * (yk - y0) / (y1 - y0)
        if e < best[1] and e < 0.8 * e_line and abs(coef[1] - mid_line) > 0.015:
            best = ([(y0, float(coef[0])), (float(yk), float(coef[1])), (y1, float(coef[2]))], e)
    return best[0]


# ---------------------------------------------------------------------------- 测量


def desk_level(o: Local, lo: float = 0.55, hi: float = 0.95) -> float | None:
    """工作台面的高度：朝上的点在 lo–hi 之间最多的高度峰。"""
    up = o.N[:, 1] > 0.85
    pk = height_peaks(o.y[up], lo, hi, max(30, int(0.01 * len(o.y))))
    return pk[0][0] if pk else None


def strip_depth(o: Local, edges: list[Edge], run: Run, desk: float | None) -> float:
    """外壳的厚度（0.12–0.6 米）：优先看外壳的内侧面——水平法线朝里的点离外边的距离，取离外边最近的
    那个明显的峰（再往里是显示器、杂物）；内侧面看不到时看顶面（朝上、在顶高附近的点）从外边往里连续有点的深度。"""
    nh = o.N[:, [0, 2]]
    ln = np.hypot(nh[:, 0], nh[:, 1])
    lo_y = (desk + 0.05) if desk is not None else 0.3
    vals = []
    for i in run.edges:
        e = edges[i]
        ab = e.b - e.a
        t = ((o.xz - e.a) @ ab) / max(ab @ ab, 1e-12)
        s = (o.xz - e.a) @ e.n
        inward = (nh @ -e.n) > 0.75 * np.maximum(ln, 1e-9)
        m = inward & (ln > 0.6) & (t > 0.1) & (t < 0.9) & (s > -0.6) & (s < -0.04)
        m &= (o.y > lo_y) & (o.y < run.top - 0.03)
        vals.append(s[m])
    s_in = np.concatenate(vals) if vals else np.zeros(0)
    if len(s_in) >= 30:
        bins = np.arange(-0.6, -0.03, 0.02)
        hist, _ = np.histogram(s_in, bins=bins)
        strong = np.nonzero(hist >= max(5, 0.3 * hist.max()))[0]
        if len(strong):
            k = int(strong.max())
            return float(np.clip(-(bins[k] + bins[k + 1]) / 2, 0.12, 0.6))
    up = (o.N[:, 1] > 0.8) & (np.abs(o.y - run.top) < 0.07)
    vals = []
    for i in run.edges:
        e = edges[i]
        ab = e.b - e.a
        t = ((o.xz[up] - e.a) @ ab) / max(ab @ ab, 1e-12)
        s = (o.xz[up] - e.a) @ e.n
        vals.append(s[(t > 0.1) & (t < 0.9) & (s > -0.7) & (s < 0.05)])
    s = np.concatenate(vals) if vals else np.zeros(0)
    if len(s) < 20:
        return 0.25
    bins = np.arange(-0.7, 0.06, 0.02)
    hist, _ = np.histogram(s, bins=bins)
    need = max(2, 0.2 * hist.max())
    k = len(hist) - 1
    while k >= 0 and hist[k] < need:  # 跳过外边上可能空着的几格
        k -= 1
    while k > 0 and (hist[k - 1] >= need or (k > 1 and hist[k - 2] >= need)):
        k -= 1
    return float(np.clip(-bins[k], 0.12, 0.6))


def plinth(y: np.ndarray, s: np.ndarray, lum: np.ndarray, top: float) -> tuple[float, float] | None:
    """踢脚线：立面从地面起连续几段（5 厘米一段）的亮度明显低于上面（不到 55%，差 35 以上），
    最高到 0.45 米。返回 (踢脚线顶高, 相对轮廓的外扩量)。"""
    upper = (y > 0.45) & (y < top - 0.08)
    if upper.sum() < 20:
        return None
    ref = float(np.median(lum[upper]))
    yc = None
    started = False
    for y0 in np.arange(0.0, 0.45, 0.05):
        m = (y >= y0) & (y < y0 + 0.05)
        if m.sum() < 8:
            if started or y0 > 0.15:
                break
            continue
        v = float(np.median(lum[m]))
        if v < 0.55 * ref and ref - v > 35:
            started = True
            yc = float(y0 + 0.05)
        else:
            break
    if yc is None or yc < 0.08:
        return None
    m = y < yc
    return yc, float(np.median(s[m]))


def cantilever(e: Edge, top: float) -> tuple[float, float] | None:
    """悬挑：沿边分 8 格，每格立面最低点的高度随位置线性变化，一头落地（≤ 8 厘米）、另一头抬高 25 厘米以上。
    返回边起点和终点处的底高（可以是负的，网格里截到地面）。"""
    if e.count < 80:
        return None
    lo_pts = []
    for k in range(8):
        a, b = k / 8, (k + 1) / 8
        m = (e.t >= a) & (e.t < b)
        if m.sum() >= 5:
            lo_pts.append(((a + b) / 2, float(np.percentile(e.y[m], 3))))
    if len(lo_pts) < 5:
        return None
    t, b = np.array(lo_pts).T
    beta, alpha = np.polyfit(t, b, 1)
    res = np.abs(alpha + beta * t - b)
    if np.median(res) > 0.08:
        return None
    b0, b1 = alpha, alpha + beta
    lo_end, hi_end = min(b0, b1), max(b0, b1)
    if lo_end > 0.08 or hi_end < 0.25 or hi_end > top - 0.15:
        return None
    return float(b0), float(b1)


# ---------------------------------------------------------------------------- 组装


def _bright(p: dict[str, Any]) -> dict[str, Any]:
    """外壳的浅色单一材质：外壳各段的立面和台面是一个材质组（取同一个颜色），
    取色时用亮的那一半（扫描里烘焙的阴影不算进颜色）。"""
    p["_part"]["albedo"] = "bright"
    p["_part"]["group"] = "shell"
    return p


def _section(pts: np.ndarray, y: float) -> dict[str, Any]:
    return {"y": sh.r4(y), "outline": sh.outline([(float(p[0]), float(p[1])) for p in pts])}


def _slab(pts: np.ndarray, y0: float, y1: float, name: str, fillet: float = 0.0) -> dict[str, Any]:
    shape = sh.extrude(
        sh.outline([(float(p[0]), float(p[1])) for p in pts]), y1 - y0, xf=sh.transform(position=[0, y0, 0])
    )
    if fillet > 0:
        shape["fillet"] = sh.r4(fillet)
    return part(shape, name, "planar", "color")


def shell_parts(edges: list[Edge], run: Run, strip: np.ndarray, name: str) -> list[dict[str, Any]]:
    """一段外壳：踢脚线（有的话）+ 立面放样 + 台面。"""
    y = np.concatenate([edges[i].y for i in run.edges])
    s = np.concatenate([edges[i].s for i in run.edges])
    lum = np.concatenate([edges[i].lum for i in run.edges])
    top = run.top
    slab_th = float(np.clip(0.04 * top, 0.025, 0.045))
    g = strip.mean(0)
    out: list[dict[str, Any]] = []
    pl = plinth(y, s, lum, top)
    y_base = 0.0
    if pl is not None:
        y_base = pl[0]
    body = (y > y_base + 0.02) & (y < top - 0.02)
    if body.sum() < 30:
        knots = [(y_base, 0.0), (top - slab_th, 0.0)]
    else:
        knots = fit_profile(y[body], s[body], y_base, top - slab_th)
    knots = [(yk, float(np.clip(sk, -0.25, 0.1))) for yk, sk in knots]
    if pl is not None:
        sp = min(float(np.clip(pl[1], -0.3, 0.05)), knots[0][1] - 0.01)
        lam, t = similarity_for(edges, run.edges, g, sp)
        out.append(_slab(transform_polygon(strip, g, lam, t), 0.0, y_base, f"{name}-plinth"))
    sections = []
    for yk, sk in knots:
        lam, t = similarity_for(edges, run.edges, g, sk)
        sections.append(_section(transform_polygon(strip, g, lam, t), yk))
    if len(sections) >= 2:
        out.append(_bright(part({"type": "loft", "sections": sections}, f"{name}-facade", "planar", "color")))
    s_top = knots[-1][1] + 0.012
    lam, t = similarity_for(edges, run.edges, g, s_top)
    top_pts = transform_polygon(strip, g, lam, t)
    out.append(_bright(_slab(top_pts, top - slab_th, top, f"{name}-top", min(0.012, slab_th / 3))))
    return out


def wing_parts(
    e: Edge, run: Run, depth: float, bottoms: tuple[float, float], name: str
) -> list[dict[str, Any]]:
    """悬挑的翼：侧面轮廓（底边从落地的一头斜向抬高的一头）沿厚度方向挤出，顶上一块台面。"""
    top = run.top
    slab_th = float(np.clip(0.04 * top, 0.025, 0.045))
    L = e.length
    b0, b1 = bottoms
    side: list[tuple[float, float]] = []  # (高度, 沿边的位置)
    if b0 <= 0 and b1 <= 0:
        side = [(0.0, 0.0), (0.0, L)]
    elif b0 <= 0:
        u0 = L * (-b0) / (b1 - b0)
        side = [(0.0, 0.0), (0.0, u0), (b1, L)]
    elif b1 <= 0:
        u1 = L * b0 / (b0 - b1)
        side = [(b0, 0.0), (0.0, u1), (0.0, L)]
    else:
        side = [(b0, 0.0), (b1, L)]
    h = top - slab_th
    pts = [*side, (h, L), (h, 0.0)]
    if sh.signed_area(pts) < 0:
        pts = pts[::-1]
    d = (e.b - e.a) / L
    yaw = math.degrees(math.atan2(d[0], d[1]))
    body = sh.extrude(
        sh.outline(pts),
        depth,
        xf=sh.transform(position=[float(e.a[0]), 0.0, float(e.a[1])], yaw=yaw, roll=90),
    )
    strip = np.array([e.a, e.b, e.b - depth * e.n, e.a - depth * e.n])
    return [
        _bright(part(body, f"{name}-body", "planar", "color")),
        _slab(strip, top - slab_th, top, f"{name}-top", min(0.01, slab_th / 3)),
    ]


def desk_parts(o: Local, desk: float, name: str = "desk") -> list[dict[str, Any]]:
    """工作台面：台面高度上朝上的点的俯视占用 → 规整的多边形，一块 3 厘米的薄板。"""
    m = (o.N[:, 1] > 0.85) & (np.abs(o.y - desk) < 0.03)
    if m.sum() < 50:
        return []
    occ = occupancy(o.xz[m], 0.03, close=3)
    occ = Mask2D(ndimage.binary_opening(largest(occ.mask), iterations=1), occ.x0, occ.z0, occ.cell)
    if occ.area < 0.1:
        return []
    size = float(np.ptp(o.xz[m], axis=0).max())
    pts = mask_polygon(occ, float(np.interp(size, [1.0, 3.0], [0.03, 0.06])))
    if pts is None:
        return []
    th = 0.03
    return [_slab(pts, desk - th, desk, name, 0.008)]


def leftover_boxes(
    o: Local,
    children: list[dict[str, Any]],
    desk: float | None,
    walls: list[tuple[Edge, float]],
    *,
    gap: float = 0.06,
    max_items: int = 6,
) -> list[dict[str, Any]]:
    """外壳和台面都没覆盖到的东西（工作区里的显示器、椅子、打印机）：离模型 `gap` 以外、
    不在外壳的带里也不在外壳外面（`walls` 是外壳的边和厚度）的点按 4 厘米体素连成块，
    大的几块各用一个圆角盒（俯视最小外接矩形，接近坐标轴时取正；底落在台面或地面上）。
    立面上拟合的残差不会变成贴在外面的盒子。"""
    probe = json.loads(json.dumps(sh.group(children)))
    strip_parts(probe)
    mesh = merge_meshes([p.mesh for p in build_parts(probe)])
    if len(mesh.indices) == 0:
        return []
    rng = np.random.default_rng(3)
    idx = np.arange(len(o.L)) if len(o.L) <= 20000 else np.sort(rng.choice(len(o.L), 20000, replace=False))
    d, _, _ = SurfaceIndex.build([mesh], spacing=0.015).query(o.L[idx], k=3)
    ok = (d > gap) & (o.y[idx] > 0.03)
    for e, depth in walls:
        ab = e.b - e.a
        t = ((o.xz[idx] - e.a) @ ab) / max(ab @ ab, 1e-12)
        s = (o.xz[idx] - e.a) @ e.n
        ok &= ~((t > -0.05) & (t < 1.05) & (s > -(depth + 0.03)))
    far = idx[ok]
    if len(far) < 50:
        return []
    lab = voxel_components(o.L[far], 0.04, conn=3)
    groups = sorted((np.nonzero(lab == k)[0] for k in np.unique(lab)), key=len, reverse=True)
    out: list[dict[str, Any]] = []
    for g in groups[:max_items]:
        if len(g) < max(60, int(0.004 * len(idx))):
            break
        P = o.L[far[g]]
        rect = min_area_rect(P[:, [0, 2]])
        yaw = rect.yaw
        diff = ((yaw + 45) % 90) - 45
        if abs(diff) < 10:
            yaw -= diff
        loc = yaw_rotate(P[:, [0, 2]], -yaw)
        lo = np.percentile(loc, 3, axis=0)
        hi = np.percentile(loc, 97, axis=0)
        y0, y1 = float(np.percentile(P[:, 1], 2)), float(np.percentile(P[:, 1], 98))
        if desk is not None and abs(y0 - desk) < 0.08:
            y0 = desk
        elif y0 < 0.12:
            y0 = 0.0
        size = np.maximum(hi - lo, 0.03)
        h = max(0.03, y1 - y0)
        c = yaw_rotate(((lo + hi) / 2)[None], yaw)[0]
        box = sh.box(
            [float(size[0]), h, float(size[1])],
            fillet=sh.r4(min(0.02, float(size.min()) / 3, h / 3)),
            xf=sh.transform(position=[float(c[0]), y0, float(c[1])], yaw=sh.r4(yaw)),
        )
        out.append(part(box, f"item-{len(out) + 1}", "planar", "color"))
    return out


def fit_counter(o: Local) -> dict[str, Any] | None:
    """前台的局部点（原点在底面中心的地面上）→ 外壳 + 台面 + 工作台面 + 杂物盒的组合；量不出外壳时 None。"""
    sel = o.y > 0.05
    if sel.sum() < 300:
        return None
    size = float(np.ptp(o.xz[sel], axis=0).max())
    m = occupancy(o.xz[sel], 0.03, close=2)
    poly = mask_polygon(m, float(np.interp(size, [1.0, 4.0], [0.03, 0.06])))
    if poly is None:
        return None
    edges = measure_edges(o, poly)
    desk = desk_level(o)
    runs = shell_runs(edges, desk)
    if not runs:
        return None
    flags = [False] * len(edges)
    for r in runs:
        for i in r.edges:
            flags[i] = True
    children: list[dict[str, Any]] = []
    walls: list[tuple[Edge, float]] = []
    for k, run in enumerate(sorted(runs, key=lambda r: -sum(edges[i].length for i in r.edges))):
        name = f"shell-{k + 1}"
        depth = strip_depth(o, edges, run, desk)
        walls.extend((edges[i], depth) for i in run.edges)
        if len(run.edges) == 1:
            e = edges[run.edges[0]]
            bottoms = cantilever(e, run.top)
            if bottoms is not None:
                children.extend(wing_parts(e, run, depth, bottoms, name))
                continue
        strip = strip_polygon(edges, run, depth, flags)
        if strip is None:
            continue
        children.extend(shell_parts(edges, run, strip, name))
    if not children:
        return None
    if desk is not None:
        children.extend(desk_parts(o, desk))
    children.extend(leftover_boxes(o, children, desk, walls))
    return sh.group(children)
