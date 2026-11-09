#!/usr/bin/env python3
"""贴图坐标（`uv/`）和 AI 物件集外链贴图（`authored/`）的跨语言测试向量。

期望值按 docs/SHAPES.md 第 2 节「贴图坐标的平铺、着色、法线与粗糙度」逐条独立算出：不调用接口服务、网站、
处理服务任何一边的实现，只用 Python 标准库。几个用到的形状（无圆角的盒子、圆柱、多边形挤出、板、直线扫掠）的
顶点按网站 `web/src/core/shapes/*.ts` 的生成方式列出（位置、法线、两种自然坐标），足够定位要核对的顶点。

    python3 texture_vectors.py          # 重新生成 ../uv/*.json 和 ../authored/*.json
    python3 texture_vectors.py --check  # 只核对：文件和脚本算出的不一致时退出码为 1

向量格式见 ../README.md 第 5、6 节。
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import sys
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path

VECTORS = Path(__file__).resolve().parent.parent

# 核对用的容差：网站的网格用 Float32 存，按 1e-5 比较足够。
POSITION_TOLERANCE = 1e-5
UV_TOLERANCE = 1e-5
# 定位顶点时法线与提示方向的最小点积（区分同一位置上不同面的顶点）。
NORMAL_MIN_DOT = 0.99

# 测试用的假资源哈希（64 位小写十六进制）。
TEXTURE = "9f2c7d4b1e0a3f5c6d8e7b9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d"
NORMAL_MAP = "4b1e0a3f5c6d8e7b9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d9f2c7d"


# ---------------------------------------------------------------------------- JSON 输出


def _float_text(value: float) -> str:
    """与 serde_json（ryu）相同的浮点写法：1.0、0.25、1e-9、1e21、1.5e-7。"""
    if value == 0:
        return "-0.0" if math.copysign(1.0, value) < 0 else "0.0"
    text = repr(abs(value))
    sign = "-" if value < 0 else ""
    mantissa, _, exponent = text.partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = (whole + fraction).lstrip("0")
    power = int(exponent or 0) - len(fraction)
    while digits.endswith("0"):
        digits = digits[:-1]
        power += 1
    length = len(digits)
    point = length + power  # 数值 = 0.digits × 10^point
    if power >= 0 and point <= 16:
        body = digits + "0" * power + ".0"
    elif 0 < point <= 16:
        body = digits[:point] + "." + digits[point:]
    elif -5 < point <= 0:
        body = "0." + "0" * -point + digits
    elif length == 1:
        body = f"{digits}e{point - 1}"
    else:
        body = f"{digits[0]}.{digits[1:]}e{point - 1}"
    return sign + body


def to_json(value: object, depth: int = 0) -> str:
    """与 Rust 生成向量用的 `serde_json::to_string_pretty` 相同：键按码点排序、两格缩进。"""
    pad = "  " * depth
    inner = "  " * (depth + 1)
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [
            f"{inner}{json.dumps(k, ensure_ascii=False)}: {to_json(value[k], depth + 1)}"
            for k in sorted(value)
        ]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    if isinstance(value, list | tuple):
        if not value:
            return "[]"
        return "[\n" + ",\n".join(inner + to_json(item, depth + 1) for item in value) + "\n" + pad + "]"
    if isinstance(value, bool) or value is None:
        return json.dumps(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _float_text(value)
    return json.dumps(value, ensure_ascii=False)


# ---------------------------------------------------------------------------- 小工具

Vec3 = tuple[float, float, float]


def sub(a: Sequence[float], b: Sequence[float]) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def dot(a: Sequence[float], b: Sequence[float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a: Sequence[float], b: Sequence[float]) -> Vec3:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def unit(a: Sequence[float]) -> Vec3:
    n = math.sqrt(dot(a, a))
    return (a[0] / n, a[1] / n, a[2] / n)


def sin_cos_deg(degrees: float) -> tuple[float, float]:
    """角度的 sin、cos；90° 的整数倍取精确的 0、±1（与 SHAPES 1 的变换规则相同）。"""
    if degrees % 90 == 0:
        return [(0.0, 1.0), (1.0, 0.0), (0.0, -1.0), (-1.0, 0.0)][int(degrees // 90) % 4]
    r = math.radians(degrees)
    return math.sin(r), math.cos(r)


def clean(value: float, places: int = 10) -> float:
    """写进向量的数：保留 10 位小数，去掉 −0。"""
    out = round(value, places)
    return 0.0 if out == 0 else out


# ---------------------------------------------------------------------------- 顶点


@dataclass(frozen=True)
class Vertex:
    """网格顶点：位置、法线、自然坐标（`uv: "mesh"` 不给 tile 时用的）和它的米版本（给了 tile 时用的）。"""

    position: Vec3
    normal: Vec3
    natural: tuple[float, float]
    meters: tuple[float, float]


def _box_projection(p: Vec3, n: Vec3, lo: Vec3, size: Vec3, meters: bool) -> tuple[float, float]:
    """三面投影：按法线绝对值最大的轴选面（并列时先 x、再 y、再 z）。"""
    ax, ay, az = (abs(c) for c in n)
    axis = 0 if ax >= ay and ax >= az else (1 if ay >= az else 2)
    return _axis_projection(p, axis, lo, size, meters)


def _axis_projection(p: Vec3, axis: int, lo: Vec3, size: Vec3, meters: bool) -> tuple[float, float]:
    ku, kv = {0: (2, 1), 1: (0, 2), 2: (0, 1)}[axis]
    u = p[ku] - lo[ku]
    v = p[kv] - lo[kv]
    if meters:
        return u, v
    return u / size[ku], v / size[kv]


def bounds(vertices: Iterable[Vertex]) -> tuple[Vec3, Vec3]:
    ps = [v.position for v in vertices]
    lo = (min(p[0] for p in ps), min(p[1] for p in ps), min(p[2] for p in ps))
    hi = (max(p[0] for p in ps), max(p[1] for p in ps), max(p[2] for p in ps))
    return lo, hi


def box_vertices(size: Sequence[float]) -> list[Vertex]:
    """无圆角的盒子：6 个面各 4 个顶点，法线是面法线。自然坐标是按盒子自己的包围盒做的三面投影。"""
    w, h, d = size
    half = (w / 2, h / 2, d / 2)
    center = (0.0, h / 2, 0.0)
    lo = (-w / 2, 0.0, -d / 2)
    extent = (w, h, d)
    out = []
    for a in range(3):
        b, c = (a + 1) % 3, (a + 2) % 3
        for sign in (1, -1):
            normal = [0.0, 0.0, 0.0]
            normal[a] = float(sign)
            for sb, sc in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                p = list(center)
                p[a] = center[a] + sign * half[a]
                p[b] = center[b] + sb * half[b]
                p[c] = center[c] + sc * half[c]
                pos = (p[0], p[1], p[2])
                n = (normal[0], normal[1], normal[2])
                out.append(
                    Vertex(
                        pos,
                        n,
                        _box_projection(pos, n, lo, extent, meters=False),
                        _box_projection(pos, n, lo, extent, meters=True),
                    )
                )
    return out


def cylinder_vertices(radius: float, height: float, segments: int) -> list[Vertex]:
    """圆柱（无圆角、无 radiusTop）：轮廓 (0,0)→(r,0)→(r,h)→(0,h) 的旋转体，每段轮廓各自一组圈。

    第 i 个顶点转过 θ = i / segments · 2π（从 +z 转向 +x），位置 (r·sinθ, y, r·cosθ)。
    自然坐标 (i / segments, 累计轮廓长 / 总长)；米版本 (θ·r, 累计轮廓长)。
    """
    profile = [(0.0, 0.0), (radius, 0.0), (radius, height), (0.0, height)]
    lengths = [0.0, radius, radius + height, 2 * radius + height]
    total = lengths[-1]
    out = []
    for j in range(3):
        for end in (j, j + 1):
            r, y = profile[end]
            for i in range(segments + 1):
                theta = (i / segments) * (360 * math.pi / 180)
                s, c = math.sin(theta), math.cos(theta)
                normal = [(0.0, -1.0, 0.0), (s, 0.0, c), (0.0, 1.0, 0.0)][j]
                out.append(
                    Vertex(
                        (r * s, y, r * c),
                        normal,
                        (i / segments, lengths[end] / total),
                        (theta * r, lengths[end]),
                    )
                )
    return out


def extrude_vertices(points: Sequence[Sequence[float]], height: float) -> list[Vertex]:
    """多边形挤出（逆时针、闭合、无圆弧圆角、转角都是硬边）：侧面每条边 4 个顶点，顶面底面每点一个。

    侧面自然坐标 (沿轮廓从第 0 点累计的长度, y)，顶面底面 (x, z)，都已是米。
    """
    n = len(points)
    out = []
    along = 0.0
    for s in range(n):
        ax, az = points[s]
        bx, bz = points[(s + 1) % n]
        step = math.hypot(bx - ax, bz - az)
        dx, dz = (bx - ax) / step, (bz - az) / step
        normal = (dz, 0.0, -dx)  # 逆时针轮廓的外法线
        for x, z, u in ((ax, az, along), (bx, bz, along + step)):
            for y in (0.0, height):
                out.append(Vertex((x, y, z), normal, (u, y), (u, y)))
        along += step
    for y, ny in ((0.0, -1.0), (height, 1.0)):
        for x, z in points:
            out.append(Vertex((x, y, z), (0.0, ny, 0.0), (x, z), (x, z)))
    return out


def plate_vertices(points: Sequence[Sequence[float]], thickness: float) -> list[Vertex]:
    """板（SHAPES 2）：正面、背面每点一个顶点，侧面每条边 4 个顶点。自然坐标已是米。"""
    count = len(points)
    c = tuple(sum(p[k] for p in points) / count for k in range(3))
    newell = [0.0, 0.0, 0.0]
    for i in range(count):
        a = sub(points[i], c)
        b = sub(points[(i + 1) % count], c)
        newell = [x + y for x, y in zip(newell, cross(a, b), strict=True)]
    n = unit(newell)
    back = [tuple(p[k] - thickness * n[k] for k in range(3)) for p in points]
    first = sub(points[1], points[0])
    u_axis = unit(tuple(first[k] - n[k] * dot(first, n) for k in range(3)))
    v_axis = cross(n, u_axis)
    minus = (-n[0], -n[1], -n[2])
    out = []
    for p in points:
        rel = sub(p, points[0])
        uv = (dot(rel, u_axis), dot(rel, v_axis))
        out.append(Vertex(tuple(float(x) for x in p), n, uv, uv))
    for p in back:
        rel = sub(p, back[0])
        uv = (dot(rel, u_axis), dot(rel, v_axis))
        out.append(Vertex(p, minus, uv, uv))
    along = 0.0
    for i in range(count):
        j = (i + 1) % count
        edge = sub(points[j], points[i])
        out_normal = unit(cross(edge, n))
        step = math.sqrt(dot(edge, edge))
        corners = (
            (points[i], (along, thickness)),
            (points[j], (along + step, thickness)),
            (back[j], (along + step, 0.0)),
            (back[i], (along, 0.0)),
        )
        for p, uv in corners:
            out.append(Vertex(tuple(float(x) for x in p), out_normal, uv, uv))
        along += step
    return out


def sweep_line_vertices(start: Vec3, length: float, radius: float, segments: int) -> list[Vertex]:
    """沿 +x 的直线扫掠圆截面、两端封口。切线 t = +x，主法线 n = +y，副法线 b = t × n = +z。

    截面第 k 点角度 a = k / segments · 2π，偏移 (r·cos a 沿 b, r·sin a 沿 n)。侧面自然坐标
    (k / segments, 路径长 / 总长)，米版本 (a·r, 路径长)；端盖自然坐标 (0.5 + r·cos a, 0.5 + r·sin a)，
    米版本 (r·cos a, r·sin a)，圆心 (0.5, 0.5) / (0, 0)。
    """
    out = []
    for along in (0.0, length):
        x = start[0] + along
        for k in range(segments + 1):
            a = (k / segments) * math.pi * 2
            c, s = math.cos(a), math.sin(a)
            pos = (x, start[1] + radius * s, start[2] + radius * c)
            out.append(
                Vertex(
                    pos,
                    (0.0, s, c),
                    (k / segments, along / length),
                    (a * radius, along),
                )
            )
    for along, nx in ((0.0, -1.0), (length, 1.0)):
        x = start[0] + along
        out.append(Vertex((x, start[1], start[2]), (nx, 0.0, 0.0), (0.5, 0.5), (0.0, 0.0)))
        for k in range(segments):
            a = (k / segments) * math.pi * 2
            c, s = math.cos(a), math.sin(a)
            pos = (x, start[1] + radius * s, start[2] + radius * c)
            out.append(
                Vertex(
                    pos,
                    (nx, 0.0, 0.0),
                    (0.5 + radius * c, 0.5 + radius * s),
                    (radius * c, radius * s),
                )
            )
    return out


def transformed(vertices: Iterable[Vertex], transform: dict) -> list[Vertex]:
    """子形状的 transform（M = T · Ry · Rx · Rz · S）：位置乘 M，法线乘 M 线性部分的逆转置再归一化。"""
    sy, cy = sin_cos_deg(transform.get("yaw", 0))
    sx, cx = sin_cos_deg(transform.get("pitch", 0))
    sz, cz = sin_cos_deg(transform.get("roll", 0))
    scale = transform.get("scale", [1, 1, 1])
    ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]
    rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]]
    rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]]

    def mul(a, b):
        return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]

    rot = mul(mul(ry, rx), rz)
    lin = [[rot[i][j] * scale[j] for j in range(3)] for i in range(3)]
    inv_t = [[rot[i][j] / scale[j] for j in range(3)] for i in range(3)]  # (R·S)^-T = R·S^-1
    pos = transform.get("position", [0, 0, 0])
    out = []
    for v in vertices:
        p = tuple(sum(lin[i][k] * v.position[k] for k in range(3)) + pos[i] for i in range(3))
        n = unit(tuple(sum(inv_t[i][k] * v.normal[k] for k in range(3)) for i in range(3)))
        out.append(replace(v, position=p, normal=n))
    return out


# ---------------------------------------------------------------------------- 贴图坐标（SHAPES 2）


def final_uvs(vertices: Sequence[Vertex], material: dict) -> list[tuple[float, float]]:
    """声明材质的那一层的全部部件一起算：先取 (s, t)，给了 tile 再加 offset、转 rotate、除 tile。"""
    mode = material["uv"]
    tile = material.get("tile")
    lo, hi = bounds(vertices)
    size = tuple(max(hi[k] - lo[k], 1e-9) for k in range(3))
    thinnest = size.index(min(size))  # 并列时先 x、再 y、再 z
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    radius = (size[0] + size[2]) / 4
    raw = []
    for v in vertices:
        x, y, z = v.position
        if mode == "mesh":
            st = v.meters if tile else v.natural
        elif mode == "cylindrical":
            phi = math.atan2(x - cx, z - cz) + math.pi
            st = (phi * radius, y - lo[1]) if tile else (phi / (2 * math.pi), (y - lo[1]) / size[1])
        elif mode == "box":
            st = _box_projection(v.position, v.normal, lo, size, meters=tile is not None)
        else:
            st = _axis_projection(v.position, thinnest, lo, size, meters=tile is not None)
        raw.append(st)
    if tile is None:
        return raw
    du, dv = material.get("offset", [0, 0])
    sin, cos = sin_cos_deg(material.get("rotate", 0))
    out = []
    for s, t in raw:
        a, b = s + du, t + dv
        out.append(((a * cos + b * sin) / tile[0], (-a * sin + b * cos) / tile[1]))
    return out


# ---------------------------------------------------------------------------- 贴图坐标向量

Pick = Callable[[Vertex], bool]


def at(position: Sequence[float], normal: Sequence[float]) -> Pick:
    """按位置和法线选顶点（与运行器的定位规则相同）。"""
    return lambda v: _matches(v, position, normal)


def _matches(v: Vertex, position: Sequence[float], normal: Sequence[float]) -> bool:
    close = all(abs(v.position[k] - position[k]) <= POSITION_TOLERANCE for k in range(3))
    return close and dot(unit(v.normal), unit(normal)) >= NORMAL_MIN_DOT


@dataclass
class UvCase:
    file: str
    description: str
    shape: dict
    vertices: list[Vertex]
    picks: list[tuple[str, Pick]] = field(default_factory=list)


def _round_vec(values: Sequence[float], places: int = 10) -> list[float]:
    return [clean(float(x), places) for x in values]


def uv_vector(case: UvCase) -> dict:
    material = case.shape["material"]
    uvs = final_uvs(case.vertices, material)
    rows = []
    for where, pick in case.picks:
        chosen = [i for i, v in enumerate(case.vertices) if pick(v)]
        if len(chosen) == 0:
            raise SystemExit(f"{case.file}：{where} 没有选到顶点")
        first = case.vertices[chosen[0]]
        # 运行器按位置和法线定位：同一位置、同一朝向的顶点必须给出同一个贴图坐标，否则定位有歧义
        twins = [i for i, v in enumerate(case.vertices) if _matches(v, first.position, first.normal)]
        expected = uvs[chosen[0]]
        for i in twins:
            if max(abs(uvs[i][0] - expected[0]), abs(uvs[i][1] - expected[1])) > 1e-9:
                raise SystemExit(f"{case.file}：{where} 的位置和法线对应多个不同的贴图坐标")
        rows.append(
            {
                "where": where,
                "position": _round_vec(first.position),
                "normal": _round_vec(first.normal, 6),
                "uv": _round_vec(expected),
            }
        )
    return {
        "kind": "uv",
        "name": case.file.removeprefix("uv_").replace("_", "-"),
        "description": case.description,
        "shape": case.shape,
        "templates": {},
        "wrap": "repeat" if "tile" in material else "clamp",
        "tolerance": {"position": POSITION_TOLERANCE, "normalDot": NORMAL_MIN_DOT, "uv": UV_TOLERANCE},
        "vertices": rows,
    }


def _cyl(theta_deg: float, radius: float, y: float) -> tuple[Vec3, Vec3]:
    s, c = math.sin(math.radians(theta_deg)), math.cos(math.radians(theta_deg))
    return (radius * s, y, radius * c), (s, 0.0, c)


def uv_cases() -> list[UvCase]:
    box_size = [2, 1, 0.5]
    box = box_vertices(box_size)
    box_picks = [
        ("+x 面右上角", at((1, 1, 0.25), (1, 0, 0))),
        ("+x 面左下角", at((1, 0, -0.25), (1, 0, 0))),
        ("−x 面", at((-1, 1, -0.25), (-1, 0, 0))),
        ("+y 面", at((1, 1, 0.25), (0, 1, 0))),
        ("+y 面", at((-1, 1, -0.25), (0, 1, 0))),
        ("−y 面", at((1, 0, -0.25), (0, -1, 0))),
        ("+z 面", at((1, 1, 0.25), (0, 0, 1))),
        ("−z 面", at((-1, 0, -0.25), (0, 0, -1))),
    ]

    def box_shape(material: dict) -> dict:
        return {"type": "box", "size": box_size, "material": material}

    radius, height, segments = 0.3, 1.2, 8
    cylinder = cylinder_vertices(radius, height, segments)

    def cylinder_picks(thetas: Sequence[int]) -> list[tuple[str, Pick]]:
        """侧面各取底边、顶边，再加两个顶点在底面、顶面边缘上的。
        mesh 坐标在 +z（转过 0°）有接缝：同一位置、同一法线的两个顶点 u 不同，所以那里不取。"""
        picks = []
        for theta in thetas:
            for y, name in ((0.0, "底边"), (height, "顶边")):
                p, n = _cyl(theta, radius, y)
                picks.append((f"侧面{name}，转过 {theta}°", at(p, n)))
        picks.append(("底面边缘，转过 90°", at(_cyl(90, radius, 0.0)[0], (0, -1, 0))))
        picks.append(("顶面边缘，转过 270°", at(_cyl(270, radius, height)[0], (0, 1, 0))))
        return picks

    # 柱面投影的接缝在 −z（转过 180°），那里不取；+z 处两个重合的顶点投影结果相同，可以取。
    projected_picks = cylinder_picks((0, 45, 90, 270))
    mesh_picks = cylinder_picks((45, 90, 270))

    def cylinder_shape(material: dict) -> dict:
        return {
            "type": "cylinder",
            "radius": radius,
            "height": height,
            "segments": segments,
            "material": material,
        }

    l_outline = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]
    l_height = 0.8
    extrude_l = extrude_vertices(l_outline, l_height)
    extrude_picks = [
        ("第 0 条边起点（底）", at((0, 0, 0), (0, 0, -1))),
        ("第 0 条边终点（顶）", at((2, 0.8, 0), (0, 0, -1))),
        ("第 2 条边终点（顶）", at((1, 0.8, 1), (0, 0, 1))),
        ("第 4 条边起点（底）", at((1, 0, 2), (0, 0, 1))),
        ("最后一条边终点（回到第 0 点，顶）", at((0, 0.8, 0), (-1, 0, 0))),
        ("顶面", at((2, 0.8, 1), (0, 1, 0))),
        ("底面", at((1, 0, 2), (0, -1, 0))),
    ]

    floor_outline = [[-3, -2], [1.5, -2], [1.5, 1], [0, 1], [0, 2.5], [-3, 2.5]]
    floor = extrude_vertices(floor_outline, 0.02)
    floor_picks = [
        ("顶面", at((-3, 0.02, -2), (0, 1, 0))),
        ("顶面", at((1.5, 0.02, 1), (0, 1, 0))),
        ("顶面", at((0, 0.02, 2.5), (0, 1, 0))),
        ("侧面（planar 不看法线）", at((1.5, 0, -2), (1, 0, 0))),
    ]

    plate_points = [[0, 0, 0], [2, 0, 0], [2, 0.9, 0.3], [0, 0.9, 0.3]]
    plate = plate_vertices(plate_points, 0.02)
    plate_n = plate[0].normal
    plate_back = [tuple(p[k] - 0.02 * plate_n[k] for k in range(3)) for p in plate_points]
    plate_minus = (-plate_n[0], -plate_n[1], -plate_n[2])
    plate_picks = [
        ("正面第 1 点", at((2, 0, 0), plate_n)),
        ("正面第 2 点", at((2, 0.9, 0.3), plate_n)),
        ("背面第 2 点", at(plate_back[2], plate_minus)),
        ("侧面第 1 条边", at((2, 0.9, 0.3), (1, 0, 0))),
        ("侧面第 2 条边", at(plate_back[3], unit(cross(sub(plate_points[3], plate_points[2]), plate_n)))),
    ]

    # sweep 没有 segments 字段，圆截面按网站的默认 16 段生成
    sweep_r, sweep_len = 0.03, 1.2
    sweep = sweep_line_vertices((0.0, 0.4, 0.0), sweep_len, sweep_r, 16)
    sweep_picks = [
        ("侧面起点，截面 90°", at((0, 0.43, 0), (0, 1, 0))),
        ("侧面终点，截面 90°", at((1.2, 0.43, 0), (0, 1, 0))),
        ("侧面终点，截面 270°", at((1.2, 0.37, 0), (0, -1, 0))),
        ("侧面起点，截面 45°", at((0, 0.4 + sweep_r * math.sqrt(0.5), sweep_r * math.sqrt(0.5)), (0, 1, 1))),
        ("起点端盖圆心", at((0, 0.4, 0), (-1, 0, 0))),
        ("起点端盖，截面 0°", at((0, 0.4, 0.03), (-1, 0, 0))),
        ("终点端盖，截面 90°", at((1.2, 0.43, 0), (1, 0, 0))),
    ]

    group_children = [
        {"type": "box", "size": [1, 1, 1]},
        {"type": "box", "size": [1, 1, 1], "transform": {"position": [3, 0, 0], "yaw": 90}},
    ]
    group = box_vertices([1, 1, 1]) + transformed(box_vertices([1, 1, 1]), group_children[1]["transform"])
    group_picks = [
        ("第一个盒子 +y 面", at((-0.5, 1, -0.5), (0, 1, 0))),
        ("第二个盒子 +y 面", at((3.5, 1, 0.5), (0, 1, 0))),
        ("第二个盒子朝 +x 的面（局部 +z 面转过来的）", at((3.5, 0, -0.5), (1, 0, 0))),
        ("第二个盒子朝 −z 的面", at((2.5, 1, -0.5), (0, 0, -1))),
    ]

    top_size = [1, 0.02, 1]
    top = box_vertices(top_size)
    top_picks = [
        ("+y 面", at((0.5, 0.02, 0.5), (0, 1, 0))),
        ("+y 面", at((-0.5, 0.02, 0.5), (0, 1, 0))),
        ("+x 面（planar 不看法线）", at((0.5, 0, -0.5), (1, 0, 0))),
    ]

    return [
        UvCase(
            "uv_box_normalized",
            "不给 tile：旧算法，box 三面投影按包围盒归一化到 0–1（与现在完全相同）",
            box_shape({"texture": TEXTURE, "uv": "box"}),
            box,
            box_picks,
        ),
        UvCase(
            "uv_box_tile",
            "box 投影 + tile：坐标是相对包围盒最小角的米数，再除以 tile",
            box_shape({"texture": TEXTURE, "uv": "box", "tile": [0.5, 0.25]}),
            box,
            box_picks,
        ),
        UvCase(
            "uv_box_tile_offset_rotate90",
            "先加 offset、再转 rotate（90°，sin、cos 取精确值）、再除 tile",
            box_shape(
                {"texture": TEXTURE, "uv": "box", "tile": [0.5, 0.25], "offset": [0.1, -0.2], "rotate": 90}
            ),
            box,
            box_picks,
        ),
        UvCase(
            "uv_box_tile_rotate30",
            "非 90° 整数倍的 rotate 用浮点 sin、cos："
            "u = (a·cosθ + b·sinθ) / tile[0]，v = (−a·sinθ + b·cosθ) / tile[1]",
            box_shape(
                {"texture": TEXTURE, "uv": "box", "tile": [0.4, 0.4], "rotate": 30, "shading": "albedo"}
            ),
            box,
            box_picks,
        ),
        UvCase(
            "uv_planar_wall_tile",
            "planar：所有顶点都沿包围盒最薄的轴（这里是 z）投影，侧面也一样；tile + offset",
            {
                "type": "box",
                "size": [3, 2, 0.1],
                "material": {"texture": TEXTURE, "uv": "planar", "tile": [0.6, 0.6], "offset": [0.3, 0]},
            },
            box_vertices([3, 2, 0.1]),
            [
                ("正面（+z）", at((1.5, 2, 0.05), (0, 0, 1))),
                ("背面（−z）", at((-1.5, 0, -0.05), (0, 0, -1))),
                ("侧面（+x）", at((1.5, 2, -0.05), (1, 0, 0))),
                ("顶面", at((-1.5, 2, 0.05), (0, 1, 0))),
            ],
        ),
        UvCase(
            "uv_planar_floor_extrude_tile",
            "planar 用在挤出的地面上：最薄的轴是 y，坐标从包围盒最小角（负坐标）量起；rotate 45°",
            {
                "type": "extrude",
                "outline": {"points": floor_outline},
                "height": 0.02,
                "material": {"texture": TEXTURE, "uv": "planar", "tile": [0.6, 0.6], "rotate": 45},
            },
            floor,
            floor_picks,
        ),
        UvCase(
            "uv_cylindrical_normalized",
            "不给 tile：柱面投影 u = φ / 2π（φ = atan2(x − cx, z − cz) + π），v 按包围盒高度归一化",
            cylinder_shape({"texture": TEXTURE, "uv": "cylindrical"}),
            cylinder,
            projected_picks,
        ),
        UvCase(
            "uv_cylindrical_tile",
            "柱面投影 + tile：u = φ · R（R = 包围盒 xz 平均半径，这里 0.3），"
            "v = y − 包围盒最低点；offset 只移 v",
            cylinder_shape(
                {"texture": TEXTURE, "uv": "cylindrical", "tile": [0.25, 0.3], "offset": [0, 0.1]}
            ),
            cylinder,
            projected_picks,
        ),
        UvCase(
            "uv_mesh_box_tile",
            "box 的 mesh 坐标给了 tile：与 box 投影相同的轴，从盒子自己的最小角 (−w/2, 0, −d/2) 量起的米数",
            box_shape({"texture": TEXTURE, "uv": "mesh", "tile": [0.5, 0.5], "offset": [0.25, 0]}),
            box,
            box_picks,
        ),
        UvCase(
            "uv_mesh_cylinder_normalized",
            "不给 tile：旋转体的自然坐标 u = i / 分段数（按转过的角度），"
            "v = 累计轮廓长 / 轮廓总长（与现在相同）",
            cylinder_shape({"texture": TEXTURE, "uv": "mesh"}),
            cylinder,
            mesh_picks,
        ),
        UvCase(
            "uv_mesh_cylinder_tile",
            "旋转体的米坐标：u = θ · r（这一圈上的弧长），"
            "v = 从轮廓第一点量起的累计长度（底面半径 0.3 + 高度）",
            cylinder_shape({"texture": TEXTURE, "uv": "mesh", "tile": [0.2, 0.2]}),
            cylinder,
            mesh_picks,
        ),
        UvCase(
            "uv_mesh_extrude",
            "不给 tile：挤出的自然坐标已是米（侧面沿轮廓累计长度和高度，顶面底面 (x, z)），与现在相同",
            {
                "type": "extrude",
                "outline": {"points": l_outline},
                "height": l_height,
                "material": {"texture": TEXTURE, "uv": "mesh"},
            },
            extrude_l,
            extrude_picks,
        ),
        UvCase(
            "uv_mesh_extrude_tile_rotate90",
            "挤出的米坐标 + offset + rotate 90° + tile；最后一条边回到第 0 点时 u 是周长",
            {
                "type": "extrude",
                "outline": {"points": l_outline},
                "height": l_height,
                "material": {
                    "texture": TEXTURE,
                    "uv": "mesh",
                    "tile": [0.5, 0.4],
                    "offset": [0.25, 0],
                    "rotate": 90,
                },
            },
            extrude_l,
            extrude_picks,
        ),
        UvCase(
            "uv_mesh_plate_tile",
            "板的自然坐标已是米（面内坐标从第 0 点量起，侧面沿轮廓累计长度和厚度）；rotate −30°",
            {
                "type": "plate",
                "points": plate_points,
                "thickness": 0.02,
                "material": {"texture": TEXTURE, "uv": "mesh", "tile": [0.3, 0.3], "rotate": -30},
            },
            plate,
            plate_picks,
        ),
        UvCase(
            "uv_mesh_sweep_tile",
            "扫掠的米坐标：侧面 u = 截面角度 · r，v = 路径累计长度；端盖是截面内坐标（圆心为 0）",
            {
                "type": "sweep",
                "path": [[0, 0.4, 0], [1.2, 0.4, 0]],
                "section": {"circle": sweep_r},
                "material": {"texture": TEXTURE, "uv": "mesh", "tile": [0.1, 0.5]},
            },
            sweep,
            sweep_picks,
        ),
        UvCase(
            "uv_group_box_tile",
            "材质写在组合上：子形状先用自己的 transform，"
            "再按全部子形状合起来的包围盒投影（第二个盒子偏航 90°）",
            {
                "type": "group",
                "children": group_children,
                "material": {"texture": TEXTURE, "uv": "box", "tile": [1, 1]},
            },
            group,
            group_picks,
        ),
        UvCase(
            "uv_color_normal_map_tile",
            "颜色材质带法线贴图：同样按 uv、tile 算贴图坐标（法线贴图用它）",
            {
                "type": "box",
                "size": top_size,
                "material": {
                    "color": [182, 140, 96],
                    "uv": "planar",
                    "tile": [0.25, 0.25],
                    "normalMap": NORMAL_MAP,
                    "roughness": 0.7,
                },
            },
            top,
            top_picks,
        ),
    ]


# ---------------------------------------------------------------------------- AI 物件集：外链贴图

COMMIT = "0123456789abcdef0123456789abcdef01234567"
REPO = f"https://raw.githubusercontent.com/ChronoAIProject/chrono-metaverse/{COMMIT}/infra/chrono-cd/demo/textures"
PH = "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k"


def link(url: str, digest: str, size: int) -> dict:
    return {"url": url, "sha256": digest, "size": size}


FLOOR_ALBEDO = link(f"{PH}/example_wood_floor/example_wood_floor_diff_1k.jpg", "a1" * 32, 734211)
FLOOR_NORMAL = link(f"{PH}/example_wood_floor/example_wood_floor_nor_gl_1k.png", "b2" * 32, 1523087)
FLOOR_ROUGH = link(f"{PH}/example_wood_floor/example_wood_floor_rough_1k.png", "c3" * 32, 402559)
LEATHER = link(f"{PH}/example_leather/example_leather_diff_1k.jpg", "d4" * 32, 512000)
MARBLE = link(f"{REPO}/counter-marble.jpg", "e5" * 32, 268321)
WOOD_NORMAL = link(f"{REPO}/counter-wood-normal.png", "f6" * 32, 1048576)
CARPET = link(f"{REPO}/rug-carpet.webp", "07" * 32, 98304)
MODEL_ID = "0000000000000000000000000000000a"


def full_example() -> dict:
    return {
        "version": 1,
        "structure": "replace",
        "notes": "外链贴图示例：地面用材质库的木地板（颜色 + 法线 + 粗糙度）按 0.6 米平铺；"
        "前台台面的大理石放在本仓库",
        "templates": [
            {
                "entityId": "tpl-stool",
                "kind": "template",
                "label": "圆凳",
                "shape": {
                    "type": "cylinder",
                    "radius": 0.18,
                    "height": 0.45,
                    "segments": 24,
                    "material": {
                        "texture": LEATHER,
                        "uv": "cylindrical",
                        "tile": [0.3, 0.3],
                        "shading": "albedo",
                        "roughness": 0.7,
                    },
                },
            }
        ],
        "entities": [
            {
                "entityId": "floor",
                "kind": "structure",
                "label": "地面",
                "shape": {
                    "type": "box",
                    "size": [8, 0.02, 6],
                    "transform": {"position": [4, -0.02, 3]},
                    "material": {
                        "texture": FLOOR_ALBEDO,
                        "uv": "planar",
                        "tile": [0.6, 0.6],
                        "shading": "albedo",
                        "normalMap": FLOOR_NORMAL,
                        "roughnessMap": FLOOR_ROUGH,
                    },
                },
            },
            {
                "entityId": "wall-north",
                "kind": "structure",
                "label": "北墙",
                "shape": {
                    "type": "box",
                    "size": [8, 2.8, 0.1],
                    "transform": {"position": [4, 0, 0]},
                    "material": {"texture": TEXTURE, "uv": "planar"},
                },
            },
            {
                "entityId": "counter-01",
                "kind": "object",
                "label": "前台",
                "shape": {
                    "type": "group",
                    "transform": {"position": [2, 0, 1.5]},
                    "children": [
                        {
                            "type": "box",
                            "size": [2.4, 0.04, 0.6],
                            "transform": {"position": [0, 1.06, 0]},
                            "material": {
                                "texture": MARBLE,
                                "uv": "box",
                                "tile": [0.8, 0.8],
                                "rotate": 90,
                                "shading": "albedo",
                                "roughness": 0.6,
                            },
                        },
                        {
                            "type": "box",
                            "size": [2.4, 1.06, 0.5],
                            "material": {
                                "color": [182, 140, 96],
                                "uv": "box",
                                "tile": [0.4, 0.4],
                                "normalMap": WOOD_NORMAL,
                                "normalScale": 0.8,
                                "roughness": 0.8,
                            },
                        },
                        {
                            "type": "box",
                            "size": [0.6, 0.02, 0.4],
                            "transform": {"position": [0.6, 1.08, 0]},
                            "material": {
                                "bake": "planar",
                                "color": [40, 40, 44],
                                "shading": "baked",
                                "roughness": 0.9,
                            },
                        },
                    ],
                },
            },
            {
                "entityId": "table-01",
                "kind": "object",
                "label": "边几",
                "shape": {
                    "type": "cylinder",
                    "radius": 0.33,
                    "height": 0.44,
                    "transform": {"position": [5, 0, 4.2]},
                    "material": {"texture": MARBLE, "uv": "planar", "tile": [0.8, 0.8], "shading": "albedo"},
                },
            },
            {
                "entityId": "rug-01",
                "kind": "object",
                "label": "地垫",
                "shape": {
                    "type": "box",
                    "size": [1.6, 0.01, 1.0],
                    "transform": {"position": [3, 0, 3]},
                    "material": {"texture": CARPET, "uv": "planar", "tile": [0.5, 0.5], "shading": "albedo"},
                },
            },
            {
                "entityId": "stool-01",
                "kind": "object",
                "label": "圆凳",
                "shape": {"type": "instance", "template": "tpl-stool", "transform": {"position": [2, 0, 4]}},
            },
            {
                "entityId": "sofa-01",
                "kind": "object",
                "label": "沙发",
                "model": {
                    "url": f"https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-000/{MODEL_ID}.glb",
                    "sha256": "18" * 32,
                    "size": 123456,
                    "format": "glb",
                },
                "transform": {"position": [5, 0, 4], "yaw": 90},
                "material": {"tint": [214, 196, 176], "shading": "albedo"},
                "props": {
                    "source": {
                        "library": "objaverse",
                        "id": MODEL_ID,
                        "page": f"https://sketchfab.com/3d-models/{MODEL_ID}",
                        "author": "示例作者",
                        "license": "CC-BY-4.0",
                        "title": "示例沙发",
                    }
                },
            },
        ],
    }


def minimal_color() -> dict:
    return {
        "version": 1,
        "entities": [
            {
                "entityId": "panel-01",
                "kind": "object",
                "label": "木饰面板",
                "shape": {
                    "type": "box",
                    "size": [1.2, 2.4, 0.03],
                    "material": {
                        "color": [150, 112, 80],
                        "uv": "planar",
                        "tile": [0.6, 0.6],
                        "normalMap": WOOD_NORMAL,
                        "roughnessMap": FLOOR_ROUGH,
                    },
                },
            }
        ],
    }


def minimal_texture() -> dict:
    return {
        "version": 1,
        "entities": [
            {
                "entityId": "panel-01",
                "kind": "object",
                "label": "大理石板",
                "shape": {
                    "type": "box",
                    "size": [1.2, 0.03, 0.6],
                    "material": {
                        "texture": copy.deepcopy(MARBLE),
                        "uv": "planar",
                        "tile": [0.8, 0.8],
                        "shading": "albedo",
                    },
                },
            }
        ],
    }


def _invalid(name: str, description: str, where: str, mutate: Callable[[dict], None]) -> dict:
    doc = minimal_texture()
    mutate(doc)
    return {"name": name, "description": description, "where": where, "authored": doc, "valid": False}


def _material(doc: dict) -> dict:
    return doc["entities"][0]["shape"]["material"]


def _set_link(key: str, value: object) -> Callable[[dict], None]:
    def mutate(doc: dict) -> None:
        if value is None:
            del _material(doc)["texture"][key]
        else:
            _material(doc)["texture"][key] = value

    return mutate


def invalid_cases() -> list[dict]:
    def put(key: str, value: object) -> Callable[[dict], None]:
        return lambda doc: _material(doc).__setitem__(key, value)

    def template_link(doc: dict) -> None:
        doc["templates"] = [
            {
                "entityId": "tpl-tile",
                "kind": "template",
                "shape": {
                    "type": "box",
                    "size": [0.6, 0.01, 0.6],
                    "material": {"texture": {**MARBLE, "size": -1}, "uv": "planar", "tile": [0.6, 0.6]},
                },
            }
        ]

    def bake_with(extra: dict) -> Callable[[dict], None]:
        def mutate(doc: dict) -> None:
            doc["entities"][0]["shape"]["material"] = {"bake": "planar", "color": [40, 40, 44], **extra}

        return mutate

    url = MARBLE["url"]
    return [
        _invalid("http", "外链必须是 https", "material.texture.url", _set_link("url", "http" + url[5:])),
        _invalid(
            "userinfo",
            "https 地址不能带用户名",
            "material.texture.url",
            _set_link("url", url.replace("https://", "https://user@")),
        ),
        _invalid(
            "sha256-uppercase",
            "sha256 必须是小写十六进制",
            "material.texture.sha256",
            _set_link("sha256", "E5" * 32),
        ),
        _invalid(
            "sha256-length", "sha256 必须是 64 位", "material.texture.sha256", _set_link("sha256", "e5" * 31)
        ),
        _invalid("size-zero", "size 必须是正整数", "material.texture.size", _set_link("size", 0)),
        _invalid(
            "size-too-large",
            "size 超过 16 MiB（16777216 字节）",
            "material.texture.size",
            _set_link("size", 16 * 1024 * 1024 + 1),
        ),
        _invalid("size-fraction", "size 必须是整数", "material.texture.size", _set_link("size", 1024.5)),
        _invalid("size-string", "size 必须是数字", "material.texture.size", _set_link("size", "268321")),
        _invalid(
            "size-missing", "url、sha256、size 都必须给", "material.texture.size", _set_link("size", None)
        ),
        _invalid(
            "extra-field",
            "外链对象只能有 url、sha256、size",
            "material.texture.format",
            _set_link("format", "jpeg"),
        ),
        _invalid(
            "workbench-file",
            "工作台的本地文件引用 {file} 不能出现在写回的物件集里（assemble --texture-base-url 换成外链）",
            "material.texture",
            put("texture", {"file": "textures/counter-marble.jpg"}),
        ),
        _invalid(
            "texture-number",
            "texture 只能是资源哈希字符串或外链对象",
            "material.texture",
            put("texture", 12345),
        ),
        _invalid(
            "normal-map-ftp",
            "normalMap 的外链同样必须是 https",
            "material.normalMap.url",
            put("normalMap", {**WOOD_NORMAL, "url": "ftp://example.org/wood-normal.png"}),
        ),
        _invalid(
            "roughness-map-sha256",
            "roughnessMap 的外链同样核对 sha256 的写法",
            "material.roughnessMap.sha256",
            put("roughnessMap", {**FLOOR_ROUGH, "sha256": "not-a-hash"}),
        ),
        _invalid(
            "template-size",
            "模板里的外链贴图同样检查（size 是负数）",
            "templates[0].shape.material.texture.size",
            template_link,
        ),
        _invalid(
            "bake-normal-map",
            "烘焙指令不能和 normalMap 一起出现",
            "material.bake",
            bake_with({"normalMap": WOOD_NORMAL}),
        ),
        _invalid("bake-tile", "烘焙指令不能和 tile 一起出现", "material.bake", bake_with({"tile": [1, 1]})),
    ]


def authored_vectors() -> dict[str, dict]:
    valid = {
        "kind": "authored",
        "name": "texture-urls-valid",
        "description": "形状材质的 texture、normalMap、roughnessMap 可以写成外链对象 {url, sha256, size}；"
        "接口服务浅层校验和处理服务完整校验都要接受",
        "cases": [
            {
                "name": "full-example",
                "description": "结构、组合、模板、实例、外部模型、烘焙指令和外链贴图混用；"
                "同一个外链（大理石）用了两次，只算一个",
                "authored": full_example(),
                "valid": True,
                "summary": {"entities": 7, "templates": 1, "models": 1, "textureUrls": 7},
            },
            {
                "name": "color-with-maps",
                "description": "颜色材质带外链的法线贴图和粗糙度贴图（必须给 uv）",
                "authored": minimal_color(),
                "valid": True,
                "summary": {"entities": 1, "templates": 0, "models": 0, "textureUrls": 2},
            },
            {
                "name": "minimal",
                "description": "只有一个带外链颜色贴图的物件（不合法的用例都从它改一处得来）",
                "authored": minimal_texture(),
                "valid": True,
                "summary": {"entities": 1, "templates": 0, "models": 0, "textureUrls": 1},
            },
        ],
    }
    invalid = {
        "kind": "authored",
        "name": "texture-urls-invalid",
        "description": "外链贴图写错的物件集：接口服务浅层校验就要拒绝（处理服务的完整校验当然也拒绝）；"
        "每个用例只错一处",
        "cases": invalid_cases(),
    }
    return {"authored_texture_urls_valid": valid, "authored_texture_urls_invalid": invalid}


# ---------------------------------------------------------------------------- 写出 / 核对


def outputs() -> dict[Path, str]:
    files: dict[Path, str] = {}
    for case in uv_cases():
        files[VECTORS / "uv" / f"{case.file}.json"] = to_json(uv_vector(case)) + "\n"
    for name, vector in authored_vectors().items():
        files[VECTORS / "authored" / f"{name}.json"] = to_json(vector) + "\n"
    return files


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="只核对，不写文件")
    args = parser.parse_args(argv)
    files = outputs()
    stale = []
    for path, text in files.items():
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                stale.append(path)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    for folder in ("uv", "authored"):
        known = {p for p in files if p.parent.name == folder}
        extra = [p for p in (VECTORS / folder).glob("*.json") if p not in known]
        if extra and args.check:
            stale.extend(extra)
        elif extra:
            for path in extra:
                path.unlink()
    if stale:
        for path in stale:
            print(f"过期或多余：{path.relative_to(VECTORS)}", file=sys.stderr)
        return 1
    print(f"{'核对' if args.check else '写出'} {len(files)} 个文件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
