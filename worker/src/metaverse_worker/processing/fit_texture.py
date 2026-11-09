"""上色、贴图转移和拟合偏差（设计 6.3 第 5、6 步）。

- **部件归属**：模型每个叶子形状（部件）的网格密集采样，扫描点归最近的部件；
- **纯色还是贴图**：部件附近扫描点的亮度标准差小（颜色单一）就用纯色（中位数）；否则烘焙贴图；
- **贴图转移**：部件按网站同样的投影（`planar` 沿最薄的轴、`cylindrical` 绕竖直中轴）展开 UV，
  每个纹素落到模型表面的一点，取原扫描最近表面（法线朝向相容）的颜色；正反两面落在同一纹素时，
  扫描里看得更多的那一面优先；没采到的纹素用 push-pull 补；JPEG 编码，内容哈希作资源编号；
- **偏差**：扫描点到模型表面的精确距离（候选三角形用 KD 树找，再逐个求最近点）。
"""

from __future__ import annotations

import hashlib
import io
import math
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

from .. import shapes as sh
from .bake import push_pull
from .shape_mesh import Mesh, Part, build_parts, merge_meshes, primitive_mesh

PLACEHOLDER = "f" * 64


# ---------------------------------------------------------------------------- 距离


def _closest_point_on_triangles(tri: np.ndarray, p: np.ndarray) -> np.ndarray:
    """逐对求点到三角形的最近点（Ericson《Real-Time Collision Detection》5.1.5）。"""
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    ab, ac, ap = b - a, c - a, p - a
    d1 = (ab * ap).sum(1)
    d2 = (ac * ap).sum(1)
    bp = p - b
    d3 = (ab * bp).sum(1)
    d4 = (ac * bp).sum(1)
    cp = p - c
    d5 = (ab * cp).sum(1)
    d6 = (ac * cp).sum(1)
    va = d3 * d6 - d5 * d4
    vb = d5 * d2 - d1 * d6
    vc = d1 * d4 - d3 * d2
    denom = va + vb + vc
    denom = np.where(np.abs(denom) < 1e-30, 1e-30, denom)
    v = vb / denom
    w = vc / denom
    out = a + ab * v[:, None] + ac * w[:, None]
    with np.errstate(divide="ignore", invalid="ignore"):
        # 边 BC
        m = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0)
        t = np.where(m, (d4 - d3) / ((d4 - d3) + (d5 - d6) + 1e-30), 0)
        out = np.where(m[:, None], b + (c - b) * t[:, None], out)
        # 边 AC
        m = (vb <= 0) & (d2 >= 0) & (d6 <= 0)
        t = np.where(m, d2 / (d2 - d6 + 1e-30), 0)
        out = np.where(m[:, None], a + ac * t[:, None], out)
        # 边 AB
        m = (vc <= 0) & (d1 >= 0) & (d3 <= 0)
        t = np.where(m, d1 / (d1 - d3 + 1e-30), 0)
        out = np.where(m[:, None], a + ab * t[:, None], out)
    # 顶点区域
    out = np.where(((d6 >= 0) & (d5 <= d6))[:, None], c, out)
    out = np.where(((d3 >= 0) & (d4 <= d3))[:, None], b, out)
    out = np.where(((d1 <= 0) & (d2 <= 0))[:, None], a, out)
    return out


