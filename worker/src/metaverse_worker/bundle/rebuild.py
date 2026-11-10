"""一份扫描 → 重建包要放的东西（原来是处理服务"导入扫描"和"写回 AI 物件集"的编排，去掉了数据库部分）。

步骤与原来的导入扫描相同，只是结果留在本地（普通数据 + 工作目录里的文件），不写提交：

1. 有 AI 物件集时先整理、校验（`authored.parse_authored`）；形状引用的已有贴图分两类：调用方本地有的
   （`known_textures`，比如从空间拉下来的贴图）直接用，其余的交给计算部分判断——本次算出了同样的贴图就用，
   结构物件可以回退到本次算法结构里同编号、同部件路径的贴图（`textureFallback`），都不行时失败；
   再下载外部模型（`sources.download_sources`）；
2. `processing.tasks.scan_task`：读取 → 解析前检查 → 对齐（给定变换 / 与参考扫描配准 / 首次自动对齐）→
   网页用模型 → 结构 + 物体（或 AI 物件集：外部模型重新导出、烘焙、逐件偏差）；
3. 核对每张贴图、每个处理后的模型与它的哈希一致，网页用模型算出哈希；
4. 按类别建议锚点（`anchors.anchor_proposals`）。

重扫配准的误差超过 `align_max_error_cm` 时不往下做，返回 `needsAlignment: true` 和建议的变换，等人确认。

物体重建模块导入失败、只交了结构时 `objectsSkipped` 写明原因：这时结果里只有结构可信，写包的一方不能把它
当成整个重建层（原来的处理服务这时只替换结构物件，旧的物体保留）。

清单写出、编号前缀 `rb.`、`--seed` 等由打包命令负责（设计 6、8.3），不在这里。
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Callable, Iterable, Mapping
from typing import Any

from ..authored import parse_authored
from ..errors import PermanentJobError
from ..processing import tasks
from ..processing.limits import default_limits
from ..processing.rebuild import OBJECTS_TARGET
from .anchors import anchor_proposals
from .sources import download_sources

# 重扫配准的误差超过它（厘米）就不往下做，等人确认变换
ALIGN_MAX_ERROR_CM = 3.0


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def prepare_authored(
    raw: Any,
    workdir: str,
    *,
    known_textures: Iterable[str] = (),
    hosts: Iterable[str] | None = None,
    max_model_bytes: int | None = None,
    opener: Any = None,
    check_cancel: Callable[[], None] | None = None,
) -> tuple[dict[str, Any], dict[str, dict[str, str]], dict[str, int]]:
    """物件集 → (整理过的物件集，带 `existingTextures`、`pendingTextures`；下载好的外部模型；下载统计)。"""
    parsed = parse_authored(raw)
    known = set(known_textures)
    parsed["existingTextures"] = sorted(sha for sha in parsed["textures"] if sha in known)
    parsed["pendingTextures"] = sorted(sha for sha in parsed["textures"] if sha not in known)
    limit = default_limits()["max_model_bytes"] if max_model_bytes is None else max_model_bytes
    sources, downloads = download_sources(
        parsed,
        os.path.join(workdir, "downloads"),
        hosts=hosts,
        max_model_bytes=limit,
        opener=opener,
        check_cancel=check_cancel,
    )
    return parsed, sources, downloads


def _compute_authored(parsed: Mapping[str, Any]) -> dict[str, Any]:
    """交给计算部分的物件集：去掉只在这里用的字段。"""
    return {k: v for k, v in parsed.items() if k not in ("existingTextures", "notes")}


def _checked_textures(textures: Mapping[str, bytes]) -> dict[str, bytes]:
    for sha, data in textures.items():
        if hashlib.sha256(data).hexdigest() != sha:
            raise PermanentJobError(f"贴图 {sha} 的内容与哈希不符")
    return dict(textures)


def _checked_models(models: Mapping[str, Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    for sha, info in models.items():
        if sha256_file(str(info["path"])) != sha:
            raise PermanentJobError(f"模型 {sha} 的内容与哈希不符")
    return {sha: dict(info) for sha, info in models.items()}


def authored_summary(
    parsed: Mapping[str, Any], rebuilt: Mapping[str, Any], downloads: Mapping[str, int]
) -> dict[str, Any]:
    """物件集的统计：逐件偏差、下载、模型、烘焙、结构贴图的回退清单。"""
    models = rebuilt.get("models") or {}
    return {
        "structure": parsed["structure"],
        "entities": len(parsed["entities"]),
        "templates": len(parsed["templates"]),
        "fit": list(rebuilt.get("fit") or []),
        "downloads": dict(downloads),
        "models": {
            "files": len(models),
            "bytes": sum(int(m["bytes"]) for m in models.values()),
            "triangles": sum(int(m["triangles"]) for m in models.values()),
        },
        "bake": dict(rebuilt.get("bake") or {}),
        "textureFallback": list(rebuilt.get("textureFallback") or []),
    }


def rebuild_scan(
    scan_path: str,
    workdir: str,
    *,
    limits: Mapping[str, int] | None = None,
    transform: list[float] | None = None,
    reference: Mapping[str, Any] | None = None,
    hints: Mapping[str, Any] | None = None,
    authored: Any = None,
    known_textures: Iterable[str] = (),
    web_models: bool = True,
    physical_boxes: list[list[int]] | None = None,
    objects_target: str | None = OBJECTS_TARGET,
    align_max_error_cm: float = ALIGN_MAX_ERROR_CM,
    hosts: Iterable[str] | None = None,
    opener: Any = None,
) -> dict[str, Any]:
    """见模块说明。

    - `transform`：给定的变换（16 个数，列主序，扫描坐标 → 空间坐标）；`reference = {"path", "transform"}`：
      与参考扫描配准；都没给时首次自动对齐；
    - `authored`：AI 物件集（JSON 对象，`authored.py` 的格式）；`known_textures`：本地有文件的贴图哈希；
    - `limits` 默认 `processing.limits.default_limits()`。

    返回：
    `{transform, alignment, boundsSpace, scan, timings, webModels: [{hash, path, bytes, triangles, …}],
    entities: {编号: body}, structureIds, objectIds, objectsSkipped, metrics, textures: {哈希: 字节},
    models: {哈希: {path, bytes, triangles, source, …}}, existingTextures: [本地已有、被引用的贴图哈希],
    anchors: {锚点编号: body}, notes, authored: 统计或 None}`；
    重扫配准误差超限时是
    `{needsAlignment: true, proposedTransform, errorCm, maxErrorCm, alignment, candidates, timings}`。
    `path` 都在 `workdir` 里，调用方删掉工作目录之前要拷走。
    """
    os.makedirs(workdir, exist_ok=True)
    limits = dict(limits) if limits is not None else default_limits()
    parsed, sources, downloads = None, {}, {}
    if authored is not None:
        parsed, sources, downloads = prepare_authored(
            authored,
            workdir,
            known_textures=known_textures,
            hosts=hosts,
            max_model_bytes=int(limits["max_model_bytes"]),
            opener=opener,
        )
    out = tasks.scan_task(
        scan_path=scan_path,
        workdir=os.path.join(workdir, "task"),
        limits=limits,
        transform=transform,
        transform_method="given",
        reference=reference,
        web_models=web_models,
        do_rebuild=True,
        hints=hints,
        physical_boxes=physical_boxes,
        objects_target=objects_target,
        align_max_error_cm=align_max_error_cm,
        authored=_compute_authored(parsed) if parsed is not None else None,
        authored_sources=sources,
    )
    if out.get("needsAlignment"):
        return {
            "needsAlignment": True,
            "proposedTransform": out["proposedTransform"],
            "errorCm": out["errorCm"],
            "maxErrorCm": align_max_error_cm,
            "alignment": out.get("alignment"),
            "candidates": out.get("candidates"),
            "timings": out.get("timings"),
        }
    rebuilt = out["rebuild"]
    entities = rebuilt["entities"]
    result: dict[str, Any] = {
        "transform": out["transform"],
        "alignment": out.get("alignment"),
        "boundsSpace": out.get("boundsSpace"),
        "scan": out.get("scan"),
        "timings": out.get("timings"),
        "webModels": [{"hash": sha256_file(m["path"]), **m} for m in out.get("webModels") or []],
        "entities": entities,
        "structureIds": list(rebuilt.get("structureIds") or []),
        "objectIds": list(rebuilt.get("objectIds") or []),
        "objectsSkipped": rebuilt.get("objectsSkipped"),
        "metrics": rebuilt.get("metrics") or {},
        "textures": _checked_textures(rebuilt["textures"]),
        "models": _checked_models(rebuilt.get("models") or {}),
        "existingTextures": list(parsed["existingTextures"]) if parsed is not None else [],
        "anchors": anchor_proposals(entities, hints),
        "notes": parsed.get("notes") if parsed is not None else None,
        "authored": authored_summary(parsed, rebuilt, downloads) if parsed is not None else None,
    }
    return result


__all__ = ["ALIGN_MAX_ERROR_CM", "authored_summary", "prepare_authored", "rebuild_scan", "sha256_file"]
