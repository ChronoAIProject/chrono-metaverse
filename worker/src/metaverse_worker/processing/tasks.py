"""处理入口：参数和返回值都是普通数据（字符串、数字、列表、字典、字节），重建工作台（`recon.prepare`）和
本地重建编排（`bundle.rebuild`）直接调用。

- `sniff_task`：文件的格式检查；
- `scan_task`：扫描读取 → 对齐（给定 / 首次自动 / 重扫配准）→ 网页用模型 → 结构 + 物体重建
  （给了 AI 物件集 `authored` 时换成 `authored_build.authored_rebuild`）；
- `voxelize_task`：体素化 → 方块表分配 → 区块编码；
- `model_task`：物件模型重新导出。

`limits` 的键见 `processing.limits.default_limits`。
"""

from __future__ import annotations

import logging
import math
import os
import time
from collections.abc import Mapping
from typing import Any

import numpy as np

from ..chunk import GRID_UNIT
from ..errors import InputRejected
from .align import AlignResult, auto_align, column_major, matrix_from_params, register_rescan
from .authored_build import authored_rebuild
from .modelimport import _count_obj_faces, export_model, load_model
from .rebuild import OBJECTS_TARGET, rebuild
from .scan import ScanMesh, apply_matrix, load_scan, sniff_file
from .sniff import extract_model, sniff_upload
from .voxelize import assign_blocks, encode_chunks, voxelize_mesh
from .webmodel import build_web_models

log = logging.getLogger(__name__)


def jsonable(value: Any) -> Any:
    """把 numpy 标量、数组、元组换成能存进 MongoDB / JSON 的普通值；非有限的浮点数换成 None。"""
    if isinstance(value, Mapping):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [jsonable(v) for v in value]
    if isinstance(value, np.ndarray):
        return jsonable(value.tolist())
    if isinstance(value, np.generic):
        return jsonable(value.item())
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


# ---------------------------------------------------------------------------- 上传检查


def sniff_task(path: str, purpose: str, limits: Mapping[str, int]) -> dict:
    found = sniff_upload(path, purpose, dict(limits))
    return {"format": found.format, "contentType": found.content_type, "detail": jsonable(found.detail)}


# ---------------------------------------------------------------------------- 扫描


def prepare_model_file(path: str, workdir: str, max_bytes: int) -> tuple[str, str | None]:
    """zip 压缩包解出模型和贴图；其他格式原样返回。"""
    with open(path, "rb") as fh:
        head = fh.read(4)
    if head.startswith(b"PK\x03\x04"):
        return extract_model(path, os.path.join(workdir, "unzipped"), max_bytes)
    return path, None


def read_scan(path: str, workdir: str, limits: Mapping[str, int]) -> ScanMesh:
    """读扫描（含解析前检查：三角形数、贴图像素）。"""
    model_path, texture_path = prepare_model_file(path, workdir, int(limits["max_scan_bytes"]) * 2)
    if sniff_file(model_path) == "obj" and _count_obj_faces(model_path) > int(limits["max_triangles"]):
        raise InputRejected(f"三角形数超过上限 {limits['max_triangles']}")
    return load_scan(
        model_path,
        texture_path,
        max_triangles=int(limits["max_triangles"]),
        max_texture_pixels=int(limits["max_texture_pixels"]),
    )


def grid_cells_inside(lo: np.ndarray, hi: np.ndarray, boxes: list[list[int]] | None) -> float:
    """包围盒（米）与实体区（格）的交集体积，单位是格数；没有实体区时就是包围盒体积（设计 6.4）。"""
    glo, ghi = np.floor(lo / GRID_UNIT), np.ceil(hi / GRID_UNIT)
    if not boxes:
        return float(np.prod(np.maximum(ghi - glo, 0)))
    total = 0.0
    for b in boxes:
        a = np.maximum(glo, np.asarray(b[:3], float))
        z = np.minimum(ghi, np.asarray(b[3:], float))
        total += float(np.prod(np.maximum(z - a, 0)))
    return total


