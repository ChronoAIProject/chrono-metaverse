"""数据访问：MongoDB 连接、集合名、索引、系统范围。

- 集合名与接口服务 `metaverse-api/src/repo/mod.rs` 相同（设计 13.2）；
- 处理服务启动时幂等地建它依赖的索引，名字和定义与接口服务完全一致，两边谁先建都可以；
- 后台任务使用显式的"系统范围"（设计 9.4）：`SystemScope` 只能由领取到的任务构造，
  带空间编号和主人，所有子集合的读写条件都带上这两项（与接口服务的授权凭据同一用法）。

`jobs/`、`assets.py`、`processing/` 以外的业务代码不直接拼查询条件，统一经这里的函数。
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from pymongo import ASCENDING, IndexModel, MongoClient
from pymongo.collection import Collection
from pymongo.database import Database
from pymongo.errors import BulkWriteError, DuplicateKeyError, OperationFailure

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


@dataclass(frozen=True)
class SystemScope:
    """后台任务的"系统范围"：某个空间、某个主人，附带产生它的任务编号（审计用）。"""

    space_id: str
    owner: Owner
    job_id: str

    def space_filter(self) -> dict[str, Any]:
        """`spaces` 文档：`{_id, owner.kind, owner.id}`，主人变了就匹配不到。"""
        return {"_id": self.space_id, "owner.kind": self.owner.kind, "owner.id": self.owner.id}

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
