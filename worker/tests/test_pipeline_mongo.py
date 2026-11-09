"""集成测试：真实本地 MongoDB 副本集（`pytest -m mongo`）。

覆盖：upload_verify → scan_import → 提交写入；重扫配准与转人工；给定变换；租约丢失不写回；
重复任务不重复提交；哈希不符时清理；rebuild、voxelize、model_import；失败分类、优雅停止、定期清理。
"""

from __future__ import annotations

import hashlib
import math
import threading
import time
from datetime import UTC, datetime

import numpy as np
import pytest

from conftest import (
    SPACE,
    make_job,
    make_space,
    make_upload,
    scan_zip,
    upload_asset,
)
from metaverse_worker.assets import find_asset, put_asset, read_asset, register_upload
from metaverse_worker.chunk import decompress
from metaverse_worker.handlers import scan as scan_handlers
from metaverse_worker.jobs.cleanup import cleanup_assets
from metaverse_worker.jobs.isolate import IsolatedCancelled, IsolatedTimeout
from metaverse_worker.jobs.lease import claim
from metaverse_worker.processing import tasks
from metaverse_worker.processing.align import column_major
from metaverse_worker.processing.glb import read_glb_json
from metaverse_worker.processing.scan import ScanMesh, rotation_y
from metaverse_worker.runner import Runner
from metaverse_worker.store import C
from metaverse_worker.timeutil import format_ts
from synthetic import room_mesh
from test_voxelize_rebuild import dense_box_glb

pytestmark = pytest.mark.mongo


@pytest.fixture
def runner(store, db_config, monkeypatch):
    monkeypatch.setattr(scan_handlers, "OBJECTS_TARGET", "fake_objects:reconstruct_objects")
    make_space(store)
    return Runner(db_config, store, isolate=False, on_stall=lambda: None)


def job(store, job_id):
    return store.jobs.find_one({"_id": job_id})


def commits(store):
    return list(store.commits.find({"spaceId": SPACE}).sort("seq", 1))


def rigid(theta_deg: float, t) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = rotation_y(math.radians(theta_deg))
    m[:3, 3] = t
    return m


def run_job(runner, store, kind, params, job_id=None) -> dict:
    jid = make_job(store, kind, params, job_id=job_id)
    assert runner.run_once() is True
    return job(store, jid)


def import_room(runner, store, mesh=None, **params) -> tuple[str, dict]:
    asset = upload_asset(store, scan_zip(mesh or room_mesh()), "scan")
    doc = run_job(runner, store, "scan_import", {"assetHash": asset, **params})
    return asset, doc


# ---------------------------------------------------------------------------- upload_verify


def test_upload_verify_registers_asset(runner, store):
    data = scan_zip(room_mesh())  # 跨多个 256KiB 数据块
    big = bytes(np.random.default_rng(0).integers(0, 256, 600_000, dtype=np.uint8))
    ops = b"".join(
        b'{"op":"fill","i":%d,"pad":"%s"}\n' % (i, big[i : i + 8].hex().encode()) for i in range(20000)
    )
    for content, purpose, fmt in ((data, "scan", "zip"), (ops, "ops", "ndjson")):
        uid = make_upload(store, content, purpose, part_size=256 * 1024)
        doc = run_job(runner, store, "upload_verify", {"uploadId": uid})
        sha = hashlib.sha256(content).hexdigest()
        assert doc["status"] == "done", doc.get("lastError")
        assert doc["result"]["assetHash"] == sha and doc["result"]["format"] == fmt
        assert doc["result"]["reused"] is False
        upload = store.uploads.find_one({"_id": uid})
        assert upload["status"] == "done" and upload["assetHash"] == sha
        files = find_asset(store, sha)
        assert files["_id"] == uid and files["metadata"]["kind"] == purpose
        assert files["metadata"]["spaceId"] == SPACE and files["metadata"]["format"] == fmt
        assert read_asset(store, sha, max_bytes=1 << 26) == content


def test_upload_verify_hash_mismatch_cleans_up(runner, store):
    content = b'{"op":"x"}\n' * 40000
    uid = make_upload(store, content, "ops", declared_sha="0" * 64, part_size=256 * 1024)
    assert store.col(C.ASSET_CHUNKS).count_documents({"files_id": uid}) > 1
    doc = run_job(runner, store, "upload_verify", {"uploadId": uid})
    assert doc["status"] == "failed" and doc["attempt"] == 1 and "哈希不符" in doc["lastError"]
    upload = store.uploads.find_one({"_id": uid})
    assert upload["status"] == "failed" and "哈希不符" in upload["error"]
    assert store.col(C.ASSET_CHUNKS).count_documents({"files_id": uid}) == 0
    assert find_asset(store, "0" * 64) is None


