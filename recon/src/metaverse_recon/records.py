"""物件和锚点记录（设计 4.4、SHAPES 3），校验规则与接口服务 `metaverse-core/src/record.rs` 一致。

`records { _id: 内容哈希, kind: entity | anchor, spaceId, body }`，
内容哈希 = `{"body": …, "kind": …, "spaceId": …}` 规范化后的 sha256。

处理服务写进去的记录必须能通过接口服务的同一套校验：接口服务读取时只反序列化不校验，但之后草稿对这些
物件、锚点做任何修改（移动锚点、只改可见性等）都会重新校验整个 body，不合格就改不动了。
"""

from __future__ import annotations

import math
import unicodedata
from collections.abc import Mapping, Sequence
from typing import Any

from .canonical import canonical_json, content_hash, is_sha256_hex
from .ids import SPACE_ANCHOR_ID, is_object_id
from .shapes import (
    SHADING_MODES,
    Bounds,
    ShapeError,
    rounded_bounds,
    shape_bounds,
    validate_opacity,
    validate_shape,
)

MAX_PROPS_BYTES = 16 * 1024
MAX_LABEL_CHARS = 200
BOUNDS_TOLERANCE = 1e-6

ENTITY_KINDS = ("structure", "object", "template")
LAYERS = ("rebuilt", "ext")
ANCHOR_KINDS = ("table", "seat", "zone", "door", "camera", "counter", "space")
VISIBILITIES = ("public", "internal")
MAX_GRID_COORD = 1 << 30
MAX_POSITION = 1e5

# 外部模型的署名（`props.source` 是对象时，docs/SHAPES.md 第 3 节）。
SOURCE_LIBRARIES = ("polyhaven", "objaverse", "sketchfab")
# 明确可商用、不传染的许可（NC、ND、SA 一律排除）。
SOURCE_LICENSES = ("CC0-1.0", "CC-BY-4.0", "CC-BY-3.0")
SOURCE_FIELDS = ("library", "id", "page", "author", "license", "title")
MAX_SOURCE_TEXT_CHARS = 200
MAX_SOURCE_URL_CHARS = 2000


class RecordError(ValueError):
    pass


def check_label(label: Any) -> None:
    """标签：字符串，不超过 200 个字符，不含控制字符（Unicode 类别 Cc，同 Rust `char::is_control`）。"""
    if (
        not isinstance(label, str)
        or len(label) > MAX_LABEL_CHARS
        or any(unicodedata.category(ch) == "Cc" for ch in label)
    ):
        raise RecordError("label 不超过 200 个字符，不能含控制字符")


def _is_control(ch: str) -> bool:
    return unicodedata.category(ch) == "Cc"


def is_https_url(url: Any) -> bool:
    """来源页地址：`https://` 开头、后面至少一个字符，不超过 2000 个字符，不含空白和控制字符
    （空白按 Rust `char::is_whitespace`，即 Unicode White_Space）。"""
    return (
        isinstance(url, str)
        and len(url) > len("https://")
        and url.startswith("https://")
        and len(url) <= MAX_SOURCE_URL_CHARS
        and not any(ch.isspace() or _is_control(ch) for ch in url)
    )


def model_source(
    *, library: str, id: str, page: str, author: str, license: str, title: str
) -> dict[str, str]:
    """构造并校验外部模型的署名（放进物件的 `props.source`）。"""
    source = {
        "library": library,
        "id": id,
        "page": page,
        "author": author,
        "license": license,
        "title": title,
    }
    validate_model_source(source)
    return source


def validate_model_source(source: Any) -> None:
    """署名（Rust `ModelSource::validate`）：六个字段都是字符串、不能有别的字段；库和许可只取白名单里的值，
    编号、作者、标题 1 到 200 个字符且不含控制字符，来源页必须是 https 地址。"""
    if not isinstance(source, dict):
        raise RecordError("props.source 必须是对象")
    unknown = set(source) - set(SOURCE_FIELDS)
    if unknown:
        raise RecordError(f"props.source 有不认识的字段：{sorted(unknown)}")
    for key in SOURCE_FIELDS:
        if not isinstance(source.get(key), str):
            raise RecordError(f"props.source.{key} 必须是字符串")
    if source["library"] not in SOURCE_LIBRARIES:
        raise RecordError("props.source.library 只能是 polyhaven、objaverse 或 sketchfab")
    if source["license"] not in SOURCE_LICENSES:
        raise RecordError("props.source.license 只能是 CC0-1.0、CC-BY-4.0 或 CC-BY-3.0（可商用、不传染）")
    for key in ("id", "author", "title"):
        text = source[key]
        if not 0 < len(text) <= MAX_SOURCE_TEXT_CHARS or any(_is_control(ch) for ch in text):
            raise RecordError(f"props.source.{key} 必须是 1 到 200 个字符，不含控制字符")
    if not is_https_url(source["page"]):
        raise RecordError("props.source.page 必须是 https 地址（不超过 2000 个字符，不含空白和控制字符）")


