"""物体重建（设计 6.3 的"优化模型"）：
扫描 → 物体分割 → 测量 → 常见形状拟合 → 同款合并 → 贴图转移 → 自查。

入口 `reconstruct_objects(mesh, structure, params=...)`，mesh 已对齐到空间坐标（y 向上，米），
structure 是同一网格上 `extract_structure` 的结果。
输出 SHAPES 第 3 节的物件记录 body（`layer: rebuilt`，`kind: object` 或 `template`）、
被引用的贴图（内容哈希 → JPEG 字节）和指标。

流程：

1. **分割**（`fit_segment`）：去掉地面、墙、玻璃带、天花板，聚类，按悬空台面、高矮、颈部、靠背山头拆开；
   `params["objects"]` 里的提示（本地 AI 看图给出）可以改写分割和类型；拆桌面剩下的块里，台面下靠里的
   柱脚并回桌子，压在台面上的东西按桌上的杂物处理（`attach_to_tables`）；
2. **识别**：有提示用提示的 `kind`、`label`；没有就按规则（尺寸、座面、台面、颜色、圆度）；
3. **朝向和原点**：最小外接矩形（接近墙的方向时取墙的方向），椅子按靠背定正面，沙发靠背朝 −z；
   原点在物体底面中心的地面上，偏航是连续值；
4. **拟合**（`fit_templates`，前台在 `fit_counter`）：按类型组合圆角盒、带圆弧的挤出、旋转体、扫掠、
   截面放样；
5. **同款合并**：同类型、尺寸相近的物体（例如一排会议椅）对齐后合并点云拟合一个模板，各处用实例摆放；
   对齐后与其他成员差得多的退出合并、单独拟合；
6. **上色和贴图**（`fit_texture`）：颜色单一的部件用纯色，其余按部件的投影烘焙小贴图；
   杂物和小柜子（最长边不到 0.8 米）只用纯色；
7. **自查**：每个物体的扫描点到模型的距离（均值、90% 分位、3 厘米内的比例）写进 `fit`，总体写进指标。
"""

from __future__ import annotations

import json
import logging
import math
import time
import zlib
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy import ndimage
from scipy.spatial import ConvexHull, cKDTree

from .. import shapes as sh
from ..canonical import canonical_json
from ..ids import slug_id
from ..records import entity_body
from .bake import FaceTable
from .fit_counter import fit_counter
from .fit_measure import (
    Rect,
    dirs_to_local,
    fit_circle,
    height_peaks,
    min_area_rect,
    polygon_contains,
    to_local,
)
from .fit_segment import ObjectPoints, Segment, SegmentParams, segment_objects
from .fit_templates import (
    Local,
    circularity,
    fit_box,
    fit_chair,
    fit_faces_box,
    fit_panel,
    fit_plant,
    fit_round,
    fit_sofa,
    fit_stack,
    fit_table,
    fit_terrace,
)
from .fit_texture import ColorSource, SurfaceIndex, TextureParams, finalize_materials, fit_stats
from .scan import ScanMesh
from .shape_mesh import build_parts, merge_meshes

log = logging.getLogger(__name__)

KINDS = ("chair", "table", "sofa", "counter", "cabinet", "plant", "lamp", "pillar", "round", "clutter")
LABELS = {
    "chair": "椅子",
    "table": "桌子",
    "sofa": "沙发",
    "counter": "前台",
    "cabinet": "柜子",
    "plant": "绿植",
    "lamp": "灯",
    "pillar": "立柱",
    "round": "圆形物件",
    "clutter": "杂物",
}
FURNITURE = {"chair", "table", "sofa", "counter", "cabinet"}
# 规则识别前台时要求的最小进深（米，俯视外接框的短边）。
COUNTER_MIN_DEPTH = 0.35
SMALL = 0.8  # 小件：最长边不到 0.8 米（小柜子只用纯色；杂物和小件的俯视轮廓偏向简单的）
# 提示里常见的别名
KIND_ALIASES = {
    "desk": "table",
    "side_table": "table",
    "coffee_table": "table",
    "armchair": "chair",
    "stool": "chair",
    "bench": "sofa",
    "reception": "counter",
    "shelf": "cabinet",
    "display": "cabinet",
    "screen": "cabinet",
    "column": "pillar",
    "pot": "round",
    "misc": "clutter",
}


@dataclass
class ObjectsResult:
    entities: dict[str, dict]  # entityId -> 物件记录 body（SHAPES 第 3 节）
    textures: dict[str, bytes]  # sha256 十六进制 -> JPEG 字节
    metrics: dict[str, Any]


@dataclass(frozen=True)
class ObjectParams:
    segment: SegmentParams = field(default_factory=SegmentParams)
    texture: TextureParams = field(default_factory=TextureParams)
    merge_size_tol: float = 0.15  # 同款：尺寸相差不超过 15%
    merge_height_tol: float = 0.08
    merge_residual: float = 0.02  # 对齐后 40% 分位的最近距离超过 2 厘米就退出合并
    merge_residual_hinted: float = 0.045  # 提示认定同款时的放宽值
    color_density: float = 60_000.0  # 取色用的扫描重采样密度（点/平方米）
    max_color_points: int = 600_000