def test_upload_verify_incomplete_and_bad_format(runner, store):
    content = bytes(range(256)) * 4096  # 1MiB，4 片
    uid = make_upload(store, content, "ops", part_size=256 * 1024, skip_parts=(2,))
    doc = run_job(runner, store, "upload_verify", {"uploadId": uid})
    assert doc["status"] == "failed" and "不完整" in doc["lastError"]
    assert store.col(C.ASSET_CHUNKS).count_documents({"files_id": uid}) == 0
    uid = make_upload(store, b"plain text, not an image", "texture")
    doc = run_job(runner, store, "upload_verify", {"uploadId": uid})
    assert doc["status"] == "failed" and "格式不符合" in doc["lastError"]
    assert store.uploads.find_one({"_id": uid})["status"] == "failed"
    assert store.col(C.ASSET_CHUNKS).count_documents({"files_id": uid}) == 0
    uid = make_upload(store, b"#!/bin/sh\necho hi\n", "script", status="open")
    doc = run_job(runner, store, "upload_verify", {"uploadId": uid})
    assert doc["status"] == "failed" and "open" in doc["lastError"]
    doc = run_job(runner, store, "upload_verify", {"uploadId": "nope"})
    assert doc["status"] == "failed" and "不存在" in doc["lastError"]


def test_upload_verify_duplicate_reuses_existing(runner, store):
    content = b"console.log('hi')\n" * 100
    existing = put_asset(store, content, content_type="text/plain", kind="script")
    uid = make_upload(store, content, "script")
    doc = run_job(runner, store, "upload_verify", {"uploadId": uid})
    assert doc["status"] == "done" and doc["result"] == {
        "assetHash": existing.hash,
        "reused": True,
        "bytes": len(content),
        "format": "text",
        "contentType": "text/plain; charset=utf-8",
    }
    assert store.col(C.ASSET_CHUNKS).count_documents({"files_id": uid}) == 0
    assert store.col(C.ASSET_FILES).count_documents({"filename": existing.hash}) == 1
    assert store.uploads.find_one({"_id": uid})["assetHash"] == existing.hash


def test_upload_verify_resumes_after_crash(runner, store):
    content = b"echo resume\n" * 50
    sha = hashlib.sha256(content).hexdigest()
    uid = make_upload(store, content, "script")
    # 上次已经登记成资源、还没来得及改上传状态
    register_upload(store, uid, sha, len(content), content_type="text/plain", kind="script", space_id=SPACE)
    doc = run_job(runner, store, "upload_verify", {"uploadId": uid})
    assert doc["status"] == "done" and doc["result"]["assetHash"] == sha and doc["result"]["reused"] is False
    assert store.uploads.find_one({"_id": uid})["status"] == "done"
    # 已经 done 的上传再来一个校验任务：直接完成
    doc = run_job(runner, store, "upload_verify", {"uploadId": uid})
    assert doc["status"] == "done" and doc["result"]["assetHash"] == sha


def used_bytes(store) -> int:
    return store.spaces.find_one({"_id": SPACE})["storageUsedBytes"]


def test_upload_verify_counts_space_storage(runner, store):
    """校验通过时把上传的大小计入空间的 storageUsedBytes（复用已有资源也算），重做不会重复计。"""
    first = b"echo storage\n" * 300
    uid = make_upload(store, first, "script")
    assert run_job(runner, store, "upload_verify", {"uploadId": uid})["status"] == "done"
    assert used_bytes(store) == len(first)
    assert store.uploads.find_one({"_id": uid})["storageBytes"] == len(first)
    # 已经 done 的上传再校验一次：不重复计
    assert run_job(runner, store, "upload_verify", {"uploadId": uid})["status"] == "done"
    assert used_bytes(store) == len(first)
    # 同一内容再上传一次（复用已有资源）：也算本空间的用量
    again = make_upload(store, first, "script")
    doc = run_job(runner, store, "upload_verify", {"uploadId": again})
    assert doc["result"]["reused"] is True and used_bytes(store) == 2 * len(first)
    # 校验失败的上传不计
    bad = make_upload(store, b"not an image", "texture")
    assert run_job(runner, store, "upload_verify", {"uploadId": bad})["status"] == "failed"
    assert used_bytes(store) == 2 * len(first)


