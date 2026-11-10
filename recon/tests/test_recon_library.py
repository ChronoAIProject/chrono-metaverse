"""模型库检索：许可过滤（固定的小元数据样本，不联网）、Objaverse 本地索引、Poly Haven 检索、Sketchfab 开关、
glTF 打包成 glb。"""

from __future__ import annotations

import base64
import gzip
import json
import struct
import typing

import numpy as np
import pytest

from conftest import png_bytes
from metaverse_recon.bench import models as md
from metaverse_recon.bench.core import ReconError
from metaverse_recon.bench.library import gltf, http, licenses, objaverse, polyhaven, search, sketchfab


@pytest.mark.parametrize(
    ("raw", "spdx"),
    [
        ("by", "CC-BY-4.0"),
        ("cc0", "CC0-1.0"),
        ("CC0-1.0", "CC0-1.0"),
        ("CC-BY-4.0", "CC-BY-4.0"),
        ({"slug": "by", "label": "CC Attribution"}, "CC-BY-4.0"),
        ({"label": "CC Attribution"}, "CC-BY-4.0"),
        ("by-sa", None),
        ("by-nc", None),
        ("by-nd", None),
        ("by-nc-sa", None),
        ("by-nc-nd", None),
        ("CC-BY-SA-4.0", None),
        ("CC Attribution-NonCommercial", None),
        ("st", None),
        ("ed", None),
        ("", None),
        (None, None),
        ("mit", None),
    ],
)
def test_license_normalize(raw, spdx):
    assert licenses.normalize(raw) == spdx


def meta_item(uid, name, lic, tags=(), faces=1000, cats=(), restricted=False):
    return {
        "uid": uid,
        "name": name,
        "license": lic,
        "faceCount": faces,
        "isAgeRestricted": restricted,
        "tags": [{"name": t} for t in tags],
        "categories": [{"name": c} for c in cats],
        "description": "",
        "user": {"displayName": f"author-{uid}", "profileUrl": f"https://sketchfab.com/u{uid}"},
        "thumbnails": {
            "images": [
                {"url": f"https://media.sketchfab.com/{uid}/1024.jpg", "width": 1024},
                {"url": f"https://media.sketchfab.com/{uid}/256.jpg", "width": 256},
            ]
        },
        "viewerUrl": f"https://sketchfab.com/3d-models/{uid}",
        "likeCount": 3,
    }


SHARD = {
    "a" * 32: meta_item("a" * 32, "Beige Leather Sofa", "by", ["sofa", "leather"]),
    "b" * 32: meta_item("b" * 32, "Leather Sofa NC", "by-nc", ["sofa"]),
    "c" * 32: meta_item("c" * 32, "Sofa share alike", "by-sa", ["sofa"]),
    "d" * 32: meta_item("d" * 32, "Public sofa", "cc0", ["couch"]),
    "e" * 32: meta_item("e" * 32, "Sofa no derivs", "by-nd", ["sofa"]),
    "f" * 32: meta_item("f" * 32, "Huge sofa", "by", ["sofa"], faces=5_000_000),
    "0" * 32: meta_item("0" * 32, "Office chair", "by", ["chair"]),
    "1" * 32: meta_item("1" * 32, "Sofa restricted", "by", ["sofa"], restricted=True),
}


@pytest.fixture
def objaverse_db(tmp_path, monkeypatch):
    monkeypatch.setenv("METAVERSE_RECON_OBJAVERSE_DB", str(tmp_path / "index.sqlite"))
    monkeypatch.setenv("METAVERSE_RECON_CACHE", str(tmp_path / "cache"))

    def fake_get_bytes(url, **_):
        assert url.endswith("/metadata/000-000.json.gz"), url
        return gzip.compress(json.dumps(SHARD).encode())

    monkeypatch.setattr(http, "get_bytes", fake_get_bytes)
    con = objaverse.connect()
    with con:
        con.executemany("INSERT INTO lvis VALUES (?, ?)", [("a" * 32, "sofa"), ("0" * 32, "chair")])
        con.execute("INSERT INTO meta VALUES ('lvis', '2')")
    kept = objaverse.index_shards(con, ["000-000"])
    con.close()
    return kept