@dataclass(eq=False)
class Obj:
    seg: Segment
    P: np.ndarray
    C: np.ndarray
    N: np.ndarray
    faces: np.ndarray
    kind: str
    label: str
    origin: np.ndarray  # [x, 地面 y, z]
    yaw: float
    local: Local
    source: str  # hint | rules
    entity_id: str = ""
    info: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------- 提示


def parse_hints(params: dict[str, Any] | None) -> list[dict[str, Any]]:
    """`params["objects"]`：[{center: [x,y,z], label?, kind?, size?: [w,h,d], yaw?}]。格式不对的项忽略。"""
    if not params:
        return []
    raw = params.get("objects")
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[:500]:
        if not isinstance(item, dict):
            continue
        c = item.get("center")
        if not (isinstance(c, list) and len(c) in (2, 3)):
            continue
        try:
            vals = [float(v) for v in c]
        except (TypeError, ValueError):
            continue
        if not all(math.isfinite(v) for v in vals):
            continue
        hint: dict[str, Any] = {"center": vals}
        kind = item.get("kind")
        if isinstance(kind, str):
            kind = KIND_ALIASES.get(kind.strip().lower(), kind.strip().lower())
            if kind in KINDS:
                hint["kind"] = kind
        label = item.get("label")
        if isinstance(label, str) and label.strip():
            hint["label"] = label.strip()[:200]
        size = item.get("size")
        if isinstance(size, list) and len(size) == 3 and len(vals) == 3:
            try:
                sz = [float(v) for v in size]
                if all(math.isfinite(v) and 0 < v < 50 for v in sz):
                    hint["size"] = sz
            except (TypeError, ValueError):
                pass
        yaw = item.get("yaw")
        if isinstance(yaw, int | float) and math.isfinite(yaw):
            hint["yaw"] = float(yaw)
        out.append(hint)
    return out


# ---------------------------------------------------------------------------- 识别


def _wall_yaws(structure) -> list[float]:
    """墙的方向对应的偏航（局部 x 平行于墙），用于把物体的朝向取正。"""
    out = [0.0]
    for e in structure.elements:
        if e.kind == "floor":
            continue
        t = e.info["tangent"]
        out.append(-math.degrees(math.atan2(t[1], t[0])) % 90.0)
    return out


def _snap(rect: Rect, wall_yaws: list[float], tol: float = 6.0) -> float:
    best = rect.yaw
    for w in wall_yaws:
        diff = ((rect.yaw - w) + 45) % 90 - 45
        if abs(diff) < tol:
            best = rect.yaw - diff
            break
    return best


def _is_green(C: np.ndarray) -> bool:
    c = C.astype(float)
    return bool(np.mean((c[:, 1] > c[:, 0] + 6) & (c[:, 1] > c[:, 2])) > 0.35)


def skirt_fraction(L: np.ndarray, top_h: float) -> float:
    """台面一圈的边上，台面以下（离地 0.1 米到台面下 0.15 米）有扫描表面的比例：
    柜子四面落地，桌子是悬空的。"""
    from .fit_measure import occupancy

    band = (L[:, 1] > top_h - 0.04) & (L[:, 1] < top_h + 0.03)
    if band.sum() < 20:
        return 0.0
    m = occupancy(L[band][:, [0, 2]], 0.03, close=2)
    ring = m.mask & ~ndimage.binary_erosion(m.mask, iterations=2)
    below = (L[:, 1] > 0.1) & (L[:, 1] < top_h - 0.15)
    if not below.any() or not ring.any():
        return 0.0
    iz = np.clip(((L[below, 2] - m.z0) / m.cell).astype(int), 0, m.mask.shape[0] - 1)
    ix = np.clip(((L[below, 0] - m.x0) / m.cell).astype(int), 0, m.mask.shape[1] - 1)
    hit = np.zeros_like(m.mask)
    hit[iz, ix] = True
    hit = ndimage.binary_dilation(hit, iterations=1)
    return float((hit & ring).sum() / ring.sum())


def classify(L: np.ndarray, N: np.ndarray, C: np.ndarray, tags: set[str], top_h: float | None) -> str:
    y = L[:, 1]
    H = float(np.percentile(y, 98))
    skirt = skirt_fraction(L, top_h) if top_h is not None else 0.0
    ext = np.ptp(L[:, [0, 2]], axis=0)
    long_, short = float(max(ext)), float(min(ext))
    if "on-top" in tags:
        return "clutter"
    # 前台要有进深：入口处 2 米多宽、十几厘米厚的竖板（门框、隔断的一截）不是前台。
    deep = short >= COUNTER_MIN_DEPTH
    if top_h is not None:
        if top_h > 0.95 and long_ > 1.2 and deep:
            return "counter"
        return "cabinet" if skirt > 0.6 else "table"
    if H > 1.5:
        if _is_green(C):
            return "plant"
        if short < 0.4 and long_ < 0.8:
            return "pillar"
        return "cabinet"
    up = N[:, 1] > 0.75
    seat = height_peaks(y[up & (y > 0.33) & (y < 0.62)], 0.33, 0.62, max(20, int(0.02 * len(y))))
    if seat and 0.55 < H < 1.35:
        hs = seat[0][0]
        high = y > hs + 0.15
        if high.sum() > 0.08 * len(y):
            if long_ >= 1.25 and short >= 0.5:
                return "sofa"
            if long_ <= 1.05:
                return "chair"
    if 0.85 < H < 1.35 and long_ > 1.5 and deep:
        return "counter"
    if long_ < 1.2 and H > 0.25:
        o = Local(L, N, C)
        if circularity(o) < 0.06:
            return "round"
    if H > 0.4 and long_ * short > 0.12:
        return "cabinet"
    return "clutter"


