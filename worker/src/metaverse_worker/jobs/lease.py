"""任务租约（设计 6.4）。

```
jobs { _id, spaceId, owner, kind, params, status: queued|running|done|failed,
       leaseOwner, leaseUntil, attempt, maxAttempts(默认 3), lastError, resultCommitId, createdAt }
```

- **领取**：一次 `find_one_and_update` 原子地领取排队中的任务，或租约已过期且重试次数未用完的任务，
  同时写入租约（默认 3 分钟）并把 `attempt` 加 1；
- **续约**：条件 `{_id, leaseOwner, attempt, status: running}`；匹配不到说明租约已经丢了（栅栏），
  处理进程必须放弃，不能再写回结果；
- **结束**：完成、失败、退回队列、释放租约，条件都带同样的栅栏；
- **重试次数用完**：租约过期且 `attempt >= maxAttempts` 的任务由 `reap_exhausted` 标记为失败；
- **每个空间的并发上限**：领取时排除正在运行的任务数已达上限的空间，一个空间的任务不会挡住其他空间。

时间都按 RFC 3339 字符串存（`timeutil`），固定格式的字符串比较就是时间比较。
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from pymongo import ReturnDocument
from pymongo.client_session import ClientSession

from ..store import JobStatus, Owner, Store, SystemScope
from ..timeutil import format_ts

log = logging.getLogger(__name__)

DEFAULT_MAX_ATTEMPTS = 3
MAX_ERROR_CHARS = 2000


class LeaseLost(RuntimeError):
    """租约已经不属于本进程（被回收、被别人领走、任务已结束）。必须放弃，不能写回。"""


@dataclass(frozen=True)
class Lease:
    job_id: Any
    space_id: str
    owner: Owner
    kind: str
    params: Mapping[str, Any]
    attempt: int
    max_attempts: int
    worker_id: str
    lease_until: str
    doc: Mapping[str, Any] = field(repr=False, compare=False)

    @property
    def scope(self) -> SystemScope:
        return SystemScope(self.space_id, self.owner, str(self.job_id))

    def fence(self, **extra: Any) -> dict[str, Any]:
        """栅栏条件：任务编号 + 租约持有者 + 重试次数 + 运行中。"""
        return {
            "_id": self.job_id,
            "leaseOwner": self.worker_id,
            "attempt": self.attempt,
            "status": JobStatus.RUNNING,
            **extra,
        }

    @property
    def is_last_attempt(self) -> bool:
        return self.attempt >= self.max_attempts


def _attempt_expr(op: str) -> dict[str, Any]:
    return {
        "$expr": {op: [{"$ifNull": ["$attempt", 0]}, {"$ifNull": ["$maxAttempts", DEFAULT_MAX_ATTEMPTS]}]}
    }


def saturated_spaces(store: Store, now_ms: int, limit: int) -> list[str]:
    """正在运行（租约未过期）的任务数已达上限的空间。"""
    pipeline = [
        {"$match": {"status": JobStatus.RUNNING, "leaseUntil": {"$gte": format_ts(now_ms)}}},
        {"$group": {"_id": "$spaceId", "n": {"$sum": 1}}},
        {"$match": {"n": {"$gte": limit}}},
    ]
    return [row["_id"] for row in store.jobs.aggregate(pipeline)]


def claim(
    store: Store,
    worker_id: str,
    kinds: Iterable[str],
    lease_ms: int,
    max_per_space: int | None = None,
) -> Lease | None:
    """原子地领取一个任务。没有可领的任务时返回 None。"""
    now = store.clock()
    now_ts = format_ts(now)
    conditions: list[dict[str, Any]] = [
        {
            "$or": [
                {"status": JobStatus.QUEUED},
                {"status": JobStatus.RUNNING, "leaseUntil": {"$lt": now_ts}},
            ]
        },
        _attempt_expr("$lt"),
        {"kind": {"$in": sorted(set(kinds))}},
    ]
    if max_per_space:
        busy = saturated_spaces(store, now, max_per_space)
        if busy:
            conditions.append({"spaceId": {"$nin": busy}})
    until = format_ts(now + lease_ms)
    doc = store.jobs.find_one_and_update(
        {"$and": conditions},
        {
            "$set": {
                "status": JobStatus.RUNNING,
                "leaseOwner": worker_id,
                "leaseUntil": until,
                "startedAt": now_ts,
            },
            "$inc": {"attempt": 1},
        },
        sort=[("createdAt", 1), ("_id", 1)],
        return_document=ReturnDocument.AFTER,
    )
    if doc is None:
        return None
    try:
        owner = Owner.from_doc(doc)
        space_id = doc["spaceId"]
        if not isinstance(space_id, str):
            raise ValueError("spaceId 不是字符串")
    except (KeyError, ValueError) as error:
        # 记录本身不合法：不能确定系统范围，直接标记失败，不做任何处理。
        store.jobs.update_one(
            {"_id": doc["_id"], "leaseOwner": worker_id, "attempt": doc["attempt"]},
            {
                "$set": {"status": JobStatus.FAILED, "lastError": f"任务记录不合法：{error}"},
                "$unset": {"leaseUntil": ""},
            },
        )
        log.error("任务 %s 记录不合法：%s", doc["_id"], error)
        return None
    return Lease(
        job_id=doc["_id"],
        space_id=space_id,
        owner=owner,
        kind=doc["kind"],
        params=doc.get("params") or {},
        attempt=int(doc["attempt"]),
        max_attempts=int(doc.get("maxAttempts") or DEFAULT_MAX_ATTEMPTS),
        worker_id=worker_id,
        lease_until=until,
        doc=doc,
    )


def renew(store: Store, lease: Lease, lease_ms: int) -> str | None:
    """续约。成功返回新的到期时间；匹配不到（租约丢了）返回 None。"""
    until = format_ts(store.clock() + lease_ms)
    result = store.jobs.update_one(lease.fence(), {"$set": {"leaseUntil": until}})
    return until if result.matched_count == 1 else None


def _error_text(error: BaseException | str) -> str:
    text = error if isinstance(error, str) else f"{type(error).__name__}: {error}"
    return text[:MAX_ERROR_CHARS]


def mark_done(
    store: Store,
    lease: Lease,
    *,
    result_commit_id: str | None = None,
    result: Mapping[str, Any] | None = None,
    session: ClientSession | None = None,
) -> None:
    """按栅栏条件把任务标记为完成。写回提交时必须和插入提交放在同一个事务里（传 session）。

    匹配不到时抛 LeaseLost，调用方据此中止事务、丢弃结果。
    """
    update: dict[str, Any] = {
        "status": JobStatus.DONE,
        "finishedAt": format_ts(store.clock()),
    }
    if result_commit_id is not None:
        update["resultCommitId"] = result_commit_id
    if result:
        update["result"] = dict(result)
    outcome = store.jobs.update_one(
        lease.fence(), {"$set": update, "$unset": {"leaseUntil": ""}}, session=session
    )
    if outcome.matched_count != 1:
        raise LeaseLost(f"任务 {lease.job_id} 的租约已丢失，放弃写回")


def mark_failed(store: Store, lease: Lease, error: BaseException | str, *, retry: bool) -> str:
    """失败：可重试且次数未用完时退回队列，否则标记为失败。返回最终状态。租约已丢时什么也不做。"""
    text = _error_text(error)
    now_ts = format_ts(store.clock())
    if retry and not lease.is_last_attempt:
        status = JobStatus.QUEUED
        update = {
            "$set": {"status": status, "lastError": text, "lastErrorAt": now_ts},
            "$unset": {"leaseOwner": "", "leaseUntil": ""},
        }
    else:
        status = JobStatus.FAILED
        update = {
            "$set": {"status": status, "lastError": text, "lastErrorAt": now_ts, "finishedAt": now_ts},
            "$unset": {"leaseUntil": ""},
        }
    outcome = store.jobs.update_one(lease.fence(), update)
    if outcome.matched_count != 1:
        log.warning("任务 %s 结束时租约已丢失，状态由新的持有者决定", lease.job_id)
        return "lost"
    return status


def release(store: Store, lease: Lease) -> bool:
    """收到停止信号、来不及做完时主动释放租约：把到期时间设为现在，其他副本马上可以重做。"""
    outcome = store.jobs.update_one(lease.fence(), {"$set": {"leaseUntil": format_ts(store.clock() - 1)}})
    return outcome.matched_count == 1


def requeue(store: Store, lease: Lease) -> bool:
    """收到停止信号、来不及做完：退回队列，并退还这一次的重试次数（不是任务本身的问题）。

    条件带栅栏；匹配不到说明租约已经不属于本进程，什么也不做。
    """
    outcome = store.jobs.update_one(
        lease.fence(),
        {
            "$set": {"status": JobStatus.QUEUED},
            "$unset": {"leaseOwner": "", "leaseUntil": ""},
            "$inc": {"attempt": -1},
        },
    )
    return outcome.matched_count == 1


def reap_exhausted(store: Store) -> int:
    """租约过期且重试次数已用完的任务标记为失败（否则它们会一直停在 running）。"""
    now_ts = format_ts(store.clock())
    result = store.jobs.update_many(
        {
            "$and": [
                {
                    "$or": [
                        {"status": JobStatus.RUNNING, "leaseUntil": {"$lt": now_ts}},
                        {"status": JobStatus.QUEUED},
                    ]
                },
                _attempt_expr("$gte"),
            ]
        },
        {
            "$set": {
                "status": JobStatus.FAILED,
                "lastError": "重试次数已用完（最后一次租约过期）",
                "finishedAt": now_ts,
            },
            "$unset": {"leaseUntil": ""},
        },
    )
    if result.modified_count:
        log.warning("%d 个任务重试次数用完，标记为失败", result.modified_count)
    return result.modified_count
