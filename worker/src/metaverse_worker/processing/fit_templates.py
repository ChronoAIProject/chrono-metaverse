"""按物体类型的拟合模板（设计 6.3 第 3 步）："按常见形状拟合，保留大棱角和弧度"。

每个模板读物体局部坐标里的扫描点（原点在物体底面中心的地面上，y 向上；椅子、沙发的正面朝 +z），
用 `fit_measure` 测出尺寸和特征，组合成 SHAPES 的常见形状：

- 桌子 `table`：台面是圆角矩形 / 跑道形 / 圆形 / 带圆弧折线的 `extrude`（边缘倒圆）；
  底座按台面下的投影块做圆柱、圆角盒或轮廓挤出，看不到时补 4 条腿；
- 椅子 `chair`：座面 `extrude`（圆角）；靠背连扶手是逐层圆弧带的 `loft`，保留靠背弧度；
  底座是转椅的立柱 + 4 爪 `sweep`，或 4 条 `sweep` 椅腿；
- 沙发 `sofa`：底座、座垫、扶手是圆角盒；靠背是侧面轮廓（保留后仰和顶部圆角）沿长度方向的挤出；
  离地高时补短腿；
- 前台 `counter`：俯视按最高点高度分层（台面、矮台），每层轮廓（圆弧 + 折线）挤出；
  主体再按高度分段挤出（踢脚线内收、上部外扩）；
- 柜子 `cabinet`、立柱 `pillar`、杂物 `clutter`：圆角盒；俯视不是矩形或上下不一样宽时用分段的轮廓挤出；
- 圆的东西（边几、花盆、灯）`round`、绿植 `plant`：按高度的半径剖面做 `lathe`。

每个叶子形状带一个临时字段 `_part = {"name", "uv"}`：部件名和建议的贴图投影（`planar` / `cylindrical`），
上色阶段（`fit_texture`）据此决定用纯色还是贴图，写出前去掉。
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy import ndimage

from .. import shapes as sh
from .fit_measure import (
    Mask2D,
    fit_circle,
    fit_footprint,
    height_peaks,
    is_convex,
    largest,
    occupancy,
    outline_polygon,
    polygon_contains,
    robust_range,
    trace_contour,
)

GRAY = (170, 170, 170)


@dataclass
class Local:
    """一个物体在自己局部坐标里的扫描点。"""

    L: np.ndarray  # (n, 3) 局部坐标
    N: np.ndarray  # (n, 3) 局部法线
    C: np.ndarray  # (n, 3) uint8
    info: dict[str, Any] = field(default_factory=dict)

    @property
    def y(self) -> np.ndarray:
        return self.L[:, 1]

    @property
    def xz(self) -> np.ndarray:
        return self.L[:, [0, 2]]

    def sub(self, m: np.ndarray) -> Local:
        return Local(self.L[m], self.N[m], self.C[m], self.info)


def part(shape: dict[str, Any], name: str, uv: str = "planar", prefer: str | None = None) -> dict[str, Any]:
    shape["material"] = sh.color_material(GRAY)
    shape["_part"] = {"name": name, "uv": uv}
    if prefer:
        shape["_part"]["prefer"] = prefer
    return shape


def tol_for(size: float) -> float:
    """轮廓简化容差随物体大小变化：小件 1 厘米，3 米以上 2.5 厘米。"""
    return float(np.interp(size, [0.5, 3.0], [0.01, 0.025]))


def _edge_fillet(thickness: float) -> float:
    return float(min(0.4 * thickness, 0.015))


# ---------------------------------------------------------------------------- 桌子


def fit_table(o: Local, top_y: float | None = None, thickness: float | None = None) -> dict[str, Any]:
    y = o.y
    up = o.N[:, 1] > 0.85
    if top_y is None:
        peaks = height_peaks(y[up & (y > 0.3)], 0.3, max(0.31, float(y.max())), 10)
        top_y = peaks[0][0] if peaks else float(np.percentile(y, 97))
    th = float(np.clip(thickness if thickness else 0.04, 0.015, 0.08))
    slab = (y > top_y - th - 0.03) & (y < top_y + 0.04)
    xz = o.xz[slab] if slab.sum() >= 20 else o.xz
    size = float(np.ptp(xz, axis=0).max())
    children = []
    fit = fit_footprint(xz, tol_for(size), cell=0.01 if size < 2.0 else 0.02)
    top_outline = fit.outline
    kind = fit.kind
    top = sh.extrude(top_outline, th, xf=sh.transform(position=[0, top_y - th, 0]))
    top["fillet"] = sh.r4(_edge_fillet(th))
    children.append(part(top, "top", "planar"))
    poly = outline_polygon(top_outline)
    under = top_y - th
    # 底座：台面下方 5 厘米以上的点在俯视里的连通块
    sup = (y > 0.05) & (y < under - 0.02) & polygon_contains(poly, o.xz)
    legs = []
    if sup.sum() >= 15:
        m = occupancy(o.xz[sup], 0.02, close=2)
        lab, n = ndimage.label(m.mask)
        for r in range(1, n + 1):
            reg = lab == r
            if reg.sum() * m.cell**2 < 0.004:
                continue
            zz, xx = np.nonzero(reg)
            pts = np.c_[m.x0 + (xx + 0.5) * m.cell, m.z0 + (zz + 0.5) * m.cell]
            legs.append(pts)
    if legs:
        for i, pts in enumerate(sorted(legs, key=lambda p: -len(p))[:6]):
            span = np.ptp(pts, axis=0)
            c = pts.mean(0)
            if max(span) < 0.14:
                r = max(0.015, max(span) / 2)
                leg = sh.cylinder(r, under, segments=16, xf=sh.transform(position=[c[0], 0, c[1]]))
            else:
                fit = fit_footprint(pts, 0.02, cell=0.02)
                if fit is not None and fit.kind == "circle":
                    cc, rr = fit.info["center"], fit.info["radius"]
                    leg = sh.cylinder(rr, under, segments=32, xf=sh.transform(position=[cc[0], 0, cc[1]]))
                elif fit is not None:
                    leg = sh.extrude(fit.outline, under)
                    leg["fillet"] = 0.01
                else:
                    lo, hi = pts.min(0), pts.max(0)
                    leg = sh.box(
                        [hi[0] - lo[0], under, hi[1] - lo[1]],
                        xf=sh.transform(position=[(lo[0] + hi[0]) / 2, 0, (lo[1] + hi[1]) / 2]),
                    )
            children.append(part(leg, f"base-{i + 1}", "cylindrical"))
    elif kind == "circle":
        children.append(part(sh.cylinder(0.04, under, segments=24), "base-1", "cylindrical"))
        r = min(0.25, 0.6 * float(np.ptp(poly[:, 0])) / 2)
        children.append(part(sh.cylinder(r, 0.03, segments=32), "foot", "cylindrical"))
    else:
        lo, hi = poly.min(0), poly.max(0)
        for i, (sx, sz) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
            x = (hi[0] + lo[0]) / 2 + sx * ((hi[0] - lo[0]) / 2 - 0.08)
            z = (hi[1] + lo[1]) / 2 + sz * ((hi[1] - lo[1]) / 2 - 0.08)
            children.append(
                part(
                    sh.box([0.04, under, 0.04], fillet=0.005, xf=sh.transform(position=[x, 0, z])),
                    f"leg-{i + 1}",
                    "planar",
                )
            )
    return sh.group(children)


# ---------------------------------------------------------------------------- 椅子


def _robust_circle(xz: np.ndarray) -> tuple[np.ndarray, float]:
    c, r, _ = fit_circle(xz)
    for _ in range(3):
        res = np.abs(np.hypot(xz[:, 0] - c[0], xz[:, 1] - c[1]) - r)
        s = 1.4826 * np.median(res) + 1e-3
        keep = res < 2.5 * s
        if keep.sum() < 8:
            break
        c, r, _ = fit_circle(xz[keep])
    return c, r


def _band_outline(c, R: float, t: float, phi0: float, phi1: float) -> dict[str, Any]:
    """以 c 为圆心、中半径 R、厚 t 的圆弧带，φ 从 −z 方向（靠背后方）量起，逆时针为正。"""
    ro, ri = R + t / 2, R - t / 2

    def at(r, phi):
        return (c[0] + r * math.sin(phi), c[1] - r * math.cos(phi))

    sweep = phi1 - phi0
    # 固定分成 4 段（每段不超过 90°，顶点组成的多边形本身也是逆时针的——校验按顶点算有向面积）；
    # 各层截面点数相同，放样时对应关系稳定，不会扭
    k = max(4, math.ceil(sweep / (math.pi / 2) - 1e-9))
    b = math.tan(sweep / k / 4)
    phis = [phi0 + sweep * i / k for i in range(k + 1)]
    pts = [at(ro, p) for p in phis] + [at(ri, p) for p in reversed(phis)]
    arcs = [{"from": i, "bulge": b} for i in range(k)] + [{"from": k + 1 + i, "bulge": -b} for i in range(k)]
    return sh.outline(pts, arcs=arcs)


def chair_measure(o: Local) -> dict[str, Any]:
    """椅子的座高（朝上的点在 0.33–0.58 米的峰）和顶高。"""
    y = o.y
    top = float(np.percentile(y, 98.5))
    up = o.N[:, 1] > 0.75
    peaks = height_peaks(y[up & (y > 0.33) & (y < 0.58)], 0.33, 0.58, 8)
    hs = peaks[0][0] if peaks else float(min(0.46, top * 0.55))
    return {"seat": hs, "top": top}


def _band_level(xz: np.ndarray, bin_deg: float = 12.0) -> list[float] | None:
    """一层截面里靠背（连扶手）的圆弧带：以局部原点为中心按方位分格，每格取外表面半径（85% 分位）；
    从正后方（−z）向两边找连续有点的格子，对这些外表面点拟合圆。返回 [cx, cz, 外半径, 厚度, φ0, φ1]，
    φ 从 −z 方向量起、逆时针为正（相对拟合的圆心）。"""
    phi = np.arctan2(xz[:, 0], -xz[:, 1])
    r = np.hypot(xz[:, 0], xz[:, 1])
    nb = round(360 / bin_deg)
    k = np.floor((phi + math.pi) / (2 * math.pi) * nb).astype(int) % nb
    rout = np.full(nb, np.nan)
    rin = np.full(nb, np.nan)
    counts = np.bincount(k, minlength=nb)
    back = nb // 2  # φ = 0（正后方）所在的格子
    # 有效格子要有足够的点：不少于正后方 ±30° 格子点数中位数的 30%（稀疏的杂点、相邻物体的边角不算）
    near_back = counts[[(back + d) % nb for d in range(-2, 3)]]
    need = max(3, int(0.3 * np.median(near_back)))
    for b in range(nb):
        rb = r[k == b]
        if len(rb) >= need and np.percentile(rb, 85) > 0.1:
            rout[b] = np.percentile(rb, 85)
            near = rb[rb > rout[b] - 0.2]
            rin[b] = np.percentile(near, 15) if len(near) >= 3 else rout[b] - 0.04
    valid = ~np.isnan(rout)
    if not (valid[back] or valid[back - 1] or valid[(back + 1) % nb]):
        return None
    run = {back} if valid[back] else set()
    for step in (1, -1):
        miss = 0
        j = back
        for _ in range(nb // 2 - 1):
            j = (j + step) % nb
            if valid[j]:
                run.add(j)
                miss = 0
            else:
                miss += 1
                if miss > 1:
                    break
    run_l = sorted(run)
    if len(run_l) < 2:
        return None
    ang = (np.array(run_l) + 0.5) / nb * 2 * math.pi - math.pi
    pts = np.c_[rout[run_l] * np.sin(ang), -rout[run_l] * np.cos(ang)]
    thick = float(np.clip(np.nanmedian(rout[run_l] - rin[run_l]), 0.03, 0.14))
    span = len(run_l) * bin_deg
    if span >= 50 and len(pts) >= 4:
        c, R, _ = fit_circle(pts)
        if R > 1.2 or c[1] < pts[:, 1].min() + 0.05:
            c, R = None, 0.0
    else:
        c, R = None, 0.0
    if c is None:
        R = 1.2
        c = np.array([float(pts[:, 0].mean()), float(pts[:, 1].min()) + R])
    pa = np.arctan2(pts[:, 0] - c[0], -(pts[:, 1] - c[1]))
    half = math.radians(bin_deg) / 2 * (R and 0.5)
    return [float(c[0]), float(c[1]), float(R), thick, float(pa.min() - half), float(pa.max() + half)]


def fit_chair(o: Local) -> dict[str, Any]:
    """局部坐标：正面朝 +z，靠背在 −z，原点在椅子中心的地面上。"""
    y = o.y
    meas = chair_measure(o)
    hs, top = meas["seat"], meas["top"]
    children: list[dict[str, Any]] = []
    # ---- 靠背（含扶手）：逐层圆弧带的放样
    levels = []
    if top - hs > 0.12:
        k = int(np.clip(round((top - hs) / 0.08) + 1, 3, 6))
        for yk in np.linspace(hs + 0.04, top - 0.02, k):
            m = np.abs(y - yk) < 0.025
            if m.sum() < 25:
                continue
            lv = _band_level(o.xz[m])
            if lv is not None:
                levels.append([float(yk), *lv])
    sm = None
    if len(levels) >= 2:
        A = np.array(levels)
        sm = A.copy()
        # 规整：圆心、半径、厚度各层取同一个值（中位数），只有圆弧两端的角度随高度线性变化（扶手往上收）
        for j in (1, 2, 3, 4):
            sm[:, j] = float(np.median(A[:, j]))
        for j in (5, 6):
            sm[:, j] = np.polyval(np.polyfit(A[:, 0], A[:, j], 1), A[:, 0])
        # 最低一层延到座面以下，和座面接上
        first = sm[0].copy()
        first[0] = hs - 0.03
        sm = np.vstack([first, sm])
        sections = []
        for yk, cx, cz, R, t, p0, p1 in sm:
            t = float(np.clip(t, 0.03, 0.14))
            R = max(float(R), t + 0.05)
            p0, p1 = float(max(p0, -2.3)), float(min(p1, 2.3))
            if p1 - p0 < 0.4:
                mid = (p0 + p1) / 2
                p0, p1 = mid - 0.2, mid + 0.2
            sections.append(
                {"y": sh.r4(yk), "outline": _band_outline((cx, cz), R - t / 2, max(t, 0.03), p0, p1)}
            )
        children.append(part({"type": "loft", "sections": sections}, "back", "cylindrical", "color"))
    # ---- 座面：靠背内侧、座高附近的点
    seat_m = (y > hs - 0.06) & (y < hs + 0.015)
    if sm is not None:
        _, cx, cz, R, t, _, _ = sm[0]
        seat_m &= np.hypot(o.L[:, 0] - cx, o.L[:, 2] - cz) < R - t + 0.02
    dn = (o.N[:, 1] < -0.5) & (y > 0.08) & (y < hs - 0.02)
    th = float(np.clip(hs - np.median(y[dn]), 0.04, 0.2)) if dn.sum() >= 10 else 0.07
    seat_outline = None
    if seat_m.sum() >= 30:
        sx = o.L[seat_m, 0]
        sz = o.L[seat_m, 2]
        x0, x1 = np.percentile(sx, [3, 97])
        z0, z1 = np.percentile(sz, [3, 97])
        if sm is not None:
            _, cx, cz, R, t, _, _ = sm[0]
            z0 = min(z0, cz - R + t)
        w, d = x1 - x0, z1 - z0
        if w > 0.15 and d > 0.15:
            seat_outline = sh.outline(
                [(x0, z0), (x1, z0), (x1, z1), (x0, z1)],
                fillets=[{"at": i, "radius": min(0.09, w / 4, d / 4)} for i in range(4)],
            )
    if seat_outline is None:
        if sm is not None:
            _, cx, cz, R, t, _, _ = sm[0]
            w = max(0.2, 1.6 * (R - t))
            seat_outline = sh.outline(
                [
                    (cx - w / 2, cz - R + t),
                    (cx + w / 2, cz - R + t),
                    (cx + w / 2, cz + 0.05),
                    (cx - w / 2, cz + 0.05),
                ],
                fillets=[{"at": i, "radius": 0.05} for i in range(4)],
            )
        else:
            lo, hi = o.xz.min(0), o.xz.max(0)
            seat_outline = sh.outline([(lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1])])
    seat = sh.extrude(seat_outline, th, xf=sh.transform(position=[0, hs - th, 0]))
    seat["fillet"] = sh.r4(min(0.02, th * 0.35))
    children.append(part(seat, "seat", "planar", "color"))
    # ---- 底座：立柱 + 4 爪，或 4 条腿
    bottom = hs - th
    poly = outline_polygon(seat_outline)
    sc = poly.mean(0)
    low = y < bottom - 0.03
    axis_pts = low & (y > 0.12) & (np.hypot(o.L[:, 0] - sc[0], o.L[:, 2] - sc[1]) < 0.08)
    spread = low & (y > 0.12) & (np.hypot(o.L[:, 0] - sc[0], o.L[:, 2] - sc[1]) >= 0.12)
    if bottom > 0.2 and axis_pts.sum() >= 8 and axis_pts.sum() >= spread.sum():
        feet = low & (y < 0.14)
        rr = np.hypot(o.L[feet, 0] - sc[0], o.L[feet, 2] - sc[1]) if feet.sum() > 5 else np.array([0.28])
        reach = float(np.clip(np.percentile(rr, 90), 0.22, 0.32))
        children.append(
            part(
                sh.cylinder(
                    0.028, bottom - 0.09, segments=16, xf=sh.transform(position=[sc[0], 0.09, sc[1]])
                ),
                "column",
                "cylindrical",
            )
        )
        for i in range(4):
            a = math.radians(45 + 90 * i)
            path = [[sc[0], 0.1, sc[1]], [sc[0] + reach * math.sin(a), 0.015, sc[1] + reach * math.cos(a)]]
            leg = {
                "type": "sweep",
                "path": [[sh.r4(v) for v in p] for p in path],
                "section": {"circle": 0.013},
            }
            children.append(part(leg, f"leg-{i + 1}", "cylindrical"))
    elif bottom > 0.03:
        lo, hi = poly.min(0), poly.max(0)
        for i, (sx, sz) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
            fx = sc[0] + sx * ((hi[0] - lo[0]) / 2 - 0.04)
            fz = sc[1] + sz * ((hi[1] - lo[1]) / 2 - 0.04)
            tx = sc[0] + (fx - sc[0]) * 0.85
            tz = sc[1] + (fz - sc[1]) * 0.85
            path = [[fx, 0.0, fz], [tx, bottom + 0.005, tz]]
            leg = {
                "type": "sweep",
                "path": [[sh.r4(v) for v in p] for p in path],
                "section": {"circle": 0.013},
            }
            children.append(part(leg, f"leg-{i + 1}", "cylindrical"))
    return sh.group(children)


# ---------------------------------------------------------------------------- 沙发


def fit_sofa(o: Local) -> dict[str, Any]:
    """局部坐标：长边沿 x，靠背在 −z。"""
    y, x, z = o.y, o.L[:, 0], o.L[:, 2]
    xlo, xhi = robust_range(x, 0.5, 99.5)
    zlo, zhi = robust_range(z, 0.5, 99.5)
    length, depth = xhi - xlo, zhi - zlo
    cx = (xlo + xhi) / 2
    top = float(np.percentile(y, 99))
    up = o.N[:, 1] > 0.75
    mid = np.abs(x - cx) < length / 2 - 0.25
    peaks = height_peaks(y[up & mid & (y > 0.25) & (y < 0.65)], 0.25, 0.65, 10)
    hs = peaks[0][0] if peaks else 0.45
    # 扶手：两端高于座面的部分
    arm_w, arm_h = 0.0, hs
    ends = (np.abs(x - cx) > length / 2 - 0.35) & (y > hs + 0.06) & (z > zlo + 0.25)
    if ends.sum() > 30:
        ah = np.percentile(y[ends], 90)
        if ah > hs + 0.08:
            arm_h = float(ah)
            inner = []
            for side in (-1, 1):
                q = ends & (np.sign(x - cx) == side) & (y > arm_h - 0.08)
                if q.sum() > 10:
                    inner.append(length / 2 - np.percentile(np.abs(x[q] - cx), 5))
            if inner:
                arm_w = float(np.clip(np.median(inner), 0.08, 0.35))
    # 靠背：中段（扶手之间）的侧面轮廓——按 z 分格的最高点，高过"座面和靠背顶的中间"的格子是靠背；
    # 靠背前表面在三个高度上的位置给出侧面轮廓（保留后仰和靠背顶的圆角）
    central = np.abs(x - cx) < length / 2 - arm_w - 0.02
    back_top = max(top, hs + 0.3)
    prof: list[tuple[float, float]] = []
    if (central & (y > hs + 0.12)).sum() > 30:
        back_top = float(np.percentile(y[central & (y > hs + 0.12)], 97))
        cut = (hs + back_top) / 2
        fronts = []
        for yk in (hs + 0.06, (hs + back_top) / 2, back_top - 0.04):
            q = central & (np.abs(y - yk) < 0.03) & (z < zlo + depth * 0.6)
            if q.sum() < 10:
                continue
            bins = np.arange(zlo, zlo + depth * 0.6 + 0.02, 0.02)
            hist, _ = np.histogram(z[q], bins=bins)
            occ = np.nonzero(hist >= max(2, hist.max() * 0.15))[0]
            if len(occ):
                # 从后往前第一段连续占用的前沿
                k = occ[0]
                while k + 1 < len(hist) and hist[k + 1] >= max(2, hist.max() * 0.15):
                    k += 1
                fronts.append((yk, float(bins[k + 1])))
        if fronts and max(f for _, f in fronts) > zlo + 0.08:
            prof = fronts
        del cut
    back_d = float(np.clip(max((f for _, f in prof), default=zlo + 0.2) - zlo, 0.12, depth * 0.55))
    # 底座离地：正面朝前的点最低处
    front_pts = (o.N[:, 2] > 0.6) & (z > zhi - 0.15)
    base0 = float(np.clip(np.percentile(y[front_pts], 3), 0.0, 0.2)) if front_pts.sum() > 20 else 0.0
    if base0 < 0.04:
        base0 = 0.0
    children = []
    inner_l = length - 2 * arm_w
    base_h = max(0.05, hs - 0.14 - base0)
    children.append(
        part(
            sh.box(
                [length, base_h, depth], fillet=0.02, xf=sh.transform(position=[cx, base0, (zlo + zhi) / 2])
            ),
            "base",
            "cylindrical",
        )
    )
    cush_d = depth - back_d
    cush_h = hs - base0 - base_h
    if cush_h > 0.03:
        children.append(
            part(
                sh.box(
                    [inner_l, cush_h, cush_d],
                    fillet=min(0.05, cush_h / 2.2),
                    xf=sh.transform(position=[cx, base0 + base_h, zhi - cush_d / 2]),
                ),
                "seat",
                "planar",
            )
        )
    bh = back_top - base0 - base_h
    if bh > 0.05:
        y0 = base0 + base_h
        if len(prof) >= 2:
            # 侧面轮廓（u = 高度 y，v = 深度 z）沿 x 挤出：roll 90° 把挤出方向转到 −x
            fr = sorted(prof)
            pts = (
                [(y0, zlo), (y0, fr[0][1])]
                + [(yy, zz) for yy, zz in fr]
                + [(back_top, fr[-1][1]), (back_top, zlo)]
            )
            pts = [
                p
                for i, p in enumerate(pts)
                if i == 0 or abs(p[0] - pts[i - 1][0]) + abs(p[1] - pts[i - 1][1]) > 1e-3
            ]
            if sh.signed_area(pts) < 0:
                pts = pts[::-1]
            n = len(pts)
            top_ids = [i for i, p in enumerate(pts) if abs(p[0] - back_top) < 1e-6]
            fil = [{"at": i, "radius": min(0.06, back_d / 2.5)} for i in top_ids if 0 <= i < n]
            back = sh.extrude(
                sh.outline(pts, fillets=fil),
                inner_l,
                xf=sh.transform(position=[cx + inner_l / 2, 0, 0], roll=90),
            )
            back["fillet"] = 0.03
        else:
            back = sh.box(
                [inner_l, bh, back_d],
                fillet=min(0.06, back_d / 2.2),
                xf=sh.transform(position=[cx, y0, zlo + back_d / 2]),
            )
        children.append(part(back, "back", "planar"))
    if arm_w > 0:
        ah = arm_h - base0
        for side in (-1, 1):
            children.append(
                part(
                    sh.box(
                        [arm_w, ah, depth],
                        fillet=min(0.06, arm_w / 2.2),
                        xf=sh.transform(
                            position=[cx + side * (length / 2 - arm_w / 2), base0, (zlo + zhi) / 2]
                        ),
                    ),
                    "arm-" + ("left" if side < 0 else "right"),
                    "planar",
                )
            )
    if base0 > 0:
        for i, (sx, sz) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
            children.append(
                part(
                    sh.cylinder(
                        0.02,
                        base0,
                        segments=12,
                        radius_top=0.015,
                        xf=sh.transform(
                            position=[
                                cx + sx * (length / 2 - 0.08),
                                0,
                                (zlo + zhi) / 2 + sz * (depth / 2 - 0.08),
                            ]
                        ),
                    ),
                    f"foot-{i + 1}",
                    "cylindrical",
                )
            )
    return sh.group(children)


# ---------------------------------------------------------------------------- 前台（分层挤出）


def fit_terrace(o: Local, *, cell: float = 0.03, max_levels: int = 4, name: str = "body") -> dict[str, Any]:
    """俯视按最高点高度分层：每层的区域按轮廓（圆弧 + 折线）挤出到该层高度。主层（面积最大的）
    用 3 个截面的 loft 表达立面的折面：各高度截面相对主层轮廓的整体外扩量。"""
    y = o.y
    m = occupancy(o.xz, cell, close=1, fill=False)
    iz = ((o.L[:, 2] - m.z0) / cell).astype(int)
    ix = ((o.L[:, 0] - m.x0) / cell).astype(int)
    hmax = np.zeros(m.mask.shape)
    np.maximum.at(hmax, (iz, ix), y)
    occ = hmax > 0.05
    occ = ndimage.binary_closing(occ, iterations=1) | occ
    hmax = ndimage.grey_closing(hmax, size=(3, 3)) * occ
    vals = hmax[occ]
    peaks = height_peaks(vals, 0.05, float(vals.max()) + 0.02, max(4, int(0.08 * occ.sum())), bin_=0.02)
    levels: list[float] = []
    for h, _ in peaks:
        if all(abs(h - q) > 0.1 for q in levels):
            levels.append(h)
        if len(levels) >= max_levels:
            break
    if not levels:
        levels = [float(np.percentile(vals, 90))]
    levels.sort()
    lv = np.array(levels)
    assign = np.argmin(np.abs(hmax[..., None] - lv[None, None, :]), axis=-1)
    children = []
    regions = []
    for k, h in enumerate(levels):
        reg = occ & (assign == k)
        reg = ndimage.binary_opening(ndimage.binary_closing(reg, iterations=1), iterations=1)
        lab, n = ndimage.label(reg)
        for r in range(1, n + 1):
            rm = lab == r
            if rm.sum() * cell * cell < 0.03:
                continue
            regions.append((h, rm))
    if not regions:
        return fit_box(o)
    main = max(regions, key=lambda t: t[1].sum())
    for i, (h, rm) in enumerate(sorted(regions, key=lambda t: -t[1].sum())[:8]):
        zz, xx = np.nonzero(rm)
        cxz = np.c_[m.x0 + (xx + 0.5) * cell, m.z0 + (zz + 0.5) * cell]
        if len(cxz) < 6:
            continue
        size = float(np.ptp(cxz, axis=0).max())
        fit = fit_footprint(cxz, tol_for(size) * 1.2, mask=Mask2D(rm, m.x0, m.z0, cell))
        top = float(h)
        if rm is main[1]:
            # 主体：区域里的点再按高度分段挤出（踢脚线内收、上部外扩的立面），分不出段时试截面放样
            inside = Mask2D(ndimage.binary_dilation(rm, iterations=1), m.x0, m.z0, cell)
            iz2 = np.clip(((o.L[:, 2] - m.z0) / cell).astype(int), 0, rm.shape[0] - 1)
            ix2 = np.clip(((o.L[:, 0] - m.x0) / cell).astype(int), 0, rm.shape[1] - 1)
            sub = o.sub(inside.mask[iz2, ix2] & (o.y <= top + 0.03))
            stack = fit_stack(sub, max_bands=4, name=f"{name}-{i + 1}") if len(sub.L) > 200 else None
            if stack is not None:
                children.extend(stack["children"])
                continue
            shape = _facade_loft(o, fit.outline, top) or sh.extrude(fit.outline, top)
        else:
            shape = sh.extrude(fit.outline, top)
        if shape["type"] == "extrude":
            shape["fillet"] = 0.01 if is_convex(shape["outline"]) else None
            if shape["fillet"] is None:
                del shape["fillet"]
        children.append(part(shape, f"{name}-{i + 1}", "cylindrical"))
    if not children:
        return fit_box(o)
    return sh.group(children)


def _facade_loft(o: Local, outline: dict[str, Any], top: float) -> dict[str, Any] | None:
    """主层的立面：在 3–4 个高度上量截面相对轮廓的外扩量（中位数的带符号距离），不明显时返回 None。"""
    poly = outline_polygon(outline)
    if len(poly) < 3 or len(poly) > 400:
        return None
    ys = [0.04, top * 0.35, top * 0.7, top - 0.03]
    offs = []
    seg_a = poly
    seg_b = np.roll(poly, -1, axis=0)
    for yk in ys:
        msk = np.abs(o.y - yk) < 0.03
        if msk.sum() < 30:
            offs.append(None)
            continue
        p = o.xz[msk]
        # 点到折线的距离，按在多边形内外取符号
        d = np.full(len(p), np.inf)
        for a, b in zip(seg_a, seg_b, strict=True):
            ab = b - a
            t = np.clip(((p - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
            d = np.minimum(d, np.hypot(*(p - (a + t[:, None] * ab)).T))
        inside = polygon_contains(poly, p)
        sd = np.where(inside, -d, d)
        near = np.abs(sd) < 0.15
        offs.append(float(np.percentile(sd[near], 80)) if near.sum() > 20 else None)
    vals = [v for v in offs if v is not None]
    if len(vals) < 2 or max(vals) - min(vals) < 0.03:
        return None
    from .fit_measure import offset_outline

    sections = []
    for yk, off in zip(ys, offs, strict=True):
        if off is None:
            continue
        off = float(np.clip(off, -0.12, 0.12))
        ol = offset_outline(outline, off) if abs(off) > 0.003 else outline
        sections.append({"y": sh.r4(yk if yk > 0.05 else 0.0), "outline": ol})
    sections[-1]["y"] = sh.r4(top)
    if len(sections) < 2:
        return None
    return {"type": "loft", "sections": sections}


# ---------------------------------------------------------------------------- 盒子、旋转体


def fit_box(o: Local, name: str = "body", uv: str = "cylindrical") -> dict[str, Any]:
    """圆角盒；俯视明显不是矩形时用轮廓挤出。"""
    y = o.y
    top = float(np.percentile(y, 99))
    bottom = max(0.0, float(np.percentile(y, 0.5)))
    if bottom < 0.06:
        bottom = 0.0
    xz = o.xz
    size = float(np.ptp(xz, axis=0).max())
    cell = 0.01 if size < 1.0 else 0.02
    m = occupancy(xz, cell, close=2)
    frag = largest(m.mask).sum() < 0.75 * m.mask.sum()
    h = max(0.02, top - bottom)
    if frag:
        # 俯视占用碎成几块（扫描稀疏、细长的东西）：取稳健的外接框
        lo = np.percentile(xz, 1, axis=0)
        hi = np.percentile(xz, 99, axis=0)
        dims = np.maximum(hi - lo, 0.02)
        shape = sh.box(
            [dims[0], h, dims[1]],
            fillet=sh.r4(min(0.01, float(dims.min()) / 3, h / 3)),
            xf=sh.transform(position=[(lo[0] + hi[0]) / 2, bottom, (lo[1] + hi[1]) / 2]),
        )
        return sh.group([part(shape, name, uv)])
    if True:
        fit = fit_footprint(xz, tol_for(size) * 1.5, mask=m)
        if fit.kind == "rect":
            hx, hz = fit.info["half"]
            c = fit.info["center"]
            r = float(fit.info["radius"])
            shape = sh.box(
                [2 * hx, h, 2 * hz],
                fillet=sh.r4(min(max(0.008, r), min(hx, hz, h / 2) * 0.9)),
                xf=sh.transform(position=[c[0], bottom, c[1]]),
            )
            return sh.group([part(shape, name, uv)])
        shape = sh.extrude(fit.outline, h, xf=sh.transform(position=[0, bottom, 0]))
        if is_convex(fit.outline):
            shape["fillet"] = 0.008
        return sh.group([part(shape, name, uv)])
    lo, hi = xz.min(0), xz.max(0)
    shape = sh.box(
        [hi[0] - lo[0], h, hi[1] - lo[1]],
        fillet=0.01,
        xf=sh.transform(position=[(lo[0] + hi[0]) / 2, bottom, (lo[1] + hi[1]) / 2]),
    )
    return sh.group([part(shape, name, uv)])


def fit_stack(
    o: Local, *, max_bands: int = 4, name: str = "body", uv: str = "cylindrical"
) -> dict[str, Any] | None:
    """按高度分段的轮廓挤出：俯视轮廓在哪些高度明显变化（相邻 10 厘米切片的占用交并比低于 0.6）就在哪里分段，
    每段把这一段的俯视轮廓（圆角矩形 / 带圆弧的折线）挤出到这一段的高度。用于柜子、展示架、前台这类
    上下不一样宽的东西。只有一段时返回 None。"""
    y = o.y
    top = float(np.percentile(y, 99.5))
    bottom = max(0.0, float(np.percentile(y, 0.3)))
    if bottom < 0.06:
        bottom = 0.0
    xz = o.xz
    cell = 0.02
    m_all = occupancy(xz, cell, close=0, fill=False)
    edges = np.arange(bottom, top + 0.1, 0.1)
    masks = []
    for a, b in itertools.pairwise(edges):
        q = (y >= a) & (y < b)
        mk = np.zeros_like(m_all.mask)
        if q.sum():
            mk[((xz[q, 1] - m_all.z0) / cell).astype(int), ((xz[q, 0] - m_all.x0) / cell).astype(int)] = True
        masks.append(ndimage.binary_closing(mk, iterations=2))
    if len(masks) < 2:
        return None
    bands: list[list[int]] = [[0]]
    acc = masks[0].copy()
    for k in range(1, len(masks)):
        inter = (acc & masks[k]).sum()
        union = (acc | masks[k]).sum()
        iou = inter / union if union else 1.0
        if iou < 0.6 and masks[k].sum() > 0 and len(bands) < max_bands:
            bands.append([k])
            acc = masks[k].copy()
        else:
            bands[-1].append(k)
            acc |= masks[k]
    # 太薄的段并到相邻段
    merged: list[list[int]] = []
    for band in bands:
        if merged and (len(band) < 2 or len(merged[-1]) < 2):
            merged[-1].extend(band)
        else:
            merged.append(list(band))
    if len(merged) < 2:
        return None
    children = []
    for i, band in enumerate(merged):
        y0 = float(edges[band[0]]) if i > 0 else bottom
        y1 = float(edges[band[-1] + 1]) if i < len(merged) - 1 else top
        q = (y >= y0) & (y < y1)
        if q.sum() < 20 or y1 - y0 < 0.03:
            continue
        pts = xz[q]
        size = float(np.ptp(pts, axis=0).max())
        fit = fit_footprint(pts, tol_for(size) * 1.5)
        if fit.kind == "rect":
            hx, hz = fit.info["half"]
            c = fit.info["center"]
            r = float(fit.info.get("radius", 0.0))
            shape = sh.box(
                [2 * hx, y1 - y0, 2 * hz],
                fillet=sh.r4(min(max(0.008, r), min(hx, hz, (y1 - y0) / 2) * 0.9)),
                xf=sh.transform(position=[c[0], y0, c[1]]),
            )
        else:
            shape = sh.extrude(fit.outline, y1 - y0, xf=sh.transform(position=[0, y0, 0]))
            if is_convex(fit.outline):
                shape["fillet"] = 0.008
        children.append(part(shape, f"{name}-{i + 1}", uv))
    if len(children) < 2:
        return None
    return sh.group(children)


def radial_profile(o: Local, n_max: int = 10) -> list[list[float]]:
    """绕局部 y 轴的半径剖面：每个高度带取半径的 90% 分位数，简化成至多 n_max 个点。"""
    y = o.y
    r = np.hypot(o.L[:, 0], o.L[:, 2])
    top = float(np.percentile(y, 99.5))
    bottom = max(0.0, float(np.percentile(y, 0.3)))
    if bottom < 0.05:
        bottom = 0.0
    edges = np.linspace(bottom, top, int(np.clip((top - bottom) / 0.04, 4, 40)) + 1)
    prof = []
    for a, b in itertools.pairwise(edges):
        m = (y >= a) & (y < b)
        if m.sum() >= 5:
            prof.append([float(np.percentile(r[m], 90)), (a + b) / 2])
    if not prof:
        return [[0.0, bottom], [0.1, bottom], [0.1, top], [0.0, top]]
    pr = np.array(prof)
    pr[:, 0] = ndimage.median_filter(pr[:, 0], size=3, mode="nearest")
    pts = [[pr[0, 0], bottom], *pr.tolist(), [pr[-1, 0], top]]
    from .fit_measure import _dp

    arr = np.array(pts)
    keep = _dp(arr, 0.012)
    if len(keep) > n_max:
        keep = _dp(arr, 0.03)
    arr = arr[keep]
    out = [[0.0, bottom]] + [[sh.r4(max(0.005, p[0])), sh.r4(p[1])] for p in arr] + [[0.0, top]]
    return out


def fit_round(o: Local, name: str = "body") -> dict[str, Any]:
    prof = radial_profile(o)
    return sh.group([part({"type": "lathe", "profile": prof, "segments": 32}, name, "cylindrical")])


def fit_plant(o: Local) -> dict[str, Any]:
    """花盆 + 枝叶：下部（颜色不绿的部分）是花盆旋转体，上部枝叶按半径剖面做旋转体。"""
    y = o.y
    C = o.C.astype(float)
    green = (C[:, 1] > C[:, 0] + 8) & (C[:, 1] > C[:, 2] - 4)
    top = float(np.percentile(y, 99.5))
    pot_top = 0.0
    if green.any():
        gy = y[green]
        pot_top = float(np.clip(np.percentile(gy, 3), 0.0, top * 0.6))
    children = []
    if pot_top > 0.12:
        pot = o.sub(y < pot_top)
        children.append(
            part({"type": "lathe", "profile": radial_profile(pot, 6), "segments": 32}, "pot", "cylindrical")
        )
    leaves = o.sub(y >= pot_top) if pot_top > 0.12 else o
    children.append(
        part(
            {"type": "lathe", "profile": radial_profile(leaves, 12), "segments": 24}, "leaves", "cylindrical"
        )
    )
    return sh.group(children)


def circularity(o: Local) -> float:
    """俯视占用相对拟合圆的均方根残差 / 半径（越小越圆）。"""
    m = occupancy(o.xz, 0.02, close=2)
    reg = largest(m.mask)
    cont = trace_contour(type(m)(reg, m.x0, m.z0, m.cell))
    if cont is None or len(cont) < 8:
        return 1.0
    _, r, rmse = fit_circle(cont)
    return rmse / max(r, 1e-6)