def _chair_frame(P: np.ndarray, N: np.ndarray, base_y: float) -> tuple[np.ndarray, float]:
    """椅子：靠背连扶手在俯视里是一段向前开口的圆弧——对座面以上的点拟合圆，圆心指向点的重心是靠背方向，
    正面朝相反方向（+z）；原点取正面坐标系里外接框的中心。"""
    y = P[:, 1] - base_y
    up = N[:, 1] > 0.75
    seat = height_peaks(y[up & (y > 0.33) & (y < 0.58)], 0.33, 0.58, 8)
    hs = seat[0][0] if seat else 0.45
    rect = min_area_rect(P[:, [0, 2]])
    high = P[(y > hs + 0.1) & (y < np.percentile(y, 99))][:, [0, 2]]
    yaw = rect.yaw
    if len(high) >= 30:
        c, r, _ = fit_circle(high)
        g = high.mean(0)
        b = g - c
        if r > 1.5 or np.hypot(*b) < 0.02:
            # 平直的靠背：靠背在外接矩形里离重心最远的长边一侧
            b = g - np.median(P[:, [0, 2]], axis=0)
        if np.hypot(*b) > 1e-3:
            f = -b / np.hypot(*b)
            yaw = math.degrees(math.atan2(f[0], f[1]))
    o0 = np.array([rect.center[0], base_y, rect.center[1]])
    loc = to_local(P, o0, yaw)
    cx = (np.percentile(loc[:, 0], 2) + np.percentile(loc[:, 0], 98)) / 2
    cz = (np.percentile(loc[:, 2], 2) + np.percentile(loc[:, 2], 98)) / 2
    a = math.radians(yaw)
    wx = o0[0] + cx * math.cos(a) + cz * math.sin(a)
    wz = o0[2] - cx * math.sin(a) + cz * math.cos(a)
    return np.array([wx, base_y, wz]), yaw


def _prepare(op: ObjectPoints, seg: Segment, wall_yaws: list[float]) -> Obj | None:
    idx = seg.idx
    # 贴地的水平面（地面的重影、反光，提示框里圈进来的地面）不属于物体
    flat = (op.h[idx] < 0.12) & (op.N[idx, 1] > 0.85)
    if flat.mean() < 0.9:
        idx = idx[~flat]
    seg = Segment(idx, seg.tags, seg.top, seg.hint)
    P, C, N, h = op.P[idx], op.C[idx], op.N[idx], op.h[idx]
    if len(P) < 30:
        return None
    # 地面上的一层薄片（扫描的重影、反光）：大部分点又低又朝上
    if np.mean(h < 0.15) > 0.7 and np.mean(N[:, 1] > 0.8) > 0.5 and np.percentile(h, 90) < 0.2:
        return None
    base_y = float(np.median(P[:, 1] - h))
    hint = seg.hint or {}
    top_h = seg.top["height"] - base_y if seg.top is not None else None
    rect = min_area_rect(P[:, [0, 2]])
    yaw = _snap(rect, wall_yaws)
    origin = np.array([rect.center[0], base_y, rect.center[1]])
    L0 = to_local(P, origin, yaw)
    kind = hint.get("kind") or classify(L0, dirs_to_local(N, yaw), C, seg.tags, top_h)
    if kind == "table" and top_h is None:
        up = N[:, 1] > 0.85
        pk = height_peaks(P[up, 1] - base_y, 0.3, 1.3, 10)
        top_h = pk[0][0] if pk else None
    if kind == "chair":
        origin, yaw = _chair_frame(P, N, base_y)
    elif kind == "sofa":
        L1 = to_local(P, origin, yaw)
        # 靠背一侧更高
        zc = np.median(L1[:, 2])
        hi_back = np.percentile(L1[L1[:, 2] < zc, 1], 95) if (L1[:, 2] < zc).sum() > 10 else 0
        hi_front = np.percentile(L1[L1[:, 2] >= zc, 1], 95) if (L1[:, 2] >= zc).sum() > 10 else 0
        if hi_front > hi_back:
            yaw = yaw + 180.0
    elif kind in ("round", "plant", "lamp"):
        cxz = P[:, [0, 2]]
        lowish = (h < np.percentile(h, 60)) if kind == "plant" else np.ones(len(P), bool)
        c, _, _ = fit_circle(cxz[lowish]) if lowish.sum() > 10 else (rect.center, 0, 0)
        if np.hypot(*(c - rect.center)) > 0.3:
            c = rect.center
        origin = np.array([c[0], base_y, c[1]])
        yaw = 0.0
    if "yaw" in hint and kind not in ("chair",):
        yaw = float(hint["yaw"])
    yaw = ((yaw + 180.0) % 360.0) - 180.0
    L = to_local(P, origin, yaw)
    local = Local(
        L, dirs_to_local(N, yaw), C, {"top": top_h, "thickness": seg.top["thickness"] if seg.top else None}
    )
    label = hint.get("label") or LABELS[kind]
    return Obj(seg, P, C, N, op.F[seg.idx], kind, label, origin, yaw, local, "hint" if seg.hint else "rules")


