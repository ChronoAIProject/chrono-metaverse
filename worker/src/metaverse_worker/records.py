"""物件记录（设计 4.4、SHAPES 3），与接口服务 `metaverse-core/src/record.rs` 一致。

`records { _id: 内容哈希, kind: entity | anchor, spaceId, body }`，
内容哈希 = `{"body": …, "kind": …, "spaceId": …}` 规范化后的 sha256。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .canonical import canonical_json, content_hash, is_sha256_hex
from .ids import is_object_id
from .shapes import Bounds, rounded_bounds, shape_bounds, validate_shape

MAX_PROPS_BYTES = 16 * 1024
MAX_LABEL_CHARS = 200
BOUNDS_TOLERANCE = 1e-6

ENTITY_KINDS = ("structure", "object", "template")
LAYERS = ("rebuilt", "ext")


class RecordError(ValueError):
    pass


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
    textures: Sequence[str] | None = None,
    bounds: Bounds | None = None,
    fit: Mapping[str, float] | None = None,
    props: Mapping[str, Any] | None = None,
    templates: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """构造物件记录的 body 并校验。不给 `bounds` 时按形状算出来（向外取整到 0.1 毫米）。"""
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
    return all(outer["min"][k] <= inner["min"][k] + tol and outer["max"][k] >= inner["max"][k] - tol for k in range(3))


def validate_entity_body(body: Mapping[str, Any], templates: Mapping[str, Mapping[str, Any]] | None = None) -> None:
    allowed = {
        "entityId", "layer", "kind", "label", "anchorId", "regionId", "shape",
        "assetHash", "textures", "bounds", "fit", "props",
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
    label = body.get("label")
    if label is not None and (not isinstance(label, str) or len(label) > MAX_LABEL_CHARS):
        raise RecordError("label 不超过 200 个字符")
    for name in ("anchorId", "regionId"):
        if body.get(name) is not None and not is_object_id(body[name]):
            raise RecordError(f"{name} 格式不对")
    if body.get("shape") is None and body.get("assetHash") is None:
        raise RecordError("物件至少要有 shape 或 assetHash")
    if body.get("kind") == "template" and body.get("shape") is None:
        raise RecordError("模板必须给出 shape")
    if body.get("assetHash") is not None and not is_sha256_hex(body["assetHash"]):
        raise RecordError("assetHash 必须是 64 位小写十六进制")
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
    shape = body.get("shape")
    if shape is not None:
        validate_shape(shape)
        if not _contains(bounds, shape_bounds(shape, templates), BOUNDS_TOLERANCE):
            raise RecordError("bounds 没有包住形状的实际范围")
