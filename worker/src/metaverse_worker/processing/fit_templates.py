"""按物体类型的拟合模板（设计 6.3 第 3 步）："按常见形状拟合，保留大棱角和弧度"。

每个模板读物体局部坐标里的扫描点（原点在物体底面中心的地面上，y 向上；椅子、沙发的正面朝 +z），
用 `fit_measure` 测出尺寸和特征，组合成 SHAPES 的常见形状：

- 桌子 `table`：台面是圆角矩形 / 跑道形 / 圆形 / 带圆弧折线的 `extrude`（边缘倒圆）；
  底座按台面下的投影块做圆柱、圆角盒或轮廓挤出，看不到时补 4 条腿；
- 椅子 `chair`：座面 `extrude`（圆角）；靠背连扶手是逐层圆弧带的 `loft`，保留靠背弧度；
  底座是转椅的立柱 + 4 爪 `sweep`，或 4 条 `sweep` 椅腿；
- 沙发 `sofa`：底座、分块的坐垫是圆角盒；分块的靠背垫和两侧扶手是侧面轮廓（带圆弧：靠背的后仰和顶部、
  扶手卷边的前上角）的挤出，两端倒圆边；离地高时补短腿；面料是一个材质组（同一个颜色）；
- 前台 `counter`：外壳折面放样 + 台面 + 工作台面的多面体在 `fit_counter`；量不出外壳时退回这里的
  分层挤出（俯视按最高点高度分层，每层轮廓挤出）；
- 柜子 `cabinet`、立柱 `pillar`、杂物 `clutter`：圆角盒；俯视不是矩形或上下不一样宽时用分段的轮廓挤出；
  只扫到相邻两个面的高柜（另两面靠墙、面上是镜子）按看到的面定尺寸，做竖直的圆角盒；
- 圆的东西（边几、花盆、灯）`round`、绿植 `plant`：按高度的半径剖面做 `lathe`。

每个叶子形状带一个临时字段 `_part = {"name", "uv", "prefer"?, "group"?, "albedo"?}`：部件名、建议的贴图投影
（`planar` / `cylindrical`）、是否偏向纯色、材质组（同组取同一个颜色）、取色偏亮（浅色单一材质），
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


def part(
    shape: dict[str, Any], name: str, uv: str = "planar", prefer: str | None = None, group: str | None = None
) -> dict[str, Any]:
    """叶子形状加上部件信息：`prefer="color"` 偏向纯色；`group` 是材质组，同组的部件取同一个颜色。"""
    shape["material"] = sh.color_material(GRAY)
    shape["_part"] = {"name": name, "uv": uv}
    if prefer:
        shape["_part"]["prefer"] = prefer
    if group:
        shape["_part"]["group"] = group
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
    # 台面偏向规整的形状（圆角矩形、跑道形、圆、凸包）：桌边的椅子、没扫全的台面让占用不规则，不追这些
    fit = fit_footprint(xz, tol_for(size), cell=0.01 if size < 2.0 else 0.02, complexity=0.012)
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


def _side_extrude(
    pts: list[tuple[float, float]],
    arcs: list[tuple[int, float]],
    fillets: list[tuple[int, float]],
    width: float,
    x_right: float,
    edge: float,
) -> dict[str, Any]:
    """侧面轮廓（点是 (高度 y, 深度 z)）沿 x 挤出 width：roll 90° 把挤出方向转到 −x，右端在 x_right。
    点按顺时针给出时整体反过来（圆弧的 from 和圆角的 at 跟着换下标，凸向外的含义不变）。"""
    n = len(pts)
    if sh.signed_area(pts) < 0:
        pts = pts[::-1]
        arcs = [((n - 2 - f) % n, b) for f, b in arcs]
        fillets = [((n - 1 - a) % n, r) for a, r in fillets]
    shape = sh.extrude(
        sh.outline(
            pts,
            arcs=[{"from": f, "bulge": b} for f, b in arcs] or None,
            fillets=[{"at": a, "radius": r} for a, r in fillets if r > 0.004] or None,
        ),
        width,
        xf=sh.transform(position=[x_right, 0, 0], roll=90),
    )
    if edge > 0.004:
        shape["fillet"] = sh.r4(edge)
    return shape


def _tangent_arc(corner, d_in, d_out, r: float):
    """折线在 corner 处转弯（进来方向 d_in，出去方向 d_out，都是单位向量）：
    半径 r 的相切圆弧的两个端点和凸度。"""
    cosang = float(np.clip(np.dot(d_in, d_out), -1.0, 1.0))
    theta = math.acos(cosang)
    if theta < 1e-3:
        return None
    t = r * math.tan(theta / 2)
    p1 = np.asarray(corner) - t * np.asarray(d_in)
    p2 = np.asarray(corner) + t * np.asarray(d_out)
    return tuple(p1), tuple(p2), math.tan(theta / 4)


def sofa_measure(o: Local) -> dict[str, Any]:
    """沙发的尺寸（局部坐标：长边沿 x，靠背在 −z）：外框、座高、扶手（两边取低的那个高度和中位的宽度——
    坐在扶手上的人、放在扶手上的东西只会让一边变高）、靠背顶高（中段分三格取中位）、
    靠背前表面随高度的直线（后仰）、离地高度。"""
    y, x, z = o.y, o.L[:, 0], o.L[:, 2]
    xlo, xhi = robust_range(x, 0.5, 99.5)
    zlo, zhi = robust_range(z, 0.5, 99.5)
    length, depth = xhi - xlo, zhi - zlo
    cx = (xlo + xhi) / 2
    up = o.N[:, 1] > 0.75
    mid = np.abs(x - cx) < length / 2 - 0.25
    peaks = height_peaks(y[up & mid & (y > 0.25) & (y < 0.65)], 0.25, 0.65, 10)
    hs = peaks[0][0] if peaks else 0.45
    arm_h, arm_w, arm_front = hs, 0.0, zhi
    ends = (np.abs(x - cx) > length / 2 - 0.35) & (y > hs + 0.06) & (z > zlo + 0.25)
    heights, widths, fronts = [], [], []
    for side in (-1, 1):
        q = ends & (np.sign(x - cx) == side)
        if q.sum() < 20:
            continue
        ah = float(np.percentile(y[q], 90))
        if ah < hs + 0.08:
            continue
        heights.append(ah)
        top = q & (y > ah - 0.08)
        if top.sum() > 10:
            widths.append(length / 2 - float(np.percentile(np.abs(x[top] - cx), 5)))
        # 扶手前沿：座面以上的扶手点（卷边的扶手顶面往前是弯下去的，只看顶面会偏后）
        fronts.append(float(np.percentile(z[q], 97)))
    if heights:
        arm_h = min(heights)
        arm_w = float(np.clip(np.median(widths), 0.08, 0.35)) if widths else 0.15
        arm_front = float(np.clip(np.median(fronts), zlo + 0.3, zhi)) if fronts else zhi
    central = np.abs(x - cx) < length / 2 - arm_w - 0.02
    high = central & (y > hs + 0.12)
    back_top = max(float(np.percentile(y, 99)), hs + 0.3)
    if high.sum() > 30:
        xs = np.linspace(cx - (length / 2 - arm_w), cx + (length / 2 - arm_w), 4)
        tops = [
            float(np.percentile(y[high & (x >= a) & (x < b)], 97))
            for a, b in itertools.pairwise(xs)
            if (high & (x >= a) & (x < b)).sum() > 10
        ]
        if tops:
            back_top = float(np.median(tops))
    # 靠背前表面：几个高度上，中段从后往前第一段连续占用的前沿
    fronts_y: list[tuple[float, float]] = []
    for yk in np.linspace(hs + 0.06, back_top - 0.06, 4):
        q = central & (np.abs(y - yk) < 0.03) & (z < zlo + depth * 0.7)
        if q.sum() < 10:
            continue
        bins = np.arange(zlo, zlo + depth * 0.7 + 0.02, 0.02)
        hist, _ = np.histogram(z[q], bins=bins)
        need = max(2, hist.max() * 0.15)
        occ = np.nonzero(hist >= need)[0]
        if len(occ):
            k = occ[0]
            while k + 1 < len(hist) and hist[k + 1] >= need:
                k += 1
            fronts_y.append((float(yk), float(bins[k + 1])))
    if len(fronts_y) >= 2:
        fy = np.array(fronts_y)
        b, a = np.polyfit(fy[:, 0], fy[:, 1], 1)
    else:
        a, b = zlo + 0.2, 0.0
    # 离地高度：中段前部朝前（含往下弯的圆角）的点最低处；细腿上的点很少，不影响 3% 分位
    front_pts = central & (o.N[:, 2] > 0.3) & (z > zhi - 0.25)
    base0 = float(np.clip(np.percentile(y[front_pts], 3), 0.0, 0.2)) if front_pts.sum() > 20 else 0.0
    if base0 < 0.06:
        base0 = 0.0
    # 座面以下前表面往里收（底座、扶手下部）：低处朝前的点的前沿
    low = (o.N[:, 2] > 0.5) & (y > base0 + 0.03) & (y < hs - 0.12)
    base_front = zhi
    if (low & central).sum() > 20:
        base_front = float(np.clip(np.percentile(z[low & central], 90), zhi - 0.2, zhi))
    arm_base_front = arm_front
    ends_low = low & (np.abs(x - cx) > length / 2 - max(arm_w, 0.1))
    if ends_low.sum() > 20:
        arm_base_front = float(np.clip(np.percentile(z[ends_low], 90), arm_front - 0.2, arm_front))
    return {
        "xlo": xlo, "xhi": xhi, "zlo": zlo, "zhi": zhi, "cx": cx, "hs": hs,
        "arm_h": arm_h, "arm_w": arm_w, "arm_front": arm_front, "back_top": back_top,
        "back_a": float(a), "back_b": float(b), "base0": base0,
        "base_front": base_front, "arm_base_front": arm_base_front,
    }  # fmt: skip


def fit_sofa(o: Local) -> dict[str, Any]:
    """沙发 = 底座 + 坐垫 + 靠背 + 两侧扶手（局部坐标：长边沿 x，靠背在 −z）：

    - 底座：圆角盒，前面比坐垫收进去（按座面以下朝前的点）；
    - 坐垫：按长度分成一两个（或更多）圆角盒，中间留一条缝；
    - 靠背：侧面轮廓沿长度挤出——后背竖直，前表面按量出来的后仰角度、略微鼓出（圆弧），
      顶上前沿是相切的圆弧，后沿倒圆角；挤出两端倒圆边；
    - 扶手：侧面轮廓沿扶手宽度挤出——前表面下收上挑，前上角是相切的圆弧（卷边的扶手），后上角倒圆角，
      两侧倒圆边；
    - 离地高时补四条短腿。
    除了腿都是同一种面料（材质组 `upholstery`，取同一个颜色）。"""
    m = sofa_measure(o)
    xlo, xhi, zlo, zhi, cx = m["xlo"], m["xhi"], m["zlo"], m["zhi"], m["cx"]
    hs, base0 = m["hs"], m["base0"]
    length, depth = xhi - xlo, zhi - zlo
    arm_w = m["arm_w"]
    inner_l = length - 2 * arm_w
    children: list[dict[str, Any]] = []
    cush_h = float(np.clip(0.4 * (hs - base0), 0.08, 0.16))
    y0 = hs - cush_h  # 底座顶面
    base_h = max(0.05, y0 - base0)
    y0 = base0 + base_h
    bf = m["base_front"]
    children.append(
        part(
            sh.box(
                [inner_l if arm_w > 0 else length, base_h, bf - zlo],
                fillet=sh.r4(min(0.03, base_h / 3)),
                xf=sh.transform(position=[cx, base0, (zlo + bf) / 2]),
            ),
            "base",
            "planar",
            "color",
        )
    )

    def z_front(yy: float) -> float:
        return float(np.clip(m["back_a"] + m["back_b"] * yy, zlo + 0.1, zlo + depth * 0.6))

    bt = m["back_top"]
    zf0 = z_front(y0)
    # 坐垫：从靠背前表面（座高处，稍微塞进靠背下面）到前沿
    zs0 = z_front(hs) - 0.02
    n = int(np.clip(round(inner_l / 0.75), 1, 4))
    gap = 0.012
    cw = (inner_l - (n - 1) * gap) / n
    if zhi - zs0 > 0.2 and cw > 0.2:
        for k in range(n):
            x0 = cx - inner_l / 2 + k * (cw + gap)
            children.append(
                part(
                    sh.box(
                        [cw, cush_h, zhi - zs0],
                        fillet=sh.r4(min(0.05, cush_h / 2.5)),
                        xf=sh.transform(position=[x0 + cw / 2, y0, (zs0 + zhi) / 2]),
                    ),
                    f"seat-{k + 1}",
                    "planar",
                    "color",
                )
            )
    # 靠背：侧面轮廓 (y, z)
    if bt - y0 > 0.15:
        zt = z_front(bt)
        corner = np.array([bt, zt])
        d_face = corner - np.array([y0, zf0])
        d_face = d_face / max(np.hypot(*d_face), 1e-9)
        r = float(min(0.1, (bt - y0) / 3, (zt - zlo) / 2))
        arc = _tangent_arc(corner, d_face, np.array([0.0, -1.0]), r) if r > 0.01 else None
        if arc is not None:
            p1, p2, bulge = arc
            pts = [(y0, zlo), (y0, zf0), p1, p2, (bt, zlo)]
            arcs = [(2, bulge), (1, 0.05)]
        else:
            pts = [(y0, zlo), (y0, zf0), (bt, zt), (bt, zlo)]
            arcs = [(1, 0.05)]
        fil = [(len(pts) - 1, float(min(0.04, (zt - zlo) / 3)))]
        # 靠背垫和坐垫一样分块（两端倒圆边，块与块之间留缝）
        nb = n if cw > 0.2 else 1
        bw = (inner_l - (nb - 1) * gap) / nb
        for k in range(nb):
            x_right = cx - inner_l / 2 + k * (bw + gap) + bw
            back = _side_extrude(list(pts), list(arcs), list(fil), bw, x_right, min(0.04, bw / 6))
            children.append(part(back, "back" if nb == 1 else f"back-{k + 1}", "planar", "color"))
    # 扶手：侧面轮廓 (y, z)，前表面从底下收进去的位置斜到上沿，前上角相切圆弧
    if arm_w > 0:
        ah = m["arm_h"]
        zfa = m["arm_front"]
        zfb = m["arm_base_front"]
        corner = np.array([ah, zfa])
        d_in = corner - np.array([base0, zfb])
        d_in = d_in / max(np.hypot(*d_in), 1e-9)
        r = float(min(0.12, (ah - base0) / 2.5, (zfa - zlo) / 3))
        arc = _tangent_arc(corner, d_in, np.array([0.0, -1.0]), r)
        if arc is not None:
            p1, p2, bulge = arc
            pts = [(base0, zlo), (base0, zfb), p1, p2, (ah, zlo)]
            arcs = [(2, bulge)]
        else:
            pts = [(base0, zlo), (base0, zfb), (ah, zfa), (ah, zlo)]
            arcs = []
        fil = [(len(pts) - 1, float(min(0.05, (zfa - zlo) / 4)))]
        edge = float(min(0.04, arm_w / 3))
        for side in (-1, 1):
            x_right = xlo + arm_w if side < 0 else xhi
            arm = _side_extrude(list(pts), list(arcs), list(fil), arm_w, x_right, edge)
            name = "arm-" + ("left" if side < 0 else "right")
            children.append(part(arm, name, "planar", "color"))
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
    # 底座、坐垫、靠背、扶手是同一种面料：一个材质组，取亮的那一半的颜色（褶皱和背光处的阴影不算）
    for c in children:
        if not c["_part"]["name"].startswith("foot"):
            c["_part"]["group"] = "upholstery"
            c["_part"]["albedo"] = "bright"
    return sh.group(children)


# ---------------------------------------------------------------------------- 前台（分层挤出）


def fit_terrace(
    o: Local, *, cell: float = 0.03, max_levels: int = 4, name: str = "body", main_mode: str = "shell"
) -> dict[str, Any]:
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
    # 主体：最高一层里最大的区域（前台的高台面那一圈立面），不太小时优先于更大的矮区域（里面的工作台）
    biggest = max(regions, key=lambda t: t[1].sum())
    top_level = max(h for h, _ in regions)
    highs = [r for r in regions if r[0] == top_level]
    main = max(highs, key=lambda t: t[1].sum())
    if main[1].sum() < 0.3 * biggest[1].sum():
        main = biggest
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
            if main_mode == "shell":
                shell = _counter_shell(sub, fit.outline, top, f"{name}-{i + 1}") if len(sub.L) > 200 else None
            else:
                stack = fit_stack(sub, max_bands=4, name=f"{name}-{i + 1}") if len(sub.L) > 200 else None
                shell = stack["children"] if stack is not None else None
            if shell:
                children.extend(shell)
                continue
            shape = sh.extrude(fit.outline, top)
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


def _facade_offsets(o: Local, outline: dict[str, Any], ys: list[float]) -> list[float | None]:
    """各高度上立面相对轮廓的外扩量：只用朝外的点（水平法线与最近一段轮廓的外法线一致），
    取它们到轮廓的带符号距离（外正内负）的中位数。"""
    poly = outline_polygon(outline)
    seg_a = poly
    seg_b = np.roll(poly, -1, axis=0)
    ab = seg_b - seg_a
    ln = np.maximum(np.hypot(*ab.T), 1e-9)
    outward = np.c_[ab[:, 1], -ab[:, 0]] / ln[:, None]
    out: list[float | None] = []
    for yk in ys:
        msk = np.abs(o.y - yk) < 0.03
        if msk.sum() < 30:
            out.append(None)
            continue
        p = o.xz[msk]
        nh = o.N[msk][:, [0, 2]]
        best_d = np.full(len(p), np.inf)
        best_k = np.zeros(len(p), int)
        for k in range(len(seg_a)):
            t = np.clip(((p - seg_a[k]) @ ab[k]) / max(ab[k] @ ab[k], 1e-12), 0, 1)
            dk = np.hypot(*(p - (seg_a[k] + t[:, None] * ab[k])).T)
            better = dk < best_d
            best_d[better] = dk[better]
            best_k[better] = k
        sd = np.where(polygon_contains(poly, p), -best_d, best_d)
        facing = (nh * outward[best_k]).sum(1) > 0.5
        near = facing & (np.abs(sd) < 0.2)
        out.append(float(np.median(sd[near])) if near.sum() > 20 else None)
    return out


def _counter_shell(o: Local, outline: dict[str, Any], top: float, name: str) -> list[dict[str, Any]] | None:
    """前台主体：踢脚线（底部内收的一圈，单独一块）+ 立面（几个高度上相对台面轮廓整体外扩或内收的截面放样，
    保留折面和斜面）。轮廓点太多时返回 None。"""
    from .fit_measure import offset_outline

    poly = outline_polygon(outline)
    if len(poly) < 3 or len(poly) > 400:
        return None
    ys = [0.06, 0.2, top * 0.45, top * 0.75, top - 0.03]
    offs = _facade_offsets(o, outline, ys)
    parts: list[dict[str, Any]] = []
    base = 0.0
    body = [(y, f) for y, f in zip(ys[1:], offs[1:], strict=True) if f is not None]
    if offs[0] is not None and body and offs[0] < min(f for _, f in body) - 0.03:
        # 踢脚线：比上面的立面缩进 3 厘米以上
        base = 0.12
        kick = sh.extrude(offset_outline(outline, float(np.clip(offs[0], -0.25, 0.1))), base)
        parts.append(part(kick, f"{name}-kick", "cylindrical", "color"))
    secs = [(max(y, base), f) for y, f in body if y >= base]
    if len(secs) >= 2 and max(f for _, f in secs) - min(f for _, f in secs) >= 0.02:
        sections = []
        for i, (yk, off) in enumerate(secs):
            y = base if i == 0 else (top if i == len(secs) - 1 else yk)
            off = float(np.clip(off, -0.15, 0.15))
            ol = offset_outline(outline, off) if abs(off) > 0.003 else outline
            sections.append({"y": sh.r4(y), "outline": ol})
        if all(sections[i]["y"] < sections[i + 1]["y"] for i in range(len(sections) - 1)):
            parts.append(part({"type": "loft", "sections": sections}, f"{name}-facade", "cylindrical"))
            return parts
    body_shape = sh.extrude(outline, top - base, xf=sh.transform(position=[0, base, 0]))
    if is_convex(outline):
        body_shape["fillet"] = 0.01
    parts.append(part(body_shape, f"{name}-facade", "cylindrical"))
    return parts


# ---------------------------------------------------------------------------- 盒子、旋转体


def fit_box(
    o: Local, name: str = "body", uv: str = "cylindrical", *, complexity: float = 0.004
) -> dict[str, Any]:
    """圆角盒；俯视明显不是矩形时用轮廓挤出。`complexity` 是轮廓每个顶点的代价（越大越偏向
    圆角矩形、凸包这类简单的轮廓）。"""
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
        fit = fit_footprint(xz, tol_for(size) * 1.5, mask=m, complexity=complexity)
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


def fit_faces_box(
    o: Local, *, min_height: float = 1.2, min_share: float = 0.15, name: str = "body"
) -> dict[str, Any] | None:
    """高柜子只扫到两个相邻的面（另外两面靠墙、靠窗）、面上又是镜子或玻璃时，镜子里的虚像在柜子外面
    散成一片，俯视占用变成 L 形，按占用拟合会得到一块斜的大板。这里只用外轮廓上的面定尺寸：

    - 四个水平方向上，法线朝外的点占全部点 `min_share` 以上、位置集中（四分位距 8 厘米以内）的是"看到的面"；
    - 至少有两个相互垂直的面时，看到的面给出这一侧的位置（中位数），没看到的一侧取相邻那个面的点
      沿边的范围（2%–98% 分位）——散在外面的虚像点不参与；
    - 竖直的圆角盒，底在地面，顶是面上的点的 99% 分位。不满足条件时返回 None。"""
    if float(np.percentile(o.y, 99)) < min_height:
        return None
    n_all = len(o.L)
    faces: dict[tuple[int, int], np.ndarray] = {}
    for ax in (0, 2):
        for sg in (-1, 1):
            m = sg * o.N[:, ax] > 0.8
            if m.sum() < min_share * n_all:
                continue
            q = np.percentile(o.L[m, ax], [25, 75])
            if q[1] - q[0] > 0.08:
                continue
            faces[(ax, sg)] = m
    if not any(k[0] == 0 for k in faces) or not any(k[0] == 2 for k in faces):
        return None
    lo = [0.0, 0.0, 0.0]
    hi = [0.0, 0.0, 0.0]
    for ax, other in ((0, 2), (2, 0)):
        for sg in (-1, 1):
            if (ax, sg) in faces:
                v = float(np.median(o.L[faces[(ax, sg)], ax]))
            else:
                # 没看到的一侧：垂直方向那个看到的面沿这条轴的范围
                m = next(faces[k] for k in faces if k[0] == other)
                v = float(np.percentile(o.L[m, ax], 98 if sg > 0 else 2))
            (hi if sg > 0 else lo)[ax] = v
    w, d = hi[0] - lo[0], hi[2] - lo[2]
    if w < 0.2 or d < 0.2:
        return None
    seen = np.zeros(n_all, bool)
    for m in faces.values():
        seen |= m
    top = float(np.percentile(o.y[seen], 99))
    shape = sh.box(
        [w, top, d],
        fillet=0.01,
        xf=sh.transform(position=[(lo[0] + hi[0]) / 2, 0.0, (lo[2] + hi[2]) / 2]),
    )
    return sh.group([part(shape, name, "planar", "color")])


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