def validate_props(props: Mapping[str, Any]) -> None:
    """`props` 里有结构的键：`source` 是对象时按署名校验；不是对象的 `source`（旧数据里识别来源的字符串
    `hint` / `rules`，现在写在 `detectedBy`）照旧当不透明的值。"""
    if isinstance(props.get("source"), dict):
        validate_model_source(props["source"])


def detected_by(props: Mapping[str, Any] | None) -> str | None:
    """物体的识别来源（`hint` 按提示、`rules` 按规则；只有物体重建算法写）。新数据写在 `props.detectedBy`；
    旧数据写在 `props.source`（字符串），一并认。`props.source` 是对象时是外部模型的署名，不是识别来源。"""
    props = props or {}
    for key in ("detectedBy", "source"):
        value = props.get(key)
        if isinstance(value, str):
            return value
    return None


def _validate_model_material(material: Any) -> None:
    if not isinstance(material, dict):
        raise RecordError("material 必须是对象")
    unknown = set(material) - {"tint", "opacity", "unlit", "shading"}
    if unknown:
        raise RecordError(f"material 有不认识的字段：{sorted(unknown)}")
    if material.get("shading") is not None and material["shading"] not in SHADING_MODES:
        raise RecordError("material.shading 只能是 baked 或 albedo")
    tint = material.get("tint")
    if tint is not None and not (
        isinstance(tint, list) and len(tint) == 3 and all(_is_int(c) and 0 <= c <= 255 for c in tint)
    ):
        raise RecordError("material.tint 必须是 3 个 0–255 的整数")
    if material.get("unlit") is not None and not isinstance(material["unlit"], bool):
        raise RecordError("material.unlit 必须是布尔值")
    try:
        validate_opacity("material.opacity", material.get("opacity"))
    except ShapeError as error:
        raise RecordError(str(error)) from error


def record_hash(kind: str, space_id: str, body: Mapping[str, Any]) -> str:
    """`records._id`：`{"body", "kind", "spaceId"}` 规范化后的 sha256。"""
    return content_hash({"body": body, "kind": kind, "spaceId": space_id})