def test_upload_verify_lease_lost_does_not_count_storage(runner, store):
    """收尾时租约已丢：上传改 done、计用量、任务完成在同一个事务里，一起放弃。"""
    content = b"echo lost\n" * 100
    uid = make_upload(store, content, "script")
    jid = make_job(store, "upload_verify", {"uploadId": uid})
    lease = claim(store, "worker-a", ["upload_verify"], 60_000)
    store.jobs.update_one({"_id": jid}, {"$set": {"leaseOwner": "worker-b"}})
    assert runner.process(lease) == "lost"
    assert store.uploads.find_one({"_id": uid})["status"] == "complete"
    assert used_bytes(store) == 0
    # 新的持有者从头收尾，只计一次
    store.jobs.update_one({"_id": jid}, {"$set": {"status": "queued"}, "$unset": {"leaseOwner": ""}})
    assert runner.run_once() is True
    assert job(store, jid)["status"] == "done" and used_bytes(store) == len(content)


def test_upload_verify_timeout_fails_upload(runner, store, monkeypatch):
    """嗅探子进程超时（不可重试）：任务失败的同时上传也标记失败、删数据块，不再占着进行中的配额。"""

    def too_slow(**_kwargs):
        raise IsolatedTimeout("子进程超时（1800 秒）", kind="timeout")

    monkeypatch.setattr(tasks, "sniff_task", too_slow)
    uid = make_upload(store, b"#!/bin/sh\necho slow\n", "script")
    doc = run_job(runner, store, "upload_verify", {"uploadId": uid})
    assert doc["status"] == "failed" and doc["attempt"] == 1
    upload = store.uploads.find_one({"_id": uid})
    assert upload["status"] == "failed" and "校验任务失败" in upload["error"] and "超时" in upload["error"]
    assert store.col(C.ASSET_CHUNKS).count_documents({"files_id": uid}) == 0


def test_upload_verify_retries_then_fails_upload(runner, store, monkeypatch):
    """可重试的错误：重试期间上传保持 complete；重试次数用完后上传标记失败。"""

    def flaky(**_kwargs):
        raise ConnectionError("数据库抖动")

    monkeypatch.setattr(tasks, "sniff_task", flaky)
    uid = make_upload(store, b"#!/bin/sh\necho flaky\n", "script")
    jid = make_job(store, "upload_verify", {"uploadId": uid})
    for attempt in (1, 2):
        assert runner.run_once() is True
        assert job(store, jid)["status"] == "queued" and job(store, jid)["attempt"] == attempt
        assert store.uploads.find_one({"_id": uid})["status"] == "complete"
    assert runner.run_once() is True
    assert job(store, jid)["status"] == "failed"
    upload = store.uploads.find_one({"_id": uid})
    assert upload["status"] == "failed" and "数据库抖动" in upload["error"]
    assert store.col(C.ASSET_CHUNKS).count_documents({"files_id": uid}) == 0


def test_stuck_complete_uploads_are_settled_by_housekeeping(runner, store):
    """主循环没来得及处理的（重试次数用完被回收、任务记录丢了）由定期清理兜底。"""
    old = format_ts(store.clock() - 48 * 3600 * 1000)

    def stuck_upload(content: bytes, job_status: str | None, **extra) -> str:
        uid = make_upload(store, content, "script")
        jid = None
        if job_status is not None:
            jid = make_job(store, "upload_verify", {"uploadId": uid})
            store.jobs.update_one({"_id": jid}, {"$set": {"status": job_status, "lastError": "崩溃了"}})
        store.uploads.update_one({"_id": uid}, {"$set": {"jobId": jid, "completedAt": old, **extra}})
        return uid

    failed = stuck_upload(b"echo 1\n", "failed")
    queued = stuck_upload(b"echo 2\n", "queued")
    orphan = stuck_upload(b"echo 3\n", None)
    fresh = stuck_upload(b"echo 4\n", None, completedAt=format_ts(store.clock()))
    # 上次已核对并登记成资源、还没改上传状态就失败了：补做收尾，不删数据
    content = b"echo registered\n"
    sha = hashlib.sha256(content).hexdigest()
    registered = stuck_upload(content, "failed", verifiedSha256=sha)
    register_upload(
        store, registered, sha, len(content), content_type="text/plain", kind="script", space_id=SPACE
    )
    # 重试次数用完、租约已过期：housekeeping 先回收任务，同一轮里处理它的上传
    exhausted = stuck_upload(b"echo 5\n", "running")
    store.jobs.update_one(
        {"_id": store.uploads.find_one({"_id": exhausted})["jobId"]},
        {"$set": {"attempt": 3, "leaseUntil": old, "leaseOwner": "gone"}},
    )

    cleaned = runner.housekeeping()
    assert cleaned["stuckUploads"] == 4 and cleaned["exhaustedJobs"] == 1
    status = {
        uid: store.uploads.find_one({"_id": uid}) for uid in (failed, queued, orphan, fresh, registered)
    }
    assert status[failed]["status"] == "failed" and "崩溃了" in status[failed]["error"]
    assert status[orphan]["status"] == "failed" and "不存在" in status[orphan]["error"]
    assert status[queued]["status"] == "complete" and status[fresh]["status"] == "complete"
    assert status[registered]["status"] == "done" and status[registered]["assetHash"] == sha
    assert read_asset(store, sha) == content
    assert used_bytes(store) == len(content)  # 补做收尾的也计入用量；失败的不计
    assert store.uploads.find_one({"_id": exhausted})["status"] == "failed"
    for uid in (failed, orphan, exhausted):
        assert store.col(C.ASSET_CHUNKS).count_documents({"files_id": uid}) == 0
    assert runner.housekeeping()["stuckUploads"] == 0


