"""打包和本地流水线的命令（设计 8.3、6.1–6.4、6.8）：上限、扫描 zip、贴图引用、清单、`bundle`（物件集、
`--seed`、`--from-snapshot`）、`models`、`align`、`webmodel`、`bake`、`fit`、`scan-zip`、工作区交接、
`doctor --install`。都用小的合成数据，不联网（下载用桩或本机文件）。"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import zipfile
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from conftest import scan_zip
from metaverse_recon.authored import AuthoredError
from metaverse_recon.bench import cli
from metaverse_recon.bench import env as benv
from metaverse_recon.bench import workspace as ws
from metaverse_recon.bench.core import ReconError
from metaverse_recon.bundle import limits as bl
from metaverse_recon.bundle import manifest as bm
from metaverse_recon.bundle import scanzip as bz
from metaverse_recon.bundle import textures as bt
from metaverse_recon.bundle.build import build_bundle
from metaverse_recon.bundle.snapshot import build_from_snapshot
from metaverse_recon.errors import InputRejected
from metaverse_recon.records import rotated_model_bounds, validate_anchor_body, validate_entity_body
from recon_support import make_base
from synthetic import room_mesh
from test_authored import SHA, doc, model_glb, room_with_table

VECTORS = Path(__file__).resolve().parents[2] / "api" / "crates"
CORE_VECTORS = VECTORS / "metaverse-core" / "tests" / "vectors"
API_VECTORS = VECTORS / "metaverse-api" / "tests" / "vectors"
FAKE = "fake_objects:reconstruct_objects"
IDENTITY = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def jpeg(color, size=(16, 16)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def run_cli(*argv: str) -> int:
    return cli.main(list(argv))


# ---------------------------------------------------------------------------- 上限


def test_default_upload_limits_match_the_shared_vector():
    vector = json.loads((CORE_VECTORS / "bundle" / "bundle_limits_default.json").read_text("utf-8"))
    assert bl.default_upload_limits() == vector["limits"]
    parsed = bl.parse_upload_limits({"v": 1, "model": {"maxTriangles": 5000}, "texture": {"maxSide": 1024}})
    assert parsed["model"]["maxTriangles"] == 5000 and parsed["texture"]["maxSide"] == 1024
    assert parsed["webmodel"] == vector["limits"]["webmodel"]
    proc = bl.processing_limits(parsed)
    assert proc["model_max_triangles"] == 5000 and proc["model_max_texture_pixels"] == 16777216
    for bad in (
        {"v": 2},
        {"v": 1, "model": {"maxTriangles": 0}},
        {"v": 1, "texture": {"maxSide": "4096"}},
        [],
    ):
        with pytest.raises(InputRejected):
            bl.parse_upload_limits(bad)


# ---------------------------------------------------------------------------- 扫描 zip


def test_scan_zip_matches_the_api_packing_vector(tmp_path):
    vector = json.loads((API_VECTORS / "demo_seed_zip.json").read_text("utf-8"))
    members = [(m["name"], base64.b64decode(m["base64"])) for m in vector["members"]]
    data = bz.stored_zip_bytes(members)
    assert data == base64.b64decode(vector["zipBase64"])
    assert hashlib.sha256(data).hexdigest() == vector["zipSha256"]
    # 命令行：成员名=本地文件，按给出的顺序
    paths = []
    for name, payload in members:
        p = tmp_path / name
        p.write_bytes(payload)
        paths.append(f"{name}={p}")
    out = tmp_path / "scan.zip"
    args = ["scan-zip", "--out", str(out), "--hash", vector["zipSha256"]]
    for p in paths:
        args += ["--member", p]
    assert run_cli(*args) == 0
    assert out.read_bytes() == data
    # 顺序不同，哈希就不同：报错
    args = ["scan-zip", "--out", str(tmp_path / "x.zip"), "--hash", vector["zipSha256"]]
    for p in reversed(paths):
        args += ["--member", p]
    assert run_cli(*args) == 2


def test_scan_zip_members_from_a_sources_table(tmp_path, monkeypatch):
    vector = json.loads((API_VECTORS / "demo_seed_zip.json").read_text("utf-8"))
    payload = {m["name"]: base64.b64decode(m["base64"]) for m in vector["members"]}
    calls = []

    def fake_fetch(url, dest, *, sha256, size, hosts, timeout, opener):
        name = url.rsplit("/", 1)[1]
        assert hashlib.sha256(payload[name]).hexdigest() == sha256 and len(payload[name]) == size
        calls.append(url)
        Path(dest).write_bytes(payload[name])

    monkeypatch.setattr(bz, "fetch", fake_fetch)
    monkeypatch.setattr(bz, "build_opener", lambda: None)
    sources = {
        "format": "chrono-metaverse-bundle-sources",
        "version": 1,
        "files": {
            vector["zipSha256"]: {
                "zip": [
                    {
                        "name": m["name"],
                        "url": f"https://scaniverse.com/m/{m['name']}",
                        "sha256": m["sha256"],
                        "size": len(base64.b64decode(m["base64"])),
                    }
                    for m in vector["members"]
                ]
            },
            "b" * 64: {"url": "https://github.com/x/b.glb"},
        },
    }
    (tmp_path / "sources.json").write_text(json.dumps(sources))
    out = tmp_path / "scan.zip"
    assert run_cli("scan-zip", "--sources", str(tmp_path / "sources.json"), "--out", str(out)) == 0
    assert hashlib.sha256(out.read_bytes()).hexdigest() == vector["zipSha256"]
    assert len(calls) == 2


def test_reading_someone_elses_scan_zip_is_bounded(tmp_path):
    def make(entries, flags=0):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            for name, data in entries:
                info = zipfile.ZipInfo(name)
                info.flag_bits |= flags
                zf.writestr(info, data)
        path = tmp_path / f"z{len(list(tmp_path.iterdir()))}.zip"
        path.write_bytes(buf.getvalue())
        return str(path)

    ok = make([("mesh.drc", b"DRACO"), ("__MACOSX/._mesh.drc", b"x"), (".DS_Store", b"x")])
    assert [i.filename for i in bz.check_scan_zip(ok)] == ["mesh.drc"]
    for entries, message in (
        ([("../mesh.drc", b"x")], "路径"),
        ([("/abs/mesh.drc", b"x")], "路径"),
        ([("big.bin", b"x" * 100)], "解压后"),
    ):
        with pytest.raises(InputRejected, match=message):
            bz.check_scan_zip(make(entries), max_unpacked=50)


# ---------------------------------------------------------------------------- 贴图引用


def _authored_cases(name: str) -> list[dict]:
    return json.loads((CORE_VECTORS / "authored" / f"{name}.json").read_text("utf-8"))["cases"]


def test_authored_texture_vectors():
    for case in _authored_cases("authored_texture_urls_valid"):
        assert bt.check_authored(case["authored"]) == case["summary"], case["name"]
    for case in _authored_cases("authored_texture_urls_invalid"):
        with pytest.raises(AuthoredError) as err:
            bt.check_authored(case["authored"])
        assert case["where"].rsplit(".", 1)[-1] in str(err.value), (case["name"], str(err.value))


def test_texture_refs_become_files_and_hashes(tmp_path):
    marble = jpeg((220, 220, 215))
    (tmp_path / "textures").mkdir()
    (tmp_path / "textures" / "m.jpg").write_bytes(marble)
    big = io.BytesIO()
    Image.new("RGB", (64, 32), (10, 20, 30)).save(big, format="PNG")
    url_sha = hashlib.sha256(big.getvalue()).hexdigest()
    known = jpeg((1, 2, 3))
    known_sha = hashlib.sha256(known).hexdigest()
    (tmp_path / "base").mkdir()
    (tmp_path / "base" / f"{known_sha}.jpg").write_bytes(known)
    doc_ = {
        "version": 1,
        "entities": [
            {
                "entityId": "a",
                "kind": "object",
                "shape": {
                    "type": "box",
                    "size": [1, 1, 1],
                    "material": {
                        "texture": {"file": "textures/m.jpg"},
                        "uv": "planar",
                        "tile": [1, 1],
                        "normalMap": {
                            "url": "https://dl.polyhaven.org/n.png",
                            "sha256": url_sha,
                            "size": len(big.getvalue()),
                        },
                    },
                },
            },
            {
                "entityId": "b",
                "kind": "object",
                "shape": {
                    "type": "box",
                    "size": [1, 1, 1],
                    "material": {"texture": {"file": "textures/m.jpg"}, "uv": "box"},
                },
            },
            {
                "entityId": "c",
                "kind": "object",
                "shape": {"type": "box", "size": [1, 1, 1], "material": {"texture": known_sha, "uv": "box"}},
            },
        ],
    }
    downloads = []

    def fake_download(url, dest, *, sha256, size, hosts, opener):
        downloads.append(url)
        Path(dest).write_bytes(big.getvalue())

    limits = {**bl.default_upload_limits()["texture"], "maxSide": 32}
    out, files, stats = bt.resolve_texture_refs(
        doc_,
        base_dir=str(tmp_path),
        workdir=str(tmp_path / "w"),
        texture_limits=limits,
        search_dirs=[str(tmp_path / "base")],
        download=fake_download,
        opener=object(),
    )
    mat_a = out["entities"][0]["shape"]["material"]
    mat_b = out["entities"][1]["shape"]["material"]
    assert mat_a["texture"] == mat_b["texture"] == hashlib.sha256(marble).hexdigest()
    # 外链的法线贴图 64×32 超过边长上限 32：缩小、重新编码，换成新的哈希
    assert mat_a["normalMap"] != url_sha and mat_a["normalMap"] in files
    with Image.open(files[mat_a["normalMap"]]) as im:
        assert max(im.size) == 32
    assert out["entities"][2]["shape"]["material"]["texture"] == known_sha and known_sha in files
    assert stats == {"hashes": 1, "urls": 1, "files": 1, "shrunk": 1} and downloads == [
        "https://dl.polyhaven.org/n.png"
    ]
    for name, data in files.items():
        assert hashlib.sha256(Path(data).read_bytes()).hexdigest() == name
    # 本地文件跑出物件集所在的目录、不存在：报错
    doc_["entities"][1]["shape"]["material"]["texture"] = {"file": "textures/none.jpg"}
    with pytest.raises(AuthoredError, match="找不到"):
        bt.resolve_texture_refs(
            doc_,
            base_dir=str(tmp_path),
            workdir=str(tmp_path / "w2"),
            texture_limits=limits,
            download=fake_download,
            opener=object(),
        )


# ---------------------------------------------------------------------------- 清单


def test_rb_prefix_and_template_references():
    templates = [
        {
            "entityId": "chair-a",
            "kind": "template",
            "layer": "rebuilt",
            "shape": {"type": "box", "size": [1, 1, 1]},
        }
    ]
    entities = [
        {
            "entityId": "c1",
            "kind": "object",
            "layer": "rebuilt",
            "shape": {
                "type": "group",
                "children": [{"type": "instance", "template": "chair-a"}, {"type": "box", "size": [1, 1, 1]}],
            },
        },
        {"entityId": "rb.keep", "kind": "object", "shape": {"type": "instance", "template": "chair-a"}},
    ]
    t, e, mapping = bm.prefixed_records(templates, entities)
    assert [b["entityId"] for b in t] == ["rb.chair-a"] and [b["entityId"] for b in e] == ["rb.c1", "rb.keep"]
    assert (
        e[0]["shape"]["children"][0]["template"] == "rb.chair-a" and e[1]["shape"]["template"] == "rb.chair-a"
    )
    assert all(b["layer"] == "rebuilt" for b in [*t, *e]) and mapping["rb.keep"] == "rb.keep"
    with pytest.raises(InputRejected, match="128"):
        bm.rb_id("x" * 127)


def test_manifest_layout_and_limits(tmp_path):
    w = bm.BundleWriter(str(tmp_path), bl.default_upload_limits())
    src = tmp_path / "a.jpg"
    src.write_bytes(jpeg((5, 5, 5)))
    sha = w.texture(str(src))
    assert w.texture(str(src)) == sha and len(w.files) == 1  # 同一哈希只放一次
    entity = {
        "entityId": "rb.a",
        "layer": "rebuilt",
        "kind": "object",
        "shape": {"type": "box", "size": [1, 1, 1], "material": {"texture": sha, "uv": "box"}},
        "textures": [sha],
        "bounds": {"min": [-0.5, 0, -0.5], "max": [0.5, 1, 0.5]},
        "props": {},
    }
    manifest, digest = bm.write_manifest(
        w,
        note="测试",
        base={"spaceId": "demo-space", "seq": 3},
        scan=None,
        templates=[],
        entities=[entity],
        anchors=[{"anchorId": "a", "kind": "table", "box": [0, 0, 0, 1, 1, 1], "visibility": "public"}],
        notes_sha=None,
        report={"fit": {"meanCm": 1.0}},
    )
    text = (tmp_path / "manifest.json").read_text("utf-8")
    assert hashlib.sha256(text.encode()).hexdigest() == digest
    assert json.loads(text) == manifest
    assert manifest["format"] == "chrono-metaverse-rebuild-bundle" and manifest["version"] == 1
    assert manifest["tool"]["name"] == "metaverse-recon" and manifest["base"] == {
        "spaceId": "demo-space",
        "seq": 3,
    }
    # 记录各占一行、不缩进
    lines = text.splitlines()
    assert json.dumps(entity, ensure_ascii=False, separators=(",", ":"), sort_keys=True) in [
        ln.strip().rstrip(",") for ln in lines
    ]
    assert manifest["files"] == [
        {"path": f"textures/{sha[:12]}.jpg", "purpose": "texture", "sha256": sha, "size": src.stat().st_size}
    ]
    huge = dict(entity, props={"x": "y" * 70000})
    with pytest.raises(InputRejected, match="64 KiB"):
        bm.check_records({"note": "x", "rebuilt": {"entities": [huge]}})
    with pytest.raises(InputRejected, match="note"):
        bm.check_records({"note": " ", "rebuilt": {}})
    small = bl.default_upload_limits()
    small["texture"]["maxBytes"] = 10
    with pytest.raises(InputRejected, match="上传上限"):
        bm.BundleWriter(str(tmp_path / "x"), small).texture(str(src))


def test_seed_filter_and_fit_report():
    anchors = [{"anchorId": "a", "visibility": "public"}, {"anchorId": "b", "visibility": "internal"}]
    kept, report, dropped = bm.seed_filter(anchors, {"fit": {"meanCm": 2}, "models": {"files": 3}})
    assert kept == [anchors[0]] and report == {"fit": {"meanCm": 2}} and dropped == 1
    fit = bm.fit_report(
        [
            {"meanCm": 1.0, "p90Cm": 2.0, "coverage3cm": 1.0, "points": 300},
            {"meanCm": 5.0, "p90Cm": 9.0, "coverage3cm": 0.0, "points": 100},
            {"points": 50},
        ]
    )
    assert fit == {"meanCm": 2.0, "p90Cm": 3.75, "within3cm": 0.75, "entities": 2, "points": 400}


# ---------------------------------------------------------------------------- bundle


def model_dir(tmp_path) -> Path:
    """工作台 fetch 的缓存：旁注 model.json 记着来源文件的 sha256，本机文件是 model.glb。"""
    d = tmp_path / "models" / "objaverse" / "chair"
    d.mkdir(parents=True)
    (d / "model.glb").write_bytes(model_glb())
    (d / "model.json").write_text(json.dumps({"model": {"sha256": SHA}, "local": {"path": "model.glb"}}))
    return tmp_path / "models"


def authored_for_bundle(tmp_path) -> Path:
    d = doc()
    # 第二把同款椅子，只有偏航和位置不同：共用一份 glb，偏航写进记录
    second = json.loads(json.dumps(d["entities"][-1]))
    second["entityId"] = "chair-02"
    second["transform"] = {"position": [3.2, 0, 2.0], "yaw": 90}
    d["entities"].append(second)
    # 工作台写进工作副本的贴图：{file}
    (tmp_path / "textures").mkdir()
    (tmp_path / "textures" / "wood.jpg").write_bytes(jpeg((150, 100, 60)))
    d["entities"][2]["shape"]["material"] = {
        "texture": {"file": "textures/wood.jpg"},
        "uv": "box",
        "tile": [0.5, 0.5],
        "shading": "albedo",
    }
    path = tmp_path / "authored.json"
    path.write_text(json.dumps(d, ensure_ascii=False))
    return path


def bundle_inputs(tmp_path) -> Path:
    d = tmp_path / "in"
    if not d.exists():
        d.mkdir()
        (d / "scan.zip").write_bytes(scan_zip(room_with_table()))
        authored_for_bundle(d)
        model_dir(d)
    return d


def bundle_once(tmp_path, out: str, **extra) -> dict:
    d = bundle_inputs(tmp_path)
    args = dict(
        scan_path=str(d / "scan.zip"),
        transform=IDENTITY,
        out_dir=str(tmp_path / out),
        workdir=str(tmp_path / f"w-{out}"),
        upload_limits=bl.default_upload_limits(),
        authored_path=str(d / "authored.json"),
        model_dirs=[str(d / "models")],
        base={"spaceId": "demo-space", "seq": 4},
        check=False,
        objects_target=FAKE,
    )
    args.update(extra)
    return build_bundle(**args)


def read_bundle(path: Path) -> dict:
    return json.loads((path / "manifest.json").read_text("utf-8"))


def test_bundle_from_authored(tmp_path):
    res = bundle_once(tmp_path, "b1-out")
    out = tmp_path / "b1-out"
    m = read_bundle(out)
    entities = {b["entityId"]: b for b in m["rebuilt"]["entities"]}
    templates = {b["entityId"]: b for b in m["rebuilt"]["templates"]}
    assert m["rebuilt"]["mode"] == "replace" and m["base"] == {"spaceId": "demo-space", "seq": 4}
    assert set(templates) == {"rb.stool-a"} and all(e.startswith("rb.") for e in entities)
    assert entities["rb.stool-01"]["shape"]["template"] == "rb.stool-a"
    # 外部模型：同一个模型两个朝向共用一份 glb，偏航写进 transform，默认按固有色画
    c1, c2 = entities["rb.chair-01"], entities["rb.chair-02"]
    assert c1["assetHash"] == c2["assetHash"] and "transform" not in c1 and c2["transform"] == {"yaw": 90.0}
    assert c1["material"]["shading"] == "albedo" == c2["material"]["shading"]
    files = {f["sha256"]: f for f in m["files"]}
    model = files[c1["assetHash"]]
    assert model["purpose"] == "model" and model["path"].startswith("models/")
    # 记录的 bounds 是模型包围盒按偏航转过之后的外包（与接口服务的模型一致性检查相同的算法）
    from metaverse_recon.processing.modelexport import read_gltf

    src = read_gltf(str(out / model["path"]), max_triangles=10_000, max_pixels=1 << 20)
    lo, hi = src.bounds()
    turned = rotated_model_bounds({"min": lo.tolist(), "max": hi.tolist()}, c2["transform"])
    size = np.subtract(c2["bounds"]["max"], c2["bounds"]["min"])
    assert np.allclose(size, np.subtract(turned["max"], turned["min"]), atol=2e-4)
    # 贴图：工作台的 {file}、烘焙出的贴图都作为贴图文件进包，记录里只有哈希
    table_tex = entities["rb.table-01"]["shape"]["material"]["texture"]
    assert files[table_tex]["purpose"] == "texture"
    panel_tex = entities["rb.panel-01"]["shape"]["material"]["texture"]
    assert files[panel_tex]["purpose"] == "texture"
    for f in m["files"]:
        assert hashlib.sha256((out / f["path"]).read_bytes()).hexdigest() == f["sha256"]
        assert (out / f["path"]).stat().st_size == f["size"]
    # 扫描：给定的变换；网页用模型是生成的两档；建模记录作为 script
    assert m["scan"]["transform"] == IDENTITY and len(m["scan"]["webModelHashes"]) == 2
    assert files[m["scan"]["assetHash"]]["purpose"] == "scan" and files[m["notes"]]["purpose"] == "script"
    # 锚点：桌子按类别建议
    assert [a["anchorId"] for a in m["anchors"]] == ["table-01"]
    for a in m["anchors"]:
        validate_anchor_body(a)
    tmpl = {k: v["shape"] for k, v in templates.items()}
    for body in [*templates.values(), *entities.values()]:
        validate_entity_body(body, tmpl)
    assert res["renamed"] == len(entities) + len(templates)
    assert res["check"] == {"ran": False}
    # 同样的输入：记录和文件都相同（清单只有 createdAt 不同）
    again = bundle_once(tmp_path, "b1-again")
    m2 = read_bundle(tmp_path / "b1-again")
    assert m2["rebuilt"] == m["rebuilt"] and m2["files"] == m["files"] and m2["anchors"] == m["anchors"]
    assert again["entities"] == res["entities"]


def test_bundle_for_the_seed_drops_internal_and_notes(tmp_path, monkeypatch):
    import metaverse_recon.bundle.rebuild as br

    real = br.anchor_proposals

    def with_internal(entities, hints):
        out = real(entities, hints)
        out["back-office"] = {
            "anchorId": "back-office",
            "kind": "zone",
            "box": [0, 0, 0, 2, 2, 2],
            "visibility": "internal",
        }
        return out

    monkeypatch.setattr(br, "anchor_proposals", with_internal)
    res = bundle_once(tmp_path, "s1-out", seed=True)
    m = read_bundle(tmp_path / "s1-out")
    assert [a["anchorId"] for a in m["anchors"]] == ["table-01"] and res["droppedInternalAnchors"] == 1
    assert "notes" not in m and all(f["purpose"] != "script" for f in m["files"])
    assert set(m["report"]) == {"fit"}


def test_bundle_with_existing_webmodel_and_limits(tmp_path):
    web = tmp_path / "web.glb"
    web.write_bytes(model_glb())
    bundle_once(tmp_path, "w1-out", webmodels=[str(web)])
    m = read_bundle(tmp_path / "w1-out")
    assert m["scan"]["webModelHashes"] == [hashlib.sha256(model_glb()).hexdigest()]
    small = bl.default_upload_limits()
    small["scan"]["maxBytes"] = 100
    with pytest.raises(InputRejected, match="上传上限"):
        bundle_once(tmp_path, "w1-small", webmodels=[str(web)], upload_limits=small)


def test_from_snapshot_keeps_the_rebuilt_layer_except_ids(tmp_path):
    root = tmp_path / "ws"
    (root / "assets").mkdir(parents=True)
    glb = model_glb()
    gsha = hashlib.sha256(glb).hexdigest()
    (root / "assets" / f"{gsha}.glb").write_bytes(glb)
    tex = jpeg((9, 9, 9))
    tsha = hashlib.sha256(tex).hexdigest()
    (root / "assets" / f"{tsha}.jpg").write_bytes(tex)
    entities = [
        {
            "entityId": "chair-a",
            "layer": "rebuilt",
            "kind": "template",
            "shape": {"type": "box", "size": [0.5, 0.9, 0.5]},
            "bounds": {"min": [-0.25, 0, -0.25], "max": [0.25, 0.9, 0.25]},
            "props": {},
        },
        {
            "entityId": "chair-01",
            "layer": "rebuilt",
            "kind": "object",
            "anchorId": "seat-1",
            "shape": {"type": "instance", "template": "chair-a", "transform": {"position": [1, 0, 1]}},
            "bounds": {"min": [0.75, 0, 0.75], "max": [1.25, 0.9, 1.25]},
            "props": {},
        },
        {
            "entityId": "floor",
            "layer": "rebuilt",
            "kind": "structure",
            "shape": {"type": "box", "size": [4, 0.02, 4], "material": {"texture": tsha, "uv": "planar"}},
            "textures": [tsha],
            "bounds": {"min": [-2, 0, -2], "max": [2, 0.02, 2]},
            "props": {},
        },
        {
            "entityId": "sofa",
            "layer": "rebuilt",
            "kind": "object",
            "assetHash": gsha,
            "bounds": {"min": [2, 0, 2], "max": [3, 0.5, 3]},
            "props": {},
        },
        {
            "entityId": "plant",
            "layer": "ext",
            "kind": "object",
            "shape": {"type": "box", "size": [1, 1, 1]},
            "bounds": {"min": [-0.5, 0, -0.5], "max": [0.5, 1, 0.5]},
            "props": {},
        },
    ]
    (root / "entities.json").write_text(json.dumps(entities))
    (root / "space.json").write_text(
        json.dumps(
            {
                "spaceId": "demo-space",
                "seq": 7,
                "readOnly": True,
                "scan": {"webModelHashes": [gsha], "transform": IDENTITY},
            }
        )
    )
    res = build_from_snapshot(
        str(root),
        str(tmp_path / "out"),
        upload_limits=bl.default_upload_limits(),
        base={"spaceId": "demo-space", "seq": 7},
        check=False,
    )
    m = read_bundle(tmp_path / "out")
    got = [*m["rebuilt"]["templates"], *m["rebuilt"]["entities"]]

    def strip(body):
        text = json.dumps(body, sort_keys=True).replace('"rb.', '"')
        return json.loads(text)

    want = sorted(
        (b for b in entities if b["layer"] == "rebuilt"),
        key=lambda b: (b["kind"] != "template", b["entityId"]),
    )
    assert sorted(map(lambda b: json.dumps(strip(b), sort_keys=True), got)) == sorted(
        json.dumps(b, sort_keys=True) for b in want
    )
    assert all(b["entityId"].startswith("rb.") for b in got)
    assert {f["purpose"] for f in m["files"]} == {"model", "texture"} and "scan" not in m
    assert res["notes"] and res["renamed"] == 4
    # 缺文件：报错，写明是哪个
    (root / "assets" / f"{tsha}.jpg").unlink()
    with pytest.raises(InputRejected, match=tsha[:12]):
        build_from_snapshot(
            str(root), str(tmp_path / "out2"), upload_limits=bl.default_upload_limits(), check=False
        )


def test_bundle_out_dir_is_never_someone_elses_folder(tmp_path):
    from metaverse_recon.bundle.build import prepare_out_dir

    d = tmp_path / "x"
    d.mkdir()
    (d / "important.txt").write_text("keep")
    with pytest.raises(InputRejected, match="不是重建包"):
        prepare_out_dir(str(d))
    (d / "important.txt").unlink()
    (d / "manifest.json").write_text("{}")
    (d / "models").mkdir()
    prepare_out_dir(str(d))
    assert list(d.iterdir()) == []


# ---------------------------------------------------------------------------- 工作区


def test_workspace_defaults(tmp_path, monkeypatch):
    root = tmp_path / "space"
    (root / "scan").mkdir(parents=True)
    (root / "space.json").write_text(json.dumps({"spaceId": "demo-space", "seq": 5}))
    (root / "scan" / "scan.zip").write_bytes(b"PK")
    deep = root / "out" / "a" / "b"
    deep.mkdir(parents=True)
    monkeypatch.chdir(deep)
    found = ws.find_workspace()
    assert (
        found is not None and found.root == root and found.base_ref() == {"spaceId": "demo-space", "seq": 5}
    )
    assert ws.default_path(None, ws.SCAN_ZIP) == str(root / "scan" / "scan.zip")
    assert ws.default_path("given", ws.SCAN_ZIP) == "given"
    assert ws.default_path(None, ws.TRANSFORM_FILE) is None
    with pytest.raises(ReconError, match=r"scan/transform\.json"):
        ws.require_path(None, ws.TRANSFORM_FILE, "变换")
    ws.write_transform(str(root / ws.TRANSFORM_FILE), IDENTITY, "align", 5)
    assert ws.read_transform(str(root / ws.TRANSFORM_FILE)) == IDENTITY
    assert json.loads((root / ws.TRANSFORM_FILE).read_text())["source"] == "align"
    (root / "bad.json").write_text("[1, 2]")
    with pytest.raises(ReconError, match="16 个数"):
        ws.read_transform(str(root / "bad.json"))
    monkeypatch.chdir(tmp_path)
    assert ws.find_workspace() is None


# ---------------------------------------------------------------------------- 命令


def test_models_command_dedups_yaw_and_writes_records(tmp_path):
    d = doc(entities=[e for e in doc()["entities"] if "model" in e])
    twin = json.loads(json.dumps(d["entities"][0]))
    twin["entityId"] = "chair-02"
    twin["transform"] = {"position": [4, 0, 2], "yaw": 33}
    d["entities"].append(twin)
    tinted = json.loads(json.dumps(d["entities"][0]))
    tinted["entityId"] = "chair-03"
    tinted["material"] = {"tint": [200, 100, 100]}
    d["entities"].append(tinted)
    (tmp_path / "a.json").write_text(json.dumps(d))
    md = model_dir(tmp_path)
    out = tmp_path / "out"
    assert (
        run_cli(
            "models",
            "--authored",
            str(tmp_path / "a.json"),
            "--out",
            str(out),
            "--models-dir",
            str(md),
            "--offline",
        )
        == 0
    )
    report = json.loads((out / "models.json").read_text())
    e = report["entities"]
    assert e["chair-01"]["assetHash"] == e["chair-02"]["assetHash"] != e["chair-03"]["assetHash"]
    assert e["chair-02"]["transform"] == {"yaw": 33.0} and "transform" not in e["chair-01"]
    assert report["summary"]["files"] == 2 and all(
        (out / f["file"]).exists() for f in report["files"].values()
    )
    # 本地没有、又不许下载：报错
    assert (
        run_cli("models", "--authored", str(tmp_path / "a.json"), "--out", str(tmp_path / "o2"), "--offline")
        == 2
    )


def test_align_and_webmodel_commands(tmp_path):
    scan = tmp_path / "scan.zip"
    scan.write_bytes(scan_zip(room_mesh()))
    out = tmp_path / "t.json"
    assert run_cli("align", "--scan", str(scan), "--out", str(out)) == 0
    doc_ = json.loads(out.read_text())
    assert (
        doc_["source"] == "align" and len(doc_["transform"]) == 16 and doc_["alignment"]["method"] == "auto"
    )
    # 与自己配准：误差接近 0；误差上限设成负数时退出码非 0，变换照样写出
    out2 = tmp_path / "t2.json"
    assert (
        run_cli(
            "align",
            "--scan",
            str(scan),
            "--reference",
            str(scan),
            "--reference-transform",
            str(out),
            "--out",
            str(out2),
            "--max-error-cm",
            "-1",
        )
        == 2
    )
    assert json.loads(out2.read_text())["source"] == "align"
    assert run_cli("webmodel", "--scan", str(scan), "--out", str(tmp_path / "web")) == 0
    assert sorted(os.listdir(tmp_path / "web")) == ["scan-0.glb", "scan-1.glb"]


def test_bake_and_fit_commands(tmp_path):
    base = make_base(tmp_path, room_with_table())
    d = doc()
    d["entities"] = [e for e in d["entities"] if "model" not in e]
    (tmp_path / "a.json").write_text(json.dumps(d))
    out = tmp_path / "baked"
    assert (
        run_cli("bake", "--authored", str(tmp_path / "a.json"), "--base", str(base), "--out", str(out)) == 0
    )
    baked = json.loads((out / "authored.json").read_text())
    panel = next(e for e in baked["entities"] if e["entityId"] == "panel-01")
    ref = panel["shape"]["material"]["texture"]
    assert (
        set(ref) == {"file"} and (out / ref["file"]).exists() and panel["shape"]["material"]["uv"] == "planar"
    )
    assert bt.check_authored(baked)["textureFiles"] == 1
    fits = tmp_path / "fit.json"
    assert (
        run_cli("fit", "--authored", str(tmp_path / "a.json"), "--base", str(base), "--out", str(fits)) == 0
    )
    report = json.loads(fits.read_text())
    table = next(r for r in report["entities"] if r["entityId"] == "table-01")
    assert table["meanCm"] < 0.5 and report["summary"]["entities"] >= 1


def test_doctor_install_uses_the_cache(tmp_path, monkeypatch):
    calls = []

    class Done:
        returncode = 0
        stdout = stderr = ""

    def fake_run(cmd, **kw):
        calls.append((cmd, kw.get("env", {}).get("PLAYWRIGHT_BROWSERS_PATH")))
        if "install" in cmd and "chromium" not in cmd:
            prefix = Path(cmd[cmd.index("--prefix") + 1])
            (prefix / "node_modules" / "three" / "build").mkdir(parents=True)
            (prefix / "node_modules" / "three" / "build" / "three.module.js").write_text("")
            (prefix / "node_modules" / "playwright-core").mkdir(parents=True)
            (prefix / "node_modules" / "playwright-core" / "package.json").write_text("{}")
        return Done()

    monkeypatch.setattr(benv, "find_node", lambda: "/usr/bin/node")
    monkeypatch.setattr(benv.shutil, "which", lambda name: f"/usr/bin/{name}")
    done = benv.install(run=fake_run)
    assert (
        f"three@{benv.THREE_VERSION}" in calls[0][0]
        and f"playwright-core@{benv.PLAYWRIGHT_VERSION}" in calls[0][0]
    )
    assert calls[1][0][-2:] == ["install", "chromium"] and calls[1][1] == str(
        benv.cache_dir() / "ms-playwright"
    )
    assert set(done) == {"npm", "chromium"}
    # 装好以后：three 找得到，再装一次只补 Chromium（假装的下载没有真的放文件）
    monkeypatch.delenv("METAVERSE_RECON_THREE", raising=False)
    monkeypatch.setattr(benv, "repo_root", lambda: None)
    assert benv.find_three() == str(benv.cache_dir() / "node" / "node_modules" / "three")
    calls.clear()
    benv.install(run=fake_run)
    assert len(calls) == 1 and "chromium" in calls[0][0]


def test_bundle_command_in_a_workspace(tmp_path, monkeypatch):
    root = tmp_path / "space"
    (root / "scan").mkdir(parents=True)
    (root / "space.json").write_text(json.dumps({"spaceId": "demo-space", "seq": 2}))
    (root / "scan" / "scan.zip").write_bytes(scan_zip(room_with_table()))
    ws.write_transform(str(root / ws.TRANSFORM_FILE), IDENTITY, "pull", 2)
    authored = authored_for_bundle(root)
    md = model_dir(root)
    monkeypatch.chdir(root)
    import metaverse_recon.bundle.build as bb

    real = bb.build_bundle
    monkeypatch.setattr(bb, "build_bundle", lambda **kw: real(**kw, objects_target=FAKE))
    monkeypatch.setattr(bb.shutil, "which", lambda name: None)
    assert run_cli("bundle", "--authored", str(authored), "--models-dir", str(md)) == 0
    m = read_bundle(root / "out" / "bundle")
    assert m["base"] == {"spaceId": "demo-space", "seq": 2} and (root / "out" / "bundle-report.json").exists()
    # 不给物件集也不给 --algorithm：报错
    assert run_cli("bundle") == 2


def test_parser_has_every_pipeline_command():
    parser = cli.build_parser()
    sub = next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))
    for name in (
        "align",
        "webmodel",
        "models",
        "bake",
        "fit",
        "scan-zip",
        "bundle",
        "refshot",
        "texture",
        "texsearch",
        "texfetch",
        "doctor",
    ):
        assert name in sub.choices
