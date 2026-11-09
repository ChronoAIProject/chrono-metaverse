"""本地重建编排（`bundle.rebuild.rebuild_scan`）：原来处理服务"导入扫描""写回 AI 物件集"的重建语义，
去掉数据库以后照样成立（本机 https 模型库，不需要数据库）。

覆盖：对齐（首次自动、给定变换、重扫配准、误差超限转人工）；网页用模型带哈希；结构 + 物体；物体模块缺失时
只交结构；锚点按类别和提示；AI 物件集（烘焙、外部模型下载和重新导出、逐件偏差、结构 keep / replace、
notes、本地已有的贴图、结构贴图回退、同样的输入得到同样的结果）；下载和输入不合法时失败。
"""

from __future__ import annotations

import copy
import hashlib
import io
import math
import os
import zipfile

import numpy as np
import pytest

from conftest import jpeg_bytes, scan_zip
from https_server import serve
from metaverse_worker.authored import AuthoredError
from metaverse_worker.bundle import rebuild as br
from metaverse_worker.errors import PermanentJobError
from metaverse_worker.fetch import DownloadRejected
from metaverse_worker.processing.align import column_major
from metaverse_worker.processing.rebuild import structure_entities
from metaverse_worker.processing.scan import ScanMesh, rotation_y
from metaverse_worker.processing.structure import extract_structure
from synthetic import room_mesh
from test_authored import SOURCE, gltf_files, model_glb, room_with_table

FAKE = "fake_objects:reconstruct_objects"
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def rigid(theta_deg: float, t) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = rotation_y(math.radians(theta_deg))
    m[:3, 3] = t
    return m


def write_scan(tmp_path, mesh: ScanMesh, name: str = "scan.zip") -> str:
    path = tmp_path / name
    path.write_bytes(scan_zip(mesh))
    return str(path)


def run(tmp_path, scan: str, name: str = "work", **kwargs) -> dict:
    kwargs.setdefault("objects_target", FAKE)
    return br.rebuild_scan(scan, str(tmp_path / name), **kwargs)


@pytest.fixture
def library(tmp_path):
    with serve(str(tmp_path)) as server:
        yield server


def run_authored(tmp_path, library, doc: dict, name: str = "work", **kwargs) -> dict:
    scan = write_scan(tmp_path, room_with_table(), "table-room.zip")  # 扫描里有会议桌（算得出偏差）
    return run(
        tmp_path,
        scan,
        name,
        transform=IDENTITY,
        authored=doc,
        hosts=(library.host,),
        opener=library.opener(),
        **kwargs,
    )


# ---------------------------------------------------------------------------- 扫描 → 结构、物体、锚点


def test_first_scan_rebuilds_with_web_models_and_anchor_hints(tmp_path):
    # 提示只要求第二把椅子建座位锚点（假物体重建把它摆在 x = 2.4、z = 1.0）
    hints = {"k": 1, "objects": [{"center": [2.4, 0.45, 1.0], "kind": "chair", "anchor": True}]}
    out = run(tmp_path, write_scan(tmp_path, room_mesh()), hints=hints)
    assert out["alignment"]["method"] == "auto" and len(out["transform"]) == 16
    assert len(out["webModels"]) == 2
    for model in out["webModels"]:
        assert model["hash"] == br.sha256_file(model["path"]) and model["bytes"] == os.path.getsize(
            model["path"]
        )
    entities = out["entities"]
    assert {"floor", "chair-a", "chair-01", "chair-02", "table-01"} <= set(entities)
    assert set(out["structureIds"]) | set(out["objectIds"]) == set(entities)
    assert out["objectsSkipped"] is None and all(b["layer"] == "rebuilt" for b in entities.values())
    # 贴图都核对过哈希；物件引用的贴图都在结果里
    for sha, data in out["textures"].items():
        assert hashlib.sha256(data).hexdigest() == sha
    assert entities["table-01"]["shape"]["material"]["texture"] in out["textures"]
    assert set(entities["floor"]["textures"]) <= set(out["textures"])
    # 锚点：桌子建；椅子只建提示要求的那一把；没有标签的用类别的中文名
    anchors = out["anchors"]
    assert set(anchors) == {"seat-02", "table-01"}
    assert anchors["table-01"]["kind"] == "table" and anchors["table-01"]["label"] == "会议桌"
    assert anchors["seat-02"]["kind"] == "seat" and anchors["seat-02"]["label"] == "椅子"
    assert all(a["visibility"] == "public" and len(a["box"]) == 6 for a in anchors.values())
    assert out["metrics"]["objects"]["hints"] == hints and out["metrics"]["structure"]["walls"] >= 4
    assert out["authored"] is None and out["notes"] is None and out["models"] == {}