# ---------------------------------------------------------------------------- scan_import


def test_upload_then_scan_import_full_pipeline_in_subprocess(store, db_config, monkeypatch):
    """真实子进程：上传校验 → 扫描导入（假物体重建在子进程里导入）→ 体素化任务。"""
    monkeypatch.setattr(scan_handlers, "OBJECTS_TARGET", "fake_objects:reconstruct_objects")
    make_space(store)
    runner = Runner(db_config, store, isolate=True, on_stall=lambda: None)
    content = scan_zip(room_mesh())
    uid = make_upload(store, content, "scan", part_size=256 * 1024)
    verify = run_job(runner, store, "upload_verify", {"uploadId": uid})
    assert verify["status"] == "done", verify.get("lastError")
    asset = verify["result"]["assetHash"]

    params = {
        "assetHash": asset,
        "observedAt": "2026-11-01T09:30:00+08:00",
        "voxelize": True,
        "hints": {"k": 1},
    }
    doc = run_job(runner, store, "scan_import", params)
    assert doc["status"] == "done", doc.get("lastError")
    (commit,) = commits(store)
    assert doc["resultCommitId"] == commit["_id"] and commit["jobId"] == doc["_id"]
    assert commit["seq"] == 1 and commit["observedAt"] == "2026-11-01T01:30:00.000Z"
    assert commit["actor"] == {
        "sub": "alice",
        "nyxServiceId": "dev-service",
        "scope": "physical",
        "kind": "job",
    }
    scan = commit["scan"]
    assert set(scan) == {"assetHash", "webModelHashes", "transform"}
    assert scan["assetHash"] == asset and len(scan["webModelHashes"]) == 2 and len(scan["transform"]) == 16
    for h in scan["webModelHashes"]:
        files = find_asset(store, h)
        assert (
            files["metadata"]["kind"] == "web_model"
            and files["metadata"]["contentType"] == "model/gltf-binary"
        )
        assert read_glb_json(read_asset(store, h))["asset"]["version"] == "2.0"
    space = store.spaces.find_one({"_id": SPACE})
    assert space["head"]["seq"] == 1 and space["frame"]["referenceScan"] == asset

    ids = {c["id"] for c in commit["changedEntities"]}
    assert {"floor", "chair-a", "chair-01", "chair-02", "table-01"} <= ids
    assert all(c["hash"] for c in commit["changedEntities"])
    ents = {e["id"]: e for e in store.col(C.ENTITIES).find({"spaceId": SPACE})}
    assert ents.keys() == ids and all(e["body"]["layer"] == "rebuilt" for e in ents.values())
    record = store.col(C.RECORDS).find_one({"_id": ents["table-01"]["hash"]})
    assert record["kind"] == "entity" and record["owner"] == {"kind": "person", "id": "alice"}

    anchors = {a["id"]: a["body"] for a in store.col(C.ANCHORS).find({"spaceId": SPACE})}
    assert set(anchors) == {"chair-01", "seat-02", "table-01"}
    assert anchors["table-01"]["kind"] == "table" and anchors["seat-02"]["kind"] == "seat"
    assert anchors["table-01"]["label"] == "会议桌" and len(anchors["table-01"]["box"]) == 6
    assert {c["id"] for c in commit["changedAnchors"]} == set(anchors)

    refs = {r["hash"] for r in store.col(C.ASSET_REFS).find({"spaceId": SPACE})}
    table_tex = ents["table-01"]["body"]["shape"]["material"]["texture"]
    assert {*scan["webModelHashes"], table_tex, *ents["floor"]["body"]["textures"]} <= refs
    assert asset not in refs  # 原始扫描不进公开白名单

    result = doc["result"]
    assert result["alignment"]["method"] == "auto"
    assert result["objects"]["hints"] == {"k": 1} and result["objects"]["entities"] == 4
    assert result["structure"]["walls"] >= 4 and result["entities"]["removed"] == 0
    assert sorted(result["anchorsCreated"]) == sorted(anchors)
    assert [m["hash"] for m in result["webModels"]] == scan["webModelHashes"]

    vox_id = result["voxelizeJobId"]
    assert vox_id == f"{doc['_id']}-voxelize"
    vox = job(store, vox_id)
    assert (
        vox["status"] == "queued"
        and vox["params"] == {"scanAssetHash": asset}
        and vox["actor"]["sub"] == "alice"
    )
    assert runner.run_once() is True
    vox = job(store, vox_id)
    assert vox["status"] == "done", vox.get("lastError")
    _, second = commits(store)
    assert second["paletteHash"] and second["changedChunks"]
    assert all(c["layer"] == "rebuilt" and c["hash"] for c in second["changedChunks"])
    palette = store.col(C.PALETTES).find_one({"_id": second["paletteHash"]})
    assert min(b["id"] for b in palette["blocks"]) == 2
    chunk = store.col(C.CHUNKS).find_one({"_id": second["changedChunks"][0]["hash"]})
    assert chunk["publishedAt"] and decompress(bytes(chunk["data"])).any()


