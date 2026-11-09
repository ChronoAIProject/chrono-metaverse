"""AI 物件集：格式校验、下载（本机 https）、外部模型重新导出、烘焙和偏差（不需要数据库）。"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import zipfile

import numpy as np
import pytest
import trimesh

from conftest import png_bytes, scan_glb
from https_server import serve
from metaverse_worker import shapes as sh
from metaverse_worker.authored import (
    MAX_ENTITIES,
    AuthoredError,
    load_authored_bytes,
    node_at,
    parse_authored,
    source_key,
)
from metaverse_worker.errors import InputRejected, PermanentJobError
from metaverse_worker.fetch import (
    DEFAULT_MODEL_HOSTS,
    DownloadFailed,
    DownloadRejected,
    fetch,
    host_allowed,
    parse_hosts,
)
from metaverse_worker.processing.authored_build import (
    GLTF_MAIN,
    _texture_nodes,
    authored_rebuild,
    export_models,
    extract_gltf_zip,
    load_source,
    uv_extents,
)
from metaverse_worker.processing.glb import read_glb_json
from metaverse_worker.processing.modelimport import inspect_gltf, load_model
from metaverse_worker.processing.rebuild import structure_entities
from metaverse_worker.processing.shape_mesh import build_parts
from metaverse_worker.processing.structure import extract_structure
from metaverse_worker.records import validate_entity_body
from synthetic import box_mesh, merged, room_mesh

LIMITS = {
    "max_triangles": 1_000_000,
    "max_texture_pixels": 1 << 26,
    "max_model_bytes": 1 << 26,
    "model_max_triangles": 5000,
    "model_max_texture_side": 256,
}
SHA = "a" * 64
SOURCE = {
    "library": "polyhaven",
    "id": "ArmChair_01",
    "page": "https://polyhaven.com/a/ArmChair_01",
    "author": "示例作者",
    "license": "CC0-1.0",
    "title": "Arm Chair",
}


def model_glb() -> bytes:
    """0.5 米见方、0.4 米高的带贴图盒子（底面中心在原点），贴图是单一的橙色。"""
    return scan_glb(box_mesh([-0.25, 0, -0.25], [0.25, 0.4, 0.25], color=(200, 100, 50)))


def model_entity(eid: str, model: dict, **extra) -> dict:
    return {
        "entityId": eid,
        "kind": "object",
        "label": "扶手椅",
        "model": model,
        "transform": {"position": [2.5, 0, 2.0]},
        "props": {"category": "chair", "source": dict(SOURCE)},
        **extra,
    }


def doc(**overrides) -> dict:
    """一份合法的物件集：模板 + 实例、带烘焙指令的面板、带锚点的桌子、外部模型。"""
    base = {
        "version": 1,
        "templates": [
            {
                "entityId": "stool-a",
                "kind": "template",
                "shape": sh.cylinder(0.2, 0.45, material=sh.color_material([90, 70, 50])),
            }
        ],
        "entities": [
            {
                "entityId": "stool-01",
                "kind": "object",
                "shape": sh.instance("stool-a", xf=sh.transform(position=[3.5, 0, 1.0])),
                "props": {"category": "stool"},
            },
            {
                "entityId": "panel-01",
                "kind": "object",
                "label": "木饰面",
                "shape": {
                    "type": "box",
                    "size": [0.02, 1.0, 1.0],
                    "transform": {"position": [0.01, 0.5, 2.0]},
                    "material": {"bake": "planar"},
                },
                "fit": {"meanCm": 99, "p90Cm": 99, "coverage3cm": 0},
            },
            {
                "entityId": "table-01",
                "kind": "object",
                "label": "会议桌",
                "anchorId": "table-01",
                "shape": sh.box([1.6, 0.75, 0.8], xf=sh.transform(position=[2.0, 0, 3.0])),
                "props": {"category": "table"},
            },
            model_entity(
                "chair-01",
                {"url": "https://dl.polyhaven.org/a.glb", "sha256": SHA, "size": 10, "format": "glb"},
            ),
        ],
        "notes": "前台用了折板；扶手椅在 Poly Haven 找到了差不多的。",
        "structure": "keep",
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------- 格式校验


def test_parse_valid_document():
    parsed = parse_authored(doc())
    assert parsed["structure"] == "keep" and parsed["notes"].startswith("前台")
    assert set(parsed["entities"]) == {"stool-01", "panel-01", "table-01", "chair-01"}
    assert set(parsed["templates"]) == {"stool-a"}
    # 省略的 layer 按 rebuilt；没给的 bounds 按形状算；fit 一律重算
    panel = parsed["entities"]["panel-01"]
    assert panel["layer"] == "rebuilt" and "fit" not in panel
    assert np.allclose(panel["bounds"]["min"], [0, 0.5, 1.5], atol=2e-4)
    assert np.allclose(panel["bounds"]["max"], [0.02, 1.5, 2.5], atol=2e-4)
    # 烘焙指令换成后备纯色，路径和投影记下来
    assert panel["shape"]["material"] == {"color": [128, 128, 128]}
    assert parsed["bakes"] == {
        "panel-01": [{"path": "$", "uv": "planar", "keep": {}, "fallback": [128, 128, 128]}]
    }
    # 外部模型物件：还没有 assetHash，模型和摆放另放
    chair = parsed["entities"]["chair-01"]
    assert "model" not in chair and "assetHash" not in chair and chair["props"]["source"] == SOURCE
    item = parsed["models"]["chair-01"]
    assert item["transform"] == {"position": [2.5, 0, 2.0]} and item["tint"] is None
    assert parsed["sources"][item["source"]]["format"] == "glb"


def test_same_model_is_downloaded_once_and_gltf_files_are_listed():
    gltf = {
        "url": "https://dl.polyhaven.org/chair.gltf",
        "sha256": SHA,
        "size": 100,
        "format": "gltf",
        "files": {
            "chair.bin": {"url": "https://dl.polyhaven.org/chair.bin", "sha256": "b" * 64, "size": 5},
            "textures/diff.jpg": {"url": "https://dl.polyhaven.org/d.jpg", "sha256": "c" * 64, "size": 7},
        },
    }
    entities = [
        model_entity(f"chair-0{i}", gltf, material={"tint": [255, 200, 200]} if i == 2 else None)
        for i in (1, 2)
    ]
    for e in entities:
        if e["material"] is None:
            del e["material"]
    parsed = parse_authored(doc(templates=[], entities=entities))
    assert len(parsed["sources"]) == 1
    source = next(iter(parsed["sources"].values()))
    assert [f["path"] for f in source["files"]] == ["chair.bin", "textures/diff.jpg"]
    assert parsed["models"]["chair-02"]["tint"] == [255, 200, 200]
    assert source_key(source) == parsed["models"]["chair-01"]["source"]


def _set(path: list, value):
    def mutate(d: dict) -> dict:
        node = d
        for key in path[:-1]:
            node = node[key]
        if value is _DELETE:
            del node[path[-1]]
        else:
            node[path[-1]] = value
        return d

    return mutate


_DELETE = object()
PANEL = ["entities", 1]
CHAIR = ["entities", 3]


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (_set(["version"], 2), "version"),
        (_set(["extra"], 1), "不认识的字段"),
        (_set(["structure"], "merge"), "keep 或 replace"),
        (_set(["notes"], "x" * (64 * 1024 + 1)), "64KB"),
        (_set(["entities"], []), "entities"),
        (_set([*PANEL, "kind"], "structure"), "structure 是 keep"),
        (_set([*PANEL, "kind"], "template"), "kind 必须是 object 或 structure"),
        (_set([*PANEL, "layer"], "ext"), "rebuilt"),
        (_set([*PANEL, "entityId"], "table-01"), "重复"),
        (_set([*PANEL, "assetHash"], SHA), "不认识的字段"),
        (_set([*PANEL, "shape", "material"], {"bake": "spherical"}), "bake 必须是"),
        (_set([*PANEL, "shape", "material"], {"bake": "box", "texture": SHA, "uv": "box"}), "没有 texture"),
        (_set([*PANEL, "bounds"], {"min": [0, 0, 0], "max": [0.01, 0.01, 0.01]}), "bounds"),
        (_set(["entities", 0, "shape", "template"], "missing"), "找不到模板"),
        (_set(["templates", 0, "shape", "material"], {"bake": "box"}), "模板"),
        (_set(["templates", 0, "kind"], "object"), "template"),
        (_set([*CHAIR, "props", "source", "license"], "CC-BY-NC-4.0"), "NC、ND、SA"),
        (_set([*CHAIR, "props", "source", "license"], "CC-BY-SA-4.0"), "NC、ND、SA"),
        (_set([*CHAIR, "props", "source", "library"], "turbosquid"), "library"),
        (_set([*CHAIR, "props", "source", "page"], "http://polyhaven.com/a/x"), "page"),
        (_set([*CHAIR, "props", "source"], _DELETE), "props.source"),
        (_set([*CHAIR, "props", "source"], "llm-modeler"), "props.source"),
        (_set([*CHAIR, "model", "url"], "http://dl.polyhaven.org/a.glb"), "https"),
        (_set([*CHAIR, "model", "sha256"], "ABC"), "sha256"),
        (_set([*CHAIR, "model", "size"], 0), "size"),
        (_set([*CHAIR, "model", "format"], "fbx"), "format"),
        (_set([*CHAIR, "model", "files"], {"a.bin": {}}), "files 只用于"),
        (_set([*CHAIR, "shape"], sh.box([1, 1, 1])), "不能同时有"),
        (_set([*CHAIR, "transform"], {"scale": [0, 1, 1]}), "transform"),
        (_set([*CHAIR, "material"], {"color": [1, 2, 3]}), "tint"),
    ],
)
def test_invalid_documents_are_rejected(mutate, message):
    with pytest.raises(AuthoredError, match=message):
        parse_authored(mutate(copy.deepcopy(doc())))


def test_cc_by_needs_author_and_gltf_paths_stay_inside():
    d = doc()
    d["entities"][3]["props"]["source"].update(license="CC-BY-4.0", author="")
    with pytest.raises(AuthoredError, match="author"):
        parse_authored(d)
    # 署名规则与物件记录相同：CC0 也要写作者（records.validate_model_source）
    d = doc()
    d["entities"][3]["props"]["source"]["author"] = ""
    with pytest.raises(AuthoredError, match="author"):
        parse_authored(d)
    d = doc()
    del d["entities"][3]["props"]["source"]["title"]
    with pytest.raises(AuthoredError, match="title"):
        parse_authored(d)
    for bad in ("../x.bin", "/etc/x", "a/../../b", "a\\b.bin"):
        d = doc()
        d["entities"][3]["model"] = {
            "url": "https://dl.polyhaven.org/a.gltf",
            "sha256": SHA,
            "size": 1,
            "format": "gltf",
            "files": {bad: {"url": "https://dl.polyhaven.org/b", "sha256": SHA, "size": 1}},
        }
        with pytest.raises(AuthoredError, match="文件路径"):
            parse_authored(d)


def test_string_source_on_shapes_passes_like_entity_records():
    """手写形状的 props.source 可以是标来源的字符串（物件记录也放行），不当署名校验。"""
    d = doc()
    d["entities"][1]["props"] = {"source": "llm-modeler"}
    d["templates"][0]["props"] = {"source": "llm-modeler"}
    parsed = parse_authored(d)
    assert parsed["entities"]["panel-01"]["props"]["source"] == "llm-modeler"


def test_replace_needs_structure_and_limits():
    with pytest.raises(AuthoredError, match="没有 kind structure"):
        parse_authored(doc(structure="replace"))
    many = [
        {"entityId": f"b-{i}", "kind": "object", "shape": sh.box([0.1, 0.1, 0.1])}
        for i in range(MAX_ENTITIES + 1)
    ]
    with pytest.raises(AuthoredError, match="entities"):
        parse_authored(doc(templates=[], entities=many))
    with pytest.raises(AuthoredError, match="UTF-8 JSON"):
        load_authored_bytes(b"\xff\xfe")
    assert load_authored_bytes(json.dumps(doc()).encode())["version"] == 1


# ---------------------------------------------------------------------------- 下载


def test_host_list_parsing_and_matching():
    assert parse_hosts(None) == DEFAULT_MODEL_HOSTS and parse_hosts(" ") == DEFAULT_MODEL_HOSTS
    assert parse_hosts("A.example.com, .hf.co,localhost:8443,a.example.com") == (
        "a.example.com",
        ".hf.co",
        "localhost:8443",
    )
    for bad in ("http://x.com", "x.com/path", ".com", ".hf.co:443", "x.com:99999", "*.hf.co", ","):
        with pytest.raises(ValueError):
            parse_hosts(bad)
    hosts = parse_hosts("dl.polyhaven.org,.hf.co,localhost:8443")
    assert host_allowed("https://dl.polyhaven.org/a.glb", hosts)
    assert host_allowed("https://dl.polyhaven.org:443/a.glb", hosts)
    assert host_allowed("https://us.aws.cdn.hf.co/x?sig=1", hosts)
    assert host_allowed("https://localhost:8443/a", hosts)
    assert not host_allowed("http://dl.polyhaven.org/a.glb", hosts)
    assert not host_allowed("https://dl.polyhaven.org:8443/a.glb", hosts)
    assert not host_allowed("https://hf.co/x", hosts)  # 后缀条目只匹配子域名
    assert not host_allowed("https://evilhf.co/x", hosts)
    assert not host_allowed("https://dl.polyhaven.org.evil.com/a", hosts)
    assert not host_allowed("https://user@dl.polyhaven.org/a", hosts)
    assert not host_allowed("https://localhost/a", hosts)
    assert not host_allowed("https://[::1", hosts)


def test_fetch_checks_hosts_redirects_size_and_hash(tmp_path):
    body = b"glTF-model-bytes" * 1000
    with serve(str(tmp_path)) as server:
        hosts = (server.host,)
        opener = server.opener()
        good = server.add("/models/a.glb", body)
        dest = str(tmp_path / "a.glb")
        got = fetch(good["url"], dest, sha256=good["sha256"], size=good["size"], hosts=hosts, opener=opener)
        with open(dest, "rb") as fh:
            assert got.bytes == len(body) and got.redirects == 0 and fh.read() == body
        # 重定向：每一跳都在列表里就跟过去
        hop2 = server.redirect("/r2", "/models/a.glb", 307)
        hop1 = server.redirect("/r1", hop2)
        got = fetch(hop1, dest, sha256=good["sha256"], size=good["size"], hosts=hosts, opener=opener)
        assert got.redirects == 2

        def rejected(url, message, *, sha=good["sha256"], size=good["size"], hosts=hosts):
            with pytest.raises(DownloadRejected, match=message):
                fetch(url, dest, sha256=sha, size=size, hosts=hosts, opener=opener)
            assert not os.path.exists(dest)

        rejected(good["url"], "sha256", sha="0" * 64)
        rejected(good["url"], "与声明的", size=len(body) + 1)
        rejected(good["url"], "不在允许列表", hosts=("dl.polyhaven.org",))
        rejected(server.url("/models/a.glb").replace("https", "http"), "不是 https")
        rejected(server.redirect("/away", "https://example.com/a.glb"), "第 1 次重定向")
        rejected(server.redirect("/plain", f"http://{server.host}/models/a.glb"), "第 1 次重定向")
        rejected(server.url("/missing"), "404")
        server.redirect("/loop", "/loop")
        rejected(server.url("/loop"), "重定向超过")
        server.routes["/broken"] = server.routes["/models/a.glb"].__class__(status=503)
        with pytest.raises(DownloadFailed, match="503"):
            fetch(server.url("/broken"), dest, sha256=SHA, size=1, hosts=hosts, opener=opener)
    # 服务已经关了：网络错误可以重试
    with pytest.raises(DownloadFailed):
        fetch(good["url"], dest, sha256=SHA, size=1, hosts=hosts, opener=opener, timeout=2)


# ---------------------------------------------------------------------------- 外部模型


def test_export_bakes_rotation_scale_and_tint(tmp_path):
    src = tmp_path / "chair.glb"
    src.write_bytes(model_glb())
    parsed = parse_authored(
        doc(
            templates=[],
            entities=[
                model_entity(
                    "chair-01",
                    {"url": "https://dl.polyhaven.org/a.glb", "sha256": SHA, "size": 1, "format": "glb"},
                    transform={"position": [2.5, 0, 2.0], "yaw": 90, "scale": [2, 1, 1]},
                    material={"tint": [128, 255, 255]},
                ),
                model_entity(
                    "chair-02",
                    {"url": "https://dl.polyhaven.org/a.glb", "sha256": SHA, "size": 1, "format": "glb"},
                    transform={"position": [4.0, 0.5, 1.0], "yaw": 90, "scale": [2, 1, 1]},
                    material={"tint": [128, 255, 255]},
                ),
            ],
        )
    )
    key = parsed["models"]["chair-01"]["source"]
    files, placed = export_models(parsed, {key: {"format": "glb", "path": str(src)}}, str(tmp_path), LIMITS)
    assert len(files) == 1  # 旋转、缩放、调色相同：共用一个 glb
    sha = next(iter(files))
    assert placed["chair-01"]["hash"] == placed["chair-02"]["hash"] == sha
    # 偏航 90°：模型的 x 方向（缩放 2 倍后 1 米）转到 z 方向；原点在底面中心
    local = placed["chair-01"]["mesh"].bounds()
    assert np.allclose(local[0], [-0.25, 0, -0.5], atol=1e-6) and np.allclose(
        local[1], [0.25, 0.4, 0.5], atol=1e-6
    )
    assert np.allclose(placed["chair-02"]["origin"], [4.0, 0.5, 1.0])
    with open(files[sha]["path"], "rb") as fh:
        assert read_glb_json(fh.read())["asset"]
    mesh, _, _ = load_model(files[sha]["path"], None, max_triangles=10_000, max_texture_pixels=1 << 24)
    red, green, _ = mesh.texture.reshape(-1, 3)[:, :3].astype(float).mean(0)
    assert 90 < red < 110 and 90 < green < 110  # 橙色 (200, 100, 50) 的红色减半


def test_model_material_tint_is_baked_and_look_stays_on_the_entity():
    model = {"url": "https://dl.polyhaven.org/a.glb", "sha256": SHA, "size": 1, "format": "glb"}
    parsed = parse_authored(
        doc(
            templates=[],
            entities=[
                model_entity("c-1", model, material={"tint": [10, 20, 30], "opacity": 0.4, "unlit": True})
            ],
        )
    )
    assert parsed["models"]["c-1"]["tint"] == [10, 20, 30]
    assert parsed["entities"]["c-1"]["material"] == {"opacity": 0.4, "unlit": True}
    for bad, message in (({"opacity": 1.5}, "opacity"), ({"unlit": 1}, "unlit"), ({"shine": 1}, "只能是")):
        with pytest.raises(AuthoredError, match=message):
            parse_authored(doc(templates=[], entities=[model_entity("c-1", model, material=bad)]))


def test_centimetre_models_are_checked_after_scaling(tmp_path):
    """模型库的模型常用厘米：原始坐标超过 ±1000 米也收，缩放后的坐标才按上限检查。"""
    src = tmp_path / "cm.glb"
    box = trimesh.creation.box((3000, 1200, 3000))  # 厘米：30 × 12 × 30 米
    src.write_bytes(trimesh.Scene(box).export(file_type="glb"))
    model = {"url": "https://dl.polyhaven.org/a.glb", "sha256": SHA, "size": 1, "format": "glb"}
    scaled = parse_authored(
        doc(templates=[], entities=[model_entity("c-1", model, transform={"scale": [0.01, 0.01, 0.01]})])
    )
    key = scaled["models"]["c-1"]["source"]
    sources = {key: {"format": "glb", "path": str(src)}}
    _, placed = export_models(scaled, sources, str(tmp_path / "a"), LIMITS)
    lo, hi = placed["c-1"]["mesh"].bounds()
    assert np.allclose(hi - lo, [30, 12, 30], atol=1e-6)
    raw = parse_authored(doc(templates=[], entities=[model_entity("c-1", model)]))
    with pytest.raises(InputRejected, match="1000"):
        export_models(raw, sources, str(tmp_path / "b"), LIMITS)


def test_mirrored_scale_flips_winding(tmp_path):
    src = tmp_path / "chair.glb"
    src.write_bytes(model_glb())
    model = {"url": "https://dl.polyhaven.org/a.glb", "sha256": SHA, "size": 1, "format": "glb"}
    plain = parse_authored(doc(templates=[], entities=[model_entity("c-1", model)]))
    mirror = parse_authored(
        doc(templates=[], entities=[model_entity("c-1", model, transform={"scale": [-1, 1, 1]})])
    )
    key = plain["models"]["c-1"]["source"]
    sources = {key: {"format": "glb", "path": str(src)}}
    _, a = export_models(plain, sources, str(tmp_path / "a"), LIMITS)
    _, b = export_models(mirror, sources, str(tmp_path / "b"), LIMITS)

    def outward(mesh) -> float:
        tri = mesh.positions[mesh.indices]
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        return float(np.sum(n * (tri.mean(1) - mesh.positions.mean(0))))

    assert outward(a["c-1"]["mesh"]) > 0 and outward(b["c-1"]["mesh"]) > 0


def gltf_files() -> dict[str, bytes]:
    """trimesh 导出的带贴图 gltf（json + bin + png）。"""
    box = trimesh.creation.box((0.4, 0.4, 0.4))
    tex = np.zeros((16, 16, 3), np.uint8)
    tex[:] = (30, 160, 60)
    from PIL import Image

    uv = np.random.default_rng(0).random((len(box.vertices), 2))
    box.visual = trimesh.visual.TextureVisuals(uv=uv, image=Image.fromarray(tex))
    files = trimesh.Scene(box).export(file_type="gltf")
    return {name: bytes(data) for name, data in files.items()}


def test_gltf_zip_and_gltf_files_load(tmp_path):
    files = gltf_files()
    main = next(n for n in files if n.endswith(".gltf"))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(f"chair/{name}", data)
        zf.writestr("chair/.DS_Store", b"x")
    (tmp_path / "m.zip").write_bytes(buf.getvalue())
    mesh, _, _ = load_source(
        {"format": "gltf-zip", "path": str(tmp_path / "m.zip")}, str(tmp_path / "w"), LIMITS
    )
    assert mesh.triangle_count == 12 and mesh.texture is not None
    # format gltf：父进程按相对路径摆好的目录
    folder = tmp_path / "dir"
    folder.mkdir()
    for name, data in files.items():
        (folder / (GLTF_MAIN if name == main else name)).write_bytes(data)
    mesh, _, _ = load_source({"format": "gltf", "path": str(folder)}, str(tmp_path / "w2"), LIMITS)
    assert mesh.triangle_count == 12


@pytest.mark.parametrize(
    ("members", "message"),
    [
        ({"../evil.gltf": b"{}"}, "路径"),
        ({"a/./b.gltf": b"{}"}, "路径"),
        ({"a.gltf": b"{}", "b.gltf": b"{}"}, "正好有一个"),
        ({"a.bin": b"x"}, "正好有一个"),
    ],
)
def test_gltf_zip_rejects_bad_members(tmp_path, members, message):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    (tmp_path / "m.zip").write_bytes(buf.getvalue())
    with pytest.raises(InputRejected, match=message):
        extract_gltf_zip(str(tmp_path / "m.zip"), str(tmp_path / "out"), 1 << 20)


def test_inspect_gltf_rejects_outside_files_and_compression(tmp_path):
    files = gltf_files()
    main = next(n for n in files if n.endswith(".gltf"))
    gltf = json.loads(files[main])
    for name, data in files.items():
        (tmp_path / name).write_bytes(data)

    def check(doc_: dict, message: str) -> None:
        (tmp_path / "x.gltf").write_text(json.dumps(doc_))
        with pytest.raises(InputRejected, match=message):
            inspect_gltf(str(tmp_path / "x.gltf"), 1_000_000, 1 << 24)

    assert inspect_gltf(str(tmp_path / main), 1_000_000, 1 << 24) == 12
    for uri in ("https://example.com/a.bin", "/etc/passwd", "../a.bin", "missing.bin"):
        bad = copy.deepcopy(gltf)
        bad["buffers"][0]["uri"] = uri
        check(bad, "buffer")
    check({**gltf, "extensionsRequired": ["KHR_draco_mesh_compression"]}, "不支持的扩展")
    with pytest.raises(InputRejected, match="三角形数"):
        inspect_gltf(str(tmp_path / main), 11, 1 << 24)


# ---------------------------------------------------------------------------- 烘焙、偏差、结构


def room_with_table():
    """带斜墙的房间 + 会议桌（与 `doc()` 里的 table-01 一样大、一样位置）。"""
    return merged(room_mesh(), box_mesh([1.2, 0, 2.6], [2.8, 0.75, 3.4], color=(90, 70, 50)))


def test_authored_rebuild_bakes_fits_and_keeps_structure(tmp_path):
    src = tmp_path / "chair.glb"
    src.write_bytes(model_glb())
    parsed = parse_authored(doc())
    key = parsed["models"]["chair-01"]["source"]
    out = authored_rebuild(
        room_with_table(),
        {k: v for k, v in parsed.items() if k != "notes"},
        {key: {"format": "glb", "path": str(src)}},
        workdir=str(tmp_path / "w"),
        limits=LIMITS,
    )
    assert out["structureIds"] and all(e in out["entities"] for e in out["structureIds"])
    assert set(out["objectIds"]) == {"stool-a", "stool-01", "panel-01", "table-01", "chair-01"}
    templates = {"stool-a": out["entities"]["stool-a"]["shape"]}
    for body in out["entities"].values():
        validate_entity_body(body, templates)
    # 烘焙：面板贴着红色的西墙，贴图是红的；登记在 textures 里
    panel = out["entities"]["panel-01"]
    material = panel["shape"]["material"]
    assert material["uv"] == "planar" and panel["textures"] == [material["texture"]]
    from PIL import Image

    img = np.asarray(Image.open(io.BytesIO(out["textures"][material["texture"]])).convert("RGB")).reshape(
        -1, 3
    )
    r, g, b = img.astype(float).mean(0)
    assert r > 160 and g < 110 and b < 110, (r, g, b)
    assert out["bake"] == {"entities": 1, "parts": 1, "textured": 1, "fallback": 0}
    # 偏差：扫描里有会议桌，几乎为零；面板贴着墙（扫描里分不出来）、外部模型附近只有地面：范围里的点都算到
    # 背景上，没有这件物件的证据，不写 fit
    table = out["entities"]["table-01"]
    assert table["fit"]["meanCm"] < 0.5 and table["fit"]["coverage3cm"] > 0.98
    chair = out["entities"]["chair-01"]
    assert "fit" not in chair and "fit" not in panel and chair["assetHash"] in out["models"]
    lo, hi = chair["bounds"]["min"], chair["bounds"]["max"]
    assert np.allclose([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2], [2.5, 0, 2.0], atol=1e-3)
    fits = {f["entityId"]: f for f in out["fit"]}
    assert fits["panel-01"]["points"] > 1000 and fits["chair-01"]["points"] > 100
    assert "meanCm" not in fits["panel-01"] and fits["table-01"]["meanCm"] == table["fit"]["meanCm"]
    # 同样的输入，同样的结果（重新重建没有变化就不提交）
    again = authored_rebuild(
        room_with_table(),
        {k: v for k, v in parsed.items() if k != "notes"},
        {key: {"format": "glb", "path": str(src)}},
        workdir=str(tmp_path / "w2"),
        limits=LIMITS,
    )
    assert again["entities"] == out["entities"]


def test_authored_rebuild_replace_structure_and_bake_fallback(tmp_path):
    floor = {
        "entityId": "floor-01",
        "kind": "structure",
        "shape": {"type": "box", "size": [5, 0.05, 4], "transform": {"position": [2.5, -0.05, 2]},
                  "material": {"bake": "box", "color": [10, 20, 30]}},
    }  # fmt: skip
    far = {
        "entityId": "far-01",
        "kind": "object",
        "shape": {"type": "group", "children": [
            {"type": "box", "size": [0.3, 0.3, 0.3], "material": {"bake": "box", "color": [1, 2, 3]}},
        ], "transform": {"position": [20, 0, 20]}},
    }  # fmt: skip
    parsed = parse_authored(doc(templates=[], entities=[floor, far], structure="replace"))
    out = authored_rebuild(room_mesh(), parsed, {}, workdir=str(tmp_path), limits=LIMITS)
    assert out["structureIds"] == ["floor-01"] and out["objectIds"] == ["far-01"]
    assert out["entities"]["floor-01"]["shape"]["material"]["uv"] == "box"
    # 远处没有扫描：退回后备纯色，不写 fit
    far_body = out["entities"]["far-01"]
    assert far_body["shape"]["children"][0]["material"] == {"color": [1, 2, 3]} and "fit" not in far_body
    assert out["bake"]["fallback"] == 1 and out["bake"]["textured"] == 1


def algorithm_structure_doc() -> tuple[dict, dict[str, bytes], dict[str, str]]:
    """本次算法在 `room_mesh()` 上算出的结构 → 物件集里 `kind: structure` 的物件，但贴图哈希换成"本地基线"
    算的另一份（模拟依赖版本不同、哈希不同），`uv` 也故意改成 box，看回退后是不是保持物件集里写的。

    返回 (物件集, 本次算法的贴图, {本地哈希: 本次哈希})。
    """
    bodies, textures = structure_entities(extract_structure(room_mesh()))
    renamed: dict[str, str] = {}
    entities = []
    for _, body in sorted(bodies.items()):
        body = copy.deepcopy(body)
        for _, node in _texture_nodes(body["shape"]):
            old = node["material"]["texture"]
            new = renamed.setdefault(old, hashlib.sha256(f"local\0{old}".encode()).hexdigest())
            node["material"] = {"texture": new, "uv": "box"}
        body.pop("textures", None)
        entities.append({k: v for k, v in body.items() if k != "fit"})
    assert renamed and len(entities) >= 3  # 地面和几面墙带贴图
    doc_ = {"version": 1, "entities": entities, "structure": "replace"}
    return doc_, textures, {local: real for real, local in renamed.items()}


def run_replace(tmp_path, doc_, pending) -> dict:
    parsed = parse_authored(doc_)
    parsed["pendingTextures"] = sorted(pending)
    return authored_rebuild(room_mesh(), parsed, {}, workdir=str(tmp_path), limits=LIMITS)


def test_structure_textures_fall_back_to_this_jobs_algorithm(tmp_path):
    doc_, textures, local_to_real = algorithm_structure_doc()
    out = run_replace(tmp_path, doc_, set(local_to_real))
    replaced = out["textureFallback"]
    assert {(r["from"], r["to"]) for r in replaced} == set(local_to_real.items())
    assert out["metrics"]["structure"]["textureFallback"] == len(replaced)
    for item in replaced:
        body = out["entities"][item["entityId"]]
        material = node_at(body["shape"], item["path"])["material"]
        assert material == {"texture": item["to"], "uv": "box"}  # uv 保持物件集里写的
        assert item["to"] in body["textures"] and item["from"] not in body["textures"]
        assert out["textures"][item["to"]] == textures[item["to"]]  # 本次算出的贴图要登记
    assert set(out["textures"]) == set(local_to_real.values())
    # 本次算出的哈希本来就对（同样的依赖版本）：直接用，不算回退
    same = copy.deepcopy(doc_)
    for body in same["entities"]:
        for _, node in _texture_nodes(body["shape"]):
            node["material"]["texture"] = local_to_real[node["material"]["texture"]]
    out = run_replace(tmp_path / "same", same, set(local_to_real.values()))
    assert out["textureFallback"] == [] and set(out["textures"]) == set(local_to_real.values())
    # 没有待定的贴图（都是本空间登记过的）：不跑算法，也不登记新贴图
    out = run_replace(tmp_path / "none", same, set())
    assert out["textureFallback"] == [] and out["textures"] == {}


def _wall_with_texture(doc_) -> dict:
    return next(b for b in doc_["entities"] if b["entityId"] != "floor" and list(_texture_nodes(b["shape"])))


def _rename_wall(doc_):
    _wall_with_texture(doc_)["entityId"] = "wall-renamed"


def _wrap_wall_panel(doc_):
    wall = _wall_with_texture(doc_)
    wall["shape"] = {"type": "group", "children": [wall["shape"]]}  # 部件路径变了，那里不是贴图材质


def _as_object(doc_):
    wall = _wall_with_texture(doc_)
    wall["kind"] = "object"


@pytest.mark.parametrize("mutate", [_rename_wall, _wrap_wall_panel, _as_object])
def test_structure_texture_fallback_needs_same_id_path_and_kind(tmp_path, mutate):
    doc_, _, local_to_real = algorithm_structure_doc()
    mutate(doc_)
    with pytest.raises(PermanentJobError, match="不是本空间的贴图资源，本次任务也没有算出"):
        run_replace(tmp_path, doc_, set(local_to_real))


def test_structure_texture_fallback_is_not_shared_with_templates_or_objects(tmp_path):
    """同一个待定哈希在结构物件上能回退，模板、物体引用它照样失败：回退只换结构物件自己那个节点，
    不能借结构物件的名义把别的空间（或不存在）的贴图带进模板和物体。"""
    doc_, _, local_to_real = algorithm_structure_doc()
    wall = _wall_with_texture(doc_)
    local = next(node["material"]["texture"] for _, node in _texture_nodes(wall["shape"]))
    textured = {"type": "box", "size": [0.6, 0.9, 0.01], "material": {"texture": local, "uv": "planar"}}
    template = {"entityId": "tpl-poster", "kind": "template", "shape": copy.deepcopy(textured)}
    with pytest.raises(PermanentJobError, match="模板 tpl-poster 的 \\$ 引用的贴图"):
        run_replace(tmp_path / "template", {**doc_, "templates": [template]}, set(local_to_real))
    poster = {"entityId": "poster-01", "kind": "object", "shape": copy.deepcopy(textured)}
    poster["shape"]["transform"] = {"position": [1, 1, 0.02]}
    with_poster = {**doc_, "entities": [*doc_["entities"], poster]}
    with pytest.raises(PermanentJobError, match="物件 poster-01 的 \\$ 引用的贴图"):
        run_replace(tmp_path / "object", with_poster, set(local_to_real))


def test_keep_mode_accepts_textures_this_job_computed(tmp_path):
    """keep：物件引用的贴图本空间没登记，但本次算法结构算出了同样的贴图——直接用；算不出的照样失败。"""
    _, textures, _ = algorithm_structure_doc()
    real = sorted(textures)[0]
    poster = {
        "entityId": "poster-01",
        "kind": "object",
        "shape": {"type": "box", "size": [0.6, 0.9, 0.01], "transform": {"position": [1, 1, 0.02]},
                  "material": {"texture": real, "uv": "planar"}},
    }  # fmt: skip
    parsed = parse_authored({"version": 1, "entities": [poster]})
    out = authored_rebuild(
        room_mesh(), {**parsed, "pendingTextures": [real]}, {}, workdir=str(tmp_path), limits=LIMITS
    )
    assert out["entities"]["poster-01"]["textures"] == [real] and real in out["textures"]
    poster["shape"]["material"]["texture"] = "d" * 64
    parsed = parse_authored({"version": 1, "entities": [poster]})
    with pytest.raises(PermanentJobError, match="物件 poster-01 的 \\$ 引用的贴图"):
        authored_rebuild(room_mesh(), {**parsed, "pendingTextures": ["d" * 64]}, {}, workdir=str(tmp_path),
                         limits=LIMITS)  # fmt: skip


def test_uv_extents_follow_projection():
    shape = {"type": "box", "size": [2.0, 1.0, 0.1], "material": {"texture": SHA, "uv": "planar"}}
    mesh = build_parts(shape)[0].mesh
    eu, ev = uv_extents(mesh)
    assert eu == pytest.approx(2.0, rel=1e-6) and ev == pytest.approx(1.0, rel=1e-6)
    assert png_bytes(np.zeros((2, 2, 3), np.uint8))  # 夹具可用
