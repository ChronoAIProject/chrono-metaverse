"""物件的逐件偏差 `fit {meanCm, p90Cm, coverage3cm}`：打包流程（`authored_build`）和重建工作台（`compare`、
`assemble`、`place`）共用这一个函数，同样的扫描、物件网格和背景算出同样的数字。

1. **范围按物件自身的朝向取**：水平朝向是物件网格水平投影的最小外接矩形（竖直方向不转），在这个局部坐标里
   水平外扩 5 厘米；竖直方向只取底面以下 2 厘米到顶面以上 2 厘米。斜放的薄件（入口门框、隔断）不会把轴对齐
   包围盒角落里的门外走廊、隔壁算进来，顶到天花的物件不会把顶面 2 厘米以上的天花板算进来；
2. 范围里的扫描表面密集采样（每平方米 2 万点，最多 2 万点），求到物件网格和**背景**（全部结构：墙、玻璃、
   地面）的最近距离：贴墙、落地的扫描点算到墙和地面上，不当成物件的偏差；相邻的其他物件不当背景；
3. **只计距离在 10 厘米以内的点**：更远的是范围里别的东西（门外的走廊、桌下的椅子、路过的人），不是这件物件
   的偏差；
4. 离物件 10 厘米以内、又离背景超过 2 厘米的点（扫描里确实有这件物件的证据）不到 20 个时不写：范围里只有墙
   和地面，说明扫描里没有这件物件，偏差没有意义。

采样的随机数按物件编号固定。扫描的面按"外包球碰到范围"筛选、按编号顺序采样，所以工作台只读范围附近的
扫描（裁剪保持面的先后顺序）也得到同样的点。
"""

from __future__ import annotations

import math
import zlib
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.spatial import ConvexHull, QhullError

from .bake import FaceTable
from .fit_texture import SurfaceIndex, _closest_point_on_triangles, fit_stats
from .shape_mesh import Mesh, build_parts, merge_meshes

FIT_MARGIN = 0.05  # 局部坐标里水平外扩 5 厘米
FIT_VERTICAL = 0.02  # 竖直方向：底面以下、顶面以上各 2 厘米
FIT_NEAR = 0.10  # 只计到物件网格或背景 10 厘米以内的点
BACKGROUND_GAP = 0.02  # 离背景 2 厘米以内的点算背景的（不算物件的证据）
FIT_DENSITY = 20_000.0  # 每平方米采样点数
MAX_FIT_POINTS = 20_000
MIN_FIT_POINTS = 20
BACKGROUND_MARGIN = 0.3  # 背景只用离范围 30 厘米以内的结构三角形
BACKGROUND_EXACT_TRIANGLES = 2000  # 背景三角形不多时逐个精确求距离，多了用采样点索引


def fit_seed(*parts: str) -> int:
    return zlib.crc32("\0".join(parts).encode())


# ---------------------------------------------------------------------------- 范围


def _fold(angle: float) -> float:
    """矩形的朝向只看模 90°：折到 [0, π/2)，贴近 π/2 的当 0。"""
    a = math.fmod(angle, math.pi / 2)
    if a < 0:
        a += math.pi / 2
    return 0.0 if a > math.pi / 2 - 1e-9 else a


def footprint_yaw(xz: np.ndarray) -> float:
    """水平投影 (x, z) 的最小外接矩形的朝向（弧度，[0, π/2)）：局部 u 轴是 (cos, 0, sin)。

    面积相同时取角度小的（轴对齐的物件就是 0）；点共线时（竖着的薄片）沿那条线。"""
    pts = np.unique(np.round(np.asarray(xz, float), 6), axis=0)
    if len(pts) < 2:
        return 0.0
    try:
        hull = pts[ConvexHull(pts).vertices]
    except QhullError:  # 共线：np.unique 按字典序排好，首尾就是两端
        d = pts[-1] - pts[0]
        return _fold(math.atan2(d[1], d[0]))
    edges = np.roll(hull, -1, axis=0) - hull
    angles = sorted({round(_fold(math.atan2(e[1], e[0])), 9) for e in edges})
    best, best_area = 0.0, math.inf
    for a in angles:
        c, s = math.cos(a), math.sin(a)
        u = hull[:, 0] * c + hull[:, 1] * s
        w = hull[:, 1] * c - hull[:, 0] * s
        area = float((u.max() - u.min()) * (w.max() - w.min()))
        if area < best_area * (1 - 1e-9):
            best, best_area = a, area
    return best


@dataclass(frozen=True)
class FitRegion:
    """物件自身朝向的偏差范围：水平转 `yaw` 到局部坐标（u = x·cos + z·sin，w = z·cos − x·sin），y 不转。"""

    yaw: float
    lo: np.ndarray  # 局部坐标 (u, y, w) 的下界
    hi: np.ndarray

    def local(self, P: np.ndarray) -> np.ndarray:
        c, s = math.cos(self.yaw), math.sin(self.yaw)
        return np.stack([P[:, 0] * c + P[:, 2] * s, P[:, 1], P[:, 2] * c - P[:, 0] * s], axis=1)

    def contains(self, P: np.ndarray) -> np.ndarray:
        loc = self.local(P)
        return np.all((loc >= self.lo) & (loc <= self.hi), axis=1)

    def world_box(self) -> tuple[np.ndarray, np.ndarray]:
        """范围在空间坐标里的轴对齐外包盒。"""
        c, s = math.cos(self.yaw), math.sin(self.yaw)
        u = np.array([self.lo[0], self.hi[0], self.lo[0], self.hi[0]])
        w = np.array([self.lo[2], self.lo[2], self.hi[2], self.hi[2]])
        x, z = u * c - w * s, u * s + w * c
        return (
            np.array([x.min(), self.lo[1], z.min()]),
            np.array([x.max(), self.hi[1], z.max()]),
        )


