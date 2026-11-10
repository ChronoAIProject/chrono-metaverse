"""各用途的上传上限（SHAPES 8 `uploadLimits`；设计 6.5：本地工具生成时就按上限导出）。

命令行 `metaverse pull` 把接口服务给的 `uploadLimits` 写进工作区的 `limits.json`；没有这个文件时用默认值，
默认值与接口服务、命令行相同（向量 `bundle/bundle_limits_default.json` 核对）。本地工具只用它守住上限：
物件模型的三角形、贴图边长和像素合计、坐标，贴图的边长和像素，网页用模型的三角形和贴图，各用途的大小。
清单本身的校验和展开不在这里（`metaverse bundle check`、接口服务）。
"""

from __future__ import annotations

import copy
import json
from collections.abc import Mapping
from typing import Any

from ..errors import InputRejected

DEFAULT_UPLOAD_LIMITS: dict[str, Any] = {
    "v": 1,
    "scan": {"maxBytes": 1073741824},
    "webmodel": {
        "maxBytes": 67108864,
        "maxTriangles": 500000,
        "maxTextureSide": 4096,
        "maxTexturePixels": 33554432,
        "maxCoord": 100000.0,
    },
    "model": {
        "maxBytes": 52428800,
        "maxTriangles": 100000,
        "maxTextureSide": 2048,
        "maxTexturePixels": 16777216,
        "maxCoord": 1000.0,
    },
    "texture": {"maxBytes": 52428800, "maxSide": 4096, "maxPixels": 16777216},
    "ops": {"maxBytes": 67108864},
    "script": {"maxBytes": 4194304},
    "bundle": {"maxBytes": 16777216},
}
PURPOSES = ("scan", "webmodel", "model", "texture", "script", "bundle")


def default_upload_limits() -> dict[str, Any]:
    return copy.deepcopy(DEFAULT_UPLOAD_LIMITS)


def _positive(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and value > 0


def parse_upload_limits(doc: Any) -> dict[str, Any]:
    """`uploadLimits` → 完整的上限表：认识的键按给的值，缺的按默认值；值不对时报错。"""
    if not isinstance(doc, Mapping) or doc.get("v") != 1:
        raise InputRejected(
            "limits.json 不是认识的上传上限（要 {v: 1, scan, webmodel, model, texture, ...}）"
        )
    out = default_upload_limits()
    for purpose, fields in DEFAULT_UPLOAD_LIMITS.items():
        if purpose == "v" or not isinstance(doc.get(purpose), Mapping):
            continue
        for key in fields:
            value = doc[purpose].get(key)
            if value is None:
                continue
            if not _positive(value):
                raise InputRejected(f"limits.json 的 {purpose}.{key} 必须是正数")
            out[purpose][key] = value
    return out


def load_upload_limits(path: str | None) -> dict[str, Any]:
    """读 `limits.json`；`path` 是 None 时用默认值。"""
    if path is None:
        return default_upload_limits()
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as error:
        raise InputRejected(f"limits.json 读不了：{error}") from error
    return parse_upload_limits(doc)


def processing_limits(upload: Mapping[str, Any], base: Mapping[str, int] | None = None) -> dict[str, int]:
    """上传上限 → `processing` 各入口用的上限表（`processing.limits.default_limits` 的键）：物件模型的导出
    上限取 `model`，外部模型下载的大小上限取 `model.maxBytes`。"""
    from ..processing.limits import default_limits

    out = dict(base) if base is not None else default_limits()
    model = upload["model"]
    out["model_max_triangles"] = int(model["maxTriangles"])
    out["model_max_texture_side"] = int(model["maxTextureSide"])
    out["model_max_texture_pixels"] = int(model["maxTexturePixels"])
    out["max_model_bytes"] = int(model["maxBytes"])
    return out


__all__ = [
    "DEFAULT_UPLOAD_LIMITS",
    "PURPOSES",
    "default_upload_limits",
    "load_upload_limits",
    "parse_upload_limits",
    "processing_limits",
]
