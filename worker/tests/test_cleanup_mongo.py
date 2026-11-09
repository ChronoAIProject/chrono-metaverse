"""定期清理的集成测试：真实本地 MongoDB 副本集（`pytest -m mongo`）。

草稿和预览的文档结构照接口服务 `metaverse-api/src/repo/drafts.rs` 构造。
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from conftest import OWNER, SPACE, make_space, upload_asset
from metaverse_worker.assets import find_asset
from metaverse_worker.jobs.cleanup import cleanup_assets, cleanup_drafts, run_cleanup
from metaverse_worker.store import C, Store
from metaverse_worker.timeutil import format_ts
from metaverse_worker.uploads import release_upload_storage

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


def test_deleted_asset_releases_counted_upload_storage(store):
    """没人引用的资源被删掉后，计过用量的上传各自减回；只减一次，用量不会变成负数。"""
    make_space(store)
    make_space(store, "other-space")
    content = b"unused upload bytes" * 10
    sha = upload_asset(store, content, "script", kind="script")
    age_assets(store, sha)
    size = len(content)
    for uid, space_id in (("u1", SPACE), ("u2", SPACE), ("u3", "other-space"), ("u4", SPACE)):
        store.uploads.insert_one(
            {
                "_id": uid,
                "spaceId": space_id,
                "owner": OWNER,
                "purpose": "script",
                "size": size,
                "sha256": sha,
                "status": "done",
                "assetHash": sha,
                "createdAt": ts(store, 0),
                # u4 是处理服务累加用量以前完成的上传，没有计过，也不减
                **({"storageBytes": size} if uid != "u4" else {}),
            }
        )
    store.spaces.update_one({"_id": SPACE}, {"$set": {"storageUsedBytes": 2 * size + 1000}})
    store.spaces.update_one({"_id": "other-space"}, {"$set": {"storageUsedBytes": size // 2}})
    assert cleanup_assets(store, 7) == 1 and find_asset(store, sha) is None
    assert store.spaces.find_one({"_id": SPACE})["storageUsedBytes"] == 1000
    assert store.spaces.find_one({"_id": "other-space"})["storageUsedBytes"] == 0  # 减到 0 为止
    released = {u["_id"] for u in store.uploads.find({"storageReleasedAt": {"$exists": True}})}
    assert released == {"u1", "u2", "u3"}
    # 再减一次什么也不做
    assert release_upload_storage(store, sha) == 0
    assert store.spaces.find_one({"_id": SPACE})["storageUsedBytes"] == 1000


def make_preview(store: Store, token_hash: str, draft_id: str, *, expires_in_ms: int) -> None:
    """接口服务的预览令牌记录（`_id` = 令牌的 sha256）。"""
    store.col(C.PREVIEWS).insert_one(
        {
            "_id": token_hash,
            "spaceId": SPACE,
            "owner": OWNER,
            "draftId": draft_id,
            "rev": 1,
            "createdBy": "alice",
            "createdAt": ts(store, 0),
            "expiresAt": ts(store, expires_in_ms),
        }
    )


def make_draft_chunk(store: Store, draft_id: str, chunk_hash: str, *, expires_in_ms: int) -> None:
    """接口服务的草稿区块（`_id` = `草稿编号:区块哈希`）。"""
    store.col(C.DRAFT_CHUNKS).insert_one(
        {
            "_id": f"{draft_id}:{chunk_hash}",
            "draftId": draft_id,
            "spaceId": SPACE,
            "owner": OWNER,
            "hash": chunk_hash,
            "data": b"x",
            "expiresAt": ts(store, expires_in_ms),
        }
    )


def ids(store: Store, collection: str) -> set[str]:
    return {d["_id"] for d in store.col(collection).find({}, {"_id": 1})}


def test_expired_drafts_previews_and_chunks_are_removed(store):
    make_space(store)
    make_draft(store, "old", expires_in_ms=-1000)
    make_draft(store, "old-published", expires_in_ms=-DAY_MS, status="published")
    make_draft(store, "fresh")
    make_draft_chunk(store, "old", "a" * 64, expires_in_ms=-1000)
    make_draft_chunk(store, "fresh", "a" * 64, expires_in_ms=30 * DAY_MS)
    make_draft_chunk(store, "gone", "b" * 64, expires_in_ms=-1)  # 草稿上一轮已删，区块没来得及删
    make_preview(store, "p-old", "old", expires_in_ms=DAY_MS)  # 令牌本身没过期，但草稿过期了
    make_preview(store, "p-fresh-expired", "fresh", expires_in_ms=-1)
    make_preview(store, "p-fresh", "fresh", expires_in_ms=DAY_MS)

    assert cleanup_drafts(store) == {"drafts": 2, "previews": 2, "draftChunks": 2}
    assert ids(store, C.DRAFTS) == {"fresh"}
    assert ids(store, C.PREVIEWS) == {"p-fresh"}
    assert ids(store, C.DRAFT_CHUNKS) == {f"fresh:{'a' * 64}"}
    # 再跑一次什么也不做；没过期的都留着
    assert cleanup_drafts(store) == {"drafts": 0, "previews": 0, "draftChunks": 0}
    assert ids(store, C.DRAFTS) == {"fresh"}


def test_assets_of_expired_drafts_are_released_in_the_same_round(store):
    make_space(store)
    kept = upload_asset(store, b"texture of an open draft", "texture", kind="texture")
    released = upload_asset(store, b'{"op":"abandoned"}\n', "ops", kind="ops")
    age_assets(store, kept, released)
    make_draft(store, "open", assets=[kept])
    make_draft(
        store, "abandoned", expires_in_ms=-1, ops_refs=[{"assetHash": released, "after": 0, "count": 1}]
    )
    result = run_cleanup(store, upload_ttl_hours=24, asset_grace_days=7)
    assert result == {
        "stuckUploads": 0,
        "uploads": 0,
        "drafts": 1,
        "previews": 0,
        "draftChunks": 0,
        "assets": 1,
        "publishedChunks": 0,
    }
    assert find_asset(store, kept) is not None and find_asset(store, released) is None