def test_objects_module_missing_gives_structure_only(tmp_path):
    out = run(
        tmp_path,
        write_scan(tmp_path, room_mesh()),
        objects_target="metaverse_worker.processing.no_such:reconstruct_objects",
        web_models=False,
    )
    assert out["objectsSkipped"] and out["objectIds"] == [] and out["webModels"] == []
    assert set(out["entities"]) == set(out["structureIds"]) and out["anchors"] == {}


def test_given_transform_registration_and_needs_alignment(tmp_path):
    room = room_mesh()
    first = run(tmp_path, write_scan(tmp_path, room, "first.zip"), "first", web_models=False)
    ref_transform = np.asarray(first["transform"]).reshape(4, 4).T
    reference = {"path": str(tmp_path / "first.zip"), "transform": first["transform"]}
    # 重扫：配准到参考扫描的坐标系
    truth = rigid(37.0, [1.5, 0.0, -0.7])
    rescan = ScanMesh(room.vertices @ truth[:3, :3].T + truth[:3, 3], room.faces, room.uv, room.texture)
    second = run(
        tmp_path,
        write_scan(tmp_path, rescan, "second.zip"),
        "second",
        reference=reference,
        objects_target="fake_objects:moved_objects",
        web_models=False,
    )
    assert second["alignment"]["method"] == "registered" and second["alignment"]["errorCm"] < 1.0
    np.testing.assert_allclose(
        np.asarray(second["transform"]).reshape(4, 4).T @ truth, ref_transform, atol=5e-3
    )
    assert second["entities"]["table-01"] != first["entities"]["table-01"]  # 挪了位置
    # 差太多的扫描：不往下做，给出建议的变换等人确认
    other = room_mesh(diagonal=False)
    other = ScanMesh(other.vertices * np.array([1.6, 1.0, 0.7]), other.faces, other.uv, other.texture)
    held = run(tmp_path, write_scan(tmp_path, other, "other.zip"), "other", reference=reference)
    assert held["needsAlignment"] is True and held["errorCm"] > held["maxErrorCm"] == br.ALIGN_MAX_ERROR_CM
    assert len(held["proposedTransform"]) == 16 and "entities" not in held
    # 人给出变换：直接用
    given = column_major(rigid(0, [0.1, 0, 0.2]))
    done = run(tmp_path, str(tmp_path / "other.zip"), "given", transform=given, web_models=False)
    assert done["transform"] == given and done["alignment"]["method"] == "given"


def test_bad_scan_and_transform_fail(tmp_path):
    junk = tmp_path / "junk.bin"
    junk.write_bytes(b"not a model at all")
    with pytest.raises(PermanentJobError, match="格式"):
        run(tmp_path, str(junk))
    with pytest.raises(PermanentJobError, match="transform"):
        run(tmp_path, write_scan(tmp_path, room_mesh()), transform=[1, 2, 3])


# ---------------------------------------------------------------------------- AI 物件集


