"""形状词表新增部分在工作台里的兼容层：`plate`、`hull` 两种形状和材质的 `opacity`、`unlit`、`bake`。

`plate`、`hull`、`opacity`、`unlit` 由形状词表扩展加进处理服务的 `shapes.py`（校验、包围盒）和
`processing/shape_mesh.py`（网格）；`bake` 只出现在 AI 物件集里，由写回路径换成贴图。工作台先按 SHAPES 的
规定自己实现一份，处理服务已经认识的就直接用处理服务的实现（合并后自动以它为准）：

- **plate** `{points: [[x,y,z], …]（3–64 个点，平面简单多边形）, thickness: t（0 < t ≤ 1）}`：点的顺序按右手
  定则给出法向（从法向一侧看是逆时针），板从多边形面沿 −法向延伸 thickness；所有点到最佳拟合平面的距离
  ≤ 1 毫米。
- **hull** `{points: [[x,y,z], …]（4–256 个点）}`：这些点的凸包实体；全部共面或共线时无效。
- 材质 `opacity`（0–1，默认 1）、`unlit`（布尔，默认 false），颜色材质和贴图材质都可以带；
  `bake`（`planar` | `box` | `cylindrical`）表示"把扫描颜色烘焙成贴图"，可以带一个 `color` 作为预览色。

校验和包围盒的做法：先按上面的规定检查这些节点，再把它们换成包围盒相同的占位 `group + box`、去掉材质里的
新字段，交给处理服务原有的 `validate_shape` / `shape_bounds`。
"""

from __future__ import annotations

import functools
import math
from collections.abc import Mapping
from typing import Any

import numpy as np

from .. import shapes as sh
from ..processing import shape_mesh as sm

EXT_TYPES = ("plate", "hull")
BAKE_MODES = ("planar", "box", "cylindrical")
PLATE_MIN_POINTS, PLATE_MAX_POINTS = 3, 64
HULL_MIN_POINTS, HULL_MAX_POINTS = 4, 256
PLANAR_TOL = 0.001
MAX_THICKNESS = 1.0
PREVIEW_COLOR = [200, 200, 200]


class ExtShapeError(sh.ShapeError):
    pass


@functools.cache
def native_type(kind: str) -> bool:
    """处理服务的形状词表是否已经认识这种形状。"""
    return kind in getattr(sh, "_FIELDS", {})


@functools.cache
def native_material_key(key: str) -> bool:
    """处理服务的材质校验是否已经认识这个字段（opacity、unlit）。"""
    sample = {"opacity": 0.5, "unlit": True}.get(key)
    try:
        sh.validate_shape({"type": "box", "size": [1, 1, 1], "material": {"color": [1, 1, 1], key: sample}})
    except sh.ShapeError:
        return False
    return True


# ---------------------------------------------------------------------------- plate / hull 几何


def _points(value: Any, lo: int, hi: int, path: str) -> np.ndarray:
    if not isinstance(value, list) or not lo <= len(value) <= hi:
        raise ExtShapeError(f"{path}.points", f"需要 {lo} 到 {hi} 个点")
    out = []
    for i, p in enumerate(value):
        if not (isinstance(p, list) and len(p) == 3 and all(sh._is_number(v) for v in p)):
            raise ExtShapeError(f"{path}.points[{i}]", "点必须是 3 个数字 [x, y, z]")
        for k, v in enumerate(p):
            sh._finite(f"{path}.points[{i}][{k}]", float(v))
        out.append([float(v) for v in p])
    return np.array(out, float)


def newell_normal(P: np.ndarray) -> np.ndarray:
    """多边形的右手法向（Newell 法；从法向一侧看点是逆时针）。没有面积时返回零向量。"""
    Q = np.roll(P, -1, axis=0)
    n = np.array(
        [
            ((P[:, 1] - Q[:, 1]) * (P[:, 2] + Q[:, 2])).sum(),
            ((P[:, 2] - Q[:, 2]) * (P[:, 0] + Q[:, 0])).sum(),
            ((P[:, 0] - Q[:, 0]) * (P[:, 1] + Q[:, 1])).sum(),
        ]
    )
    ln = np.linalg.norm(n)
    return n / ln if ln > 1e-12 else np.zeros(3)