# ---------------------------------------------------------------------------- 拟合


def _fit_local(o: Local, kind: str) -> tuple[dict[str, Any], str]:
    shape, method = _fit_local_raw(o, kind)
    shape = _sanitize(shape)
    if shape is None:
        return _sanitize(fit_box(o)) or fit_box(o), "box"
    return shape, method


def _sanitize(shape: dict[str, Any] | None) -> dict[str, Any] | None:
    """去掉校验不过的部件（退化的截面、轮廓方向错的放样等），保证输出的每个形状都合法。"""
    if shape is None:
        return None
    kids = []
    for child in shape.get("children") or []:
        probe = json.loads(json.dumps(child))
        probe.pop("_part", None)
        try:
            sh.validate_shape(probe)
            sh.shape_bounds(probe)
        except sh.ShapeError as err:
            log.debug("丢掉不合法的部件：%s", err)
            continue
        kids.append(child)
    if not kids:
        return None
    shape["children"] = kids
    return shape


def _fit_local_raw(o: Local, kind: str) -> tuple[dict[str, Any], str]:
    if kind == "table":
        return fit_table(o, o.info.get("top"), o.info.get("thickness")), "table"
    if kind == "chair":
        return fit_chair(o), "chair"
    if kind == "sofa":
        return fit_sofa(o), "sofa"
    if kind == "counter":
        # 外壳 + 台面 + 工作台面的多面体；量不出外壳时退回分层挤出
        shell = fit_counter(o)
        if shell is not None:
            return shell, "counter"
        return _best_of(
            o,
            [
                ("terrace", lambda: fit_terrace(o)),
                ("terrace", lambda: fit_terrace(o, main_mode="stack")),
                ("stack", lambda: fit_stack(o)),
            ],
        )
    if kind == "plant":
        return fit_plant(o), "lathe"
    if kind in ("round", "lamp"):
        return fit_round(o), "lathe"
    if kind == "cabinet":
        # 只扫到两个相邻面的高柜（镜面的虚像散在外面）：按看到的面定尺寸的竖直圆角盒
        faces = fit_faces_box(o)
        if faces is not None:
            return faces, "faces"
        # 大屏、展板：正面贴图面板 + 深色机身 + 前面立着的音箱、底座
        panel = fit_panel(o)
        if panel is not None:
            return panel, "panel"
    ext = np.ptp(o.L, axis=0)
    dims = sorted(ext)
    uv = "planar" if dims[0] < 0.4 * dims[1] else "cylindrical"
    # 杂物和小件的俯视轮廓偏向简单的（圆角矩形、凸包），不追一堆东西拼出来的凹凸
    small = kind == "clutter" or max(ext[0], ext[2]) < SMALL
    cands = [("box", lambda: fit_box(o, uv=uv, complexity=0.015 if small else 0.004))]
    if kind in ("cabinet", "clutter") and float(np.percentile(o.y, 99)) > 0.3:
        cands.append(("stack", lambda: fit_stack(o, uv=uv)))
        if float(np.percentile(o.y, 99)) > 1.5:
            cands.append(("stack", lambda: fit_stack(o, uv=uv, max_bands=6)))
    return _best_of(o, cands)


def _best_of(o: Local, cands) -> tuple[dict[str, Any], str]:
    """几种拟合里选偏差最小的（每多一个部件加 0.1 厘米的代价，偏向简单的形状）。"""
    from .fit_texture import strip_parts

    rng = np.random.default_rng(5)
    P = o.L if len(o.L) <= 4000 else o.L[rng.choice(len(o.L), 4000, replace=False)]
    best = None
    for name, make in cands:
        shape = make()
        if shape is None:
            continue
        probe = json.loads(json.dumps(shape))
        strip_parts(probe)
        mesh = merge_meshes([p.mesh for p in build_parts(probe)])
        if len(mesh.indices) == 0:
            continue
        d, _, _ = SurfaceIndex.build([mesh], spacing=0.015).query(P, k=3)
        score = float(d.mean()) + 0.001 * len(shape.get("children") or [shape])
        if best is None or score < best[0]:
            best = (score, shape, name)
    if best is None:
        return fit_box(o), "box"
    return best[1], best[2]


def _color_source(table: FaceTable, faces: np.ndarray, prm: ObjectParams, seed: int) -> ColorSource:
    faces = np.unique(faces)
    area = float(table.area[faces].sum())
    density = min(prm.color_density, prm.max_color_points / max(area, 1e-6))
    rng = np.random.default_rng(seed)
    P, C, N = table.dense(faces, density, rng)
    return ColorSource(P, C, N)


