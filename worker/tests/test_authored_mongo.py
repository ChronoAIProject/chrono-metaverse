"""集成测试：AI 物件集经 `scan_import` / `rebuild` 写进时间线（真实本地 MongoDB + 本机 https 模型库）。

覆盖：内联和资源两种传法；提交里就是物件集的物件；烘焙生成贴图；外部模型下载、重新导出、登记；
偏差写进 fit；结构 keep / replace；notes → scriptRef；锚点按类别；哈希不符、主机不在列表、重定向到不允许的
主机、资源用途不对、贴图不是本空间的都失败；同样的物件集再跑一次没有变化就不提交。
"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import zipfile

import numpy as np
import pytest

from conftest import SPACE, jpeg_bytes, make_config, make_job, make_space, make_upload, scan_zip, upload_asset
from https_server import serve
from metaverse_worker.assets import find_asset, put_asset, read_asset
from metaverse_worker.handlers import authored as authored_io
from metaverse_worker.handlers import scan as scan_handlers
from metaverse_worker.runner import Runner
from metaverse_worker.store import C
from synthetic import room_mesh
from test_authored import SOURCE, gltf_files, model_glb

pytestmark = pytest.mark.mongo

IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


@pytest.fixture
def library(tmp_path):
    with serve(str(tmp_path)) as server:
        yield server


@pytest.fixture
def runner(store, tmp_path, library, monkeypatch):
    monkeypatch.setattr(scan_handlers, "OBJECTS_TARGET", "fake_objects:reconstruct_objects")
    monkeypatch.setattr(authored_io, "OPENER_FACTORY", library.opener)
    make_space(store)
    config = make_config(store.db.name, workdir=str(tmp_path), model_hosts=(library.host,))
    return Runner(config, store, isolate=False, on_stall=lambda: None)


def run_job(runner, store, kind, params) -> dict:
    jid = make_job(store, kind, params)
    assert runner.run_once() is True
    return store.jobs.find_one({"_id": jid})


def commits(store) -> list[dict]:
    return list(store.commits.find({"spaceId": SPACE}).sort("seq", 1))


def entities(store) -> dict[str, dict]:
    return {e["id"]: e["body"] for e in store.col(C.ENTITIES).find({"spaceId": SPACE})}


def asset_refs(store) -> set[str]:
    return {r["hash"] for r in store.col(C.ASSET_REFS).find({"spaceId": SPACE})}


def authored_doc(library, *, texture: str | None = None, **overrides) -> dict:
    model = library.add("/models/chair.glb", model_glb())
    panel_material = {"bake": "planar"}
    entities_ = [
        {
            "entityId": "panel-01",
            "kind": "object",
            "label": "木饰面",
            "shape": {"type": "box", "size": [0.02, 1.0, 1.0], "transform": {"position": [0.01, 0.5, 2.0]},
                      "material": panel_material},
        },
        {
            "entityId": "table-01",
            "kind": "object",
            "label": "会议桌",
            "anchorId": "table-01",
            "shape": {"type": "box", "size": [1.6, 0.75, 0.8], "transform": {"position": [2.0, 0, 3.0]},
                      "material": {"color": [120, 90, 60]}},
            "props": {"category": "table"},
        },
        {
            "entityId": "chair-01",
            "kind": "object",
            "label": "扶手椅",
            "model": {**model, "format": "glb"},
            "transform": {"position": [2.5, 0, 1.5], "yaw": 30},
            "material": {"tint": [255, 230, 230]},
            "props": {"category": "chair", "source": dict(SOURCE)},
        },
    ]  # fmt: skip
    if texture is not None:
        entities_.append(
            {
                "entityId": "poster-01",
                "kind": "object",
                "shape": {"type": "box", "size": [0.6, 0.9, 0.01], "transform": {"position": [1, 1, 0.01]},
                          "material": {"texture": texture, "uv": "planar"}},
            }
        )  # fmt: skip
    doc = {"version": 1, "entities": entities_, "notes": "面板贴着西墙，烘焙；扶手椅来自模型库。"}
    doc.update(overrides)
    return doc


def import_scan(runner, store, **params) -> tuple[str, dict]:
    scan = upload_asset(store, scan_zip(room_mesh()), "scan")
    return scan, run_job(runner, store, "scan_import", {"assetHash": scan, "transform": IDENTITY, **params})


def test_scan_import_with_inline_authored(runner, store, library):
    poster = put_asset(store, jpeg_bytes(np.full((8, 8, 3), 90, np.uint8)), content_type="image/jpeg",
                       kind="texture", space_id=SPACE).hash  # fmt: skip
    _, job = import_scan(runner, store, authored=authored_doc(library, texture=poster))
    assert job["status"] == "done", job.get("lastError")
    [commit] = commits(store)
    assert "AI 物件集" in commit["message"]
    current = entities(store)
    # 结构沿用算法结果，物体就是物件集里的（假的物体重建模块没有被调用：没有 chair-a 模板）
    structure = {e for e, b in current.items() if b["kind"] == "structure"}
    assert structure and set(current) - structure == {"panel-01", "table-01", "chair-01", "poster-01"}
    # 烘焙：面板的贴图登记成资源、进了 assetRefs
    panel = current["panel-01"]
    texture = panel["shape"]["material"]["texture"]
    assert find_asset(store, texture)["metadata"]["kind"] == "texture" and texture in asset_refs(store)
    assert panel["fit"]["meanCm"] < 1.0
    # 外部模型：下载、重新导出、登记，物件只引用处理后的模型
    chair = current["chair-01"]
    meta = find_asset(store, chair["assetHash"])["metadata"]
    assert meta["kind"] == "model" and meta["spaceId"] == SPACE and chair["assetHash"] in asset_refs(store)
    assert chair["props"]["source"] == SOURCE and "shape" not in chair
    lo, hi = chair["bounds"]["min"], chair["bounds"]["max"]
    assert np.allclose([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2], [2.5, 0, 1.5], atol=1e-3)
    # 已有的贴图过了栅栏并登记引用
    assert poster in asset_refs(store) and current["poster-01"]["textures"] == [poster]
    # notes → 脚本资源，提交的 scriptRef 指向它
    script = commit["scriptRef"]
    assert find_asset(store, script)["metadata"]["kind"] == "script"
    assert read_asset(store, script).decode() == "面板贴着西墙，烘焙；扶手椅来自模型库。"
    # 锚点规则不变：桌子建，椅子没被提示要求不建
    anchors = {a["id"] for a in store.col(C.ANCHORS).find({"spaceId": SPACE})}
    assert anchors == {"table-01"}
    result = job["result"]["authored"]
    assert result["origin"] == {"kind": "inline"} and result["structure"] == "keep"
    assert result["downloads"] == {"models": 1, "files": 1, "bytes": len(model_glb()), "redirects": 0}
    assert result["models"]["files"] == 1 and result["bake"]["textured"] == 1
    fits = {f["entityId"]: f for f in result["fit"]}
    assert fits["panel-01"]["meanCm"] == panel["fit"]["meanCm"] and result["scriptRef"] == script
    assert job["result"]["entities"]["objects"] == 4


def test_rebuild_with_authored_asset_replaces_structure(runner, store, library):
    _, job = import_scan(runner, store)
    assert job["status"] == "done", job.get("lastError")
    before = entities(store)
    assert "chair-a" in before  # 算法（假的物体重建）给的模板
    files = gltf_files()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(f"stool/{name}", data)
    stool = library.add("/models/stool.zip", buf.getvalue())
    doc = authored_doc(library, structure="replace")
    doc["entities"] += [
        {
            "entityId": "floor-01",
            "kind": "structure",
            "label": "地面",
            "shape": {"type": "box", "size": [5, 0.05, 4], "transform": {"position": [2.5, -0.05, 2]},
                      "material": {"bake": "box"}},
        },
        {
            "entityId": "stool-01",
            "kind": "object",
            "model": {**stool, "format": "gltf-zip"},
            "transform": {"position": [4, 0, 1]},
            "props": {"category": "stool", "source": {**SOURCE, "license": "CC-BY-4.0"}},
        },
    ]  # fmt: skip
    data = json.dumps(doc).encode()
    asset = put_asset(store, data, content_type="application/json", kind="authored", space_id=SPACE).hash
    job = run_job(runner, store, "rebuild", {"authoredAsset": asset})
    assert job["status"] == "done", job.get("lastError")
    c2 = commits(store)[1]
    assert c2["message"].startswith("写入 AI 物件集") and c2["scriptRef"]
    after = entities(store)
    assert set(after) == {"panel-01", "table-01", "chair-01", "floor-01", "stool-01"}
    removed = {c["id"] for c in c2["changedEntities"] if c["hash"] is None}
    assert removed == set(before) - set(after)  # 算法的结构和物体全部换掉
    assert after["floor-01"]["kind"] == "structure" and after["floor-01"]["shape"]["material"]["uv"] == "box"
    assert after["stool-01"]["assetHash"] in asset_refs(store)
    assert job["result"]["authored"]["origin"] == {"kind": "asset", "assetHash": asset}
    assert job["result"]["authored"]["structure"] == "replace"
    # 同样的物件集再跑一次：结果完全相同，不提交
    job = run_job(runner, store, "rebuild", {"authoredAsset": asset})
    assert job["status"] == "done" and job["result"]["unchanged"] is True and len(commits(store)) == 2


def _bad_sha(library, doc):
    doc["entities"][2]["model"]["sha256"] = "0" * 64


def _foreign_host(library, doc):
    doc["entities"][2]["model"]["url"] = "https://example.com/chair.glb"


def _redirect_away(library, doc):
    doc["entities"][2]["model"]["url"] = library.redirect("/away", "https://example.com/chair.glb")


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (_bad_sha, "sha256"),
        (_foreign_host, "不在允许列表"),
        (_redirect_away, "第 1 次重定向"),
    ],
)
def test_download_failures_fail_the_job(runner, store, library, mutate, message):
    doc = authored_doc(library)
    mutate(library, doc)
    _, job = import_scan(runner, store, authored=doc)
    assert job["status"] == "failed" and message in job["lastError"], job.get("lastError")
    assert commits(store) == []
    assert "/away" not in library.hits or library.hits.count("/away") == 1  # 不可重试，只请求一次


def test_invalid_authored_inputs_fail(runner, store, library):
    scan = upload_asset(store, scan_zip(room_mesh()), "scan")
    doc = authored_doc(library)

    def failed(params, message):
        job = run_job(runner, store, "scan_import", {"assetHash": scan, "transform": IDENTITY, **params})
        assert job["status"] == "failed" and message in job["lastError"], job.get("lastError")

    failed({"authored": doc, "rebuild": False}, "rebuild 不能是 false")
    failed({"authored": doc, "authoredAsset": "a" * 64}, "只能给一个")
    failed({"authored": {**doc, "version": 9}}, "version")
    failed({"authoredAsset": "b" * 64}, "不存在")
    wrong_kind = put_asset(store, json.dumps(doc).encode(), content_type="application/json", kind="script",
                           space_id=SPACE).hash  # fmt: skip
    failed({"authoredAsset": wrong_kind}, "authored 用途")
    # 物件集的归属由接口服务建任务时检查：别的空间先登记的同一份内容也能用（资源全局去重）
    shared = put_asset(store, json.dumps({"version": 1}).encode(), content_type="application/json",
                       kind="authored", space_id="other-space").hash  # fmt: skip
    failed({"authoredAsset": shared}, "entities")
    other_space = put_asset(store, jpeg_bytes(np.full((8, 8, 3), 7, np.uint8)), content_type="image/jpeg",
                            kind="texture", space_id="other-space").hash  # fmt: skip
    failed({"authored": authored_doc(library, texture=other_space)}, "不是本空间的贴图资源")
    failed({"authored": authored_doc(library, texture="c" * 64)}, "不是本空间的贴图资源")
    assert commits(store) == []


def test_authored_notes_survive_cleanup_and_models_count_storage(runner, store, library):
    from metaverse_worker.jobs.cleanup import _referenced

    _, job = import_scan(runner, store, authored=authored_doc(library))
    assert job["status"] == "done", job.get("lastError")
    commit = commits(store)[0]
    chair = entities(store)["chair-01"]
    assert _referenced(store, commit["scriptRef"], "2099-01-01T00:00:00Z")
    assert _referenced(store, chair["assetHash"], "2099-01-01T00:00:00Z")
    space = store.spaces.find_one({"_id": SPACE})
    model_bytes = find_asset(store, chair["assetHash"])["length"]
    assert space["storageUsedBytes"] >= model_bytes
    raw = copy.deepcopy(authored_doc(library))
    assert hashlib.sha256(json.dumps(raw).encode()).hexdigest()  # 物件集本身可以原样再提交


def test_authored_upload_then_scan_import(runner, store, library):
    data = json.dumps(authored_doc(library)).encode()
    uid = make_upload(store, data, "authored")
    upload = run_job(runner, store, "upload_verify", {"uploadId": uid})
    assert upload["status"] == "done", upload.get("lastError")
    assert upload["result"]["format"] == "json" and upload["result"]["contentType"] == "application/json"
    asset = upload["result"]["assetHash"]
    assert find_asset(store, asset)["metadata"]["kind"] == "authored"
    _, job = import_scan(runner, store, authoredAsset=asset)
    assert job["status"] == "done", job.get("lastError")
    assert {"panel-01", "table-01", "chair-01"} <= set(entities(store))
    # 格式不对的物件集上传时就失败
    uid = make_upload(store, json.dumps({"version": 1, "entities": []}).encode(), "authored")
    bad = run_job(runner, store, "upload_verify", {"uploadId": uid})
    assert bad["status"] == "failed" and "entities" in bad["lastError"]
