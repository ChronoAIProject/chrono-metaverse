"""`scan_import` / `rebuild` 的 AI 物件集：父进程部分（读取、校验、下载外部模型、登记资源）。

任务参数二选一：

- `authored`：物件集本身（内联 JSON，规范化后 ≤ 4MB）；
- `authoredAsset`：authored 用途的资源哈希（本空间上传的，或接口服务、部署种子登记的），内容是物件集的
  UTF-8 JSON。接口服务收到内联的物件集时也登记成资源、改传这个，任务参数不会太大。

格式和校验规则见 `authored.py`；计算（结构、模型重新导出、烘焙、偏差）在子进程里做，见
`processing/authored_build.py`。这里负责：

1. 读物件集并校验，不合法直接失败（不可重试）；
2. 形状里引用的已有贴图必须是本空间的贴图资源，先过清理的栅栏（刷新 `touchedAt` 并要求匹配到）；
3. 下载外部模型：只用 https、主机在 `WORKER_MODEL_HOSTS` 里、重定向的每一跳都检查，核对大小和 sha256
   （`fetch.py`）；同一个文件只下载一次，单个模型（含附属文件）不超过 `WORKER_MAX_MODEL_BYTES`，全部下载
   不超过 1 GiB；
4. 子进程算完以后：处理后的模型登记成资源（`kind: model`），`notes` 存成脚本资源（`kind: script`），
   提交的 `scriptRef` 指向它。
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from typing import Any

from ..assets import AssetError, find_asset, put_asset, read_asset, touch_asset
from ..authored import MAX_AUTHORED_BYTES, AuthoredError, load_authored_bytes, parse_authored
from ..errors import InputRejected, PermanentJobError
from ..fetch import build_opener, fetch
from ..processing.authored_build import GLTF_MAIN
from ..store import C
from .context import JobContext, require_hash

log = logging.getLogger(__name__)

AUTHORED_ASSET_KIND = "authored"
MAX_DOWNLOAD_TOTAL = 1 << 30
DOWNLOAD_TIMEOUT_SECONDS = 60.0
# 下载用的 urllib opener（测试里换成信任本机证书、不走代理的）
OPENER_FACTORY = build_opener


def space_asset(ctx: JobContext, sha: str, kind: str) -> bool:
    """资源存在、`metadata.kind` 对，并且属于本空间（与接口服务 `Repo::owned_assets` 同样的依据）：
    本空间登记的（`metadata.spaceId`），或本空间的提交引用过（`assetRefs`），或本空间完成的上传。
    资源按内容全局去重，别的空间先登记了同一份内容时 `metadata.spaceId` 是那个空间。"""
    doc = find_asset(ctx.store, sha)
    meta = (doc or {}).get("metadata") or {}
    if doc is None or meta.get("kind") != kind:
        return False
    space_id = ctx.lease.scope.space_id
    if meta.get("spaceId") == space_id:
        return True
    if ctx.store.col(C.ASSET_REFS).find_one({"hash": sha, "spaceId": space_id}, {"_id": 1}):
        return True
    done = {"spaceId": space_id, "assetHash": sha, "status": "done"}
    return ctx.store.uploads.find_one(done, {"_id": 1}) is not None


def load_authored(ctx: JobContext) -> dict[str, Any] | None:
    """任务参数里的物件集 → `parse_authored` 的结果（另加 `origin`：inline 或 asset）；没给时返回 None。"""
    params = ctx.params
    inline, asset = params.get("authored"), params.get("authoredAsset")
    if inline is None and asset is None:
        return None
    if inline is not None and asset is not None:
        raise PermanentJobError("参数 authored 和 authoredAsset 只能给一个")
    if asset is not None:
        # 归属由接口服务建任务时检查（调用方给的哈希必须是本空间的；内联的物件集由接口服务登记成资源，
        # 内容相同的资源全局只有一份，可能最早是别的空间登记的），这里只认用途
        asset_hash = require_hash(params, "authoredAsset")
        doc = find_asset(ctx.store, asset_hash)
        if doc is None:
            raise PermanentJobError("物件集资源不存在（可能已被定期清理，请重新上传）")
        if (doc.get("metadata") or {}).get("kind") != AUTHORED_ASSET_KIND:
            raise PermanentJobError("authoredAsset 必须是 authored 用途的资源")
        try:
            data = read_asset(ctx.store, asset_hash, MAX_AUTHORED_BYTES)
        except AssetError as error:
            raise AuthoredError(f"物件集资源读不出来：{error}") from error
        raw = load_authored_bytes(data)
    else:
        raw = inline
    parsed = parse_authored(raw)
    parsed["origin"] = {"kind": "asset", "assetHash": asset} if asset is not None else {"kind": "inline"}
    return parsed


def fence_textures(ctx: JobContext, parsed: Mapping[str, Any]) -> list[str]:
    """形状里引用的已有贴图：必须是本空间的贴图资源，并且还在（刷新 `touchedAt`，清理就删不掉它）。"""
    out = []
    for sha in parsed["textures"]:
        if not space_asset(ctx, sha, "texture"):
            raise AuthoredError(f"形状引用的贴图 {sha} 不是本空间的贴图资源")
        if not touch_asset(ctx.store, sha):
            raise AuthoredError(f"形状引用的贴图 {sha} 已被定期清理，请重新上传")
        out.append(sha)
    return out


def download_sources(
    ctx: JobContext, parsed: Mapping[str, Any]
) -> tuple[dict[str, dict[str, str]], dict[str, int]]:
    """下载物件集里的外部模型。返回 ({来源键: {format, path}}, 统计)。"""
    hosts = ctx.config.model_hosts
    opener = OPENER_FACTORY()
    out: dict[str, dict[str, str]] = {}
    stats = {"models": 0, "files": 0, "bytes": 0, "redirects": 0}
    total = 0
    for key, src in sorted(parsed["sources"].items()):
        size = int(src["size"]) + sum(int(f["size"]) for f in src["files"])
        if size > ctx.config.max_model_bytes:
            raise InputRejected(f"外部模型有 {size} 字节，超过上限 {ctx.config.max_model_bytes}")
        total += size
        if total > MAX_DOWNLOAD_TOTAL:
            raise InputRejected(f"外部模型合计超过 {MAX_DOWNLOAD_TOTAL} 字节")
        base = ctx.path(f"model-{key[:16]}")
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
            ctx.check_cancel()
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            got = fetch(
                item["url"],
                dest,
                sha256=item["sha256"],
                size=int(item["size"]),
                hosts=hosts,
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


def register_models(ctx: JobContext, models: Mapping[str, Mapping[str, Any]]) -> list[str]:
    """处理后的外部模型 glb 登记成资源（`kind: model`，按内容哈希去重）。"""
    out = []
    for sha, info in sorted(models.items()):
        asset = put_asset(
            ctx.store,
            info["path"],
            content_type="model/gltf-binary",
            kind="model",
            space_id=ctx.lease.scope.space_id,
            extra={"authoredSource": info.get("source")},
        )
        if asset.hash != sha:
            raise PermanentJobError(f"模型 {sha} 的内容与哈希不符")
        out.append(sha)
    return out


def store_notes(ctx: JobContext, notes: str | None) -> str | None:
    """建模过程记录存成本空间的脚本资源，返回哈希（提交的 `scriptRef`）。"""
    if not notes:
        return None
    return put_asset(
        ctx.store,
        notes.encode("utf-8"),
        content_type="text/plain; charset=utf-8",
        kind="script",
        space_id=ctx.lease.scope.space_id,
    ).hash


def summary(
    parsed: Mapping[str, Any],
    rebuilt: Mapping[str, Any],
    downloads: Mapping[str, int],
    script_ref: str | None,
) -> dict[str, Any]:
    """写进任务结果的物件集统计：逐件偏差、下载、模型、烘焙。"""
    models = rebuilt.get("models") or {}
    return {
        "origin": parsed["origin"],
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
        "scriptRef": script_ref,
    }
