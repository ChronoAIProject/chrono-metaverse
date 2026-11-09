"""形状词表（SHAPES 2）的网格生成，逐条对照网站的 `web/src/core/shapes/`（box.ts、extrude.ts、lathe.ts、
sweep.ts、loft.ts、outline.ts、uv.ts、build.ts、transform.ts）。

用途：重建模块算拟合偏差（模型表面到扫描的距离）、按网站同样的 UV 投影烘焙贴图、导出查看用的 glb。
所以分段数、硬边判断、UV 投影都和网站一致：贴图在网站上的位置与这里烘焙时的位置相同。

- 三角形按"从外面看逆时针"排列，法线朝外；
- 贴图坐标 v 向上（与 three.js 相同，图片第 0 行 = v 最大）；
- 投影（box / planar / cylindrical）在带材质的那个形状自己的局部坐标里做，包围盒是它下面还没有材质的
  全部网格块的包围盒。
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

EPS = 1e-9
HARD_ANGLE_DEG = 30.0
ARC_STEP = math.pi / 16
EDGE_SEGMENTS = 4
LOFT_UNIFORM_SAMPLES = 48
LOFT_MAX_SAMPLES = 512
LOFT_PARAM_EPS = 1e-4
DEFAULT_COLOR = (200, 200, 200)
MAX_TEMPLATE_DEPTH = 8


@dataclass
class Mesh:
    positions: np.ndarray  # (n, 3)
    normals: np.ndarray  # (n, 3)
    uvs: np.ndarray  # (n, 2)
    indices: np.ndarray  # (m, 3) int64

    @property
    def triangle_count(self) -> int:
        return len(self.indices)

    def triangles(self) -> np.ndarray:
        return self.positions[self.indices]

    def bounds(self) -> tuple[np.ndarray, np.ndarray] | None:
        if len(self.positions) == 0:
            return None
        return self.positions.min(axis=0), self.positions.max(axis=0)

    def area(self) -> float:
        t = self.triangles()
        if len(t) == 0:
            return 0.0
        return float(np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1).sum() / 2)


def empty_mesh() -> Mesh:
    return Mesh(np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 2)), np.zeros((0, 3), np.int64))


def merge_meshes(meshes: Sequence[Mesh]) -> Mesh:
    meshes = [m for m in meshes if len(m.positions)]
    if not meshes:
        return empty_mesh()
    offset = 0
    idx = []
    for m in meshes:
        idx.append(m.indices + offset)
        offset += len(m.positions)
    return Mesh(
        np.concatenate([m.positions for m in meshes]),
        np.concatenate([m.normals for m in meshes]),
        np.concatenate([m.uvs for m in meshes]),
        np.concatenate(idx),
    )


class _Builder:
    def __init__(self) -> None:
        self.p: list[Sequence[float]] = []
        self.n: list[Sequence[float]] = []
        self.uv: list[Sequence[float]] = []
        self.idx: list[tuple[int, int, int]] = []

    def vertex(self, p, n, uv=(0.0, 0.0)) -> int:
        self.p.append((float(p[0]), float(p[1]), float(p[2])))
        self.n.append((float(n[0]), float(n[1]), float(n[2])))
        self.uv.append((float(uv[0]), float(uv[1])))
        return len(self.p) - 1

    def tri(self, a: int, b: int, c: int) -> None:
        self.idx.append((a, b, c))

    def quad(self, a: int, b: int, c: int, d: int) -> None:
        self.idx.append((a, b, c))
        self.idx.append((a, c, d))

    def oriented_quad(self, a: int, b: int, c: int, d: int) -> None:
        pa, pb, pc, pd = (np.asarray(self.p[i]) for i in (a, b, c, d))
        geometric = np.cross(pc - pa, pd - pb)
        expected = np.sum([self.n[i] for i in (a, b, c, d)], axis=0)
        if float(geometric @ expected) >= 0:
            self.quad(a, b, c, d)
        else:
            self.quad(a, d, c, b)

    def oriented_tri(self, a: int, b: int, c: int) -> None:
        pa, pb, pc = (np.asarray(self.p[i]) for i in (a, b, c))
        geometric = np.cross(pb - pa, pc - pa)
        expected = np.sum([self.n[i] for i in (a, b, c)], axis=0)
        if float(geometric @ expected) >= 0:
            self.tri(a, b, c)
        else:
            self.tri(a, c, b)

    def build(self) -> Mesh:
        if not self.p:
            return empty_mesh()
        return Mesh(
            np.asarray(self.p, float),
            np.asarray(self.n, float),
            np.asarray(self.uv, float),
            np.asarray(self.idx, np.int64).reshape(-1, 3),
        )


def drop_degenerate(mesh: Mesh, min_area: float = 1e-14) -> Mesh:
    if len(mesh.indices) == 0:
        return mesh
    t = mesh.positions[mesh.indices]
    n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    keep = (n * n).sum(1) > min_area * min_area * 4
    return Mesh(mesh.positions, mesh.normals, mesh.uvs, mesh.indices[keep])


def flat_shade(mesh: Mesh) -> Mesh:
    t = mesh.positions[mesh.indices].reshape(-1, 3)
    uv = mesh.uvs[mesh.indices].reshape(-1, 2)
    tri = t.reshape(-1, 3, 3)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.where(ln > EPS, n / np.maximum(ln, EPS), [0.0, 1.0, 0.0])
    return Mesh(t, np.repeat(n, 3, axis=0), uv, np.arange(len(t), dtype=np.int64).reshape(-1, 3))


# ---------------------------------------------------------------------------- 小工具


def _positive_or(value: Any, fallback: float) -> float:
    if isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value) and value > 0:
        return float(value)
    return fallback


def _segments_or(value: Any, fallback: int, lo: int = 3, hi: int = 128) -> int:
    raw = fallback
    if isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value):
        raw = math.floor(value + 0.5)
    return max(lo, min(hi, raw))


def _norm(v, fallback):
    v = np.asarray(v, float)
    length = float(np.linalg.norm(v))
    return v / length if length > EPS else np.asarray(fallback, float)


def _signed_area(points) -> float:
    total = 0.0
    n = len(points)
    for i in range(n):
        a, b = points[i], points[(i + 1) % n]
        total += a[0] * b[1] - a[1] * b[0]
    return total / 2.0


def _cross2(a, b) -> float:
    return a[0] * b[1] - a[1] * b[0]


def triangulate(points: Sequence[Sequence[float]]) -> list[tuple[int, int, int]]:
    """简单多边形的耳切法三角化（与 three.js 的 earcut 结果不一定逐个相同，覆盖的区域相同）。"""
    n = len(points)
    if n < 3:
        return []
    pts = [(float(p[0]), float(p[1])) for p in points]
    order = list(range(n))
    if _signed_area(pts) < 0:
        order.reverse()
    out: list[tuple[int, int, int]] = []

    def inside(p, a, b, c) -> bool:
        return (
            _cross2((b[0] - a[0], b[1] - a[1]), (p[0] - a[0], p[1] - a[1])) >= -1e-12
            and _cross2((c[0] - b[0], c[1] - b[1]), (p[0] - b[0], p[1] - b[1])) >= -1e-12
            and _cross2((a[0] - c[0], a[1] - c[1]), (p[0] - c[0], p[1] - c[1])) >= -1e-12
        )

    def reflex_set() -> set[int]:
        m = len(order)
        out_ = set()
        for k in range(m):
            a, b, c = pts[order[(k - 1) % m]], pts[order[k]], pts[order[(k + 1) % m]]
            if _cross2((b[0] - a[0], b[1] - a[1]), (c[0] - b[0], c[1] - b[1])) <= 1e-14:
                out_.add(order[k])
        return out_

    guard = 0
    while len(order) > 3 and guard < 4 * n * n:
        guard += 1
        m = len(order)
        clipped = False
        reflex = reflex_set()
        for k in range(m):
            i0, i1, i2 = order[(k - 1) % m], order[k], order[(k + 1) % m]
            a, b, c = pts[i0], pts[i1], pts[i2]
            if i1 in reflex:
                continue
            if any(
                inside(pts[j], a, b, c) for j in reflex if j not in (i0, i1, i2) and pts[j] not in (a, b, c)
            ):
                continue
            out.append((i0, i1, i2))
            order.pop(k)
            clipped = True
            break
        if not clipped:
            # 退化（共线、自相交）时退回扇形，保证有封口
            for k in range(1, len(order) - 1):
                out.append((order[0], order[k], order[k + 1]))
            return out
    if len(order) == 3:
        out.append((order[0], order[1], order[2]))
    return out


# ---------------------------------------------------------------------------- 二维轮廓


def _dedupe(points, closed: bool) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for p in points:
        q = (float(p[0]), float(p[1]))
        if not (math.isfinite(q[0]) and math.isfinite(q[1])):
            continue
        if not out or math.hypot(q[0] - out[-1][0], q[1] - out[-1][1]) > 1e-9:
            out.append(q)
    if closed and len(out) > 2 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) <= 1e-9:
        out.pop()
    return out


def mark_hard(points, closed: bool) -> list[bool]:
    threshold = math.cos(math.radians(HARD_ANGLE_DEG))
    n = len(points)
    out = []
    for i, p in enumerate(points):
        if not closed and (i == 0 or i == n - 1):
            out.append(True)
            continue
        prev, nxt = points[(i - 1) % n], points[(i + 1) % n]
        d1 = (p[0] - prev[0], p[1] - prev[1])
        d2 = (nxt[0] - p[0], nxt[1] - p[1])
        l1, l2 = math.hypot(*d1), math.hypot(*d2)
        if l1 < EPS or l2 < EPS:
            out.append(False)
            continue
        out.append((d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2) < threshold)
    return out


def arc_points(p0, p1, bulge: float, outward_sign: float) -> list[tuple[float, float]]:
    cx, cy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(cx, cy)
    if length < EPS or not math.isfinite(bulge) or abs(bulge) < 1e-9:
        return []
    b = max(-1e3, min(1e3, bulge))
    half = length / 2
    sagitta = b * half
    outward = (cy * outward_sign / length, -cx * outward_sign / length)
    mid = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
    radius = (half * half + sagitta * sagitta) / (2 * abs(sagitta))
    sg = math.copysign(1.0, sagitta)
    toward = (outward[0] * sg, outward[1] * sg)
    center = (mid[0] + toward[0] * (abs(sagitta) - radius), mid[1] + toward[1] * (abs(sagitta) - radius))
    arc_mid = (mid[0] + toward[0] * abs(sagitta), mid[1] + toward[1] * abs(sagitta))
    theta = 4 * math.atan(abs(b))
    start = math.atan2(p0[1] - center[1], p0[0] - center[0])
    direction = (
        1
        if _cross2((p0[0] - center[0], p0[1] - center[1]), (arc_mid[0] - center[0], arc_mid[1] - center[1]))
        >= 0
        else -1
    )
    steps = max(2, 2 * math.ceil(theta / (2 * ARC_STEP)))
    out = []
    for k in range(1, steps):
        angle = start + direction * theta * (k / steps)
        out.append((center[0] + radius * math.cos(angle), center[1] + radius * math.sin(angle)))
    return out


def fillet_points(prev, corner, nxt, radius: float, max_tangent: float) -> list[tuple[float, float]]:
    d1 = _norm((corner[0] - prev[0], corner[1] - prev[1]), (1.0, 0.0))
    d2 = _norm((nxt[0] - corner[0], nxt[1] - corner[1]), (1.0, 0.0))
    turn = math.acos(max(-1.0, min(1.0, float(d1 @ d2))))
    if not radius > 0 or turn < 1e-6 or math.pi - turn < 1e-6:
        return [tuple(corner)]
    half_tan = math.tan(turn / 2)
    tangent = min(radius * half_tan, max(0.0, max_tangent))
    if tangent < 1e-9:
        return [tuple(corner)]
    r = tangent / half_tan
    t1 = (corner[0] - d1[0] * tangent, corner[1] - d1[1] * tangent)
    t2 = (corner[0] + d2[0] * tangent, corner[1] + d2[1] * tangent)
    side = 1 if _cross2(d1, d2) > 0 else -1
    inward = (-d1[1], d1[0]) if side > 0 else (d1[1], -d1[0])
    center = (t1[0] + inward[0] * r, t1[1] + inward[1] * r)
    start = math.atan2(t1[1] - center[1], t1[0] - center[0])
    steps = max(2, math.ceil(turn / ARC_STEP))
    out = [t1]
    for k in range(1, steps):
        angle = start + side * turn * (k / steps)
        out.append((center[0] + r * math.cos(angle), center[1] + r * math.sin(angle)))
    out.append(t2)
    return out


def _corner_points(points, radii, i: int, closed: bool):
    n = len(points)

    def has(k: int) -> bool:
        return radii[k] > 0 and (closed or 0 < k < n - 1)

    point = points[i]
    if not has(i):
        return [point]
    ip, inx = (i - 1) % n, (i + 1) % n
    prev, nxt = points[ip], points[inx]
    prev_share = 0.5 if has(ip) else 1.0
    next_share = 0.5 if has(inx) else 1.0
    max_tangent = min(
        math.hypot(prev[0] - point[0], prev[1] - point[1]) * prev_share,
        math.hypot(point[0] - nxt[0], point[1] - nxt[1]) * next_share,
    )
    return fillet_points(prev, point, nxt, radii[i], max_tangent)


def fillet_polyline(points, radii, closed: bool):
    out = []
    for i in range(len(points)):
        out.extend(_corner_points(points, radii, i, closed))
    return _dedupe(out, closed)


def expand_outline(outline: Mapping[str, Any], force_closed: bool | None = None):
    """二维轮廓 → (点, 硬点标记, 是否闭合)：展开圆弧和圆角。"""
    closed = force_closed if force_closed is not None else outline.get("closed") is not False
    base = _dedupe(outline.get("points") or [], closed)
    if len(base) < 2:
        return base, [True] * len(base), closed
    n = len(base)
    orientation = -1 if closed and _signed_area(base) < 0 else 1
    segment_count = n if closed else n - 1
    bulges: dict[int, float] = {}
    for arc in outline.get("arcs") or []:
        f = arc.get("from")
        if isinstance(f, int) and 0 <= f < segment_count:
            bulges[f] = float(arc.get("bulge", 0))
    radii = [0.0] * n
    for fl in outline.get("fillets") or []:
        at = fl.get("at")
        if not isinstance(at, int) or at < 0 or at >= n:
            continue
        before = (at - 1) % n
        if at in bulges or ((closed or at > 0) and before in bulges):
            continue
        r = float(fl.get("radius", 0))
        if math.isfinite(r) and r > 0:
            radii[at] = r
    out = []
    for i in range(n):
        out.extend(_corner_points(base, radii, i, closed))
        if i in bulges and (closed or i < n - 1):
            out.extend(arc_points(base[i], base[(i + 1) % n], bulges[i], orientation))
    pts = _dedupe(out, closed)
    return pts, mark_hard(pts, closed), closed


def _edge_normals(points, closed: bool):
    orientation = -1 if closed and _signed_area(points) < 0 else 1
    count = len(points) if closed else len(points) - 1
    out = []
    for i in range(count):
        a, b = points[i], points[(i + 1) % len(points)]
        d = _norm((b[0] - a[0], b[1] - a[1]), (1.0, 0.0))
        out.append(np.array([d[1] * orientation, -d[0] * orientation]))
    return out


def _offset_inward(points, delta: float):
    if delta == 0:
        return [np.array(p, float) for p in points]
    normals = _edge_normals(points, True)
    n = len(points)
    out = []
    for i, p in enumerate(points):
        before, after = normals[(i - 1) % n], normals[i]
        s = before + after
        denom = 1 + float(before @ after)
        miter = s / denom if denom > 0.05 else after
        out.append(np.array(p, float) - miter * delta)
    return out


# ---------------------------------------------------------------------------- 基本形体


def box_mesh(shape: Mapping[str, Any]) -> Mesh:
    size = shape.get("size") or [1, 1, 1]
    w, h, d = (_positive_or(v, 0.0) for v in size)
    limit = min(w, h, d) / 2
    fillet = min(_positive_or(shape.get("fillet"), 0.0), limit)
    chamfer = 0.0 if fillet > 0 else min(_positive_or(shape.get("chamfer"), 0.0), limit)
    radius = fillet if fillet > 0 else chamfer
    segments = _segments_or(shape.get("segments"), 4, 1, 32) if fillet > 0 else 1
    center = np.array([0.0, h / 2, 0.0])
    half = np.array([w / 2, h / 2, d / 2])
    inner = half - radius
    b = _Builder()

    def point(signs, normal, along=None):
        p = np.zeros(3)
        for k in range(3):
            base = along[1] if along is not None and along[0] == k else signs[k] * inner[k]
            p[k] = center[k] + base + radius * normal[k]
        return p

    for a in range(3):
        bb, cc = (a + 1) % 3, (a + 2) % 3
        if inner[bb] <= 1e-12 or inner[cc] <= 1e-12:
            continue
        for sign in (1, -1):
            normal = np.zeros(3)
            normal[a] = sign
            ids = []
            for sb, sc in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                p = center.copy()
                p[a] = center[a] + sign * half[a]
                p[bb] = center[bb] + sb * inner[bb]
                p[cc] = center[cc] + sc * inner[cc]
                ids.append(b.vertex(p, normal))
            b.oriented_quad(*ids)
    if radius > 0:
        for c in range(3):
            a, bb = (c + 1) % 3, (c + 2) % 3
            if inner[c] <= 1e-12:
                continue
            for sa in (1, -1):
                for sb in (1, -1):
                    rows = []
                    for k in range(segments + 1):
                        phi = k / segments * (math.pi / 2)
                        normal = np.zeros(3)
                        normal[a] = sa * math.cos(phi)
                        normal[bb] = sb * math.sin(phi)
                        signs = np.zeros(3)
                        signs[a], signs[bb] = sa, sb
                        rows.append(
                            [b.vertex(point(signs, normal, (c, sc * inner[c])), normal) for sc in (-1, 1)]
                        )
                    for k in range(segments):
                        b.oriented_quad(rows[k][0], rows[k][1], rows[k + 1][1], rows[k + 1][0])
        for sx in (1, -1):
            for sy in (1, -1):
                for sz in (1, -1):
                    signs = np.array([sx, sy, sz], float)
                    grid = []
                    for i in range(segments + 1):
                        theta = i / segments * (math.pi / 2)
                        row = []
                        for j in range(segments + 1):
                            phi = j / segments * (math.pi / 2)
                            normal = np.array(
                                [
                                    sx * math.sin(theta) * math.cos(phi),
                                    sy * math.cos(theta),
                                    sz * math.sin(theta) * math.sin(phi),
                                ]
                            )
                            row.append(b.vertex(point(signs, normal), normal))
                        grid.append(row)
                    for i in range(segments):
                        for j in range(segments):
                            b.oriented_quad(grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j])
    mesh = drop_degenerate(b.build())
    if chamfer > 0:
        mesh = flat_shade(mesh)
    return project_uvs(mesh, "box")


def lathe_profile_mesh(profile_input, segments_input, angle_input) -> Mesh:
    profile = [(max(0.0, p[0]), p[1]) for p in _dedupe(profile_input, False)]
    if len(profile) < 2:
        return empty_mesh()
    segments = _segments_or(segments_input, 32, 3, 256)
    angle_deg = max(1e-3, min(360.0, _positive_or(angle_input, 360.0)))
    angle = math.radians(angle_deg)
    full = angle_deg >= 360 - 1e-6
    steps = segments if full else max(1, math.ceil(segments * angle_deg / 360))
    orientation = -1 if _signed_area(profile) < 0 else 1
    seg_normals = []
    for j in range(len(profile) - 1):
        d = _norm((profile[j + 1][0] - profile[j][0], profile[j + 1][1] - profile[j][1]), (1.0, 0.0))
        seg_normals.append(np.array([d[1] * orientation, -d[0] * orientation]))
    hard = mark_hard(profile, False)

    def vertex_normal(j: int, segment: int):
        if hard[j]:
            return seg_normals[segment]
        return _norm(seg_normals[j - 1] + seg_normals[j], (1.0, 0.0))

    lengths = [0.0]
    for j in range(1, len(profile)):
        lengths.append(
            lengths[-1] + math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1])
        )
    total = max(lengths[-1], 1e-9)
    b = _Builder()

    def ring(point, normal, v):
        ids = []
        for i in range(steps + 1):
            theta = i / steps * angle
            s, c = math.sin(theta), math.cos(theta)
            ids.append(
                b.vertex(
                    (point[0] * s, point[1], point[0] * c),
                    (normal[0] * s, normal[1], normal[0] * c),
                    (i / steps, v),
                )
            )
        return ids

    for j in range(len(profile) - 1):
        ra = ring(profile[j], vertex_normal(j, j), lengths[j] / total)
        rb = ring(profile[j + 1], vertex_normal(j + 1, j), lengths[j + 1] / total)
        for i in range(steps):
            b.oriented_quad(ra[i], ra[i + 1], rb[i + 1], rb[i])
    if not full:
        polygon = list(profile)
        first, last = profile[0], profile[-1]
        if last[0] > 1e-9:
            polygon.append((0.0, last[1]))
        if first[0] > 1e-9:
            polygon.append((0.0, first[1]))
        contour = _dedupe(polygon, True)
        tris = triangulate(contour)
        for theta, sign in ((0.0, -1), (angle, 1)):
            s, c = math.sin(theta), math.cos(theta)
            normal = (c * sign, 0.0, -s * sign)
            ids = [b.vertex((r * s, y, r * c), normal, (r, y)) for r, y in contour]
            for t in tris:
                b.oriented_tri(ids[t[0]], ids[t[1]], ids[t[2]])
    return drop_degenerate(b.build())


def lathe_mesh(shape) -> Mesh:
    return lathe_profile_mesh(shape.get("profile") or [], shape.get("segments"), shape.get("angle"))


def cylinder_mesh(shape) -> Mesh:
    radius = _positive_or(shape.get("radius"), 0.0)
    height = _positive_or(shape.get("height"), 0.0)
    rt = shape.get("radiusTop")
    top = radius if rt is None else max(0.0, float(rt) if isinstance(rt, int | float) else 0.0)
    profile = [(0.0, 0.0), (radius, 0.0), (top, height), (0.0, height)]
    fillet = _positive_or(shape.get("fillet"), 0.0)
    radii = [0.0, fillet, fillet if top > 0 else 0.0, 0.0]
    points = fillet_polyline(profile, radii, False) if fillet > 0 else profile
    return lathe_profile_mesh(points, shape.get("segments"), 360)


def cone_mesh(shape) -> Mesh:
    radius = _positive_or(shape.get("radius"), 0.0)
    height = _positive_or(shape.get("height"), 0.0)
    return lathe_profile_mesh([(0.0, 0.0), (radius, 0.0), (0.0, height)], shape.get("segments"), 360)


def _side_bands(height: float, edge: float, chamfer: bool):
    def wall(y0, y1):
        return [(0.0, y0, 1.0, 0.0), (0.0, y1, 1.0, 0.0)]

    if edge <= 0:
        return [wall(0.0, height)]
    if chamfer:
        d = math.sqrt(0.5)
        return [
            [(edge, 0.0, d, -d), (0.0, edge, d, -d)],
            wall(edge, height - edge),
            [(0.0, height - edge, d, d), (edge, height, d, d)],
        ]
    rings = []
    for k in range(EDGE_SEGMENTS + 1):
        a = k / EDGE_SEGMENTS * (math.pi / 2)
        rings.append((edge * (1 - math.sin(a)), edge * (1 - math.cos(a)), math.sin(a), -math.cos(a)))
    for k in range(EDGE_SEGMENTS + 1):
        a = k / EDGE_SEGMENTS * (math.pi / 2)
        rings.append((edge * (1 - math.cos(a)), height - edge + edge * math.sin(a), math.cos(a), math.sin(a)))
    return [rings]


def _open_strip(points, height: float) -> Mesh:
    b = _Builder()
    along = 0.0
    for i in range(len(points) - 1):
        a, c = points[i], points[i + 1]
        d = _norm((c[0] - a[0], c[1] - a[1]), (1.0, 0.0))
        step = math.hypot(c[0] - a[0], c[1] - a[1])
        for side in (1, -1):
            n = (d[1] * side, 0.0, -d[0] * side)
            ids = [
                b.vertex((a[0], 0, a[1]), n, (along, 0)),
                b.vertex((c[0], 0, c[1]), n, (along + step, 0)),
                b.vertex((c[0], height, c[1]), n, (along + step, height)),
                b.vertex((a[0], height, a[1]), n, (along, height)),
            ]
            b.oriented_quad(*ids)
        along += step
    return b.build()


def extrude_mesh(shape) -> Mesh:
    height = _positive_or(shape.get("height"), 0.0)
    points, hard, closed = expand_outline(shape.get("outline") or {"points": []})
    if len(points) < 2 or height <= 0:
        return empty_mesh()
    if not closed:
        return _open_strip(points, height)
    if len(points) < 3:
        return empty_mesh()
    arr = np.asarray(points)
    span = arr.max(0) - arr.min(0)
    limit = min(height / 2, min(span[0], span[1]) / 4)
    fillet_in = _positive_or(shape.get("fillet"), 0.0)
    chamfer = False if fillet_in > 0 else _positive_or(shape.get("chamfer"), 0.0) > 0
    edge = min(fillet_in if fillet_in > 0 else _positive_or(shape.get("chamfer"), 0.0), limit)
    bands = _side_bands(height, edge, chamfer)
    n = len(points)
    normals = _edge_normals(points, True)
    cache: dict[float, list[np.ndarray]] = {}

    def inset(delta):
        if delta not in cache:
            cache[delta] = _offset_inward(points, delta)
        return cache[delta]

    def vertex_normal(i, segment):
        if hard[i]:
            return normals[segment]
        return _norm(normals[(i - 1) % n] + normals[i], (1.0, 0.0))

    b = _Builder()
    along = 0.0
    for s in range(n):
        ia, ib = s, (s + 1) % n
        step = math.hypot(points[ib][0] - points[ia][0], points[ib][1] - points[ia][1])
        columns = [(ia, vertex_normal(ia, s), along), (ib, vertex_normal(ib, s), along + step)]
        for rings in bands:
            ids = []
            for index, normal, u in columns:
                col = []
                for ins, y, hor, ver in rings:
                    p = inset(ins)[index]
                    col.append(b.vertex((p[0], y, p[1]), (normal[0] * hor, ver, normal[1] * hor), (u, y)))
                ids.append(col)
            for k in range(len(rings) - 1):
                b.oriented_quad(ids[0][k], ids[1][k], ids[1][k + 1], ids[0][k + 1])
        along += step
    cap = inset(edge)
    tris = triangulate([(p[0], p[1]) for p in cap])
    for y, ny in ((0.0, -1.0), (height, 1.0)):
        ids = [b.vertex((p[0], y, p[1]), (0, ny, 0), (p[0], p[1])) for p in cap]
        for t in tris:
            b.oriented_tri(ids[t[0]], ids[t[1]], ids[t[2]])
    return drop_degenerate(b.build())


def _rotate(v, axis, angle):
    c, s = math.cos(angle), math.sin(angle)
    return v * c + np.cross(axis, v) * s + axis * float(axis @ v) * (1 - c)


def smooth_path(path, radius: float):
    if not radius > 0 or len(path) < 3:
        return [np.asarray(p, float) for p in path]
    out = [np.asarray(path[0], float)]
    for i in range(1, len(path) - 1):
        prev, corner, nxt = (np.asarray(path[k], float) for k in (i - 1, i, i + 1))
        d1 = _norm(corner - prev, (0, 1, 0))
        d2 = _norm(nxt - corner, (0, 1, 0))
        turn = math.acos(max(-1.0, min(1.0, float(d1 @ d2))))
        if turn < 1e-6 or math.pi - turn < 1e-6:
            out.append(corner)
            continue
        half_tan = math.tan(turn / 2)
        max_tangent = min(np.linalg.norm(corner - prev), np.linalg.norm(nxt - corner)) / 2
        tangent = min(radius * half_tan, max_tangent)
        r = tangent / half_tan
        t1 = corner - d1 * tangent
        inward = _norm(d2 - d1 * float(d1 @ d2), (0, 1, 0))
        center = t1 + inward * r
        u = t1 - center
        w = d1 * r
        steps = max(2, math.ceil(turn / ARC_STEP))
        for k in range(steps + 1):
            a = k / steps * turn
            out.append(center + u * math.cos(a) + w * math.sin(a))
    out.append(np.asarray(path[-1], float))
    return out


def _section_points(shape):
    section = shape.get("section") or {"circle": 0.02}
    if "rect" in section:
        w = _positive_or((section.get("rect") or [0.02, 0.02])[0], 0.02) / 2
        h = _positive_or((section.get("rect") or [0.02, 0.02])[1], 0.02) / 2
        sides = [
            ((w, -h), (w, h), (1, 0)),
            ((w, h), (-w, h), (0, 1)),
            ((-w, h), (-w, -h), (-1, 0)),
            ((-w, -h), (w, -h), (0, -1)),
        ]
        out = []
        for i, (a, c, n) in enumerate(sides):
            out.append((a, n, i / 4))
            out.append((c, n, (i + 1) / 4))
        return out, True
    radius = _positive_or(section.get("circle"), 0.02)
    segments = _segments_or(shape.get("segments"), 16, 3, 64)
    out = []
    for k in range(segments + 1):
        ang = k / segments * math.pi * 2
        c, s = math.cos(ang), math.sin(ang)
        out.append(((radius * c, radius * s), (c, s), k / segments))
    return out, False


def sweep_mesh(shape) -> Mesh:
    raw = []
    for p in shape.get("path") or []:
        q = np.asarray(p, float)
        if not np.all(np.isfinite(q)):
            continue
        if not raw or np.linalg.norm(q - raw[-1]) > 1e-9:
            raw.append(q)
    path = smooth_path(raw, _positive_or(shape.get("smooth"), 0.0))
    if len(path) < 2:
        return empty_mesh()
    section, is_rect = _section_points(shape)
    if is_rect:
        edges = [(i, i + 1) for i in range(0, len(section), 2)]
    else:
        edges = [(i, i + 1) for i in range(len(section) - 1)]
    tangents = [_norm(path[i + 1] - path[i], (0, 1, 0)) for i in range(len(path) - 1)]
    lengths = [0.0]
    for i in range(1, len(path)):
        lengths.append(lengths[-1] + float(np.linalg.norm(path[i] - path[i - 1])))
    total = max(lengths[-1], EPS)

    def initial_normal(t):
        ref = np.array([0.0, 1.0, 0.0]) if abs(t[1]) < 0.9 else np.array([0.0, 0.0, 1.0])
        return _norm(ref - t * float(ref @ t), (0, 1, 0))

    seg_normals = [initial_normal(tangents[0])]
    for i in range(1, len(tangents)):
        before, after = tangents[i - 1], tangents[i]
        axis = np.cross(before, after)
        sin = float(np.linalg.norm(axis))
        prev = seg_normals[i - 1]
        moved = _rotate(prev, axis / sin, math.atan2(sin, float(before @ after))) if sin > 1e-9 else prev
        seg_normals.append(_norm(moved - after * float(moved @ after), (0, 1, 0)))
    hard_cos = math.cos(math.radians(HARD_ANGLE_DEG))
    b = _Builder()

    def ring(i, segment):
        t_in = tangents[max(0, i - 1)]
        t_out = tangents[min(len(tangents) - 1, i)]
        interior = 0 < i < len(path) - 1
        t_avg = _norm(t_in + t_out, t_out) if interior else (t_out if i == 0 else t_in)
        hard = interior and float(t_in @ t_out) < hard_cos
        n_ref = seg_normals[min(i, len(seg_normals) - 1)]
        if interior:
            axis = np.cross(t_in, t_out)
            sin = float(np.linalg.norm(axis))
            n_ref = seg_normals[i - 1]
            if sin > 1e-9:
                n_ref = _rotate(n_ref, axis / sin, math.atan2(sin, float(t_in @ t_out)) / 2)
        n_axis = _norm(n_ref - t_avg * float(n_ref @ t_avg), (0, 1, 0))
        b_axis = _norm(np.cross(t_avg, n_axis), (0, 1, 0))
        cos_half = max(float(t_avg @ t_out), 0.2)
        bend = _norm(t_out - t_in, n_axis) if interior else n_axis
        t_seg = tangents[segment]
        ids = []
        for offset, normal, u in section:
            o = b_axis * offset[0] + n_axis * offset[1]
            stretched = o + bend * float(o @ bend) * (1 / cos_half - 1)
            nn = b_axis * normal[0] + n_axis * normal[1]
            if hard:
                nn = _norm(nn - t_seg * float(nn @ t_seg), nn)
            ids.append(b.vertex(path[i] + stretched, _norm(nn, (0, 1, 0)), (u, lengths[i] / total)))
        return ids

    for s in range(len(tangents)):
        ra, rb = ring(s, s), ring(s + 1, s)
        for e0, e1 in edges:
            b.oriented_quad(ra[e0], ra[e1], rb[e1], rb[e0])
    if shape.get("caps") is not False:
        for i, normal in ((0, -tangents[0]), (len(path) - 1, tangents[-1])):
            segment = 0 if i == 0 else len(tangents) - 1
            n = seg_normals[segment]
            t = tangents[segment]
            b_axis = _norm(np.cross(t, n), (0, 1, 0))
            center = b.vertex(path[i], normal, (0.5, 0.5))
            if is_rect:
                rim_pts = [section[k][0] for k in range(0, len(section), 2)]
            else:
                rim_pts = [section[k][0] for k in range(len(section) - 1)]
            rim = [
                b.vertex(path[i] + b_axis * o[0] + n * o[1], normal, (0.5 + o[0], 0.5 + o[1]))
                for o in rim_pts
            ]
            for k in range(len(rim)):
                b.oriented_tri(center, rim[k], rim[(k + 1) % len(rim)])
    return drop_degenerate(b.build())


def _prepare_section(y, raw_points, raw_hard):
    if len(raw_points) < 3:
        return None
    points, hard = list(raw_points), list(raw_hard)
    if _signed_area(points) < 0:
        points.reverse()
        hard.reverse()
    cx = sum(p[0] for p in points) / len(points)
    cz = sum(p[1] for p in points) / len(points)
    best = None
    for i in range(len(points)):
        a, c = points[i], points[(i + 1) % len(points)]
        if (a[1] - cz) * (c[1] - cz) > 0 or a[1] == c[1]:
            continue
        s = (cz - a[1]) / (c[1] - a[1])
        x = a[0] + s * (c[0] - a[0])
        t = x - cx
        if t >= 0 and (best is None or t < best[1]):
            best = (i, t, s)
    if best is not None:
        edge, _, s = best
        a, c = points[edge], points[(edge + 1) % len(points)]
        start = (a[0] + s * (c[0] - a[0]), a[1] + s * (c[1] - a[1]))
        rot, roth = [], []
        for k in range(1, len(points) + 1):
            idx = (edge + k) % len(points)
            rot.append(points[idx])
            roth.append(hard[idx])
        first, last = rot[0], rot[-1]
        if (
            math.hypot(start[0] - first[0], start[1] - first[1]) > 1e-9
            and math.hypot(start[0] - last[0], start[1] - last[1]) > 1e-9
        ):
            rot.insert(0, start)
            roth.insert(0, False)
        elif math.hypot(start[0] - last[0], start[1] - last[1]) <= 1e-9:
            rot.insert(0, rot.pop())
            roth.insert(0, roth.pop())
        points, hard = rot, roth
    lengths = [0.0]
    for i in range(1, len(points) + 1):
        a, c = points[i % len(points)], points[i - 1]
        lengths.append(lengths[-1] + math.hypot(a[0] - c[0], a[1] - c[1]))
    perimeter = lengths[len(points)]
    if not perimeter > 0:
        return None
    return {"y": y, "points": points, "hard": hard, "params": [v / perimeter for v in lengths[:-1]]}


def _sample_at(section, t):
    points, params = section["points"], section["params"]
    n = len(points)
    for i in range(n):
        t0 = params[i]
        t1 = params[i + 1] if i + 1 < n else 1.0
        if t0 - 1e-12 <= t <= t1 + 1e-12:
            f = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
            a, c = points[i], points[(i + 1) % n]
            return (a[0] + f * (c[0] - a[0]), a[1] + f * (c[1] - a[1]))
    return points[0]


def loft_mesh(shape) -> Mesh:
    secs = [s for s in (shape.get("sections") or [])[:8] if isinstance(s.get("y"), int | float)]
    secs.sort(key=lambda s: s["y"])
    sections = []
    for s in secs:
        pts, hard, _ = expand_outline(s.get("outline") or {"points": []}, True)
        prepared = _prepare_section(float(s["y"]), pts, hard)
        if prepared is not None:
            sections.append(prepared)
    if len(sections) < 2:
        return empty_mesh()
    entries = [(k / LOFT_UNIFORM_SAMPLES, False) for k in range(LOFT_UNIFORM_SAMPLES)]
    for sec in sections:
        entries.extend(zip(sec["params"], sec["hard"], strict=True))
    entries.sort(key=lambda e: e[0])
    params: list[float] = []
    hard: list[bool] = []
    for t, hd in entries:
        if params and t - params[-1] < LOFT_PARAM_EPS:
            hard[-1] = hard[-1] or hd
            continue
        if 1 - t < LOFT_PARAM_EPS:
            hard[0] = hard[0] or hd
            continue
        params.append(t)
        hard.append(hd)
    if len(params) > LOFT_MAX_SAMPLES:
        stride = math.ceil(len(params) / LOFT_MAX_SAMPLES)
        keep = [hard[i] or i % stride == 0 for i in range(len(params))]
        params = [p for p, k in zip(params, keep, strict=True) if k]
        hard = [h for h, k in zip(hard, keep, strict=True) if k]
    columns = len(params)
    rings = []
    for sec in sections:
        row = []
        for t in params:
            x, z = _sample_at(sec, t)
            row.append(np.array([x, sec["y"], z]))
        rings.append(row)
    y0, yn = sections[0]["y"], sections[-1]["y"]

    def v_of(y):
        return (y - y0) / (yn - y0) if yn > y0 else 0.0

    b = _Builder()
    hard_cols = [i for i, h in enumerate(hard) if h]
    starts = hard_cols if hard_cols else [0]
    for p in range(len(starts)):
        frm = starts[p]
        to = starts[p + 1] if p + 1 < len(starts) else starts[0] + columns
        span = to - frm
        if span <= 0:
            continue
        cols = [(frm + k) % columns for k in range(span + 1)]
        normals = [[np.zeros(3) for _ in cols] for _ in rings]
        for r in range(len(rings) - 1):
            for c in range(span):
                a = rings[r][cols[c]]
                bb = rings[r][cols[c + 1]]
                ct = rings[r + 1][cols[c + 1]]
                d = rings[r + 1][cols[c]]
                face = np.cross(d - bb, ct - a)
                for rr, cc in ((r, c), (r, c + 1), (r + 1, c + 1), (r + 1, c)):
                    normals[rr][cc] = normals[rr][cc] + face
        ids = []
        for r, ring in enumerate(rings):
            row = []
            for c, col in enumerate(cols):
                u = 1.0 if frm + c >= columns else params[col]
                row.append(b.vertex(ring[col], _norm(normals[r][c], (0, 1, 0)), (u, v_of(ring[col][1]))))
            ids.append(row)
        for r in range(len(rings) - 1):
            for c in range(span):
                b.oriented_quad(ids[r][c], ids[r][c + 1], ids[r + 1][c + 1], ids[r + 1][c])
    for sec, ny in ((sections[0], -1.0), (sections[-1], 1.0)):
        tris = triangulate(sec["points"])
        ids = [b.vertex((x, sec["y"], z), (0, ny, 0), (x, z)) for x, z in sec["points"]]
        for t in tris:
            b.oriented_tri(ids[t[0]], ids[t[1]], ids[t[2]])
    return drop_degenerate(b.build())


# ---------------------------------------------------------------------------- UV、变换、组合


def project_uvs(mesh: Mesh, mode: str, bounds=None) -> Mesh:
    """与网站 uv.ts 相同：box 按顶点法线主轴三面投影，planar 沿包围盒最薄的轴，cylindrical 绕竖直中轴展开。"""
    if mode == "mesh" or len(mesh.positions) == 0:
        return mesh
    lo, hi = bounds if bounds is not None else mesh.bounds()
    size = np.maximum(hi - lo, 1e-9)
    P = mesh.positions
    unit = (P - lo) / size
    uv = np.zeros((len(P), 2))
    if mode == "cylindrical":
        cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
        uv[:, 0] = np.arctan2(P[:, 0] - cx, P[:, 2] - cz) / (2 * math.pi) + 0.5
        uv[:, 1] = unit[:, 1]
    else:
        if mode == "box":
            an = np.abs(mesh.normals)
            axis = np.where(
                (an[:, 0] >= an[:, 1]) & (an[:, 0] >= an[:, 2]), 0, np.where(an[:, 1] >= an[:, 2], 1, 2)
            )
        else:
            axis = np.full(len(P), int(np.argmin(size)))
        uv[:, 0] = np.where(axis == 0, unit[:, 2], unit[:, 0])
        uv[:, 1] = np.where(axis == 1, unit[:, 2], unit[:, 1])
    return Mesh(mesh.positions, mesh.normals, uv, mesh.indices)


def _sin_cos(deg: float) -> tuple[float, float]:
    r = math.radians(deg)
    return math.sin(r), math.cos(r)


def transform_matrix(xf: Mapping[str, Any] | None) -> np.ndarray:
    """M = T · Ry(yaw) · Rx(pitch) · Rz(roll) · S。"""
    xf = xf or {}
    sy, cy = _sin_cos(float(xf.get("yaw") or 0))
    sx, cx = _sin_cos(float(xf.get("pitch") or 0))
    sz, cz = _sin_cos(float(xf.get("roll") or 0))
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    scale = xf.get("scale") or [1, 1, 1]
    m = np.eye(4)
    m[:3, :3] = ry @ rx @ rz @ np.diag([float(v) for v in scale])
    m[:3, 3] = [float(v) for v in (xf.get("position") or [0, 0, 0])]
    return m


def apply_matrix(mesh: Mesh, m: np.ndarray) -> Mesh:
    if np.allclose(m, np.eye(4)) or len(mesh.positions) == 0:
        return mesh
    lin = m[:3, :3]
    pos = mesh.positions @ lin.T + m[:3, 3]
    nm = np.linalg.inv(lin).T
    nrm = mesh.normals @ nm.T
    ln = np.linalg.norm(nrm, axis=1, keepdims=True)
    nrm = np.where(ln > 1e-12, nrm / np.maximum(ln, 1e-12), nrm)
    idx = mesh.indices
    if np.linalg.det(lin) < 0:
        idx = idx[:, [0, 2, 1]]
    return Mesh(pos, nrm, mesh.uvs, idx)


def primitive_mesh(shape: Mapping[str, Any]) -> Mesh | None:
    kind = shape.get("type")
    fn = {
        "box": box_mesh,
        "cylinder": cylinder_mesh,
        "cone": cone_mesh,
        "extrude": extrude_mesh,
        "lathe": lathe_mesh,
        "sweep": sweep_mesh,
        "loft": loft_mesh,
    }.get(kind)
    return fn(shape) if fn is not None else None


def material_key(material: Mapping[str, Any]) -> str:
    if material.get("texture") is not None:
        tint = material.get("tint")
        return f"t:{material['texture']}:{','.join(str(v) for v in tint) if tint else ''}"
    return "c:" + ",".join(str(v) for v in material["color"])


@dataclass
class Part:
    mesh: Mesh
    material: dict[str, Any] | None
    path: str = "$"  # 生成这块网格的叶子形状（JSON 路径），烘焙贴图时用来找部件


def _parts_bounds(parts):
    bs = [p.mesh.bounds() for p in parts if len(p.mesh.positions)]
    if not bs:
        return None
    return np.min([b[0] for b in bs], axis=0), np.max([b[1] for b in bs], axis=0)


def _assign(parts: list[Part], material: Mapping[str, Any]) -> list[Part]:
    open_ = [p for p in parts if p.material is None]
    if not open_:
        return parts
    mode = (material.get("uv") or "box") if material.get("texture") is not None else "mesh"
    bounds = None if mode == "mesh" else _parts_bounds(open_)
    out = []
    for p in parts:
        if p.material is not None:
            out.append(p)
        else:
            mesh = p.mesh if mode == "mesh" or bounds is None else project_uvs(p.mesh, mode, bounds)
            out.append(Part(mesh, dict(material), p.path))
    return out


def _override(parts: list[Part], material: Mapping[str, Any]) -> list[Part]:
    if material.get("texture") is not None:
        return _assign([Part(p.mesh, None, p.path) for p in parts], material)
    out = []
    for p in parts:
        if p.material is not None and p.material.get("texture") is not None:
            out.append(Part(p.mesh, {**p.material, "tint": list(material["color"])}, p.path))
        else:
            out.append(Part(p.mesh, dict(material), p.path))
    return out


def build_parts(shape: Mapping[str, Any], templates: Mapping[str, Any] | None = None) -> list[Part]:
    """形状 → 网格块（父坐标系，已应用形状自己的 transform），每块带材质（没有材质的给默认灰色）。"""
    templates = templates or {}
    stack: list[str] = []

    def node(s, path) -> list[Part]:
        kind = s.get("type")
        parts: list[Part] = []
        if kind == "group":
            for i, child in enumerate(s.get("children") or []):
                parts.extend(node(child, f"{path}.children[{i}]"))
        elif kind == "instance":
            tid = s.get("template")
            tpl = templates.get(tid)
            if tpl is not None and tid not in stack and len(stack) < MAX_TEMPLATE_DEPTH:
                stack.append(tid)
                parts = node(tpl, f"{path}<{tid}>")
                stack.pop()
            if s.get("material") is not None:
                parts = _override(parts, s["material"])
        else:
            mesh = primitive_mesh(s)
            if mesh is None:
                return []
            parts = [Part(mesh, None, path)]
        if kind != "instance" and s.get("material") is not None:
            parts = _assign(parts, s["material"])
        if s.get("transform") is not None:
            m = transform_matrix(s["transform"])
            parts = [Part(apply_matrix(p.mesh, m), p.material, p.path) for p in parts]
        return parts

    parts = _assign(node(shape, "$"), {"color": list(DEFAULT_COLOR)})
    return parts


def shape_mesh(shape: Mapping[str, Any], templates: Mapping[str, Any] | None = None) -> Mesh:
    return merge_meshes([p.mesh for p in build_parts(shape, templates)])


def merged_by_material(parts: Sequence[Part]) -> list[tuple[dict[str, Any], Mesh]]:
    groups: dict[str, tuple[dict[str, Any], list[Mesh]]] = {}
    for p in parts:
        mat = p.material or {"color": list(DEFAULT_COLOR)}
        key = material_key(mat)
        groups.setdefault(key, (mat, []))[1].append(p.mesh)
    return [(mat, merge_meshes(meshes)) for mat, meshes in groups.values()]