def entity_body(
    *,
    entity_id: str,
    kind: str,
    shape: Mapping[str, Any] | None = None,
    layer: str = "rebuilt",
    label: str | None = None,
    anchor_id: str | None = None,
    region_id: str | None = None,
    asset_hash: str | None = None,
    material: Mapping[str, Any] | None = None,
    textures: Sequence[str] | None = None,
    bounds: Bounds | None = None,
    fit: Mapping[str, float] | None = None,
    props: Mapping[str, Any] | None = None,
    templates: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """构造物件记录的 body 并校验。不给 `bounds` 时按形状算出来（向外取整到 0.1 毫米）。

    引用外部模型时给 `asset_hash`（处理后的 glb）和 `bounds`，可以带 `material`（tint / opacity / unlit，
    给整个模型调外观），署名放进 `props={"source": model_source(...)}`。"""
    body: dict[str, Any] = {"entityId": entity_id, "layer": layer, "kind": kind}
    if label is not None:
        body["label"] = label
    if anchor_id is not None:
        body["anchorId"] = anchor_id
    if region_id is not None:
        body["regionId"] = region_id
    if shape is not None:
        body["shape"] = dict(shape)
    if asset_hash is not None:
        body["assetHash"] = asset_hash
    if material is not None:
        body["material"] = dict(material) if isinstance(material, Mapping) else material
    if textures:
        body["textures"] = sorted(set(textures))
    if bounds is None:
        if shape is None:
            raise RecordError("没有 shape 时必须给出 bounds")
        bounds = rounded_bounds(shape_bounds(shape, templates))
    body["bounds"] = {"min": list(bounds["min"]), "max": list(bounds["max"])}
    if fit is not None:
        body["fit"] = {"meanCm": fit["meanCm"], "p90Cm": fit["p90Cm"], "coverage3cm": fit["coverage3cm"]}
    body["props"] = dict(props or {})
    validate_entity_body(body, templates)
    return body


def _contains(outer: Bounds, inner: Bounds, tol: float) -> bool:
    return all(
        outer["min"][k] <= inner["min"][k] + tol and outer["max"][k] >= inner["max"][k] - tol
        for k in range(3)
    )


def validate_entity_body(
    body: Mapping[str, Any], templates: Mapping[str, Mapping[str, Any]] | None = None
) -> None:
    allowed = {
        "entityId", "layer", "kind", "label", "anchorId", "regionId", "shape",
        "assetHash", "material", "textures", "bounds", "fit", "props",
    }  # fmt: skip
    unknown = set(body) - allowed
    if unknown:
        raise RecordError(f"物件记录有不认识的字段：{sorted(unknown)}")
    if not is_object_id(body.get("entityId")) or body["entityId"].startswith("_"):
        raise RecordError("entityId 格式不对")
    if body.get("layer") not in LAYERS:
        raise RecordError("layer 必须是 rebuilt 或 ext")
    if body.get("kind") not in ENTITY_KINDS:
        raise RecordError("kind 必须是 structure、object 或 template")
    if body.get("label") is not None:
        check_label(body["label"])
    for name in ("anchorId", "regionId"):
        if body.get(name) is not None and not is_object_id(body[name]):
            raise RecordError(f"{name} 格式不对")
    if body.get("shape") is None and body.get("assetHash") is None:
        raise RecordError("物件至少要有 shape 或 assetHash")
    if body.get("kind") == "template" and body.get("shape") is None:
        raise RecordError("模板必须给出 shape")
    if body.get("assetHash") is not None and not is_sha256_hex(body["assetHash"]):
        raise RecordError("assetHash 必须是 64 位小写十六进制")
    if body.get("material") is not None:
        _validate_model_material(body["material"])
        if body.get("assetHash") is None:
            raise RecordError("material 只用于模型，必须和 assetHash 一起给")
    textures = body.get("textures")
    if textures is not None and (len(textures) > 64 or not all(is_sha256_hex(t) for t in textures)):
        raise RecordError("textures 必须是至多 64 个资源哈希")
    bounds = body.get("bounds")
    if not (
        isinstance(bounds, dict)
        and all(isinstance(bounds.get(k), list) and len(bounds[k]) == 3 for k in ("min", "max"))
        and all(bounds["min"][i] <= bounds["max"][i] for i in range(3))
    ):
        raise RecordError("bounds 必须是 {min, max} 且 min ≤ max")
    fit = body.get("fit")
    if fit is not None:
        values = [fit.get("meanCm"), fit.get("p90Cm"), fit.get("coverage3cm")]
        if not all(isinstance(v, int | float) and v >= 0 for v in values) or values[2] > 1:
            raise RecordError("fit 取值不合法")
    if len(canonical_json(body.get("props", {})).encode()) > MAX_PROPS_BYTES:
        raise RecordError("props 超过 16KB")
    validate_props(body.get("props") or {})
    shape = body.get("shape")
    if shape is not None:
        validate_shape(shape)
        if not _contains(bounds, shape_bounds(shape, templates), BOUNDS_TOLERANCE):
            raise RecordError("bounds 没有包住形状的实际范围")


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate_anchor_body(body: Mapping[str, Any]) -> None:
    """锚点记录的 body（接口服务 `AnchorBody::validate`）：位置用格子盒子 `box` 或点 `position`（米）二选一，
    空间级锚点 `_space` 没有位置。"""
    allowed = {"anchorId", "kind", "box", "position", "label", "visibility"}
    unknown = set(body) - allowed
    if unknown:
        raise RecordError(f"锚点记录有不认识的字段：{sorted(unknown)}")
    anchor_id, kind = body.get("anchorId"), body.get("kind")
    reserved = anchor_id == SPACE_ANCHOR_ID
    if not is_object_id(anchor_id) or (anchor_id.startswith("_") and not reserved):
        raise RecordError("anchorId 格式不对（以 _ 开头的编号保留）")
    if kind not in ANCHOR_KINDS:
        raise RecordError(f"锚点类型必须是 {'、'.join(ANCHOR_KINDS)} 之一")
    if reserved != (kind == "space"):
        raise RecordError("只有 _space 锚点的类型是 space")
    if body.get("visibility") not in VISIBILITIES:
        raise RecordError("visibility 必须是 public 或 internal")
    if body.get("label") is not None:
        check_label(body["label"])
    box, position = body.get("box"), body.get("position")
    if kind == "space":
        if box is not None or position is not None:
            raise RecordError("_space 锚点没有位置")
        return
    if (box is None) == (position is None):
        raise RecordError("锚点必须且只能给出 box 或 position")
    if box is not None:
        if not (
            isinstance(box, list | tuple)
            and len(box) == 6
            and all(_is_int(v) and abs(v) <= MAX_GRID_COORD for v in box)
            and all(box[k] < box[k + 3] for k in range(3))
        ):
            raise RecordError("box 必须是 6 个整数 [x0,y0,z0,x1,y1,z1]，且 min < max")
    elif not (
        isinstance(position, list | tuple)
        and len(position) == 3
        and all(
            isinstance(v, int | float)
            and not isinstance(v, bool)
            and math.isfinite(v)
            and abs(v) <= MAX_POSITION
            for v in position
        )
    ):
        raise RecordError("position 必须是 3 个有限值（米）")