def test_scan_import_is_not_committed_twice(runner, store):
    _asset, doc = import_room(runner, store, rebuild=False)
    assert doc["status"] == "done" and len(commits(store)) == 1
    # 同一个任务被再次投递（例如记录被重置）：领取后发现已经有提交，直接完成
    store.jobs.update_one(
        {"_id": doc["_id"]}, {"$set": {"status": "queued"}, "$unset": {"resultCommitId": ""}}
    )
    assert runner.run_once() is True
    again = job(store, doc["_id"])
    assert again["status"] == "done" and again["resultCommitId"] == doc["resultCommitId"]
    assert len(commits(store)) == 1 and runner.counts["already"] == 1


def test_lease_lost_does_not_write_back(runner, store):
    asset = upload_asset(store, scan_zip(room_mesh()), "scan")
    jid = make_job(store, "scan_import", {"assetHash": asset})
    lease = claim(store, "worker-a", ["scan_import"], 60_000)
    assert lease is not None
    # 租约被别人拿走（过期后重新领取）
    store.jobs.update_one({"_id": jid}, {"$set": {"leaseOwner": "worker-b", "attempt": 2}})
    assert runner.process(lease) == "lost"
    assert commits(store) == [] and store.col(C.ENTITIES).count_documents({}) == 0
    assert job(store, jid)["leaseOwner"] == "worker-b" and job(store, jid)["status"] == "running"


def test_racing_leases_only_one_commit(runner, store):
    asset = upload_asset(store, scan_zip(room_mesh()), "scan")
    jid = make_job(store, "scan_import", {"assetHash": asset, "rebuild": False})
    first = claim(store, "worker-a", ["scan_import"], 60_000)
    store.jobs.update_one({"_id": jid}, {"$set": {"leaseUntil": format_ts(store.clock() - 1000)}})
    second = claim(store, "worker-b", ["scan_import"], 60_000)
    assert second is not None and second.attempt == 2
    assert runner.process(second) == "done"
    assert runner.process(first) == "lost"  # 查到已有提交，但栅栏不匹配：什么也不写
    assert len(commits(store)) == 1
    assert job(store, jid)["leaseOwner"] == "worker-b"


