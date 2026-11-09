"""扫描对齐（设计 6.2）：首次扫描自动摆正，重扫与参考扫描配准。

结果都是 4×4 变换（扫描坐标 → 空间坐标，按列主序存进提交的 `scan.transform`）。

**首次扫描**（`auto_align`）：

1. **找地面并摆正**：朝上的面（法线与 +y 夹角 15° 以内）按面积加权求平均法线，再在 5° 内精化一次；
   倾斜在 0.05°–10° 之间时把它转到 +y（Scaniverse 按重力定向，通常只有零点几度；超过 10° 说明不是地面，
   不做处理）；
2. **按墙面主方向绕竖直轴旋转**：近似竖直的面的水平法线模 90° 做面积加权直方图，峰值再用圆周平均精化
   （`scan.wall_rotation`），让墙和网格轴对齐；
3. **地面高度**：低处朝上的面按 1 厘米做面积加权直方图取众数（比顶点分位数稳，不受桌面、台阶影响）；
4. **原点**：实体区地面的一角 = 顶点 x、z 的 0.05% 分位数（去掉零星的离群点）。

**重扫**（`register_rescan`），只求绕竖直轴的旋转和平移：

1. **只用稳定结构**：表面采样后只留地面（朝上、贴近地面高度）和墙的上部（竖直、离地 1.1 米到接近
   天花板，家具一般够不着），地面点数不超过墙点数，避免真实的装修变化把结果带偏；
2. **粗对齐**：新扫描先按首次扫描的方法摆正，再把墙的朝向转到和参考扫描一致；主墙的 4 个 90° 朝向都试：
   每个朝向把墙点投到 5 厘米的俯视占用图上，和参考扫描的占用图做互相关（FFT），取峰值作为平移初值；
3. **精配准**：点到面的迭代最近点，未知数只有偏航角和三个平移量；对应点距离阈值从 25 厘米逐步收紧到
   4 厘米，法线不一致的对应点不用，残差用 Huber 权重（离群点影响有限）；
4. **误差**：每个稳定点到参考扫描的点到面距离（找不到 10 厘米内的对应点按 10 厘米算），去掉最差的 20%
   后取平均，单位厘米。4 个朝向里取误差最小的。误差超过阈值（默认 3 厘米）时调用方不自动提交。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage
from scipy.signal import fftconvolve
from scipy.spatial import cKDTree

from ..errors import InputRejected
from .scan import ScanMesh, apply_matrix, face_normals, rotation_y, sample_surface, wall_rotation

COS_15 = math.cos(math.radians(15))
COS_5 = math.cos(math.radians(5))


@dataclass
class AlignResult:
    matrix: np.ndarray  # 4×4，扫描坐标 → 空间坐标
    method: str  # auto | registered | given | reused
    rotation_deg: float = 0.0  # 绕竖直轴的旋转（首次扫描）
    tilt_deg: float = 0.0  # 摆正时修正的倾斜
    error_cm: float | None = None  # 重扫配准误差
    overlap: float | None = None  # 重扫配准：3 厘米内有对应点的稳定点比例
    candidates: list[dict] = field(default_factory=list)

    def column_major(self) -> list[float]:
        return column_major(self.matrix)

    def summary(self) -> dict:
        out: dict = {"method": self.method}
        if self.method == "auto":
            out["rotationDeg"] = round(self.rotation_deg, 3)
            out["tiltDeg"] = round(self.tilt_deg, 3)
        if self.error_cm is not None:
            out["errorCm"] = round(self.error_cm, 2)
        if self.overlap is not None:
            out["overlap"] = round(self.overlap, 3)
        return out


def column_major(matrix: np.ndarray) -> list[float]:
    out = []
    for value in np.asarray(matrix, np.float64).T.reshape(-1):
        v = round(float(value), 9)  # 去掉浮点尾数噪声，让 JSON 更短、哈希更稳定
        out.append(0.0 if v == 0 else v)
    return out


def matrix_from_params(values) -> np.ndarray:
    """校验调用方给的 `transform`：16 个有限数字（列主序），最后一行是 [0, 0, 0, 1]，
    左上 3×3 可逆且不镜像。
    """
    if not isinstance(values, list | tuple) or len(values) != 16:
        raise InputRejected("transform 必须是 16 个数字（列主序 4×4）")
    if not all(isinstance(v, int | float) and not isinstance(v, bool) for v in values):
        raise InputRejected("transform 必须全是数字")
    arr = np.asarray(values, np.float64)
    if not np.all(np.isfinite(arr)):
        raise InputRejected("transform 含非有限值")
    matrix = arr.reshape(4, 4).T
    if not np.allclose(matrix[3], [0, 0, 0, 1], atol=1e-9):
        raise InputRejected("transform 的最后一行必须是 [0, 0, 0, 1]")
    det = float(np.linalg.det(matrix[:3, :3]))
    if not det > 1e-6:
        raise InputRejected("transform 必须可逆且不能镜像")
    if np.abs(matrix[:3, 3]).max() > 1e5:
        raise InputRejected("transform 的平移超出范围")
    return matrix


def _rigid(rot: np.ndarray, translation) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = rot
    m[:3, 3] = translation
    return m


def level_rotation(
    vertices: np.ndarray, faces: np.ndarray, max_tilt_deg: float = 10.0
) -> tuple[np.ndarray, float]:
    """把地面（朝上的面的平均法线）转到 +y 的旋转矩阵，以及原来的倾斜角（度）。"""
    normals, area = face_normals(vertices, faces)
    up = normals[:, 1] > COS_15
    if area[up].sum() <= 1e-9:
        return np.eye(3), 0.0
    n = (normals[up] * area[up, None]).sum(0)
    n /= np.linalg.norm(n)
    near = normals @ n > COS_5
    if area[near].sum() > 1e-9:
        n = (normals[near] * area[near, None]).sum(0)
        n /= np.linalg.norm(n)
    tilt = math.degrees(math.acos(min(1.0, max(-1.0, float(n[1])))))
    if tilt < 0.05 or tilt > max_tilt_deg:
        return np.eye(3), 0.0 if tilt < 0.05 else tilt
    # Rodrigues：把 n 转到 y
    y = np.array([0.0, 1.0, 0.0])
    axis = np.cross(n, y)
    s = np.linalg.norm(axis)
    c = float(n @ y)
    k = axis / s
    kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    rot = np.eye(3) + s * kx + (1 - c) * (kx @ kx)
    return rot, tilt


def floor_height(vertices: np.ndarray, faces: np.ndarray) -> float:
    """地面高度：低处朝上的面按 1 厘米做面积加权直方图取众数。"""
    normals, area = face_normals(vertices, faces)
    base = float(np.percentile(vertices[:, 1], 1))
    centers_y = vertices[faces].mean(axis=1)[:, 1]
    sel = (normals[:, 1] > 0.95) & (centers_y > base - 0.2) & (centers_y < base + 0.4)
    if area[sel].sum() < 0.05:
        return base
    hist, edges = np.histogram(centers_y[sel], bins=60, range=(base - 0.2, base + 0.4), weights=area[sel])
    hist = ndimage.uniform_filter1d(hist, 3)
    k = int(np.argmax(hist))
    lo, hi = edges[k] - 0.01, edges[k + 1] + 0.01
    band = sel & (centers_y >= lo) & (centers_y < hi)
    return float(np.average(centers_y[band], weights=area[band]))


def auto_align(mesh: ScanMesh) -> AlignResult:
    """首次扫描：摆正、墙对齐网格轴、地面 y = 0、原点在地面一角。"""
    vertices, faces = mesh.vertices, mesh.faces
    level, tilt = level_rotation(vertices, faces)
    leveled = vertices @ level.T
    theta = wall_rotation(leveled, faces)
    rot = rotation_y(theta) @ level
    rotated = vertices @ rot.T
    floor_y = floor_height(rotated, faces)
    x0 = float(np.percentile(rotated[:, 0], 0.05))
    z0 = float(np.percentile(rotated[:, 2], 0.05))
    matrix = _rigid(rot, [-x0, -floor_y, -z0])
    return AlignResult(matrix, "auto", rotation_deg=math.degrees(theta), tilt_deg=tilt)


# ---------------------------------------------------------------------------- 重扫配准


@dataclass
class StablePoints:
    points: np.ndarray  # (K, 3)
    normals: np.ndarray  # (K, 3)
    is_wall: np.ndarray  # (K,) bool
    floor_y: float


def stable_points(
    mesh: ScanMesh, *, density: float = 300.0, seed: int = 0, max_points: int = 150_000
) -> StablePoints:
    """地面和墙的上部（见模块说明）。mesh 已在空间坐标（或已摆正的坐标）里。"""
    P, _, N, _ = sample_surface(mesh, density, seed=seed)
    if len(P) == 0:
        raise InputRejected("扫描表面为空")
    floor_y = floor_height(mesh.vertices, mesh.faces)
    top = float(np.percentile(P[:, 1], 99))
    ceiling = max(floor_y + 1.4, floor_y + 0.92 * (top - floor_y))
    floor = (N[:, 1] > 0.95) & (np.abs(P[:, 1] - floor_y) < 0.05)
    wall = (np.abs(N[:, 1]) < 0.2) & (P[:, 1] > floor_y + 1.1) & (P[:, 1] < ceiling)
    rng = np.random.default_rng(seed + 1)
    wall_idx = np.nonzero(wall)[0]
    floor_idx = np.nonzero(floor)[0]
    n_floor = min(len(floor_idx), max(len(wall_idx), 2000))
    if len(floor_idx) > n_floor:
        floor_idx = rng.choice(floor_idx, n_floor, replace=False)
    idx = np.concatenate([wall_idx, floor_idx])
    if len(idx) > max_points:
        idx = rng.choice(idx, max_points, replace=False)
    idx.sort()
    return StablePoints(P[idx], N[idx], wall[idx], floor_y)


def _occupancy(xz: np.ndarray, lo: np.ndarray, shape: tuple[int, int], cell: float) -> np.ndarray:
    ij = np.floor((xz - lo) / cell).astype(np.int64)
    ok = (ij[:, 0] >= 0) & (ij[:, 0] < shape[0]) & (ij[:, 1] >= 0) & (ij[:, 1] < shape[1])
    img = np.zeros(shape)
    np.add.at(img, (ij[ok, 0], ij[ok, 1]), 1.0)
    img = (img >= 2).astype(np.float64)
    return ndimage.gaussian_filter(img, 1.0)


def _coarse_translation(ref: StablePoints, src_pts: np.ndarray, src_wall: np.ndarray, cell: float = 0.05):
    """俯视墙占用图的互相关：返回 (平移 x, 平移 z, 归一化得分)。"""
    rxz = ref.points[ref.is_wall][:, [0, 2]]
    sxz = src_pts[src_wall][:, [0, 2]]
    if len(rxz) < 50 or len(sxz) < 50:
        return 0.0, 0.0, 0.0
    rlo, slo = rxz.min(0) - 2 * cell, sxz.min(0) - 2 * cell
    rshape = tuple((np.ceil((rxz.max(0) + 2 * cell - rlo) / cell)).astype(int))
    sshape = tuple((np.ceil((sxz.max(0) + 2 * cell - slo) / cell)).astype(int))
    if max(rshape + sshape) > 4000:
        raise InputRejected("扫描范围过大，无法配准")
    R = _occupancy(rxz, rlo, rshape, cell)
    S = _occupancy(sxz, slo, sshape, cell)
    corr = fftconvolve(R, S[::-1, ::-1], mode="full")
    k = np.unravel_index(int(np.argmax(corr)), corr.shape)
    shift = (np.array(k) - (np.array(S.shape) - 1)) * cell  # S 的 (0,0) 落在 R 的 shift 处
    t = rlo + shift - slo
    score = float(corr[k] / math.sqrt(max((R * R).sum() * (S * S).sum(), 1e-12)))
    return float(t[0]), float(t[1]), score


def _icp(
    src: StablePoints, ref_tree: cKDTree, ref: StablePoints, init: np.ndarray, iters: int = 40
) -> np.ndarray:
    """点到面 ICP，只求偏航角和平移。返回 4×4（作用在空间坐标上）。"""
    T = init.copy()
    thresholds = np.geomspace(0.25, 0.04, iters)
    for thr in thresholds:
        R, t = T[:3, :3], T[:3, 3]
        p = src.points @ R.T + t
        ns = src.normals @ R.T
        d, idx = ref_tree.query(p, distance_upper_bound=float(thr))
        ok = np.isfinite(d)
        if ok.sum() < 30:
            continue
        ok_idx = np.nonzero(ok)[0]
        compat = (ref.normals[idx[ok_idx]] * ns[ok_idx]).sum(1) > 0.8
        ok_idx = ok_idx[compat]
        if len(ok_idx) < 30:
            continue
        q, n, pp = ref.points[idx[ok_idx]], ref.normals[idx[ok_idx]], p[ok_idx]
        r = ((pp - q) * n).sum(1)
        c = pp.mean(0)
        rel = pp - c
        J = np.column_stack([-n[:, 0] * rel[:, 2] + n[:, 2] * rel[:, 0], n])
        huber = 0.02
        w = np.where(np.abs(r) < huber, 1.0, huber / np.maximum(np.abs(r), 1e-12))
        A = J.T @ (J * w[:, None]) + np.eye(4) * 1e-6
        b = -J.T @ (w * r)
        delta = np.linalg.solve(A, b)
        dtheta = float(np.clip(delta[0], -0.1, 0.1))
        Rd = rotation_y(dtheta)
        new_R = Rd @ R
        new_t = Rd @ (t - c) + c + delta[1:]
        T = _rigid(new_R, new_t)
    return T


def registration_error(
    src: StablePoints, ref_tree: cKDTree, ref: StablePoints, T: np.ndarray
) -> tuple[float, float]:
    """(误差 厘米, 3 厘米内的比例)。

    点到面距离，10 厘米内没有法线一致的对应点按 10 厘米算，去掉最差的 20% 取平均。
    """
    cap = 0.10
    p = src.points @ T[:3, :3].T + T[:3, 3]
    ns = src.normals @ T[:3, :3].T
    d, idx = ref_tree.query(p, distance_upper_bound=cap)
    dist = np.full(len(p), cap)
    ok = np.nonzero(np.isfinite(d))[0]
    if len(ok):
        n = ref.normals[idx[ok]]
        compat = (n * ns[ok]).sum(1) > 0.7
        plane = np.abs(((p[ok] - ref.points[idx[ok]]) * n).sum(1))
        dist[ok[compat]] = np.minimum(plane[compat], cap)
    keep = np.sort(dist)[: max(1, int(len(dist) * 0.8))]
    return float(keep.mean() * 100), float((dist < 0.03).mean())


def register_rescan(mesh: ScanMesh, reference_space: ScanMesh, *, seed: int = 0) -> AlignResult:
    """把重扫 `mesh`（扫描坐标）配准到已在空间坐标里的参考扫描 `reference_space`。"""
    ref = stable_points(reference_space, seed=seed)
    if ref.is_wall.sum() < 50:
        raise InputRejected("参考扫描里找不到足够的墙面，无法配准")
    base = auto_align(mesh)
    # 墙的朝向转到和参考扫描一致（模 90°）
    phi_ref = wall_rotation(reference_space.vertices, reference_space.faces)
    base_matrix = _rigid(rotation_y(-phi_ref), [0, 0, 0]) @ base.matrix
    src0 = stable_points(mesh.transformed(base_matrix), seed=seed + 7)
    if src0.is_wall.sum() < 50:
        raise InputRejected("重扫里找不到足够的墙面，无法配准")
    tree = cKDTree(ref.points)
    best: tuple[float, float, np.ndarray] | None = None
    candidates = []
    for k in range(4):
        rot = rotation_y(k * math.pi / 2)
        pts = src0.points @ rot.T
        tx, tz, score = _coarse_translation(ref, pts, src0.is_wall)
        init = _rigid(rot, [tx, ref.floor_y - src0.floor_y, tz])
        T = _icp(src0, tree, ref, init)
        err, overlap = registration_error(src0, tree, ref, T)
        candidates.append(
            {
                "quarterTurns": k,
                "score": round(score, 4),
                "errorCm": round(err, 2),
                "overlap": round(overlap, 3),
            }
        )
        if best is None or err < best[0]:
            best = (err, overlap, T)
    assert best is not None
    err, overlap, T = best
    matrix = T @ base_matrix
    return AlignResult(matrix, "registered", error_cm=err, overlap=overlap, candidates=candidates)


def aligned_bounds(mesh: ScanMesh, matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    v = apply_matrix(mesh.vertices, matrix)
    return v.min(axis=0), v.max(axis=0)
