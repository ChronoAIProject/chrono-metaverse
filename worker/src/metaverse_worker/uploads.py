"""上传会话（`uploads` 集合，接口服务创建；字段见 README）的状态变化（设计 6.1）。

接口服务"完成上传"时在同一个事务里把上传从 `open` 改成 `complete`、建 `upload_verify` 任务（编号记在
上传的 `jobId` 上）。处理服务只改 `status: complete` 的上传，每次都带这个条件，所以重做是幂等的：

- `complete → done`：内容已核对、已登记成资源，写 `assetHash`；
- `complete → failed`：校验不通过，或校验任务因为别的原因最终失败（子进程超时 / 内存超限、反复崩溃、
  数据库抖动导致重试次数用完）；同时删掉没有登记成资源的数据块。

接口服务把 `open` 和 `complete` 都算作进行中的上传（每个空间的上限、存储上限的预估），资源可用性也把
`complete` 当作"还在校验"。所以校验任务最终失败时，上传必须离开 `complete`（`settle_upload`），
定期清理再兜底一遍（`settle_stuck_uploads`），否则它会一直占着配额。

**空间的存储用量 `spaces.storageUsedBytes`**（设计 4.1、6.1）由处理服务累加：上传 `complete → done` 时，
在同一个事务里给上传写 `storageBytes`（计入的字节数）并把空间的用量加上它（复用已有资源也算本空间的
用量）；资源被定期清理删掉以后，`release_upload_storage` 把还没减回的上传（`storageReleasedAt` 不存在）
从各自空间的用量里减回去。处理服务写的提交新登记派生资源时也计入（见 `jobs/writeback.py`）。

加减用量都只对上传所在的那个**空间实例**：条件按上传的 `createdAt` 比较空间的 `createdAt`（见
`store.space_filter`）。空间被删除后又用同一个编号重建时，旧空间的上传既不能完成到新空间里，也不能从新
空间的用量里减回它从没计入过的字节。
"""

from __future__ import annotations

import logging
from typing import Any

from bson import ObjectId
from bson.int64 import Int64
from pymongo.client_session import ClientSession

from .assets import delete_file_chunks, find_asset
from .errors import SpaceGone
from .store import C, JobStatus, Owner, Store, SystemScope, UploadStatus, space_filter
from .timeutil import format_ts, now_ts

log = logging.getLogger(__name__)


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


def finish_upload(
    store: Store,
    scope: SystemScope,
    files_id: Any,
    sha: str,
    size: int,
    *,
    fmt: str | None,
    content_type: str | None,
    session: ClientSession | None = None,
) -> bool:
    """`complete → done`，写 `assetHash`、`storageBytes`，并把 `size` 计入空间的存储用量。

    两处写入要放在同一个事务里（传 `session`），否则中途退出会多计或漏计。上传已经不是 `complete` 时
    什么也不做，返回 False。上传所在的空间实例已经不在了（被删除，或删除后用同一个编号重建）时抛
    `SpaceGone`，什么也不改，由调用方把上传标记为失败。
    """
    upload = store.uploads.find_one(
        {"_id": files_id, "status": UploadStatus.COMPLETE, **scope.child_filter()},
        {"createdAt": 1},
        session=session,
    )
    if upload is None:
        return False
    space = upload_space_filter(scope.space_id, scope.owner, upload)
    if store.spaces.find_one(space, {"_id": 1}, session=session) is None:
        raise SpaceGone(scope.space_id)
    update: dict[str, Any] = {
        "status": UploadStatus.DONE,
        "assetHash": sha,
        "verifiedAt": now_ts(store.clock),
        "storageBytes": Int64(size),
    }
    if fmt:
        update["format"] = fmt
    if content_type:
        update["contentType"] = content_type
    moved = store.uploads.update_one(
        {"_id": files_id, "status": UploadStatus.COMPLETE, **scope.child_filter()},
        {"$set": update},
        session=session,
    )
    if moved.modified_count != 1:
        return False
    store.add_storage_used(space, size, session=session)
    return True


def upload_space_filter(space_id: Any, owner: Owner, upload: dict[str, Any]) -> dict[str, Any]:
    """上传所在的空间实例：空间的 `createdAt` 不晚于上传的 `createdAt`。"""
    return space_filter(space_id, owner, upload.get("createdAt"))


def release_upload_storage(store: Store, sha: str) -> int:
    """资源被清理删掉以后，把计过用量的上传从各自空间的 `storageUsedBytes` 里减回去。返回减回了几个上传。

    每个上传单独一个事务：先按 `storageReleasedAt` 不存在的条件写上它，再减空间的用量，所以不会减两次。
    """
    released = 0
    counted = store.uploads.find(
        {
            "assetHash": sha,
            "status": UploadStatus.DONE,
            "storageBytes": {"$gt": 0},
            "storageReleasedAt": {"$exists": False},
        },
        {"_id": 1, "spaceId": 1, "owner": 1, "storageBytes": 1, "createdAt": 1},
    )
    for upload in list(counted):
        try:
            owner = Owner.from_doc(upload)
        except ValueError as error:
            log.error("上传 %s 记录不合法，不减回用量：%s", upload["_id"], error)
            continue
        # 只减上传所在的空间实例：同一个编号重建的空间从没计入过这个上传
        space = upload_space_filter(upload.get("spaceId"), owner, upload)
        if _release_one(store, upload["_id"], space, int(upload["storageBytes"])):
            released += 1
    return released


def _release_one(store: Store, upload_id: Any, space_filter: dict[str, Any], size: int) -> bool:
    def txn(session: ClientSession) -> bool:
        moved = store.uploads.update_one(
            {"_id": upload_id, "storageReleasedAt": {"$exists": False}},
            {"$set": {"storageReleasedAt": now_ts(store.clock)}},
            session=session,
        )
        if moved.modified_count != 1:
            return False
        store.add_storage_used(space_filter, -size, session=session)
        return True

    return bool(store.run_transaction(txn))


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
    - 否则标记 `failed`（`error` = 原因），删掉数据块；上传所在的空间实例已经不在了也一样。

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
        size = int(asset["length"])

        def txn(session: ClientSession) -> bool:
            return finish_upload(
                store, scope, files_id, sha, size, fmt=fmt, content_type=content_type, session=session
            )

        try:
            finished = store.run_transaction(txn)
        except SpaceGone as error:
            return UploadStatus.FAILED if fail_upload(store, files_id, f"{reason}；{error}") else None
        if finished:
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
    # 不限条数：complete 的上传最多是"空间数 × 每个空间的进行中上传上限"，限条数的话排在前面的正常上传
    # 会一直挡住后面卡住的。
    stuck = store.uploads.find(
        {"status": UploadStatus.COMPLETE},
        {"_id": 1, "spaceId": 1, "owner": 1, "jobId": 1, "completedAt": 1, "createdAt": 1},
    )
    for upload in stuck:
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
