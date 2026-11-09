"""形状词表（SHAPES 2）：构造、校验、包围盒。

规则与接口服务 `metaverse-core/src/shape.rs` 一致（测试向量 `shape_*.json` 由它生成）：

1. 局部包围盒按解析几何算，与分段数无关：
   - `box`：`[-w/2, 0, -d/2]`–`[w/2, h, d/2]`（圆角、倒角只会缩小，忽略）；
   - `cylinder`：半径取 `max(radius, radiusTop)`；`cone`：按解析圆；
   - `extrude`：轮廓的二维包围盒（含圆弧的极值点，忽略圆角）× `[0, height]`；
   - `lathe`：`r` 的最大值决定 x、z 范围（不管 `angle` 一律按整圈），y 取轮廓的最小、最大值；
   - `sweep`：路径点的包围盒向各方向扩出截面外接半径（圆 `r`，矩形 `√(w²+h²)/2`，忽略 `smooth`）；
   - `loft`：各截面轮廓包围盒的并 × `[第一个 y, 最后一个 y]`；
   - `group`：各子形状（含子形状自己的变换）包围盒的并；`instance`：模板（含模板自己的变换）的包围盒。
2. 再用 `transform` 变换局部包围盒的 8 个角点取包围盒：`M = T · Ry(yaw) · Rx(pitch) · Rz(roll) · S`，
   角度单位是度；90° 的整数倍时正弦、余弦取精确的 0、±1。

二维轮廓的点写作 `[x, z]`，在数学平面 (u, v) = (x, z) 上逆时针排列（有向面积为正）；
`bulge` = tan(圆心角 / 4)，正值表示逆时针转的圆弧（对逆时针轮廓就是向外凸）。
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from .canonical import is_sha256_hex
from .ids import is_object_id

MAX_SHAPE_NODES = 4096
MAX_SHAPE_DEPTH = 16
MAX_POINTS = 1024
MAX_SEGMENTS = 256
MAX_FILLET_SEGMENTS = 32
MAX_COORD = 100_000.0
MAX_SCALE = 1000.0
MAX_ANGLE = 3600.0
MAX_BULGE = 1000.0
MIN_LOFT_SECTIONS = 2
MAX_LOFT_SECTIONS = 8

UV_MODES = ("box", "planar", "cylindrical", "mesh")

Vec3 = list[float]
Bounds = dict[str, list[float]]  # {"min": [x,y,z], "max": [x,y,z]}


class ShapeError(ValueError):
    """校验或计算失败。`path` 是 JSON 路径（如 `$.children[2].size[0]`），解析阶段的错误为 None。"""

    def __init__(self, path: str | None, message: str) -> None:
        super().__init__(f"{path}: {message}" if path else message)
        self.path = path
        self.message = message


# ---------------------------------------------------------------------------- 构造


def r4(value: float, digits: int = 4) -> float:
    """坐标和尺寸统一保留 4 位小数（0.1 毫米），整数值写成整数，让 JSON 更短、哈希更稳定。"""
    out = round(float(value), digits)
    if out == 0:
        return 0
    return int(out) if out == int(out) and abs(out) < 2**53 else out


def transform(
    position: Sequence[float] | None = None,
    yaw: float | None = None,
    pitch: float | None = None,
    roll: float | None = None,
    scale: Sequence[float] | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if position is not None:
        out["position"] = [r4(v) for v in position]
    for name, value in (("yaw", yaw), ("pitch", pitch), ("roll", roll)):
        if value is not None and r4(value, 6) != 0:
            out[name] = r4(value, 6)
    if scale is not None:
        out["scale"] = [r4(v, 6) for v in scale]
    return out


def color_material(rgb: Sequence[int]) -> dict[str, Any]:
    return {"color": [int(max(0, min(255, round(c)))) for c in rgb]}


def texture_material(
    texture_hash: str, uv: str = "planar", tint: Sequence[int] | None = None
) -> dict[str, Any]:
    if not is_sha256_hex(texture_hash):
        raise ShapeError("$.material.texture", "贴图必须是 64 位小写十六进制的资源哈希")
    if uv not in UV_MODES:
        raise ShapeError("$.material.uv", "uv 不认识")
    out: dict[str, Any] = {"texture": texture_hash, "uv": uv}
    if tint is not None:
        out["tint"] = [int(c) for c in tint]
    return out


def _decorate(shape: dict[str, Any], xf: Mapping[str, Any] | None, material: Mapping[str, Any] | None):
    if xf:
        shape["transform"] = dict(xf)
    if material:
        shape["material"] = dict(material)
    return shape


def box(
    size: Sequence[float],
    *,
    fillet: float | None = None,
    chamfer: float | None = None,
    segments: int | None = None,
    xf: Mapping[str, Any] | None = None,
    material: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    shape: dict[str, Any] = {"type": "box", "size": [r4(v) for v in size]}
    if fillet:
        shape["fillet"] = r4(fillet)
    if chamfer:
        shape["chamfer"] = r4(chamfer)
    if segments is not None:
        shape["segments"] = int(segments)
    return _decorate(shape, xf, material)


def cylinder(
    radius: float,
    height: float,
    *,
    radius_top: float | None = None,
    segments: int | None = None,
    xf: Mapping[str, Any] | None = None,
    material: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    shape: dict[str, Any] = {"type": "cylinder", "radius": r4(radius), "height": r4(height)}
    if radius_top is not None:
        shape["radiusTop"] = r4(radius_top)
    if segments is not None:
        shape["segments"] = int(segments)
    return _decorate(shape, xf, material)


def outline(points: Iterable[Sequence[float]], arcs=None, fillets=None) -> dict[str, Any]:
    out: dict[str, Any] = {"points": [[r4(p[0]), r4(p[1])] for p in points]}
    if arcs:
        out["arcs"] = [{"from": int(a["from"]), "bulge": r4(a["bulge"], 6)} for a in arcs]
    if fillets:
        out["fillets"] = [{"at": int(f["at"]), "radius": r4(f["radius"])} for f in fillets]
    return out


def extrude(
    outline_: Mapping[str, Any],
    height: float,
    *,
    xf: Mapping[str, Any] | None = None,
    material: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    shape: dict[str, Any] = {"type": "extrude", "outline": dict(outline_), "height": r4(height)}
    return _decorate(shape, xf, material)


def group(children: Sequence[Mapping[str, Any]], *, xf: Mapping[str, Any] | None = None) -> dict[str, Any]:
    return _decorate({"type": "group", "children": [dict(c) for c in children]}, xf, None)


def instance(
    template_id: str, *, xf: Mapping[str, Any] | None = None, material: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    return _decorate({"type": "instance", "template": template_id}, xf, material)


# ---------------------------------------------------------------------------- 校验

_COMMON = {"type", "transform", "material"}
_FIELDS = {
    "box": ({"size"}, {"fillet", "chamfer", "segments"}),
    "cylinder": ({"radius", "height"}, {"radiusTop", "segments", "fillet"}),
    "cone": ({"radius", "height"}, {"segments"}),
    "extrude": ({"outline", "height"}, {"fillet", "chamfer"}),
    "lathe": ({"profile"}, {"segments", "angle"}),
    "sweep": ({"path", "section"}, {"smooth", "caps"}),
    "loft": ({"sections"}, set()),
    "group": ({"children"}, set()),
    "instance": ({"template"}, set()),
}


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _is_uint(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _fields(obj: Any, required: set[str], optional: set[str], what: str) -> dict[str, Any]:
    """解析阶段：类型必须是对象，不能缺字段，不能有不认识的字段（对应 serde 的 deny_unknown_fields）。"""
    if not isinstance(obj, dict):
        raise ShapeError(None, f"{what} 必须是对象")
    unknown = set(obj) - required - optional
    if unknown:
        raise ShapeError(None, f"{what} 有不认识的字段：{sorted(unknown)}")
    missing = required - set(obj)
    if missing:
        raise ShapeError(None, f"{what} 缺少字段：{sorted(missing)}")
    return obj


def _num(value: Any, what: str) -> float:
    if not _is_number(value):
        raise ShapeError(None, f"{what} 必须是数字")
    return float(value)


def _vec(value: Any, n: int, what: str) -> list[float]:
    if not isinstance(value, list) or len(value) != n:
        raise ShapeError(None, f"{what} 必须是 {n} 个数字")
    return [_num(v, what) for v in value]


def _finite(path: str, value: float) -> None:
    if not (math.isfinite(value) and abs(value) <= MAX_COORD):
        raise ShapeError(path, "必须是有限值且绝对值不超过 100000")


def _positive(path: str, value: float) -> None:
    _finite(path, value)
    if not value > 0:
        raise ShapeError(path, "必须大于 0")


def _non_negative(path: str, value: float) -> None:
    _finite(path, value)
    if value < 0:
        raise ShapeError(path, "不能小于 0")


def _segments(path: str, value: Any, lo: int, hi: int) -> None:
    if value is None:
        return
    if not _is_uint(value):
        raise ShapeError(None, "分段数必须是非负整数")
    if not lo <= value <= hi:
        raise ShapeError(path, f"分段数必须在 {lo} 到 {hi} 之间")


def _optional(path: str, obj: Mapping[str, Any], key: str, check) -> None:
    if key in obj and obj[key] is not None:
        check(f"{path}.{key}", _num(obj[key], key))


def signed_area(points: Sequence[Sequence[float]]) -> float:
    total = 0.0
    n = len(points)
    for i in range(n):
        a, b = points[i], points[(i + 1) % n]
        total += a[0] * b[1] - b[0] * a[1]
    return total / 2.0


def _validate_transform(path: str, value: Any) -> None:
    obj = _fields(value, set(), {"position", "yaw", "pitch", "roll", "scale"}, "transform")
    if obj.get("position") is not None:
        for i, v in enumerate(_vec(obj["position"], 3, "position")):
            _finite(f"{path}.position[{i}]", v)
    for name in ("yaw", "pitch", "roll"):
        if obj.get(name) is not None:
            v = _num(obj[name], name)
            if not (math.isfinite(v) and abs(v) <= MAX_ANGLE):
                raise ShapeError(f"{path}.{name}", "角度必须是有限值且绝对值不超过 3600")
    if obj.get("scale") is not None:
        for i, v in enumerate(_vec(obj["scale"], 3, "scale")):
            if not math.isfinite(v) or v == 0 or abs(v) > MAX_SCALE:
                raise ShapeError(f"{path}.scale[{i}]", "缩放必须是非零有限值且绝对值不超过 1000")


def _rgb(value: Any, what: str) -> None:
    if not (isinstance(value, list) and len(value) == 3 and all(_is_uint(c) and c <= 255 for c in value)):
        raise ShapeError(None, f"{what} 必须是 3 个 0–255 的整数")


def _validate_material(path: str, value: Any) -> None:
    obj = _fields(value, set(), {"color", "texture", "uv", "tint"}, "material")
    for key in ("color", "tint"):
        if obj.get(key) is not None:
            _rgb(obj[key], key)
    if obj.get("uv") is not None and obj["uv"] not in UV_MODES:
        raise ShapeError(None, "uv 不认识")
    if obj.get("texture") is not None and not isinstance(obj["texture"], str):
        raise ShapeError(None, "texture 必须是字符串")
    has_color, has_texture = obj.get("color") is not None, obj.get("texture") is not None
    if has_color and not has_texture:
        if obj.get("uv") is not None or obj.get("tint") is not None:
            raise ShapeError(path, "纯色材质不能带 uv 或 tint")
    elif has_texture and not has_color:
        if not is_sha256_hex(obj["texture"]):
            raise ShapeError(f"{path}.texture", "贴图必须是 64 位小写十六进制的资源哈希")
        if obj.get("uv") is None:
            raise ShapeError(path, "贴图材质必须给出 uv")
    else:
        raise ShapeError(path, "材质必须且只能给出 color 或 texture")


def _parse_outline(value: Any) -> dict[str, Any]:
    obj = _fields(value, {"points"}, {"closed", "arcs", "fillets"}, "outline")
    if not isinstance(obj["points"], list):
        raise ShapeError(None, "points 必须是数组")
    for p in obj["points"]:
        _vec(p, 2, "points")
    if obj.get("closed") is not None and not isinstance(obj["closed"], bool):
        raise ShapeError(None, "closed 必须是布尔值")
    for arc in obj.get("arcs") or []:
        a = _fields(arc, {"from", "bulge"}, set(), "arc")
        if not _is_uint(a["from"]):
            raise ShapeError(None, "from 必须是非负整数")
        _num(a["bulge"], "bulge")
    for fillet in obj.get("fillets") or []:
        f = _fields(fillet, {"at", "radius"}, set(), "fillet")
        if not _is_uint(f["at"]):
            raise ShapeError(None, "at 必须是非负整数")
        _num(f["radius"], "radius")
    return obj


def _validate_outline(path: str, obj: Mapping[str, Any]) -> None:
    if obj.get("closed") is False:
        raise ShapeError(f"{path}.closed", "拉伸和放样的轮廓必须闭合")
    points = obj["points"]
    if not 3 <= len(points) <= MAX_POINTS:
        raise ShapeError(f"{path}.points", "轮廓需要 3 到 1024 个点")
    for i, p in enumerate(points):
        for k in range(2):
            _finite(f"{path}.points[{i}][{k}]", float(p[k]))
    if signed_area(points) <= 0:
        raise ShapeError(f"{path}.points", "轮廓的点必须逆时针排列（有向面积为正）")
    seen: set[int] = set()
    for i, arc in enumerate(obj.get("arcs") or []):
        at = f"{path}.arcs[{i}]"
        if arc["from"] >= len(points) or arc["from"] in seen:
            raise ShapeError(at, "from 超出点数或重复")
        seen.add(arc["from"])
        b = float(arc["bulge"])
        if not (math.isfinite(b) and abs(b) <= MAX_BULGE):
            raise ShapeError(at, "bulge 必须是有限值且绝对值不超过 1000")
    seen = set()
    for i, fillet in enumerate(obj.get("fillets") or []):
        at = f"{path}.fillets[{i}]"
        if fillet["at"] >= len(points) or fillet["at"] in seen:
            raise ShapeError(at, "at 超出点数或重复")
        seen.add(fillet["at"])
        _positive(f"{at}.radius", float(fillet["radius"]))


def validate_shape(shape: Any) -> None:
    """结构校验：字段取值、点数、嵌套深度、节点数。不解析模板引用（包围盒计算时才查模板）。"""
    nodes = [0]
    _validate_at(shape, "$", 0, nodes)


def _validate_at(shape: Any, path: str, depth: int, nodes: list[int]) -> None:
    if not isinstance(shape, dict):
        raise ShapeError(None, "形状必须是对象")
    kind = shape.get("type")
    if kind not in _FIELDS:
        raise ShapeError(None, f"不认识的形状类型：{kind!r}")
    required, optional = _FIELDS[kind]
    _fields(shape, required | {"type"}, optional | _COMMON, kind)
    nodes[0] += 1
    if nodes[0] > MAX_SHAPE_NODES:
        raise ShapeError(path, "形状节点数超过 4096")
    if depth > MAX_SHAPE_DEPTH:
        raise ShapeError(path, "形状嵌套超过 16 层")
    if shape.get("transform") is not None:
        _validate_transform(f"{path}.transform", shape["transform"])
    if shape.get("material") is not None:
        _validate_material(f"{path}.material", shape["material"])

    if kind == "box":
        for i, v in enumerate(_vec(shape["size"], 3, "size")):
            _positive(f"{path}.size[{i}]", v)
        _optional(path, shape, "fillet", _non_negative)
        _optional(path, shape, "chamfer", _non_negative)
        _segments(f"{path}.segments", shape.get("segments"), 1, MAX_FILLET_SEGMENTS)
    elif kind == "cylinder":
        _positive(f"{path}.radius", _num(shape["radius"], "radius"))
        _positive(f"{path}.height", _num(shape["height"], "height"))
        _optional(path, shape, "radiusTop", _non_negative)
        _segments(f"{path}.segments", shape.get("segments"), 3, MAX_SEGMENTS)
        _optional(path, shape, "fillet", _non_negative)
    elif kind == "cone":
        _positive(f"{path}.radius", _num(shape["radius"], "radius"))
        _positive(f"{path}.height", _num(shape["height"], "height"))
        _segments(f"{path}.segments", shape.get("segments"), 3, MAX_SEGMENTS)
    elif kind == "extrude":
        _validate_outline(f"{path}.outline", _parse_outline(shape["outline"]))
        _positive(f"{path}.height", _num(shape["height"], "height"))
        _optional(path, shape, "fillet", _non_negative)
        _optional(path, shape, "chamfer", _non_negative)
    elif kind == "lathe":
        profile = shape["profile"]
        if not isinstance(profile, list):
            raise ShapeError(None, "profile 必须是数组")
        pts = [_vec(p, 2, "profile") for p in profile]
        if not 2 <= len(pts) <= MAX_POINTS:
            raise ShapeError(f"{path}.profile", "旋转体轮廓需要 2 到 1024 个点")
        for i, (r, y) in enumerate(pts):
            _non_negative(f"{path}.profile[{i}][0]", r)
            _finite(f"{path}.profile[{i}][1]", y)
        if all(r == 0 for r, _ in pts):
            raise ShapeError(f"{path}.profile", "旋转体轮廓至少要有一个点不在轴上")
        _segments(f"{path}.segments", shape.get("segments"), 3, MAX_SEGMENTS)
        if shape.get("angle") is not None:
            angle = _num(shape["angle"], "angle")
            if not (math.isfinite(angle) and 0 < angle <= 360):
                raise ShapeError(f"{path}.angle", "旋转角度必须在 (0, 360] 之间")
    elif kind == "sweep":
        points = shape["path"]
        if not isinstance(points, list):
            raise ShapeError(None, "path 必须是数组")
        pts = [_vec(p, 3, "path") for p in points]
        section = shape["section"]
        if not isinstance(section, dict) or len(section) != 1 or next(iter(section)) not in ("circle", "rect"):
            raise ShapeError(None, "section 必须是 {circle: r} 或 {rect: [w, h]}")
        if shape.get("caps") is not None and not isinstance(shape["caps"], bool):
            raise ShapeError(None, "caps 必须是布尔值")
        if not 2 <= len(pts) <= MAX_POINTS:
            raise ShapeError(f"{path}.path", "扫掠路径需要 2 到 1024 个点")
        for i, p in enumerate(pts):
            for k, v in enumerate(p):
                _finite(f"{path}.path[{i}][{k}]", v)
        if "circle" in section:
            _positive(f"{path}.section.circle", _num(section["circle"], "circle"))
        else:
            w, h = _vec(section["rect"], 2, "rect")
            _positive(f"{path}.section.rect[0]", w)
            _positive(f"{path}.section.rect[1]", h)
        _optional(path, shape, "smooth", _non_negative)
    elif kind == "loft":
        sections = shape["sections"]
        if not isinstance(sections, list):
            raise ShapeError(None, "sections 必须是数组")
        parsed = []
        for s in sections:
            obj = _fields(s, {"y", "outline"}, set(), "loft section")
            parsed.append((_num(obj["y"], "y"), _parse_outline(obj["outline"])))
        if not MIN_LOFT_SECTIONS <= len(parsed) <= MAX_LOFT_SECTIONS:
            raise ShapeError(f"{path}.sections", "放样需要 2 到 8 个截面")
        for i, (y, ol) in enumerate(parsed):
            at = f"{path}.sections[{i}]"
            _finite(f"{at}.y", y)
            if i > 0 and y <= parsed[i - 1][0]:
                raise ShapeError(f"{at}.y", "截面的 y 必须递增")
            _validate_outline(f"{at}.outline", ol)
    elif kind == "group":
        children = shape["children"]
        if not isinstance(children, list):
            raise ShapeError(None, "children 必须是数组")
        if not children:
            raise ShapeError(f"{path}.children", "组合至少要有一个子形状")
        for i, child in enumerate(children):
            _validate_at(child, f"{path}.children[{i}]", depth + 1, nodes)
    elif kind == "instance":
        if not isinstance(shape["template"], str):
            raise ShapeError(None, "template 必须是字符串")
        if not is_object_id(shape["template"]):
            raise ShapeError(f"{path}.template", "模板编号格式不对")


# ---------------------------------------------------------------------------- 包围盒


def sin_cos_degrees(degrees: float) -> tuple[float, float]:
    """角度的正弦和余弦；90° 的整数倍取精确值，保证各语言结果一致。"""
    reduced = math.fmod(degrees, 360.0)
    if reduced < 0:
        reduced += 360.0
    if reduced == 0:
        return 0.0, 1.0
    if reduced == 90:
        return 1.0, 0.0
    if reduced == 180:
        return 0.0, -1.0
    if reduced == 270:
        return -1.0, 0.0
    radians = math.radians(degrees)
    return math.sin(radians), math.cos(radians)


def apply_transform(xf: Mapping[str, Any] | None, point: Sequence[float]) -> list[float]:
    """`M · p`，`M = T · Ry(yaw) · Rx(pitch) · Rz(roll) · S`。"""
    xf = xf or {}
    scale = xf.get("scale") or [1.0, 1.0, 1.0]
    x, y, z = point[0] * scale[0], point[1] * scale[1], point[2] * scale[2]
    if xf.get("roll") is not None:
        s, c = sin_cos_degrees(float(xf["roll"]))
        x, y = x * c - y * s, x * s + y * c
    if xf.get("pitch") is not None:
        s, c = sin_cos_degrees(float(xf["pitch"]))
        y, z = y * c - z * s, y * s + z * c
    if xf.get("yaw") is not None:
        s, c = sin_cos_degrees(float(xf["yaw"]))
        x, z = x * c + z * s, -x * s + z * c
    pos = xf.get("position") or [0.0, 0.0, 0.0]
    return [x + pos[0], y + pos[1], z + pos[2]]


def bounds_of_points(points: Iterable[Sequence[float]]) -> Bounds:
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    for p in points:
        for k in range(3):
            lo[k] = min(lo[k], float(p[k]))
            hi[k] = max(hi[k], float(p[k]))
    if lo[0] == math.inf:
        raise ShapeError("$", "没有点")
    return {"min": lo, "max": hi}


def union_bounds(a: Bounds, b: Bounds) -> Bounds:
    return {
        "min": [min(a["min"][k], b["min"][k]) for k in range(3)],
        "max": [max(a["max"][k], b["max"][k]) for k in range(3)],
    }


def _corners(b: Bounds) -> list[list[float]]:
    lo, hi = b["min"], b["max"]
    return [[(hi if i & 1 else lo)[0], (hi if i & 2 else lo)[1], (hi if i & 4 else lo)[2]] for i in range(8)]


def transform_bounds(xf: Mapping[str, Any] | None, b: Bounds) -> Bounds:
    if not xf:
        return b
    return bounds_of_points(apply_transform(xf, c) for c in _corners(b))


def arc_extremes(start: Sequence[float], end: Sequence[float], bulge: float) -> list[list[float]]:
    """从 start 到 end、凸度 bulge 的圆弧上，落在 u、v 轴向极值处的点。"""
    du, dv = end[0] - start[0], end[1] - start[1]
    chord = math.hypot(du, dv)
    if bulge == 0 or chord == 0:
        return []
    left = (-dv / chord, du / chord)
    offset = chord * (1 - bulge * bulge) / (4 * bulge)
    center = ((start[0] + end[0]) / 2 + left[0] * offset, (start[1] + end[1]) / 2 + left[1] * offset)
    radius = chord * (1 + bulge * bulge) / (4 * abs(bulge))
    sweep = 4 * math.atan(bulge)
    begin = math.atan2(start[1] - center[1], start[0] - center[0])
    out = []
    tau = 2 * math.pi
    for angle, direction in ((0.0, (1, 0)), (math.pi / 2, (0, 1)), (math.pi, (-1, 0)), (3 * math.pi / 2, (0, -1))):
        delta = (angle - begin) % tau if sweep > 0 else (begin - angle) % tau
        if delta <= abs(sweep):
            out.append([center[0] + radius * direction[0], center[1] + radius * direction[1]])
    return out


def outline_bounds_2d(ol: Mapping[str, Any]) -> tuple[list[float], list[float]]:
    points = ol["points"]
    lo = [float(points[0][0]), float(points[0][1])]
    hi = list(lo)

    def include(p: Sequence[float]) -> None:
        for k in range(2):
            lo[k] = min(lo[k], float(p[k]))
            hi[k] = max(hi[k], float(p[k]))

    for p in points:
        include(p)
    n = len(points)
    for arc in ol.get("arcs") or []:
        i = int(arc["from"])
        for p in arc_extremes(points[i], points[(i + 1) % n], float(arc["bulge"])):
            include(p)
    return lo, hi


def shape_bounds(shape: Mapping[str, Any], templates: Mapping[str, Mapping[str, Any]] | None = None) -> Bounds:
    """包围盒（含本形状自己的 transform）。模板循环引用、找不到模板、嵌套过深时报错。"""
    cache: dict[str, Bounds] = {}
    visiting: set[str] = set()
    return _bounds_at(shape, "$", 0, templates or {}, cache, visiting)


def _bounds_at(shape, path, depth, templates, cache, visiting) -> Bounds:
    if depth > MAX_SHAPE_DEPTH:
        raise ShapeError(path, "形状嵌套超过 16 层")
    kind = shape["type"]
    if kind == "box":
        w, h, d = (float(v) for v in shape["size"])
        local = {"min": [-w / 2, 0.0, -d / 2], "max": [w / 2, h, d / 2]}
    elif kind == "cylinder":
        r = max(float(shape["radius"]), float(shape.get("radiusTop", shape["radius"])))
        local = {"min": [-r, 0.0, -r], "max": [r, float(shape["height"]), r]}
    elif kind == "cone":
        r = float(shape["radius"])
        local = {"min": [-r, 0.0, -r], "max": [r, float(shape["height"]), r]}
    elif kind == "extrude":
        lo, hi = outline_bounds_2d(shape["outline"])
        local = {"min": [lo[0], 0.0, lo[1]], "max": [hi[0], float(shape["height"]), hi[1]]}
    elif kind == "lathe":
        profile = shape["profile"]
        reach = max(0.0, *(float(p[0]) for p in profile))
        ys = [float(p[1]) for p in profile]
        local = {"min": [-reach, min(ys), -reach], "max": [reach, max(ys), reach]}
    elif kind == "sweep":
        section = shape["section"]
        if "circle" in section:
            reach = float(section["circle"])
        else:
            w, h = (float(v) for v in section["rect"])
            reach = math.sqrt(w * w + h * h) / 2
        if not shape["path"]:
            raise ShapeError(path, "扫掠路径为空")
        b = bounds_of_points(shape["path"])
        local = {"min": [v - reach for v in b["min"]], "max": [v + reach for v in b["max"]]}
    elif kind == "loft":
        sections = shape["sections"]
        if not sections:
            raise ShapeError(path, "放样没有截面")
        lo2, hi2 = [math.inf, math.inf], [-math.inf, -math.inf]
        for s in sections:
            lo, hi = outline_bounds_2d(s["outline"])
            lo2 = [min(lo2[k], lo[k]) for k in range(2)]
            hi2 = [max(hi2[k], hi[k]) for k in range(2)]
        local = {
            "min": [lo2[0], float(sections[0]["y"]), lo2[1]],
            "max": [hi2[0], float(sections[-1]["y"]), hi2[1]],
        }
    elif kind == "group":
        result = None
        for i, child in enumerate(shape["children"]):
            b = _bounds_at(child, f"{path}.children[{i}]", depth + 1, templates, cache, visiting)
            result = b if result is None else union_bounds(result, b)
        if result is None:
            raise ShapeError(path, "组合没有子形状")
        local = result
    elif kind == "instance":
        tid = shape["template"]
        if tid in cache:
            local = cache[tid]
        else:
            if tid in visiting:
                raise ShapeError(path, f"模板 {tid} 循环引用")
            template = templates.get(tid)
            if template is None:
                raise ShapeError(path, f"找不到模板 {tid}")
            visiting.add(tid)
            local = _bounds_at(template, f"{path}<{tid}>", depth + 1, templates, cache, visiting)
            visiting.discard(tid)
            cache[tid] = local
    else:
        raise ShapeError(path, f"不认识的形状类型：{kind!r}")
    return transform_bounds(shape.get("transform"), local)


def rounded_bounds(b: Bounds, digits: int = 4) -> Bounds:
    """把包围盒向外取整到 `digits` 位小数，保证仍然包住实际范围（声明的包围盒必须包住形状）。"""
    scale = 10**digits
    return {
        "min": [r4(math.floor(v * scale - 1e-9) / scale, digits) for v in b["min"]],
        "max": [r4(math.ceil(v * scale + 1e-9) / scale, digits) for v in b["max"]],
    }
