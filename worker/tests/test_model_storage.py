"""物件模型导出的存储用量（设计 4.1、6.1）：处理后的模型单独计入发起任务的空间，被清理时成对减回。

以前只计原始上传：原始上传过了宽限期没人引用就被清理、用量减回，而处理后的模型被提交永久引用、从没计入，
空间用量最后变成 0，存储上限挡不住。
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime

import pytest

from conftest import OWNER, SPACE, make_job, make_space, make_upload
from metaverse_worker.assets import find_asset
from metaverse_worker.handlers import scan as scan_handlers
from metaverse_worker.jobs.cleanup import cleanup_assets
from metaverse_worker.jobs.lease import claim
from metaverse_worker.runner import Runner
from metaverse_worker.store import C, Store
from metaverse_worker.timeutil import now_ts
from metaverse_worker.uploads import release_model_storage
from test_voxelize_rebuild import dense_box_glb

pytestmark = pytest.mark.mongo


@pytest.fixture
def runner(store, db_config, monkeypatch):
    monkeypatch.setattr(scan_handlers, "OBJECTS_TARGET", "fake_objects:reconstruct_objects")
    make_space(store)
    return Runner(db_config, store, isolate=False, on_stall=lambda: None)


def used(store: Store) -> int:
    return store.spaces.find_one({"_id": SPACE})["storageUsedBytes"]


def run(runner, store, kind: str, params: dict) -> dict:
    jid = make_job(store, kind, params)
    assert runner.run_once() is True
    return store.jobs.find_one({"_id": jid})


def age_all_assets(store: Store) -> None:
    store.col(C.ASSET_FILES).update_many({}, {"$set": {"uploadDate": datetime(2020, 1, 1, tzinfo=UTC)}})


def publish_placement(store: Store, model_hash: str) -> None:
    """照接口服务发布草稿的写法引用处理后的模型：物件记录 + assetRefs（$setOnInsert，不动用量）。"""
    at = now_ts(store.clock)
    store.col(C.RECORDS).insert_one(
        {
            "_id": "placed-record",
            "kind": "entity",
            "spaceId": SPACE,
            "owner": OWNER,
            "body": {"layer": "extended", "kind": "object", "assetHash": model_hash},
        }
    )
    store.col(C.ASSET_REFS).update_one(
        {"hash": model_hash, "spaceId": SPACE},
        {"$setOnInsert": {"owner": OWNER, "createdAt": at, "commitId": "published"}},
        upsert=True,
    )


def test_processed_model_is_counted_and_survives_source_cleanup(runner, store):
    source = dense_box_glb()
    uid = make_upload(store, source, "model")
    assert run(runner, store, "upload_verify", {"uploadId": uid})["status"] == "done"
    source_hash = hashlib.sha256(source).hexdigest()
    assert used(store) == len(source)

    doc = run(runner, store, "model_import", {"assetHash": source_hash})
    assert doc["status"] == "done", doc.get("lastError")
    model_hash = doc["result"]["modelHash"]
    model_bytes = find_asset(store, model_hash)["length"]
    assert doc["storageBytes"] == model_bytes
    assert used(store) == len(source) + model_bytes

    # 放物件发布后，原始上传过了宽限期没人引用被清理：减回原始上传，处理后的模型仍然计着
    publish_placement(store, model_hash)
    age_all_assets(store)
    assert cleanup_assets(store, 7) == 1
    assert find_asset(store, source_hash) is None and find_asset(store, model_hash) is not None
    assert used(store) == model_bytes
    assert "storageReleasedAt" not in store.jobs.find_one({"_id": doc["_id"]})


def test_unreferenced_processed_model_is_released_once(runner, store):
    source = dense_box_glb()
    uid = make_upload(store, source, "model")
    assert run(runner, store, "upload_verify", {"uploadId": uid})["status"] == "done"
    source_hash = hashlib.sha256(source).hexdigest()
    doc = run(runner, store, "model_import", {"assetHash": source_hash})
    model_hash = doc["result"]["modelHash"]
    # 没人放这个物件：宽限期过后原始上传和处理后的模型都被清理，两份用量都减回
    age_all_assets(store)
    assert cleanup_assets(store, 7) == 2
    assert find_asset(store, model_hash) is None
    assert used(store) == 0
    assert "storageReleasedAt" in store.jobs.find_one({"_id": doc["_id"]})
    assert release_model_storage(store, model_hash) == 0  # 只减一次


def test_model_import_lease_lost_does_not_count(runner, store):
    """收尾时租约已丢：任务完成和计入用量在同一个事务里，一起放弃；新的持有者只计一次。"""
    uid = make_upload(store, dense_box_glb(), "model")
    assert run(runner, store, "upload_verify", {"uploadId": uid})["status"] == "done"
    before = used(store)
    jid = make_job(store, "model_import", {"assetHash": hashlib.sha256(dense_box_glb()).hexdigest()})
    lease = claim(store, "worker-a", ["model_import"], 60_000)
    store.jobs.update_one({"_id": jid}, {"$set": {"leaseOwner": "worker-b"}})
    assert runner.process(lease) == "lost"
    assert used(store) == before and "storageBytes" not in store.jobs.find_one({"_id": jid})
    store.jobs.update_one({"_id": jid}, {"$set": {"status": "queued"}, "$unset": {"leaseOwner": ""}})
    assert runner.run_once() is True
    doc = store.jobs.find_one({"_id": jid})
    assert doc["status"] == "done"
    assert used(store) == before + find_asset(store, doc["result"]["modelHash"])["length"]
