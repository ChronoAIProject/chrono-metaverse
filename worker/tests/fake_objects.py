"""测试用的假物体重建模块（真实实现是 `metaverse_worker.processing.objects`，由另一个模块负责）。

接口与约定相同：`reconstruct_objects(mesh, structure, *, params=None) -> ObjectsResult`。
不分析网格，只按地面高度摆一个模板（椅子）+ 两个实例 + 一张带贴图的桌子（建议锚点 table-01），
让写回流程覆盖模板、实例、贴图、锚点。
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from PIL import Image

from metaverse_worker import shapes as sh
from metaverse_worker.records import entity_body

CALLS: list[dict[str, Any]] = []


@dataclass
class ObjectsResult:
    entities: dict[str, dict] = field(default_factory=dict)
    textures: dict[str, bytes] = field(default_factory=dict)
    metrics: dict[str, Any] = field(default_factory=dict)


def table_texture() -> bytes:
    rng = np.random.default_rng(3)
    img = (rng.random((32, 32, 3)) * 80 + 100).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="PNG")
    return buf.getvalue()


def reconstruct_objects(mesh, structure, *, params: dict | None = None) -> ObjectsResult:
    CALLS.append({"params": dict(params or {}), "triangles": len(mesh.faces)})
    y = float(structure.floor_y)
    tex = table_texture()
    sha = hashlib.sha256(tex).hexdigest()
    chair = sh.box([0.5, 0.9, 0.5], fillet=0.03, material=sh.color_material([60, 60, 70]))
    templates = {"chair-a": chair}
    entities = {
        "chair-a": entity_body(entity_id="chair-a", kind="template", shape=chair, label="会议椅"),
        "chair-01": entity_body(
            entity_id="chair-01",
            kind="object",
            shape=sh.instance("chair-a", xf=sh.transform(position=[1.2, y, 1.0], yaw=90)),
            templates=templates,
            anchor_id="chair-01",
            label="会议椅",
        ),
        "chair-02": entity_body(
            entity_id="chair-02",
            kind="object",
            shape=sh.instance("chair-a", xf=sh.transform(position=[2.4, y, 1.0], yaw=-90)),
            templates=templates,
            anchor_id="seat-02",
        ),
        "table-01": entity_body(
            entity_id="table-01",
            kind="object",
            shape=sh.box(
                [1.6, 0.75, 0.8],
                xf=sh.transform(position=[1.8, y, 1.0]),
                material=sh.texture_material(sha, "box"),
            ),
            anchor_id="table-01",
            label="会议桌",
            fit={"meanCm": 1.2, "p90Cm": 2.5, "coverage3cm": 0.9},
        ),
    }
    return ObjectsResult(
        entities, {sha: tex}, {"furnitureMeanCm": 1.2, "objects": 3, "hints": dict(params or {})}
    )


def broken_objects(mesh, structure, *, params: dict | None = None) -> ObjectsResult:
    """返回不合法的结果（layer 不对），用来测试校验。"""
    body = entity_body(entity_id="x1", kind="object", shape=sh.box([1, 1, 1]))
    body["layer"] = "ext"
    return ObjectsResult({"x1": body}, {}, {})


def raising_objects(mesh, structure, *, params: dict | None = None) -> ObjectsResult:
    raise RuntimeError("物体重建内部出错")


def moved_objects(mesh, structure, *, params: dict | None = None) -> ObjectsResult:
    """和 reconstruct_objects 一样，只是桌子挪了位置（用来测试重新重建会产生变化）。"""
    result = reconstruct_objects(mesh, structure, params=params)
    shape = dict(result.entities["table-01"]["shape"])
    shape["transform"] = sh.transform(position=[2.5, float(structure.floor_y), 2.0])
    result.entities["table-01"] = entity_body(
        entity_id="table-01", kind="object", shape=shape, anchor_id="table-01", label="会议桌"
    )
    return result