def fit_region(meshes: list[Mesh]) -> FitRegion | None:
    """物件网格（空间坐标）→ 偏差范围（见模块说明第 1 条）。没有三角形时返回 None。"""
    V = [m.positions for m in meshes if len(m.indices)]
    if not V:
        return None
    pts = np.concatenate(V)
    yaw = footprint_yaw(pts[:, [0, 2]])
    region = FitRegion(yaw, np.zeros(3), np.zeros(3))
    L = region.local(pts)
    pad = np.array([FIT_MARGIN, FIT_VERTICAL, FIT_MARGIN])
    return FitRegion(yaw, L.min(axis=0) - pad, L.max(axis=0) + pad)


def region_points(table: FaceTable, region: FitRegion, seed: int) -> np.ndarray:
    """范围里的扫描表面密集采样点（最多 `MAX_FIT_POINTS` 个）。"""
    lo, hi = region.world_box()
    ids = table.faces_touching(lo, hi)
    if len(ids):  # 外包盒是粗筛，再在局部坐标里看外包球碰不碰到范围
        L = region.local(table.centers[ids])
        gap = np.maximum(region.lo - L, 0.0) + np.maximum(L - region.hi, 0.0)
        ids = ids[np.einsum("ij,ij->i", gap, gap) <= table.radius[ids] ** 2]
    if len(ids) == 0:
        return np.zeros((0, 3))
    area = float(table.area[ids].sum())
    rng = np.random.default_rng(seed)
    P, _, _ = table.dense(ids, min(FIT_DENSITY, MAX_FIT_POINTS / max(area, 1e-9)), rng)
    P = P[region.contains(P)]
    if len(P) > MAX_FIT_POINTS:
        P = P[np.sort(rng.choice(len(P), MAX_FIT_POINTS, replace=False))]
    return P


# ---------------------------------------------------------------------------- 背景


def background_meshes(bodies: Mapping[str, Mapping[str, Any]], templates: Mapping[str, Any]) -> list[Mesh]:
    """偏差的背景：全部结构（墙、玻璃、地面……）的网格，按编号排好（结果与记录的先后无关）。"""
    out = []
    for eid in sorted(bodies):
        body = bodies[eid]
        if body.get("kind") != "structure" or body.get("shape") is None:
            continue
        mesh = merge_meshes([p.mesh for p in build_parts(body["shape"], templates)])
        if len(mesh.indices):
            out.append(mesh)
    return out


def background_distance(
    P: np.ndarray, background: list[Mesh], lo: np.ndarray, hi: np.ndarray
) -> np.ndarray | None:
    """扫描点到背景（范围 [lo, hi] 附近的结构三角形）的距离；附近没有结构时返回 None。"""
    tris = [m.triangles() for m in background if len(m.indices)]
    if not tris or len(P) == 0:
        return None
    T = np.concatenate(tris)
    near = np.all(
        (T.max(axis=1) >= lo - BACKGROUND_MARGIN) & (T.min(axis=1) <= hi + BACKGROUND_MARGIN), axis=1
    )
    T = T[near]
    if len(T) == 0:
        return None
    if len(T) > BACKGROUND_EXACT_TRIANGLES:
        index = SurfaceIndex.build(
            [
                Mesh(
                    T.reshape(-1, 3),
                    np.zeros((len(T) * 3, 3)),
                    np.zeros((len(T) * 3, 2)),
                    np.arange(len(T) * 3).reshape(-1, 3),
                )
            ],
            spacing=0.02,
        )
        return index.query(P, k=4)[0]
    best = np.full(len(P), np.inf)
    for t in T:  # 结构多是大块平面，三角形少：逐个精确求最近点
        cp = _closest_point_on_triangles(np.broadcast_to(t, (len(P), 3, 3)), P)
        best = np.minimum(best, np.linalg.norm(cp - P, axis=1))
    return best


# ---------------------------------------------------------------------------- 偏差


def entity_fit(
    meshes: list[Mesh],
    table: FaceTable,
    eid: str,
    background: list[Mesh] | None = None,
) -> tuple[dict[str, float] | None, int]:
    """扫描到物件网格（空间坐标）的偏差（见模块说明）。返回 (fit 或 None, 计入的扫描点数)。"""
    meshes = [m for m in meshes if len(m.indices)]
    region = fit_region(meshes)
    if region is None:
        return None, 0
    P = region_points(table, region, fit_seed("fit", eid))
    if len(P) == 0:
        return None, 0
    index = SurfaceIndex.build(meshes, spacing=0.01, seed=fit_seed("surface", eid))
    d_mesh = index.query(P, k=4)[0]
    lo, hi = region.world_box()
    d_bg = background_distance(P, background or [], lo, hi)
    d = d_mesh if d_bg is None else np.minimum(d_mesh, d_bg)
    counted = d <= FIT_NEAR
    evidence = d_mesh <= FIT_NEAR
    if d_bg is not None:
        evidence &= d_bg > BACKGROUND_GAP
    points = int(counted.sum())
    if int(evidence.sum()) < MIN_FIT_POINTS:
        return None, points
    return fit_stats(d[counted]), points


__all__ = [
    "FitRegion",
    "background_distance",
    "background_meshes",
    "entity_fit",
    "fit_region",
    "fit_seed",
    "footprint_yaw",
    "region_points",
]
