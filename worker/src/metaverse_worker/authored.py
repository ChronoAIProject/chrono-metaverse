"""AI 物件集（authored）：格式、校验与整理（设计 6.3「AI 逐件建模」）。

本地的 AI（大语言模型）逐件完成前厅的物件：先去模型库找一个看起来差不多的现成模型摆进扫描里对照，找不到
或差太多的定制件再手写参数形状；完成后把整套物件交给 `scan_import` / `rebuild` 任务写进时间线。

```json
{ "version": 1,
  "templates": [ 模板物件 body（kind "template"）... ],
  "entities":  [ 物件 body ... ],
  "notes": "建模过程记录（可选，≤ 64KB）",
  "structure": "keep" | "replace" }
```

- **坐标**：空间坐标，与处理服务 `scan_import` 对齐后的坐标系相同；
- **物件**（SHAPES 3 的 body，`layer` 省略时按 `rebuilt`）：
  - **形状物件**：`shape` + 材质。材质里可以带烘焙指令 `"bake": "planar" | "box" | "cylindrical"`（不能和
    `texture` 同时出现，可以带 `color` 作为采不到颜色时的后备），处理服务从扫描烘焙贴图后换成
    `{texture, uv}`；模板里不能带烘焙指令（模板在自己的局部坐标里，不知道对应扫描的哪一处）；
  - **外部模型物件**：没有 `shape`，带 `model: {url, sha256, size, format}`、`transform`（含 `scale`）、
    `props.source`（署名）、可选的 `material: {tint, opacity, unlit}`（`tint` 烘进模型，`opacity`、
    `unlit` 留在处理后物件的 `material` 里，网站按它画半透明或不打光）。`format` 是 `glb`、
    `gltf-zip`（zip 里一个 `.gltf` 和它引用的文件），或 `gltf`（`url` 指向 `.gltf`，另给
    `files: {相对路径: {url, sha256, size}}`，即 Poly Haven 文件列表里的 `include`）。处理服务下载、
    核对哈希和大小，把 `transform` 和 `tint` 烘进模型（±1000 米的坐标上限按缩放之后检查，厘米单位的
    模型缩放后也能用）、按物件模型的限制重新导出 glb，写成 `assetHash`；工作台 `place` 写的 `fit` 可以
    留着，处理服务会重算；
  - `bounds` 可以省略（形状物件按形状算；外部模型按导出后的网格算），`fit` 和 `textures` 一律由处理服务重算；
  - 形状里引用的贴图（`material.texture`）必须是本空间已登记的贴图资源；
- **`structure`**：`keep`（默认）时结构（地面、墙、玻璃）沿用算法结果，物件集里不能有 `kind: structure`；
  `replace` 时结构就是物件集里 `kind: structure` 的物件，不跑结构算法；
- **署名** `props.source = {library, id, page, author, license, title}`：`library` 是 `polyhaven`、
  `objaverse`、`sketchfab`；`license` 只接受可商用、不传染的 `CC0-1.0`、`CC-BY-4.0`、`CC-BY-3.0`
  （NC、ND、SA 一律拒绝）；六个字段都必须是非空字符串（CC0 也写模型库标注的作者），规则与物件记录的
  `props.source` 相同（`records.validate_model_source`，接口服务提交时也按它校验）。外部模型物件必须带，形状
  物件可选。

本模块只做纯数据的解析和校验（父进程里调用，不碰网络和数据库）：返回普通字典，可以原样交给子进程。
"""

from __future__ import annotations

import copy
import hashlib
import json
import posixpath
import re
from collections.abc import Iterator, Mapping
from typing import Any
from urllib.parse import urlsplit

from .canonical import CanonicalError, canonical_json, is_sha256_hex
from .errors import PermanentJobError
from .ids import is_object_id
from .records import RecordError, validate_entity_body, validate_model_source
from .shapes import ShapeError, _validate_transform, rounded_bounds, shape_bounds, validate_opacity

