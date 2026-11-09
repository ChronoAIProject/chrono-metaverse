"""数据访问：MongoDB 连接、集合名、索引、系统范围。

- 集合名与接口服务 `metaverse-api/src/repo/mod.rs` 相同（设计 13.2）；
- 处理服务启动时幂等地建它依赖的索引，名字和定义与接口服务完全一致，两边谁先建都可以；
- 后台任务使用显式的"系统范围"（设计 9.4）：`SystemScope` 只能由领取到的任务构造，
  带空间编号和主人，所有子集合的读写条件都带上这两项（与接口服务的授权凭据同一用法）。

`jobs/`、`assets.py`、`uploads.py`、`processing/` 以外的业务代码不直接拼查询条件，统一经这里的函数。
事务统一经 `run_transaction`，空间存储用量统一经 `add_storage_used`。
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from bson.int64 import Int64
from pymongo import ASCENDING, IndexModel, MongoClient, ReadPreference
from pymongo.client_session import ClientSession
from pymongo.collection import Collection
from pymongo.database import Database
from pymongo.errors import BulkWriteError, DuplicateKeyError, OperationFailure
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from .config import Config
from .timeutil import Clock, system_clock

log = logging.getLogger(__name__)


class C:
    """集合名（设计 13.2）。"""

    SPACES = "spaces"
    COMMITS = "commits"
    CHUNKS = "chunks"
    RECORDS = "records"
    PALETTES = "palettes"
    ENTITIES = "entities"
    ANCHORS = "anchors"
    ASSET_REFS = "assetRefs"
    DRAFTS = "drafts"
    DRAFT_CHUNKS = "draftChunks"
    PREVIEWS = "previews"
    UPLOADS = "uploads"
    JOBS = "jobs"
    ASSET_BUCKET = "assets"
    ASSET_FILES = "assets.files"
    ASSET_CHUNKS = "assets.chunks"


class JobStatus:
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class UploadStatus:
    """上传会话的状态（与接口服务约定，见 README）。"""

    OPEN = "open"  # 接收分片中
    COMPLETE = "complete"  # 调用方已"完成上传"，校验任务排队中
    DONE = "done"  # 校验通过，已登记成资源（assetHash）
    FAILED = "failed"  # 校验失败，分片已删除
    EXPIRED = "expired"  # 超过 24 小时没完成，清理中


@dataclass(frozen=True)
class Owner:
    kind: str  # person | org
    id: str

    @classmethod
    def from_doc(cls, doc: Mapping[str, Any]) -> Owner:
        owner = doc.get("owner") or {}
        kind, oid = owner.get("kind"), owner.get("id")
        if kind not in ("person", "org") or not isinstance(oid, str) or not oid:
            raise ValueError("记录缺少合法的 owner")
        return cls(kind, oid)

    def as_doc(self) -> dict[str, str]:
        return {"kind": self.kind, "id": self.id}


def space_filter(space_id: Any, owner: Owner, record_created_at: Any = None) -> dict[str, Any]:
    """`spaces` 文档的条件：`{_id, owner.kind, owner.id}`，主人变了就匹配不到。

    空间编号在删除后可以被同一个主人重新使用（接口服务删除空间时不清理任务和上传）。任务、上传都是在某个
    空间"实例"里建的：给了记录的创建时间 `record_created_at`（RFC 3339 字符串，固定格式，字符串比较就是
    时间比较）时，再要求空间的 `createdAt` 不晚于它。空间的 `createdAt` 更晚，说明记录建好之后空间被删除、
    又用同一个编号重建了，那是另一个空间，旧任务不能写进它的时间线，旧上传也不能改它的存储用量。
    没有 `createdAt` 的空间（旧数据）不做这项比较。
    """
    filt: dict[str, Any] = {"_id": space_id, "owner.kind": owner.kind, "owner.id": owner.id}
    if isinstance(record_created_at, str) and record_created_at:
        filt["createdAt"] = {"$not": {"$gt": record_created_at}}
    return filt


@dataclass(frozen=True)
class SystemScope:
    """后台任务的"系统范围"：某个空间、某个主人，附带产生它的任务编号（审计用）和任务的创建时间。"""

    space_id: str
    owner: Owner
    job_id: str
    created_at: str | None = None  # 任务记录的 createdAt：只认这之前建的空间实例（见 `space_filter`）

    def space_filter(self) -> dict[str, Any]:
        """`spaces` 文档的条件：主人变了、或空间在任务创建之后被删除重建，都匹配不到。"""
        return space_filter(self.space_id, self.owner, self.created_at)

    def child_filter(self, **extra: Any) -> dict[str, Any]:
        """子集合：`{spaceId, owner.kind, owner.id, ...}`。"""
        return {"spaceId": self.space_id, "owner.kind": self.owner.kind, "owner.id": self.owner.id, **extra}


def is_duplicate_key(error: BaseException) -> bool:
    if isinstance(error, DuplicateKeyError):
        return True
    if isinstance(error, BulkWriteError):
        return any(e.get("code") == 11000 for e in error.details.get("writeErrors", []))
    if isinstance(error, OperationFailure):
        return error.code == 11000
    return False


class Store:
    """MongoDB 连接和处理服务用到的集合。"""

    def __init__(self, client: MongoClient, database: str, clock: Clock = system_clock) -> None:
        self.client = client
        self.db: Database = client[database]
        self.clock = clock

    @classmethod
    def connect(cls, config: Config, clock: Clock = system_clock) -> Store:
        # 超时都设上限：数据库不可用时调用很快失败（不会一直挂着，看门狗才有意义）。
        client: MongoClient = MongoClient(
            config.mongodb_uri,
            appname="chrono-metaverse-worker",
            serverSelectionTimeoutMS=10_000,
            connectTimeoutMS=10_000,
            socketTimeoutMS=60_000,
            tz_aware=True,
        )
        return cls(client, config.mongodb_database, clock)

    def col(self, name: str) -> Collection:
        return self.db[name]

    @property
    def jobs(self) -> Collection:
        return self.db[C.JOBS]

    @property
    def commits(self) -> Collection:
        return self.db[C.COMMITS]

    @property
    def spaces(self) -> Collection:
        return self.db[C.SPACES]

    @property
    def uploads(self) -> Collection:
        return self.db[C.UPLOADS]

    def ping(self) -> None:
        self.db.command("ping")

    def run_transaction(self, callback: Callable[[ClientSession], Any]) -> Any:
        """在一个事务里执行 `callback(session)`（快照读、多数派写）。

        写冲突等临时错误由驱动自动重试整个回调；回调抛出的其他异常中止事务、原样抛出。
        """
        with self.client.start_session() as session:
            return session.with_transaction(
                callback,
                read_concern=ReadConcern("snapshot"),
                write_concern=WriteConcern("majority"),
                read_preference=ReadPreference.PRIMARY,
            )

    def add_storage_used(
        self, space_filter: Mapping[str, Any], delta: int, session: ClientSession | None = None
    ) -> None:
        """空间的 `storageUsedBytes` 加上 `delta`（可以是负数，减到 0 为止）。

        接口服务按 u64 读这个字段，所以不能写成负数；字段不存在时按 0 算。条件带主人（`space_filter`）。
        """
        if delta == 0:
            return
        if delta > 0:
            update: Any = {"$inc": {"storageUsedBytes": Int64(delta)}}
        else:
            used = {"$ifNull": ["$storageUsedBytes", Int64(0)]}
            update = [{"$set": {"storageUsedBytes": {"$max": [Int64(0), {"$add": [used, Int64(delta)]}]}}}]
        self.spaces.update_one(dict(space_filter), update, session=session)

    def ensure_indexes(self) -> None:
        """幂等地建处理服务依赖的索引。名字和定义与接口服务相同，多副本、两种服务同时执行都安全。"""

        def named(keys, name, **kw):
            return IndexModel(keys, name=name, **kw)

        plan: dict[str, list[IndexModel]] = {
            C.COMMITS: [
                named([("spaceId", ASCENDING), ("seq", ASCENDING)], "space_seq", unique=True),
                named([("spaceId", ASCENDING), ("at", ASCENDING)], "space_at"),
                named(
                    [("jobId", ASCENDING)],
                    "job_unique",
                    unique=True,
                    partialFilterExpression={"jobId": {"$type": "string"}},
                ),
            ],
            C.CHUNKS: [named([("publishedAt", ASCENDING)], "published_at")],
            C.RECORDS: [named([("spaceId", ASCENDING), ("kind", ASCENDING)], "space_kind")],
            C.ENTITIES: [named([("spaceId", ASCENDING), ("id", ASCENDING)], "space_id", unique=True)],
            C.ANCHORS: [named([("spaceId", ASCENDING), ("id", ASCENDING)], "space_id", unique=True)],
            C.ASSET_REFS: [named([("hash", ASCENDING), ("spaceId", ASCENDING)], "hash_space", unique=True)],
            # 草稿、草稿区块、预览令牌：定期清理按 expiresAt 删除过期的（与接口服务的定义相同）
            C.DRAFTS: [
                named([("spaceId", ASCENDING)], "space"),
                named([("expiresAt", ASCENDING)], "expires_at"),
            ],
            C.DRAFT_CHUNKS: [
                named([("draftId", ASCENDING)], "draft"),
                named([("expiresAt", ASCENDING)], "expires_at"),
            ],
            C.PREVIEWS: [
                named([("spaceId", ASCENDING)], "space"),
                named([("expiresAt", ASCENDING)], "expires_at"),
            ],
            C.UPLOADS: [
                named([("spaceId", ASCENDING)], "space"),
                named([("createdAt", ASCENDING)], "created_at"),
            ],
            C.JOBS: [
                named([("status", ASCENDING), ("createdAt", ASCENDING)], "status_created"),
                named([("status", ASCENDING), ("leaseUntil", ASCENDING)], "status_lease"),
                named([("spaceId", ASCENDING), ("status", ASCENDING)], "space_status"),
            ],
            C.ASSET_FILES: [named([("filename", ASCENDING)], "filename", unique=True)],
            C.ASSET_CHUNKS: [named([("files_id", ASCENDING), ("n", ASCENDING)], "files_id_n", unique=True)],
        }
        for name, indexes in plan.items():
            self.db[name].create_indexes(indexes)

    def drop_database(self) -> None:
        """删除整个数据库。只给测试用。"""
        self.client.drop_database(self.db.name)