def test_objaverse_index_keeps_only_cc0_and_cc_by(objaverse_db):
    assert objaverse_db == 4  # a、d、f、0；NC、SA、ND、年龄限制的都不进索引
    res, status = objaverse.search("leather sofa", None, 300_000, 10, max_new_shards=0, offline=True)
    ids = [c["id"] for c in res]
    assert ids[0] == "a" * 32  # 名称、标签、LVIS 类别都匹配
    assert set(ids) <= {"a" * 32, "d" * 32}  # 面数超限的 f 不要；NC/SA/ND 不在
    a = res[0]
    assert a["license"] == "CC-BY-4.0" and a["author"] == "author-" + "a" * 32
    assert a["page"].startswith("https://sketchfab.com/3d-models/")
    assert a["download"]["url"].endswith(f"/glbs/000-000/{'a' * 32}.glb")
    assert a["thumbnail"].endswith("/256.jpg")
    assert status["shardsIndexed"] == 1


def test_objaverse_category_filter(objaverse_db):
    res, status = objaverse.search("sofa", "sofa", 10_000_000, 10, max_new_shards=0, offline=True)
    assert status["lvis"] == ["sofa"]
    assert res[0]["id"] == "a" * 32
    chairs, _ = objaverse.search("chair", "chair", 10_000_000, 10, max_new_shards=0, offline=True)
    assert [c["id"] for c in chairs] == ["0" * 32]


CATALOG = {
    "sofa_02": {
        "name": "Sofa 02",
        "tags": ["sofa", "leather"],
        "categories": ["furniture", "seating"],
        "authors": {"Someone": "All"},
        "polycount": 2728,
        "dimensions": [1807, 818, 709],
    },
    "lamp_01": {
        "name": "Lamp",
        "tags": ["lamp"],
        "categories": ["lighting"],
        "authors": {"B": "All"},
        "polycount": 300,
    },
    "big_sofa": {
        "name": "Big Sofa",
        "tags": ["sofa"],
        "categories": ["furniture"],
        "authors": {"C": "All"},
        "polycount": 900_000,
    },
}


def test_polyhaven_search_is_cc0_and_respects_limits(monkeypatch):
    monkeypatch.setattr(polyhaven, "assets", lambda offline=False: CATALOG)
    res = polyhaven.search("leather sofa", "sofa", 300_000, 5)
    assert [c["id"] for c in res] == ["sofa_02"]
    c = res[0]
    assert c["license"] == "CC0-1.0" and c["page"] == "https://polyhaven.com/a/sofa_02"
    assert c["dimensionsM"] == [1.807, 0.709, 0.818]  # Blender z 向上 → [宽, 高, 深]
    assert "format=webp" not in c["thumbnail"]


def test_sketchfab_disabled_without_token_and_filters_licenses(monkeypatch):
    monkeypatch.delenv("SKETCHFAB_TOKEN", raising=False)
    assert not sketchfab.enabled() and sketchfab.search("sofa", None, 1000, 5) == []
    monkeypatch.setattr(polyhaven, "assets", lambda offline=False: CATALOG)
    res = search.run_search("sofa", ["polyhaven", "sketchfab"], None, 300_000, 5)
    assert "SKETCHFAB_TOKEN" in res["sketchfab"] and all(
        c["library"] == "polyhaven" for c in res["candidates"]
    )
    items = [
        {
            "uid": "u1",
            "name": "A",
            "license": {"slug": "by", "label": "CC Attribution"},
            "user": {"username": "x"},
        },
        {"uid": "u2", "name": "B", "license": {"slug": "by-nc"}},
        {"uid": "u3", "name": "C", "license": {"slug": "st", "label": "Standard"}},
        {"uid": "u4", "name": "D", "license": {"slug": "cc0"}},
        {"uid": "u5", "name": "E", "license": {"label": "CC Attribution-ShareAlike"}},
    ]
    assert [c["id"] for c in sketchfab.filter_results(items)] == ["u1", "u4"]


