"""place：把模型库里的候选摆到扫描里的某个物体上，输出外部模型物件记录和"扫描 | 候选"对比图。

1. **向上轴**：6 种（+y 是 glTF 的约定，另外 ±z、±x、−y）都试，每种用 `pitch` / `roll` 的 90° 倍数摆正；
   最后按偏差选，非 +y 的要明显更好（代价低 15% 以上）才选；
2. **缩放**：量扫描的高度（局部地面到顶）和水平最小外接矩形的长、短边，和模型摆正后的同样三个尺寸比：
   默认等比（高度权重 2，长短边各 1 的对数平均）；`--scale axis` 再逐轴微调、限在等比的 ±15% 以内；
   `--scale none` 保持原尺寸（Poly Haven 这类真实尺寸的模型可以试）；
3. **朝向**：偏航粗搜（默认每 15°，再加按外接矩形对齐的 4 个角度），每个角度把水平中心对上、底落到地面，
   然后做只求偏航和水平平移的迭代最近点（对应点阈值从 15 厘米收到 4 厘米，双向、去掉最差的 30%）；
4. **落地**：模型最低点放到物体下面的局部地面高度；
5. **代价**：扫描→模型的平均距离 + 0.5 × 模型→扫描（去掉最差 20%，背面、底面没扫到不算）的平均距离，都截到 10
厘米。

输出目录：`entity.json`（外部模型物件记录，AI 物件集的 (b) 格式）、`place.json`（每种向上轴的结果、偏差、
tint 建议、提示）、`place.jpg`（扫描 | 候选，3 个角度）、`place_error.jpg`（偏差上色）。
"""

from __future__ import annotations

import math
import os
import time

import numpy as np
from scipy.spatial import cKDTree

from ...processing import shape_mesh as sm_
from ...processing.fit_texture import SurfaceIndex
from .. import core as wc
from .. import models as md
from ..base import Base, from_args, resolve_box
from ..compare import (
    ModelSet,
    add_footer,
    base_modelset,
    error_map,
    evaluate,
    parse_angles,
    render_models,
    render_sheet,
    structure_parts,
    summary_line,
)
from ..core import r
from ..i18n import t
from ..measure import min_rect
from ..render import available as render_available
from ..views import prepare_scan
from .fetch import fetch_one
from .search import load_candidate

UP_OPTIONS = {"+y": (0, 0), "+z": (-90, 0), "-z": (90, 0), "+x": (0, 90), "-x": (0, -90), "-y": (180, 0)}
CAP = 0.10


def up_rotation(up: str) -> np.ndarray:
    pitch, roll = UP_OPTIONS[up]
    return md.transform_matrix({"pitch": pitch, "roll": roll})[:3, :3]


def ry(deg: float) -> np.ndarray:
    return md.transform_matrix({"yaw": deg})[:3, :3]


def surface_samples(V: np.ndarray, F: np.ndarray, n: int, seed: int = 0) -> np.ndarray:
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
    if area.sum() <= 0:
        return V[:n]
    rng = np.random.default_rng(seed)
    idx = rng.choice(len(F), size=n, p=area / area.sum())
    r1, r2 = rng.random(n), rng.random(n)
    s = np.sqrt(r1)
    return a[idx] * (1 - s)[:, None] + b[idx] * (s * (1 - r2))[:, None] + c[idx] * (s * r2)[:, None]


def subsample(P: np.ndarray, n: int, seed: int = 0) -> np.ndarray:
    if len(P) <= n:
        return P
    return P[np.random.default_rng(seed).choice(len(P), n, replace=False)]


def footprint(P: np.ndarray) -> dict:
    rect = min_rect(P[:, [0, 2]], robust=True) or {
        "center": list(P[:, [0, 2]].mean(0)),
        "size": [0.1, 0.1],
        "yaw": 0,
    }
    return rect


