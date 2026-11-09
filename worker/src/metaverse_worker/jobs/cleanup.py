"""定期清理（设计 6.1）。平台没有定时任务，所以放在处理服务的循环里做。

1. **没完成的上传**：创建超过 24 小时仍是 `open` 的上传会话。先按条件把状态改成 `expired`（之后接口服务
   的"完成上传"按 `status: open` 条件更新就会失败，不会和清理赛跑），再删除 `files_id` = 上传编号的
   GridFS 数据块，最后删除上传会话。校验失败（`failed`）超过 24 小时的会话同样删除。在这之前先兜底处理
   校验任务已经失败、上传却还停在 `complete` 的（`uploads.settle_stuck_uploads`），免得它一直占着配额。
2. **没人引用的资源**：上传（或最近一次被复用）已超过 7 天、仍没有被任何提交、草稿（`opsRefs.assetHash`、
   `assets`）、物件记录、方块表、资源引用表或未结束的任务引用的资源：先删 `files` 文档（不再可见），
   再删数据块，最后把上传时（以及物件模型导出时）计入的存储用量从各自空间的 `storageUsedBytes` 里减回去。
   重扫配准误差过大、等人工对齐的扫描（完成的 `scan_import` 任务 `result.needsAlignment`）在任务的
   `result.retainUntil` 之前也算被引用。
3. **过期的草稿、草稿区块、预览令牌**（设计 5.6、13.2）：接口服务把 `drafts`、`draftChunks`、`previews` 的
   `expiresAt` 写成 RFC 3339 字符串（固定格式，字符串比较就是时间比较），不建 TTL 索引，由这里清理。
   过期的草稿（不论是否已发布）先删草稿本身，再删它的预览令牌和草稿区块；预览令牌（最长 7 天）和草稿区块
   （与草稿同时过期）再各自按 `expiresAt` 扫一遍，收拾上一轮删了草稿、没来得及删的。草稿删掉后，它
   引用的资源不再算被草稿引用，按第 2 条处理。

这些数据还没进时间线（已发布草稿的内容已经在提交里），删除它们不违反只追加原则。

另外顺带补做一件事：最近 48 小时的提交引用、还没打上 `publishedAt` 的区块补打上（设计 5.7，见
`writeback.backfill_published_chunks`）。
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from ..assets import delete_file_chunks
from ..store import C, JobStatus, Store, UploadStatus
from ..timeutil import format_ts
from ..uploads import release_model_storage, release_upload_storage, settle_stuck_uploads
from .writeback import backfill_published_chunks

log = logging.getLogger(__name__)

_BATCH = 200
PUBLISH_BACKFILL_HOURS = 48


def cleanup_uploads(store: Store, ttl_hours: float) -> int:
    cutoff = format_ts(store.clock() - int(ttl_hours * 3600 * 1000))
    removed = 0
    stale = store.uploads.find(
        {
            "status": {"$in": [UploadStatus.OPEN, UploadStatus.FAILED, UploadStatus.EXPIRED]},
            "createdAt": {"$lt": cutoff},
        },
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


def _referenced(store: Store, sha: str, now: str) -> bool:
    """资源是否仍被引用。这些查询在资源少的第一版可以接受；量大以后再给相应字段加索引。

    `now` 是当前时间（RFC 3339 字符串），判断转人工的扫描是否还在保留期内。
    """
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
            {
                "$or": [
                    {"blocks.texture.top": sha},
                    {"blocks.texture.side": sha},
                    {"blocks.texture.bottom": sha},
                ]
            },
        ),
        # 草稿（接口服务 repo/drafts.rs）：经上传追加的操作文件在 opsRefs[].assetHash，引用的资源在 assets。
        # 草稿没有 opsRef / scriptRef（发布时才写到提交上）；过期草稿已在本轮先删掉。
        (C.DRAFTS, {"$or": [{"opsRefs.assetHash": sha}, {"assets": sha}]}),
    ]
    for collection, filt in checks:
        if store.col(collection).find_one(filt, {"_id": 1}) is not None:
            return True
    # 未结束的任务的参数里提到了它（例如排队中的对齐任务）
    pending = store.jobs.find({"status": {"$in": [JobStatus.QUEUED, JobStatus.RUNNING]}}, {"params": 1})
    if any(sha in _strings(job.get("params")) for job in pending):
        return True
    # 重扫配准误差过大、等人工对齐的扫描（设计 6.2）：任务已经完成但没有提交引用它，保留到 retainUntil。
    # 放在未结束任务之后查：任务在两次查询之间结束时，前一次看到它还在运行，后一次看到完成的结果。
    held = {
        "kind": "scan_import",
        "status": JobStatus.DONE,
        "result.needsAlignment": True,
        "result.scanAssetHash": sha,
        "result.retainUntil": {"$gt": now},
    }
    return store.jobs.find_one(held, {"_id": 1}) is not None


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
    now_ms = store.clock()
    now = format_ts(now_ms)
    cutoff = datetime.fromtimestamp(now_ms / 1000, tz=UTC) - timedelta(days=grace_days)
    removed = 0
    candidates = (
        store.col(C.ASSET_FILES)
        .find(
            {
                "uploadDate": {"$lt": cutoff},
                "$or": [{"metadata.touchedAt": {"$exists": False}}, {"metadata.touchedAt": {"$lt": cutoff}}],
            },
            {"_id": 1, "filename": 1},
        )
        .limit(_BATCH)
    )
    for doc in list(candidates):
        sha = doc.get("filename")
        if not isinstance(sha, str) or _referenced(store, sha, now):
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
            # 这份内容不再占空间：把计过用量的上传、物件模型导出从各自空间的 storageUsedBytes 里减回去
            release_upload_storage(store, sha)
            release_model_storage(store, sha)
            removed += 1
    if removed:
        log.info("清理了 %d 个没人引用的资源", removed)
    return removed


def cleanup_drafts(store: Store) -> dict[str, int]:
    """删除过期的草稿、预览令牌和草稿区块，返回各删了多少。"""
    expired = {"expiresAt": {"$lt": format_ts(store.clock())}}
    drafts = previews = chunks = 0
    stale = store.col(C.DRAFTS).find(expired, {"_id": 1, "spaceId": 1}).limit(_BATCH)
    for draft in list(stale):
        # 先删草稿（接口服务按编号读不到，就不能再追加、预览或发布），再删它的子文档。
        gone = store.col(C.DRAFTS).delete_one({"_id": draft["_id"], **expired})
        if gone.deleted_count != 1:
            continue
        drafts += 1
        children = {"draftId": draft["_id"], "spaceId": draft.get("spaceId")}
        previews += store.col(C.PREVIEWS).delete_many(children).deleted_count
        chunks += store.col(C.DRAFT_CHUNKS).delete_many(children).deleted_count
    previews += store.col(C.PREVIEWS).delete_many(expired).deleted_count
    chunks += store.col(C.DRAFT_CHUNKS).delete_many(expired).deleted_count
    if drafts or previews or chunks:
        log.info("清理了 %d 个过期草稿、%d 个预览令牌、%d 个草稿区块", drafts, previews, chunks)
    return {"drafts": drafts, "previews": previews, "draftChunks": chunks}


def run_cleanup(store: Store, *, upload_ttl_hours: float, asset_grace_days: float) -> dict[str, int]:
    # 顺序：先让卡在 complete 的上传离开（失败的随后按上传规则删除）；草稿在资源之前清，
    # 过期草稿引用的资源在同一轮里就不再算被引用（仍要过资源自己的宽限期）。
    stuck = settle_stuck_uploads(store, upload_ttl_hours)
    uploads = cleanup_uploads(store, upload_ttl_hours)
    drafts = cleanup_drafts(store)
    return {
        "stuckUploads": stuck,
        "uploads": uploads,
        **drafts,
        "assets": cleanup_assets(store, asset_grace_days),
        "publishedChunks": backfill_published_chunks(store, PUBLISH_BACKFILL_HOURS),
    }
