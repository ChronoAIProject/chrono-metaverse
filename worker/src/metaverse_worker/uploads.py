"""上传会话（`uploads` 集合，接口服务创建；字段见 README）的状态变化（设计 6.1）。

接口服务"完成上传"时在同一个事务里把上传从 `open` 改成 `complete`、建 `upload_verify` 任务（编号记在
上传的 `jobId` 上）。处理服务只改 `status: complete` 的上传，每次都带这个条件，所以重做是幂等的：

- `complete → done`：内容已核对、已登记成资源，写 `assetHash`；
- `complete → failed`：校验不通过，或校验任务因为别的原因最终失败（子进程超时 / 内存超限、反复崩溃、
  数据库抖动导致重试次数用完）；同时删掉没有登记成资源的数据块。

接口服务把 `open` 和 `complete` 都算作进行中的上传（每个空间的上限、存储上限的预估），资源可用性也把
`complete` 当作"还在校验"。所以校验任务最终失败时，上传必须离开 `complete`（`settle_upload`），
定期清理再兜底一遍（`settle_stuck_uploads`），否则它会一直占着配额。
"""

from __future__ import annotations

import logging
from typing import Any

from bson import ObjectId
from pymongo.client_session import ClientSession

from .assets import delete_file_chunks, find_asset
from .store import C, JobStatus, Owner, Store, SystemScope, UploadStatus
from .timeutil import format_ts, now_ts

log = logging.getLogger(__name__)

_BATCH = 200


def find_upload(store: Store, scope: SystemScope, upload_id: Any) -> dict[str, Any] | None:
    """按编号找本空间、本主人的上传（编号也接受 ObjectId 的十六进制写法）。"""
    candidates: list[Any] = [upload_id]
    if isinstance(upload_id, str) and ObjectId.is_valid(upload_id):
        candidates.append(ObjectId(upload_id))
    for candidate in candidates:
        doc = store.uploads.find_one({"_id": candidate, **scope.child_filter()})
        if doc is not None:
            return doc
    return None


def declared(doc: dict[str, Any]) -> tuple[str | None, int | None, str | None]:
    """上传记录里声明的 (整体哈希, 大小, 用途)。也接受 `hash`、`totalSize` 作为别名。"""
    sha = doc.get("sha256", doc.get("hash"))
    size = doc.get("size", doc.get("totalSize"))
    purpose = doc.get("purpose")
    return sha, size if isinstance(size, int) and not isinstance(size, bool) else None, purpose


def mark_upload_done(
    store: Store,
    files_id: Any,
    sha: str,
    *,
    fmt: str | None,
    content_type: str | None,
    session: ClientSession | None = None,
) -> bool:
    """`complete → done`，写 `assetHash`。上传已经不是 `complete` 时什么也不做，返回 False。"""
    update: dict[str, Any] = {
        "status": UploadStatus.DONE,
        "assetHash": sha,
        "verifiedAt": now_ts(store.clock),
    }
    if fmt:
        update["format"] = fmt
    if content_type:
        update["contentType"] = content_type
    moved = store.uploads.update_one(
        {"_id": files_id, "status": UploadStatus.COMPLETE}, {"$set": update}, session=session
    )
    return moved.modified_count == 1


def fail_upload(store: Store, files_id: Any, reason: str) -> bool:
    """`complete → failed`（写 `error`），再删掉它的数据块（之后不会再被当成可校验的上传）。

    数据块已经登记成资源（`files._id` = 上传编号）时不删。返回上传是否由本次改成了 failed。
    """
    moved = store.uploads.update_one(
        {"_id": files_id, "status": UploadStatus.COMPLETE},
        {"$set": {"status": UploadStatus.FAILED, "error": reason[:500], "failedAt": now_ts(store.clock)}},
    )
    if store.col(C.ASSET_FILES).find_one({"_id": files_id}, {"_id": 1}) is not None:
        log.error("上传 %s 已登记成资源，不删数据块", files_id)
        return moved.modified_count == 1
    removed = delete_file_chunks(store, files_id)
    log.warning("上传 %s 标记为失败，删除了 %d 个数据块：%s", files_id, removed, reason)
    return moved.modified_count == 1


def settle_upload(store: Store, scope: SystemScope, upload_id: Any, reason: str) -> str | None:
    """校验任务最终失败后，让仍停在 `complete` 的上传离开这个状态。

    - 内容已经核对通过（`verifiedSha256` = 声明的哈希、格式也嗅探过）并且这个哈希的资源已经存在：补做收尾，
      标记 `done`（资源不是本次登记的就删掉本次的数据块，复用已有资源）；
    - 否则标记 `failed`（`error` = 原因），删掉数据块。

    返回上传的新状态；上传不存在或已经不是 `complete` 时返回 None。
    """
    doc = find_upload(store, scope, upload_id)
    if doc is None or doc.get("status") != UploadStatus.COMPLETE:
        return None
    files_id = doc["_id"]
    sha, _size, _purpose = declared(doc)
    asset = find_asset(store, sha) if isinstance(sha, str) and doc.get("verifiedSha256") == sha else None
    if asset is not None:
        meta = asset.get("metadata") or {}
        if asset["_id"] != files_id:
            delete_file_chunks(store, files_id)
        fmt, content_type = meta.get("format"), meta.get("contentType")
        if mark_upload_done(store, files_id, sha, fmt=fmt, content_type=content_type):
            log.info("上传 %s 的内容已登记成资源 %s，校验任务失败后补做收尾", files_id, sha)
            return UploadStatus.DONE
        return None
    return UploadStatus.FAILED if fail_upload(store, files_id, reason) else None


def settle_stuck_uploads(store: Store, ttl_hours: float) -> int:
    """定期清理的兜底：校验任务已经 `failed`（或任务记录超过 `ttl_hours` 还不存在）的 `complete` 上传。

    覆盖主循环来不及处理的情况：重试次数用完被 `reap_exhausted` 标记失败、任务记录不合法、进程在标记任务
    失败之后退出。返回处理了多少个上传。
    """
    cutoff = format_ts(store.clock() - int(ttl_hours * 3600 * 1000))
    settled = 0
    stuck = store.uploads.find(
        {"status": UploadStatus.COMPLETE},
        {"_id": 1, "spaceId": 1, "owner": 1, "jobId": 1, "completedAt": 1, "createdAt": 1},
    ).limit(_BATCH)
    for upload in list(stuck):
        job_id = upload.get("jobId")
        job = store.jobs.find_one({"_id": job_id}, {"status": 1, "lastError": 1}) if job_id else None
        if job is not None and job.get("status") != JobStatus.FAILED:
            continue  # 还在排队或运行中
        if job is None and str(upload.get("completedAt") or upload.get("createdAt") or "") >= cutoff:
            continue  # 刚完成，任务记录可能还没写（正常情况下二者在同一个事务里）
        try:
            scope = SystemScope(str(upload["spaceId"]), Owner.from_doc(upload), str(job_id or "cleanup"))
        except (KeyError, ValueError) as error:
            log.error("上传 %s 记录不合法，跳过：%s", upload["_id"], error)
            continue
        reason = f"校验任务失败：{job.get('lastError') or '原因不明'}" if job else "校验任务不存在"
        if settle_upload(store, scope, upload["_id"], reason) is not None:
            settled += 1
    if settled:
        log.warning("%d 个校验任务已失败的上传离开了 complete 状态", settled)
    return settled