AUTHORED_VERSION = 1
MAX_AUTHORED_BYTES = 4 << 20
MAX_ENTITIES = 2000
MAX_TEMPLATES = 200
MAX_NOTES_BYTES = 64 << 10
MAX_MODEL_SOURCES = 200
MAX_MODEL_FILES = 64
MAX_BAKES = 500
MAX_URL = 2048

STRUCTURE_MODES = ("keep", "replace")
BAKE_MODES = ("planar", "box", "cylindrical")
MODEL_FORMATS = ("glb", "gltf-zip", "gltf")
LIBRARIES = ("polyhaven", "objaverse", "sketchfab")
# 只收可商用、不传染的许可（SPDX 写法）；CC-BY 要署名
LICENSES = ("CC0-1.0", "CC-BY-4.0", "CC-BY-3.0")
# 烘焙失败（附近没有扫描）时的后备颜色
FALLBACK_COLOR = [128, 128, 128]
# 校验外部模型物件的 body 时临时填的资源哈希和包围盒（导出后换成真的）
_PLACEHOLDER_HASH = "0" * 64

_TOP_KEYS = {"version", "templates", "entities", "notes", "structure"}
_RECORD_KEYS = {
    "entityId", "layer", "kind", "label", "anchorId", "regionId", "shape",
    "textures", "bounds", "fit", "props",
}  # fmt: skip
_MODEL_ENTITY_KEYS = {
    "entityId", "layer", "kind", "label", "anchorId", "regionId",
    "bounds", "fit", "props", "model", "transform", "material",
}  # fmt: skip
_FILE_PATH = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_. -]*(?:/[A-Za-z0-9_][A-Za-z0-9_. -]*)*$")


class AuthoredError(PermanentJobError):
    """物件集不合法（不可重试）。"""


# ---------------------------------------------------------------------------- 读取


def load_authored_bytes(data: bytes) -> Any:
    """资源里的物件集（UTF-8 JSON）→ 对象。大小和格式不对时抛 `AuthoredError`。"""
    if len(data) > MAX_AUTHORED_BYTES:
        raise AuthoredError(f"物件集有 {len(data)} 字节，超过上限 {MAX_AUTHORED_BYTES}")
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise AuthoredError(f"物件集不是 UTF-8 JSON：{error}") from error


def _is_https(value: Any) -> bool:
    if not isinstance(value, str) or len(value) > MAX_URL or any(ord(c) < 0x21 for c in value):
        return False
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    return parts.scheme == "https" and bool(parts.hostname) and parts.username is None


def validate_source(value: Any, what: str) -> dict[str, Any]:
    """`props.source`：模型库来源与署名，规则与物件记录相同（`records.validate_model_source`）。"""
    if not isinstance(value, Mapping):
        raise AuthoredError(f"{what} 必须是对象 {{library, id, page, author, license, title}}")
    if value.get("license") is not None and value.get("license") not in LICENSES:
        allowed = "、".join(LICENSES)
        raise AuthoredError(
            f"{what}.license {value.get('license')!r} 这个许可不能用：只接受 {allowed}（NC、ND、SA 排除）"
        )
    try:
        validate_model_source(dict(value))
    except RecordError as error:
        raise AuthoredError(f"{what} 不合法：{error}") from error
    return dict(value)


# ---------------------------------------------------------------------------- 形状里的烘焙指令和贴图


def _walk(shape: Mapping[str, Any], path: str = "$") -> Iterator[tuple[str, Mapping[str, Any]]]:
    yield path, shape
    if shape.get("type") == "group":
        for i, child in enumerate(shape.get("children") or []):
            if isinstance(child, Mapping):
                yield from _walk(child, f"{path}.children[{i}]")