def authored_doc(library, *, texture: str | None = None, **overrides) -> dict:
    model = library.add("/models/chair.glb", model_glb())
    entities = [
        {
            "entityId": "panel-01",
            "kind": "object",
            "label": "木饰面",
            "shape": {"type": "box", "size": [0.02, 1.0, 1.0], "transform": {"position": [0.01, 0.5, 2.0]},
                      "material": {"bake": "planar"}},
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
        entities.append(
            {
                "entityId": "poster-01",
                "kind": "object",
                "shape": {"type": "box", "size": [0.6, 0.9, 0.01], "transform": {"position": [1, 1, 0.01]},
                          "material": {"texture": texture, "uv": "planar"}},
            }
        )  # fmt: skip
    doc = {"version": 1, "entities": entities, "notes": "面板贴着西墙，烘焙；扶手椅来自模型库。"}
    doc.update(overrides)
    return doc


def test_authored_bakes_downloads_fits_and_keeps_structure(tmp_path, library):
    poster = hashlib.sha256(jpeg_bytes(np.full((8, 8, 3), 90, np.uint8))).hexdigest()
    out = run_authored(tmp_path, library, authored_doc(library, texture=poster), known_textures=[poster])
    entities = out["entities"]
    # 结构沿用算法结果，物体就是物件集里的（假的物体重建模块没有被调用：没有 chair-a 模板）
    structure = set(out["structureIds"])
    assert structure and set(entities) - structure == {"panel-01", "table-01", "chair-01", "poster-01"}
    # 烘焙：面板的贴图在结果里
    texture = entities["panel-01"]["shape"]["material"]["texture"]
    assert texture in out["textures"]
    # 偏差：扫描里的会议桌写了 fit；面板贴墙、扫描里分不出来，不写
    assert entities["table-01"]["fit"]["meanCm"] < 1.0 and "fit" not in entities["panel-01"]
    # 外部模型：下载、重新导出，物件只引用处理后的模型（底面中心在摆放位置）
    chair = entities["chair-01"]
    model = out["models"][chair["assetHash"]]
    assert br.sha256_file(model["path"]) == chair["assetHash"]
    assert chair["props"]["source"] == SOURCE and "shape" not in chair
    lo, hi = chair["bounds"]["min"], chair["bounds"]["max"]
    assert np.allclose([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2], [2.5, 0, 1.5], atol=1e-3)
    # 本地已有的贴图原样引用、单独列出（写包时带上这个文件）
    assert entities["poster-01"]["textures"] == [poster] and out["existingTextures"] == [poster]
    assert poster not in out["textures"]
    assert out["notes"] == "面板贴着西墙，烘焙；扶手椅来自模型库。"
    # 锚点规则不变：桌子建，椅子没被提示要求不建
    assert set(out["anchors"]) == {"table-01"}
    summary = out["authored"]
    assert summary["structure"] == "keep" and summary["entities"] == 4
    assert summary["downloads"] == {"models": 1, "files": 1, "bytes": len(model_glb()), "redirects": 0}
    assert summary["models"]["files"] == 1 and summary["bake"]["textured"] == 1
    fits = {f["entityId"]: f for f in summary["fit"]}
    assert fits["table-01"]["meanCm"] == entities["table-01"]["fit"]["meanCm"]
    assert "meanCm" not in fits["panel-01"] and fits["panel-01"]["points"] > 0


def test_authored_replace_structure_with_gltf_zip_is_repeatable(tmp_path, library):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in gltf_files().items():
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
    out = run_authored(tmp_path, library, doc)
    entities = out["entities"]
    assert set(entities) == {"panel-01", "table-01", "chair-01", "floor-01", "stool-01"}
    assert out["structureIds"] == ["floor-01"] and out["authored"]["structure"] == "replace"
    assert entities["floor-01"]["shape"]["material"]["uv"] == "box"
    assert entities["stool-01"]["assetHash"] in out["models"]
    # 同样的物件集再跑一次：物件、贴图、模型都完全相同（重新推送时没有变化）
    again = run_authored(tmp_path, library, doc, "again")
    assert again["entities"] == entities and again["textures"] == out["textures"]
    assert set(again["models"]) == set(out["models"]) and again["anchors"] == out["anchors"]


def _baseline_structure(texture_of) -> list[dict]:
    """本地基线算的结构物件，贴图哈希换成 `texture_of(原哈希)`。"""
    bodies, _ = structure_entities(extract_structure(room_with_table()))
    out = []
    for _, body in sorted(bodies.items()):
        body = {k: v for k, v in copy.deepcopy(body).items() if k not in ("textures", "fit")}
        shape = body["shape"]
        for node in [shape, *(shape.get("children") or [])]:
            material = node.get("material") or {}
            if "texture" in material:
                material["texture"] = texture_of(material["texture"])
        out.append(body)
    return out


def test_structure_textures_without_local_files_fall_back(tmp_path, library):
    """结构物件引用的贴图本地没有（基线用别的依赖版本算的）：换成本次算出的贴图，列出替换清单；本地有的
    贴图照常引用、不回退。"""
    poster = "e" * 64
    doc = authored_doc(library, texture=poster, structure="replace")
    doc["entities"] += _baseline_structure(lambda sha: hashlib.sha256(f"base\0{sha}".encode()).hexdigest())
    out = run_authored(tmp_path, library, doc, known_textures=[poster])
    replaced = out["authored"]["textureFallback"]
    assert replaced and {r["entityId"] for r in replaced} <= set(out["structureIds"])
    for item in replaced:
        body = out["entities"][item["entityId"]]
        assert item["to"] in body["textures"] and item["from"] not in body["textures"]
        assert item["to"] in out["textures"]
    assert out["entities"]["poster-01"]["textures"] == [poster] and all(r["from"] != poster for r in replaced)


def test_object_texture_without_local_file_fails(tmp_path, library):
    """物体引用的贴图本地没有、本次也没算出：不能回退，整个重建失败。"""
    with pytest.raises(PermanentJobError, match="本次任务也没有算出"):
        run_authored(tmp_path, library, authored_doc(library, texture="c" * 64))


def _bad_sha(library, doc):
    doc["entities"][2]["model"]["sha256"] = "0" * 64


def _foreign_host(library, doc):
    doc["entities"][2]["model"]["url"] = "https://example.com/chair.glb"


def _redirect_away(library, doc):
    doc["entities"][2]["model"]["url"] = library.redirect("/away", "https://example.com/chair.glb")


@pytest.mark.parametrize(
    ("mutate", "message"),
    [(_bad_sha, "sha256"), (_foreign_host, "不在允许列表"), (_redirect_away, "第 1 次重定向")],
)
def test_download_failures_stop_the_rebuild(tmp_path, library, mutate, message):
    doc = authored_doc(library)
    mutate(library, doc)
    with pytest.raises(DownloadRejected, match=message):
        run_authored(tmp_path, library, doc)
    assert library.hits.count("/away") <= 1  # 不可重试的错误只请求一次


def test_invalid_authored_documents_fail(tmp_path, library):
    with pytest.raises(AuthoredError, match="version"):
        run_authored(tmp_path, library, {**authored_doc(library), "version": 9})
    with pytest.raises(AuthoredError, match="entities"):
        run_authored(tmp_path, library, {"version": 1})


def test_model_hosts_come_from_the_environment(monkeypatch):
    from metaverse_worker.bundle import sources
    from metaverse_worker.fetch import DEFAULT_MODEL_HOSTS

    monkeypatch.delenv(sources.HOSTS_ENV, raising=False)
    assert sources.default_hosts() == DEFAULT_MODEL_HOSTS
    monkeypatch.setenv(sources.HOSTS_ENV, "dl.polyhaven.org, .HF.co")
    assert sources.default_hosts() == ("dl.polyhaven.org", ".hf.co")
    monkeypatch.setenv(sources.HOSTS_ENV, "http://dl.polyhaven.org")
    with pytest.raises(ValueError):
        sources.default_hosts()