def _icp_2d(src: np.ndarray, ref_tree: cKDTree, iters: int = 12, max_d: float = 0.08):
    """把 src（局部坐标点）在 xz 平面里对齐到参考：截尾 ICP，偏航修正限制在 ±8° 内（各物体自己的朝向
    已经量过——椅子按靠背、桌边的椅子朝桌子；圆的外形让 ICP 自由转会转错）。
    残差是 40% 分位的最近距离（不怕遮挡和杂点）。返回 (偏航度, dx, dz, 残差, 对齐后的点)。"""
    best = None
    for start in (0.0,):
        a = math.radians(start)
        c, s = math.cos(a), math.sin(a)
        R = np.array([[c, -s], [s, c]])
        xz = src[:, [0, 2]] @ R.T
        init = np.c_[xz[:, 0], src[:, 1], xz[:, 1]]
        yaw, tx, tz, res, cur = _icp_once(init, ref_tree, iters, max_d)
        if best is None or res < best[3]:
            # 合成：先转 start 再做 ICP 的 (yaw, t)
            best = (yaw + start, tx, tz, res, cur)
    if best is None:
        d, _ = ref_tree.query(src, k=1)
        best = (0.0, 0.0, 0.0, float(np.percentile(d, 40)), src)
    return best


def _icp_once(src: np.ndarray, ref_tree: cKDTree, iters: int, max_d: float, max_yaw: float = 8.0):
    yaw, tx, tz = 0.0, 0.0, 0.0
    cur = src.copy()
    res = np.inf
    for _ in range(iters):
        d, j = ref_tree.query(cur, k=1)
        # 截尾：只用最近的 70%（遮挡、粘连进来的杂点不参与）
        ok = (d < max_d) & (d <= np.percentile(d, 70))
        if ok.sum() < 20:
            break
        a = cur[ok][:, [0, 2]]
        b = ref_tree.data[j[ok]][:, [0, 2]]
        ca, cb = a.mean(0), b.mean(0)
        Hm = (a - ca).T @ (b - cb)
        ang = math.atan2(Hm[0, 1] - Hm[1, 0], Hm[0, 0] + Hm[1, 1])
        lim = math.radians(max_yaw)
        ang = float(np.clip(ang, -lim - math.radians(yaw), lim - math.radians(yaw)))
        c, s = math.cos(ang), math.sin(ang)
        R = np.array([[c, -s], [s, c]])
        t = cb - R @ ca  # 转角被限制时，平移仍取对应点重心之差
        xz = cur[:, [0, 2]] @ R.T + t
        cur = np.c_[xz[:, 0], cur[:, 1], xz[:, 1]]
        yaw += math.degrees(ang)
        tx, tz = (np.array([tx, tz]) @ R.T + t).tolist()
    d, _ = ref_tree.query(cur, k=1)
    res = float(np.percentile(d, 40))
    return yaw, tx, tz, res, cur


def _apply_icp(o: Obj, dyaw: float, dx: float, dz: float) -> None:
    """把局部坐标里的修正（先转 dyaw，再平移 (dx, dz)）换回物体的世界原点和偏航。"""
    a = math.radians(dyaw)
    c, s = math.cos(a), math.sin(a)
    R = np.array([[c, -s], [s, c]])
    inv_t = -R.T @ np.array([dx, dz])
    yw = math.radians(o.yaw)
    wx = inv_t[0] * math.cos(yw) + inv_t[1] * math.sin(yw)
    wz = -inv_t[0] * math.sin(yw) + inv_t[1] * math.cos(yw)
    o.origin = o.origin + np.array([wx, 0.0, wz])
    o.yaw = o.yaw + dyaw
    o.local = Local(to_local(o.P, o.origin, o.yaw), dirs_to_local(o.N, o.yaw), o.C, o.local.info)


def _model_tree(local: Local, kind: str) -> cKDTree:
    from .fit_texture import strip_parts

    shape, _ = _fit_local(local, kind)
    strip_parts(shape)
    mesh = merge_meshes([p.mesh for p in build_parts(shape)])
    idx = SurfaceIndex.build([mesh], spacing=0.01)
    return cKDTree(idx.samples)


def _pool(members: list[Obj]) -> Local:
    return Local(
        np.concatenate([o.local.L for o in members]),
        np.concatenate([o.local.N for o in members]),
        np.concatenate([o.C for o in members]),
        dict(members[0].local.info),
    )


def _merge_members(members: list[Obj], prm: ObjectParams) -> list[Obj]:
    """同款合并：
    1. 点最多的成员做参考，其他成员 ICP 对齐到它，残差小的组成核心；
    2. 核心合并点云拟合出第一版模板；所有成员（包括被遮挡、只扫到一部分的）再 ICP 对齐到模板表面——
       残部对完整模型的距离只看自己有的那部分，所以遮挡不影响；
    3. 对得上的成员合并点云，返回（第一个是参考）。对不上的留给单独拟合。"""
    ref = max(members, key=lambda o: len(o.P))
    tree = cKDTree(ref.local.L)
    core = [ref]
    scored = []
    for o in members:
        if o is ref:
            continue
        dyaw, dx, dz, res, _ = _icp_2d(o.local.L, tree)
        scored.append((res, o, dyaw, dx, dz))
    scored.sort(key=lambda t: t[0])
    for res, o, dyaw, dx, dz in scored:
        if res <= prm.merge_residual or len(core) < 2:
            _apply_icp(o, dyaw, dx, dz)
            core.append(o)
    mtree = _model_tree(_pool(core), ref.kind)
    accepted = [ref]
    # 提示里说是同一款（本地 AI 看图认定）时，被遮挡得厉害的成员也用模板，放宽对齐残差
    hinted = all(
        (o.seg.hint or {}).get("label") == (ref.seg.hint or {}).get("label") for o in members
    ) and bool((ref.seg.hint or {}).get("label"))
    limit = prm.merge_residual_hinted if hinted else prm.merge_residual
    for o in members:
        if o is ref:
            continue
        dyaw, dx, dz, res, _ = _icp_2d(o.local.L, mtree)
        if res <= limit:
            _apply_icp(o, dyaw, dx, dz)
            accepted.append(o)
    return accepted


