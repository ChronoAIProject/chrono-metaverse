"""物体分割（设计 6.3 第 2 步）：去掉结构上的点，空间聚类，再把粘在一起的物体拆开。

输入是已对齐的扫描网格和同一网格上的结构结果（`structure.extract_structure`）。

1. **表面采样**：按面积均匀采样（默认每平方米 2500 点，约 2 厘米间距），记下每个点所在的三角面；
2. **去掉结构**：
   - 局部地面高度：0.25 米格子里朝上低处点的 30% 分位数，离地 2 厘米以内的点算地面；
   - 墙：离墙面 6 厘米 + 墙的最大漂移以内、或在墙后面的点；玻璃放宽到 25 厘米（窗框、窗台、竖梃跟着玻璃走）；
   - 天花板：朝下点的高度众数，往下 12 厘米以上的点；
   - 地面范围（向外 0.3 米）以外的点；
3. **聚类**：3 厘米体素、6 邻接的连通块；
4. **拆分**（每一簇依次做）：
   - **桌面**：0.3–1.3 米高、朝上、面积够大的水平面，而且下面能看到桌面底面（朝下的点）——
     这是"悬空的台面"（桌子、书桌），沙发座面、柜顶下面看不到底面，不会被当成桌面。
     去掉台面薄层后重新聚类：落在台面投影里、在台面以下的块是桌腿或底座，台面以上的是桌上的杂物，
     伸出台面投影的块是别的物体（椅子）。
   - **高矮分开**：1.5 米以上的格子连成的块（柜子、绿植、立柱）取凸包，凸包里的点归它，其余归矮的物体；
   - **颈部**：俯视占用图上做距离变换分水岭，两块之间的"颈"窄于较小那块核心直径的 75% 时拆开
     （沙发和挨着的边几）；
   - **提示**：任务参数里给了物体中心时，一簇里有几个中心就按测地距离拆成几块。
5. **清理**：太小、太矮（最高不到 12 厘米）、太稀的簇丢掉（地面反光、扫描边缘的碎片）。
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy import ndimage
from scipy.spatial import ConvexHull, cKDTree

from .scan import ScanMesh, sample_surface

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class SegmentParams:
    density: float = 2500.0  # 表面采样密度（点/平方米）
    floor_clear: float = 0.02  # 离地这么高以内算地面
    wall_tol: float = 0.06  # 离墙这么近算墙
    glazing_tol: float = 0.25  # 离玻璃这么近算窗框、窗台
    ceiling_gap: float = 0.12  # 天花板往下这么多以上的点去掉
    footprint_margin: int = 3  # 地面范围向外扩的格数（0.1 米格子）
    voxel: float = 0.03  # 聚类体素
    min_area: float = 0.04  # 一簇至少这么多表面积（平方米）
    min_height: float = 0.12  # 一簇最高点至少离地这么高
    top_min_area: float = 0.12  # 桌面至少这么大
    top_underside: float = 0.2  # 桌面投影里能看到底面的比例下限
    tall: float = 1.5  # "高"的格子
    neck_ratio: float = 0.75  # 颈宽 / 较小块核心直径 低于这个就拆
    seed: int = 7


@dataclass
class Segment:
    """一个物体的扫描点（下标指向 `ObjectPoints` 的数组）。"""

    idx: np.ndarray
    tags: set[str] = field(default_factory=set)  # table-top、on-top、support、tall、hint 等
    top: dict[str, Any] | None = None  # 桌面：{height, thickness, mask 信息}
    hint: dict[str, Any] | None = None


@dataclass
class ObjectPoints:
    """去掉结构以后的扫描点（世界坐标）和地面高度场。"""

    P: np.ndarray
    C: np.ndarray
    N: np.ndarray
    F: np.ndarray  # 所在三角面
    h: np.ndarray  # 离局部地面的高度
    floor: FloorField
    ceiling_y: float | None
    stats: dict[str, Any]


class FloorField:
    """局部地面高度：0.25 米格子，每格朝上低处点的 30% 分位数，空格用最近的有效格填，双线性插值。"""

    def __init__(self, P: np.ndarray, N: np.ndarray, cell: float = 0.25, base: float = 0.0) -> None:
        self.cell = cell
        up = (N[:, 1] > 0.9) & (P[:, 1] < base + 0.3) & (P[:, 1] > base - 0.3)
        self.x0 = float(P[:, 0].min()) - cell
        self.z0 = float(P[:, 2].min()) - cell
        self.gx = int((P[:, 0].max() - self.x0) / cell) + 3
        self.gz = int((P[:, 2].max() - self.z0) / cell) + 3
        grid = np.full((self.gz, self.gx), np.nan)
        if up.sum() > 0:
            ix = ((P[up, 0] - self.x0) / cell).astype(int)
            iz = ((P[up, 2] - self.z0) / cell).astype(int)
            lin = iz * self.gx + ix
            order = np.lexsort((P[up, 1], lin))
            ls, ys = lin[order], P[up, 1][order]
            starts = np.r_[0, np.nonzero(np.diff(ls))[0] + 1]
            ends = np.r_[starts[1:], len(ls)]
            for s, e in zip(starts, ends, strict=True):
                if e - s >= 8:
                    grid.flat[ls[s]] = ys[s + int(0.3 * (e - s))]
        valid = ~np.isnan(grid)
        if not valid.any():
            grid[:] = base
            valid[:] = True
        _, (ni, nj) = ndimage.distance_transform_edt(~valid, return_indices=True)
        self.grid = grid[ni, nj]

    def height(self, x, z) -> np.ndarray:
        x = np.asarray(x, float)
        z = np.asarray(z, float)
        i = (z - self.z0) / self.cell - 0.5
        j = (x - self.x0) / self.cell - 0.5
        return ndimage.map_coordinates(
            self.grid, [np.atleast_1d(i), np.atleast_1d(j)], order=1, mode="nearest"
        )


# ---------------------------------------------------------------------------- 去掉结构


def _ceiling(P: np.ndarray, N: np.ndarray) -> float | None:
    dn = (N[:, 1] < -0.9) & (P[:, 1] > 1.8)
    if dn.sum() < 200:
        return None
    hist, edges = np.histogram(P[dn, 1], bins=np.arange(1.8, P[:, 1].max() + 0.04, 0.03))
    if hist.max() < 100:
        return None
    k = int(np.argmax(hist))
    return float((edges[k] + edges[k + 1]) / 2)


def object_points(mesh: ScanMesh, structure, prm: SegmentParams) -> ObjectPoints:
    P, C, N, F = sample_surface(mesh, prm.density, seed=prm.seed)
    floor = FloorField(P, N, base=float(structure.floor_y))
    h = P[:, 1] - floor.height(P[:, 0], P[:, 2])
    keep = h > prm.floor_clear
    stats: dict[str, Any] = {"samples": len(P), "floor": int((~keep).sum())}
    removed_wall = 0
    for e in structure.elements:
        if e.kind == "floor":
            continue
        info = e.info
        n2, t2 = np.asarray(info["normal"], float), np.asarray(info["tangent"], float)
        d = P[:, [0, 2]] @ n2 - info["offset"]
        u = P[:, [0, 2]] @ t2
        u0, u1 = info["u"]
        y0, y1 = info["y"]
        inside = (u > u0 - 0.3) & (u < u1 + 0.3) & (P[:, 1] > y0 - 0.2) & (P[:, 1] < y1 + 0.3)
        tol = (prm.glazing_tol if e.kind == "glazing" else prm.wall_tol) + float(info.get("max_drift", 0.0))
        rm = keep & inside & (d < tol)
        removed_wall += int(rm.sum())
        keep &= ~rm
    stats["wall"] = removed_wall
    ceiling = _ceiling(P, N)
    if ceiling is not None:
        rm = keep & (P[:, 1] > ceiling - prm.ceiling_gap)
        stats["ceiling"] = int(rm.sum())
        keep &= ~rm
    fp = structure.footprint
    cell = structure.footprint_cell
    if fp is not None and fp.any():
        fpd = ndimage.binary_dilation(fp, iterations=prm.footprint_margin)
        iz = np.floor(P[:, 2] / cell).astype(int)
        ix = np.floor(P[:, 0] / cell).astype(int)
        ok = (iz >= 0) & (iz < fp.shape[0]) & (ix >= 0) & (ix < fp.shape[1])
        inside = np.zeros(len(P), bool)
        inside[ok] = fpd[iz[ok], ix[ok]]
        stats["outside"] = int((keep & ~inside).sum())
        keep &= inside
    stats["objects"] = int(keep.sum())
    return ObjectPoints(P[keep], C[keep], N[keep], F[keep], h[keep], floor, ceiling, stats)


# ---------------------------------------------------------------------------- 聚类


def voxel_components(P: np.ndarray, voxel: float, conn: int = 1) -> np.ndarray:
    """体素连通块标签（从 0 开始，-1 不会出现）。"""
    if len(P) == 0:
        return np.zeros(0, np.int64)
    q = np.floor(P / voxel).astype(np.int64)
    q -= q.min(0)
    shape = q.max(0) + 1
    grid = np.zeros(shape, bool)
    grid[q[:, 0], q[:, 1], q[:, 2]] = True
    lab, _ = ndimage.label(grid, ndimage.generate_binary_structure(3, conn))
    return lab[q[:, 0], q[:, 1], q[:, 2]] - 1


def _groups(labels: np.ndarray) -> list[np.ndarray]:
    if len(labels) == 0:
        return []
    order = np.argsort(labels, kind="stable")
    ls = labels[order]
    starts = np.r_[0, np.nonzero(np.diff(ls))[0] + 1]
    ends = np.r_[starts[1:], len(ls)]
    return [order[s:e] for s, e in zip(starts, ends, strict=True)]


class Grid2D:
    """俯视格子（xz 平面）。"""

    def __init__(self, xz: np.ndarray, cell: float, pad: int = 3) -> None:
        self.cell = cell
        self.x0 = float(xz[:, 0].min()) - pad * cell
        self.z0 = float(xz[:, 1].min()) - pad * cell
        self.nx = int((xz[:, 0].max() - self.x0) / cell) + pad + 1
        self.nz = int((xz[:, 1].max() - self.z0) / cell) + pad + 1

    def index(self, xz: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        ix = np.clip(((xz[:, 0] - self.x0) / self.cell).astype(int), 0, self.nx - 1)
        iz = np.clip(((xz[:, 1] - self.z0) / self.cell).astype(int), 0, self.nz - 1)
        return iz, ix

    def mask(self, xz: np.ndarray) -> np.ndarray:
        m = np.zeros((self.nz, self.nx), bool)
        if len(xz):
            iz, ix = self.index(xz)
            m[iz, ix] = True
        return m

    def lookup(self, mask: np.ndarray, xz: np.ndarray) -> np.ndarray:
        iz, ix = self.index(xz)
        return mask[iz, ix]


# ---------------------------------------------------------------------------- 桌面


def find_tops(
    op: ObjectPoints, idx: np.ndarray, prm: SegmentParams, exclude: tuple[float, ...] = ()
) -> list[dict[str, Any]]:
    """一簇里"悬空"的水平台面：返回 [{height, thickness, grid, mask}]，按面积从大到小。

    `exclude`：上一级已经拆过的台面高度，同一张桌子起伏不平的台面不再重复拆。"""
    P, N, hf = op.P[idx], op.N[idx], op.h[idx]
    up = (N[:, 1] > 0.85) & (hf > 0.3) & (hf < 1.3)
    # 台面是刚性的平面，扫描的地面却有几厘米的起伏：台面按世界高度 y 找，阈值再换回离地高度
    h = P[:, 1]
    base = float(np.median(P[up, 1] - hf[up])) if up.any() else 0.0
    per_m2 = prm.density
    if up.sum() < prm.top_min_area * per_m2 * 0.5:
        return []
    hist, edges = np.histogram(h[up], bins=np.arange(base + 0.3, base + 1.31, 0.01))
    sm = np.convolve(hist, [1, 2, 3, 2, 1], "same") / 9
    peaks = [
        k
        for k in range(1, len(sm) - 1)
        if sm[k] >= sm[k - 1]
        and sm[k] >= sm[k + 1]
        and hist[max(0, k - 2) : k + 3].sum() >= prm.top_min_area * per_m2 * 0.4
    ]
    tops: list[dict[str, Any]] = []
    grid = Grid2D(P[:, [0, 2]], 0.02)
    used = np.zeros((grid.nz, grid.nx), bool)
    for k in sorted(peaks, key=lambda k: -sm[k]):
        t = float((edges[k] + edges[k + 1]) / 2)
        band = up & (np.abs(h - t) < 0.025)
        if band.sum() < 20:
            continue
        t = float(np.median(h[band]))
        m = grid.mask(P[band][:, [0, 2]])
        m = ndimage.binary_closing(m, iterations=2)
        m = ndimage.binary_fill_holes(m)
        m = ndimage.binary_opening(m, iterations=1)
        lab, nl = ndimage.label(m)
        for r in range(1, nl + 1):
            region = lab == r
            area = region.sum() * grid.cell**2
            if area < prm.top_min_area or (region & used).sum() > 0.3 * region.sum():
                continue
            if any(abs(t - e) < 0.12 for e in exclude):
                continue
            # 台面要"宽"：内切圆直径至少 0.3 米（沙发靠背顶、窗台这种窄条不算）
            if 2 * ndimage.distance_transform_edt(np.pad(region, 1)).max() * grid.cell < 0.3:
                continue
            dn = (N[:, 1] < -0.7) & (h < t - 0.005) & (h > t - 0.16)
            inreg = grid.lookup(ndimage.binary_dilation(region, iterations=1), P[:, [0, 2]])
            dn &= inreg
            dmask = ndimage.binary_dilation(grid.mask(P[dn][:, [0, 2]]), iterations=2) & region
            frac = dmask.sum() / max(1, region.sum())
            # 台面上压着的东西（显示器、杂物）占台面投影的比例
            above = grid.lookup(region, P[:, [0, 2]]) & (h > t + 0.05)
            above_frac = (
                ndimage.binary_dilation(grid.mask(P[above][:, [0, 2]]), iterations=1) & region
            ).sum() / max(1, region.sum())
            # 台面四周 12 厘米内比台面高出 8 厘米以上的东西（沙发的扶手、靠背）
            ring = ndimage.binary_dilation(region, iterations=6) & ~region
            higher = grid.lookup(ring, P[:, [0, 2]]) & (h > t + 0.08)
            ring_frac = (grid.mask(P[higher][:, [0, 2]]) & ring).sum() / max(1, ring.sum())
            if t - base >= 0.6:
                ok = frac >= prm.top_underside or (area >= 0.2 and above_frac < 0.35)
            else:
                ok = frac >= prm.top_underside and ring_frac < 0.15
            if not ok:
                continue
            thickness = float(np.clip(t - np.median(h[dn]), 0.012, 0.08)) if dn.sum() else 0.04
            upr = up & grid.lookup(region, P[:, [0, 2]]) & (np.abs(h - t) < 0.1)
            lo_up, hi_up = np.percentile(h[upr], [3, 97]) if upr.sum() > 20 else (t, t)
            used |= region
            tops.append(
                {
                    "height": t,
                    "thickness": thickness,
                    "grid": grid,
                    "mask": region,
                    "area": float(area),
                    "underside": float(frac),
                    "above": float(above_frac),
                    "band": (float(lo_up), float(hi_up)),
                    "base": base,
                }
            )
    tops.sort(key=lambda x: -x["area"])
    return tops


def split_table(op: ObjectPoints, idx: np.ndarray, top: dict[str, Any], prm: SegmentParams) -> list[Segment]:
    """去掉台面薄层后重新聚类：台面（含底座、桌上杂物）一块，伸出去的块各自一块。"""
    P = op.P[idx]
    h = P[:, 1]  # 世界高度，与 find_tops 一致
    grid, region = top["grid"], top["mask"]
    t, th = top["height"], top["thickness"]
    reg_d = ndimage.binary_dilation(region, iterations=2)
    inside = grid.lookup(reg_d, P[:, [0, 2]])
    lo_up, hi_up = top.get("band", (t, t))
    band_lo = min(t - th - 0.03, lo_up - th - 0.02)
    band_hi = max(t + 0.04, hi_up + 0.03)
    slab = inside & (h > band_lo) & (h < band_hi)
    rest = np.nonzero(~slab)[0]
    lab = voxel_components(P[rest], prm.voxel * 0.85)
    table = [idx[slab]]
    clutter: list[np.ndarray] = []
    others: list[Segment] = []
    reg_in = ndimage.binary_dilation(region, iterations=1)
    for g in _groups(lab):
        gi = rest[g]
        frac_in = grid.lookup(reg_in, P[gi][:, [0, 2]]).mean()
        hmin, hmax = np.percentile(h[gi], 2), np.percentile(h[gi], 98)
        in_band = (h[gi] > band_lo - 0.03) & (h[gi] < band_hi + 0.03)
        if frac_in > 0.85 and hmax <= t + 0.01:
            table.append(idx[gi])  # 桌腿、底座
        elif frac_in > 0.6 and in_band.mean() > 0.6:
            table.append(idx[gi])  # 台面上高低不平、没进薄层的碎块
        elif frac_in > 0.85 and hmin >= t - 0.02:
            clutter.append(idx[gi])  # 桌上的东西
        else:
            others.append(Segment(idx[gi], {f"below-top:{t:.3f}"}))
    info = {k: top[k] for k in ("height", "thickness", "area", "base")}
    info.update(grid=grid, mask=reg_d, band=(band_lo, band_hi))
    seg = Segment(np.concatenate(table), {"table-top"}, top=info)
    out = [seg]
    for c in clutter:
        out.append(Segment(c, {"on-top"}))
    out.extend(others)
    return out


# ---------------------------------------------------------------------------- 高矮、颈部


def split_tall(op: ObjectPoints, idx: np.ndarray, prm: SegmentParams) -> list[Segment] | None:
    P, h = op.P[idx], op.h[idx]
    if h.max() < prm.tall:
        return None
    grid = Grid2D(P[:, [0, 2]], 0.03)
    iz, ix = grid.index(P[:, [0, 2]])
    hmax = np.zeros((grid.nz, grid.nx))
    np.maximum.at(hmax, (iz, ix), h)
    occ = hmax > 0
    tall = ndimage.binary_closing(hmax > prm.tall, iterations=2) & occ
    low = occ & (hmax < prm.tall - 0.3)
    if low.sum() * grid.cell**2 < 0.15 or tall.sum() * grid.cell**2 < 0.02:
        return None
    lab, nl = ndimage.label(tall, np.ones((3, 3)))
    owner = np.zeros((grid.nz, grid.nx), np.int64)
    for r in range(1, nl + 1):
        zz, xx = np.nonzero(lab == r)
        if len(zz) * grid.cell**2 < 0.02:
            continue
        pts = np.c_[xx, zz].astype(float)
        hull_mask = np.zeros_like(occ)
        if len(pts) >= 3 and np.ptp(pts[:, 0]) > 0 and np.ptp(pts[:, 1]) > 0:
            try:
                hull = ConvexHull(pts)
            except Exception:
                hull = None
            if hull is not None:
                gz, gx = np.mgrid[0 : grid.nz, 0 : grid.nx]
                q = np.c_[gx.ravel(), gz.ravel()]
                eq = hull.equations
                ins = np.all(q @ eq[:, :2].T + eq[:, 2] <= 0.5, axis=1)
                hull_mask = ins.reshape(grid.nz, grid.nx)
        hull_mask |= lab == r
        hull_mask = ndimage.binary_dilation(hull_mask, iterations=1)
        owner[hull_mask & (owner == 0)] = r
    own = owner[iz, ix]
    if not (own > 0).any() or (own == 0).sum() < 50:
        return None
    out = [Segment(idx[own == r], {"tall"}) for r in np.unique(own[own > 0])]
    out.append(Segment(idx[own == 0]))
    return out


def _disk(radius_cells: int) -> np.ndarray:
    r = radius_cells
    yy, xx = np.mgrid[-r : r + 1, -r : r + 1]
    return xx * xx + yy * yy <= r * r


def split_necks(op: ObjectPoints, idx: np.ndarray, prm: SegmentParams) -> list[np.ndarray]:
    """俯视占用图上用开运算找"核心"（宽于 24 厘米的部分），每个格子归最近的核心；
    相邻两块的分界线短于较窄核心宽度的 neck_ratio 倍时才拆开（颈部），否则合并。返回各块的下标。"""
    P = op.P[idx]
    cell = 0.02
    grid = Grid2D(P[:, [0, 2]], cell, pad=8)
    occ = grid.mask(P[:, [0, 2]])
    occ = ndimage.binary_closing(occ, iterations=2)
    occ = ndimage.binary_fill_holes(occ)
    if occ.sum() * cell * cell < 0.2:
        return [idx]
    core = ndimage.binary_opening(occ, structure=_disk(6))
    lab, nl = ndimage.label(core)
    if nl < 2:
        return [idx]
    sizes = ndimage.sum(core, lab, range(1, nl + 1)) * cell * cell
    keep_ids = [i + 1 for i, a in enumerate(sizes) if a >= 0.06]
    if len(keep_ids) < 2:
        return [idx]
    cores = np.zeros_like(lab)
    for new_id, old in enumerate(keep_ids, start=1):
        cores[lab == old] = new_id
    dt = ndimage.distance_transform_edt(occ) * cell
    width = {k: 2 * float(dt[cores == k].max()) for k in range(1, len(keep_ids) + 1)}
    _, (ni, nj) = ndimage.distance_transform_edt(cores == 0, return_indices=True)
    region = cores[ni, nj]
    region[~occ] = 0
    # 分界线长度
    border: dict[tuple[int, int], float] = {}
    for dz, dx in ((0, 1), (1, 0)):
        a = region[: region.shape[0] - dz, : region.shape[1] - dx]
        b = region[dz:, dx:]
        m = (a != b) & (a > 0) & (b > 0)
        for ra, rb in zip(a[m], b[m], strict=True):
            key = (min(ra, rb), max(ra, rb))
            border[key] = border.get(key, 0.0) + cell
    parent = list(range(len(keep_ids) + 1))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for (ra, rb), length in sorted(border.items(), key=lambda kv: -kv[1]):
        fa, fb = find(ra), find(rb)
        if fa == fb:
            continue
        wa = max(width[k] for k in width if find(k) == fa)
        wb = max(width[k] for k in width if find(k) == fb)
        if length >= prm.neck_ratio * min(wa, wb):
            parent[fb] = fa
    roots = np.array([find(r) for r in range(len(keep_ids) + 1)])
    region = roots[region]
    region[~occ] = 0
    ids = np.unique(region[region > 0])
    if len(ids) < 2:
        return [idx]
    _, (ni, nj) = ndimage.distance_transform_edt(region == 0, return_indices=True)
    filled = region[ni, nj]
    iz, ix = grid.index(P[:, [0, 2]])
    lab_pts = filled[iz, ix]
    return [idx[lab_pts == r] for r in ids if (lab_pts == r).sum() > 0]


def h_maxima(f: np.ndarray, depth: float) -> np.ndarray:
    """动态至少为 depth 的区域极大值（形态学重建：f − depth 在 f 下面做膨胀重建）。"""
    marker = f - depth
    for _ in range(2000):
        nxt = np.minimum(ndimage.grey_dilation(marker, size=(3, 3)), f)
        if np.array_equal(nxt, marker):
            break
        marker = nxt
    return (f - marker) >= depth - 1e-6


def split_peaks(
    op: ObjectPoints, idx: np.ndarray, prm: SegmentParams, depth: float = 0.08
) -> list[np.ndarray]:
    """俯视最高点高度图上做分水岭：每个"山头"（比周围高出 depth 以上）是一个物体，
    用于拆开挨在一起的一排椅子（靠背是山头，中间低下去）。沙发靠背是连续的山脊，不会被拆开。"""
    P, h = op.P[idx], op.h[idx]
    cell = 0.03
    grid = Grid2D(P[:, [0, 2]], cell, pad=2)
    iz, ix = grid.index(P[:, [0, 2]])
    f = np.zeros((grid.nz, grid.nx))
    np.maximum.at(f, (iz, ix), h)
    occ = f > 0
    if occ.sum() * cell * cell < 0.35:
        return [idx]
    f = ndimage.median_filter(f, size=3) * occ
    peaks = h_maxima(f, depth) & occ & (f > 0.3)
    markers, nm = ndimage.label(peaks, np.ones((3, 3)))
    if nm < 2:
        return [idx]
    inv = np.clip((f.max() - f) * 1000, 0, 65000).astype(np.uint16)
    ws = ndimage.watershed_ift(inv, markers.astype(np.int32))
    ws[~occ] = 0
    areas = {r: (ws == r).sum() * cell * cell for r in range(1, nm + 1)}
    # 太小的块并到分界最长的邻块
    border: dict[tuple[int, int], int] = {}
    for dz, dx in ((0, 1), (1, 0)):
        a = ws[: ws.shape[0] - dz, : ws.shape[1] - dx]
        b = ws[dz:, dx:]
        m = (a != b) & (a > 0) & (b > 0)
        for ra, rb in zip(a[m], b[m], strict=True):
            border[(ra, rb)] = border.get((ra, rb), 0) + 1
            border[(rb, ra)] = border.get((rb, ra), 0) + 1
    remap = {r: r for r in range(1, nm + 1)}
    for r in sorted(areas, key=lambda r: areas[r]):
        if areas[r] >= 0.05:
            continue
        nbs = [(n, c) for (a, n), c in border.items() if a == r and remap[n] != r]
        if nbs:
            target = max(nbs, key=lambda x: x[1])[0]
            for k, v in remap.items():
                if v == r:
                    remap[k] = remap[target]
    lut = np.zeros(nm + 1, np.int64)
    for k, v in remap.items():
        lut[k] = v
    ws = lut[ws]
    ids = np.unique(ws[ws > 0])
    if len(ids) < 2:
        return [idx]
    _, (ni, nj) = ndimage.distance_transform_edt(ws == 0, return_indices=True)
    lab = ws[ni, nj][iz, ix]
    return [idx[lab == r] for r in ids if (lab == r).sum() > 0]


def split_by_seeds(
    op: ObjectPoints, idx: np.ndarray, seeds: list[np.ndarray], voxel: float
) -> list[np.ndarray]:
    """按测地距离（体素图上的广度优先）把一簇分给最近的种子（提示里的物体中心）。"""
    P = op.P[idx]
    q = np.floor(P / voxel).astype(np.int64)
    q -= q.min(0)
    shape = q.max(0) + 1
    occ = np.zeros(shape, bool)
    occ[q[:, 0], q[:, 1], q[:, 2]] = True
    owner = np.zeros(shape, np.int64)
    frontier = []
    tree = cKDTree(P)
    for k, s in enumerate(seeds, start=1):
        _, j = tree.query(np.asarray(s, float), k=1)
        v = tuple(q[j])
        owner[v] = k
        frontier.append(v)
    st = ndimage.generate_binary_structure(3, 1)
    while True:
        grown = owner.copy()
        for k in range(1, len(seeds) + 1):
            d = ndimage.binary_dilation(owner == k, st) & occ & (grown == 0)
            grown[d] = k
        if np.array_equal(grown, owner):
            break
        owner = grown
    lab = owner[q[:, 0], q[:, 1], q[:, 2]]
    if (lab == 0).any():
        # 不连通的点归最近的种子
        ctr = np.asarray(seeds, float)
        lab[lab == 0] = np.argmin(((P[lab == 0][:, None, :] - ctr[None]) ** 2).sum(-1), axis=1) + 1
    return [idx[lab == k] for k in range(1, len(seeds) + 1) if (lab == k).any()]


# ---------------------------------------------------------------------------- 主流程


def _hint_center_xz(hint: dict[str, Any]) -> np.ndarray | None:
    c = hint.get("center")
    if not isinstance(c, list | tuple) or len(c) not in (2, 3):
        return None
    try:
        vals = [float(v) for v in c]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in vals):
        return None
    return np.array([vals[0], vals[-1]])


def _hint_box(hint: dict[str, Any]) -> tuple[np.ndarray, np.ndarray, float] | None:
    """提示的范围框：(中心 xyz, 半尺寸 xyz, 偏航角度)。没有 size 时返回 None。"""
    size = hint.get("size")
    c = hint.get("center")
    if not (
        isinstance(size, list | tuple) and len(size) == 3 and isinstance(c, list | tuple) and len(c) == 3
    ):
        return None
    try:
        sz = np.array([float(v) for v in size])
        ctr = np.array([float(v) for v in c])
        yaw = float(hint.get("yaw", 0.0) or 0.0)
    except (TypeError, ValueError):
        return None
    if not (np.all(np.isfinite(sz)) and np.all(sz > 0) and np.all(np.isfinite(ctr)) and math.isfinite(yaw)):
        return None
    return ctr, sz / 2, yaw


def apply_hints(
    op: ObjectPoints, segs: list[Segment], hints: list[dict[str, Any]], prm: SegmentParams
) -> list[Segment]:
    """提示改写分割：

    - 带 `size` 的提示直接认领框里的点（框按 `yaw` 旋转，向外放 3 厘米；
      几个框重叠时归按尺寸归一化后最近的中心）；
      桌面薄层（台面）上的点不被别的框认领；
    - 只有 `center` 的提示认领中心所在的那一块；一块里有几个中心就按测地距离拆开。
    """
    owner = np.full(len(op.P), -1)
    best = np.full(len(op.P), np.inf)
    seg_of = np.full(len(op.P), -1)
    for k, seg in enumerate(segs):
        seg_of[seg.idx] = k
    # 台面薄层（台面投影内、台面高度带里的点，不管在哪一块）不被别的提示框认领
    slab = np.zeros(len(op.P), bool)
    for seg in segs:
        if seg.top is not None and "mask" in seg.top:
            lo, hi = seg.top["band"]
            y = op.P[:, 1]
            cand = (y > lo) & (y < hi)
            slab[cand] |= seg.top["grid"].lookup(seg.top["mask"], op.P[cand][:, [0, 2]])
    boxed = []
    for k, hint in enumerate(hints):
        box = _hint_box(hint)
        if box is None:
            continue
        ctr, half, yaw = box
        a = math.radians(yaw)
        d = op.P - ctr
        # 世界 → 框的局部：x' = x·cos − z·sin，z' = x·sin + z·cos（偏航的逆）
        lx = d[:, 0] * math.cos(a) - d[:, 2] * math.sin(a)
        lz = d[:, 0] * math.sin(a) + d[:, 2] * math.cos(a)
        ly = d[:, 1]
        pad = 0.03
        inside = (np.abs(lx) <= half[0] + pad) & (np.abs(lz) <= half[2] + pad) & (np.abs(ly) <= half[1] + pad)
        is_table = str(hint.get("kind", "")) == "table"
        if not is_table:
            inside &= ~slab
        score = np.sqrt((lx / half[0]) ** 2 + (lz / half[2]) ** 2)
        take = inside & (score < best)
        owner[take] = k
        best[take] = score[take]
        boxed.append(k)
    out: list[Segment] = []
    for k in boxed:
        idx = np.nonzero(owner == k)[0]
        if len(idx):
            out.append(Segment(idx, {"hint"}, None, hints[k]))
            if str(hints[k].get("kind", "")) == "table":
                tops = [segs[j].top for j in np.unique(seg_of[idx]) if j >= 0 and segs[j].top is not None]
                if tops:
                    out[-1].top = max(tops, key=lambda t: t["area"])
    rest_hints = [(h, _hint_center_xz(h)) for k, h in enumerate(hints) if k not in boxed]
    rest_hints = [(h, c) for h, c in rest_hints if c is not None]
    remaining = [seg.idx[owner[seg.idx] < 0] for seg in segs]
    # 只有中心的提示归一块：中心 0.25 米内点最多的那块（桌子优先归有台面的块）
    claim: dict[int, list[tuple[dict[str, Any], np.ndarray]]] = {}
    for h, c in rest_hints:
        best_k, best_n = -1, 0
        for k, idx in enumerate(remaining):
            if len(idx) < prm.min_area * prm.density:
                continue
            n = int((np.hypot(op.P[idx, 0] - c[0], op.P[idx, 2] - c[1]) < 0.25).sum())
            if h.get("kind") == "table" and segs[k].top is not None:
                n *= 4
            if n > best_n:
                best_k, best_n = k, n
        if best_k >= 0:
            claim.setdefault(best_k, []).append((h, c))
    for k, seg in enumerate(segs):
        idx = remaining[k]
        if len(idx) < prm.min_area * prm.density:
            continue
        mine = claim.get(k, [])
        if len(mine) >= 2 and "table-top" not in seg.tags:
            seeds = []
            for h, c in mine:
                y = float(h["center"][1]) if len(h["center"]) == 3 else float(np.median(op.P[idx, 1]))
                seeds.append(np.array([c[0], y, c[1]]))
            for j, sub in enumerate(split_by_seeds(op, idx, seeds, prm.voxel)):
                out.append(Segment(sub, set(seg.tags) | {"hint"}, seg.top, mine[j][0]))
        else:
            tags = set(seg.tags) | ({"hint"} if mine else set())
            out.append(Segment(idx, tags, seg.top, mine[0][0] if mine else None))
    return out


def _tidy(op: ObjectPoints, seg: Segment, prm: SegmentParams) -> list[Segment]:
    if len(seg.idx) < 50:
        return [seg]
    lab = voxel_components(op.P[seg.idx], 0.05, conn=3)
    groups = sorted(_groups(lab), key=len, reverse=True)
    if len(groups) == 1:
        return [seg]
    main = [groups[0]]
    tree = cKDTree(op.P[seg.idx[groups[0]]])
    out: list[Segment] = []
    min_pts = prm.min_area * prm.density
    for g in groups[1:]:
        d, _ = tree.query(op.P[seg.idx[g]], k=1)
        if d.min() < 0.15:
            main.append(g)
        elif len(g) >= min_pts and seg.hint is None:
            out.append(Segment(seg.idx[g], {t for t in seg.tags if t != "table-top"}))
    keep = np.concatenate(main)
    return [Segment(seg.idx[keep], seg.tags, seg.top, seg.hint), *out]


def segment_objects(
    mesh: ScanMesh, structure, prm: SegmentParams | None = None, hints: list[dict[str, Any]] | None = None
) -> tuple[ObjectPoints, list[Segment]]:
    prm = prm or SegmentParams()
    op = object_points(mesh, structure, prm)
    if len(op.P) == 0:
        return op, []
    labels = voxel_components(op.P, prm.voxel)
    pending = [Segment(g) for g in _groups(labels)]
    min_pts = prm.min_area * prm.density
    pending = [s for s in pending if len(s.idx) >= min_pts * 0.5]
    done: list[Segment] = []
    # 1. 桌面拆分（可以嵌套：拆出来的块再找台面）
    queue = list(pending)
    while queue:
        seg = queue.pop()
        if "table-top" in seg.tags or "on-top" in seg.tags or len(seg.idx) < min_pts:
            done.append(seg)
            continue
        exclude = tuple(float(tag.split(":")[1]) for tag in seg.tags if tag.startswith("below-top:"))
        tops = find_tops(op, seg.idx, prm, exclude)
        if not tops:
            done.append(seg)
            continue
        parts = split_table(op, seg.idx, tops[0], prm)
        done.append(parts[0])
        for p in parts[1:]:
            p.tags |= {tag for tag in seg.tags if tag.startswith("below-top:")}
            queue.append(p)
    # 2. 高矮分开 3. 颈部
    result: list[Segment] = []
    for seg in done:
        if "table-top" in seg.tags or "on-top" in seg.tags:
            result.append(seg)
            continue
        tall = split_tall(op, seg.idx, prm)
        parts = tall if tall is not None else [seg]
        for p in parts:
            if "tall" in p.tags:
                result.append(p)
                continue
            for sub in split_necks(op, p.idx, prm):
                if np.percentile(op.h[sub], 98) < 1.3:
                    for sub2 in split_peaks(op, sub, prm):
                        result.append(Segment(sub2, set(p.tags)))
                else:
                    result.append(Segment(sub, set(p.tags)))
    # 4. 提示（本地 AI 看图给出的物体中心、可选的尺寸）
    if hints:
        result = apply_hints(op, result, hints, prm)
    # 5. 清理：每块再按 5 厘米体素分连通块，离主体 15 厘米以内的并回，远处的大块另起一块，小碎块丢掉
    tidy: list[Segment] = []
    for seg in result:
        tidy.extend(_tidy(op, seg, prm))
    final = []
    for seg in tidy:
        h = op.h[seg.idx]
        if len(seg.idx) < min_pts or np.percentile(h, 99) < prm.min_height:
            continue
        final.append(seg)
    return op, final
