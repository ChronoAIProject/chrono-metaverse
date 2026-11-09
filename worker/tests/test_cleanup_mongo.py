"""定期清理的集成测试：真实本地 MongoDB 副本集（`pytest -m mongo`）。

草稿和预览的文档结构照接口服务 `metaverse-api/src/repo/drafts.rs` 构造。
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from conftest import OWNER, SPACE, make_space, upload_asset
from metaverse_worker.assets import find_asset
from metaverse_worker.jobs.cleanup import cleanup_assets
from metaverse_worker.store import C, Store
from metaverse_worker.timeutil import format_ts

pytestmark = pytest.mark.mongo

DAY_MS = 24 * 3600 * 1000


def ts(store: Store, offset_ms: int) -> str:
    return format_ts(store.clock() + offset_ms)


def make_draft(
    store: Store,
    draft_id: str,
    *,
    expires_in_ms: int = 30 * DAY_MS,
    ops_refs: list[dict] | None = None,
    assets: list[str] | None = None,
    status: str = "open",
) -> None:
    """接口服务的草稿文档（`DraftDoc`）。"""
    now = ts(store, 0)
    store.col(C.DRAFTS).insert_one(
        {
            "_id": draft_id,
            "spaceId": SPACE,
            "owner": OWNER,
            "scope": "physical",
            "baseSeq": 0,
            "rev": 1,
            "createdBy": {"sub": "alice"},
            "status": status,
            "ops": [],
            "opsRefs": ops_refs or [],
            "touched": {},
            "resultChunks": [],
            "assets": assets or [],
            "createdAt": now,
            "updatedAt": now,
            "expiresAt": ts(store, expires_in_ms),
        }
    )


def age_assets(store: Store, *hashes: str) -> None:
    """把资源的上传时间改到很久以前（超过宽限期）。"""
    store.col(C.ASSET_FILES).update_many(
        {"filename": {"$in": list(hashes)}}, {"$set": {"uploadDate": datetime(2020, 1, 1, tzinfo=UTC)}}
    )


def test_assets_referenced_by_draft_ops_refs_survive(store):
    """经上传追加到草稿的操作文件记在 opsRefs[].assetHash：草稿还在就不能删。"""
    make_space(store)
    ops = upload_asset(store, b'{"op":"fill","box":[0,0,0,1,1,1]}\n', "ops", kind="ops")
    tex = upload_asset(store, b"draft texture bytes", "texture", kind="texture")
    lone = upload_asset(store, b'{"op":"nobody"}\n', "ops", kind="ops")
    age_assets(store, ops, tex, lone)
    make_draft(store, "d1", ops_refs=[{"assetHash": ops, "after": 0, "count": 1}], assets=[tex])
    assert cleanup_assets(store, 7) == 1
    assert find_asset(store, ops) is not None and find_asset(store, tex) is not None
    assert find_asset(store, lone) is None
    # 草稿没了（发布后操作文件由提交引用，丢弃后就没人要了）：宽限期已过，下一轮删除
    store.col(C.DRAFTS).delete_one({"_id": "d1"})
    assert cleanup_assets(store, 7) == 2
    assert find_asset(store, ops) is None and find_asset(store, tex) is None