def _dims(o: Obj) -> np.ndarray:
    L = o.local.L
    lo = np.percentile(L, 2, axis=0)
    hi = np.percentile(L, 98, axis=0)
    return hi - lo


def _groups(objs: list[Obj], prm: ObjectParams) -> list[list[Obj]]:
    """同款候选：同类型（椅子、沙发、柜子、圆形物件），尺寸和高度相近。"""
    out: list[list[Obj]] = []
    used: set[int] = set()
    for i, a in enumerate(objs):
        if i in used:
            continue
        group = [a]
        used.add(i)
        if a.kind in ("chair", "sofa", "cabinet", "round"):
            da = _dims(a)
            for j in range(i + 1, len(objs)):
                b = objs[j]
                if (
                    j in used
                    or b.kind != a.kind
                    or (a.seg.hint or {}).get("label") != (b.seg.hint or {}).get("label")
                ):
                    continue
                db = _dims(b)
                same_hint = bool((a.seg.hint or {}).get("label")) and a.kind == "chair"
                if same_hint or (
                    np.all(
                        np.abs(da[[0, 2]] - db[[0, 2]]) <= prm.merge_size_tol * np.maximum(da[[0, 2]], 0.3)
                    )
                    and abs(da[1] - db[1]) <= prm.merge_height_tol
                ):
                    group.append(b)
                    used.add(j)
        out.append(group)
    return out


def _textured(kind: str, size: float, min_size: float = SMALL) -> bool:
    """杂物和小柜子（最长边不到 0.8 米）只用纯色：它们身上的"图案"多半是反光、粘连进来的桌面和扫描噪声，
    贴上去像一块块玻璃；纯色的圆角盒干净。桌子（边几的大理石台面）等照旧按颜色是否单一决定。"""
    if kind == "clutter":
        return False
    return not (kind == "cabinet" and size < min_size)


def _world_shape(local_shape: dict[str, Any], origin: np.ndarray, yaw: float) -> dict[str, Any]:
    shape = dict(local_shape)
    shape["transform"] = sh.transform(position=origin.tolist(), yaw=yaw)
    return shape


def _clean_shape(shape: dict[str, Any]) -> dict[str, Any]:
    """去掉临时字段，数值取 4 位小数。"""
    shape.pop("_part", None)
    for child in shape.get("children") or []:
        _clean_shape(child)
    return shape


def _face_tables(objs: list[Obj], reach: float = 0.6, agree: float = 40.0) -> None:
    """桌边的椅子朝向桌子：椅子中心离某张桌子的台面投影不到 0.6 米时，正面取指向台面最近点的方向
    （椅子被桌面挡住、只扫到靠背时，自己的点定不准朝向）；与椅子自己量出来的朝向相差不到 40° 时保留自己的。"""
    tops = []
    for o in objs:
        top = o.seg.top
        if o.kind == "table" and top is not None and "mask" in top:
            grid = top["grid"]
            mask = top["mask"]
            zz, xx = np.nonzero(mask)
            cells = np.c_[grid.x0 + (xx + 0.5) * grid.cell, grid.z0 + (zz + 0.5) * grid.cell]
            # 台面的"芯"：离台面边缘 0.25 米以上（窄桌取最深的一圈），椅子朝芯上最近的点
            depth = ndimage.distance_transform_edt(np.pad(mask, 1))[1:-1, 1:-1][zz, xx] * grid.cell
            core = cells[depth >= min(0.25, 0.8 * depth.max())]
            tops.append((cells, core))
    if not tops:
        return
    for o in objs:
        if o.kind != "chair":
            continue
        c = o.origin[[0, 2]]
        best = None
        for cells, core in tops:
            d = float(np.hypot(*(cells - c).T).min())
            if d < reach and (best is None or d < best[0]):
                j = int(np.argmin(np.hypot(*(core - c).T)))
                best = (d, core[j])
        if best is None or np.hypot(*(best[1] - c)) < 0.05:
            continue
        f = best[1] - c
        yaw_t = math.degrees(math.atan2(f[0], f[1]))
        diff = ((o.yaw - yaw_t) + 180) % 360 - 180
        if abs(diff) > agree:
            o.yaw = yaw_t
            o.local = Local(to_local(o.P, o.origin, o.yaw), dirs_to_local(o.N, o.yaw), o.C, o.local.info)
            o.info["facing"] = "table"


