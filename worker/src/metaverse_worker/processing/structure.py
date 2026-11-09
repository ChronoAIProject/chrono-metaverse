"""结构重建：地面、墙（含斜墙）、玻璃、墙角吸附、贴图烘焙（设计 6.3 第 1 步）。

验证代码见 `spikes/parametric/structure.py`，这里把它整理成纯函数，并把按前厅调好的常量换成与采样密度
无关的面积阈值（平方米），所以小房间、大房间都能用：

1. **地面**：朝上的点在低处的高度众数；按 0.5 米格子求局部高度场（跟随扫描 ±5 厘米的翘曲）；
   10 厘米占用图取最大连通块并填洞，得到地面范围。
2. **墙**：近似水平法线的点按方向做直方图：4 个轴向 + 足够强的斜向。每个方向上按平面偏移做直方图找峰，
   每 0.5 米一段求局部偏移（处理扫描漂移，剔除墙前家具造成的跳变），±4 厘米内的点为内点；
   在 10 厘米 (沿墙, 高度) 占用图上切段：1.0–2.4 米覆盖率高、到达 2 米以上、并且某处接近地面的列才算墙。
3. **玻璃**：玻璃扫描得稀疏、深度分散，不会形成尖峰。在轴向上找宽峰（排除已认定的实墙附近），
   要求长度 ≥ 3 米、1 米以上有覆盖、位于地面范围的外缘（前面有地、后面没有）。
4. **墙角吸附**：两段不平行的墙，端点都在交点附近时把端点移到交点。
5. **地面补全**：把墙线画进占用图当作边界，填满被地面和墙围住的区域（桌下、沙发下），
   但不超出已扫到地面 1.2 米。
6. **贴图**：每个元素按 1 厘米/像素正交投影烘焙（地面剔除与周围地面颜色差异大的采样，去掉印在地上的椅子）。
   墙面没扫到的纹素：离已扫到区域 5 厘米内推拉补洞，30 厘米外用同一面墙沿墙每 0.5 米的中位色
   （`bake.fill_unobserved`），不再从远处不相关的点（墙前的椅子、门框）取色。

输出 `StructureResult`，再由 `structure_entities` 写成 SHAPES 物件记录（`kind: structure`）：地面是带贴图的
`box` 或 `extrude`；墙是 `group` = 朝房间一侧 1 厘米厚的贴图面板 + 纯色墙体（背面扫到过就用背面的中位色，
否则用正面的中位色），从房间外面看不会再看到镜像的贴图。
贴图约定（与网站的 `planar` 投影一致，图片第 0 行 = v 最大）：
- 墙：第 0 列 = 从房间里看的左端（局部 −x），第 0 行 = 顶部；
- 地面：第 0 列 = x 最小，第 0 行 = z 最大。
"""

from __future__ import annotations

import io
import logging
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from PIL import Image
from scipy import ndimage

from .. import shapes as sh
from ..ids import slug_id
from .bake import FaceTable, bake, fill_unobserved
from .scan import ScanMesh, sample_surface

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class StructureParams:
    sample_density: float = 1500.0  # 表面采样密度（点/平方米）
    px: float = 0.01  # 贴图分辨率（米/纹素）
    bake_density: float = 40_000.0  # 烘焙时的重采样密度（点/平方米），约每纹素 4 个
    max_texture_px: int = 4096  # 贴图单边像素上限，超出时自动降低分辨率
    height_cell: float = 0.5  # 地面局部高度场的格子（米）
    footprint_cell: float = 0.1  # 地面占用图的格子（米）
    wall_dir_min_area: float = 4.0  # 斜向墙方向至少要有这么多面积（平方米）才算一个方向
    wall_peak_min_area: float = 0.8  # 偏移直方图的峰至少这么多面积
    wall_min_area: float = 2.0  # 一段墙至少这么多内点面积
    wall_min_length: float = 1.0  # 一段墙至少这么长（米）
    wall_fill_upper: float = 0.7  # 1.0–2.4 米的覆盖率下限
    glazing_min_area: float = 4.0
    glazing_min_length: float = 3.0
    floor_band: float = 0.035  # 地面烘焙只取局部高度 ±3.5 厘米内的点（去掉椅子底座、地毯）
    floor_dark: float = 0.72  # 比周围地面暗这么多倍以上的采样点去掉
    floor_hue: float = 0.05  # 色度偏离周围地面超过这么多的采样点去掉
    wall_fill_near: float = 0.05  # 墙面没扫到的纹素：离已扫到区域这么近的用推拉补洞（米）
    wall_fill_far: float = 0.3  # 这么远以外用同一面墙沿墙分段的中位色，中间线性过渡（米）
    wall_fill_band: float = 0.5  # 沿墙分段取中位色的段长（米）
    wall_thickness: float = 0.1
    wall_face_thickness: float = 0.01  # 墙朝房间一侧的贴图面板厚度，其余墙体用纯色（背面不再显示镜像的贴图）
    wall_back_depth: float = 0.3  # 墙背面的扫描最多在墙面后这么远（米），用来取墙体颜色
    wall_back_min_area: float = 0.5  # 背面扫到这么多面积（平方米）才用背面的颜色
    floor_thickness: float = 0.05
    jpeg_quality: int = 85
    seed: int = 0


