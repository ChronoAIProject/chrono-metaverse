"""`metaverse-recon bundle` 的编排（设计 8.3）：物件集或算法结果 → 重建包目录。

1. 读上限（`limits.json`，没有就用默认值），物件集里的贴图引用换成哈希、准备好文件（`textures`）；
2. `rebuild.rebuild_scan`：按给定的变换读扫描（不重新对齐）→ 网页用模型（给了 `--webmodel` 就不生成）→
   AI 物件集（外部模型找本地文件或下载、按上限导出、烘焙、逐件偏差、结构贴图回退）或算法的结构和物体 →
   建议锚点；
3. 写包（`manifest`）：编号加 `rb.`、整体替换（`rebuilt.mode = replace`）、`base` 取工作区、`--seed` 去掉
   内部锚点和建模记录；
4. 最后调用 `metaverse bundle check`（`PATH` 里有就调，没有就打印要运行的命令）。

`--from-snapshot`（`snapshot.py`）另走一条路：用拉下来的快照直接打包，不读扫描、不重建。
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from collections.abc import Iterable, Mapping
from typing import Any

from ..errors import InputRejected
from ..processing.rebuild import OBJECTS_TARGET
from .limits import processing_limits
from .manifest import (
    BundleWriter,
    fit_report,
    prefixed_records,
    record_refs,
    seed_filter,
    write_manifest,
)
from .rebuild import rebuild_scan
from .textures import resolve_texture_refs

log = logging.getLogger(__name__)
MANAGED = ("manifest.json", "scan", "web", "models", "textures", "notes.md")


def prepare_out_dir(out_dir: str) -> None:
    """包目录：不存在就建；已经是包目录（有 manifest.json 或只有包里的那几样）就清掉重写；别的目录拒绝。"""
    if os.path.isdir(out_dir) and os.listdir(out_dir):
        extra = set(os.listdir(out_dir)) - set(MANAGED)
        if extra:
            raise InputRejected(f"{out_dir} 里有不是重建包的文件（{sorted(extra)[:3]}），换一个空目录")
        for name in MANAGED:
            path = os.path.join(out_dir, name)
            if os.path.isdir(path):
                shutil.rmtree(path)
            elif os.path.exists(path):
                os.remove(path)
    os.makedirs(out_dir, exist_ok=True)


def scan_section(
    writer: BundleWriter,
    scan_path: str,
    web_paths: list[str],
    transform: list[float],
    alignment: Mapping[str, Any] | None,
    observed_at: str | None,
) -> dict[str, Any]:
    """清单的 `scan`：扫描文件、网页用模型（[0] 是网站加载的那一档）、变换、对齐说明、拍摄时间（可选）。"""
    ext = os.path.splitext(scan_path)[1].lower().lstrip(".") or "zip"
    scan_hash = writer.add(scan_path, f"scan/scan.{ext}", "scan")
    hashes = [writer.add(p, f"web/scan-{i}.glb", "webmodel") for i, p in enumerate(web_paths[:2])]
    if not hashes:
        raise InputRejected("没有网页用模型（给 --webmodel，或让 bundle 生成）")
    section: dict[str, Any] = {"assetHash": scan_hash, "webModelHashes": hashes, "transform": list(transform)}
    if alignment:
        section["alignment"] = {k: v for k, v in alignment.items() if isinstance(v, str | int | float)}
    if observed_at:
        section["observedAt"] = observed_at
    return section


def run_bundle_check(out_dir: str, seed: bool) -> dict[str, Any]:
    """调用 `metaverse bundle check`：`PATH` 里有就调，没有就只返回要运行的命令。"""
    cmd = ["metaverse", "bundle", "check", out_dir, *(["--seed"] if seed else [])]
    exe = shutil.which("metaverse")
    if exe is None:
        return {"ran": False, "command": " ".join(cmd)}
    proc = subprocess.run([exe, *cmd[1:]], capture_output=True, text=True, timeout=600)
    return {
        "ran": True,
        "command": " ".join(cmd),
        "ok": proc.returncode == 0,
        "output": (proc.stdout + proc.stderr)[-4000:],
    }


def collect_files(
    writer: BundleWriter,
    templates: list[dict],
    entities: list[dict],
    models: Mapping[str, Mapping[str, Any]],
    textures: Mapping[str, bytes],
    texture_files: Mapping[str, str],
) -> None:
    """记录引用的每个物件模型和贴图都放进包；缺文件时报错（包必须完整，SHAPES 7"引用"）。"""
    need_models: set[str] = set()
    need_textures: set[str] = set()
    for body in [*templates, *entities]:
        m, t = record_refs(body)
        need_models |= m
        need_textures |= t
    missing = []
    for sha in sorted(need_models):
        if sha in models:
            writer.model(str(models[sha]["path"]))
        else:
            missing.append(f"物件模型 {sha}")
    for sha in sorted(need_textures):
        if sha in texture_files:
            writer.texture(texture_files[sha])
        elif sha in textures:
            data = textures[sha]
            ext = "png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "jpg"
            writer.add_bytes(data, f"textures/{sha[:12]}.{ext}", "texture")
        else:
            missing.append(f"贴图 {sha}")
    if missing:
        raise InputRejected("这些文件本地没有，包不完整：" + "；".join(missing[:10]))


def build_bundle(
    *,
    scan_path: str,
    transform: list[float],
    out_dir: str,
    workdir: str,
    upload_limits: Mapping[str, Any],
    authored_path: str | None = None,
    hints: Mapping[str, Any] | None = None,
    webmodels: list[str] | None = None,
    base: Mapping[str, Any] | None = None,
    note: str | None = None,
    seed: bool = False,
    model_dirs: Iterable[str] = (),
    texture_dirs: Iterable[str] = (),
    observed_at: str | None = None,
    notes_path: str | None = None,
    hosts: Iterable[str] | None = None,
    opener: Any = None,
    check: bool = True,
    objects_target: str | None = OBJECTS_TARGET,
) -> dict[str, Any]:
    """见模块说明。`authored_path` 不给时用算法的结构和物体（`--algorithm`）。返回打包的统计。"""
    prepare_out_dir(out_dir)
    os.makedirs(workdir, exist_ok=True)
    limits = processing_limits(upload_limits)
    authored = None
    texture_files: dict[str, str] = {}
    texture_stats: dict[str, int] = {}
    if authored_path is not None:
        try:
            with open(authored_path, encoding="utf-8") as fh:
                raw = json.load(fh)
        except (OSError, ValueError) as error:
            raise InputRejected(f"物件集 {authored_path} 读不了：{error}") from error
        authored, texture_files, texture_stats = resolve_texture_refs(
            raw,
            base_dir=os.path.dirname(os.path.abspath(authored_path)),
            workdir=os.path.join(workdir, "textures"),
            texture_limits=upload_limits["texture"],
            search_dirs=texture_dirs,
            hosts=hosts,
            opener=opener,
        )
    result = rebuild_scan(
        scan_path,
        os.path.join(workdir, "rebuild"),
        limits=limits,
        transform=transform,
        hints=hints,
        authored=authored,
        known_textures=texture_files,
        web_models=webmodels is None,
        hosts=hosts,
        opener=opener,
        model_dirs=model_dirs,
        objects_target=objects_target,
    )
    if result.get("objectsSkipped"):
        raise InputRejected(f"物体重建没有做（{result['objectsSkipped']}），只有结构：不能当整个重建层打包")
    writer = BundleWriter(out_dir, upload_limits)
    web_paths = list(webmodels) if webmodels is not None else [m["path"] for m in result["webModels"]]
    scan = scan_section(
        writer, scan_path, web_paths, result["transform"], result.get("alignment"), observed_at
    )
    bodies = result["entities"]
    raw_templates = [b for _, b in sorted(bodies.items()) if b.get("kind") == "template"]
    structure = set(result.get("structureIds") or [])
    raw_entities = [bodies[e] for e in sorted(structure) if e in bodies] + [
        b for e, b in sorted(bodies.items()) if e not in structure and b.get("kind") != "template"
    ]
    templates, entities, mapping = prefixed_records(raw_templates, raw_entities)
    collect_files(writer, templates, entities, result["models"], result["textures"], texture_files)
    anchors = [dict(a) for _, a in sorted((result.get("anchors") or {}).items())]
    summary = result.get("authored") or {}
    report: dict[str, Any] = {"entities": len(entities), "templates": len(templates)}
    fit = fit_report(summary.get("fit") or [])
    if fit:
        report["fit"] = fit
    if summary.get("models"):
        report["models"] = summary["models"]
    dropped = 0
    notes_sha = None
    if seed:
        anchors, report, dropped = seed_filter(anchors, report)
    else:
        text = None
        if notes_path is not None:
            with open(notes_path, encoding="utf-8") as fh:
                text = fh.read()
        elif result.get("notes"):
            text = result["notes"]
        if text:
            notes_sha = writer.add_bytes(text.encode("utf-8"), "notes.md", "script")
    if note is None:
        kind = "AI 物件集" if authored is not None else "算法结构和物体"
        note = f"重建层整体替换：{kind}，物件 {len(entities)} 件、模板 {len(templates)} 个"
    _, manifest_sha = write_manifest(
        writer,
        note=note,
        base=base,
        scan=scan,
        templates=templates,
        entities=entities,
        anchors=anchors,
        notes_sha=notes_sha,
        report=report,
    )
    out = {
        "outDir": out_dir,
        "manifest": manifest_sha,
        "entities": len(entities),
        "templates": len(templates),
        "anchors": len(anchors),
        "droppedInternalAnchors": dropped,
        "files": {
            p: sum(1 for f in writer.files if f["purpose"] == p)
            for p in ("scan", "webmodel", "model", "texture", "script")
        },
        "bytes": sum(f["size"] for f in writer.files),
        "renamed": sum(1 for k, v in mapping.items() if k != v),
        "textureRefs": texture_stats,
        "authored": {k: v for k, v in summary.items() if k != "fit"} if summary else None,
        "fit": summary.get("fit"),
        "transform": result["transform"],
        "timings": result.get("timings"),
    }
    out["check"] = run_bundle_check(out_dir, seed) if check else {"ran": False}
    return out


__all__ = ["build_bundle", "collect_files", "prepare_out_dir", "run_bundle_check", "scan_section"]