def attach_to_tables(op: ObjectPoints, segs: list[Segment]) -> list[Segment]:
    """拆桌面时台面以下剩下的块（`below-top:<台面高度>`），按它和桌子的关系重新归属：

    - **底座**：俯视一半以上在台面投影里、重心离台面边 15 厘米以上、从地面附近（0.35 米以下）一直到
      台面下 0.3 米以内的大块（300 点以上）是桌子的柱脚，并回桌子，由桌子的拟合做成规整的底座
      （不再是一个单独的"柜子"）；
    - **桌上的东西**：俯视 70% 以上在台面投影里、60% 以上的点高过台面的是压在台面上的东西（只是有几个点挂到了
      台面边以下）：去掉台面以下的点，按桌上的杂物处理（底面贴着台面，不会往台面下面长出一个大圆角盒）。

    其余的照旧。"""
    tables = [s for s in segs if "table-top" in s.tags and s.top is not None]
    if not tables:
        return segs
    hulls: list[np.ndarray | None] = []
    rects: list[Rect | None] = []
    for s in tables:
        # 台面的俯视范围：台面薄层上的点的凸包（台面上压着东西的地方，台面检测的格子里是缺的）
        P = op.P[s.idx]
        t, th = s.top["height"], float(s.top.get("thickness") or 0.04)
        xz = P[(P[:, 1] > t - th - 0.03) & (P[:, 1] < t + 0.04)][:, [0, 2]]
        try:
            hulls.append(xz[ConvexHull(xz).vertices] if len(xz) >= 10 else None)
            rects.append(min_area_rect(xz) if len(xz) >= 10 else None)
        except Exception:
            hulls.append(None)
            rects.append(None)
    out: list[Segment] = []
    extra: dict[int, list[np.ndarray]] = {}
    for seg in segs:
        tag = next((t for t in seg.tags if t.startswith("below-top:")), None)
        if tag is None or seg.hint is not None:
            out.append(seg)
            continue
        t = float(tag.split(":")[1])
        owner = next(
            (k for k, s in enumerate(tables) if abs(s.top["height"] - t) < 0.005 and hulls[k] is not None),
            None,
        )
        if owner is None:
            out.append(seg)
            continue
        top = tables[owner].top
        P, h = op.P[seg.idx], op.h[seg.idx]
        hull = hulls[owner]
        inside = float(polygon_contains(hull, P[:, [0, 2]]).mean())
        y = P[:, 1]
        under = t - float(top.get("thickness") or 0.04)
        lo, hi = np.percentile(h, 2), np.percentile(y, 98)
        # 柱脚在台面下面靠里：重心在台面外接矩形里、离矩形的边 15 厘米以上（台面一角被柱脚的块分走时，
        # 凸包会缺一角，外接矩形不会）；推进桌下的椅子贴着台面边
        rect = rects[owner]
        assert rect is not None
        c = to_local(
            np.c_[P[:, 0], np.zeros(len(P)), P[:, 2]].mean(0, keepdims=True),
            np.r_[rect.center[0], 0, rect.center[1]],
            rect.yaw,
        )[0]
        depth = min(rect.size[0] / 2 - abs(c[0]), rect.size[1] / 2 - abs(c[2]))
        core = depth >= 0.15
        if len(y) >= 300 and inside >= 0.5 and core and lo <= 0.35 and under - 0.3 <= hi <= t + 0.02:
            extra.setdefault(owner, []).append(seg.idx)
        elif inside < 0.7:
            out.append(seg)
        elif np.mean(y > t) >= 0.6:
            keep = seg.idx[y > t - 0.01]
            if len(keep) >= 30:
                out.append(Segment(keep, {"on-top"}))
        else:
            out.append(seg)
    for k, idxs in extra.items():
        s = tables[k]
        merged = Segment(np.concatenate([s.idx, *idxs]), set(s.tags), s.top, s.hint)
        out[next(i for i, x in enumerate(out) if x is s)] = merged
    return out


def _name(objs: list[Obj]) -> None:
    counters: dict[str, int] = {}
    for o in sorted(objs, key=lambda o: (o.kind, round(o.origin[2], 1), round(o.origin[0], 1))):
        counters[o.kind] = counters.get(o.kind, 0) + 1
        o.entity_id = slug_id(f"{o.kind}-{counters[o.kind]:02d}")