def plate_frame(P: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """平面多边形的局部坐标：(原点, u, v, n)，u × v = n，n 是右手法向。"""
    n = newell_normal(P)
    e = P[1] - P[0]
    u = e - n * (e @ n)
    if np.linalg.norm(u) < 1e-9:
        u = np.cross(n, [1.0, 0, 0]) if abs(n[0]) < 0.9 else np.cross(n, [0, 1.0, 0])
    u /= np.linalg.norm(u)
    v = np.cross(n, u)
    return P.mean(0), u, v, n


def _segments_cross(a, b, c, d) -> bool:
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    o1, o2, o3, o4 = orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)
    return (o1 * o2 < -1e-14) and (o3 * o4 < -1e-14)


def is_simple_polygon(Q: np.ndarray) -> bool:
    n = len(Q)
    for i in range(n):
        a, b = Q[i], Q[(i + 1) % n]
        for j in range(i + 1, n):
            if j == i or (j + 1) % n == i or j == (i + 1) % n:
                continue
            if _segments_cross(a, b, Q[j], Q[(j + 1) % n]):
                return False
    return True


def validate_plate(shape: Mapping[str, Any], path: str = "$") -> None:
    unknown = set(shape) - {"type", "points", "thickness", "transform", "material"}
    if unknown:
        raise ExtShapeError(path, f"plate 有不认识的字段：{sorted(unknown)}")
    P = _points(shape.get("points"), PLATE_MIN_POINTS, PLATE_MAX_POINTS, path)
    t = shape.get("thickness")
    if not sh._is_number(t) or not (0 < float(t) <= MAX_THICKNESS):
        raise ExtShapeError(f"{path}.thickness", "厚度必须大于 0、不超过 1 米")
    n = newell_normal(P)
    if not np.any(n):
        raise ExtShapeError(f"{path}.points", "点共线，围不成多边形")
    # 最佳拟合平面（过质心、法向取协方差最小特征向量）
    c = P.mean(0)
    _, _, vt = np.linalg.svd(P - c)
    dev = np.abs((P - c) @ vt[-1]).max()
    if dev > PLANAR_TOL:
        raise ExtShapeError(
            f"{path}.points", f"点不在同一平面上（最大偏离 {dev * 1000:.1f} 毫米，限 1 毫米）"
        )
    _, u, v, _ = plate_frame(P)
    Q = np.c_[(P - c) @ u, (P - c) @ v]
    if sh.signed_area(Q.tolist()) <= 0:
        raise ExtShapeError(f"{path}.points", "多边形没有面积")
    if not is_simple_polygon(Q):
        raise ExtShapeError(f"{path}.points", "多边形自相交（必须是简单多边形）")


def validate_hull(shape: Mapping[str, Any], path: str = "$") -> None:
    unknown = set(shape) - {"type", "points", "transform", "material"}
    if unknown:
        raise ExtShapeError(path, f"hull 有不认识的字段：{sorted(unknown)}")
    P = _points(shape.get("points"), HULL_MIN_POINTS, HULL_MAX_POINTS, path)
    c = P.mean(0)
    s = np.linalg.svd(P - c, compute_uv=False)
    if s[0] < 1e-9 or s[-1] < 1e-6 * max(s[0], 1e-9):
        raise ExtShapeError(f"{path}.points", "点全部共面或共线，围不成实体")


def plate_points_all(shape: Mapping[str, Any]) -> np.ndarray:
    P = np.array(shape["points"], float)
    n = newell_normal(P)
    return np.vstack([P, P - n * float(shape["thickness"])])