def kabsch_yaw(src: np.ndarray, dst: np.ndarray, w: np.ndarray | None = None) -> tuple[float, np.ndarray]:
    """xz 平面上把 src 对到 dst 的旋转（按 SHAPES 偏航，度）和平移：dst ≈ Ry(θ)·src + t（只看 x、z）。"""
    w = np.ones(len(src)) if w is None else w
    ws = w.sum()
    a = src[:, [0, 2]]
    b = dst[:, [0, 2]]
    ca, cb = (a * w[:, None]).sum(0) / ws, (b * w[:, None]).sum(0) / ws
    A, B = a - ca, b - cb
    # Ry(θ) 在 (x, z) 上是 [[c, s], [-s, c]]：x' = c x + s z，z' = −s x + c z
    num = (w * (A[:, 1] * B[:, 0] - A[:, 0] * B[:, 1])).sum()
    den = (w * (A[:, 0] * B[:, 0] + A[:, 1] * B[:, 1])).sum()
    theta = math.atan2(num, den)
    c, s = math.cos(theta), math.sin(theta)
    rot = np.array([[c, s], [-s, c]])
    t2 = cb - rot @ ca
    return math.degrees(theta), np.array([t2[0], 0.0, t2[1]])


class TopMap:
    """俯视的顶面高度图（每格最高点）。扫描从上面看得最全，顶面高度最能分清朝向：沙发的靠背在哪一边、
    是不是倒过来了。"""

    def __init__(self, S: np.ndarray, cell: float = 0.04) -> None:
        self.cell = cell
        self.x0, self.z0 = float(S[:, 0].min()), float(S[:, 2].min())
        self.nx = int(np.ceil(np.ptp(S[:, 0]) / cell)) + 1
        self.nz = int(np.ceil(np.ptp(S[:, 2]) / cell)) + 1
        self.H = self.top(S)
        self.has = np.isfinite(self.H)

    def top(self, P: np.ndarray) -> np.ndarray:
        ix = np.floor((P[:, 0] - self.x0) / self.cell).astype(int)
        iz = np.floor((P[:, 2] - self.z0) / self.cell).astype(int)
        ok = (ix >= 0) & (ix < self.nx) & (iz >= 0) & (iz < self.nz)
        H = np.full((self.nz, self.nx), -np.inf)
        np.maximum.at(H, (iz[ok], ix[ok]), P[ok, 1])
        return H

    def cost(self, M: np.ndarray) -> float:
        """有扫描的格子：高度差（截到 15 厘米），模型没盖到算 15 厘米；模型多出来的格子（包括伸出扫描范围的）
        每格算 5 厘米。按有扫描的格子数平均。"""
        Hm = self.top(M)
        hm = np.isfinite(Hm)
        both = self.has & hm
        d = np.minimum(np.abs(self.H[both] - Hm[both]), 0.15).sum()
        miss = (self.has & ~hm).sum() * 0.15
        ix = np.floor((M[:, 0] - self.x0) / self.cell).astype(np.int64)
        iz = np.floor((M[:, 2] - self.z0) / self.cell).astype(np.int64)
        cells = len(np.unique(ix * 1_000_003 + iz))
        extra = (cells - int(both.sum())) * 0.05
        return float((d + miss + extra) / max(int(self.has.sum()), 1))


def cost(
    S: np.ndarray, M: np.ndarray, tree_s: cKDTree, top: TopMap | None = None
) -> tuple[float, float, float]:
    """代价 = 扫描→模型 + 0.5 × 模型→扫描（去掉最差 20%）+ 0.5 × 顶面高度图的差（给了 top 时）；
    距离都截到 10 厘米。"""
    d1, _ = cKDTree(M).query(S, k=1)
    d2, _ = tree_s.query(M, k=1)
    d1 = np.minimum(d1, CAP)
    d2 = np.sort(np.minimum(d2, CAP))[: max(1, int(len(d2) * 0.8))]
    total = float(d1.mean() + 0.5 * d2.mean()) + (0.5 * top.cost(M) if top is not None else 0.0)
    return total, float(d1.mean()), float(d2.mean())