def scan_task(
    *,
    scan_path: str,
    workdir: str,
    limits: Mapping[str, int],
    transform: list[float] | None = None,
    transform_method: str = "given",
    reference: Mapping[str, Any] | None = None,
    web_models: bool = True,
    do_rebuild: bool = True,
    hints: Mapping[str, Any] | None = None,
    physical_boxes: list[list[int]] | None = None,
    objects_target: str | None = OBJECTS_TARGET,
    align_max_error_cm: float = 3.0,
    authored: Mapping[str, Any] | None = None,
    authored_sources: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict:
    """见模块说明。`reference = {"path", "transform"}` 时做重扫配准；`transform` 给了就直接用。

    `authored` 是 `authored.parse_authored` 整理过的物件集，`authored_sources` 是下载好的外部模型
    （`{来源键: {format, path}}`）。"""
    os.makedirs(workdir, exist_ok=True)
    timings: dict[str, float] = {}
    t0 = time.monotonic()
    mesh = read_scan(scan_path, workdir, limits)
    timings["load"] = round(time.monotonic() - t0, 2)
    out: dict[str, Any] = {
        "scan": {
            "triangles": mesh.triangle_count,
            "vertices": len(mesh.vertices),
            "textureSide": 0 if mesh.texture is None else int(max(mesh.texture.shape[:2])),
        },
        "needsAlignment": False,
    }

    t = time.monotonic()
    if transform is not None:
        align = AlignResult(matrix_from_params(transform), transform_method)
    elif reference is not None:
        ref_mesh = read_scan(str(reference["path"]), os.path.join(workdir, "reference"), limits)
        ref_space = ref_mesh.transformed(matrix_from_params(reference["transform"]))
        del ref_mesh
        align = register_rescan(mesh, ref_space)
        del ref_space
        if align.error_cm is not None and align.error_cm > align_max_error_cm:
            out.update(
                needsAlignment=True,
                alignment=align.summary(),
                proposedTransform=align.column_major(),
                errorCm=round(float(align.error_cm), 2),
                candidates=align.candidates,
            )
            timings["align"] = round(time.monotonic() - t, 2)
            out["timings"] = timings
            return jsonable(out)
    else:
        align = auto_align(mesh)
    timings["align"] = round(time.monotonic() - t, 2)
    out["transform"] = align.column_major()
    out["alignment"] = align.summary()
    if align.candidates:
        out["alignment"]["candidates"] = align.candidates

    # 解析前检查：包围盒与实体区的交集 / GRID_UNIT³
    space_vertices = apply_matrix(mesh.vertices, align.matrix)
    lo, hi = space_vertices.min(axis=0), space_vertices.max(axis=0)
    del space_vertices
    cells = grid_cells_inside(lo, hi, physical_boxes)
    if cells > int(limits["max_grid_cells"]):
        raise InputRejected(f"扫描范围 {cells:.0f} 格超过上限 {limits['max_grid_cells']}")
    out["boundsSpace"] = {"min": lo.tolist(), "max": hi.tolist()}

    if web_models:
        t = time.monotonic()
        models = []
        for index, model in enumerate(build_web_models(mesh)):
            path = os.path.join(workdir, f"web-{index}.glb")
            with open(path, "wb") as fh:
                fh.write(model.data)
            models.append(
                {
                    "path": path,
                    "bytes": len(model.data),
                    "triangles": model.triangles,
                    "vertices": model.vertices,
                    "textureSide": model.texture_side,
                }
            )
        out["webModels"] = models
        timings["webModels"] = round(time.monotonic() - t, 2)

    if do_rebuild and authored is not None:
        t = time.monotonic()
        out["rebuild"] = authored_rebuild(
            mesh.transformed(align.matrix),
            authored,
            authored_sources or {},
            workdir=os.path.join(workdir, "authored"),
            limits=limits,
            hints=hints,
        )
        timings["rebuild"] = round(time.monotonic() - t, 2)
    elif do_rebuild:
        t = time.monotonic()
        result = rebuild(mesh.transformed(align.matrix), hints=hints, objects_target=objects_target)
        out["rebuild"] = {
            "entities": jsonable(result.entities),
            "textures": result.textures,
            "structureIds": result.structure_ids,
            "objectIds": result.object_ids,
            "objectsSkipped": result.objects_skipped,
            "metrics": jsonable(result.metrics),
        }
        timings["rebuild"] = round(time.monotonic() - t, 2)
    timings["total"] = round(time.monotonic() - t0, 2)
    out["timings"] = timings
    return jsonable(out)  # 贴图字节原样保留


# ---------------------------------------------------------------------------- 体素化


def voxelize_task(
    *,
    scan_path: str,
    workdir: str,
    limits: Mapping[str, int],
    transform: list[float],
    palette_size: int,
    existing_blocks: list[dict],
    physical_boxes: list[list[int]] | None = None,
    max_cells: int = 100_000_000,
) -> dict:
    t0 = time.monotonic()
    mesh = read_scan(scan_path, workdir, limits)
    space = mesh.transformed(matrix_from_params(transform))
    del mesh
    vox = voxelize_mesh(space, palette_size=palette_size, physical_boxes=physical_boxes, max_cells=max_cells)
    blocks, ids = assign_blocks(existing_blocks, vox.colors)
    block_per_cell = ids[vox.labels] if len(vox.labels) else np.zeros(0, np.int64)
    chunks = encode_chunks(vox.cells, block_per_cell)
    return {
        "chunks": [[k[0], k[1], k[2], h, data] for k, (h, data) in sorted(chunks.items())],
        "blocks": jsonable(blocks),
        "paletteChanged": len(blocks) != len(existing_blocks),
        "stats": jsonable({**vox.stats, "chunks": len(chunks), "seconds": round(time.monotonic() - t0, 2)}),
    }


# ---------------------------------------------------------------------------- 物件模型


def model_task(*, path: str, workdir: str, limits: Mapping[str, int]) -> dict:
    os.makedirs(workdir, exist_ok=True)
    model_path, texture_path = prepare_model_file(path, workdir, int(limits["max_model_bytes"]) * 4)
    mesh, colors, base = load_model(
        model_path,
        texture_path,
        max_triangles=int(limits["max_triangles"]),
        max_texture_pixels=int(limits["max_texture_pixels"]),
    )
    model = export_model(
        mesh,
        colors,
        base,
        max_triangles=int(limits["model_max_triangles"]),
        max_texture_side=int(limits["model_max_texture_side"]),
    )
    out_path = os.path.join(workdir, "model.glb")
    with open(out_path, "wb") as fh:
        fh.write(model.data)
    return jsonable(
        {
            "path": out_path,
            "bytes": len(model.data),
            "triangles": model.triangles,
            "vertices": model.vertices,
            "textureSide": model.texture_side,
            "sourceTriangles": model.source_triangles,
            "bounds": model.bounds,
        }
    )


__all__ = [
    "column_major",
    "jsonable",
    "model_task",
    "scan_task",
    "sniff_task",
    "voxelize_task",
]
