"""按类别建议锚点（原来是处理服务导入扫描、重新重建时的规则，处理服务下线后搬到本地）。

只给有意义的物体建：桌子 → `table`、前台 → `counter`、沙发 → `zone`；椅子只在提示
`hints.objects[]` 写了 `anchor: true` 时 → `seat`；柜子、杂物、绿植、灯、立柱、圆形物件等不建（否则几十个
标签把场景盖住）。锚点编号用物体建议的 `anchorId`，标签用物体的标签，没有就用类别的中文名，`box` 是物体
包围盒覆盖的格子，`visibility: public`。

这是本地工具的建议：结果写进重建包的 `anchors`，服务端按 `ifNew` 只建本空间从没出现过的锚点。
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

from ..chunk import GRID_UNIT
from ..errors import PermanentJobError
from ..ids import is_object_id
from ..records import RecordError, validate_anchor_body

# 只给"有意义"的物体建锚点，按物体模块输出的类别（`props.category`）定锚点类型。
# 椅子只在提示里明确要求（`hints.objects[].anchor: true`）时才建座位锚点；
# 柜子、杂物、绿植、灯、立柱、圆形物件等一律不建（否则几十个标签把场景盖住）。
ANCHOR_CATEGORIES = {"table": "table", "counter": "counter", "sofa": "zone"}
SEAT_CATEGORY = "chair"
# 物体没有标签时，锚点标签用类别的中文名（与物体模块的默认标签相同）
CATEGORY_LABELS = {"table": "桌子", "counter": "前台", "sofa": "沙发", "chair": "椅子"}
# 提示里能要求座位锚点的类型（不写 kind 也算）：物体模块把 armchair、stool 当成椅子
SEAT_HINT_KINDS = {"chair", "armchair", "stool"}
# 提示的中心点离椅子的包围盒（俯视）超过这个距离就不算指的是它（米）
HINT_MATCH_M = 0.3
MAX_HINT_OBJECTS = 500


def _snap(value: float) -> float:
    r = round(value)
    return r if abs(value - r) < 1e-6 else value


def grid_cover(bounds: Mapping[str, Any]) -> list[int]:
    """米制包围盒 → 覆盖它的格子盒子（半开区间），与接口服务 `Aabb::grid_cover` 相同。"""
    lo = [math.floor(_snap(v / GRID_UNIT)) for v in bounds["min"]]
    hi = [math.ceil(_snap(v / GRID_UNIT)) for v in bounds["max"]]
    hi = [max(h, low + 1) for low, h in zip(lo, hi, strict=True)]
    return [*lo, *hi]


def object_category(body: Mapping[str, Any]) -> str | None:
    """物体模块写在 `props.category` 里的类别（chair、table、sofa、counter、cabinet、clutter……）。"""
    props = body.get("props")
    category = props.get("category") if isinstance(props, Mapping) else None
    return category if isinstance(category, str) else None


def _hint_xz(center: Any) -> tuple[float, float] | None:
    """提示的中心点 `[x, y, z]` 或 `[x, z]` → 俯视坐标 (x, z)（与物体模块读提示的方式相同）。"""
    if not isinstance(center, list) or len(center) not in (2, 3):
        return None
    if not all(isinstance(v, int | float) and not isinstance(v, bool) for v in center):
        return None
    vals = [float(v) for v in center]
    return (vals[0], vals[-1]) if all(math.isfinite(v) for v in vals) else None


def _rect_distance(xz: tuple[float, float], bounds: Mapping[str, Any]) -> tuple[float, float]:
    """俯视下点到包围盒的距离（在盒子里为 0），以及点到盒子中心的距离（并列时用）。"""
    lo, hi = bounds["min"], bounds["max"]
    dx = max(lo[0] - xz[0], 0.0, xz[0] - hi[0])
    dz = max(lo[2] - xz[1], 0.0, xz[1] - hi[2])
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    return math.hypot(dx, dz), math.hypot(xz[0] - cx, xz[1] - cz)


def requested_seats(entities: Mapping[str, Mapping[str, Any]], hints: Mapping[str, Any] | None) -> set[str]:
    """提示里要求建座位锚点的椅子（物件编号）。

    `hints.objects[]` 里写了 `anchor: true`、没写 `kind` 或 `kind` 是椅子的项，按中心点（只看 x、z）找椅子：
    中心落在椅子包围盒里或离它不超过 `HINT_MATCH_M`；几把都符合时取离得最近、再取盒子中心最近的那把。
    """
    raw = (hints or {}).get("objects")
    if not isinstance(raw, list):
        return set()
    chairs = [
        (eid, body["bounds"])
        for eid, body in sorted(entities.items())
        if body.get("kind") == "object" and object_category(body) == SEAT_CATEGORY
    ]
    out: set[str] = set()
    for item in raw[:MAX_HINT_OBJECTS]:
        if not isinstance(item, dict) or item.get("anchor") is not True:
            continue
        kind = item.get("kind")
        if kind is not None and (not isinstance(kind, str) or kind.strip().lower() not in SEAT_HINT_KINDS):
            continue
        xz = _hint_xz(item.get("center"))
        if xz is None:
            continue
        best = min(((*_rect_distance(xz, bounds), eid) for eid, bounds in chairs), default=None)
        if best is not None and best[0] <= HINT_MATCH_M:
            out.add(best[2])
    return out


def anchor_proposals(
    entities: Mapping[str, Mapping[str, Any]], hints: Mapping[str, Any] | None = None
) -> dict[str, dict[str, Any]]:
    """带建议锚点编号、类别值得建锚点的物体 → 锚点 body（`box` = 物体包围盒覆盖的格子，
    `visibility: public`）。

    桌子 → table、前台 → counter、沙发 → zone；椅子只在提示要求时 → seat；其他类别不建。
    `label` 用物体的标签（提示给的中文名，如"会议桌""前台"），没有就用类别的中文名。
    """
    seats = requested_seats(entities, hints)
    out: dict[str, dict[str, Any]] = {}
    for eid in sorted(entities):
        body = entities[eid]
        aid = body.get("anchorId")
        if body.get("kind") != "object" or not is_object_id(aid) or aid.startswith("_") or aid in out:
            continue
        category = object_category(body)
        kind = ANCHOR_CATEGORIES.get(category or "")
        if kind is None and category == SEAT_CATEGORY and eid in seats:
            kind = "seat"
        if kind is None:
            continue
        label = body.get("label")
        if not (isinstance(label, str) and label.strip()):
            label = CATEGORY_LABELS[category]
        anchor: dict[str, Any] = {
            "anchorId": aid,
            "kind": kind,
            "box": grid_cover(body["bounds"]),
            "label": label,
            "visibility": "public",
        }
        try:
            validate_anchor_body(anchor)  # 与接口服务 AnchorBody 同样的规则，之后草稿才改得动它
        except RecordError as error:
            raise PermanentJobError(f"物体 {eid} 的建议锚点 {aid} 不合法：{error}") from error
        out[aid] = anchor
    return out


__all__ = [
    "ANCHOR_CATEGORIES",
    "CATEGORY_LABELS",
    "SEAT_CATEGORY",
    "anchor_proposals",
    "grid_cover",
    "object_category",
    "requested_seats",
]