def node_at(shape: dict[str, Any], path: str) -> dict[str, Any]:
    """按 `$.children[i]...` 找形状节点。"""
    node = shape
    rest = path[1:]
    while rest:
        if not rest.startswith(".children["):
            raise ValueError(f"形状路径不对：{path}")
        end = rest.index("]")
        node = node["children"][int(rest[len(".children[") : end])]
        rest = rest[end + 1 :]
    return node


def extract_bakes(shape: dict[str, Any], what: str) -> list[dict[str, Any]]:
    """取出形状里的烘焙指令：材质换成后备纯色（让 SHAPES 校验通过），返回 `[{path, uv, keep, fallback}]`。

    `keep` 是材质里除 `bake`、`color` 以外的字段（例如以后的 `opacity`、`unlit`），烘焙后原样保留。
    """
    out: list[dict[str, Any]] = []
    for path, node in list(_walk(shape)):
        material = node.get("material")
        if not isinstance(material, Mapping) or "bake" not in material:
            continue
        mode = material["bake"]
        if mode not in BAKE_MODES:
            raise AuthoredError(f"{what} {path}.material.bake 必须是 {'、'.join(BAKE_MODES)} 之一")
        if any(material.get(k) is not None for k in ("texture", "uv", "tint")):
            raise AuthoredError(f"{what} {path}.material：bake 只能出现在没有 texture、uv、tint 的材质里")
        keep = {k: v for k, v in material.items() if k not in ("bake", "color", "tint")}
        fallback = material.get("color") if material.get("color") is not None else list(FALLBACK_COLOR)
        node["material"] = {"color": fallback, **keep}  # type: ignore[index]
        out.append({"path": path, "uv": mode, "keep": keep, "fallback": fallback})
    return out


def shape_textures(shape: Any) -> set[str]:
    """形状树里引用的贴图哈希（`material.texture`）。"""
    out: set[str] = set()
    if isinstance(shape, Mapping):
        for _, node in _walk(shape):
            material = node.get("material")
            if isinstance(material, Mapping) and isinstance(material.get("texture"), str):
                out.add(material["texture"])
    return out


# ---------------------------------------------------------------------------- 外部模型


def _file_path(value: Any, what: str) -> str:
    """gltf 引用的相对路径：不能是绝对路径、不能含 `..`、只用常见字符。"""
    if (
        not isinstance(value, str)
        or len(value) > 255
        or not _FILE_PATH.fullmatch(value)
        or posixpath.normpath(value) != value
        or ".." in value.split("/")
    ):
        raise AuthoredError(f"{what} 的文件路径 {value!r} 不合法（相对路径，只含字母、数字、_ . - 空格和 /）")
    return value


