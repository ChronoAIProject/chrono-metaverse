"""外部模型：找本机文件或下载，再按物件模型的上限导出成 glb（设计 8.3 `models`，第 12 节的导出修正）。

- **找文件**：物件集里每个外部模型（`model: {url, sha256, size, format}`）先在本机找——工作台 `fetch` 的缓存
  （`<缓存>/models/**/model.json` 旁注里记着来源文件的 sha256，Poly Haven 的 glTF 已打包成 glb）和
  `--models-dir` 给的目录；找不到再按地址下载（`sources.download_sources`：https、主机列表、核对大小和哈希）；
- **导出**：`processing.authored_build.export_models`（读入按材质分开 → 缩放、俯仰、翻滚和调色烘进模型 →
  减面 → 写 glb，原点在底面中心）。偏航写进物件记录的 `transform`，同一个模型只因偏航不同的几处摆放
  共用一份 glb。

只读写本地文件，不连接本服务。
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable, Mapping
from typing import Any

from ..processing.authored_build import export_models
from .sources import download_sources


def sidecar_files(dirs: Iterable[str]) -> dict[str, str]:
    """`fetch` 写的旁注（`model.json`）：来源文件的 sha256 → 本机打包好的 glb。"""
    out: dict[str, str] = {}
    for root in dirs:
        if not os.path.isdir(root):
            continue
        for dirpath, _, files in os.walk(root):
            if "model.json" not in files:
                continue
            try:
                with open(os.path.join(dirpath, "model.json"), encoding="utf-8") as fh:
                    side = json.load(fh)
            except (OSError, ValueError):
                continue
            sha = (side.get("model") or {}).get("sha256") if isinstance(side, dict) else None
            local = os.path.join(dirpath, ((side.get("local") or {}).get("path")) or "model.glb")
            if isinstance(sha, str) and os.path.isfile(local):
                out.setdefault(sha, local)
    return out


def resolve_sources(
    parsed: Mapping[str, Any],
    workdir: str,
    *,
    search_dirs: Iterable[str] = (),
    hosts: Iterable[str] | None = None,
    max_model_bytes: int | None = None,
    opener: Any = None,
    download: bool = True,
) -> tuple[dict[str, dict[str, str]], dict[str, Any]]:
    """物件集（`parse_authored` 的结果）里的外部模型 → `{来源键: {format, path}}`：本机有的直接用，
    没有的下载。

    返回 (来源, 统计 `{local, downloaded: {models, files, bytes, redirects}, missing: [...]}`)。
    `download=False` 时不下载，找不到的列进 `missing`。
    """
    local = sidecar_files(search_dirs)
    found: dict[str, dict[str, str]] = {}
    pending: dict[str, Any] = {}
    for key, src in sorted(parsed["sources"].items()):
        if src["sha256"] in local:
            found[key] = {"format": "glb", "path": local[src["sha256"]]}
        else:
            pending[key] = src
    stats: dict[str, Any] = {"local": len(found), "downloaded": None, "missing": []}
    if pending and download:
        kwargs: dict[str, Any] = {"hosts": hosts, "opener": opener}
        if max_model_bytes is not None:
            kwargs["max_model_bytes"] = max_model_bytes
        got, dl = download_sources({"sources": pending}, os.path.join(workdir, "downloads"), **kwargs)
        found.update(got)
        stats["downloaded"] = dl
    elif pending:
        stats["missing"] = sorted(pending)
    return found, stats


def export_entity_models(
    parsed: Mapping[str, Any],
    sources: Mapping[str, Mapping[str, str]],
    workdir: str,
    limits: Mapping[str, int],
) -> tuple[dict[str, dict], dict[str, dict]]:
    """见模块说明。返回 ({资源哈希: 文件信息}, {物件编号: 摆放 `{hash, yaw, origin, bounds, mesh}`})。"""
    return export_models(parsed, sources, workdir, limits)


__all__ = ["export_entity_models", "resolve_sources", "sidecar_files"]
