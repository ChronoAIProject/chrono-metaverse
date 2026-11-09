"""复用已有资源与定期清理之间的栅栏：清理先查引用、再按 touchedAt 条件删除；复用一方先刷新 touchedAt 并确认
匹配到 1 条，匹配不到就按资源不存在处理（不能引用一个已经被删掉的资源）。"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime

import pytest

from conftest import OWNER, SPACE, make_job, make_space, make_upload
from metaverse_worker import assets, uploads
from metaverse_worker.assets import (
    delete_asset,
    delete_file_chunks,
    find_asset,
    put_asset,
    read_asset,
    register_upload,
    touch_asset,
    write_upload_part,
)
from metaverse_worker.handlers import upload_verify
from metaverse_worker.jobs.cleanup import cleanup_assets
from metaverse_worker.runner import Runner
from metaverse_worker.store import C, Owner, Store, SystemScope

pytestmark = pytest.mark.mongo

LONG_AGO = datetime(2020, 1, 1, tzinfo=UTC)


def vanishing_find(store: Store, real=assets.find_asset):
    """模拟清理恰好在"查到资源"和"刷新它"之间把它删掉：返回查到的文档，同时把资源删掉。"""

    def find(_store, sha, session=None):
        doc = real(store, sha, session=session)
        if doc is not None:
            delete_asset(store, sha)
        return doc

    return find


def test_touch_reports_whether_asset_still_exists(store):
    sha = put_asset(store, b"touch me", content_type="text/plain", kind="script").hash
    assert touch_asset(store, sha) is True
    delete_asset(store, sha)
    assert touch_asset(store, sha) is False


def test_cleanup_does_not_delete_asset_touched_after_reference_check(store):
    """清理查完引用、删除之前，引用方刷新了 touchedAt：条件删除落空，资源保留。"""
    make_space(store)
    sha = put_asset(store, b"texture about to be reused", content_type="image/png", kind="texture").hash
    store.col(C.ASSET_FILES).update_one(
        {"filename": sha}, {"$set": {"uploadDate": LONG_AGO, "metadata.touchedAt": LONG_AGO}}
    )

    class RacingStore(Store):
        """清理扫描未结束任务的那一刻，另一方复用了这个资源（先刷新，再写引用）。"""

        @property
        def jobs(self):
            touch_asset(store, sha)
            return super().jobs

    racing = RacingStore(store.client, store.db.name, store.clock)
    assert cleanup_assets(racing, 7) == 0
    assert find_asset(store, sha) is not None


def test_put_asset_registers_again_when_existing_asset_vanishes(store, monkeypatch):
    data = b"derived texture bytes"
    first = put_asset(store, data, content_type="image/png", kind="texture")
    monkeypatch.setattr(assets, "find_asset", vanishing_find(store))
    info = put_asset(store, data, content_type="image/png", kind="texture")
    monkeypatch.undo()
    assert info.created is True and info.files_id != first.files_id
    assert read_asset(store, info.hash) == data


def test_register_upload_retries_when_duplicate_vanishes(store, monkeypatch):
    """登记时撞上同名资源，而它在刷新之前被清理删掉：本次的数据块保留，重新插入 files 文档。"""
    data = b"uploaded script\n" * 100
    sha = hashlib.sha256(data).hexdigest()
    put_asset(store, data, content_type="text/plain", kind="script")
    write_upload_part(store, "upload-1", 0, 256 * 1024, data)
    monkeypatch.setattr(assets, "find_asset", vanishing_find(store))
    info = register_upload(
        store, "upload-1", sha, len(data), content_type="text/plain", kind="script", space_id=SPACE
    )
    monkeypatch.undo()
    assert info.created is True and info.files_id == "upload-1"
    assert read_asset(store, sha) == data


@pytest.fixture
def runner(store, db_config):
    make_space(store)
    return Runner(db_config, store, isolate=False, on_stall=lambda: None)


def test_upload_verify_reuse_fails_when_existing_asset_was_cleaned(runner, store, monkeypatch):
    """上次核对通过、复用已有资源时删掉了本次数据块；收尾前那份资源被清理：不能把上传完成到它上面。"""
    data = b"#!/bin/sh\necho reuse\n"
    sha = hashlib.sha256(data).hexdigest()
    put_asset(store, data, content_type="text/plain", kind="script")
    uid = make_upload(store, data, "script")
    store.uploads.update_one({"_id": uid}, {"$set": {"verifiedSha256": sha}})
    delete_file_chunks(store, uid)
    monkeypatch.setattr(upload_verify, "find_asset", vanishing_find(store))
    jid = make_job(store, "upload_verify", {"uploadId": uid})
    assert runner.run_once() is True
    assert store.jobs.find_one({"_id": jid})["status"] == "failed"
    upload = store.uploads.find_one({"_id": uid})
    assert upload["status"] == "failed" and "assetHash" not in upload
    assert store.spaces.find_one({"_id": SPACE})["storageUsedBytes"] == 0


def test_settle_upload_does_not_finish_onto_cleaned_asset(store, monkeypatch):
    make_space(store)
    data = b"verified, then the existing copy was cleaned"
    sha = hashlib.sha256(data).hexdigest()
    put_asset(store, data, content_type="text/plain", kind="script")
    uid = make_upload(store, data, "script")
    store.uploads.update_one({"_id": uid}, {"$set": {"verifiedSha256": sha}})
    monkeypatch.setattr(uploads, "find_asset", vanishing_find(store))
    scope = SystemScope(SPACE, Owner.from_doc({"owner": OWNER}), "cleanup")
    assert uploads.settle_upload(store, scope, uid, "校验任务失败") == "failed"
    assert store.uploads.find_one({"_id": uid})["status"] == "failed"
    assert store.spaces.find_one({"_id": SPACE})["storageUsedBytes"] == 0
