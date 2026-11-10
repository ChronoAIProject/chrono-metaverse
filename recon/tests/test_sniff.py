"""按用途嗅探上传格式（设计 6.1）。"""

import gzip
import io
import json
import zipfile

import numpy as np
import pytest
from PIL import Image

from conftest import jpeg_bytes, png_bytes, scan_glb, scan_zip
from metaverse_recon.errors import InputRejected
from metaverse_recon.processing.sniff import extract_model, inspect_zip, sniff_upload
from metaverse_recon.processing.tasks import prepare_model_file, read_scan, sniff_task
from synthetic import room_mesh

LIMITS = {
    "max_texture_side": 8192,
    "max_texture_pixels": 8192 * 8192,
    "max_ops_bytes": 1 << 20,
    "max_zip_bytes": 1 << 28,
}


def write(tmp_path, name, data: bytes) -> str:
    p = tmp_path / name
    p.write_bytes(data)
    return str(p)


def test_scan_formats(tmp_path):
    mesh = room_mesh()
    glb = write(tmp_path, "a.bin", scan_glb(mesh))
    assert sniff_upload(glb, "scan", LIMITS).format == "glb"
    z = write(tmp_path, "b.bin", scan_zip(mesh))
    found = sniff_upload(z, "model", LIMITS)
    assert found.format == "zip" and found.content_type == "application/zip"
    assert found.detail == {"model": "draco", "texture": True}
    obj = write(tmp_path, "c.bin", b"# test\nv 0 0 0\nv 1 0 0\nv 0 0 1\nf 1 2 3\n")
    assert sniff_upload(obj, "scan", LIMITS).format == "obj"
    with pytest.raises(InputRejected):
        sniff_upload(write(tmp_path, "d.bin", png_bytes(mesh.texture)), "scan", LIMITS)
    with pytest.raises(InputRejected):
        sniff_upload(write(tmp_path, "e.bin", b"glTF" + b"\x02\x00\x00\x00" + b"\x00" * 12), "scan", LIMITS)


def test_zip_member_rules(tmp_path):
    def make(members: dict[str, bytes]) -> str:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            for name, data in members.items():
                zf.writestr(name, data)
        return write(tmp_path, f"z{len(members)}{abs(hash(tuple(members)))}.zip", buf.getvalue())

    mesh = room_mesh()
    tex = jpeg_bytes(mesh.texture)
    obj = b"mtllib m.mtl\nv 0 0 0\nv 1 0 0\nv 0 0 1\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n"
    mtl = b"newmtl a\nmap_Kd textures/scan.jpg\n"
    plan = inspect_zip(
        make({"m.obj": obj, "m.mtl": mtl, "textures/scan.jpg": tex, "other.jpg": tex + b"x"}), 1 << 20
    )
    assert plan.model_format == "obj" and plan.texture == "textures/scan.jpg" and plan.mtl == "m.mtl"
    with pytest.raises(InputRejected):
        inspect_zip(make({"readme.txt": b"hi"}), 1 << 20)
    with pytest.raises(InputRejected):
        inspect_zip(make({"a.obj": obj, "b.obj": obj}), 1 << 20)
    with pytest.raises(InputRejected):
        inspect_zip(make({"a.obj": obj * 100}), 100)
    with pytest.raises(InputRejected):
        inspect_zip(write(tmp_path, "bad.zip", b"PK\x03\x04garbage"), 1 << 20)