def reconstruct_objects(mesh: ScanMesh, structure, *, params: dict | None = None) -> ObjectsResult:
    t0 = time.time()
    prm = ObjectParams()
    hints = parse_hints(params)
    op, segs = segment_objects(mesh, structure, prm.segment, hints)
    segs = attach_to_tables(op, segs)
    t_seg = time.time()
    wall_yaws = _wall_yaws(structure)
    objs = [o for o in (_prepare(op, s, wall_yaws) for s in segs) if o is not None]
    _face_tables(objs)
    _name(objs)
    table = FaceTable(mesh)
    entities: dict[str, dict] = {}
    textures: dict[str, bytes] = {}
    templates: dict[str, dict[str, Any]] = {}
    fits: dict[str, np.ndarray] = {}
    kinds: dict[str, str] = {}
    n_templates = 0
    for group in _groups(objs, prm):
        members = list(group)
        if len(members) >= 2:
            members = _merge_members(members, prm)
            if len(members) >= 2:
                ref = members[0]
                n_templates += 1
                tid = slug_id(f"tpl-{ref.kind}-{n_templates:02d}")
                pooled = Local(
                    np.concatenate([o.local.L for o in members]),
                    np.concatenate([o.local.N for o in members]),
                    np.concatenate([o.C for o in members]),
                    dict(ref.local.info),
                )
                tshape, method = _fit_local(pooled, ref.kind)
                # 取色：各成员的扫描换到模板坐标
                srcs = []
                for k, o in enumerate(members):
                    cs = _color_source(table, o.faces, prm, seed=11 + k)
                    srcs.append((to_local(cs.P, o.origin, o.yaw), dirs_to_local(cs.N, o.yaw), cs.C))
                csrc = ColorSource(
                    np.concatenate([s[0] for s in srcs]),
                    np.concatenate([s[2] for s in srcs]),
                    np.concatenate([s[1] for s in srcs]),
                )
                size = float(np.ptp(pooled.L, axis=0).max())
                finalize_materials(
                    tshape,
                    pooled.L,
                    pooled.C,
                    pooled.N,
                    csrc,
                    prm.texture,
                    size,
                    textures,
                    allow_textures=_textured(ref.kind, size),
                )
                tshape = _clean_shape(tshape)
                templates[tid] = tshape
                entities[tid] = entity_body(
                    entity_id=tid,
                    kind="template",
                    shape=tshape,
                    label=ref.label,
                    textures=_texture_refs(tshape),
                    props={"category": ref.kind, "fitMethod": method, "instances": len(members)},
                )
                for o in members:
                    ishape = sh.instance(tid, xf=sh.transform(position=o.origin.tolist(), yaw=o.yaw))
                    d = _distances(ishape, o.P, templates)
                    fits[o.entity_id] = d
                    kinds[o.entity_id] = o.kind
                    entities[o.entity_id] = entity_body(
                        entity_id=o.entity_id,
                        kind="object",
                        shape=ishape,
                        label=o.label,
                        anchor_id=o.entity_id,
                        fit=fit_stats(d),
                        props={"category": o.kind, "fitMethod": method, "template": tid, "source": o.source},
                        templates=templates,
                    )
                group = [o for o in group if all(o is not m for m in members)]
            else:
                group = list(group)
        for o in group:
            lshape, method = _fit_local(o.local, o.kind)
            wshape = _world_shape(lshape, o.origin, o.yaw)
            csrc = _color_source(table, o.faces, prm, seed=zlib.crc32(o.entity_id.encode()) % 1000)
            size = float(np.ptp(o.local.L, axis=0).max())
            finalize_materials(
                wshape,
                o.P,
                o.C,
                o.N,
                csrc,
                prm.texture,
                size,
                textures,
                allow_textures=_textured(o.kind, size),
            )
            wshape = _clean_shape(wshape)
            d = _distances(wshape, o.P, templates)
            fits[o.entity_id] = d
            kinds[o.entity_id] = o.kind
            entities[o.entity_id] = entity_body(
                entity_id=o.entity_id,
                kind="object",
                shape=wshape,
                label=o.label,
                anchor_id=o.entity_id,
                textures=_texture_refs(wshape),
                fit=fit_stats(d),
                props={"category": o.kind, "fitMethod": method, "source": o.source},
            )
    # 只保留被引用的贴图
    used = {t for body in entities.values() for t in body.get("textures", [])}
    textures = {k: v for k, v in textures.items() if k in used}
    furn = [fits[k] for k in fits if kinds[k] in FURNITURE]
    every = list(fits.values())
    fd = np.concatenate(furn) if furn else np.zeros(0)
    ad = np.concatenate(every) if every else np.zeros(0)
    tex_bytes = sum(len(v) for v in textures.values())
    json_bytes = sum(len(canonical_json(b).encode()) for b in entities.values())
    metrics = {
        "objects": sum(1 for b in entities.values() if b["kind"] == "object"),
        "templates": n_templates,
        "furnitureMeanCm": fit_stats(fd)["meanCm"],
        "furnitureP90Cm": fit_stats(fd)["p90Cm"],
        "furnitureCoverage3cm": fit_stats(fd)["coverage3cm"],
        "allMeanCm": fit_stats(ad)["meanCm"],
        "allP90Cm": fit_stats(ad)["p90Cm"],
        "textures": len(textures),
        "textureBytes": tex_bytes,
        "jsonBytes": json_bytes,
        "bytes": tex_bytes + json_bytes,
        "byKind": {k: sum(1 for v in kinds.values() if v == k) for k in sorted(set(kinds.values()))},
        "perObject": {
            k: {
                "kind": kinds[k],
                "points": len(v),
                "meanCm": round(float(v.mean() * 100), 2) if len(v) else 0.0,
            }
            for k, v in fits.items()
        },
        "segmentStats": op.stats,
        "seconds": {"segment": round(t_seg - t0, 2), "total": round(time.time() - t0, 2)},
    }
    return ObjectsResult(entities, textures, metrics)


def _texture_refs(shape: dict[str, Any]) -> list[str]:
    out: list[str] = []

    def walk(s):
        mat = s.get("material") or {}
        if mat.get("texture"):
            out.append(mat["texture"])
        for c in s.get("children") or []:
            walk(c)

    walk(shape)
    return sorted(set(out))


def _distances(shape: dict[str, Any], P: np.ndarray, templates: dict[str, Any]) -> np.ndarray:
    mesh = merge_meshes([p.mesh for p in build_parts(shape, templates)])
    if len(mesh.indices) == 0 or len(P) == 0:
        return np.full(len(P), 1.0)
    idx = SurfaceIndex.build([mesh], spacing=0.01)
    d, _, _ = idx.query(P, k=4)
    return d