def icp_yaw(
    S: np.ndarray,
    tree_s: cKDTree,
    M0: np.ndarray,
    yaw: float,
    t: np.ndarray,
    iters: int,
    thr0: float = 0.15,
    thr1: float = 0.04,
    fix_yaw: bool = False,
) -> tuple[float, np.ndarray]:
    """只求偏航和水平平移：M = Ry(yaw)·M0 + t。双向最近点，去掉最差的 30%。`fix_yaw` 时只求平移。"""
    for k in range(iters):
        thr = thr0 + (thr1 - thr0) * (k / max(iters - 1, 1))
        M = M0 @ ry(yaw).T + t
        tree_m = cKDTree(M)
        d1, j1 = tree_m.query(S, k=1)
        d2, j2 = tree_s.query(M, k=1)
        k1 = d1 < max(thr, np.percentile(d1, 70))
        k2 = d2 < max(thr, np.percentile(d2, 70))
        k1 &= d1 < thr * 2
        k2 &= d2 < thr * 2
        if k1.sum() + k2.sum() < 10:
            break
        src = np.vstack([M[j1[k1]], M[k2]])
        dst = np.vstack([S[k1], S[j2[k2]]])
        if fix_yaw:
            dyaw, dt = 0.0, (dst - src).mean(0) * np.array([1.0, 0.0, 1.0])
        else:
            dyaw, dt = kabsch_yaw(src, dst)
        # 新的 M' = Ry(dyaw)·(Ry(yaw)·M0 + t) + dt
        t = ry(dyaw) @ t + dt
        t[1] = 0.0
        yaw = yaw + dyaw
        if abs(dyaw) < 0.02 and np.linalg.norm(dt) < 1e-4:
            break
    return yaw, t


def angle_diff(a: float, b: float) -> float:
    return (a - b + 180) % 360 - 180


def snap_yaw(
    best: dict, S: np.ndarray, tree_s: cKDTree, Ms: np.ndarray, sm: dict, tol: float = 10.0
) -> dict | None:
    """家具多半和房间的墙、或者扫描物体自己的外接矩形对齐：偏航离这些方向不到 tol 度时，试着落到这个方向上
    （只再求平移）。代价不比自由偏航差 3% 以上就采用。返回采用的结果或 None。"""
    world_dirs = [k * 90.0 for k in range(4)] + [sm["rect"]["yaw"] + k * 90.0 for k in range(4)]
    principal = best["yaw"] + best["modelRectYaw"]
    target = min(world_dirs, key=lambda d: abs(angle_diff(principal, d)))
    delta = angle_diff(target, principal)
    if abs(delta) > tol or abs(delta) < 0.05:
        return None
    M0 = subsample(Ms @ best["Ru"].T * best["scale"], 6000, 4)
    yaw = best["yaw"] + delta
    _, t = icp_yaw(S, tree_s, M0, yaw, best["t"].copy(), 15, 0.08, 0.03, fix_yaw=True)
    t[1] = best["t"][1]
    c = cost(S, M0 @ ry(yaw).T + t, tree_s, TopMap(S))
    if c[0] <= best["cost"] * 1.03 + 0.002:
        return {
            **best,
            "cost": c[0],
            "scanToModel": c[1],
            "modelToScan": c[2],
            "yaw": yaw,
            "t": t,
            "snappedFrom": round(float(best["yaw"]), 2),
        }
    return None


def center_extents(
    best: dict, S: np.ndarray, tree_s: cKDTree, Ms: np.ndarray, frame_scale: np.ndarray
) -> dict:
    """在模型的偏航坐标系里把模型和扫描的水平范围（2%–98%）中心对齐，代价不比迭代最近点差 5% 以上就用它：
    模型和扫描外形差得多时，迭代最近点容易整体滑开，按范围居中更稳。"""
    R = ry(best["yaw"])
    M = (Ms @ best["Ru"].T * frame_scale) @ R.T + best["t"]
    ls = (S - best["t"]) @ R
    lm = (M - best["t"]) @ R
    shift = np.zeros(3)
    for k in (0, 2):
        a = np.percentile(ls[:, k], [2, 98]).mean()
        b = np.percentile(lm[:, k], [2, 98]).mean()
        shift[k] = a - b
    t2 = best["t"] + R @ shift
    sub = subsample(Ms @ best["Ru"].T * frame_scale, 6000, 4)
    top = TopMap(S)
    c_icp = cost(S, sub @ R.T + best["t"], tree_s, top)
    c_ctr = cost(S, sub @ R.T + t2, tree_s, top)
    if c_ctr[0] <= c_icp[0] * 1.05:
        return {
            **best,
            "t": t2,
            "cost": c_ctr[0],
            "scanToModel": c_ctr[1],
            "modelToScan": c_ctr[2],
            "centered": [round(float(v), 4) for v in R @ shift],
        }
    return best


def scan_measure(P: np.ndarray, floor_y: float) -> dict:
    fp = footprint(P)
    top = float(np.percentile(P[:, 1], 99.5))
    return {"floor": floor_y, "top": top, "height": top - floor_y, "rect": fp}


