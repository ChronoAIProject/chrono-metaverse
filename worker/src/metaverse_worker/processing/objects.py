"""物体重建（设计 6.3 的"优化模型"）：扫描 → 物体分割 → 测量 → 常见形状拟合 → 同款合并 → 贴图转移 → 自查。

入口 `reconstruct_objects(mesh, structure, params=...)`，mesh 已对齐到空间坐标（y 向上，米），structure 是同一网格上
`extract_structure` 的结果。输出 SHAPES 第 3 节的物件记录 body（`layer: rebuilt`，`kind: object` 或 `template`）、
被引用的贴图（内容哈希 → JPEG 字节）和指标。

流程：

1. **分割**（`fit_segment`）：去掉地面、墙、玻璃带、天花板，聚类，按悬空台面、高矮、颈部、靠背山头拆开；
   `params["objects"]` 里的提示（本地 AI 看图给出）可以改写分割和类型；
2. **识别**：有提示用提示的 `kind`、`label`；没有就按规则（尺寸、座面、台面、颜色、圆度）；
3. **朝向和原点**：最小外接矩形（接近墙的方向时取墙的方向），椅子按靠背定正面，沙发靠背朝 −z；
   原点在物体底面中心的地面上，偏航是连续值；
4. **拟合**（`fit_templates`）：按类型组合圆角盒、带圆弧的挤出、旋转体、扫掠、截面放样；
5. **同款合并**：同类型、尺寸相近的物体（例如一排会议椅）对齐后合并点云拟合一个模板，各处用实例摆放；
   对齐后与其他成员差得多的退出合并、单独拟合；
6. **上色和贴图**（`fit_texture`）：颜色单一的部件用纯色，其余按部件的投影烘焙小贴图；
7. **自查**：每个物体的扫描点到模型的距离（均值、90% 分位、3 厘米内的比例）写进 `fit`，总体写进指标。
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy.spatial import cKDTree

from .. import shapes as sh
from ..canonical import canonical_json
from ..ids import slug_id
from ..records import entity_body
from .bake import FaceTable
from .fit_measure import Rect, dirs_to_local, fit_circle, height_peaks, min_area_rect, to_local
from .fit_segment import ObjectPoints, Segment, SegmentParams, segment_objects
from .fit_templates import (
    Local,
    circularity,
    fit_box,
    fit_chair,
    fit_plant,
    fit_round,
    fit_sofa,
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
    merge_residual: float = 0.035  # 对齐后与其他成员的中位距离超过 3.5 厘米就退出合并
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


def classify(L: np.ndarray, N: np.ndarray, C: np.ndarray, tags: set[str], top_h: float | None) -> str:
    y = L[:, 1]
    H = float(np.percentile(y, 98))
    ext = np.ptp(L[:, [0, 2]], axis=0)
    long_, short = float(max(ext)), float(min(ext))
    if "on-top" in tags:
        return "clutter"
    if top_h is not None:
        return "counter" if top_h > 0.95 and long_ > 1.2 else "table"
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
    if 0.85 < H < 1.35 and long_ > 1.5:
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
    if kind == "table":
        return fit_table(o, o.info.get("top"), o.info.get("thickness")), "table"
    if kind == "chair":
        return fit_chair(o), "chair"
    if kind == "sofa":
        return fit_sofa(o), "sofa"
    if kind == "counter":
        return fit_terrace(o), "terrace"
    if kind == "plant":
        return fit_plant(o), "lathe"
    if kind in ("round", "lamp"):
        return fit_round(o), "lathe"
    ext = np.ptp(o.L, axis=0)
    dims = sorted(ext)
    uv = "planar" if dims[0] < 0.4 * dims[1] else "cylindrical"
    return fit_box(o, uv=uv), "box"


def _color_source(table: FaceTable, faces: np.ndarray, prm: ObjectParams, seed: int) -> ColorSource:
    faces = np.unique(faces)
    area = float(table.area[faces].sum())
    density = min(prm.color_density, prm.max_color_points / max(area, 1e-6))
    rng = np.random.default_rng(seed)
    P, C, N = table.dense(faces, density, rng)
    return ColorSource(P, C, N)


def _icp_2d(src: np.ndarray, ref_tree: cKDTree, iters: int = 6, max_d: float = 0.06):
    """把 src（局部坐标点）在 xz 平面里对齐到参考：返回 (偏航度, dx, dz, 中位残差)。"""
    yaw, tx, tz = 0.0, 0.0, 0.0
    cur = src.copy()
    res = np.inf
    for _ in range(iters):
        d, j = ref_tree.query(cur, k=1)
        ok = d < max_d
        if ok.sum() < 20:
            break
        res = float(np.median(d))
        a = cur[ok][:, [0, 2]]
        b = ref_tree.data[j[ok]][:, [0, 2]]
        ca, cb = a.mean(0), b.mean(0)
        Hm = (a - ca).T @ (b - cb)
        ang = math.atan2(Hm[0, 1] - Hm[1, 0], Hm[0, 0] + Hm[1, 1])
        c, s = math.cos(ang), math.sin(ang)
        R = np.array([[c, -s], [s, c]])
        t = cb - R @ ca
        xz = cur[:, [0, 2]] @ R.T + t
        cur = np.c_[xz[:, 0], cur[:, 1], xz[:, 1]]
        yaw += math.degrees(ang)
        tx, tz = (np.array([tx, tz]) @ R.T + t).tolist()
    d, _ = ref_tree.query(cur, k=1)
    res = float(np.median(d))
    return yaw, tx, tz, res, cur


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
                if (
                    np.all(
                        np.abs(da[[0, 2]] - db[[0, 2]]) <= prm.merge_size_tol * np.maximum(da[[0, 2]], 0.3)
                    )
                    and abs(da[1] - db[1]) <= prm.merge_height_tol
                ):
                    group.append(b)
                    used.add(j)
        out.append(group)
    return out


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
    t_seg = time.time()
    wall_yaws = _wall_yaws(structure)
    objs = [o for o in (_prepare(op, s, wall_yaws) for s in segs) if o is not None]
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
            # ---- 同款合并：对齐到中位成员，合并点云
            ref = max(members, key=lambda o: len(o.P))
            tree = cKDTree(ref.local.L)
            aligned = []
            for o in members:
                if o is ref:
                    aligned.append((o, o.local.L, 0.0))
                    continue
                dyaw, dx, dz, res, cur = _icp_2d(o.local.L, tree)
                if res > prm.merge_residual:
                    continue
                # 局部坐标的修正换回世界：新原点 = 旧原点 + Ry(yaw)·(−R⁻¹ t)，新偏航 = yaw − dyaw
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
                aligned.append((o, o.local.L, res))
            members = [a[0] for a in aligned]
            if len(members) >= 2:
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
                finalize_materials(tshape, pooled.L, pooled.C, pooled.N, csrc, prm.texture, size, textures)
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
            csrc = _color_source(table, o.faces, prm, seed=hash(o.entity_id) % 1000)
            size = float(np.ptp(o.local.L, axis=0).max())
            finalize_materials(wshape, o.P, o.C, o.N, csrc, prm.texture, size, textures)
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