@dataclass
class SurfaceIndex:
    """模型表面的近邻查询：密集采样点（带三角形编号和部件编号）的 KD 树。"""

    tri: np.ndarray  # (T, 3, 3)
    tri_part: np.ndarray  # (T,)
    samples: np.ndarray
    sample_tri: np.ndarray
    tree: cKDTree

    @classmethod
    def build(cls, meshes: list[Mesh], spacing: float = 0.006, seed: int = 0) -> SurfaceIndex:
        tris, parts = [], []
        for k, m in enumerate(meshes):
            if len(m.indices):
                t = m.triangles()
                tris.append(t)
                parts.append(np.full(len(t), k))
        if not tris:
            raise ValueError("模型没有三角形")
        tri = np.concatenate(tris)
        tri_part = np.concatenate(parts)
        area = np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1) / 2
        rng = np.random.default_rng(seed)
        cnt = np.minimum(rng.poisson(area / spacing**2), 20000)
        idx = np.repeat(np.arange(len(tri)), cnt)
        r1, r2 = rng.random(len(idx)), rng.random(len(idx))
        s = np.sqrt(r1)
        w = np.c_[1 - s, s * (1 - r2), s * r2]
        pts = np.einsum("ni,nij->nj", w, tri[idx])
        pts = np.concatenate([pts, tri.mean(1)])
        idx = np.concatenate([idx, np.arange(len(tri))])
        return cls(tri, tri_part, pts, idx, cKDTree(pts))

    def query(self, P: np.ndarray, k: int = 6) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """返回 (精确距离, 最近点, 所在三角形)。"""
        k = min(k, len(self.samples))
        _, nn = self.tree.query(P, k=k)
        nn = nn.reshape(len(P), -1)
        best_d = np.full(len(P), np.inf)
        best_p = np.zeros_like(P)
        best_t = np.zeros(len(P), np.int64)
        for j in range(nn.shape[1]):
            t = self.sample_tri[nn[:, j]]
            cp = _closest_point_on_triangles(self.tri[t], P)
            d = np.linalg.norm(cp - P, axis=1)
            better = d < best_d
            best_d[better] = d[better]
            best_p[better] = cp[better]
            best_t[better] = t[better]
        return best_d, best_p, best_t


def fit_stats(d: np.ndarray) -> dict[str, float]:
    if len(d) == 0:
        return {"meanCm": 0.0, "p90Cm": 0.0, "coverage3cm": 0.0}
    cm = d * 100
    return {
        "meanCm": round(float(cm.mean()), 2),
        "p90Cm": round(float(np.percentile(cm, 90)), 2),
        "coverage3cm": round(float((cm <= 3).mean()), 3),
    }


# ---------------------------------------------------------------------------- 部件


def strip_parts(shape: dict[str, Any], path: str = "$", out: dict[str, dict[str, Any]] | None = None):
    """取出叶子形状上的临时字段 `_part`，返回 {JSON 路径: 部件信息}。"""
    out = {} if out is None else out
    info = shape.pop("_part", None)
    if info is not None:
        out[path] = info
    for i, child in enumerate(shape.get("children") or []):
        strip_parts(child, f"{path}.children[{i}]", out)
    return out


def leaf_at(shape: dict[str, Any], path: str) -> dict[str, Any]:
    node = shape
    rest = path[1:]
    while rest:
        assert rest.startswith(".children[")
        end = rest.index("]")
        node = node["children"][int(rest[len(".children[") : end])]
        rest = rest[end + 1 :]
    return node


def luminance(C: np.ndarray) -> np.ndarray:
    c = C.astype(np.float64)
    return 0.299 * c[:, 0] + 0.587 * c[:, 1] + 0.114 * c[:, 2]


@dataclass
class ColorSource:
    """取色用的扫描：密集采样点（同一坐标系）+ 颜色 + 法线。"""

    P: np.ndarray
    C: np.ndarray
    N: np.ndarray
    tree: cKDTree | None = None

    def __post_init__(self) -> None:
        if self.tree is None and len(self.P):
            self.tree = cKDTree(self.P)

    def colors_at(
        self, X: np.ndarray, normals: np.ndarray, max_dist: float = 0.08
    ) -> tuple[np.ndarray, np.ndarray]:
        """每个点取最近（法线相容优先）的扫描颜色；返回 (颜色 float, 是否采到)。"""
        if self.tree is None or len(X) == 0:
            return np.zeros((len(X), 3)), np.zeros(len(X), bool)
        k = min(8, len(self.P))
        d, nn = self.tree.query(X, k=k)
        d = d.reshape(len(X), -1)
        nn = nn.reshape(len(X), -1)
        compat = (self.N[nn] * normals[:, None, :]).sum(-1) > 0.2
        score = np.where(compat, d, d + 0.03)
        j = np.argmin(score, axis=1)
        pick = nn[np.arange(len(X)), j]
        dist = d[np.arange(len(X)), j]
        return self.C[pick].astype(np.float64), dist < max_dist


