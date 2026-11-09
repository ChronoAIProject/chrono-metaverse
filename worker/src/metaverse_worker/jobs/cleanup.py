"""定期清理（设计 6.1）。平台没有定时任务，所以放在处理服务的循环里做。

1. **没完成的上传**：创建超过 24 小时仍是 `open` 的上传会话。先按条件把状态改成 `expired`（之后接口服务
   的"完成上传"按 `status: open` 条件更新就会失败，不会和清理赛跑），再删除 `files_id` = 上传编号的
   GridFS 数据块，最后删除上传会话。校验失败（`failed`）超过 24 小时的会话同样删除。
2. **没人引用的资源**：上传（或最近一次被复用）已超过 7 天、仍没有被任何提交、草稿、物件记录、
   方块表、资源引用表或未结束的任务引用的资源：先删 `files` 文档（不再可见），再删数据块。

这些数据还没进时间线，删除它们不违反只追加原则。
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from ..assets import delete_file_chunks
from ..store import C, JobStatus, Store, UploadStatus
from ..timeutil import format_ts

log = logging.getLogger(__name__)

_BATCH = 200


def cleanup_uploads(store: Store, ttl_hours: float) -> int:
    cutoff = format_ts(store.clock() - int(ttl_hours * 3600 * 1000))
    removed = 0
    stale = store.uploads.find(
        {"status": {"$in": [UploadStatus.OPEN, UploadStatus.FAILED, UploadStatus.EXPIRED]}, "createdAt": {"$lt": cutoff}},
        {"_id": 1, "status": 1},
    ).limit(_BATCH)
    for upload in list(stale):
        uid = upload["_id"]
        if upload["status"] == UploadStatus.OPEN:
            flipped = store.uploads.update_one(
                {"_id": uid, "status": UploadStatus.OPEN, "createdAt": {"$lt": cutoff}},
                {"$set": {"status": UploadStatus.EXPIRED}},
            )
            if flipped.matched_count != 1:
                continue  # 刚好被完成了
        # 已登记成资源的 files 文档（_id = 上传编号）不能被删：只有校验通过（done）才会登记，这里不会遇到。
        if store.col(C.ASSET_FILES).find_one({"_id": uid}, {"_id": 1}) is not None:
            log.error("上传 %s 状态是 %s 却已登记成资源，跳过", uid, upload["status"])
            continue
        delete_file_chunks(store, uid)
        store.uploads.delete_one({"_id": uid, "status": {"$in": [UploadStatus.EXPIRED, UploadStatus.FAILED]}})
        removed += 1
    if removed:
        log.info("清理了 %d 个过期上传", removed)
    return removed


def _referenced(store: Store, sha: str) -> bool:
    """资源是否仍被引用。这些查询在资源少的第一版可以接受；量大以后再给相应字段加索引。"""
    checks: list[tuple[str, dict[str, Any]]] = [
        (C.ASSET_REFS, {"hash": sha}),
        (
            C.COMMITS,
            {
                "$or": [
                    {"scan.assetHash": sha},
                    {"scan.textureHash": sha},
                    {"scan.webModelHashes": sha},
                    {"opsRef": sha},
                    {"scriptRef": sha},
                ]
            },
        ),
        (C.RECORDS, {"$or": [{"body.assetHash": sha}, {"body.textures": sha}]}),
        (
            C.PALETTES,
            {"$or": [{"blocks.texture.top": sha}, {"blocks.texture.side": sha}, {"blocks.texture.bottom": sha}]},
        ),
        (C.DRAFTS, {"$or": [{"opsRef": sha}, {"scriptRef": sha}, {"assets": sha}]}),
    ]
    for collection, filt in checks:
        if store.col(collection).find_one(filt, {"_id": 1}) is not None:
            return True
    # 未结束的任务的参数里提到了它（例如排队中的对齐任务）
    pending = store.jobs.find({"status": {"$in": [JobStatus.QUEUED, JobStatus.RUNNING]}}, {"params": 1})
    return any(sha in _strings(job.get("params")) for job in pending)


def _strings(value: Any) -> set[str]:
    out: set[str] = set()
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            out.add(item)
        elif isinstance(item, dict):
            stack.extend(item.values())
        elif isinstance(item, list | tuple):
            stack.extend(item)
    return out


def cleanup_assets(store: Store, grace_days: float) -> int:
    cutoff = datetime.fromtimestamp(store.clock() / 1000, tz=UTC) - timedelta(days=grace_days)
    removed = 0
    candidates = store.col(C.ASSET_FILES).find(
        {
            "uploadDate": {"$lt": cutoff},
            "$or": [{"metadata.touchedAt": {"$exists": False}}, {"metadata.touchedAt": {"$lt": cutoff}}],
        },
        {"_id": 1, "filename": 1},
    ).limit(_BATCH)
    for doc in list(candidates):
        sha = doc.get("filename")
        if not isinstance(sha, str) or _referenced(store, sha):
            continue
        # 条件删除：期间被复用（touchedAt 更新）就不删。
        gone = store.col(C.ASSET_FILES).delete_one(
            {
                "_id": doc["_id"],
                "$or": [{"metadata.touchedAt": {"$exists": False}}, {"metadata.touchedAt": {"$lt": cutoff}}],
            }
        )
        if gone.deleted_count == 1:
            delete_file_chunks(store, doc["_id"])
            removed += 1
    if removed:
        log.info("清理了 %d 个没人引用的资源", removed)
    return removed


def run_cleanup(store: Store, *, upload_ttl_hours: float, asset_grace_days: float) -> dict[str, int]:
    return {
        "uploads": cleanup_uploads(store, upload_ttl_hours),
        "assets": cleanup_assets(store, asset_grace_days),
    }
