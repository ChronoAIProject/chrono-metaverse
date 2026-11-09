"""同一个编号的空间被删除后又重建：旧任务、旧上传属于旧的空间实例，不能写进新空间的时间线，也不能改新空间的
存储用量（接口服务删除空间时不清理任务和上传；空间编号可以重新使用）。"""

from __future__ import annotations

import hashlib

import pytest

from conftest import OWNER, SPACE, make_job, make_space, make_upload, scan_zip, upload_asset
from metaverse_worker.assets import find_asset, put_asset
from metaverse_worker.errors import SpaceGone
from metaverse_worker.handlers import scan as scan_handlers
from metaverse_worker.jobs.lease import claim
from metaverse_worker.jobs.writeback import CommitPlan, write_back
from metaverse_worker.runner import Runner
from metaverse_worker.store import C, Owner, Store, SystemScope
from metaverse_worker.timeutil import format_ts
from metaverse_worker.uploads import release_upload_storage, settle_upload
from synthetic import room_mesh
from test_voxelize_rebuild import dense_box_glb

pytestmark = pytest.mark.mongo

# 接口服务 repo/space_admin.rs 的 delete_space 删除的子集合（不含 jobs、uploads）
API_DELETED_CHILDREN = (
    C.COMMITS,
    C.ENTITIES,
    C.ANCHORS,
    C.RECORDS,
    C.PALETTES,
    C.ASSET_REFS,
    C.DRAFTS,
    C.DRAFT_CHUNKS,
    C.PREVIEWS,
)
MINUTE_MS = 60_000


@pytest.fixture
def runner(store, db_config, monkeypatch):
    monkeypatch.setattr(scan_handlers, "OBJECTS_TARGET", "fake_objects:reconstruct_objects")
    make_space(store)
    return Runner(db_config, store, isolate=False, on_stall=lambda: None)


def age(store: Store, collection: str, record_id) -> None:
    """记录是一分钟以前、在旧的空间实例里建的。"""
    store.col(collection).update_one(
        {"_id": record_id}, {"$set": {"createdAt": format_ts(store.clock() - MINUTE_MS)}}
    )


def recreate_space(store: Store, *, storage_used: int = 0) -> None:
    """照接口服务的做法删除空间（任务和上传留着），再由同一个主人用同一个编号重建，写 genesis（seq = 1）。"""
    store.spaces.delete_one({"_id": SPACE})
    for name in API_DELETED_CHILDREN:
        store.col(name).delete_many({"spaceId": SPACE})
    make_space(store)
    space = store.spaces.find_one({"_id": SPACE})
    at = space["createdAt"]
    store.commits.insert_one(
        {
            "_id": "genesis",
            "spaceId": SPACE,
            "owner": OWNER,
            "seq": 1,
            "at": at,
            "actor": {"sub": "alice", "nyxServiceId": "dev-service", "scope": "physical", "kind": "person"},
            "message": "创建空间",
            "changedChunks": [],
            "changedEntities": [],
            "changedAnchors": [],
        }
    )
    store.spaces.update_one(
        {"_id": SPACE},
        {"$set": {"head": {"seq": 1, "at": at, "commitId": "genesis"}, "storageUsedBytes": storage_used}},
    )


def space_doc(store: Store) -> dict:
    return store.spaces.find_one({"_id": SPACE})


def space_commits(store: Store) -> list[str]:
    return [c["_id"] for c in store.commits.find({"spaceId": SPACE}).sort("seq", 1)]


# ---------------------------------------------------------------------------- 任务


def test_old_scan_import_does_not_write_into_recreated_space(runner, store):
    asset = upload_asset(store, scan_zip(room_mesh()), "scan")
    old = make_job(store, "scan_import", {"assetHash": asset, "rebuild": False})
    age(store, C.JOBS, old)
    recreate_space(store)

    assert runner.run_once() is True
    doc = store.jobs.find_one({"_id": old})
    assert doc["status"] == "failed" and doc["attempt"] == 1  # 不可重试
    assert "删除重建" in doc["lastError"]
    space = space_doc(store)
    assert space["head"]["seq"] == 1 and "frame" not in space
    assert space_commits(store) == ["genesis"]

    # 新空间里新建的任务照常导入
    new = make_job(store, "scan_import", {"assetHash": asset, "rebuild": False})
    assert runner.run_once() is True
    doc = store.jobs.find_one({"_id": new})
    assert doc["status"] == "done", doc.get("lastError")
    assert space_doc(store)["head"]["seq"] == 2 and space_doc(store)["frame"]["referenceScan"] == asset