def model_measure(Vu: np.ndarray) -> dict:
    fp = footprint(Vu)
    lo, hi = Vu[:, 1].min(), Vu[:, 1].max()
    return {"height": float(hi - lo), "rect": fp, "bottom": float(lo)}


def uniform_scale(sm: dict, mm: dict) -> float:
    ratios = [(sm["height"] / max(mm["height"], 1e-9), 2.0)]
    for i in (0, 1):
        ratios.append((sm["rect"]["size"][i] / max(mm["rect"]["size"][i], 1e-9), 1.0))
    lw = sum(w * math.log(max(v, 1e-9)) for v, w in ratios) / sum(w for _, w in ratios)
    return math.exp(lw)


def place_up(
    up: str,
    S: np.ndarray,
    tree_s: cKDTree,
    Ms: np.ndarray,
    sm: dict,
    scale_mode: str,
    yaws: list[float],
    fixed_scale: float | None = None,
    yaw_window: tuple[float, float] | None = None,
) -> dict:
    """一种向上轴：缩放 → 偏航粗搜 + 细化。返回最好的结果。`yaw_window = (中心, 半宽)` 时只试这个范围。"""
    Ru = up_rotation(up)
    Vu = Ms @ Ru.T
    mm = model_measure(Vu)
    s = 1.0 if scale_mode == "none" else (fixed_scale or uniform_scale(sm, mm))
    M0 = Vu * s
    c_s = np.array([sm["rect"]["center"][0], 0, sm["rect"]["center"][1]])
    bottom = M0[:, 1].min()
    # 粗搜的角度 + 按水平外接矩形对齐的 4 个角度
    base_yaw = sm["rect"]["yaw"] - mm["rect"]["yaw"]
    seeds = [*yaws, *(base_yaw + k * 90 for k in range(4))]
    if yaw_window is not None:  # 给了 --yaw：只试这个范围里的角度
        center, half = yaw_window
        seeds = [y for y in seeds if abs(((y - center + 180) % 360) - 180) <= half]
    top = TopMap(S)
    S_c = subsample(S, 1500, 1)
    tree_c = cKDTree(S_c)
    M_c = subsample(M0, 1500, 2)
    results = []
    for y0 in seeds:
        R = ry(y0)
        Mr = M_c @ R.T
        fc = footprint(Mr)
        tt = c_s - np.array([fc["center"][0], 0, fc["center"][1]])
        tt[1] = sm["floor"] - bottom
        # 初始摆法也算一个候选：模型和扫描差得多时迭代最近点会滑走，只在代价变低时采用
        results.append((cost(S_c, M_c @ R.T + tt, tree_c, top)[0], y0, tt.copy()))
        yaw, tvec = icp_yaw(S_c, tree_c, M_c, y0, tt, 6)
        tvec[1] = sm["floor"] - bottom
        cst = cost(S_c, M_c @ ry(yaw).T + tvec, tree_c, top)
        results.append((cst[0], yaw, tvec))
    results.sort(key=lambda x: x[0])
    best = None
    S_f = subsample(S, 6000, 3)
    tree_f = cKDTree(S_f)
    M_f = subsample(M0, 6000, 4)
    for _, yaw0, t0 in results[:4]:
        yaw, tvec = icp_yaw(S_f, tree_f, M_f, yaw0, t0.copy(), 20, 0.08, 0.03)
        tvec[1] = sm["floor"] - bottom
        for y, tv in ((yaw0, t0), (yaw, tvec)):
            cst = cost(S_f, M_f @ ry(y).T + tv, tree_f, top)
            if best is None or cst[0] < best["cost"]:
                best = {"cost": cst[0], "scanToModel": cst[1], "modelToScan": cst[2], "yaw": y, "t": tv}
    best.update(
        up=up,
        scale=s,
        modelHeight=mm["height"],
        modelRect=mm["rect"]["size"],
        modelRectYaw=mm["rect"]["yaw"],
        Ru=Ru,
        bottom=bottom,
    )
    return best