def test_extract_uses_fixed_names(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("../../evil/mesh.drc", b"DRACO" + b"\x00" * 20)
        zf.writestr("../tex.png", png_bytes(np.zeros((4, 4, 3), np.uint8)))
    z = write(tmp_path, "evil.zip", buf.getvalue())
    out = tmp_path / "out"
    model, texture = extract_model(z, str(out), 1 << 20)
    assert model == str(out / "model.drc") and texture == str(out / "texture.png")
    assert sorted(p.name for p in out.iterdir()) == ["model.drc", "texture.png"]


def test_texture_limits(tmp_path):
    small = write(tmp_path, "t.png", png_bytes(np.zeros((10, 20, 3), np.uint8)))
    found = sniff_upload(small, "texture", LIMITS)
    assert found.format == "png" and found.detail == {"width": 20, "height": 10}
    buf = io.BytesIO()
    Image.new("RGB", (40, 8)).save(buf, format="WEBP")
    assert sniff_upload(write(tmp_path, "t.webp", buf.getvalue()), "texture", LIMITS).format == "webp"
    with pytest.raises(InputRejected):
        sniff_upload(small, "texture", {**LIMITS, "max_texture_side": 16})
    with pytest.raises(InputRejected):
        sniff_upload(write(tmp_path, "t.txt", b"hello"), "texture", LIMITS)


def test_ops_ndjson_and_gzip(tmp_path):
    lines = b"\n".join(json.dumps({"op": "fill", "i": i}).encode() for i in range(5)) + b"\n\n"
    plain = sniff_upload(write(tmp_path, "o.ndjson", lines), "ops", LIMITS)
    assert plain.format == "ndjson" and plain.detail["lines"] == 5
    gz = sniff_upload(write(tmp_path, "o.gz", gzip.compress(lines)), "ops", LIMITS)
    assert gz.format == "ndjson+gzip" and gz.content_type == "application/gzip"
    with pytest.raises(InputRejected, match="第 2 行"):
        sniff_upload(write(tmp_path, "o2", b'{"a":1}\n[1,2]\n'), "ops", LIMITS)
    with pytest.raises(InputRejected):
        sniff_upload(write(tmp_path, "o3", b'{"a":1}\nnot json\n'), "ops", LIMITS)
    with pytest.raises(InputRejected):
        sniff_upload(write(tmp_path, "o4", b"\n\n"), "ops", LIMITS)
    bomb = gzip.compress(b'{"a":"' + b"x" * (2 << 20) + b'"}\n')
    with pytest.raises(InputRejected, match="上限"):
        sniff_upload(write(tmp_path, "o5", bomb), "ops", LIMITS)


def test_script_text(tmp_path):
    assert (
        sniff_upload(write(tmp_path, "s.ts", "const a = 1; // 中文\n".encode()), "script", LIMITS).format
        == "text"
    )
    with pytest.raises(InputRejected):
        sniff_upload(write(tmp_path, "s2", b"abc\x00def"), "script", LIMITS)
    with pytest.raises(InputRejected):
        sniff_upload(write(tmp_path, "s3", b"\xff\xfe\xfa"), "script", LIMITS)
    with pytest.raises(InputRejected):
        sniff_upload(write(tmp_path, "s4", b"x"), "video", LIMITS)


def test_sniff_task_and_scan_reading(tmp_path):
    mesh = room_mesh()
    z = write(tmp_path, "scan.zip", scan_zip(mesh))
    assert sniff_task(z, "scan", LIMITS)["format"] == "zip"
    model, texture = prepare_model_file(z, str(tmp_path), 1 << 28)
    assert model.endswith("model.drc") and texture.endswith("texture.jpg")
    limits = {"max_scan_bytes": 1 << 28, "max_triangles": 100_000, "max_texture_pixels": 1 << 24}
    loaded = read_scan(z, str(tmp_path / "w"), limits)
    assert loaded.triangle_count == mesh.triangle_count and loaded.texture is not None
    with pytest.raises(InputRejected, match="三角形数"):
        read_scan(z, str(tmp_path / "w2"), {**limits, "max_triangles": 100})
    obj = write(tmp_path, "big.obj", b"v 0 0 0\nv 1 0 0\nv 0 0 1\n" + b"f 1 2 3\n" * 50)
    with pytest.raises(InputRejected):
        read_scan(obj, str(tmp_path / "w3"), {**limits, "max_triangles": 10})