def _rasterize(mesh: Mesh, W: int, H: int, priority: np.ndarray):
    """把三角形按 UV 画到 W×H 的图上：返回每个纹素对应的 3D 点、法线、是否覆盖。
    v 向上（图片第 0 行 = v 最大）；同一纹素被多个三角形覆盖时，priority 大的赢。"""
    pos = np.zeros((H, W, 3))
    nrm = np.zeros((H, W, 3))
    best = np.full((H, W), -np.inf)
    tri_p = mesh.positions[mesh.indices]
    tri_uv = mesh.uvs[mesh.indices]
    fn = np.cross(tri_p[:, 1] - tri_p[:, 0], tri_p[:, 2] - tri_p[:, 0])
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    for t in np.argsort(priority, kind="stable"):
        uv = tri_uv[t]
        px = np.c_[uv[:, 0] * W - 0.5, (1 - uv[:, 1]) * H - 0.5]
        x0, x1 = int(max(0, math.floor(px[:, 0].min()))), int(min(W - 1, math.ceil(px[:, 0].max())))
        y0, y1 = int(max(0, math.floor(px[:, 1].min()))), int(min(H - 1, math.ceil(px[:, 1].max())))
        if x1 < x0 or y1 < y0:
            continue
        gy, gx = np.mgrid[y0 : y1 + 1, x0 : x1 + 1]
        a, b, c = px
        den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(den) < 1e-12:
            continue
        w0 = ((b[1] - c[1]) * (gx - c[0]) + (c[0] - b[0]) * (gy - c[1])) / den
        w1 = ((c[1] - a[1]) * (gx - c[0]) + (a[0] - c[0]) * (gy - c[1])) / den
        w2 = 1 - w0 - w1
        eps = -0.6 / max(1.0, abs(den)) ** 0.5
        inside = (w0 >= eps) & (w1 >= eps) & (w2 >= eps)
        if not inside.any():
            continue
        ww = np.clip(np.stack([w0, w1, w2], -1), 0, None)
        ww /= np.maximum(ww.sum(-1, keepdims=True), 1e-12)
        p3 = ww @ tri_p[t]
        yy, xx = gy[inside], gx[inside]
        upd = priority[t] >= best[yy, xx]
        yy, xx = yy[upd], xx[upd]
        pos[yy, xx] = p3[inside][upd]
        nrm[yy, xx] = fn[t]
        best[yy, xx] = priority[t]
    return pos, nrm, np.isfinite(best)


def encode_jpeg(rgb: np.ndarray, quality: int) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


@dataclass(frozen=True)
class TextureParams:
    texel_small: float = 0.004  # 1 米以下的物体 4 毫米/纹素
    texel_large: float = 0.01  # 3 米以上 1 厘米/纹素
    max_px: int = 512
    max_px_large: int = 1024
    jpeg_quality: int = 82
    lum_std_texture: float = 16.0  # 亮度标准差超过这个就烘焙贴图
    min_texture_area: float = 0.03  # 部件表面积小于这个只用纯色
    assign_dist: float = 0.05