def axis_scale(best: dict, S: np.ndarray, Ms: np.ndarray, limit: float) -> np.ndarray:
    """逐轴缩放（摆正后的模型坐标里）：扫描点换到模型的偏航坐标系，比较 2%–98% 的范围，限在等比的 ±limit。"""
    Vu = Ms @ best["Ru"].T * best["scale"]
    R = ry(best["yaw"])
    local = (S - best["t"]) @ R  # 世界 → 模型偏航坐标系（R 是正交阵）
    ratios = []
    for k in range(3):
        a = np.percentile(local[:, k], [2, 98])
        b = np.percentile(Vu[:, k], [2, 98])
        ratios.append(float(np.clip((a[1] - a[0]) / max(b[1] - b[0], 1e-9), 1 - limit, 1 + limit)))
    return np.array(ratios)


def raw_scale(Ru: np.ndarray, frame_scale: np.ndarray) -> list[float]:
    """摆正后坐标系里的逐轴缩放 → 模型原始坐标轴上的缩放（Ru 是带符号的置换矩阵：Ru·S_raw = S_frame·Ru）。"""
    out = []
    for i in range(3):
        j = int(np.argmax(np.abs(Ru[:, i])))
        out.append(float(frame_scale[j]))
    return out


def srgb_to_linear(c):
    c = np.asarray(c, float) / 255
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(np.asarray(c, float), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055) * 255


def tint_suggestion(scan_rgb: np.ndarray, model_rgb: np.ndarray) -> dict:
    """tint 乘在模型颜色上（线性空间）：tint = 扫描 / 模型，只能调暗（每个通道 ≤ 255）。
    模型比扫描暗得多时 tint 帮不上（只会更暗、偏色），不给建议，提示换颜色接近的候选。"""
    s, m = srgb_to_linear(scan_rgb), srgb_to_linear(model_rgb)
    ratio = s / np.maximum(m, 1e-4)
    k = float(ratio.max())
    out = {
        "tint": None,
        "scanMedian": [int(v) for v in scan_rgb],
        "modelMedian": [int(v) for v in model_rgb],
        "note": None,
    }
    if k > 1.5:
        out["note"] = f"模型比扫描暗（最亮的通道差 {k:.1f} 倍），tint 只能调暗，帮不上：换颜色接近的候选"
        return out
    if k > 1:
        ratio = ratio / k
        out["note"] = "模型略暗于扫描，tint 按色相给出"
    out["tint"] = [round(float(v)) for v in linear_to_srgb(ratio)]
    return out


# ---------------------------------------------------------------------------- 候选


def resolve_candidate(spec: str) -> dict:
    """候选 → fetch 写的旁注（没下载就先下载）。"""
    if spec.endswith(".json") and os.path.exists(spec) and "#" not in spec:
        side = wc.read_json(spec)
        if "model" not in side or "local" not in side:
            raise wc.ReconError(f"{spec} 不是 fetch 写的 model.json")
        return {**side, "sidecar": os.path.abspath(spec)}
    if "#" in spec:
        return fetch_one(load_candidate(spec))
    lib, _, mid = spec.partition(":")
    if lib in ("polyhaven", "objaverse", "sketchfab") and mid:
        from argparse import Namespace

        from .fetch import resolve_candidates

        (c,) = resolve_candidates(Namespace(source=None, pick=None, library=lib, id=mid))
        return fetch_one(c)
    raise wc.ReconError(f"候选写成 candidates.json#编号、model.json 或 库:编号：{spec}")


# ---------------------------------------------------------------------------- 命令