def test_rescan_registration_replaces_rebuilt_layer_only(runner, store):
    room = room_mesh()
    first_asset, first = import_room(runner, store, room)
    assert first["status"] == "done"
    ref_transform = np.asarray(commits(store)[0]["scan"]["transform"]).reshape(4, 4).T
    # 扩展层的物件不受重建影响
    store.col(C.ENTITIES).insert_one(
        {
            "spaceId": SPACE,
            "id": "flowers",
            "owner": {"kind": "person", "id": "alice"},
            "hash": "f" * 64,
            "body": {"layer": "ext", "kind": "object"},
        }
    )
    truth = rigid(37.0, [1.5, 0.0, -0.7])
    rescan = ScanMesh(room.vertices @ truth[:3, :3].T + truth[:3, 3], room.faces, room.uv, room.texture)
    monkey_target = "fake_objects:moved_objects"
    scan_handlers.OBJECTS_TARGET = monkey_target
    _second_asset, doc = import_room(runner, store, rescan)
    assert doc["status"] == "done", doc.get("lastError")
    assert doc["result"]["alignment"]["method"] == "registered"
    assert doc["result"]["alignment"]["errorCm"] < 1.0
    c2 = commits(store)[1]
    matrix = np.asarray(c2["scan"]["transform"]).reshape(4, 4).T
    np.testing.assert_allclose(matrix @ truth, ref_transform, atol=5e-3)
    assert c2["message"].startswith("导入扫描") and "重扫配准" in c2["message"]
    changed = {c["id"]: c["hash"] for c in c2["changedEntities"]}
    assert changed.get("table-01")  # 挪了位置
    assert store.col(C.ENTITIES).find_one({"spaceId": SPACE, "id": "flowers"}) is not None
    assert c2["changedAnchors"] == []  # 锚点已存在就不动
    space = store.spaces.find_one({"_id": SPACE})
    assert space["frame"]["referenceScan"] == first_asset  # 坐标系不变


def test_rescan_with_large_error_needs_alignment(runner, store):
    import_room(runner, store)
    other = room_mesh(diagonal=False)
    other = ScanMesh(other.vertices * np.array([1.6, 1.0, 0.7]), other.faces, other.uv, other.texture)
    asset, doc = import_room(runner, store, other)
    assert doc["status"] == "done" and "resultCommitId" not in doc
    result = doc["result"]
    assert result["needsAlignment"] is True and result["errorCm"] > result["maxErrorCm"]
    assert len(result["proposedTransform"]) == 16 and result["scanAssetHash"] == asset
    assert len(commits(store)) == 1
    # 人工给出变换后重新发起：直接用给定的变换
    given = column_major(rigid(0, [0.1, 0, 0.2]))
    doc = run_job(runner, store, "scan_import", {"assetHash": asset, "transform": given, "rebuild": False})
    assert doc["status"] == "done", doc.get("lastError")
    c2 = commits(store)[1]
    assert c2["scan"]["transform"] == given and doc["result"]["alignment"]["method"] == "given"
    assert c2["changedEntities"] == []


def test_scan_import_reuses_previous_transform_and_validates(runner, store):
    asset, _first = import_room(runner, store, rebuild=False)
    doc = run_job(runner, store, "scan_import", {"assetHash": asset, "rebuild": False})
    assert doc["result"]["alignment"]["method"] == "reused"
    assert commits(store)[1]["scan"]["transform"] == commits(store)[0]["scan"]["transform"]
    bad = run_job(runner, store, "scan_import", {"assetHash": asset, "transform": [1, 2, 3]})
    assert bad["status"] == "failed" and bad["attempt"] == 1 and "transform" in bad["lastError"]
    bad = run_job(runner, store, "scan_import", {"assetHash": "x"})
    assert bad["status"] == "failed" and "assetHash" in bad["lastError"]
    bad = run_job(runner, store, "scan_import", {"assetHash": "a" * 64})
    assert bad["status"] == "failed" and "不存在" in bad["lastError"]
    junk = upload_asset(store, b"not a model at all", "scan")
    bad = run_job(runner, store, "scan_import", {"assetHash": junk})
    assert bad["status"] == "failed" and "格式" in bad["lastError"]


def test_rebuild_job(runner, store):
    asset, _ = import_room(runner, store)
    doc = run_job(runner, store, "rebuild", {})
    assert doc["status"] == "done" and doc["result"]["unchanged"] is True and len(commits(store)) == 1
    scan_handlers.OBJECTS_TARGET = "fake_objects:moved_objects"
    doc = run_job(runner, store, "rebuild", {"scanAssetHash": asset, "hints": {"x": 2}})
    assert doc["status"] == "done", doc.get("lastError")
    c2 = commits(store)[1]
    assert [c["id"] for c in c2["changedEntities"]] == ["table-01"] and "scan" not in c2
    # 物体重建模块缺失：只替换结构，旧物体保留
    scan_handlers.OBJECTS_TARGET = "metaverse_worker.processing.no_such:reconstruct_objects"
    doc = run_job(runner, store, "rebuild", {})
    assert doc["result"]["objects"]["skipped"]
    assert store.col(C.ENTITIES).find_one({"spaceId": SPACE, "id": "table-01"}) is not None
    doc = run_job(runner, store, "rebuild", {"scanAssetHash": "b" * 64})
    assert doc["status"] == "failed" and "没有扫描" in doc["lastError"]