def finalize_materials(
    shape: dict[str, Any],
    scan_P: np.ndarray,
    scan_C: np.ndarray,
    scan_N: np.ndarray,
    color_src: ColorSource,
    tp: TextureParams,
    size_hint: float,
    textures: dict[str, bytes],
    *,
    allow_textures: bool = True,
) -> dict[str, Any]:
    """给形状的每个部件上色或烘焙贴图。shape 与扫描点在同一坐标系；返回统计。"""
    parts_info = strip_parts(shape)
    parts = build_parts(shape)
    by_path: dict[str, list[Part]] = {}
    for p in parts:
        by_path.setdefault(p.path, []).append(p)
    paths = sorted(by_path)
    meshes = [merge_meshes([p.mesh for p in by_path[q]]) for q in paths]
    stats: dict[str, Any] = {"parts": len(paths), "textured": 0}
    if not paths:
        return stats
    index = SurfaceIndex.build(meshes, spacing=0.008)
    d, _, t = index.query(scan_P, k=4)
    owner = index.tri_part[t]
    texel = float(np.interp(size_hint, [1.0, 3.0], [tp.texel_small, tp.texel_large]))
    max_px = tp.max_px_large if size_hint > 1.5 else tp.max_px
    for k, path in enumerate(paths):
        leaf = leaf_at(shape, path)
        info = parts_info.get(path, {"uv": "planar"})
        m = (owner == k) & (d < tp.assign_dist)
        cols = scan_C[m]
        if len(cols) == 0:
            near = np.argsort(d)[: max(1, min(50, len(d)))]
            cols = scan_C[near]
        med = np.median(cols.astype(float), axis=0)
        lum_std = float(np.std(luminance(cols))) if len(cols) > 5 else 0.0
        area = meshes[k].area()
        want = (
            allow_textures and lum_std > tp.lum_std_texture and area >= tp.min_texture_area and m.sum() >= 150
        )
        if not want:
            leaf["material"] = sh.color_material(med)
            continue
        uv = info.get("uv", "planar")
        leaf["material"] = {"texture": PLACEHOLDER, "uv": uv}
        part_mesh = merge_meshes([p.mesh for p in build_parts(shape) if p.path == path])
        local = primitive_mesh({k2: v for k2, v in leaf.items() if k2 not in ("transform", "material")})
        if local is None or len(local.positions) == 0 or len(part_mesh.indices) == 0:
            leaf["material"] = sh.color_material(med)
            continue
        ext = local.positions.max(0) - local.positions.min(0)
        if uv == "cylindrical":
            eu = math.pi * float(max(ext[0], ext[2]) + min(ext[0], ext[2])) / 2 * 1.2
            ev = float(ext[1])
        else:
            dims = sorted([(float(e), a) for a, e in enumerate(ext)])
            thin = dims[0][1]
            if thin == 0:
                eu, ev = ext[2], ext[1]
            elif thin == 1:
                eu, ev = ext[0], ext[2]
            else:
                eu, ev = ext[0], ext[1]
        W = int(np.clip(math.ceil(eu / texel), 16, max_px))
        H = int(np.clip(math.ceil(ev / texel), 16, max_px))
        # 正反面优先级：扫描里看到更多的那一面（法线方向的统计）
        tri_n = np.cross(
            part_mesh.positions[part_mesh.indices[:, 1]] - part_mesh.positions[part_mesh.indices[:, 0]],
            part_mesh.positions[part_mesh.indices[:, 2]] - part_mesh.positions[part_mesh.indices[:, 0]],
        )
        tri_n /= np.maximum(np.linalg.norm(tri_n, axis=1, keepdims=True), 1e-12)
        tri_c = part_mesh.positions[part_mesh.indices].mean(1)
        if uv == "cylindrical":
            ctr = (part_mesh.positions.min(0) + part_mesh.positions.max(0)) / 2
            radial = tri_c - ctr
            radial[:, 1] = 0
            radial /= np.maximum(np.linalg.norm(radial, axis=1, keepdims=True), 1e-9)
            priority = (tri_n * radial).sum(1)
        else:
            sn = scan_N[m] if m.any() else scan_N
            pref = sn.mean(0)
            pref /= max(np.linalg.norm(pref), 1e-9)
            priority = tri_n @ pref
        pos, nrm, covered = _rasterize(part_mesh, W, H, priority)
        img = np.zeros((H, W, 3))
        flat = covered.ravel()
        cols_t, ok = color_src.colors_at(pos.reshape(-1, 3)[flat], nrm.reshape(-1, 3)[flat])
        weight = np.zeros(H * W)
        acc = img.reshape(-1, 3)
        acc[np.nonzero(flat)[0][ok]] = cols_t[ok]
        weight[np.nonzero(flat)[0][ok]] = 1.0
        if weight.sum() < 16:
            leaf["material"] = sh.color_material(med)
            continue
        filled = push_pull(acc.reshape(H, W, 3), weight.reshape(H, W))
        rgb = np.clip(np.round(filled), 0, 255).astype(np.uint8)
        data = encode_jpeg(rgb, tp.jpeg_quality)
        digest = hashlib.sha256(data).hexdigest()
        textures[digest] = data
        leaf["material"] = sh.texture_material(digest, uv)
        stats["textured"] += 1
    return stats