def cmd_place(args) -> dict:
    start = time.time()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    base: Base = from_args(args)
    box, eid = resolve_box(args, base)
    side = resolve_candidate(args.candidate)
    local = os.path.join(os.path.dirname(side["sidecar"]), side["local"]["path"])
    model = md.load_model_file(local)
    wc.log(
        f"place：{side['library']}:{side['id']}（{side['title']}，{model.triangles} 个三角形）→ "
        f"{eid or '范围'} {r(box.lo, 3)} – {r(box.hi, 3)}"
    )
    if side["model"].get("url") is None:
        wc.log("  提示：这个模型没有可写回的地址（见 fetch 的提示）")

    # 扫描点（范围里、地面以上、去掉排除框）
    clip, floor_y, scan_glb, near, grid, _, hm = prepare_scan(args, box, args.margin, out_dir, base)
    try:
        fit_box = box.grow(0.02)
        part = wc.crop_scan(near, fit_box.grow(0.1))
        P, C, _, _ = wc.sample_points(part, args.density, seed=3)
        keep = fit_box.contains(P) & (P[:, 1] >= wc.floor_at(hm, P) + args.floor_gap)
        excludes = [wc.parse_box(e) for e in args.exclude or []]
        for ex in excludes:
            keep &= ~ex.contains(P)
        P, C = P[keep], C[keep]
        # 贴着墙、玻璃的扫描点不参与摆放（偏差计算时结构作为背景，和 compare 一样）
        background = structure_parts(base, fit_box)
        fit_mask = np.ones(len(P), bool)
        if background:
            bg_index = SurfaceIndex.build([sm_.merge_meshes([b.mesh for b in background])], spacing=0.02)
            d_bg, _, _ = bg_index.query(P, k=2)
            fit_mask = d_bg > 0.03
        if fit_mask.sum() < 50:
            raise wc.ReconError("范围里的扫描点太少（检查 --object / --box / --exclude）")
        Pf = P[fit_mask]
        under = wc.floor_at(hm, Pf)
        local_floor = float(np.median(under))
        sm = scan_measure(Pf, local_floor)
        tree_s = cKDTree(subsample(Pf, 6000, 3))
        Ms = surface_samples(model.vertices, model.faces, 12000, seed=5)

        # 向上轴 × 偏航
        if args.yaw is not None:
            yaws = list(np.linspace(args.yaw - args.yaw_range, args.yaw + args.yaw_range, 9))
        else:
            yaws = [k * 360 / args.yaw_steps for k in range(args.yaw_steps)]
        ups = list(UP_OPTIONS) if args.up == "auto" else [args.up]
        for u in ups:
            if u not in UP_OPTIONS:
                raise wc.ReconError(f"--up 只能是 auto 或 {', '.join(UP_OPTIONS)}")
        window = (args.yaw, args.yaw_range) if args.yaw is not None else None
        tried = [place_up(u, Pf, tree_s, Ms, sm, args.scale, yaws, yaw_window=window) for u in ups]
        by_up = {b["up"]: b for b in tried}
        best = min(tried, key=lambda b: b["cost"])
        if "+y" in by_up and best["up"] != "+y" and best["cost"] > 0.85 * by_up["+y"]["cost"]:
            best = by_up["+y"]  # glTF 约定 +y 向上：别的轴要明显更好才选
        if not args.no_snap:
            snapped = snap_yaw(best, subsample(Pf, 6000, 3), tree_s, Ms, sm)
            if snapped is not None:
                wc.log(
                    f"  偏航 {best['yaw']:.1f}° 落到 {snapped['yaw']:.1f}°（和墙或外接矩形对齐，代价不变差）"
                )
                best = snapped
        frame_scale = np.full(3, best["scale"])
        if args.scale == "axis":
            frame_scale = best["scale"] * axis_scale(best, Pf, Ms, args.axis_limit)
            Vu = Ms @ best["Ru"].T * frame_scale
            sub = subsample(Vu, 6000, 4)
            S_f = subsample(Pf, 6000, 3)
            top = TopMap(S_f)
            t0 = best["t"].copy()
            t0[1] = local_floor - Vu[:, 1].min()
            yaw, tvec = icp_yaw(
                S_f, tree_s, sub, best["yaw"], t0.copy(), 15, 0.06, 0.03, fix_yaw="snappedFrom" in best
            )
            tvec[1] = t0[1]
            # 迭代最近点只在代价变低时采用（模型和扫描差得多时它会滑走）
            if (
                cost(S_f, sub @ ry(yaw).T + tvec, tree_s, top)[0]
                < cost(S_f, sub @ ry(best["yaw"]).T + t0, tree_s, top)[0]
            ):
                best.update(yaw=yaw, t=tvec)
            else:
                best.update(t=t0)
        best = center_extents(best, subsample(Pf, 6000, 3), tree_s, Ms, frame_scale)
        pitch, roll = UP_OPTIONS[best["up"]]
        yaw = float((best["yaw"] + 180) % 360 - 180)
        xf = {
            "position": [0.0, 0.0, 0.0],
            "yaw": round(yaw, 3),
            "pitch": pitch,
            "roll": roll,
            "scale": [round(v, 6) for v in raw_scale(best["Ru"], frame_scale)],
        }
        # 平移：水平位置用细化结果；高度让模型最低的顶点落到局部地面
        V0 = md.world_vertices({"transform": xf}, model)
        pos = best["t"].copy()
        pos[1] = local_floor - V0[:, 1].min()
        xf["position"] = [round(float(v), 4) for v in pos]
        body: dict = {
            "entityId": args.entity_id or eid or f"{side['library']}-{str(side['id'])[:12]}",
            "layer": "rebuilt",
            "kind": "object",
        }
        src_body = base.objects.get(eid) if eid else None
        label = args.label or (src_body or {}).get("label")
        if label:
            body["label"] = label
        if src_body and src_body.get("anchorId"):
            body["anchorId"] = src_body["anchorId"]
        model_ref = {k: v for k, v in side["model"].items() if k != "resolution"}
        body["model"] = model_ref
        body["transform"] = xf
        body["bounds"] = md.world_bounds(body, model)
        props: dict = {}
        if src_body and (src_body.get("props") or {}).get("category"):
            props["category"] = src_body["props"]["category"]
        props["source"] = {k: side[k] for k in ("library", "id", "page", "author", "license", "title")}
        body["props"] = props

        # 偏差（和 compare 同样的口径：结构作为背景）
        R, _, _, _ = wc.sample_points(part, 20000, seed=4)
        ref_tree = cKDTree(R[fit_box.grow(0.1).contains(R)])
        new = ModelSet(
            "new",
            {body["entityId"]: body},
            {},
            md.model_parts(body, model),
            [body["entityId"]],
            {
                body["entityId"]: {
                    "path": local,
                    "matrix": md.column_major(md.transform_matrix(xf)),
                    "tint": None,
                }
            },
        )
        res_new = evaluate(new, P, C, ref_tree, floor_y, background)
        old = base_modelset(base, [eid] if eid in base.objects else [])
        res_base = evaluate(old, P, C, ref_tree, floor_y, background) if old.parts else None
        fit = res_new["scanToModel"]
        body["fit"] = {"meanCm": fit["meanCm"], "p90Cm": fit["p90Cm"], "coverage3cm": fit["coverage3cm"]}

        # tint 建议：模型表面（变换后）离扫描 3 厘米内的点的颜色，对照扫描颜色
        Pm, Cm = model.surface_colors(20000, seed=6)
        Pw = Pm @ md.transform_matrix(xf)[:3, :3].T + md.transform_matrix(xf)[:3, 3]
        d_m, j_m = cKDTree(P).query(Pw, k=1)
        close = d_m < 0.03
        tint = None
        if close.sum() > 50:
            tint = tint_suggestion(np.median(C[j_m[close]], 0), np.median(Cm[close], 0))
            if args.tint and tint["tint"]:
                body["material"] = {"tint": tint["tint"]}
        wc.write_json(os.path.join(out_dir, "entity.json"), body)

        # 对比图
        images = {}
        if not args.no_render and render_available():
            cw, ch = (int(v) for v in args.cell.lower().split("x"))
            models = render_models(None, new, None, scan_glb, False)
            if body.get("material", {}).get("tint"):
                models[f"new#{body['entityId']}"]["tint"] = body["material"]["tint"]
            # 正面默认看水平外接矩形的长边（--front 可改）
            front = float(args.front) if args.front is not None else float(sm["rect"]["yaw"])
            angles = parse_angles("oblique,front,top", front)
            sheet = render_sheet(
                columns=[
                    ("scan", t("扫描", "scan")),
                    ("new", t(f"候选 {side['title'][:30]}", f"candidate {side['title'][:30]}")),
                ],
                models=models,
                angles=angles,
                box=box,
                clip=clip,
                floor_y=floor_y,
                grid=grid,
                cut=None,
                cell=(cw, ch),
                workdir=out_dir,
                header=t(
                    f"{side['library']}:{side['id']} · {side['license']} · {side['author']}",
                    f"{side['library']}:{side['id']} · {side['license']} · {side['author']}",
                ),
            )
            lines = [
                summary_line(t("现有算法", "current"), res_base),
                summary_line(t("候选", "candidate"), res_new),
            ]
            images["place"] = os.path.join(out_dir, "place.jpg")
            wc.save_jpeg(add_footer(sheet, lines), images["place"], 700_000)
            images["error"] = os.path.join(out_dir, "place_error.jpg")
            error_map(
                P,
                [
                    (t("现有算法", "current"), res_base["_d"] if res_base else None),
                    (t("候选", "candidate"), res_new["_d"]),
                ],
                fit_box,
                images["error"],
                t(f"扫描点到模型的距离（{len(P)} 点）", f"scan point to model distance ({len(P)})"),
            )
    finally:
        os.remove(scan_glb)
    for res in (res_new, res_base):
        if res:
            res.pop("_d", None)
    report = {
        "entity": os.path.join(out_dir, "entity.json"),
        "candidate": {
            k: side.get(k) for k in ("library", "id", "title", "author", "license", "page", "sidecar")
        },
        "scan": {
            "points": len(P),
            "floor": r(local_floor, 4),
            "height": r(sm["height"], 3),
            "rect": {"size": r(sm["rect"]["size"], 3), "yaw": sm["rect"]["yaw"]},
        },
        "chosen": {
            "snappedFrom": best.get("snappedFrom"),
            "up": best["up"],
            "yaw": round(yaw, 2),
            "scale": xf["scale"],
            "position": xf["position"],
            "uniformScale": round(best["scale"], 5),
            "cost": round(best["cost"] * 100, 2),
        },
        "upAxes": [
            {
                "up": b["up"],
                "costCm": round(b["cost"] * 100, 2),
                "scanToModelCm": round(b["scanToModel"] * 100, 2),
                "modelToScanCm": round(b["modelToScan"] * 100, 2),
                "yaw": round(float((b["yaw"] + 180) % 360 - 180), 2),
                "scale": round(b["scale"], 5),
                "modelHeight": round(b["modelHeight"], 4),
            }
            for b in tried
        ],
        "fit": {"new": res_new, "base": res_base},
        "tintSuggestion": tint,
        "images": images,
        "warnings": list(side.get("warnings") or []),
        "seconds": round(time.time() - start, 1),
    }
    if abs(best["scale"] - 1) > 0.3 and side["library"] == "polyhaven":
        report["warnings"].append(
            f"Poly Haven 模型是真实尺寸，这里缩放了 {best['scale']:.2f} 倍：可能不是同一类东西"
        )
    wc.write_json(os.path.join(out_dir, "place.json"), report)
    print_place(report, body, res_new, res_base)
    return report