def test_voxelize_without_scan_and_unchanged(runner, store):
    doc = run_job(runner, store, "voxelize", {})
    assert doc["status"] == "failed" and "还没有导入扫描" in doc["lastError"]
    import_room(runner, store, rebuild=False)
    doc = run_job(runner, store, "voxelize", {"style": {"paletteSize": 6}})
    assert doc["status"] == "done", doc.get("lastError")
    assert doc["result"]["newBlocks"] >= 1 and doc["result"]["changedChunks"] >= 1
    doc = run_job(runner, store, "voxelize", {"style": {"paletteSize": 6}})
    assert doc["result"]["unchanged"] is True and len(commits(store)) == 2
    doc = run_job(runner, store, "voxelize", {"style": {"paletteSize": 0}})
    assert doc["status"] == "failed"


def test_voxelize_style_name_from_api(runner, store):
    """接口服务和命令行把 style 当字符串（风格名）传：按风格表换算颜色数；不认识的名字直接失败。"""
    import_room(runner, store, rebuild=False)
    doc = run_job(runner, store, "voxelize", {"style": "coarse"})
    assert doc["status"] == "done", doc.get("lastError")
    assert doc["result"]["style"] == "coarse" and doc["result"]["paletteSize"] == 16
    for bad, text in (("watercolor", "不认识的体素化风格"), (5, "风格名"), ({"colors": 3}, "不认识的字段")):
        doc = run_job(runner, store, "voxelize", {"style": bad})
        assert doc["status"] == "failed" and doc["attempt"] == 1 and text in doc["lastError"]


def test_model_import_job(runner, store):
    source = upload_asset(store, dense_box_glb(), "model", kind="model")
    doc = run_job(runner, store, "model_import", {"assetHash": source})
    assert doc["status"] == "done", doc.get("lastError")
    result = doc["result"]
    assert result["sourceHash"] == source and result["triangles"] <= 100_000
    files = find_asset(store, result["modelHash"])
    assert files["metadata"]["kind"] == "model" and files["metadata"]["sourceHash"] == source
    junk = upload_asset(store, b"\x00\x01garbage", "model", kind="model")
    doc = run_job(runner, store, "model_import", {"assetHash": junk})
    assert doc["status"] == "failed" and doc["attempt"] == 1


def test_derived_assets_count_space_storage_once(runner, store):
    """扫描导入新登记进 assetRefs 的网页用模型计入空间用量；同样的资源再次引用不重复计。"""
    asset, doc = import_room(runner, store, rebuild=False)
    assert doc["status"] == "done", doc.get("lastError")
    web = commits(store)[0]["scan"]["webModelHashes"]
    web_bytes = sum(find_asset(store, h)["length"] for h in web)
    assert web_bytes > 0 and used_bytes(store) == web_bytes  # 原始扫描在这里没经过上传校验，不计
    doc = run_job(runner, store, "scan_import", {"assetHash": asset, "rebuild": False})
    assert doc["status"] == "done" and len(commits(store)) == 2
    assert used_bytes(store) == web_bytes


def test_raw_scan_not_public_but_kept_by_cleanup(runner, store):
    """原始扫描不登记 assetRefs（公开资源接口的白名单），但被提交引用，过了宽限期也不会被清理。"""
    asset, doc = import_room(runner, store, rebuild=False)
    assert doc["status"] == "done", doc.get("lastError")
    refs = {r["hash"] for r in store.col(C.ASSET_REFS).find({"spaceId": SPACE})}
    web = commits(store)[0]["scan"]["webModelHashes"]
    assert refs == set(web) and asset not in refs
    # 没被提交引用的另一个扫描：宽限期过后会被清理；已提交的扫描保留
    orphan = upload_asset(store, b"orphan scan bytes", "scan")
    long_ago = {"$set": {"uploadDate": datetime(2020, 1, 1, tzinfo=UTC)}}
    store.col(C.ASSET_FILES).update_many({"filename": {"$in": [asset, orphan, *web]}}, long_ago)
    assert cleanup_assets(store, 7) == 1
    assert find_asset(store, asset) is not None and find_asset(store, orphan) is None
    assert all(find_asset(store, h) is not None for h in web)


