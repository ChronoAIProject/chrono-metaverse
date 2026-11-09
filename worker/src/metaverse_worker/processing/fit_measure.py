"""测量工具（设计 6.3 第 3 步）：俯视轮廓、最小外接矩形、圆、圆角矩形、带圆弧的折线、高度峰值。

思路来自第 3 轮验证（`spikes/parametric/r3/contour.py` 的截面轮廓），但目标不同：这里只"测量"，
最后都落到 SHAPES 的常见形状上——圆、圆角矩形（`fillets`）、两头半圆的跑道形、带圆弧（`arcs`）的折线；
直边接近坐标轴时取正，坐标保持连续值，不吸附网格。

坐标约定：二维点是 (x, z)；轮廓按数学意义逆时针（有向面积为正），与 SHAPES 的 `outline` 一致。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy import ndimage
from scipy.spatial import ConvexHull

from .. import shapes as sh

# ---------------------------------------------------------------------------- 坐标系


def yaw_rotate(xz: np.ndarray, yaw_deg: float) -> np.ndarray:
    """局部 → 世界的旋转（SHAPES 的 Ry）：x' = x·cos + z·sin，z' = −x·sin + z·cos。"""
    a = math.radians(yaw_deg)
    c, s = math.cos(a), math.sin(a)
    return np.c_[xz[:, 0] * c + xz[:, 1] * s, -xz[:, 0] * s + xz[:, 1] * c]


def to_local(P: np.ndarray, origin: np.ndarray, yaw_deg: float) -> np.ndarray:
    """世界点 → 物体局部（原点 origin = [x, 地面 y, z]，偏航 yaw）。"""
    d = P - origin
    xz = yaw_rotate(d[:, [0, 2]], -yaw_deg)
    return np.c_[xz[:, 0], d[:, 1], xz[:, 1]]


def dirs_to_local(N: np.ndarray, yaw_deg: float) -> np.ndarray:
    xz = yaw_rotate(N[:, [0, 2]], -yaw_deg)
    return np.c_[xz[:, 0], N[:, 1], xz[:, 1]]


def to_world(L: np.ndarray, origin: np.ndarray, yaw_deg: float) -> np.ndarray:
    xz = yaw_rotate(L[:, [0, 2]], yaw_deg)
    return np.c_[xz[:, 0], L[:, 1], xz[:, 1]] + origin


# ---------------------------------------------------------------------------- 矩形、圆


@dataclass
class Rect:
    center: np.ndarray  # (x, z)
    size: tuple[float, float]  # 沿局部 x、局部 z
    yaw: float  # 度：局部 → 世界

    @property
    def long_short(self) -> tuple[float, float]:
        return max(self.size), min(self.size)


def min_area_rect(xz: np.ndarray, *, prefer: float | None = None) -> Rect:
    """凸包旋转卡壳求最小面积外接矩形。局部 x 取长边方向；`prefer` 是偏好的偏航（度，例如墙的方向），
    面积相差不到 3% 时取最接近它的方向（轴向规整）。"""
    pts = np.asarray(xz, float)
    if len(pts) < 3 or np.ptp(pts[:, 0]) < 1e-6 or np.ptp(pts[:, 1]) < 1e-6:
        lo, hi = pts.min(0), pts.max(0)
        return Rect((lo + hi) / 2, (float(max(hi[0] - lo[0], 1e-3)), float(max(hi[1] - lo[1], 1e-3))), 0.0)
    try:
        hull = pts[ConvexHull(pts).vertices]
    except Exception:
        hull = pts
    cands = []
    for i in range(len(hull)):
        e = hull[(i + 1) % len(hull)] - hull[i]
        if np.hypot(*e) < 1e-9:
            continue
        cands.append(math.degrees(math.atan2(e[1], e[0])) % 90.0)
    if prefer is not None:
        cands += [(-prefer) % 90.0]
    best = None
    results = []
    for ang in cands:
        # 旋转 −ang 让这条边平行于 x 轴
        loc = yaw_rotate(hull, ang)
        lo, hi = loc.min(0), loc.max(0)
        area = (hi[0] - lo[0]) * (hi[1] - lo[1])
        results.append((area, ang, lo, hi))
    amin = min(r[0] for r in results)
    for area, ang, lo, hi in results:
        if area > amin * 1.03:
            continue
        key = 0.0 if prefer is None else abs(((ang + prefer) + 45) % 90 - 45)
        cand = (key if prefer is not None else area, ang, lo, hi)
        if best is None or cand[0] < best[0]:
            best = cand
    _, ang, lo, hi = best
    w, d = hi[0] - lo[0], hi[1] - lo[1]
    c_loc = (lo + hi) / 2
    yaw = -ang  # 局部轴相对世界转了 ang；SHAPES 的偏航方向与数学角相反
    center = yaw_rotate(c_loc[None], yaw)[0]
    if d > w:  # 局部 x 取长边
        yaw -= 90.0
        w, d = d, w
    yaw = ((yaw + 180.0) % 360.0) - 180.0
    return Rect(center, (float(w), float(d)), float(yaw))


def fit_circle(xz: np.ndarray) -> tuple[np.ndarray, float, float]:
    """代数最小二乘圆（Kasa）：返回 (圆心, 半径, 残差均方根)。"""
    x, z = xz[:, 0], xz[:, 1]
    A = np.c_[2 * x, 2 * z, np.ones(len(x))]
    b = x * x + z * z
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    c = sol[:2]
    r = math.sqrt(max(sol[2] + c @ c, 1e-12))
    res = np.hypot(x - c[0], z - c[1]) - r
    return c, r, float(np.sqrt(np.mean(res * res)))


def rounded_rect_distance(xz: np.ndarray, half: tuple[float, float], r: float) -> np.ndarray:
    """点到圆角矩形边界的距离（矩形局部坐标，中心在原点）。"""
    qx = np.abs(xz[:, 0]) - (half[0] - r)
    qz = np.abs(xz[:, 1]) - (half[1] - r)
    outside = np.hypot(np.maximum(qx, 0), np.maximum(qz, 0)) + np.minimum(np.maximum(qx, qz), 0)
    return np.abs(outside - r)


# ---------------------------------------------------------------------------- 俯视占用与轮廓


@dataclass
class Mask2D:
    mask: np.ndarray  # [z, x]
    x0: float
    z0: float
    cell: float

    def centers(self) -> np.ndarray:
        zz, xx = np.nonzero(self.mask)
        return np.c_[self.x0 + (xx + 0.5) * self.cell, self.z0 + (zz + 0.5) * self.cell]

    @property
    def area(self) -> float:
        return float(self.mask.sum() * self.cell * self.cell)


def occupancy(xz: np.ndarray, cell: float, close: int = 2, pad: int = 4, fill: bool = True) -> Mask2D:
    x0 = float(xz[:, 0].min()) - pad * cell
    z0 = float(xz[:, 1].min()) - pad * cell
    nx = int((xz[:, 0].max() - x0) / cell) + pad + 1
    nz = int((xz[:, 1].max() - z0) / cell) + pad + 1
    m = np.zeros((nz, nx), bool)
    m[((xz[:, 1] - z0) / cell).astype(int), ((xz[:, 0] - x0) / cell).astype(int)] = True
    if close:
        m = ndimage.binary_closing(m, iterations=close)
    if fill:
        m = ndimage.binary_fill_holes(m)
    return Mask2D(m, x0, z0, cell)


def largest(mask: np.ndarray) -> np.ndarray:
    lab, n = ndimage.label(mask)
    if n <= 1:
        return mask
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    return lab == int(np.argmax(sizes))


def trace_contour(m: Mask2D) -> np.ndarray | None:
    """最大连通区域的外轮廓（格子边界），逆时针，世界单位。捏合点（只在角上相接）时返回 None。"""
    region = ndimage.binary_fill_holes(largest(m.mask))
    if not region.any():
        return None
    H, W = region.shape
    padded = np.zeros((H + 2, W + 2), bool)
    padded[1:-1, 1:-1] = region
    edges: dict[tuple[int, int], tuple[int, int]] = {}
    zs, xs = np.nonzero(padded)
    for z, x in zip(zs.tolist(), xs.tolist(), strict=True):
        gx, gz = x - 1, z - 1
        if not padded[z - 1, x]:
            edges[(gx, gz)] = (gx + 1, gz)
        if not padded[z, x + 1]:
            edges[(gx + 1, gz)] = (gx + 1, gz + 1)
        if not padded[z + 1, x]:
            edges[(gx + 1, gz + 1)] = (gx, gz + 1)
        if not padded[z, x - 1]:
            edges[(gx, gz + 1)] = (gx, gz)
    if not edges:
        return None
    start = min(edges)
    loop = [start]
    cur = edges[start]
    guard = 0
    while cur != start and guard <= len(edges):
        loop.append(cur)
        nxt = edges.get(cur)
        if nxt is None:
            return None
        cur = nxt
        guard += 1
    if cur != start or len(loop) < 4:
        return None
    pts = np.array(loop, float) * m.cell + [m.x0, m.z0]
    if sh.signed_area(pts.tolist()) < 0:
        pts = pts[::-1]
    return pts


def smooth_contour(pts: np.ndarray, spacing: float, window: int = 5) -> np.ndarray:
    """按弧长等距重采样，再做首尾相接的滑动平均（去掉格子的台阶）。"""
    closed = np.vstack([pts, pts[:1]])
    seg = np.hypot(*np.diff(closed, axis=0).T)
    s = np.r_[0, np.cumsum(seg)]
    total = s[-1]
    n = max(8, int(total / spacing))
    t = np.linspace(0, total, n, endpoint=False)
    res = np.c_[np.interp(t, s, closed[:, 0]), np.interp(t, s, closed[:, 1])]
    if window > 1:
        k = np.ones(window) / window
        ext = np.vstack([res[-window:], res, res[:window]])
        res = np.c_[np.convolve(ext[:, 0], k, "same"), np.convolve(ext[:, 1], k, "same")][window:-window]
    return res


def _dp(points: np.ndarray, tol: float) -> list[int]:
    """开放折线的道格拉斯–普克，返回保留点的下标。"""
    n = len(points)
    if n < 3:
        return list(range(n))
    keep = [0, n - 1]
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        p0, p1 = points[a], points[b]
        d = p1 - p0
        length = math.hypot(*d)
        seg = points[a + 1 : b]
        if length < 1e-12:
            dist = np.hypot(*(seg - p0).T)
        else:
            dist = np.abs(d[0] * (seg[:, 1] - p0[1]) - d[1] * (seg[:, 0] - p0[0])) / length
        k = int(np.argmax(dist))
        if dist[k] > tol:
            m = a + 1 + k
            keep.append(m)
            stack.append((a, m))
            stack.append((m, b))
    return sorted(set(keep))


def contour_of(xz: np.ndarray, cell: float, close: int = 2) -> np.ndarray | None:
    m = occupancy(xz, cell, close=close)
    c = trace_contour(m)
    if c is None:
        try:
            hull = ConvexHull(xz)
            c = xz[hull.vertices]
        except Exception:
            return None
    return smooth_contour(c, cell, 5)


# ---------------------------------------------------------------------------- 轮廓拟合


@dataclass
class OutlineFit:
    kind: str  # circle | rect | poly
    outline: dict[str, Any]  # SHAPES 轮廓（局部坐标）
    rmse: float
    info: dict[str, Any]


def _rect_outline(half: tuple[float, float], r: float, cx: float = 0.0, cz: float = 0.0) -> dict[str, Any]:
    hx, hz = half
    pts = [(cx - hx, cz - hz), (cx + hx, cz - hz), (cx + hx, cz + hz), (cx - hx, cz + hz)]
    fillets = [{"at": i, "radius": r} for i in range(4)] if r > 0.004 else None
    return sh.outline(pts, fillets=fillets)


def fit_outline(contour: np.ndarray, tol: float, *, allow_circle: bool = True) -> OutlineFit:
    """局部坐标里的轮廓 → 常见形状：圆 → 圆角矩形（含跑道形）→ 带圆弧的折线。"""
    pts = np.asarray(contour, float)
    area = abs(sh.signed_area(pts.tolist()))
    if allow_circle and len(pts) >= 8:
        c, r, rmse = fit_circle(pts)
        if rmse < max(tol, 0.02 * r) and r > 0.02:
            # 四段四分之一圆弧（SHAPES 轮廓至少要 3 个点）
            outline = {
                "points": [
                    [sh.r4(c[0] + r), sh.r4(c[1])],
                    [sh.r4(c[0]), sh.r4(c[1] + r)],
                    [sh.r4(c[0] - r), sh.r4(c[1])],
                    [sh.r4(c[0]), sh.r4(c[1] - r)],
                ],
                "arcs": [{"from": i, "bulge": sh.r4(math.tan(math.pi / 8), 6)} for i in range(4)],
            }
            return OutlineFit("circle", outline, rmse, {"center": c.tolist(), "radius": r})
    # 圆角矩形：轴向（局部坐标已对齐物体的主方向）
    lo, hi = pts.min(0), pts.max(0)
    half = ((hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2)
    ctr = (lo + hi) / 2
    deficit = max(0.0, 4 * half[0] * half[1] - area)
    r = min(math.sqrt(deficit / (4 - math.pi)), min(half))
    d = rounded_rect_distance(pts - ctr, half, r)
    rmse = float(np.sqrt(np.mean(d * d)))
    if rmse < tol * 1.2 and np.percentile(d, 95) < tol * 3:
        return OutlineFit(
            "rect",
            _rect_outline(half, r, ctr[0], ctr[1]),
            rmse,
            {"half": half, "radius": r, "center": ctr.tolist()},
        )
    return OutlineFit("poly", poly_outline(pts, tol), rmse, {})


def poly_outline(pts: np.ndarray, tol: float, *, snap_deg: float = 4.0) -> dict[str, Any]:
    """一般轮廓：道格拉斯–普克简化，连续几段同向小转角换成圆弧，接近坐标轴的直边取正。"""
    n = len(pts)
    # 从转角最大的点切开，圆弧不会跨过起点
    prev = np.roll(pts, 1, axis=0)
    nxt = np.roll(pts, -1, axis=0)
    d1 = pts - prev
    d2 = nxt - pts
    turn = np.abs(np.arctan2(d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0], (d1 * d2).sum(1)))
    k0 = int(np.argmax(ndimage.uniform_filter1d(turn, 5, mode="wrap")))
    pts = np.roll(pts, -k0, axis=0)
    loop = np.vstack([pts, pts[:1]])
    keep = _dp(loop, tol)[:-1]
    V = keep
    out_pts: list[tuple[float, float]] = []
    arcs: list[dict[str, Any]] = []
    i = 0
    m = len(V)
    while i < m:
        a = V[i]
        best = None
        for j in range(i + 3, m + 1):
            b = V[j] if j < m else n
            seg = loop[a : b + 1]
            chord = math.hypot(*(seg[-1] - seg[0]))
            if chord < 0.06 or len(seg) < 6:
                continue
            c, r, _ = fit_circle(seg)
            res = np.abs(np.hypot(seg[:, 0] - c[0], seg[:, 1] - c[1]) - r)
            if res.max() > tol * 1.5 or r > 5.0:
                break
            # 转向一致
            dd = np.diff(seg, axis=0)
            cr = dd[:-1, 0] * dd[1:, 1] - dd[:-1, 1] * dd[1:, 0]
            if not (np.mean(cr > 0) > 0.85 or np.mean(cr < 0) > 0.85):
                break
            best = (j, c, r)
        if best is not None:
            j, c, r = best
            b = V[j] if j < m else n
            p0, p1 = loop[a], loop[b]
            mid = loop[(a + b) // 2]
            a0 = math.atan2(p0[1] - c[1], p0[0] - c[0])
            a1 = math.atan2(p1[1] - c[1], p1[0] - c[0])
            am = math.atan2(mid[1] - c[1], mid[0] - c[0])
            ccw = ((am - a0) % (2 * math.pi)) < ((a1 - a0) % (2 * math.pi))
            sweep = (a1 - a0) % (2 * math.pi) if ccw else (a0 - a1) % (2 * math.pi)
            bulge = math.tan(sweep / 4) * (1 if ccw else -1)
            out_pts.append((float(p0[0]), float(p0[1])))
            arcs.append({"from": len(out_pts) - 1, "bulge": bulge})
            i = j
        else:
            out_pts.append((float(loop[a][0]), float(loop[a][1])))
            i += 1
    # 接近坐标轴的直边取正：两端点取同一坐标
    arr = np.array(out_pts)
    arc_from = {a["from"] for a in arcs}
    for k in range(len(arr)):
        if k in arc_from:
            continue
        p, q = arr[k], arr[(k + 1) % len(arr)]
        ang = math.degrees(math.atan2(q[1] - p[1], q[0] - p[0])) % 180
        if min(ang, 180 - ang) < snap_deg:
            zz = (p[1] + q[1]) / 2
            arr[k, 1] = arr[(k + 1) % len(arr), 1] = zz
        elif abs(ang - 90) < snap_deg:
            xx = (p[0] + q[0]) / 2
            arr[k, 0] = arr[(k + 1) % len(arr), 0] = xx
    pts_out = [tuple(p) for p in arr]
    if len(pts_out) < 3 or sh.signed_area(pts_out) <= 0:
        try:
            hull = ConvexHull(pts)
            pts_out = [tuple(p) for p in pts[hull.vertices]]
            arcs = []
        except Exception:
            lo, hi = pts.min(0), pts.max(0)
            pts_out = [(lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1])]
            arcs = []
    return sh.outline(pts_out, arcs=arcs or None)


def outline_polygon(outline: dict[str, Any]) -> np.ndarray:
    """SHAPES 轮廓展开成折线（与网格生成一致）。"""
    from .shape_mesh import expand_outline

    pts, _, _ = expand_outline(outline, True)
    return np.asarray(pts, float)


def offset_outline(outline: dict[str, Any], delta: float) -> dict[str, Any]:
    """整体向外（delta > 0）或向内偏移：展开成折线后按斜接偏移，返回只有点的轮廓。"""
    from .shape_mesh import _offset_inward

    pts = outline_polygon(outline)
    off = _offset_inward([tuple(p) for p in pts], -delta)
    return sh.outline([(float(p[0]), float(p[1])) for p in off])


def polygon_contains(poly: np.ndarray, xz: np.ndarray) -> np.ndarray:
    """偶奇规则判断点在多边形内。"""
    x, z = xz[:, 0], xz[:, 1]
    inside = np.zeros(len(xz), bool)
    n = len(poly)
    for i in range(n):
        x1, z1 = poly[i]
        x2, z2 = poly[(i + 1) % n]
        cond = (z1 > z) != (z2 > z)
        with np.errstate(divide="ignore", invalid="ignore"):
            xi = (x2 - x1) * (z - z1) / (z2 - z1 + 1e-300) + x1
        inside ^= cond & (x < xi)
    return inside


# ---------------------------------------------------------------------------- 高度


def height_peaks(
    y: np.ndarray, lo: float, hi: float, min_count: int, bin_: float = 0.01
) -> list[tuple[float, int]]:
    """直方图峰值（平滑后）：返回 [(高度, 峰附近的点数)]，按点数从多到少。"""
    if len(y) == 0 or hi <= lo:
        return []
    hist, edges = np.histogram(y, bins=np.arange(lo, hi + bin_, bin_))
    if len(hist) < 3:
        return []
    sm = np.convolve(hist, [1, 2, 3, 2, 1], "same") / 9
    out = []
    for k in range(len(sm)):
        left = sm[k - 1] if k > 0 else -1
        right = sm[k + 1] if k + 1 < len(sm) else -1
        cnt = int(hist[max(0, k - 2) : k + 3].sum())
        if sm[k] >= left and sm[k] > right and cnt >= min_count:
            out.append((float((edges[k] + edges[k + 1]) / 2), cnt))
    out.sort(key=lambda t: -t[1])
    return out


def robust_range(v: np.ndarray, lo: float = 2, hi: float = 98) -> tuple[float, float]:
    if len(v) == 0:
        return 0.0, 0.0
    a, b = np.percentile(v, [lo, hi])
    return float(a), float(b)


def mask_iou(outline: dict[str, Any], m: Mask2D) -> float:
    """轮廓（展开后的折线）与俯视占用的交并比。"""
    poly = outline_polygon(outline)
    nz, nx = m.mask.shape
    gz, gx = np.mgrid[0:nz, 0:nx]
    centers = np.c_[m.x0 + (gx.ravel() + 0.5) * m.cell, m.z0 + (gz.ravel() + 0.5) * m.cell]
    inside = polygon_contains(poly, centers).reshape(nz, nx)
    union = (inside | m.mask).sum()
    return float((inside & m.mask).sum() / union) if union else 0.0


def fit_footprint(
    xz: np.ndarray,
    tol: float,
    *,
    cell: float | None = None,
    allow_circle: bool = True,
    mask: Mask2D | None = None,
) -> OutlineFit:
    """俯视占用 → 轮廓：先按 `fit_outline`（圆 / 圆角矩形 / 带圆弧的折线），与占用的交并比不到 0.8 时
    退回凸包或外接框里交并比最高的那个。"""
    size = float(np.ptp(xz, axis=0).max())
    cell = cell or (0.01 if size < 1.0 else 0.02)
    m = mask if mask is not None else occupancy(xz, cell, close=2)
    cands: list[OutlineFit] = []
    cont = trace_contour(m)
    if cont is not None and len(cont) >= 8:
        cands.append(fit_outline(smooth_contour(cont, m.cell, 5), tol, allow_circle=allow_circle))
    try:
        hull = xz[ConvexHull(xz).vertices]
        keep = _dp(np.vstack([hull, hull[:1]]), tol)[:-1]
        hp = hull[keep] if len(keep) >= 3 else hull
        cands.append(OutlineFit("hull", sh.outline([tuple(p) for p in hp]), 0.0, {}))
    except Exception:
        pass
    lo, hi = np.percentile(xz, 1, axis=0), np.percentile(xz, 99, axis=0)
    half = (max((hi[0] - lo[0]) / 2, 0.01), max((hi[1] - lo[1]) / 2, 0.01))
    ctr = (lo + hi) / 2
    info = {"half": half, "radius": 0.0, "center": ctr.tolist()}
    cands.append(OutlineFit("rect", _rect_outline(half, 0.0, ctr[0], ctr[1]), 0.0, info))
    best = None
    for c in cands:
        try:
            if sh.signed_area(c.outline["points"]) <= 0:
                continue
            iou = mask_iou(c.outline, m)
        except Exception:
            continue
        c.info["iou"] = iou
        if iou >= 0.8:
            return c
        if best is None or iou > best.info["iou"]:
            best = c
    return best if best is not None else cands[-1]
