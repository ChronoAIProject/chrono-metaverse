"""下载 AI 物件集里的外部模型（原来是处理服务写回物件集时父进程做的，处理服务下线后搬到本地）。

- 只用 https、主机在列表里、重定向的每一跳都检查，核对大小和 sha256（`fetch.py`）；主机列表默认取环境变量
  `METAVERSE_RECON_MODEL_HOSTS`（逗号分隔，没设时用 `fetch.DEFAULT_MODEL_HOSTS`）；
- 同一个文件只下载一次；单个模型（含附属文件）不超过 `max_model_bytes`，全部下载不超过 1 GiB；
- gltf 按相对路径把主文件和附属文件摆进一个目录（主文件名固定 `model.gltf`），glb 和 gltf-zip 各是一个文件。

返回的 `{来源键: {format, path}}` 直接交给 `processing.authored_build.authored_rebuild`。
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable, Iterable, Mapping
from typing import Any

from ..authored import AuthoredError
from ..errors import InputRejected
from ..fetch import build_opener, fetch, parse_hosts
from ..processing.authored_build import GLTF_MAIN
from ..processing.limits import MAX_MODEL_BYTES

log = logging.getLogger(__name__)

HOSTS_ENV = "METAVERSE_RECON_MODEL_HOSTS"
MAX_DOWNLOAD_TOTAL = 1 << 30
DOWNLOAD_TIMEOUT_SECONDS = 60.0


def default_hosts() -> tuple[str, ...]:
    """外部模型允许下载的主机：环境变量 `METAVERSE_RECON_MODEL_HOSTS`，没设时用默认列表。"""
    return parse_hosts(os.environ.get(HOSTS_ENV))


def download_sources(
    parsed: Mapping[str, Any],
    workdir: str,
    *,
    hosts: Iterable[str] | None = None,
    max_model_bytes: int = MAX_MODEL_BYTES,
    opener: Any = None,
    check_cancel: Callable[[], None] | None = None,
) -> tuple[dict[str, dict[str, str]], dict[str, int]]:
    """下载 `parse_authored` 整理过的物件集里的外部模型到 `workdir`。

    返回 ({来源键: {format, path}}, 统计 {models, files, bytes, redirects})。`opener` 默认是
    `fetch.build_opener()`（测试里换成信任本机证书的）；`check_cancel` 在每个文件之前调用，要停下时抛异常。
    """
    allowed = tuple(hosts) if hosts is not None else default_hosts()
    opener = opener if opener is not None else build_opener()
    out: dict[str, dict[str, str]] = {}
    stats = {"models": 0, "files": 0, "bytes": 0, "redirects": 0}
    total = 0
    for key, src in sorted(parsed["sources"].items()):
        size = int(src["size"]) + sum(int(f["size"]) for f in src["files"])
        if size > max_model_bytes:
            raise InputRejected(f"外部模型有 {size} 字节，超过上限 {max_model_bytes}")
        total += size
        if total > MAX_DOWNLOAD_TOTAL:
            raise InputRejected(f"外部模型合计超过 {MAX_DOWNLOAD_TOTAL} 字节")
        base = os.path.join(workdir, f"model-{key[:16]}")
        jobs: list[tuple[Mapping[str, Any], str]]
        if src["format"] == "gltf":
            if any(f["path"] == GLTF_MAIN for f in src["files"]):
                raise AuthoredError(f"gltf 的附属文件不能叫 {GLTF_MAIN}")
            jobs = [(src, os.path.join(base, GLTF_MAIN))]
            jobs += [(f, os.path.join(base, *f["path"].split("/"))) for f in src["files"]]
            path = base
        else:
            path = base + (".glb" if src["format"] == "glb" else ".zip")
            jobs = [(src, path)]
        for item, dest in jobs:
            if check_cancel is not None:
                check_cancel()
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            got = fetch(
                item["url"],
                dest,
                sha256=item["sha256"],
                size=int(item["size"]),
                hosts=allowed,
                timeout=DOWNLOAD_TIMEOUT_SECONDS,
                opener=opener,
            )
            stats["files"] += 1
            stats["bytes"] += got.bytes
            stats["redirects"] += got.redirects
        stats["models"] += 1
        out[key] = {"format": src["format"], "path": path}
    if out:
        log.info("下载了 %(models)d 个外部模型（%(files)d 个文件，%(bytes)d 字节）", stats)
    return out, stats


__all__ = ["DOWNLOAD_TIMEOUT_SECONDS", "HOSTS_ENV", "MAX_DOWNLOAD_TOTAL", "default_hosts", "download_sources"]