def test_interleave_and_aspect_bonus():
    a = [{"id": i} for i in "abc"]
    b = [{"id": i} for i in "xy"]
    assert [c["id"] for c in search.interleave([a, b], 4)] == ["a", "x", "b", "y"]
    assert search.aspect_bonus([1.8, 0.7, 0.9], [1.75, 0.77, 1.1]) > search.aspect_bonus(
        [0.5, 1.8, 0.5], [1.75, 0.77, 1.1]
    )


def tiny_gltf():
    pos = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], "<f4").tobytes()
    uv = np.array([[0, 0], [1, 0], [0, 1]], "<f4").tobytes()
    idx = struct.pack("<3H", 0, 1, 2) + b"\0\0"
    buf = pos + uv + idx
    img = png_bytes(np.full((4, 4, 3), 200, np.uint8))
    doc = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "translation": [0, 0, 5]}],
        "meshes": [
            {"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "indices": 2, "material": 0}]}
        ],
        "materials": [
            {
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": 1},
                    "metallicRoughnessTexture": {"index": 0},
                },
                "normalTexture": {"index": 0},
            }
        ],
        "textures": [{"source": 0}, {"source": 1}],
        "images": [{"uri": "textures/nor.png"}, {"uri": "textures/diff%20map.png"}],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": 3,
                "type": "VEC3",
                "min": [0, 0, 0],
                "max": [1, 1, 0],
            },
            {"bufferView": 1, "componentType": 5126, "count": 3, "type": "VEC2"},
            {"bufferView": 2, "componentType": 5123, "count": 3, "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": 36},
            {"buffer": 0, "byteOffset": 36, "byteLength": 24},
            {"buffer": 0, "byteOffset": 60, "byteLength": 6},
        ],
        "buffers": [{"uri": "m.bin", "byteLength": len(buf)}],
    }
    files = {"m.bin": buf, "textures/nor.png": img, "textures/diff map.png": img}
    return json.dumps(doc).encode(), files


def test_pack_gltf_is_deterministic_and_keeps_base_color(tmp_path):
    g, files = tiny_gltf()
    assert gltf.referenced_files(g) == ["m.bin", "textures/nor.png", "textures/diff%20map.png"]
    a = gltf.pack_gltf(g, files)
    assert a == gltf.pack_gltf(g, files)
    doc = json.loads(a[20 : 20 + struct.unpack("<I", a[12:16])[0]])
    assert (
        len(doc["images"]) == 1 and len(doc["textures"]) == 1 and "normalTexture" not in doc["materials"][0]
    )
    assert doc["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"] == 0
    path = tmp_path / "m.glb"
    path.write_bytes(a)
    m = md.load_model_file(str(path))  # 和处理服务同样的读法：节点变换展开
    assert m.triangles == 1 and m.texture is not None
    assert m.vertices[:, 2] == pytest.approx([5, 5, 5])
    with pytest.raises(ReconError, match="没有下载"):
        gltf.pack_gltf(g, {"m.bin": files["m.bin"]})
    data_uri = json.loads(g)
    data_uri["buffers"][0]["uri"] = (
        "data:application/octet-stream;base64," + base64.b64encode(files["m.bin"]).decode()
    )
    with pytest.raises(ReconError, match="目录外"):
        gltf._resolve("../etc/passwd", {})
    assert gltf.pack_gltf(json.dumps(data_uri).encode(), files)[:4] == b"glTF"


def test_download_respects_size_limit(tmp_path, monkeypatch):
    class Resp:
        headers: typing.ClassVar[dict] = {"Content-Length": "100"}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self, n):
            return b""

    with pytest.raises(http.DownloadError, match="https"):
        http.request("http://huggingface.co/x")
    monkeypatch.setattr(http, "request", lambda *a, **k: Resp())
    with pytest.raises(http.DownloadError, match="超过上限"):
        http.download("https://huggingface.co/x.glb", tmp_path / "x.glb", max_bytes=10)
    assert not list(tmp_path.iterdir())  # 临时文件删掉了