def local_bounds(shape: Mapping[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    P = plate_points_all(shape) if shape["type"] == "plate" else np.array(shape["points"], float)
    return P.min(0), P.max(0)


def plate_mesh(shape: Mapping[str, Any]) -> sm.Mesh:
    """板件网格：顶面（法向 n）、底面（−n）和侧面，平面着色，按包围盒投影贴图坐标。"""
    P = np.array(shape["points"], float)
    c, u, v, n = plate_frame(P)
    t = float(shape["thickness"])
    Q = [(float((p - c) @ u), float((p - c) @ v)) for p in P]
    tris = sm.triangulate(Q)
    k = len(P)
    B = P - n * t
    pos, nrm, idx = [], [], []

    def add(verts, normal, faces):
        base = len(pos)
        pos.extend(verts)
        nrm.extend([normal] * len(verts))
        idx.extend([[base + a, base + b, base + cc] for a, b, cc in faces])

    add(list(P), n, [tuple(tr) for tr in tris])
    add(list(B), -n, [(a, cc, b) for a, b, cc in tris])
    for i in range(k):
        j = (i + 1) % k
        e = P[j] - P[i]
        side = np.cross(e, n)
        ln = np.linalg.norm(side)
        if ln < 1e-12:
            continue
        add([P[i], P[j], B[j], B[i]], side / ln, [(0, 2, 1), (0, 3, 2)])
    mesh = sm.Mesh(np.array(pos), np.array(nrm), np.zeros((len(pos), 2)), np.array(idx, np.int64))
    return sm.project_uvs(mesh, "box")


def hull_mesh(shape: Mapping[str, Any]) -> sm.Mesh:
    """凸包网格：每个面朝外，平面着色，按包围盒投影贴图坐标。"""
    from scipy.spatial import ConvexHull

    P = np.array(shape["points"], float)
    hull = ConvexHull(P)
    c = P[hull.vertices].mean(0)
    pos, nrm, idx = [], [], []
    for simplex, eq in zip(hull.simplices, hull.equations, strict=True):
        a, b, cc = P[simplex]
        normal = eq[:3]
        if np.cross(b - a, cc - a) @ normal < 0:
            b, cc = cc, b
        if (a - c) @ normal < 0:
            normal = -normal
        base = len(pos)
        pos += [a, b, cc]
        nrm += [normal] * 3
        idx.append([base, base + 1, base + 2])
    mesh = sm.Mesh(np.array(pos), np.array(nrm), np.zeros((len(pos), 2)), np.array(idx, np.int64))
    return sm.project_uvs(mesh, "box")


def ext_mesh(shape: Mapping[str, Any]) -> sm.Mesh | None:
    kind = shape.get("type")
    if kind == "plate":
        return plate_mesh(shape)
    if kind == "hull":
        return hull_mesh(shape)
    return None


# ---------------------------------------------------------------------------- 材质


def check_material_extras(material: Any, path: str) -> None:
    if not isinstance(material, Mapping):
        return
    if "opacity" in material:
        o = material["opacity"]
        if not sh._is_number(o) or not 0 <= float(o) <= 1:
            raise ExtShapeError(f"{path}.opacity", "opacity 必须在 0–1 之间")
    if "unlit" in material and not isinstance(material["unlit"], bool):
        raise ExtShapeError(f"{path}.unlit", "unlit 必须是布尔值")
    if "bake" in material:
        if material["bake"] not in BAKE_MODES:
            raise ExtShapeError(f"{path}.bake", f"bake 必须是 {'、'.join(BAKE_MODES)} 之一")
        if material.get("texture") is not None:
            raise ExtShapeError(path, "烘焙指令不能和 texture 一起给（烘焙后由处理服务换成贴图）")


def lowered_material(material: Mapping[str, Any]) -> dict[str, Any]:
    """去掉处理服务还不认识的材质字段；只有烘焙指令时补一个预览色。"""
    out = dict(material)
    out.pop("bake", None)
    for key in ("opacity", "unlit"):
        if key in out and not native_material_key(key):
            out.pop(key)
    if out.get("color") is None and out.get("texture") is None:
        out["color"] = list(PREVIEW_COLOR)
    return out


# ----------------------------------------------------------------------------
# 降级（给处理服务原有的校验和包围盒用）


def lower(shape: Any, path: str = "$") -> Any:
    """返回一份副本：处理服务不认识的 plate / hull 换成包围盒相同的占位组合，材质新字段去掉。
    这些节点按本模块的规则先校验，不合格抛 `ShapeError`。"""
    if not isinstance(shape, Mapping):
        return shape
    out = dict(shape)
    kind = out.get("type")
    if out.get("material") is not None:
        check_material_extras(out["material"], f"{path}.material")
        out["material"] = lowered_material(out["material"])
    if kind in EXT_TYPES and not native_type(kind):
        (validate_plate if kind == "plate" else validate_hull)(shape, path)
        lo, hi = local_bounds(shape)
        size = [max(float(v), 1e-4) for v in hi - lo]
        center = (lo + hi) / 2
        box = {
            "type": "box",
            "size": size,
            "transform": {"position": [float(center[0]), float(lo[1]), float(center[2])]},
        }
        placeholder: dict[str, Any] = {"type": "group", "children": [box]}
        for key in ("transform", "material"):
            if out.get(key) is not None:
                placeholder[key] = out[key]
        return placeholder
    if kind == "group" and isinstance(out.get("children"), list):
        out["children"] = [lower(c, f"{path}.children[{i}]") for i, c in enumerate(out["children"])]
    return out


def validate_shape(shape: Any) -> None:
    sh.validate_shape(lower(shape))


def lower_templates(templates: Mapping[str, Any] | None) -> dict[str, Any]:
    return {k: lower(v) for k, v in (templates or {}).items()}


def shape_bounds(shape: Any, templates: Mapping[str, Any] | None = None) -> sh.Bounds:
    return sh.shape_bounds(lower(shape), lower_templates(templates))


def rounded_shape_bounds(shape: Any, templates: Mapping[str, Any] | None = None) -> sh.Bounds:
    return sh.rounded_bounds(shape_bounds(shape, templates))


def lower_body(body: Mapping[str, Any]) -> dict[str, Any]:
    """物件 body 的副本：形状降级，好交给 `records.validate_entity_body`。"""
    out = dict(body)
    if out.get("shape") is not None:
        out["shape"] = lower(out["shape"])
    return out


def uses_ext(shape: Any) -> list[str]:
    """形状里用到的新增内容（plate、hull、opacity、unlit、bake），提示用。"""
    found: set[str] = set()

    def walk(s):
        if not isinstance(s, Mapping):
            return
        if s.get("type") in EXT_TYPES:
            found.add(s["type"])
        mat = s.get("material")
        if isinstance(mat, Mapping):
            found.update(k for k in ("opacity", "unlit", "bake") if k in mat)
        for c in s.get("children") or []:
            walk(c)

    walk(shape)
    return sorted(found)


# ---------------------------------------------------------------------------- 网格


def build_parts(shape: Mapping[str, Any], templates: Mapping[str, Any] | None = None) -> list[sm.Part]:
    """与 `shape_mesh.build_parts` 相同的遍历，处理服务还不会生成的 plate / hull 用本模块的网格。
    材质原样带着 opacity、unlit、bake（只有烘焙指令时补预览色）。"""
    templates = templates or {}
    stack: list[str] = []

    def mat(m: Mapping[str, Any]) -> dict[str, Any]:
        out = dict(m)
        if out.get("color") is None and out.get("texture") is None:
            out["color"] = list(PREVIEW_COLOR)
        return out

    def node(s, path) -> list[sm.Part]:
        kind = s.get("type")
        parts: list[sm.Part] = []
        if kind == "group":
            for i, child in enumerate(s.get("children") or []):
                parts.extend(node(child, f"{path}.children[{i}]"))
        elif kind == "instance":
            tid = s.get("template")
            tpl = templates.get(tid)
            if tpl is not None and tid not in stack and len(stack) < sm.MAX_TEMPLATE_DEPTH:
                stack.append(tid)
                parts = node(tpl, f"{path}<{tid}>")
                stack.pop()
            if s.get("material") is not None:
                parts = sm._override(parts, mat(s["material"]))
        else:
            mesh = sm.primitive_mesh(s)
            if mesh is None:
                mesh = ext_mesh(s)
            if mesh is None:
                return []
            parts = [sm.Part(mesh, None, path)]
        if kind != "instance" and s.get("material") is not None:
            parts = sm._assign(parts, mat(s["material"]))
        if s.get("transform") is not None:
            m = sm.transform_matrix(s["transform"])
            parts = [sm.Part(sm.apply_matrix(p.mesh, m), p.material, p.path) for p in parts]
        return parts

    return sm._assign(node(shape, "$"), {"color": list(sm.DEFAULT_COLOR)})


def slope_degrees(normal: np.ndarray) -> float:
    """法向与竖直方向的夹角（0 = 水平面，90 = 竖直面）。"""
    n = np.asarray(normal, float)
    return math.degrees(math.acos(min(1.0, abs(n[1]) / max(np.linalg.norm(n), 1e-12))))