def print_place(rep: dict, body: dict, res_new: dict, res_base: dict | None) -> None:
    p = print
    c = rep["candidate"]
    p(f"\n== 候选 {c['library']}:{c['id']}  {c['title']}  {c['license']}  — {c['author']}")
    p(
        f"  扫描：{rep['scan']['points']} 点，局部地面 y={rep['scan']['floor']}，"
        f"高 {rep['scan']['height']} 米，"
        f"水平外接矩形 {rep['scan']['rect']['size']}（yaw {rep['scan']['rect']['yaw']}°）"
    )
    p("  向上轴    代价   扫描→模型  模型→扫描   偏航     等比缩放  模型高")
    for u in rep["upAxes"]:
        mark = " ←" if u["up"] == rep["chosen"]["up"] else ""
        p(
            f"   {u['up']:<4} {u['costCm']:7.2f} {u['scanToModelCm']:9.2f} {u['modelToScanCm']:9.2f} "
            f"{u['yaw']:8.1f}° "
            f"{u['scale']:10.5f} {u['modelHeight']:8.3f}{mark}"
        )
    ch = rep["chosen"]
    p(f"  选定：向上 {ch['up']}，偏航 {ch['yaw']}°，缩放 {ch['scale']}，位置 {ch['position']}")
    p(f"  包围盒 {body['bounds']}")
    p(f"  {summary_line('现有算法', res_base)}")
    p(f"  {summary_line('候选', res_new)}")
    if rep["tintSuggestion"]:
        ts = rep["tintSuggestion"]
        p(
            f"  tint 建议 {ts['tint']}（扫描中位色 {ts['scanMedian']}，模型 {ts['modelMedian']}）"
            + (f"；{ts['note']}" if ts["note"] else "")
        )
    for w in rep["warnings"]:
        p(f"  提示：{w}")
    p(f"  记录：{rep['entity']}")
    for k, v in rep["images"].items():
        p(f"  图（{k}）：{v}")
    p(f"  共 {rep['seconds']} 秒")
