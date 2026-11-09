"""写回：把任务结果写成一次提交（设计 5.2、5.7、6.4）。

**事务外**（按内容哈希幂等写入，重复键直接忽略；失败只留下无人引用的对象）：
区块 `chunks`、物件记录 `records`、方块表 `palettes`、GridFS 资源。

**事务内**（`write_back`，与接口服务的提交事务同一套规则）：
1. 读空间（条件带主人，系统范围）；
2. 由 `build(session, space)` 按事务内看到的最新状态算出本次变化（旧区块写 null、旧物件删除等）；
3. 插入提交：`seq = head.seq + 1`，`at = max(当前时间, head.at)`，带 `jobId`（`commits.jobId` 部分唯一索引）；
4. 按 `head.seq == 旧值` 条件推进 `spaces.head`（首次导入扫描时同时固定坐标系 `frame`）；
5. 更新物件当前状态 `entities`、登记资源引用 `assetRefs`；
6. **`mark_done`**：按 `{_id, attempt, leaseOwner, status: running}` 把任务标记为完成并写入 `resultCommitId`。

第 6 步匹配不到（租约已丢）或 jobId 唯一键冲突时，中止事务、丢弃结果。并发提交造成的写冲突由驱动的
`with_transaction` 自动重试（重新执行 `build`）。接口服务以后自己写回任务结果时，照搬这里的顺序和条件。

**事务后**：给本次新引用的区块打上 `publishedAt`（幂等，失败可以补做）。
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from bson import Binary
from pymongo import ReadPreference
from pymongo.client_session import ClientSession
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from ..canonical import content_hash
from ..errors import PermanentJobError
from ..records import record_hash
from ..store import C, Store, SystemScope, is_duplicate_key
from ..timeutil import format_ts, parse_ts
from .lease import Lease, LeaseLost, mark_done

log = logging.getLogger(__name__)


class AlreadyCommitted(LeaseLost):
    """这个任务的结果已经写过一次提交（jobId 唯一键冲突）。"""


@dataclass
class CommitPlan:
    """一次提交要写的内容。`entity_bodies` 给出 `changed_entities` 里非 null 项的 body（用于当前状态）。"""

    message: str
    changed_chunks: list[dict[str, Any]] = field(default_factory=list)
    changed_entities: list[dict[str, Any]] = field(default_factory=list)
    changed_anchors: list[dict[str, Any]] = field(default_factory=list)
    entity_bodies: dict[str, Mapping[str, Any]] = field(default_factory=dict)
    anchor_bodies: dict[str, Mapping[str, Any]] = field(default_factory=dict)
    palette_hash: str | None = None
    scan: dict[str, Any] | None = None
    observed_at: str | None = None
    asset_refs: list[str] = field(default_factory=list)
    reference_scan: str | None = None  # 空间还没有坐标系时，以这次扫描固定坐标系（设计 4.1）
    result: dict[str, Any] = field(default_factory=dict)
    # 和提交同一个事务里插入的后续任务（例如扫描导入之后的体素化），编号要确定，重做不会重复
    new_jobs: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class CommitResult:
    commit_id: str
    seq: int
    at: str


def job_actor(lease: Lease) -> dict[str, Any]:
    """提交的发布者：由任务产生（kind = job），sub 和服务编号取发起任务的调用者（任务记录里的 actor）。"""
    requested = lease.doc.get("actor") or {}
    return {
        "sub": str(requested.get("sub") or "system"),
        "nyxServiceId": str(requested.get("nyxServiceId") or ""),
        "scope": "physical",
        "kind": "job",
    }


# ---------------------------------------------------------------------------- 事务外的幂等写入


def _insert_ignore_duplicates(store: Store, collection: str, docs: list[dict[str, Any]]) -> None:
    if not docs:
        return
    try:
        store.col(collection).insert_many(docs, ordered=False)
    except Exception as error:
        if not is_duplicate_key(error):
            raise
        # 只有重复键错误可以忽略
        details = getattr(error, "details", {}) or {}
        others = [e for e in details.get("writeErrors", []) if e.get("code") != 11000]
        if others:
            raise


def put_chunks(store: Store, chunks: Mapping[str, bytes]) -> None:
    """区块：`{_id: 区块哈希, data: zlib 压缩的规范字节, format: 1}`。"""
    now_ts = format_ts(store.clock())
    _insert_ignore_duplicates(
        store,
        C.CHUNKS,
        [{"_id": h, "data": Binary(z), "format": 1, "createdAt": now_ts} for h, z in chunks.items()],
    )


def put_anchor_records(
    store: Store, scope: SystemScope, bodies: Mapping[str, Mapping[str, Any]]
) -> dict[str, str]:
    """锚点记录：`records {_id: 内容哈希, kind: anchor, spaceId, owner, body}`。返回 `{anchorId: 哈希}`。"""
    out: dict[str, str] = {}
    docs = []
    for anchor_id, body in bodies.items():
        h = record_hash("anchor", scope.space_id, body)
        out[anchor_id] = h
        docs.append(
            {
                "_id": h,
                "kind": "anchor",
                "spaceId": scope.space_id,
                "owner": scope.owner.as_doc(),
                "body": dict(body),
            }
        )
    _insert_ignore_duplicates(store, C.RECORDS, docs)
    return out


def put_entity_records(
    store: Store, scope: SystemScope, bodies: Mapping[str, Mapping[str, Any]]
) -> dict[str, str]:
    """物件记录：`records {_id: 内容哈希, kind: entity, spaceId, owner, body}`。返回 `{entityId: 哈希}`。"""
    out: dict[str, str] = {}
    docs = []
    for entity_id, body in bodies.items():
        h = record_hash("entity", scope.space_id, body)
        out[entity_id] = h
        docs.append(
            {
                "_id": h,
                "kind": "entity",
                "spaceId": scope.space_id,
                "owner": scope.owner.as_doc(),
                "body": dict(body),
            }
        )
    _insert_ignore_duplicates(store, C.RECORDS, docs)
    return out


def palette_hash(space_id: str, blocks: list[dict[str, Any]]) -> str:
    return content_hash({"blocks": blocks, "spaceId": space_id})


def put_palette(store: Store, scope: SystemScope, blocks: list[dict[str, Any]]) -> str:
    """方块表：`palettes {_id: 内容哈希, spaceId, owner, blocks}`。"""
    h = palette_hash(scope.space_id, blocks)
    _insert_ignore_duplicates(
        store,
        C.PALETTES,
        [{"_id": h, "spaceId": scope.space_id, "owner": scope.owner.as_doc(), "blocks": blocks}],
    )
    return h


# ---------------------------------------------------------------------------- 事务内读取当前状态


def head_palette_doc(
    store: Store, scope: SystemScope, session: ClientSession | None = None
) -> tuple[str | None, list[dict[str, Any]]]:
    """head 生效的方块表 (哈希, 方块列表)；还没有方块表时返回 (None, [])。"""
    commit = store.commits.find_one(
        scope.child_filter(paletteHash={"$type": "string"}),
        {"paletteHash": 1},
        sort=[("seq", -1)],
        session=session,
    )
    if commit is None:
        return None, []
    doc = store.col(C.PALETTES).find_one(
        {"_id": commit["paletteHash"], "spaceId": scope.space_id}, session=session
    )
    if doc is None:
        raise PermanentJobError(f"方块表 {commit['paletteHash']} 不存在")
    return commit["paletteHash"], list(doc.get("blocks") or [])


def head_palette(
    store: Store, scope: SystemScope, session: ClientSession | None = None
) -> list[dict[str, Any]]:
    """head 生效的方块表（最近一次带 paletteHash 的提交）。没有时返回空表。"""
    commit = store.commits.find_one(
        scope.child_filter(paletteHash={"$type": "string"}),
        {"paletteHash": 1},
        sort=[("seq", -1)],
        session=session,
    )
    if commit is None:
        return []
    doc = store.col(C.PALETTES).find_one(
        {"_id": commit["paletteHash"], "spaceId": scope.space_id}, session=session
    )
    if doc is None:
        raise PermanentJobError(f"方块表 {commit['paletteHash']} 不存在")
    return list(doc.get("blocks") or [])


def head_scan(
    store: Store, scope: SystemScope, session: ClientSession | None = None
) -> dict[str, Any] | None:
    """head 生效的扫描（最近一次带 scan 的提交）。"""
    commit = store.commits.find_one(
        scope.child_filter(scan={"$type": "object"}), {"scan": 1}, sort=[("seq", -1)], session=session
    )
    return None if commit is None else dict(commit["scan"])


def current_chunks(
    store: Store, scope: SystemScope, layer: str, session: ClientSession | None = None
) -> dict[tuple[int, int, int], str]:
    """某一层在 head 的区块清单 `{(cx, cy, cz): 哈希}`：按 seq 顺序叠加各次提交的 changedChunks。"""
    state: dict[tuple[int, int, int], str] = {}
    cursor = store.commits.find(
        scope.child_filter(**{"changedChunks.layer": layer}),
        {"changedChunks": 1, "seq": 1},
        sort=[("seq", 1)],
        session=session,
    )
    for commit in cursor:
        for change in commit.get("changedChunks") or []:
            if change.get("layer") != layer:
                continue
            key = (int(change["cx"]), int(change["cy"]), int(change["cz"]))
            if change.get("hash"):
                state[key] = change["hash"]
            else:
                state.pop(key, None)
    return state


def scan_commit(
    store: Store, scope: SystemScope, asset_hash: str | None = None, session: ClientSession | None = None
) -> dict[str, Any] | None:
    """最近一次带扫描的提交；给了 `asset_hash` 就找引用这个扫描的最近一次提交。"""
    filt = scope.child_filter(scan={"$type": "object"})
    if asset_hash is not None:
        filt["scan.assetHash"] = asset_hash
    return store.commits.find_one(filt, {"scan": 1, "seq": 1}, sort=[("seq", -1)], session=session)


def current_anchor_ids(
    store: Store, scope: SystemScope, session: ClientSession | None = None
) -> dict[str, str]:
    """当前状态里的锚点 `{id: 记录哈希}`。"""
    cursor = store.col(C.ANCHORS).find(scope.child_filter(), {"id": 1, "hash": 1}, session=session)
    return {d["id"]: d["hash"] for d in cursor}


def current_entity_ids(
    store: Store,
    scope: SystemScope,
    *,
    layer: str,
    kind: str | None = None,
    session: ClientSession | None = None,
) -> dict[str, str]:
    """当前状态里某一层（可再按物件类型筛选）的物件 `{id: 记录哈希}`。"""
    filt = scope.child_filter(**{"body.layer": layer})
    if kind is not None:
        filt["body.kind"] = kind
    return {
        d["id"]: d["hash"] for d in store.col(C.ENTITIES).find(filt, {"id": 1, "hash": 1}, session=session)
    }


def diff_ids(old: Mapping[str, str], new: Mapping[str, str]) -> list[dict[str, Any]]:
    """新旧 `{id: 哈希}` 的差异：新增、变化写新哈希，消失的写 null；不变的不写。"""
    out = [{"id": i, "hash": h} for i, h in sorted(new.items()) if old.get(i) != h]
    out += [{"id": i, "hash": None} for i in sorted(set(old) - set(new))]
    return out


def diff_chunks(
    layer: str, old: Mapping[tuple[int, int, int], str], new: Mapping[tuple[int, int, int], str]
) -> list[dict[str, Any]]:
    """重新生成方块时，旧清单里有、新结果里没有的区块必须写 null（设计 4.2）。"""
    out = [
        {"layer": layer, "cx": k[0], "cy": k[1], "cz": k[2], "hash": h}
        for k, h in sorted(new.items())
        if old.get(k) != h
    ]
    out += [
        {"layer": layer, "cx": k[0], "cy": k[1], "cz": k[2], "hash": None}
        for k in sorted(set(old) - set(new))
    ]
    return out


# ---------------------------------------------------------------------------- 写回事务


def finish_if_committed(store: Store, lease: Lease) -> str | None:
    """领取后先查：已经有带这个 jobId 的提交，就直接把任务标记为完成，不再重做（设计 6.4）。"""
    existing = store.commits.find_one({"jobId": str(lease.job_id)}, {"_id": 1})
    if existing is None:
        return None
    mark_done(store, lease, result_commit_id=existing["_id"])
    return existing["_id"]


def write_back(
    store: Store,
    lease: Lease,
    build: CommitPlan | Callable[[ClientSession, Mapping[str, Any]], CommitPlan],
    *,
    commit_id: str | None = None,
) -> CommitResult:
    """在一个事务里插入提交、推进空间指针、更新当前状态、登记资源引用、按栅栏完成任务。"""
    scope = lease.scope
    commit_id = commit_id or uuid.uuid4().hex
    outcome: dict[str, Any] = {}

    def callback(session: ClientSession) -> None:
        space = store.spaces.find_one(scope.space_filter(), session=session)
        if space is None:
            raise PermanentJobError(f"空间 {scope.space_id} 不存在，或主人与任务记录不一致")
        plan = build(session, space) if callable(build) else build
        head = space.get("head") or {}
        head_seq = int(head.get("seq") or 0)
        now_ms = store.clock()
        head_at = head.get("at")
        at_ms = max(now_ms, parse_ts(head_at)) if head_at else now_ms
        at = format_ts(at_ms)
        seq = head_seq + 1
        commit: dict[str, Any] = {
            "_id": commit_id,
            "spaceId": scope.space_id,
            "owner": scope.owner.as_doc(),
            "seq": seq,
            "at": at,
            "actor": job_actor(lease),
            "message": plan.message,
            "changedChunks": plan.changed_chunks,
            "changedEntities": plan.changed_entities,
            "changedAnchors": plan.changed_anchors,
            "jobId": str(lease.job_id),
        }
        if plan.observed_at:
            commit["observedAt"] = plan.observed_at
        if plan.palette_hash:
            commit["paletteHash"] = plan.palette_hash
        if plan.scan is not None:
            commit["scan"] = plan.scan
        try:
            store.commits.insert_one(commit, session=session)
        except Exception as error:
            if is_duplicate_key(error):
                raise AlreadyCommitted(f"任务 {lease.job_id} 已经写过提交，或 seq 冲突") from error
            raise
        head_filter = dict(scope.space_filter())
        head_filter["head.seq"] = head_seq if "seq" in head else {"$in": [0, None]}
        space_set: dict[str, Any] = {"head": {"seq": seq, "at": at, "commitId": commit_id}, "updatedAt": at}
        if plan.reference_scan and not space.get("frame"):
            space_set["frame"] = {"fixedAt": at, "referenceScan": plan.reference_scan}
        moved = store.spaces.update_one(head_filter, {"$set": space_set}, session=session)
        if moved.matched_count != 1:
            raise LeaseLost("空间的 head 在事务中变了")  # 快照事务里不应发生；保守起见放弃
        for collection, changes, bodies in (
            (C.ENTITIES, plan.changed_entities, plan.entity_bodies),
            (C.ANCHORS, plan.changed_anchors, plan.anchor_bodies),
        ):
            for change in changes:
                key = {"spaceId": scope.space_id, "id": change["id"]}
                if change["hash"] is None:
                    store.col(collection).delete_one({**key, "owner.id": scope.owner.id}, session=session)
                    continue
                store.col(collection).replace_one(
                    key,
                    {
                        **key,
                        "owner": scope.owner.as_doc(),
                        "hash": change["hash"],
                        "body": dict(bodies[change["id"]]),
                        "seq": seq,
                    },
                    upsert=True,
                    session=session,
                )
        for job in plan.new_jobs:
            store.jobs.insert_one(
                {
                    "spaceId": scope.space_id,
                    "owner": scope.owner.as_doc(),
                    "status": "queued",
                    "attempt": 0,
                    "maxAttempts": 3,
                    "createdAt": at,
                    "actor": dict(lease.doc.get("actor") or {}),
                    "parentJobId": str(lease.job_id),
                    **job,
                },
                session=session,
            )
        for asset_hash in sorted(set(plan.asset_refs)):
            store.col(C.ASSET_REFS).update_one(
                {"hash": asset_hash, "spaceId": scope.space_id},
                {"$setOnInsert": {"owner": scope.owner.as_doc(), "createdAt": at, "commitId": commit_id}},
                upsert=True,
                session=session,
            )
        mark_done(store, lease, result_commit_id=commit_id, result=plan.result or None, session=session)
        outcome.update(seq=seq, at=at, chunks=[c["hash"] for c in plan.changed_chunks if c.get("hash")])

    with store.client.start_session() as session:
        session.with_transaction(
            callback,
            read_concern=ReadConcern("snapshot"),
            write_concern=WriteConcern("majority"),
            read_preference=ReadPreference.PRIMARY,
        )
    publish_chunks(store, outcome["chunks"], outcome["at"])
    log.info("任务 %s 写回提交 %s（seq %s）", lease.job_id, commit_id, outcome["seq"])
    return CommitResult(commit_id, outcome["seq"], outcome["at"])


def publish_chunks(store: Store, hashes: Iterable[str], at: str) -> None:
    hashes = sorted(set(hashes))
    if hashes:
        store.col(C.CHUNKS).update_many(
            {"_id": {"$in": hashes}, "publishedAt": {"$exists": False}}, {"$set": {"publishedAt": at}}
        )
