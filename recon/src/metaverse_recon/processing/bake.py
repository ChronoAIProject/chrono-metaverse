"""从扫描贴图烘焙平面贴图（验证见 `spikes/parametric/structure.py` 的 bake 和 `bake_util.py`）。

做法：对指定的三角面按面积密集重采样（默认每平方米 4 万点，约每纹素 4 个），每个采样点按重心坐标取扫描
贴图的颜色，再映射到目标图像的纹素上取平均；没有采样到的纹素用 push-pull 金字塔平滑补洞。
墙面可以改用 `fill_unobserved`：小洞推拉补，大片没扫到的地方用同一面墙已扫到部分沿墙分段的中位色。
"""

from __future__ import annotations

import itertools
from collections.abc import Callable
from functools import cached_property

import numpy as np
from scipy import ndimage

from .scan import ScanMesh, face_normals, texture_lookup


class FaceTable:
    """网格的逐面数据（面积、法线、中心），烘焙和筛选面时共用。"""

    def __init__(self, mesh: ScanMesh) -> None:
        self.mesh = mesh
        V, F = mesh.vertices, mesh.faces
        self.normals, self.area = face_normals(V, F)
        self.centers = (V[F[:, 0]] + V[F[:, 1]] + V[F[:, 2]]) / 3

    def faces_in_box(self, lo, hi, normal=None, cos_min: float | None = None) -> np.ndarray:
        lo, hi = np.asarray(lo, float), np.asarray(hi, float)
        m = np.all((self.centers >= lo) & (self.centers <= hi), axis=1)
        if normal is not None and cos_min is not None:
            m &= self.normals @ np.asarray(normal, float) > cos_min
        return np.nonzero(m)[0]

    @cached_property
    def radius(self) -> np.ndarray:
        """每个面的外包球半径（面中心到最远顶点的距离）。"""
        V, F = self.mesh.vertices, self.mesh.faces
        out = np.zeros(len(F))
        for k in range(3):
            out = np.maximum(out, np.linalg.norm(V[F[:, k]] - self.centers, axis=1))
        return out

    def faces_touching(self, lo, hi) -> np.ndarray:
        """外包球碰到盒子 [lo, hi] 的面（比只看面中心宽，大三角形的一部分落在盒子里也算），按编号排好。"""
        lo, hi = np.asarray(lo, float), np.asarray(hi, float)
        gap = np.maximum(lo - self.centers, 0.0) + np.maximum(self.centers - hi, 0.0)
        return np.nonzero(np.einsum("ij,ij->i", gap, gap) <= self.radius**2)[0]

    def dense(self, face_ids: np.ndarray, density: float, rng: np.random.Generator):
        """在给定的面上按面积密集采样：返回 (点, 颜色 uint8, 法线)。每个面至少一个点。"""
        face_ids = np.asarray(face_ids, np.int64)
        k = rng.poisson(self.area[face_ids] * density) + 1
        idx = np.repeat(face_ids, k)
        r1, r2 = rng.random(len(idx)), rng.random(len(idx))
        s = np.sqrt(r1)
        w0, w1, w2 = 1 - s, s * (1 - r2), s * r2
        f = self.mesh.faces[idx]
        V = self.mesh.vertices
        p = V[f[:, 0]] * w0[:, None] + V[f[:, 1]] * w1[:, None] + V[f[:, 2]] * w2[:, None]
        return p, texture_lookup(self.mesh, f, w0, w1, w2), self.normals[idx]