@dataclass
class Element:
    id: str
    kind: str  # floor | wall | glazing
    texture: np.ndarray  # H×W×3 uint8
    observed: np.ndarray  # H×W bool
    info: dict[str, Any] = field(default_factory=dict)


@dataclass
class StructureResult:
    floor_y: float
    elements: list[Element]
    footprint: np.ndarray  # [z, x] bool，footprint_cell 格子
    footprint_cell: float
    stats: dict[str, Any] = field(default_factory=dict)


def _runs(b: np.ndarray) -> list[tuple[int, int]]:
    """一维布尔数组里 True 的 [start, end) 段。"""
    d = np.diff(np.r_[0, b.astype(np.int8), 0])
    return list(zip(np.where(d == 1)[0].tolist(), np.where(d == -1)[0].tolist(), strict=True))


def _angdiff(a, b):
    return np.abs((a - b + 180) % 360 - 180)


def _lum(col: np.ndarray) -> np.ndarray:
    return col.astype(np.float64) @ np.array([0.299, 0.587, 0.114])


def _chroma(col: np.ndarray) -> np.ndarray:
    c = col.astype(np.float64) + 1.0
    return c[:, [0, 2]] / c.sum(1, keepdims=True)


class _HeightField:
    """地面局部高度场（每格取中位数，空格用最近的有效格填，再 3×3 平滑）。"""

    def __init__(self, P: np.ndarray, sel: np.ndarray, extent: np.ndarray, cell: float, min_pts: int) -> None:
        self.cell = cell
        self.gx = int(np.ceil(max(extent[0], cell) / cell)) + 1
        self.gz = int(np.ceil(max(extent[2], cell) / cell)) + 1
        ci = np.clip((P[sel, 2] / cell).astype(int), 0, self.gz - 1)
        cj = np.clip((P[sel, 0] / cell).astype(int), 0, self.gx - 1)
        self.ci, self.cj = ci, cj
        med = self.cell_median(P[sel, 1], min_pts)
        self.raw = med
        valid = ~np.isnan(med)
        if not valid.any():
            med = np.zeros_like(med)
            valid = np.ones_like(valid)
        _, (ni, nj) = ndimage.distance_transform_edt(~valid, return_indices=True)
        self.field = ndimage.uniform_filter(med[ni, nj], 3)

    def cell_median(self, vals: np.ndarray, min_pts: int) -> np.ndarray:
        out = np.full((self.gz, self.gx), np.nan)
        if len(vals) == 0:
            return out
        lin_all = self.ci * self.gx + self.cj
        order = np.lexsort((vals, lin_all))
        lin, vs = lin_all[order], vals[order]
        starts = np.r_[0, np.where(np.diff(lin))[0] + 1]
        ends = np.r_[starts[1:], len(lin)]
        for s, e in zip(starts, ends, strict=True):
            if e - s >= min_pts:
                out.flat[lin[s]] = vs[(s + e) // 2]
        return out

    def filled_median(self, vals: np.ndarray, min_pts: int, size: int = 7) -> np.ndarray:
        ref = self.cell_median(vals, min_pts)
        if np.isnan(ref).all():
            ref[:] = np.nanmean(vals) if len(vals) else 0.0
        _, (ni, nj) = ndimage.distance_transform_edt(np.isnan(ref), return_indices=True)
        return ndimage.median_filter(ref[ni, nj], size)

    def sample(self, grid: np.ndarray, x: np.ndarray, z: np.ndarray) -> np.ndarray:
        i = np.clip(z / self.cell - 0.5, 0, self.gz - 1)
        j = np.clip(x / self.cell - 0.5, 0, self.gx - 1)
        return ndimage.map_coordinates(grid, [i, j], order=1, mode="nearest")

    def height(self, x: np.ndarray, z: np.ndarray) -> np.ndarray:
        return self.sample(self.field, x, z)


def extract_structure(mesh: ScanMesh, params: StructureParams | None = None) -> StructureResult:
    """在已对齐（地面 y≈0，墙与坐标轴对齐，最小角在原点）的扫描上找出地面、墙和玻璃，并烘焙贴图。"""
    prm = params or StructureParams()
    dens = prm.sample_density

    def pts(area: float) -> int:
        return max(3, round(area * dens))

    table = FaceTable(mesh)
    V = mesh.vertices
    extent = V.max(axis=0)
    P, C, N, _ = sample_surface(mesh, dens, seed=prm.seed)
    stats: dict[str, Any] = {"samples": len(P)}
    if len(P) < 100:
        raise ValueError("扫描表面太小，无法重建结构")
    FG = prm.footprint_cell
    cell_min = max(1, round(0.2 * FG * FG * dens))  # 10 厘米格子里至少 20% 的期望点数

    # ------------------------------------------------------------ 1. 地面
    up = (N[:, 1] > 0.9) & (P[:, 1] < 0.4)
    if up.sum() < pts(0.5):
        raise ValueError("找不到地面（朝上的低处表面太少）")
    hy, ey = np.histogram(P[up, 1], bins=80, range=(-0.2, 0.4))
    y_mode = 0.5 * (ey[np.argmax(hy)] + ey[np.argmax(hy) + 1])
    fl = up & (np.abs(P[:, 1] - y_mode) < 0.15)
    floor_y = float(np.median(P[fl, 1]))
    G = prm.height_cell
    hf_min = max(3, round(0.0667 * G * G * dens))
    hf = _HeightField(P, fl, extent, G, hf_min)
    fin = up & (np.abs(P[:, 1] - hf.height(P[:, 0], P[:, 2])) < 0.05)
    stats["floor"] = {"y": floor_y, "inliers": int(fin.sum())}

    nz, nx = int(np.ceil(extent[2] / FG)) + 2, int(np.ceil(extent[0] / FG)) + 2
    fz = np.clip((P[fin, 2] / FG).astype(int), 0, nz - 1)
    fx = np.clip((P[fin, 0] / FG).astype(int), 0, nx - 1)
    cnt = np.zeros((nz, nx))
    np.add.at(cnt, (fz, fx), 1)
    occ = cnt >= cell_min
    occ = ndimage.binary_closing(occ, np.ones((3, 3)), iterations=2)
    lab, nl = ndimage.label(occ)
    if nl == 0:
        raise ValueError("找不到地面范围")
    occ = lab == (np.argmax(np.bincount(lab.ravel())[1:]) + 1)
    occ = ndimage.binary_fill_holes(occ)
    occ = ndimage.binary_opening(occ, np.ones((3, 3)))
    if not occ.any():
        raise ValueError("地面范围为空")

    # ------------------------------------------------------------ 2. 墙
    hor = np.abs(N[:, 1]) < 0.3
    nh = N[:, [0, 2]] / np.maximum(np.linalg.norm(N[:, [0, 2]], axis=1, keepdims=True), 1e-9)
    ANG = np.degrees(np.arctan2(nh[:, 1], nh[:, 0]))
    ah, _ = np.histogram(ANG[hor], bins=360, range=(-180, 180))
    ahs = np.convolve(np.r_[ah[-4:], ah, ah[:4]], np.ones(9), "valid")  # ±4° 窗口，首尾相接
    dirs = [0.0, 90.0, 180.0, -90.0]
    for i in np.argsort(-ahs, kind="stable"):
        if ahs[i] < pts(prm.wall_dir_min_area):
            break
        a = -179.5 + float(i)
        # 直方图窗口有平台（墙很平时只落在一两格里），用 ±5° 内法线角度的圆周平均精化方向
        near = hor & (_angdiff(ANG, a) < 5)
        if near.any():
            rad = np.radians(ANG[near])
            a = float(np.degrees(np.arctan2(np.sin(rad).mean(), np.cos(rad).mean())))
        if min(abs((a - d + 180) % 360 - 180) for d in dirs) > 10:
            dirs.append(round(a, 2))
    stats["wall_directions"] = dirs

    claimed = np.zeros(len(P), bool)
    cands: list[dict[str, Any]] = []
    for dg in dirs:
        a = math.radians(dg)
        n2 = np.array([math.cos(a), math.sin(a)])
        if dg in (0.0, 90.0, 180.0, -90.0):
            n2 = np.round(n2, 12)
        t2 = np.array([n2[1], -n2[0]])
        dm = hor & (_angdiff(ANG, dg) < 20)
        if dm.sum() < pts(prm.wall_peak_min_area):
            continue
        s_all = P[:, [0, 2]] @ n2
        u_all = P[:, [0, 2]] @ t2
        s = s_all[dm]
        lo = math.floor(s.min() / 0.02) * 0.02
        nb = int((s.max() - lo) / 0.02) + 2
        hh, ee = np.histogram(s, bins=nb, range=(lo, lo + 0.02 * nb))
        sup = np.convolve(hh, np.ones(5), "same")
        peaks = [
            i
            for i in range(nb)
            if sup[i] == sup[max(0, i - 7) : i + 8].max() and sup[i] >= pts(prm.wall_peak_min_area)
        ]
        for i in sorted(peaks, key=lambda i: -sup[i]):
            off0 = 0.5 * (ee[i] + ee[i + 1])
            band = dm & ~claimed & (np.abs(s_all - off0) < 0.25)
            if band.sum() < pts(prm.wall_peak_min_area):
                continue
            # 漂移：沿墙每 0.5 米一段，取偏移直方图的众数
            ub = np.floor(u_all[band] / 0.5).astype(int)
            sb = s_all[band]
            loc: dict[int, float] = {}
            for b in np.unique(ub):
                sv = sb[ub == b]
                if len(sv) < pts(0.027):
                    continue
                hb, eb = np.histogram(sv, bins=50, range=(off0 - 0.25, off0 + 0.25))
                hb = np.convolve(hb, np.ones(3), "same")
                k = int(np.argmax(hb))
                if hb[k] < pts(0.0133):
                    continue
                loc[int(b)] = 0.5 * (eb[k] + eb[k + 1])
            if len(loc) < 2:
                continue
            kb = np.array(sorted(loc))
            kv = np.array([loc[b] for b in kb])
            # 去掉和相邻段相差过大的段（墙前的家具）
            med = ndimage.median_filter(kv, 5, mode="nearest")
            good = np.abs(kv - med) < 0.05
            kb, kv = kb[good], kv[good]
            if len(kb) < 2:
                continue
            prof_u = (kb + 0.5) * 0.5
            inl = band & (np.abs(s_all - np.interp(u_all, prof_u, kv)) < 0.04)
            if inl.sum() < pts(prm.wall_peak_min_area):
                continue
            # 10 厘米 (沿墙, 高度) 占用图上切段
            ui, yi = u_all[inl], P[inl, 1]
            u_lo = math.floor(ui.min() / 0.1) * 0.1
            nu = int((ui.max() - u_lo) / 0.1) + 1
            grid = np.zeros((nu, 30))
            np.add.at(
                grid,
                (((ui - u_lo) / 0.1).astype(int).clip(0, nu - 1), (yi / 0.1).astype(int).clip(0, 29)),
                1,
            )
            occg = grid >= cell_min
            upper = occg[:, 10:24].mean(1)  # 1.0–2.4 米（下部常被家具挡住）
            low = occg[:, 1:6].sum(1) >= 2  # 接近地面
            high = occg[:, 20:27].sum(1) >= 2  # 到达 2 米以上
            wallcol = (upper >= 0.6) & high
            pad = np.zeros(3, bool)
            wallcol = ndimage.binary_closing(np.r_[pad, wallcol, pad], np.ones(4))[3:-3]
            for r0, r1 in _runs(wallcol):
                if (r1 - r0) * 0.1 < 0.6:
                    continue
                if low[r0:r1].mean() < 0.2:  # 整段都不着地：电视、吊柜
                    continue
                ua, ubb = u_lo + r0 * 0.1, u_lo + r1 * 0.1
                seg = inl & (u_all >= ua) & (u_all < ubb)
                cands.append(
                    dict(
                        dir=dg,
                        n2=n2,
                        t2=t2,
                        off=float(np.median(s_all[seg])),
                        u=[float(ua), float(ubb)],
                        y=[float(np.percentile(P[seg, 1], 0.5)), float(np.percentile(P[seg, 1], 99.5))],
                        npts=int(seg.sum()),
                        fill=float(occg[r0:r1, 2:24].mean()),
                        fill_upper=float(occg[r0:r1, 10:24].mean()),
                        prof_u=prof_u,
                        prof_v=kv,
                        seg=seg,
                    )
                )
            claimed |= inl

    cands.sort(key=lambda c: -c["npts"])
    walls = [
        c
        for c in cands
        if (c["u"][1] - c["u"][0]) >= prm.wall_min_length
        and c["fill_upper"] >= prm.wall_fill_upper
        and c["npts"] >= pts(prm.wall_min_area)
    ]
    for c in walls:
        useg = P[c["seg"]][:, [0, 2]] @ c["t2"]
        c["u"] = [
            max(c["u"][0], float(np.percentile(useg, 0.2)) - 0.02),
            min(c["u"][1], float(np.percentile(useg, 99.8)) + 0.02),
        ]
        c["glazing"] = False
        c["band"] = (0.05, 0.05)
    stats["wall_candidates"] = len(cands)
    stats["walls"] = len(walls)

    # ------------------------------------------------------------ 2b. 玻璃
    near_solid = np.zeros(len(P), bool)
    for c in walls:
        s_ = P[:, [0, 2]] @ c["n2"]
        u_ = P[:, [0, 2]] @ c["t2"]
        near_solid |= (np.abs(s_ - c["off"]) < 0.25) & (u_ > c["u"][0] - 0.2) & (u_ < c["u"][1] + 0.2)
    hor5 = np.abs(N[:, 1]) < 0.5

    def in_footprint(x: np.ndarray, z: np.ndarray) -> np.ndarray:
        i = (z / FG).astype(int)
        j = (x / FG).astype(int)
        ok = (i >= 0) & (i < occ.shape[0]) & (j >= 0) & (j < occ.shape[1])
        r = np.zeros(len(x), bool)
        r[ok] = occ[i[ok], j[ok]]
        return r

    for dg in (0.0, 90.0, 180.0, -90.0):
        a = math.radians(dg)
        n2 = np.round(np.array([math.cos(a), math.sin(a)]), 6)
        t2 = np.array([n2[1], -n2[0]])
        dm = hor5 & (_angdiff(ANG, dg) < 35) & ~near_solid
        s_all = P[:, [0, 2]] @ n2
        u_all = P[:, [0, 2]] @ t2
        sel = dm & (P[:, 1] > 0.8)
        if sel.sum() < pts(prm.glazing_min_area):
            continue
        lo = math.floor(s_all[sel].min() / 0.05) * 0.05
        nb = int((s_all[sel].max() - lo) / 0.05) + 2
        hh, ee = np.histogram(s_all[sel], bins=nb, range=(lo, lo + 0.05 * nb))
        sm = np.convolve(hh, np.ones(13), "same")
        i = int(np.argmax(sm))
        if sm[i] < pts(prm.glazing_min_area):
            continue
        cen = 0.5 * (ee[i] + ee[i + 1])
        band = dm & (np.abs(s_all - cen) < 0.35)
        ui, yi = u_all[band], P[band, 1]
        u_lo = math.floor(ui.min() / 0.1) * 0.1
        nu = int((ui.max() - u_lo) / 0.1) + 1
        g = np.zeros((nu, 30))
        np.add.at(g, (((ui - u_lo) / 0.1).astype(int).clip(0, nu - 1), (yi / 0.1).astype(int).clip(0, 29)), 1)
        col = (g[:, 10:24] >= 1).mean(1) >= 0.4
        pad = np.zeros(16, bool)
        col = ndimage.binary_closing(np.r_[pad, col, pad], np.ones(16))[16:-16]  # 跨过 1.5 米以内的遮挡
        for r0, r1 in _runs(col):
            if (r1 - r0) * 0.1 < prm.glazing_min_length:
                continue
            ua, ub_ = u_lo + r0 * 0.1, u_lo + r1 * 0.1
            seg = band & (u_all >= ua) & (u_all < ub_)
            off = float(np.percentile(s_all[seg], 75))  # 玻璃靠房间一侧的面
            uu = np.linspace(ua, ub_, 60)
            f_in = np.mean(
                [
                    in_footprint(*(n2[None] * (off + dd) + t2[None] * uu[:, None]).T).mean()
                    for dd in (0.6, 1.2, 1.8)
                ]
            )
            b_in = np.mean(
                [
                    in_footprint(*(n2[None] * (off - dd) + t2[None] * uu[:, None]).T).mean()
                    for dd in (0.6, 1.2)
                ]
            )
            if f_in < 0.5 or b_in > 0.2:
                continue
            sv = s_all[seg]
            walls.append(
                dict(
                    dir=dg,
                    n2=n2,
                    t2=t2,
                    off=off,
                    u=[float(ua), float(ub_)],
                    y=[0.0, float(np.percentile(P[seg, 1], 99.5))],
                    npts=int(seg.sum()),
                    fill=float((g[r0:r1, 2:24] >= 1).mean()),
                    fill_upper=float((g[r0:r1, 10:24] >= 1).mean()),
                    prof_u=np.array([ua, ub_]),
                    prof_v=np.array([off, off]),
                    seg=seg,
                    glazing=True,
                    band=(
                        float(np.percentile(sv, 98) - off) + 0.02,
                        float(off - np.percentile(sv, 2)) + 0.02,
                    ),
                )
            )

    # ------------------------------------------------------------ 2c. 墙角吸附
    snaps: list[tuple[int, int, float]] = []
    for i, A in enumerate(walls):
        for j, B in enumerate(walls):
            if j <= i or abs(A["n2"] @ B["n2"]) > 0.95:
                continue
            M = np.array([A["n2"], B["n2"]])
            X = np.linalg.solve(M, [A["off"], B["off"]])
            tol = 1.0 if (A["glazing"] or B["glazing"]) else 0.3
            ea = [k for k in (0, 1) if abs(X @ A["t2"] - A["u"][k]) < tol]
            eb = [k for k in (0, 1) if abs(X @ B["t2"] - B["u"][k]) < tol]
            if ea and eb:
                snaps.append((i, ea[0], float(X @ A["t2"])))
                snaps.append((j, eb[0], float(X @ B["t2"])))
    for i, k, u in snaps:
        walls[i]["u"][k] = u
    for c in walls:
        if c["u"][1] < c["u"][0]:
            c["u"] = sorted(c["u"])
    stats["corner_snaps"] = len(snaps) // 2

    # ------------------------------------------------------------ 2d. 地面补全
    bar = np.zeros_like(occ)
    for c in walls:
        uu = np.arange(c["u"][0], c["u"][1], 0.02)
        xy = c["n2"][None] * c["off"] + c["t2"][None] * uu[:, None]
        i, j = (xy[:, 1] / FG).astype(int), (xy[:, 0] / FG).astype(int)
        ok = (i >= 0) & (i < occ.shape[0]) & (j >= 0) & (j < occ.shape[1])
        bar[i[ok], j[ok]] = True
    occ0 = occ.copy()
    occ = ndimage.binary_fill_holes(
        ndimage.binary_closing(occ | bar, np.ones((3, 3)), iterations=2) | occ | bar
    )
    occ &= ndimage.binary_dilation(occ0, np.ones((3, 3)), iterations=12)  # 不超出已扫到的地面 1.2 米
    occ = ndimage.binary_opening(occ, np.ones((2, 2))) | occ0
    zz, xx = np.where(occ)
    floor_rect = {"x": [xx.min() * FG, (xx.max() + 1) * FG], "z": [zz.min() * FG, (zz.max() + 1) * FG]}
    outline = floor_outline(occ, FG)
    if outline:
        ox, oz = [p[0] for p in outline], [p[1] for p in outline]
        floor_rect = {"x": [min(ox), max(ox)], "z": [min(oz), max(oz)]}
    stats["floor"]["footprint_m2"] = round(float(occ.sum() * FG * FG), 2)
    stats["floor"]["scanned_m2"] = round(float(occ0.sum() * FG * FG), 2)

    # ------------------------------------------------------------ 3. 贴图
    elements: list[Element] = []
    fx0, fx1 = floor_rect["x"]
    fz0, fz1 = floor_rect["z"]
    pxf = max(prm.px, (fx1 - fx0) / prm.max_texture_px, (fz1 - fz0) / prm.max_texture_px)
    Wf, Hf = max(1, round((fx1 - fx0) / pxf)), max(1, round((fz1 - fz0) / pxf))
    # 参考颜色：地面内点每格的中位数，再做 3.5 米的中值滤波（与验证代码相同）
    hf_ref = _HeightField(P, fin, extent, G, hf_min)
    REF = [hf_ref.filled_median(_lum(C[fin]), hf_min)] + [
        hf_ref.filled_median(_chroma(C[fin])[:, k], hf_min) for k in (0, 1)
    ]

    def floor_ok(p: np.ndarray, col: np.ndarray) -> np.ndarray:
        band_ok = np.abs(p[:, 1] - hf.height(p[:, 0], p[:, 2])) < prm.floor_band
        r = [hf_ref.sample(R, p[:, 0], p[:, 2]) for R in REF]
        ch = _chroma(col)
        return (
            band_ok
            & (_lum(col) > prm.floor_dark * r[0])
            & (np.abs(ch[:, 0] - r[1]) < prm.floor_hue)
            & (np.abs(ch[:, 1] - r[2]) < prm.floor_hue)
        )

    FC = table.centers
    ffaces = np.where(
        (table.normals[:, 1] > 0.85)
        & (np.abs(FC[:, 1] - hf.height(FC[:, 0], FC[:, 2])) < prm.floor_band + 0.01)
        & (FC[:, 0] > fx0 - 0.05)
        & (FC[:, 0] < fx1 + 0.05)
        & (FC[:, 2] > fz0 - 0.05)
        & (FC[:, 2] < fz1 + 0.05)
    )[0]
    rgb, obs = bake(
        table,
        ffaces,
        lambda p: ((p[:, 0] - fx0) / pxf, (fz1 - p[:, 2]) / pxf),  # 第 0 行 = z 最大
        (Wf, Hf),
        keep=floor_ok,
        density=prm.bake_density,
        seed=prm.seed + 1,
    )
    elements.append(
        Element(
            id="floor",
            kind="floor",
            texture=rgb,
            observed=obs,
            info={
                "y": floor_y,
                "rect": floor_rect,
                "px": pxf,
                "thickness": prm.floor_thickness,
                "height_range": [float(np.nanmin(hf.raw)), float(np.nanmax(hf.raw))]
                if not np.isnan(hf.raw).all()
                else [floor_y, floor_y],
                "footprint_m2": stats["floor"]["footprint_m2"],
                "outline": outline,
            },
        )
    )

    solid_tops = [c["y"][1] for c in walls if not c["glazing"]]
    wall_top = float(np.median(solid_tops)) if solid_tops else 2.6
    counters: dict[tuple[str, str], int] = {}
    for c in walls:
        if c["glazing"]:
            c["y"][1] = min(c["y"][1], wall_top)  # 透过玻璃看到的东西会超出天花板线
        n2, t2, off = c["n2"], c["t2"], c["off"]
        axis = "x" if abs(n2[0]) > 0.999 else ("z" if abs(n2[1]) > 0.999 else "n")
        y0 = floor_y if c["y"][0] < 0.4 else c["y"][0]
        y1 = c["y"][1]
        if y1 - y0 < 0.3:
            continue
        u0, u1 = c["u"]
        prof_u, prof_v = c["prof_u"], c["prof_v"]
        bf, bb = c["band"]
        wo = off * (n2[0] if axis == "x" else n2[1]) if axis in "xz" else off
        tag = {"x": f"x{wo:.2f}", "z": f"z{wo:.2f}", "n": f"a{round(c['dir']) % 360}"}[axis]
        pre = "glazing" if c["glazing"] else "wall"
        counters[(pre, tag)] = counters.get((pre, tag), 0) + 1
        wid = slug_id(f"{pre}-{tag}-{counters[(pre, tag)]}")
        pxw = max(prm.px, (u1 - u0) / prm.max_texture_px, (y1 - y0) / prm.max_texture_px)
        Ww, Hw = max(1, round((u1 - u0) / pxw)), max(1, round((y1 - y0) / pxw))
        fs = FC[:, [0, 2]] @ n2
        fu = FC[:, [0, 2]] @ t2
        fn2 = table.normals[:, [0, 2]] @ n2
        dsf = fs - np.interp(fu, prof_u, prof_v)
        ffs = np.where(
            (fn2 > math.cos(math.radians(35 if c["glazing"] else 30)))
            & (dsf < bf + 0.01)
            & (dsf > -bb - 0.01)
            & (fu > u0 - 0.05)
            & (fu < u1 + 0.05)
            & (FC[:, 1] > y0 - 0.05)
            & (FC[:, 1] < y1 + 0.05)
        )[0]

        def keep(p, col, n2=n2, t2=t2, prof_u=prof_u, prof_v=prof_v, bf=bf, bb=bb):
            d_ = p[:, [0, 2]] @ n2 - np.interp(p[:, [0, 2]] @ t2, prof_u, prof_v)
            return (d_ < bf) & (d_ > -bb)

        rgb, obs = bake(
            table,
            ffs,
            lambda p, t2=t2, u0=u0, y1=y1, pxw=pxw: (((p[:, [0, 2]] @ t2) - u0) / pxw, (y1 - p[:, 1]) / pxw),
            (Ww, Hw),
            keep=keep,
            density=prm.bake_density,
            seed=prm.seed + 2 + len(elements),
            fill=False,
        )
        filled = fill_unobserved(
            rgb,
            obs,
            near_px=prm.wall_fill_near / pxw,
            far_px=prm.wall_fill_far / pxw,
            band_px=max(1, round(prm.wall_fill_band / pxw)),
        )
        rgb = np.clip(np.round(filled), 0, 255).astype(np.uint8)
        # 墙体颜色：背面扫到过（独立的隔墙、背后是走廊）就用背面的中位色，否则用正面已扫到部分的中位色
        sp = P[:, [0, 2]] @ n2 - np.interp(P[:, [0, 2]] @ t2, prof_u, prof_v)
        back = (
            (N[:, [0, 2]] @ n2 < -0.85)
            & (sp < -0.01)
            & (sp > -(prm.wall_thickness + prm.wall_back_depth))
            & (P[:, [0, 2]] @ t2 > u0)
            & (P[:, [0, 2]] @ t2 < u1)
            & (P[:, 1] > y0)
            & (P[:, 1] < y1)
        )
        if back.sum() >= pts(prm.wall_back_min_area):
            body = np.median(C[back], axis=0)
        elif obs.any():
            body = np.median(rgb[obs], axis=0)
        else:
            body = np.median(rgb.reshape(-1, 3), axis=0)
        pu = np.linspace(u0, u1, max(2, int((u1 - u0) / 0.5) + 1))
        drift = np.interp(pu, prof_u, prof_v) - off
        elements.append(
            Element(
                id=wid,
                kind="glazing" if c["glazing"] else "wall",
                texture=rgb,
                observed=obs,
                info={
                    "normal": [float(n2[0]), float(n2[1])],
                    "tangent": [float(t2[0]), float(t2[1])],
                    "offset": float(off),
                    "u": [float(u0), float(u1)],
                    "y": [float(y0), float(y1)],
                    "px": pxw,
                    "thickness": prm.wall_thickness,
                    "face_thickness": prm.wall_face_thickness,
                    "body_color": [int(v) for v in np.round(body)],
                    "axis": axis,
                    "direction_deg": float(c["dir"]),
                    "support_pts": int(c["npts"]),
                    "fill_above_1m": float(c["fill_upper"]),
                    "max_drift": float(np.abs(drift).max()),
                },
            )
        )
    stats["elements"] = len(elements)
    return StructureResult(floor_y=floor_y, elements=elements, footprint=occ, footprint_cell=FG, stats=stats)


# ---------------------------------------------------------------------------- 地面轮廓


def _trace_outline(mask: np.ndarray, cell: float) -> list[tuple[float, float]]:
    """最大连通区域的外轮廓（格子边界，单位米），点在 (x, z) 平面上逆时针排列。"""
    lab, n = ndimage.label(mask)
    if n == 0:
        return []
    biggest = lab == (np.argmax(np.bincount(lab.ravel())[1:]) + 1)
    region = ndimage.binary_fill_holes(biggest)
    H, W = region.shape
    padded = np.zeros((H + 2, W + 2), bool)
    padded[1:-1, 1:-1] = region
    # 有向边：每个占用格子的四条边里，邻格为空的那条（格子坐标 (z, x)，顶点坐标 (x, z)）
    edges: dict[tuple[int, int], tuple[int, int]] = {}
    zs, xs = np.nonzero(padded)
    for z, x in zip(zs.tolist(), xs.tolist(), strict=True):
        gx, gz = x - 1, z - 1
        # 在 (x, z) 平面里逆时针绕格子：(gx,gz)->(gx+1,gz)->(gx+1,gz+1)->(gx,gz+1)
        if not padded[z - 1, x]:
            edges[(gx, gz)] = (gx + 1, gz)
        if not padded[z, x + 1]:
            edges[(gx + 1, gz)] = (gx + 1, gz + 1)
        if not padded[z + 1, x]:
            edges[(gx + 1, gz + 1)] = (gx, gz + 1)
        if not padded[z, x - 1]:
            edges[(gx, gz + 1)] = (gx, gz)
    if not edges:
        return []
    start = min(edges)
    loop = [start]
    cur = edges[start]
    guard = 0
    while cur != start and guard < len(edges) + 1:
        loop.append(cur)
        cur = edges.get(cur)
        if cur is None:
            break
        guard += 1
    if cur != start:
        return []  # 有捏合点（两个格子只在角上相接）时放弃，退回矩形
    pts = np.array(loop, float) * cell
    return [(float(p[0]), float(p[1])) for p in pts]


def _rdp(points: np.ndarray, tol: float) -> np.ndarray:
    if len(points) < 3:
        return points
    a, b = points[0], points[-1]
    ab = b - a
    norm = np.hypot(*ab)
    if norm < 1e-12:
        d = np.hypot(*(points - a).T)
    else:
        d = np.abs(ab[0] * (points[:, 1] - a[1]) - ab[1] * (points[:, 0] - a[0])) / norm
    k = int(np.argmax(d))
    if d[k] > tol:
        left = _rdp(points[: k + 1], tol)
        right = _rdp(points[k:], tol)
        return np.vstack([left[:-1], right])
    return np.vstack([a, b])


def simplify_closed(points: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """闭合多边形的道格拉斯–普克简化（从离起点最远的点处切开，分两半简化）。"""
    if len(points) < 4:
        return points
    arr = np.array(points)
    far = int(np.argmax(np.hypot(*(arr - arr[0]).T)))
    first = _rdp(arr[: far + 1], tol)
    second = _rdp(np.vstack([arr[far:], arr[:1]]), tol)
    out = np.vstack([first[:-1], second[:-1]])
    return [(float(p[0]), float(p[1])) for p in out]


# ---------------------------------------------------------------------------- 物件记录


def encode_texture(rgb: np.ndarray, quality: int = 85) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="JPEG", quality=quality, optimize=True, progressive=False)
    return buf.getvalue()


def element_shape(element: Element, texture_hash: str) -> dict[str, Any]:
    """一个结构元素 → SHAPES 形状。

    - 地面：带贴图的 box，非矩形时用 extrude；
    - 墙：group = 朝房间一侧的薄贴图面板 + 纯色墙体。整块 box 用 planar 贴图时背面、顶面、侧面也会印上
      （镜像的）贴图，从房间外面看就是一面印着反字和斑点的墙，所以贴图只放在面板上，墙体用这面墙的中位色。
    """
    material = sh.texture_material(texture_hash, "planar")
    info = element.info
    if element.kind == "floor":
        (x0, x1), (z0, z1) = info["rect"]["x"], info["rect"]["z"]
        t = info["thickness"]
        cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
        xf = sh.transform(position=[cx, info["y"] - t, cz])
        outline = info.get("outline")
        if outline and len(outline) >= 3:
            rel = [(px - cx, pz - cz) for px, pz in outline]
            return sh.extrude(sh.outline(rel), t, xf=xf, material=material)
        return sh.box([x1 - x0, t, z1 - z0], xf=xf, material=material)
    n = np.array(info["normal"])
    tvec = np.array(info["tangent"])
    u0, u1 = info["u"]
    y0, y1 = info["y"]
    t = info["thickness"]
    face = n * info["offset"] + tvec * (u0 + u1) / 2  # 可见面（房间一侧）的中点，墙体向后延伸
    yaw = math.degrees(math.atan2(n[0], n[1]))  # 局部 +z 指向房间，局部 +x = 切向
    xf = sh.transform(position=[face[0], y0, face[1]], yaw=yaw)
    w, h = u1 - u0, y1 - y0
    ft = min(float(info.get("face_thickness") or 0.0), t / 2)
    if ft <= 0 or "body_color" not in info:
        return sh.box(
            [w, h, t],
            xf=sh.transform(position=[face[0] - n[0] * t / 2, y0, face[1] - n[1] * t / 2], yaw=yaw),
            material=material,
        )
    return sh.group(
        [
            sh.box([w, h, ft], xf=sh.transform(position=[0, 0, -ft / 2]), material=material),
            sh.box(
                [w, h, t - ft],
                xf=sh.transform(position=[0, 0, -ft - (t - ft) / 2]),
                material=sh.color_material(info["body_color"]),
            ),
        ],
        xf=xf,
    )


LABELS = {"floor": "地面", "wall": "墙面", "glazing": "玻璃"}


def element_props(element: Element) -> dict[str, Any]:
    info = element.info
    props: dict[str, Any] = {
        "structure": element.kind,
        "observedFraction": round(float(element.observed.mean()), 3),
        "metresPerPixel": round(float(info["px"]), 4),
    }
    if element.kind == "floor":
        props["footprintM2"] = info.get("footprint_m2")
    else:
        props["supportPoints"] = info["support_pts"]
        props["maxDriftM"] = round(info["max_drift"], 3)
        if info["axis"] == "n":
            props["offAxisDeg"] = round(info["direction_deg"], 1)
    if element.kind == "glazing":
        props["confidence"] = "low"
    return props


def floor_outline(
    footprint: np.ndarray, cell: float, tolerance: float = 0.15
) -> list[tuple[float, float]] | None:
    """地面范围明显不是矩形时（填充率 < 97%），返回简化后的轮廓（逆时针），用 extrude 生成地面；否则 None。"""
    zz, xx = np.nonzero(footprint)
    if len(zz) == 0:
        return None
    area_rect = (xx.max() - xx.min() + 1) * (zz.max() - zz.min() + 1)
    if footprint.sum() / area_rect >= 0.97:
        return None
    outline = simplify_closed(_trace_outline(footprint, cell), tolerance)
    if len(outline) >= 3 and sh.signed_area(outline) > 0:
        return outline
    return None
