"""重建层（设计 6.3）：结构元素 + 物体，整理成物件记录 body 和贴图。

- **结构**：`structure.extract_structure` 的每个元素写成一个 `kind: structure` 的物件（带贴图的 `box`，
  非矩形地面用 `extrude`），贴图 JPEG 编码后按内容哈希引用；
- **物体**：调用物体重建模块 `processing.objects.reconstruct_objects(mesh, structure, params=hints)`
  （由另一个模块实现）。导入失败时记录警告、只交结构（`objects_skipped` 写明原因）；
- **校验**：所有 body 都按 SHAPES 3 重新校验（模板实例按同一批结果里的模板算包围盒），贴图哈希必须和字节
  一致，编号不能重复。不合格就抛 `PermanentJobError`。

纯计算，不碰数据库；在子进程里调用。
"""

from __future__ import annotations

import hashlib
import importlib
import logging
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from typing import Any

from ..canonical import is_sha256_hex
from ..errors import PermanentJobError
from ..records import RecordError, entity_body, validate_entity_body
from ..shapes import ShapeError
from .scan import ScanMesh, sniff_format
from .structure import (
    LABELS,
    StructureParams,
    StructureResult,
    element_props,
    element_shape,
    encode_texture,
    extract_structure,
)

log = logging.getLogger(__name__)