def push_pull(img: np.ndarray, w: np.ndarray) -> np.ndarray:
    """把权重为 0 的像素用由粗到细的加权金字塔填上（平滑补洞）。"""
    if w.min() > 0 or min(img.shape[:2]) <= 1:
        return img
    H, W = w.shape
    Hp, Wp = H + (H & 1), W + (W & 1)
    ip = np.zeros((Hp, Wp, img.shape[2]))
    ip[:H, :W] = img * w[..., None]
    wp = np.zeros((Hp, Wp))
    wp[:H, :W] = w
    sw = wp.reshape(Hp // 2, 2, Wp // 2, 2).sum((1, 3))
    si = ip.reshape(Hp // 2, 2, Wp // 2, 2, -1).sum((1, 3))
    coarse = si / np.maximum(sw, 1e-9)[..., None]
    coarse = push_pull(coarse, np.minimum(sw, 1.0))
    up = ndimage.zoom(coarse, (Hp / coarse.shape[0], Wp / coarse.shape[1], 1), order=1)[:H, :W]
    a = np.minimum(w, 1.0)[..., None]
    return img * a + up * (1 - a)


def band_medians(img: np.ndarray, observed: np.ndarray, band_px: int, min_texels: int = 20) -> np.ndarray:
    """沿图像横向每 band_px 列一段，取段内已扫到纹素的中位色，段间线性插值，返回每列的颜色（W×3）。

    已扫到的纹素太少的段不参与，全图都太少时退回全部已扫到纹素的中位色。"""
    W = observed.shape[1]
    edges = np.unique(np.linspace(0, W, max(1, round(W / max(band_px, 1))) + 1).astype(int))
    centers, meds = [], []
    for a, b in itertools.pairwise(edges):
        sel = observed[:, a:b]
        if sel.sum() >= max(min_texels, 0.05 * sel.size):
            centers.append(0.5 * (a + b))
            meds.append(np.median(img[:, a:b][sel], axis=0))
    if not meds:
        return np.broadcast_to(np.median(img[observed], axis=0), (W, img.shape[2])).astype(np.float64)
    cols = np.arange(W) + 0.5
    m = np.array(meds, np.float64)
    return np.stack([np.interp(cols, centers, m[:, c]) for c in range(img.shape[2])], -1)


def fill_unobserved(
    img: np.ndarray,
    observed: np.ndarray,
    *,
    near_px: float,
    far_px: float,
    band_px: int,
    default: float = 160.0,
) -> np.ndarray:
    """补没扫到的纹素（墙面用）。

    - 离已扫到区域 near_px 以内：推拉金字塔局部平滑补洞，和周围的纹理接得上；
    - far_px 以外：同一面墙已扫到部分沿墙分段的中位色（`band_medians`），木纹墙、白墙各补各的，
      不再像整图推拉那样把远处不相关的颜色（墙前的椅子、门框）拉过来；
    - 中间线性过渡。已扫到的纹素保持原值。

    "已扫到区域"按 5×5 窗口里至少四分之一的纹素有采样来算；零星的孤立采样保留自己的颜色，但不参与推拉，
    避免它们把颜色带进大片空洞。返回浮点 H×W×3。
    """
    img = np.asarray(img, np.float64)
    if not observed.any():
        return np.full(img.shape, default)
    covered = ndimage.uniform_filter(observed.astype(np.float64), 5) >= 0.25
    if not (covered & observed).any():
        covered = observed
    local = push_pull(img, (observed & covered).astype(np.float64))
    dist = ndimage.distance_transform_edt(~covered)
    flat = band_medians(img, observed, band_px)[None]
    w = np.clip((dist - near_px) / max(far_px - near_px, 1e-9), 0.0, 1.0)
    w[observed] = 0.0
    out = local * (1 - w[..., None]) + flat * w[..., None]
    out[observed] = img[observed]
    return out


def bake(
    table: FaceTable,
    face_ids: np.ndarray,
    to_texel: Callable[[np.ndarray], tuple[np.ndarray, np.ndarray]],
    size_px: tuple[int, int],
    *,
    keep: Callable[[np.ndarray, np.ndarray], np.ndarray] | None = None,
    density: float = 40_000.0,
    seed: int = 1,
    fill: bool = True,
    batch_faces: int = 20_000,
) -> tuple[np.ndarray, np.ndarray]:
    """密集采样给定的面，`to_texel(点) -> (列, 行)`（浮点，取整到纹素），每个纹素取平均颜色。

    `keep(点, 颜色) -> 布尔数组` 可以再筛掉一部分采样点。返回 (RGB uint8 H×W×3, 是否采样到 H×W)。
    """
    Wpx, Hpx = size_px
    rng = np.random.default_rng(seed)
    acc = np.zeros((Hpx * Wpx, 3))
    cnt = np.zeros(Hpx * Wpx)
    face_ids = np.asarray(face_ids, np.int64)
    if len(face_ids):
        for part in np.array_split(face_ids, max(1, len(face_ids) // batch_faces)):
            p, col, _ = table.dense(part, density, rng)
            if keep is not None:
                k = keep(p, col)
                p, col = p[k], col[k]
            cu, rv = to_texel(p)
            ci, ri = np.floor(cu).astype(np.int64), np.floor(rv).astype(np.int64)
            ok = (ci >= 0) & (ci < Wpx) & (ri >= 0) & (ri < Hpx)
            lin = ri[ok] * Wpx + ci[ok]
            cnt += np.bincount(lin, minlength=Hpx * Wpx)
            for c in range(3):
                acc[:, c] += np.bincount(lin, weights=col[ok, c].astype(np.float64), minlength=Hpx * Wpx)
    cnt = cnt.reshape(Hpx, Wpx)
    acc = acc.reshape(Hpx, Wpx, 3)
    observed = cnt > 0
    img = acc / np.maximum(cnt, 1)[..., None]
    if fill:
        if observed.any():
            img = push_pull(img, observed.astype(np.float64))
        else:
            img[:] = 160.0
    return np.clip(np.round(img), 0, 255).astype(np.uint8), observed


def ortho_bake(
    table: FaceTable,
    face_ids: np.ndarray,
    origin,
    u_vec,
    v_vec,
    size_px: tuple[int, int],
    *,
    px: float = 0.01,
    depth_vec=None,
    visible_tol: float | None = None,
    density: float = 40_000.0,
    seed: int = 1,
) -> tuple[np.ndarray, np.ndarray]:
    """正交投影：纹素 (列, 行) = ((p − origin)·u, (p − origin)·v) / px。

    给出 `depth_vec` 和 `visible_tol` 时，每个纹素只保留离观察者最近（p·depth 最大）的 visible_tol 以内的
    采样点，相当于拍一张"可见表面"的照片。
    """
    Wpx, Hpx = size_px
    rng = np.random.default_rng(seed)
    p, col, _ = table.dense(face_ids, density, rng)
    d = p - np.asarray(origin, float)
    ci = np.floor(d @ np.asarray(u_vec, float) / px).astype(np.int64)
    ri = np.floor(d @ np.asarray(v_vec, float) / px).astype(np.int64)
    ok = (ci >= 0) & (ci < Wpx) & (ri >= 0) & (ri < Hpx)
    lin = ri[ok] * Wpx + ci[ok]
    colf = col[ok].astype(np.float64)
    if depth_vec is not None and visible_tol is not None:
        dep = p[ok] @ np.asarray(depth_vec, float)
        dmax = np.full(Hpx * Wpx, -np.inf)
        np.maximum.at(dmax, lin, dep)
        vis = dep >= dmax[lin] - visible_tol
        lin, colf = lin[vis], colf[vis]
    cnt = np.bincount(lin, minlength=Hpx * Wpx).astype(np.float64).reshape(Hpx, Wpx)
    acc = np.stack([np.bincount(lin, weights=colf[:, c], minlength=Hpx * Wpx) for c in range(3)], -1)
    acc = acc.reshape(Hpx, Wpx, 3)
    observed = cnt > 0
    img = acc / np.maximum(cnt, 1)[..., None]
    if observed.any():
        img = push_pull(img, observed.astype(np.float64))
    return np.clip(np.round(img), 0, 255).astype(np.uint8), observed