def _download(value: Any, what: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise AuthoredError(f"{what} 必须是对象 {{url, sha256, size}}")
    if not _is_https(value.get("url")):
        raise AuthoredError(f"{what}.url 必须是 https 地址")
    if not is_sha256_hex(value.get("sha256")):
        raise AuthoredError(f"{what}.sha256 必须是 64 位小写十六进制")
    size = value.get("size")
    if not (isinstance(size, int) and not isinstance(size, bool) and size > 0):
        raise AuthoredError(f"{what}.size 必须是正整数（字节）")
    return {"url": value["url"], "sha256": value["sha256"], "size": size}


def parse_model(value: Any, what: str) -> dict[str, Any]:
    """`model` → `{url, sha256, size, format, files: [{path, url, sha256, size}]}`。"""
    if not isinstance(value, Mapping):
        raise AuthoredError(f"{what} 必须是对象 {{url, sha256, size, format}}")
    unknown = set(value) - {"url", "sha256", "size", "format", "files"}
    if unknown:
        raise AuthoredError(f"{what} 有不认识的字段：{sorted(unknown)}")
    out = _download(value, what)
    fmt = value.get("format")
    if fmt not in MODEL_FORMATS:
        raise AuthoredError(f"{what}.format 必须是 {'、'.join(MODEL_FORMATS)} 之一")
    out["format"] = fmt
    files = value.get("files")
    if fmt == "gltf":
        if not isinstance(files, Mapping) or not files or len(files) > MAX_MODEL_FILES:
            raise AuthoredError(
                f"{what}.files 必须是 1–{MAX_MODEL_FILES} 个 {{相对路径: {{url, sha256, size}}}}"
            )
        out["files"] = [
            {"path": _file_path(path, f"{what}.files"), **_download(item, f"{what}.files[{path!r}]")}
            for path, item in sorted(files.items())
        ]
    elif files is not None:
        raise AuthoredError(f"{what}.files 只用于 format gltf")
    else:
        out["files"] = []
    return out


def source_key(model: Mapping[str, Any]) -> str:
    """同一个外部模型（主文件和附属文件都相同）只下载一次。"""
    parts = [model["format"], model["sha256"], *(f"{f['path']}={f['sha256']}" for f in model["files"])]
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def model_material(value: Any, what: str) -> tuple[list[int] | None, dict[str, Any] | None]:
    """外部模型物件的 `material: {tint?, opacity?, unlit?}` → (烘进模型的 tint, 留在物件上的 material)。"""
    if value is None:
        return None, None
    if not isinstance(value, Mapping) or set(value) - {"tint", "opacity", "unlit"}:
        raise AuthoredError(f"{what} 只能是 {{tint?: [r, g, b], opacity?: 0–1, unlit?: 布尔}}")
    tint = value.get("tint")
    if tint is not None and not (
        isinstance(tint, list)
        and len(tint) == 3
        and all(isinstance(c, int) and not isinstance(c, bool) and 0 <= c <= 255 for c in tint)
    ):
        raise AuthoredError(f"{what}.tint 必须是 3 个 0–255 的整数")
    if value.get("unlit") is not None and not isinstance(value["unlit"], bool):
        raise AuthoredError(f"{what}.unlit 必须是布尔值")
    if value.get("opacity") is not None:
        try:
            validate_opacity(f"{what}.opacity", value["opacity"])
        except ShapeError as error:
            raise AuthoredError(str(error)) from error
    look = {k: value[k] for k in ("opacity", "unlit") if value.get(k) is not None}
    return (list(tint) if tint is not None else None), (look or None)


# ---------------------------------------------------------------------------- 物件


def _base_body(raw: Mapping[str, Any], keys: set[str], what: str) -> dict[str, Any]:
    unknown = set(raw) - keys
    if unknown:
        raise AuthoredError(f"{what} 有不认识的字段：{sorted(unknown)}")
    body = copy.deepcopy(dict(raw))
    body.setdefault("layer", "rebuilt")
    if body["layer"] != "rebuilt":
        raise AuthoredError(f"{what} 的 layer 必须是 rebuilt（物件集只写重建层）")
    body.pop("fit", None)  # 偏差由处理服务重算
    body.setdefault("props", {})
    if not isinstance(body["props"], dict):
        raise AuthoredError(f"{what}.props 必须是对象")
    # 与物件记录相同：source 是对象时按署名严格校验；不是对象（旧数据和手写模型里标来源的字符串，
    # 例如 "rules"、"llm-modeler"）原样放行
    if isinstance(body["props"].get("source"), Mapping):
        body["props"]["source"] = validate_source(body["props"]["source"], f"{what}.props.source")
    return body


def _check(body: Mapping[str, Any], templates: Mapping[str, Any], what: str) -> None:
    try:
        validate_entity_body(body, templates)
    except (RecordError, ShapeError) as error:
        raise AuthoredError(f"{what} 不合法：{error}") from error


def _shape_entity(raw: Mapping[str, Any], templates: Mapping[str, Any], what: str) -> tuple[dict, list]:
    body = _base_body(raw, _RECORD_KEYS, what)
    shape = body.get("shape")
    if not isinstance(shape, dict):
        raise AuthoredError(f"{what} 没有 shape（外部模型物件用 model）")
    bakes = extract_bakes(shape, what)
    body.pop("textures", None)
    given = shape_textures(shape)
    if given:
        body["textures"] = sorted(given)
    if body.get("bounds") is None:
        try:
            body["bounds"] = rounded_bounds(shape_bounds(shape, templates))
        except ShapeError as error:
            raise AuthoredError(f"{what} 的形状不合法：{error}") from error
    _check(body, templates, what)
    return body, bakes


def _model_entity(raw: Mapping[str, Any], what: str) -> tuple[dict, dict, dict]:
    body = _base_body(raw, _MODEL_ENTITY_KEYS, what)
    model = parse_model(body.pop("model"), f"{what}.model")
    transform = body.pop("transform", None) or {}
    try:
        _validate_transform(f"{what}.transform", transform)
    except ShapeError as error:
        raise AuthoredError(f"{what}.transform 不合法：{error}") from error
    tint, look = model_material(body.pop("material", None), f"{what}.material")
    if look is not None:
        body["material"] = look
    if not isinstance(body["props"].get("source"), Mapping):
        raise AuthoredError(f"{what} 是外部模型，必须在 props.source 里写明来源和许可（署名）")
    body.pop("bounds", None)  # 按导出后的网格重算
    check = {**body, "assetHash": _PLACEHOLDER_HASH, "bounds": {"min": [0, 0, 0], "max": [0, 0, 0]}}
    _check(check, {}, what)
    return body, model, {"transform": transform, "tint": tint}


def parse_authored(doc: Any) -> dict[str, Any]:
    """校验物件集并整理成处理用的普通字典：

    ```
    {"structure", "notes", "templates": {id: body}, "entities": {id: body},
     "bakes": {id: [{path, uv, keep, fallback}]},
     "models": {id: {source, transform, tint}}, "sources": {key: {url, sha256, size, format, files}},
     "textures": [形状里引用的已有贴图]}
    ```

    形状物件的 body 已通过 SHAPES 3 校验（烘焙部件暂时是后备纯色）；外部模型物件的 body 还没有
    `assetHash` 和 `bounds`（导出后补上）。
    """
    if not isinstance(doc, Mapping):
        raise AuthoredError("物件集必须是 JSON 对象")
    unknown = set(doc) - _TOP_KEYS
    if unknown:
        raise AuthoredError(f"物件集有不认识的字段：{sorted(unknown)}")
    if doc.get("version") != AUTHORED_VERSION:
        raise AuthoredError(f"物件集的 version 必须是 {AUTHORED_VERSION}")
    try:
        size = len(canonical_json(doc).encode())
    except CanonicalError as error:
        raise AuthoredError(f"物件集无法规范化：{error}") from error
    if size > MAX_AUTHORED_BYTES:
        raise AuthoredError(f"物件集有 {size} 字节，超过上限 {MAX_AUTHORED_BYTES}")
    structure = doc.get("structure", "keep")
    if structure not in STRUCTURE_MODES:
        raise AuthoredError("structure 必须是 keep 或 replace")
    notes = doc.get("notes")
    if notes is not None and (not isinstance(notes, str) or len(notes.encode()) > MAX_NOTES_BYTES):
        raise AuthoredError("notes 必须是不超过 64KB 的字符串")
    raw_templates, raw_entities = doc.get("templates") or [], doc.get("entities")
    if not isinstance(raw_templates, list) or len(raw_templates) > MAX_TEMPLATES:
        raise AuthoredError(f"templates 必须是不超过 {MAX_TEMPLATES} 个模板的数组")
    if not isinstance(raw_entities, list) or not raw_entities or len(raw_entities) > MAX_ENTITIES:
        raise AuthoredError(f"entities 必须是 1–{MAX_ENTITIES} 个物件的数组")

    seen: set[str] = set()

    def new_id(raw: Any, index: int, what: str) -> str:
        if not isinstance(raw, Mapping):
            raise AuthoredError(f"{what}[{index}] 必须是对象")
        eid = raw.get("entityId")
        if not is_object_id(eid) or eid.startswith("_"):
            raise AuthoredError(f"{what}[{index}].entityId 格式不对")
        if eid in seen:
            raise AuthoredError(f"物件编号 {eid} 重复")
        seen.add(eid)
        return eid

    template_shapes: dict[str, dict] = {}
    templates: dict[str, dict] = {}
    for i, raw in enumerate(raw_templates):
        eid = new_id(raw, i, "templates")
        what = f"模板 {eid}"
        if raw.get("kind") != "template":
            raise AuthoredError(f"{what} 的 kind 必须是 template")
        body = _base_body(raw, _RECORD_KEYS, what)
        shape = body.get("shape")
        if not isinstance(shape, dict):
            raise AuthoredError(f"{what} 必须给出 shape")
        if any(isinstance(n.get("material"), Mapping) and "bake" in n["material"] for _, n in _walk(shape)):
            raise AuthoredError(f"{what} 里不能有烘焙指令 bake（模板在局部坐标里，烘焙请写在物件上）")
        templates[eid] = body
        template_shapes[eid] = shape
    for eid, body in templates.items():
        body.pop("textures", None)
        given = shape_textures(body["shape"])
        if given:
            body["textures"] = sorted(given)
        if body.get("bounds") is None:
            try:
                body["bounds"] = rounded_bounds(shape_bounds(body["shape"], template_shapes))
            except ShapeError as error:
                raise AuthoredError(f"模板 {eid} 的形状不合法：{error}") from error
        _check(body, template_shapes, f"模板 {eid}")

    entities: dict[str, dict] = {}
    bakes: dict[str, list] = {}
    models: dict[str, dict] = {}
    sources: dict[str, dict] = {}
    for i, raw in enumerate(raw_entities):
        eid = new_id(raw, i, "entities")
        what = f"物件 {eid}"
        kind = raw.get("kind")
        if kind not in ("object", "structure"):
            raise AuthoredError(f"{what} 的 kind 必须是 object 或 structure（模板放在 templates 里）")
        if kind == "structure" and structure == "keep":
            raise AuthoredError(
                f"{what} 是结构，但 structure 是 keep（结构沿用算法结果）；要替换结构请写 replace"
            )
        if "model" in raw:
            if "shape" in raw:
                raise AuthoredError(f"{what} 不能同时有 shape 和 model")
            body, model, placement = _model_entity(raw, what)
            key = source_key(model)
            sources.setdefault(key, model)
            models[eid] = {"source": key, **placement}
        else:
            body, found = _shape_entity(raw, template_shapes, what)
            if found:
                bakes[eid] = found
        entities[eid] = body
    if structure == "replace" and not any(b["kind"] == "structure" for b in entities.values()):
        raise AuthoredError("structure 是 replace，但物件集里没有 kind structure 的物件")
    if len(sources) > MAX_MODEL_SOURCES:
        raise AuthoredError(f"外部模型最多 {MAX_MODEL_SOURCES} 个（不同的文件）")
    if sum(len(v) for v in bakes.values()) > MAX_BAKES:
        raise AuthoredError(f"烘焙指令最多 {MAX_BAKES} 处")
    textures = sorted(
        {t for body in [*templates.values(), *entities.values()] for t in body.get("textures") or []}
    )
    return {
        "structure": structure,
        "notes": notes if notes else None,
        "templates": templates,
        "entities": entities,
        "bakes": bakes,
        "models": models,
        "sources": sources,
        "textures": textures,
    }


__all__ = [
    "AUTHORED_VERSION",
    "BAKE_MODES",
    "LICENSES",
    "MAX_AUTHORED_BYTES",
    "MAX_ENTITIES",
    "MAX_TEMPLATES",
    "AuthoredError",
    "extract_bakes",
    "load_authored_bytes",
    "model_material",
    "node_at",
    "parse_authored",
    "parse_model",
    "shape_textures",
    "source_key",
    "validate_source",
]