OBJECTS_TARGET = "metaverse_worker.processing.objects:reconstruct_objects"
TEXTURE_FORMATS = {"jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
MAX_TEXTURE_BYTES = 32 << 20


@dataclass
class RebuildOutput:
    entities: dict[str, dict] = field(default_factory=dict)  # entityId → body
    textures: dict[str, bytes] = field(default_factory=dict)  # sha256 → 图片字节
    structure_ids: list[str] = field(default_factory=list)
    object_ids: list[str] = field(default_factory=list)
    objects_skipped: str | None = None  # 物体重建没有运行的原因（导入失败）
    metrics: dict[str, Any] = field(default_factory=dict)


def structure_entities(
    result: StructureResult, quality: int = 85
) -> tuple[dict[str, dict], dict[str, bytes]]:
    """结构元素 → 物件记录 body（`layer: rebuilt`、`kind: structure`）和贴图。"""
    bodies: dict[str, dict] = {}
    textures: dict[str, bytes] = {}
    for element in result.elements:
        data = encode_texture(element.texture, quality)
        sha = hashlib.sha256(data).hexdigest()
        textures[sha] = data
        bodies[element.id] = entity_body(
            entity_id=element.id,
            kind="structure",
            shape=element_shape(element, sha),
            label=LABELS.get(element.kind),
            textures=[sha],
            props=element_props(element),
        )
    return bodies, textures


def _shape_textures(node: Any) -> Iterator[str]:
    """形状树里引用的贴图哈希（`material.texture`）。"""
    if isinstance(node, Mapping):
        material = node.get("material")
        if isinstance(material, Mapping) and isinstance(material.get("texture"), str):
            yield material["texture"]
        for child in node.get("children") or []:
            yield from _shape_textures(child)


def body_textures(body: Mapping[str, Any]) -> set[str]:
    out = set(_shape_textures(body.get("shape")))
    out.update(t for t in body.get("textures") or [] if isinstance(t, str))
    return out


def load_objects_impl(target: str | None):
    """按 '模块:函数' 导入物体重建函数。导入失败返回 (None, 原因)。"""
    if not target:
        return None, "未配置物体重建模块"
    module_name, _, func_name = target.partition(":")
    try:
        module = importlib.import_module(module_name)
        return getattr(module, func_name), None
    except Exception as error:  # 模块不存在、导入时出错、函数不存在
        return None, f"物体重建模块导入失败：{type(error).__name__}: {error}"


def _check_texture(sha: str, data: Any) -> None:
    if not is_sha256_hex(sha) or not isinstance(data, bytes | bytearray):
        raise PermanentJobError("物体重建返回的贴图必须是 {sha256: 字节}")
    if len(data) > MAX_TEXTURE_BYTES:
        raise PermanentJobError(f"物体贴图 {sha} 超过 32MB")
    if hashlib.sha256(data).hexdigest() != sha:
        raise PermanentJobError(f"物体贴图 {sha} 的内容与哈希不符")
    if sniff_format(bytes(data[:64])) not in TEXTURE_FORMATS:
        raise PermanentJobError(f"物体贴图 {sha} 不是 jpeg、png 或 webp")


def validate_object_entities(entities: Mapping[str, Any], textures: Mapping[str, bytes]) -> dict[str, dict]:
    """物体重建结果的校验：layer = rebuilt，kind 是 object 或 template，SHAPES 3 合法，贴图都给了字节。"""
    out: dict[str, dict] = {}
    templates = {
        eid: body["shape"]
        for eid, body in entities.items()
        if isinstance(body, Mapping)
        and body.get("kind") == "template"
        and isinstance(body.get("shape"), Mapping)
    }
    for eid, body in entities.items():
        if not isinstance(body, Mapping):
            raise PermanentJobError(f"物件 {eid} 的记录不是对象")
        if body.get("entityId") != eid:
            raise PermanentJobError(f"物件 {eid} 的 entityId 与键不一致")
        if body.get("layer") != "rebuilt" or body.get("kind") not in ("object", "template"):
            raise PermanentJobError(f"物件 {eid} 必须是 layer=rebuilt、kind=object|template")
        try:
            validate_entity_body(body, templates)
        except (RecordError, ShapeError) as error:
            raise PermanentJobError(f"物件 {eid} 不合法：{error}") from error
        for sha in body_textures(body):
            if sha not in textures:
                raise PermanentJobError(f"物件 {eid} 引用的贴图 {sha} 没有随结果给出")
        out[eid] = dict(body)
    return out


def rebuild(
    mesh_space: ScanMesh,
    *,
    hints: Mapping[str, Any] | None = None,
    objects_target: str | None = OBJECTS_TARGET,
    structure_params: StructureParams | None = None,
) -> RebuildOutput:
    """在已对齐到空间坐标的扫描上做结构 + 物体重建。"""
    out = RebuildOutput()
    try:
        structure = extract_structure(mesh_space, structure_params)
    except ValueError as error:
        raise PermanentJobError(f"结构重建失败：{error}") from error
    bodies, textures = structure_entities(structure)
    out.entities.update(bodies)
    out.textures.update(textures)
    out.structure_ids = sorted(bodies)
    kinds = [e.kind for e in structure.elements]
    out.metrics["structure"] = {
        "entities": len(bodies),
        "walls": kinds.count("wall"),
        "glazing": kinds.count("glazing"),
        "floorM2": structure.stats.get("floor", {}).get("footprint_m2"),
        "wallDirections": structure.stats.get("wall_directions"),
    }

    func, reason = load_objects_impl(objects_target)
    if func is None:
        log.warning("跳过物体重建，只提交结构：%s", reason)
        out.objects_skipped = reason
        out.metrics["objects"] = {"skipped": reason}
        return out
    result = func(mesh_space, structure, params=dict(hints or {}))
    entities = getattr(result, "entities", None)
    obj_textures = getattr(result, "textures", None) or {}
    metrics = getattr(result, "metrics", None) or {}
    if not isinstance(entities, Mapping) or not isinstance(obj_textures, Mapping):
        raise PermanentJobError("物体重建的返回值必须有 entities、textures 两个字典")
    for sha, data in obj_textures.items():
        _check_texture(sha, data)
    checked = validate_object_entities(entities, obj_textures)
    clash = sorted(set(checked) & set(out.entities))
    if clash:
        raise PermanentJobError(f"物体编号与结构编号重复：{clash[:5]}")
    out.entities.update(checked)
    out.textures.update({sha: bytes(data) for sha, data in obj_textures.items()})
    out.object_ids = sorted(checked)
    out.metrics["objects"] = {"entities": len(checked), **{str(k): v for k, v in dict(metrics).items()}}
    return out