# ---------------------------------------------------------------------------- 主循环


def test_failure_classification_and_unclaimed_kinds(store, db_config):
    make_space(store)
    calls = []

    def flaky(ctx):
        calls.append(ctx.lease.attempt)
        raise ConnectionError("数据库抖动")

    runner = Runner(db_config, store, handlers={"rebuild": flaky}, isolate=False, on_stall=lambda: None)
    ops = make_job(store, "ops_from_upload", {"uploadId": "u"})
    jid = make_job(store, "rebuild", {})
    assert runner.run_once() is True
    doc = job(store, jid)
    assert doc["status"] == "queued" and doc["attempt"] == 1 and "数据库抖动" in doc["lastError"]
    assert runner.run_once() and runner.run_once()
    assert job(store, jid)["status"] == "failed" and calls == [1, 2, 3]
    assert runner.run_once() is False
    assert job(store, ops)["status"] == "queued"  # 处理服务不领取 ops_from_upload


def test_graceful_stop_requeues_and_refunds_attempt(store, db_config):
    make_space(store)
    started = threading.Event()

    def slow(ctx):
        started.set()
        while True:
            ctx.check_cancel()
            time.sleep(0.02)

    config = db_config.__class__(**{**db_config.__dict__, "stop_grace_seconds": 0.2})
    runner = Runner(config, store, handlers={"rebuild": slow}, isolate=False, on_stall=lambda: None)
    jid = make_job(store, "rebuild", {})
    t = threading.Thread(target=runner.run_once)
    t.start()
    assert started.wait(10)
    runner.request_stop()
    t.join(10)
    doc = job(store, jid)
    assert doc["status"] == "queued" and doc["attempt"] == 0 and "leaseOwner" not in doc
    assert runner.counts["requeued"] == 1


def test_cancel_raises_in_context(store, db_config):
    make_space(store)
    jid = make_job(store, "rebuild", {})
    lease = claim(store, "w", ["rebuild"], 60_000)
    from metaverse_worker.handlers import JobContext

    ctx = JobContext(store, db_config, lease, "/tmp", cancel=lambda: True)
    with pytest.raises(IsolatedCancelled):
        ctx.compute("metaverse_worker.processing.tasks:jsonable", value=1)
    assert job(store, jid)["status"] == "running"


def test_housekeeping_and_run_loop(store, db_config):
    make_space(store)
    old = format_ts(store.clock() - 48 * 3600 * 1000)
    uid = make_upload(store, b"abc" * 1000, "script", status="open")
    store.uploads.update_one({"_id": uid}, {"$set": {"createdAt": old}})
    exhausted = make_job(store, "rebuild", {})
    store.jobs.update_one(
        {"_id": exhausted},
        {"$set": {"status": "running", "attempt": 3, "leaseUntil": old, "leaseOwner": "gone"}},
    )
    done = threading.Event()

    def quick(ctx):
        from metaverse_worker.jobs.lease import mark_done

        mark_done(ctx.store, ctx.lease, result={"ok": True})
        done.set()
        return {}

    runner = Runner(db_config, store, handlers={"model_import": quick}, isolate=False, on_stall=lambda: None)
    ok, body = runner.health()
    assert not ok and body["status"] == "starting"
    jid = make_job(store, "model_import", {"assetHash": "c" * 64})
    t = threading.Thread(target=runner.run)
    t.start()
    try:
        assert done.wait(10)
        deadline = time.monotonic() + 10
        while runner.last_cleanup is None and time.monotonic() < deadline:
            time.sleep(0.05)
        ok, body = runner.health()
        assert ok and body["status"] == "ok" and body["service"] == "metaverse-worker"
        assert body["workerId"] == "test-worker" and body["kinds"] == ["model_import"]
    finally:
        runner.request_stop()
        t.join(10)
    assert not t.is_alive()
    assert job(store, jid)["status"] == "done"
    assert store.uploads.find_one({"_id": uid}) is None
    assert store.col(C.ASSET_CHUNKS).count_documents({"files_id": uid}) == 0
    assert job(store, exhausted)["status"] == "failed"
    assert runner.last_cleanup["uploads"] == 1 and runner.last_cleanup["exhaustedJobs"] == 1
    ok, body = runner.health()
    assert not ok and body["status"] == "stopping"