def test_write_back_rejects_space_recreated_during_processing(store):
    """领取时空间还在，处理期间被删除重建：写回事务里按任务的创建时间核对空间实例，不写提交。"""
    make_space(store)
    old = make_job(store, "rebuild", {})
    age(store, C.JOBS, old)
    lease = claim(store, "worker-a", ["rebuild"], 60_000)
    assert lease is not None and lease.job_id == old
    recreate_space(store)
    with pytest.raises(SpaceGone):
        write_back(store, lease, CommitPlan(message="旧任务的结果"))
    assert space_commits(store) == ["genesis"] and space_doc(store)["head"]["seq"] == 1
    assert store.jobs.find_one({"_id": old})["status"] == "running"  # 事务整体放弃，没有标记完成


def test_old_model_import_fails_in_recreated_space(runner, store):
    source = upload_asset(store, dense_box_glb(), "model", kind="model")
    old = make_job(store, "model_import", {"assetHash": source})
    age(store, C.JOBS, old)
    recreate_space(store)
    assert runner.run_once() is True
    doc = store.jobs.find_one({"_id": old})
    assert doc["status"] == "failed" and "删除重建" in doc["lastError"]
    assert "result" not in doc


# ---------------------------------------------------------------------------- 上传与存储用量


def test_old_upload_is_not_completed_into_recreated_space(runner, store):
    content = b"#!/bin/sh\necho old space\n"
    uid = make_upload(store, content, "script")
    age(store, C.UPLOADS, uid)
    recreate_space(store, storage_used=8000)
    jid = make_job(store, "upload_verify", {"uploadId": uid})  # 新实例里才完成上传，任务是新建的
    assert runner.run_once() is True
    assert store.jobs.find_one({"_id": jid})["status"] == "failed"
    upload = store.uploads.find_one({"_id": uid})
    assert upload["status"] == "failed" and "storageBytes" not in upload
    assert space_doc(store)["storageUsedBytes"] == 8000
    assert find_asset(store, hashlib.sha256(content).hexdigest()) is None

    # 同一个空间实例里的上传照常完成、计入用量
    fresh = make_upload(store, content, "script")
    make_job(store, "upload_verify", {"uploadId": fresh})
    assert runner.run_once() is True
    assert store.uploads.find_one({"_id": fresh})["status"] == "done"
    assert space_doc(store)["storageUsedBytes"] == 8000 + len(content)


def test_settle_upload_fails_upload_of_old_space_instance(store):
    make_space(store)
    content = b"verified before the space was deleted"
    sha = put_asset(store, content, content_type="text/plain", kind="script", space_id=SPACE).hash
    uid = make_upload(store, content, "script")
    store.uploads.update_one({"_id": uid}, {"$set": {"verifiedSha256": sha}})
    age(store, C.UPLOADS, uid)
    recreate_space(store, storage_used=8000)
    scope = SystemScope(SPACE, Owner.from_doc({"owner": OWNER}), "cleanup")
    assert settle_upload(store, scope, uid, "校验任务失败") == "failed"
    assert store.uploads.find_one({"_id": uid})["status"] == "failed"
    assert space_doc(store)["storageUsedBytes"] == 8000


def test_release_only_subtracts_from_the_space_instance_that_counted(store):
    make_space(store)
    content = b"counted in the old space"
    sha = put_asset(store, content, content_type="text/plain", kind="script", space_id=SPACE).hash
    old_time = format_ts(store.clock() - MINUTE_MS)
    recreate_space(store, storage_used=8000)
    new_time = space_doc(store)["createdAt"]
    for uid, created_at, size in (("old", old_time, 5000), ("new", new_time, 3000)):
        store.uploads.insert_one(
            {
                "_id": uid,
                "spaceId": SPACE,
                "owner": OWNER,
                "purpose": "script",
                "size": size,
                "sha256": sha,
                "status": "done",
                "assetHash": sha,
                "storageBytes": size,
                "createdAt": created_at,
            }
        )
    assert release_upload_storage(store, sha) == 2
    # 旧实例的 5000 字节没有计进新空间，不减；新实例自己的 3000 字节减回
    assert space_doc(store)["storageUsedBytes"] == 5000
    released = {u["_id"] for u in store.uploads.find({"storageReleasedAt": {"$exists": True}})}
    assert released == {"old", "new"}  # 都标记过，下次不会再处理
    assert release_upload_storage(store, sha) == 0
    assert space_doc(store)["storageUsedBytes"] == 5000
