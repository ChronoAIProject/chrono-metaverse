"""measure：在范围内对扫描表面采样 / 求截面，输出外接框、截面轮廓、高度剖面、占用图、圆拟合、颜色。"""

from __future__ import annotations

import math
import os
import time
from collections import defaultdict

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.optimize import least_squares
from scipy.spatial import ConvexHull

from . import core as wc
from .base import from_args, resolve_box
from .core import r
from .i18n import t

# ---------------------------------------------------------------------------- 坐标系


def ry(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


class Frame:
    """输出坐标系：world = origin + Ry(yaw)·local（与 SHAPES 的 transform 相同）。不给时就是空间坐标。"""

    def __init__(self, text: str | None):
        if text:
            v = [float(x) for x in text.split(",")]
            if len(v) != 4:
                raise wc.ReconError("--frame 需要 4 个数：x,y,z,yaw")
            self.origin, self.yaw = np.array(v[:3]), v[3]
        else:
            self.origin, self.yaw = np.zeros(3), 0.0
        self.R = ry(self.yaw)
        self.active = bool(text)

    def to_local(self, P: np.ndarray) -> np.ndarray:
        return (P - self.origin) @ self.R

    def as_dict(self):
        return {"origin": r(self.origin), "yaw": self.yaw} if self.active else None


# ---------------------------------------------------------------------------- 折线


def rdp(P: np.ndarray, tol: float) -> np.ndarray:
    """Douglas–Peucker 简化（开折线，保留首尾）。"""
    if len(P) < 3:
        return P
    keep = np.zeros(len(P), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(P) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        seg = P[b] - P[a]
        L = np.linalg.norm(seg)
        Q = P[a + 1 : b] - P[a]
        d = np.linalg.norm(Q, axis=1) if L < 1e-12 else np.abs(Q[:, 0] * seg[1] - Q[:, 1] * seg[0]) / L
        i = int(np.argmax(d))
        if d[i] > tol:
            k = a + 1 + i
            keep[k] = True
            stack += [(a, k), (k, b)]
    return P[keep]


def rdp_closed(P: np.ndarray, tol: float) -> np.ndarray:
    """闭合折线简化：从离第一个点最远的点处分成两段分别简化。P 不重复首点。"""
    if len(P) < 4:
        return P
    k = int(np.argmax(np.linalg.norm(P - P[0], axis=1)))
    a = rdp(np.vstack([P[: k + 1]]), tol)
    b = rdp(np.vstack([P[k:], P[:1]]), tol)
    out = np.vstack([a[:-1], b[:-1]])
    return out


def signed_area(P: np.ndarray) -> float:
    x, y = P[:, 0], P[:, 1]
    return float((x * np.roll(y, -1) - np.roll(x, -1) * y).sum() / 2)


def polyline_length(P: np.ndarray, closed: bool) -> float:
    if len(P) < 2:
        return 0.0
    d = np.linalg.norm(np.diff(P, axis=0), axis=1).sum()
    if closed:
        d += np.linalg.norm(P[-1] - P[0])
    return float(d)


# ---------------------------------------------------------------------------- 网格截面


def plane_section(V: np.ndarray, F: np.ndarray, n: np.ndarray, c: float):
    """平面 n·p = c 与三角网格求交，返回 (线段端点的边编号 (k,2), 端点坐标 (k,2,3))。"""
    s = V @ n - c
    s = np.where(np.abs(s) < 1e-9, 1e-9, s)
    sf = s[F]
    pos = sf > 0
    cnt = pos.sum(axis=1)
    m = (cnt == 1) | (cnt == 2)
    F2, s2, p2 = F[m], sf[m], pos[m]
    ea, eb = np.array([0, 1, 2]), np.array([1, 2, 0])
    cross = p2[:, ea] != p2[:, eb]
    idx = np.argsort(~cross, axis=1, kind="stable")[:, :2]
    rows = np.arange(len(F2))[:, None]
    va, vb = F2[rows, ea[idx]], F2[rows, eb[idx]]
    sa, sb = s2[rows, ea[idx]], s2[rows, eb[idx]]
    t = sa / (sa - sb)
    pts = V[va] + (V[vb] - V[va]) * t[..., None]
    keys = np.minimum(va, vb) * len(V) + np.maximum(va, vb)
    return keys, pts


def chain_segments(keys: np.ndarray, pts: np.ndarray) -> list[tuple[np.ndarray, bool]]:
    """把截面线段按共享的网格边连成折线，返回 [(点 (n,3), 是否闭合)]。"""
    adj: dict[int, list[tuple[int, int]]] = defaultdict(list)
    P: dict[int, np.ndarray] = {}
    for i, (a, b) in enumerate(keys.tolist()):
        if a == b:
            continue
        adj[a].append((b, i))
        adj[b].append((a, i))
        P[a] = pts[i, 0]
        P[b] = pts[i, 1]
    used = np.zeros(len(keys), bool)

    def walk(start: int) -> list[int]:
        seq, cur = [start], start
        while True:
            nxt = None
            for nb, si in adj[cur]:
                if not used[si]:
                    used[si] = True
                    nxt = nb
                    break
            if nxt is None:
                break
            seq.append(nxt)
            cur = nxt
            if len(adj[cur]) != 2 or cur == start:
                break
        return seq

    chains = []
    for node, lst in adj.items():
        if len(lst) != 2:
            while any(not used[si] for _, si in lst):
                seq = walk(node)
                chains.append((np.array([P[k] for k in seq]), False))
    for node, lst in adj.items():
        if any(not used[si] for _, si in lst):
            seq = walk(node)
            closed = len(seq) > 3 and seq[0] == seq[-1]
            pts_ = np.array([P[k] for k in (seq[:-1] if closed else seq)])
            chains.append((pts_, closed))
    return chains


def join_chains(chains: list[tuple[np.ndarray, bool]], tol: float) -> list[tuple[np.ndarray, bool]]:
    """把端点相距不到 tol 的开折线首尾相接（扫描网格的小缺口）；接成环的标为闭合。"""
    open_ = [c for c, closed in chains if not closed and len(c) >= 2]
    done = [(c, True) for c, closed in chains if closed]
    changed = True
    while changed and len(open_) > 1:
        changed = False
        ends = np.array([[c[0], c[-1]] for c in open_])  # (n,2,dim)
        best = None
        for i in range(len(open_)):
            for j in range(i + 1, len(open_)):
                for ei in (0, 1):
                    for ej in (0, 1):
                        d = np.linalg.norm(ends[i, ei] - ends[j, ej])
                        if d < tol and (best is None or d < best[0]):
                            best = (d, i, j, ei, ej)
        if best:
            _, i, j, ei, ej = best
            a = open_[i] if ei == 1 else open_[i][::-1]
            b = open_[j] if ej == 0 else open_[j][::-1]
            merged = np.vstack([a, b])
            open_ = [c for k, c in enumerate(open_) if k not in (i, j)] + [merged]
            changed = True
    out = done
    for c in open_:
        if len(c) > 3 and np.linalg.norm(c[0] - c[-1]) < tol:
            out.append((c, True))
        else:
            out.append((c, False))
    return out


# ---------------------------------------------------------------------------- 栅格轮廓


def trace_loops(mask: np.ndarray) -> list[np.ndarray]:
    """二值栅格（mask[j, i]，i 沿 u、j 沿 v 增大）的像素边界，填充区域在行进方向左侧：
    外边界逆时针（面积为正），洞顺时针。返回角点坐标（格子单位）的闭合环列表。"""
    m = np.pad(mask, 1)
    f = m[1:-1, 1:-1]
    js, is_ = np.nonzero(f)
    starts, ends = [], []
    below = ~m[js, is_ + 1]  # m 的下标偏移 1：邻居 (j-1) 在 m[j, ...]
    above = ~m[js + 2, is_ + 1]
    left = ~m[js + 1, is_]
    right = ~m[js + 1, is_ + 2]
    for sel, s, e in (
        (below, (is_, js), (is_ + 1, js)),
        (right, (is_ + 1, js), (is_ + 1, js + 1)),
        (above, (is_ + 1, js + 1), (is_, js + 1)),
        (left, (is_, js + 1), (is_, js)),
    ):
        starts.append(np.stack([s[0][sel], s[1][sel]], 1))
        ends.append(np.stack([e[0][sel], e[1][sel]], 1))
    S, E = np.concatenate(starts), np.concatenate(ends)
    out_edges: dict[tuple[int, int], list[int]] = defaultdict(list)
    for k, (a, b) in enumerate(S.tolist()):
        out_edges[(a, b)].append(k)
    used = np.zeros(len(S), bool)
    loops = []
    for k0 in range(len(S)):
        if used[k0]:
            continue
        loop = []
        k = k0
        while not used[k]:
            used[k] = True
            loop.append(S[k])
            end = (int(E[k, 0]), int(E[k, 1]))
            cands = [c for c in out_edges[end] if not used[c]]
            if not cands:
                break
            if len(cands) > 1:
                din = E[k] - S[k]
                # 鞍点：优先左转（紧贴当前像素）
                cands.sort(key=lambda c: -(din[0] * (E[c] - S[c])[1] - din[1] * (E[c] - S[c])[0]))
            k = cands[0]
        if len(loop) >= 4:
            loops.append(np.array(loop, float))
    return loops


def _point_in_poly(p, P) -> bool:
    x, y = p
    inside = False
    j = len(P) - 1
    for i in range(len(P)):
        xi, yi = P[i]
        xj, yj = P[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-30) + xi:
            inside = not inside
        j = i
    return inside


def footprints(
    segs2d: list[np.ndarray],
    tol: float,
    close_r: float,
    cell: float = 0.01,
    min_area: float = 0.002,
    points: np.ndarray | None = None,
    min_thick: float = 0.04,
):
    """截面折线（二维）或散点 → 栅格化 → 闭合 close_r → 填洞后的外轮廓 + 原本的洞。"
    "返回组件列表（面积从大到小）。"""
    if points is not None and len(points):
        segs2d = [*segs2d, points]
    if not segs2d:
        return []
    allp = np.vstack(segs2d)
    pad = close_r + 3 * cell
    u0, v0 = allp.min(0) - pad
    u1, v1 = allp.max(0) + pad
    W, H = int(np.ceil((u1 - u0) / cell)) + 1, int(np.ceil((v1 - v0) / cell)) + 1
    mask = np.zeros((H, W), bool)
    for idx_p, P in enumerate(segs2d):
        if len(P) < 2 or (points is not None and idx_p == len(segs2d) - 1):
            q = P
        else:
            seg = np.diff(P, axis=0)
            n = np.maximum(1, np.ceil(np.linalg.norm(seg, axis=1) / (cell * 0.4))).astype(int)
            t = np.concatenate([np.arange(k) / k for k in n])
            base = np.repeat(P[:-1], n, axis=0)
            q = np.vstack([base + np.repeat(seg, n, axis=0) * t[:, None], P[-1:]])
        i = np.clip(((q[:, 0] - u0) / cell).astype(int), 0, W - 1)
        j = np.clip(((q[:, 1] - v0) / cell).astype(int), 0, H - 1)
        mask[j, i] = True
    rad = max(1, round(close_r / cell))
    yy, xx = np.mgrid[-rad : rad + 1, -rad : rad + 1]
    disk = xx**2 + yy**2 <= rad * rad
    closed = ndimage.binary_closing(np.pad(mask, rad + 1), structure=disk)[
        rad + 1 : -rad - 1, rad + 1 : -rad - 1
    ]
    closed |= mask
    filled = ndimage.binary_fill_holes(closed)
    to_w = lambda L: np.c_[u0 + L[:, 0] * cell, v0 + L[:, 1] * cell]  # noqa: E731
    outers = [to_w(L) for L in trace_loops(filled)]
    outers = [o for o in outers if signed_area(o) > min_area]
    holes = [to_w(L) for L in trace_loops(closed)]
    holes = [h for h in holes if signed_area(h) < -min_area * 4]
    comps = []
    for o in outers:
        # 只留"有面积"的块：细长的交线带（平均厚度 < 4 厘米）在 chains 里已经有了
        if (
            signed_area(o) < (0.01 if min_thick > 0 else min_area)
            or 2 * signed_area(o) / polyline_length(o, True) < min_thick
        ):
            continue
        so = rdp_closed(o, tol)
        hs = [rdp_closed(h, tol) for h in holes if _point_in_poly(h[0], o)]
        comps.append(
            {
                "area": r(signed_area(o), 4),
                "perimeter": round(polyline_length(o, True), 3),
                "outline": r(so, 3),
                "holes": [r(h[::-1], 3) for h in hs],  # 洞也按逆时针给出，方便直接当轮廓用
                "holeArea": r(sum(-signed_area(h) for h in hs), 4),
                "bbox": {"min": r(o.min(0), 3), "max": r(o.max(0), 3)},
            }
        )
    comps.sort(key=lambda c: -c["area"])
    return comps


# ---------------------------------------------------------------------------- 外接框


def min_rect(P2: np.ndarray, robust: bool = False) -> dict | None:
    """最小面积外接矩形（凸包旋转卡壳）。yaw 是 SHAPES 约定：box 的局部 x 轴 = (cos yaw, −sin yaw)。
    robust=True 时在每个候选方向上用 1%–99% 分位数代替最值。"""
    if len(P2) < 5:
        return None
    try:
        hull = P2[ConvexHull(P2).vertices]
    except Exception:
        return None
    best = None
    for i in range(len(hull)):
        e = hull[(i + 1) % len(hull)] - hull[i]
        L = np.linalg.norm(e)
        if L < 1e-9:
            continue
        e = e / L
        ang = math.atan2(e[1], e[0])
        Q = hull @ np.array([[e[0], -e[1]], [e[1], e[0]]])
        a = (Q[:, 0].max() - Q[:, 0].min()) * (Q[:, 1].max() - Q[:, 1].min())
        if best is None or a < best[0]:
            best = (a, ang)
    _, ang = best
    e = np.array([math.cos(ang), math.sin(ang)])
    f = np.array([-e[1], e[0]])
    U, Vv = P2 @ e, P2 @ f
    if robust:
        u0, u1 = np.percentile(U, [1, 99])
        v0, v1 = np.percentile(Vv, [1, 99])
    else:
        u0, u1, v0, v1 = U.min(), U.max(), Vv.min(), Vv.max()
    cu, cv = (u0 + u1) / 2, (v0 + v1) / 2
    center = cu * e + cv * f
    size = [u1 - u0, v1 - v0]
    # 让局部 x 轴取长边
    if size[1] > size[0]:
        e, f = f, -e
        size = size[::-1]
    yaw = math.degrees(math.atan2(-e[1], e[0]))
    while yaw <= -90:
        yaw += 180
        e = -e
    while yaw > 90:
        yaw -= 180
        e = -e
    f = np.array([-e[1], e[0]])  # 局部 z 轴 = Ry(yaw)·(0,0,1) = (sin yaw, cos yaw)
    hx, hz = size[0] / 2, size[1] / 2
    corners = [center + sx * hx * e + sz * hz * f for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    return {
        "center": r(center, 4),
        "size": r(size, 4),
        "yaw": round(yaw, 2),
        "axisX": r(e, 4),
        "axisZ": r(f, 4),
        "corners": r(np.array(corners), 4),
    }


# ---------------------------------------------------------------------------- 圆拟合、颜色


def fit_circle(P2: np.ndarray) -> dict | None:
    if len(P2) < 8:
        return None
    pts = P2
    for _ in range(4):
        A = np.c_[pts, np.ones(len(pts))]
        b = -(pts**2).sum(1)
        sol, *_ = np.linalg.lstsq(A, b, rcond=None)
        c = -sol[:2] / 2
        rad = math.sqrt(max(c @ c - sol[2], 1e-12))
        res = np.abs(np.linalg.norm(P2 - c, axis=1) - rad)
        mad = np.median(res) * 1.4826
        keep = res < max(0.01, 3 * mad)
        if keep.sum() < 8:
            break
        pts = P2[keep]
    sol = least_squares(
        lambda p: np.linalg.norm(pts - p[:2], axis=1) - p[2], [c[0], c[1], rad], loss="soft_l1", f_scale=0.01
    )
    cx, cz, rad = sol.x
    res_all = np.abs(np.linalg.norm(P2 - [cx, cz], axis=1) - abs(rad))
    inl = res_all < 0.015
    ang = np.degrees(np.arctan2(P2[inl, 1] - cz, P2[inl, 0] - cx))
    bins = np.unique(np.floor((ang + 180) / 10)) if inl.any() else []
    span = float(np.ptp(P2, axis=0).max())
    if abs(rad) > 20 * max(span, 1e-3):
        return {
            "error": f"点基本在一条直线上（拟合半径 {abs(rad):.1f} 米），不是圆弧",
            "points": len(P2),
        }
    return {
        "center": r([cx, cz], 4),
        "radius": round(abs(float(rad)), 4),
        "rmsCm": round(float(np.sqrt(np.mean(res_all[inl] ** 2)) * 100) if inl.any() else 0.0, 2),
        "inlierShare": round(float(inl.mean()), 3),
        "arcDegrees": int(len(bins) * 10),
        "points": len(P2),
    }


def hexc(c) -> str:
    c = np.clip(np.round(c), 0, 255).astype(int)
    return "#{:02x}{:02x}{:02x}".format(*c)


def color_stats(C: np.ndarray) -> dict:
    med = np.median(C, axis=0)
    q1, q3 = np.percentile(C, [25, 75], axis=0)
    return {
        "median": [int(v) for v in med],
        "hex": hexc(med),
        "p25": [int(v) for v in q1],
        "p75": [int(v) for v in q3],
        "points": len(C),
    }


def dominant_colors(P: np.ndarray, C: np.ndarray, k: int = 4, seed: int = 0) -> list[dict]:
    """颜色 k 均值（RGB），每类给中位色、占比和它们主要所在的高度、水平范围（10%–90% 分位）。"""
    if len(C) < k * 10:
        return []
    rng = np.random.default_rng(seed)
    sel = rng.choice(len(C), min(len(C), 30000), replace=False)
    X = C[sel].astype(float)
    cent = [X[rng.integers(len(X))]]
    for _ in range(1, k):
        d = np.min([((X - c) ** 2).sum(1) for c in cent], axis=0)
        cent.append(X[int(np.argmax(d))])
    cent = np.array(cent)
    for _ in range(15):
        lab = np.argmin(((X[:, None, :] - cent[None]) ** 2).sum(2), axis=1)
        cent = np.array([X[lab == i].mean(0) if (lab == i).any() else cent[i] for i in range(k)])
    lab_all = np.argmin(((C[:, None, :].astype(float) - cent[None]) ** 2).sum(2), axis=1)
    out = []
    for i in range(k):
        m = lab_all == i
        if m.sum() == 0:
            continue
        Pm = P[m]
        out.append(
            {
                "share": round(float(m.mean()), 3),
                "hex": hexc(np.median(C[m], 0)),
                "median": [int(v) for v in np.median(C[m], 0)],
                "y10to90": r(np.percentile(Pm[:, 1], [10, 90]), 3),
                "x10to90": r(np.percentile(Pm[:, 0], [10, 90]), 3),
                "z10to90": r(np.percentile(Pm[:, 2], [10, 90]), 3),
            }
        )
    out.sort(key=lambda d: -d["share"])
    return out


# ---------------------------------------------------------------------------- 占用图


def occupancy_png(
    P: np.ndarray,
    y0: float,
    y1: float,
    path: str,
    box2d,
    rect,
    title: str,
    cell: float = 0.02,
    axes=("X", "Z"),
) -> dict:
    """俯视高度图：每格取区间内最高点的高度上色；黄框 = 输入包围盒，品红 = 最小外接矩形。"""
    m = (P[:, 1] >= y0) & (P[:, 1] <= y1)
    Q = P[m]
    (bx0, bz0), (bx1, bz1) = box2d
    u0, v0 = bx0 - 0.06, bz0 - 0.06
    u1, v1 = bx1 + 0.06, bz1 + 0.06
    nx, nz = int(np.ceil((u1 - u0) / cell)), int(np.ceil((v1 - v0) / cell))
    hmax = np.full((nz, nx), -np.inf)
    cnt = np.zeros((nz, nx), int)
    if len(Q):
        ix = np.clip(((Q[:, 0] - u0) / cell).astype(int), 0, nx - 1)
        iz = np.clip(((Q[:, 2] - v0) / cell).astype(int), 0, nz - 1)
        np.maximum.at(hmax, (iz, ix), Q[:, 1])
        np.add.at(cnt, (iz, ix), 1)
    occ = cnt > 0
    panel = wc.Panel(
        u0,
        u0 + nx * cell,
        v0,
        v0 + nz * cell,
        v_down=True,
        u_name=axes[0],
        v_name=axes[1],
        title=title,
        sub=t(
            f"颜色 = 每 {cell * 100:g} 厘米格内 y {y0:.2f}–{y1:.2f} 的最高点高度；黄框 = 包围盒；品红 = "
            "最小外接矩形",
            f"color = highest point in each {cell * 100:g} cm cell within y {y0:.2f}–{y1:.2f}; "
            "yellow = box; magenta = min-area rectangle",
        ),
        right=110,
    )
    rgba = np.zeros((nz, nx, 4), np.uint8)
    rgba[occ, :3] = wc.heat_color(hmax[occ], y0, y1)
    rgba[occ, 3] = 255
    layer = Image.fromarray(rgba, "RGBA").resize((panel.w, panel.h), Image.NEAREST)
    panel.img.paste(layer, (panel.L, panel.T), layer)
    d = panel.draw
    x0p, z0p = panel.px(bx0, bz0)
    x1p, z1p = panel.px(bx1, bz1)
    d.rectangle([x0p, z0p, x1p, z1p], outline=(255, 212, 0), width=1)
    if rect:
        cs = [tuple(float(v) for v in panel.px(*c)) for c in rect["corners"]]
        d.line(cs + cs[:1], fill=(255, 80, 220), width=2)
    bx, by, bh = panel.L + panel.w + 14, panel.T, min(300, panel.h)
    for j in range(bh):
        v = y1 - (y1 - y0) * j / max(bh - 1, 1)
        d.line(
            [(bx, by + j), (bx + 18, by + j)],
            fill=tuple(int(c) for c in wc.heat_color(np.array([v]), y0, y1)[0]),
        )
    for frac in (0, 0.25, 0.5, 0.75, 1):
        v = y1 - (y1 - y0) * frac
        d.text(
            (bx + 24, by + frac * (bh - 1)), f"y {v:.2f}", font=wc.font(12), fill=(230, 233, 238), anchor="lm"
        )
    panel.finish().save(path, optimize=True)
    return {
        "range": [r(y0, 3), r(y1, 3)],
        "png": path,
        "cell": cell,
        "occupiedCells": int(occ.sum()),
        "occupiedArea": round(float(occ.sum()) * cell * cell, 3),
        "points": len(Q),
    }


def slice_png(
    item: dict, path: str, extent, v_down: bool, axes: tuple[str, str], title: str, raw: list
) -> None:
    """截面图：每条交线一种颜色并标 #序号（与 JSON 里 chains 的顺序一致），填充轮廓淡白色。"""
    (u0, v0), (u1, v1) = extent
    panel = wc.Panel(
        u0,
        u1,
        v0,
        v1,
        v_down=v_down,
        u_name=axes[0],
        v_name=axes[1],
        title=title,
        sub=t(
            "彩色线 = 扫描表面与截面的交线（#序号 = chains 下标）\n淡白 = 闭合填充后的轮廓 "
            "footprint（只列有面积的块）",
            "colored lines = scan/plane intersections (#i = chains index)\nwhite = closed footprint outlines",
        ),
    )
    d = panel.draw
    if item.get("_points") is not None:
        u, v = panel.px(item["_points"][:, 0], item["_points"][:, 1])
        for x, y in zip(u.tolist(), v.tolist(), strict=True):
            d.point((x, y), fill=(255, 230, 120))
    for f in item["footprint"]:
        pts = [tuple(float(v) for v in panel.px(*p)) for p in f["outline"]]
        if len(pts) >= 3:
            d.polygon(pts, fill=(255, 255, 255, 38), outline=(255, 255, 255, 120))
    for i, ch in enumerate(item["chains"]):
        col = wc.PALETTE[i % len(wc.PALETTE)]
        pts = [tuple(float(v) for v in panel.px(*p)) for p in ch["points"]]
        if ch["closed"]:
            pts = pts + pts[:1]
        if len(pts) >= 2:
            d.line(pts, fill=col, width=2)
        mid = pts[len(pts) // 2]
        d.text((mid[0] + 3, mid[1] - 3), f"#{i}", font=wc.font(12), fill=col, anchor="lb")
    panel.finish().save(path, optimize=True)


# ---------------------------------------------------------------------------- 命令


def parse_range(text: str) -> tuple[float, float, list[float] | None]:
    rect = None
    if "@" in text:
        text, rr = text.split("@", 1)
        rect = [float(x) for x in rr.split(",")]
        if len(rect) != 4:
            raise wc.ReconError("矩形需要 4 个数：x0,z0,x1,z1")
    a, b = (float(x) for x in text.split(":"))
    return min(a, b), max(a, b), rect


def slice_plane(text: str, frame_center: np.ndarray):
    """竖直截面：x=c / z=c / p=x,z@yaw。返回 (法线, 常数, 平面内水平方向, 平面内原点, 名称, 横轴名)。"""
    t = text.replace(" ", "")
    if t.startswith("x="):
        c = float(t[2:])
        return np.array([1.0, 0, 0]), c, np.array([0, 0, 1.0]), np.array([c, 0, 0]), f"x={c:g}", "z"
    if t.startswith("z="):
        c = float(t[2:])
        return np.array([0, 0, 1.0]), c, np.array([1.0, 0, 0]), np.array([0, 0, c]), f"z={c:g}", "x"
    if t.startswith("p="):
        pt, yaw = t[2:].split("@")
        x, z = (float(v) for v in pt.split(","))
        a = math.radians(float(yaw))
        n = np.array([math.sin(a), 0, math.cos(a)])
        tdir = np.array([math.cos(a), 0, -math.sin(a)])
        p0 = np.array([x, 0, z])
        return n, float(n @ p0), tdir, p0, f"过 ({x:g},{z:g})、法线方位角 {float(yaw):g}°", "u"
    raise wc.ReconError(f"--vslice 格式不对：{text}（x=7.0、z=5.9 或 p=x,z@yaw）")


def section_result(V, F, n, c, to2d, args, label: str) -> dict:
    keys, pts = plane_section(V, F, n, c)
    chains = chain_segments(keys, pts)
    chains2 = [(to2d(P), closed) for P, closed in chains]
    chains2 = join_chains(chains2, 0.015)
    out_chains = []
    raw2d = []
    total = 0.0
    for P, closed in chains2:
        L = polyline_length(P, closed)
        if L < 0.02:
            continue
        raw2d.append(np.vstack([P, P[:1]]) if closed else P)
        total += L
        S = rdp_closed(P, args.tol) if closed else rdp(P, args.tol)
        if closed and signed_area(S) < 0:
            S = S[::-1]
        out_chains.append({"closed": closed, "length": round(L, 3), "points": r(S, 3)})
    out_chains.sort(key=lambda c: -c["length"])
    fp = footprints(raw2d, max(args.tol, 0.012), args.close)
    return {
        "at": label,
        "totalLength": round(total, 3),
        "chains": out_chains[:30],
        "chainsOmitted": max(0, len(out_chains) - 30),
        "footprint": fp[:8],
    }


def band_result(P, n, c, to2d, args, label: str) -> dict:
    """采样点带：|n·p − c| ≤ band/2 的点投影后求填充轮廓（没有折线）。"""
    m = np.abs(P @ n - c) <= args.band / 2
    Q = to2d(P[m])
    fp = footprints([], max(args.tol, 0.012), args.close, points=Q, min_thick=0.0) if len(Q) else []
    fp.sort(key=lambda f: -f["perimeter"])  # 点带里多是细长的块，按周长排
    return {"at": label, "points": int(m.sum()), "chains": [], "footprint": fp[:12], "_points": Q}


# ---------------------------------------------------------------------------- 平面拟合、高度图


def fit_plane(P: np.ndarray, outward_from: np.ndarray | None = None) -> dict | None:
    """选区里的点拟合平面：先随机抽样一致（选区里混进别的面时取点最多的那个面，内点阈值 1.5 厘米），
    再用 SVD 精化、去掉残差大于 3 倍中位偏差的点，迭代 3 次。

    法向朝向：不接近竖直的面取朝上（n_y ≥ 0）；接近竖直的面取背离 `outward_from`（物体中心）的一侧。
    返回法向、坡度（与水平面的夹角：0 = 水平，90 = 竖直）、方位角（法向水平分量的 SHAPES 偏航：0 = +Z，
    90 = +X）、残差、内点占比，以及内点在平面上的最小外接矩形的 4 个角（从法向一侧看逆时针，可直接作 plate
    的点）。
    """
    if len(P) < 10:
        return None
    rng = np.random.default_rng(0)
    keep = np.ones(len(P), bool)
    best = 0
    for _ in range(300):
        i = rng.choice(len(P), 3, replace=False)
        nn = np.cross(P[i[1]] - P[i[0]], P[i[2]] - P[i[0]])
        ln = np.linalg.norm(nn)
        if ln < 1e-9:
            continue
        inl = np.abs((P - P[i[0]]) @ (nn / ln)) < 0.015
        if inl.sum() > best:
            best, keep = int(inl.sum()), inl
    if keep.sum() < 10:
        keep = np.ones(len(P), bool)
    for _ in range(3):
        Q = P[keep]
        c = Q.mean(0)
        _, _, vt = np.linalg.svd(Q - c, full_matrices=False)
        n = vt[-1]
        res = np.abs((P - c) @ n)
        mad = np.median(res[keep]) * 1.4826
        new = res <= max(3 * mad, 0.003)
        if new.sum() < 10:
            break
        if (new == keep).all():
            break
        keep = new
    Q = P[keep]
    c = Q.mean(0)
    _, _, vt = np.linalg.svd(Q - c, full_matrices=False)
    n = vt[-1]
    if abs(n[1]) > 0.2:
        n = n if n[1] > 0 else -n
    elif outward_from is not None and (c - outward_from) @ n < 0:
        n = -n
    res = (Q - c) @ n
    slope = math.degrees(math.acos(min(1.0, abs(float(n[1])))))
    horiz = math.hypot(n[0], n[2])
    azimuth = math.degrees(math.atan2(n[0], n[2])) if horiz > 1e-6 else None
    # 平面内坐标：u 水平（法向竖直时取 +x），v = n × u
    u = np.cross([0, 1.0, 0], n)
    if np.linalg.norm(u) < 1e-6:
        u = np.array([1.0, 0, 0])
    u /= np.linalg.norm(u)
    v = np.cross(n, u)
    uv = np.c_[(Q - c) @ u, (Q - c) @ v]
    rect = min_rect(uv)
    corners = None
    if rect:
        cs = np.array(rect["corners"])
        world = c + cs[:, :1] * u + cs[:, 1:2] * v
        # 从法向一侧看逆时针（右手定则给出 n）
        if np.cross(world[1] - world[0], world[2] - world[0]) @ n < 0:
            world = world[::-1]
        corners = r(world, 4)
    return {
        "points": len(P),
        "inlierShare": round(float(keep.mean()), 3),
        "centroid": r(c, 4),
        "normal": r(n, 4),
        "slopeDeg": round(slope, 2),
        "azimuthDeg": None if azimuth is None else round(azimuth, 2),
        "planeD": round(float(n @ c), 4),
        "rmsCm": round(float(np.sqrt(np.mean(res**2)) * 100), 2),
        "maxCm": round(float(np.abs(res).max() * 100), 2),
        "extent": r([np.ptp(uv[:, 0]), np.ptp(uv[:, 1])], 3),
        "rectCorners": corners,
    }


def heightmap_table(
    P: np.ndarray, y0: float, y1: float, rect, cell: float, stat: str, max_cells: int = 48
) -> dict:
    """俯视高度图的数字表：每格（cell 米）取 y0–y1 之间点的最高（top）或最低（bottom）高度；
    没有点的格子是 null。
    行沿 z 增大，列沿 x 增大；格子太多时自动放大格子。"""
    m = (P[:, 1] >= y0) & (P[:, 1] <= y1)
    if rect:
        m &= (P[:, 0] >= min(rect[0], rect[2])) & (P[:, 0] <= max(rect[0], rect[2]))
        m &= (P[:, 2] >= min(rect[1], rect[3])) & (P[:, 2] <= max(rect[1], rect[3]))
    Q = P[m]
    if len(Q) < 3:
        return {"error": "范围里没有点", "range": [y0, y1]}
    if rect:
        x0, x1 = min(rect[0], rect[2]), max(rect[0], rect[2])
        z0, z1 = min(rect[1], rect[3]), max(rect[1], rect[3])
    else:
        x0, z0 = float(Q[:, 0].min()), float(Q[:, 2].min())
        x1, z1 = float(Q[:, 0].max()), float(Q[:, 2].max())
    note = None
    while max((x1 - x0) / cell, (z1 - z0) / cell) > max_cells:
        cell *= 2
        note = f"格子太多，自动放大到 {cell * 100:g} 厘米"
    nx, nz = max(1, int(np.ceil((x1 - x0) / cell - 1e-9))), max(1, int(np.ceil((z1 - z0) / cell - 1e-9)))
    ix = np.clip(((Q[:, 0] - x0) / cell).astype(int), 0, nx - 1)
    iz = np.clip(((Q[:, 2] - z0) / cell).astype(int), 0, nz - 1)
    H = np.full((nz, nx), -np.inf if stat == "top" else np.inf)
    (np.maximum if stat == "top" else np.minimum).at(H, (iz, ix), Q[:, 1])
    rows = [[None if not np.isfinite(v) else round(float(v), 3) for v in row] for row in H]
    return {
        "range": [r(y0, 3), r(y1, 3)],
        "stat": stat,
        "cell": round(cell, 4),
        "x0": r(x0, 3),
        "z0": r(z0, 3),
        "cols": nx,
        "rows": nz,
        "xCenters": r(x0 + (np.arange(nx) + 0.5) * cell, 3),
        "zCenters": r(z0 + (np.arange(nz) + 0.5) * cell, 3),
        "heights": rows,
        "note": note,
    }


def parse_named_box(spec: str) -> tuple[str, wc.Box]:
    name, _, bb = spec.rpartition("=")
    return name or bb, wc.parse_box(bb)


# ---------------------------------------------------------------------------- 命令


def cmd_measure(args) -> dict:
    t0 = time.time()
    base = from_args(args)
    box, eid = resolve_box(args, base)
    region = box.grow(args.margin)
    frame = Frame(args.frame)
    out_path = os.path.abspath(args.out)
    out_dir = os.path.dirname(out_path)
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(out_path))[0]
    wc.log(
        f"measure：{eid or ''} 范围 {r(region.lo, 3)} – {r(region.hi, 3)}（包围盒外扩 {args.margin}）"
        + (f"；局部坐标系 原点 {r(frame.origin, 3)} yaw {frame.yaw:g}" if frame.active else "")
    )

    scan = wc.load_scan(base.scan)
    near = wc.crop_scan(scan, region.grow(0.5))
    floor_w = args.floor if args.floor is not None else wc.estimate_floor(near, box)
    # 地面按局部高度图去掉（地面不平、有台阶时也只去掉贴地的一层）；给了 --floor 就按平地面
    hm = (
        wc.flat_heightmap(region, floor_w)
        if args.floor is not None
        else wc.floor_heightmap(near, region.grow(0.3), floor_w)
    )
    part = wc.crop_scan(near, region.grow(0.05))
    P, C, N, _ = wc.sample_points(part, args.density, seed=1)
    keep = region.contains(P) & (P[:, 1] >= wc.floor_at(hm, P) + args.floor_gap)
    excludes = [wc.parse_box(spec) for spec in args.exclude or []]
    for ex in excludes:
        keep &= ~ex.contains(P)
    P, C, N = P[keep], C[keep], N[keep]
    if len(P) < 20:
        raise wc.ReconError("范围内几乎没有扫描点（检查 --box / --margin / --exclude）")
    # 截面用的网格：中心在范围内、且不在地面那一层的三角形
    cen = part.V[part.F].mean(axis=1)
    fmask = region.contains(cen) & (cen[:, 1] >= wc.floor_at(hm, cen) + args.floor_gap)
    for ex in excludes:
        fmask &= ~ex.contains(cen)
    Vl = frame.to_local(part.V)
    Fs = part.F[fmask]
    PL = frame.to_local(P)
    NL = N @ frame.R
    floor = floor_w - frame.origin[1]
    PB = PL
    if args.band > 0:
        # 点带模式另做一份密采样（约 4 万点/平方米），细墙在薄带里才连得成线
        Pd, _, _, _ = wc.sample_points(part, 40000, seed=2)
        Pd = Pd[region.contains(Pd) & (Pd[:, 1] >= wc.floor_at(hm, Pd) + args.floor_gap)]
        PB = frame.to_local(Pd)
    wc.log(
        f"  采样 {len(P)} 点（{args.density:g} 点/平方米），地面 y={floor:.3f}（局部 5%–95%："
        f"{np.percentile(hm[3], 5) - frame.origin[1]:.3f}–{np.percentile(hm[3], 95) - frame.origin[1]:.3f}，"
        f"去掉离局部地面 {args.floor_gap} 米以内的点），{time.time() - t0:.1f} 秒"
    )

    fl = hm[3]
    res: dict = {
        "entityId": eid,
        "region": region.as_dict(),
        "frame": frame.as_dict(),
        "floorY": r(floor),
        "floorLocal5to95": r(np.percentile(fl, [5, 95]) - frame.origin[1]),
        "points": len(P),
        "density": args.density,
        "excluded": [e.as_dict() for e in excludes],
        "note": "坐标单位米；没有 --frame 时是空间坐标（y 向上）；有 --frame 时是 Ry(-yaw)·(p - 原点) "
        "的局部坐标",
    }

    # 1. 外接框
    lo, hi = PL.min(0), PL.max(0)
    rlo, rhi = np.percentile(PL, 0.5, axis=0), np.percentile(PL, 99.5, axis=0)
    res["bbox"] = {
        "min": r(lo),
        "max": r(hi),
        "size": r(hi - lo),
        "robust": {
            "min": r(rlo),
            "max": r(rhi),
            "size": r(rhi - rlo),
            "note": "0.5%–99.5% 分位，去掉零星离群点",
        },
    }
    rect = min_rect(PL[:, [0, 2]])
    rrect = min_rect(PL[:, [0, 2]], robust=True)
    res["minRect"] = {
        "hull": rect,
        "robust": rrect,
        "note": "水平面最小外接矩形；size=[沿局部 x（长边）, 沿局部 z]；yaw 按 SHAPES 约定，"
        "可直接用作 transform.yaw；axisX/axisZ 是局部 x、z 轴在 xz 平面的方向",
    }
    top = float(rhi[1])
    height = top - floor

    # 2. 按高度的剖面表
    prof = []
    e = np.array(rrect["axisX"]) if rrect else np.array([1.0, 0])
    f = np.array(rrect["axisZ"]) if rrect else np.array([0, 1.0])
    rc = np.array(rrect["center"]) if rrect else np.zeros(2)
    y = math.floor(floor / args.step) * args.step
    while y < hi[1] + 1e-9:
        m = (PL[:, 1] >= y) & (PL[:, 1] < y + args.step)
        if m.sum() >= 5:
            Q = PL[m]
            xs, zs = np.percentile(Q[:, 0], [2, 98]), np.percentile(Q[:, 2], [2, 98])
            d2 = Q[:, [0, 2]] - rc
            us, vs = np.percentile(d2 @ e, [2, 98]), np.percentile(d2 @ f, [2, 98])
            occ = len(np.unique(np.floor(Q[:, [0, 2]] / 0.02).astype(int), axis=0)) * 0.0004
            up = float((NL[m, 1] > 0.85).mean())
            prof.append(
                {
                    "y0": r(y, 3),
                    "y1": r(y + args.step, 3),
                    "n": int(m.sum()),
                    "x": r(xs, 3),
                    "z": r(zs, 3),
                    "w": r(xs[1] - xs[0], 3),
                    "d": r(zs[1] - zs[0], 3),
                    "u": r(us, 3),
                    "v": r(vs, 3),
                    "areaM2": round(occ, 3),
                    "upFacing": round(up, 2),
                    "color": hexc(np.median(C[m], 0)),
                }
            )
        y += args.step
    res["profile"] = {
        "step": args.step,
        "rows": prof,
        "note": "每层 2%–98% 分位的范围：x/z 是坐标轴方向，u/v 是相对最小外接矩形（robust）中心沿其局部 x/z "
        "的"
        "范围；areaM2 = 2 厘米格子的占用面积；upFacing = 朝上法线的点占比（大 = 台面/顶面）",
    }

    # 3. 水平截面
    hs = (
        [float(v) for v in args.hslice.split(",")]
        if args.hslice
        else [round(floor + height * k, 3) for k in (0.2, 0.5, 0.8, 0.97)]
    )
    res["hslices"] = []
    ax_h = ("x", "z") if frame.active else ("X", "Z")
    for i, yv in enumerate(hs):
        if args.band > 0:
            item = band_result(PB, np.array([0, 1.0, 0]), yv, lambda Q: Q[:, [0, 2]], args, f"y={yv:g}")
        else:
            item = section_result(
                Vl, Fs, np.array([0, 1.0, 0]), yv, lambda Q: Q[:, [0, 2]], args, f"y={yv:g}"
            )
        item["png"] = os.path.join(out_dir, f"{stem}_h{i + 1}.png")
        ext = ((float(lo[0]) - 0.05, float(lo[2]) - 0.05), (float(hi[0]) + 0.05, float(hi[2]) + 0.05))
        slice_png(
            item,
            item["png"],
            ext,
            True,
            ax_h,
            t(
                f"水平截面 y={yv:.3f}（{eid or ''}，俯视：右 {ax_h[0]}，下 {ax_h[1]}）",
                f"horizontal section y={yv:.3f} ({eid or ''}, top view: right {ax_h[0]}, down {ax_h[1]})",
            ),
            [],
        )
        item.pop("_points", None)
        res["hslices"].append(item)
    res["hsliceNote"] = (
        "水平截面：chains = 扫描表面与平面的交线（[x,z]，按网格精确求交、简化容差 tol），"
        "footprint = 交线闭合 close 半径后填洞的外轮廓（逆时针，可直接作 extrude 的 outline）与洞"
    )

    # 4. 竖直截面
    cen2 = (lo + hi) / 2
    vs_specs = args.vslice or [f"x={cen2[0]:.3f}", f"z={cen2[2]:.3f}"]
    res["vslices"] = []
    for spec in vs_specs:
        n, c, tdir, p0, label, uname = slice_plane(spec, cen2)
        to2d = lambda Q, tdir=tdir, p0=p0, uname=uname: np.c_[  # noqa: E731
            (Q[:, 2] if uname == "z" else Q[:, 0]) if uname in "xz" else (Q - p0) @ tdir, Q[:, 1]
        ]
        if args.band > 0:
            item = band_result(PB, n, c, to2d, args, label)
        else:
            item = section_result(Vl, Fs, n, c, to2d, args, label)
        item["axes"] = [uname, "y"]
        # 横轴范围：交线范围（没有交线时用离平面 5 厘米内的点）外扩 10 厘米
        near_plane = np.abs(PL @ n - c) < 0.05
        us = [np.array(ch["points"])[:, 0] for ch in item["chains"]] or [to2d(PL[near_plane])[:, 0]]
        u_all = np.concatenate(us) if len(np.concatenate(us)) else to2d(PL)[:, 0]
        ext = ((float(u_all.min()) - 0.1, floor - 0.05), (float(u_all.max()) + 0.1, float(hi[1]) + 0.05))
        item["png"] = os.path.join(out_dir, f"{stem}_v{len(res['vslices']) + 1}.png")
        uname_d = uname.upper() if (uname in "xz" and not frame.active) else uname
        slice_png(
            item,
            item["png"],
            ext,
            False,
            (uname_d, "Y" if not frame.active else "y"),
            t(
                f"竖直截面 {label}（{eid or ''}：右 {uname_d}，上 y）",
                f"vertical section {spec} ({eid or ''}: right {uname_d}, up y)",
            ),
            [],
        )
        item.pop("_points", None)
        res["vslices"].append(item)
    res["vsliceNote"] = (
        "竖直截面：点是 [横轴, y]；x=c 时横轴是 z，z=c 时横轴是 x，p=x,z@yaw 时横轴是沿 (cos yaw, −sin yaw) "
        "离该点的距离 u"
    )

    # 5. 占用图
    occs = args.occ or [f"{floor + args.floor_gap:.3f}:{top:.3f}"]
    res["occupancy"] = []
    if frame.active:
        b2 = ((float(lo[0]), float(lo[2])), (float(hi[0]), float(hi[2])))
    else:
        b2 = ((float(box.lo[0]), float(box.lo[2])), (float(box.hi[0]), float(box.hi[2])))
    for i, o in enumerate(occs):
        y0, y1, _ = parse_range(o)
        path = os.path.join(out_dir, f"{stem}_occ{i + 1}.png")
        title = t(
            f"俯视占用图 {eid or ''}  y {y0:.2f}–{y1:.2f}", f"top occupancy {eid or ''}  y {y0:.2f}–{y1:.2f}"
        )
        res["occupancy"].append(
            occupancy_png(
                PL,
                y0,
                y1,
                path,
                b2,
                rrect,
                title,
                axes=("x" if frame.active else "X", "z" if frame.active else "Z"),
            )
        )

    # 6. 圆拟合
    res["circles"] = []
    for spec in args.circle or []:
        y0, y1, rectv = parse_range(spec)
        m = (PL[:, 1] >= y0) & (PL[:, 1] <= y1)
        if rectv:
            m &= (PL[:, 0] >= min(rectv[0], rectv[2])) & (PL[:, 0] <= max(rectv[0], rectv[2]))
            m &= (PL[:, 2] >= min(rectv[1], rectv[3])) & (PL[:, 2] <= max(rectv[1], rectv[3]))
        # 只用侧面（法线接近水平）的点：顶面、底面的点在圆盘内部，会把圆拉偏
        side = m & (np.abs(NL[:, 1]) < 0.6)
        use = side if side.sum() >= 30 else m
        fit = fit_circle(PL[use][:, [0, 2]])
        used = "侧面点" if use is side else "全部点"
        res["circles"].append({"spec": spec, "used": used, **(fit or {"error": "点太少"})})

    # 7. 颜色
    res["colors"] = {"overall": color_stats(C), "dominant": dominant_colors(PL, C), "boxes": []}
    for spec in args.color or []:
        name, b = parse_named_box(spec)
        m = b.contains(PL)
        res["colors"]["boxes"].append(
            {
                "name": name,
                "box": b.as_dict(),
                **(color_stats(C[m]) if m.sum() else {"error": "子区域里没有点"}),
            }
        )
    res["colors"]["note"] = (
        "扫描贴图颜色（sRGB 0–255，含烘焙光照）；dominant 是 k 均值分出的主要颜色及其所在范围"
    )

    # 8. 平面拟合（斜面朝向）
    res["planes"] = []
    center = np.array([cen2[0], (lo[1] + hi[1]) / 2, cen2[2]])
    for spec in args.plane or []:
        name, b = parse_named_box(spec)
        fit = fit_plane(PL[b.contains(PL)], outward_from=center)
        res["planes"].append(
            {"name": name, "box": b.as_dict(), **(fit or {"error": "选区里的点太少（至少 10 个）"})}
        )
    if res["planes"]:
        res["planeNote"] = (
            "slopeDeg = 平面与水平面的夹角（0 水平，90 竖直）；azimuthDeg = 法向朝向（SHAPES 偏航：0 = +Z，"
            "90 = +X）；rectCorners = 内点在平面上的最小外接矩形，从法向一侧看逆时针，可直接作 plate 的 "
            "points"
        )

    # 9. 高度图数字表
    res["heightmaps"] = []
    for spec in args.heightmap or []:
        y0, y1, rectv = parse_range(spec)
        res["heightmaps"].append(
            {"spec": spec, **heightmap_table(PL, y0, y1, rectv, args.hm_cell, args.hm_stat)}
        )

    wc.write_json(out_path, res)
    print_summary(res)
    print(f"完成：{out_path}，共 {time.time() - t0:.1f} 秒")
    return res


def print_summary(res: dict) -> None:
    b = res["bbox"]
    p = print
    p(
        f"\n== 外接框（{'局部' if res['frame'] else '空间'}坐标，米）  地面 y={res['floorY']}  点数 "
        f"{res['points']}"
    )
    p(f"  最值    min {b['min']}  max {b['max']}  尺寸 {b['size']}")
    p(f"  去离群  min {b['robust']['min']}  max {b['robust']['max']}  尺寸 {b['robust']['size']}")
    for k in ("hull", "robust"):
        mr = res["minRect"][k]
        if mr:
            p(f"  最小外接矩形（{k}）中心 {mr['center']}  尺寸 {mr['size']}  yaw {mr['yaw']}°")
    p("\n== 按高度剖面（2%–98%）")
    p(
        "   y0–y1        n     x 范围            z 范围            w      d      u 范围           v 范围     "
        "     面积  朝上  颜色"
    )
    for row in res["profile"]["rows"]:
        p(
            f"  {row['y0']:.2f}–{row['y1']:.2f} {row['n']:6d}  {row['x'][0]:6.3f}–{row['x'][1]:6.3f}  "
            f"{row['z'][0]:6.3f}–{row['z'][1]:6.3f}  {row['w']:5.3f}  {row['d']:5.3f}  "
            f"{row['u'][0]:6.3f}–{row['u'][1]:6.3f}  {row['v'][0]:6.3f}–{row['v'][1]:6.3f}  "
            f"{row['areaM2']:5.3f} {row['upFacing']:4.2f}  {row['color']}"
        )
    for kind in ("hslices", "vslices"):
        p(f"\n== {'水平' if kind == 'hslices' else '竖直'}截面（交线 #i 与图里的编号一致；完整顶点见 JSON）")
        for s in res[kind]:
            fps = s["footprint"]
            ch = s["chains"]
            p(
                f"  {s['at']}：交线 {len(ch)} 条，总长 {s.get('totalLength', 0)} 米；填充轮廓 {len(fps)} 块 "
                f"→ {s['png']}"
            )
            for i, c in enumerate(ch[:6]):
                pts = c["points"]
                p(
                    f"    #{i} {'闭合' if c['closed'] else '开口'} 长 {c['length']} 米 {len(pts)} 点  "
                    f"{pts[0]} … {pts[-1]}"
                )
            for i, f in enumerate(fps[:2]):
                holes = f" 含洞 {len(f['holes'])} 个（{f['holeArea']} 平方米）" if f["holes"] else ""
                p(
                    f"    轮廓[{i}] 面积 {f['area']} 平方米 {len(f['outline'])} 点 范围 "
                    f"{f['bbox']['min']}–{f['bbox']['max']}{holes}"
                )
    p("\n== 占用图")
    for o in res["occupancy"]:
        p(f"  y {o['range'][0]}–{o['range'][1]}：占用 {o['occupiedArea']} 平方米 → {o['png']}")
    if res["circles"]:
        p("\n== 圆拟合")
        for c in res["circles"]:
            text = c.get("error") or (
                f"圆心 {c['center']} 半径 {c['radius']} 残差 {c['rmsCm']} 厘米 "
                f"内点 {c['inlierShare']} 覆盖 {c['arcDegrees']}°"
            )
            p(f"  {c['spec']}（{c['used']}）：{text}")
    p("\n== 颜色")
    o = res["colors"]["overall"]
    p(f"  整体中位 {o['hex']} {o['median']}")
    for d in res["colors"]["dominant"]:
        p(f"  主色 {d['hex']} 占 {d['share']:.0%}  y {d['y10to90']}  x {d['x10to90']}  z {d['z10to90']}")
    for d in res["colors"]["boxes"]:
        text = (
            d.get("error") or f"{d['hex']} {d['median']}（25%–75%：{d['p25']}–{d['p75']}，{d['points']} 点）"
        )
        p(f"  {d['name']}：{text}")
    if res["planes"]:
        p("\n== 平面拟合（坡度 0 = 水平，90 = 竖直；方位 = 法向的 SHAPES 偏航）")
        for q in res["planes"]:
            if "error" in q:
                p(f"  {q['name']}：{q['error']}")
                continue
            p(
                f"  {q['name']}：法向 {q['normal']} 坡度 {q['slopeDeg']}° 方位 {q['azimuthDeg']}° "
                f"残差 {q['rmsCm']} 厘米"
                f"（最大 {q['maxCm']}）内点 {q['inlierShare']:.0%}/{q['points']} 点  平面上 {q['extent']} 米"
            )
            if q.get("rectCorners"):
                p(f"    外接矩形角点（逆时针，可作 plate.points）：{q['rectCorners']}")
    for h in res["heightmaps"]:
        p(
            f"\n== 高度图 {h['spec']}（{'最高' if h.get('stat') == 'top' else '最低'}点，单位米；行 = z，列 "
            "= x）"
        )
        if "error" in h:
            p(f"  {h['error']}")
            continue
        if h.get("note"):
            p(f"  {h['note']}")
        p("  z \\ x  " + " ".join(f"{x:6.2f}" for x in h["xCenters"]))
        for z, row in zip(h["zCenters"], h["heights"], strict=True):
            p(f"  {z:6.2f} " + " ".join("     -" if v is None else f"{v:6.3f}" for v in row))
