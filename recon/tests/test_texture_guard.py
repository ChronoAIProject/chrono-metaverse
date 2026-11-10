"""贴图像素上限在解码之前检查（设计 6.4 解析前检查）：glb 里不论贴图放在哪里都要查，trimesh 打开的贴图
在转换成数组之前再查一次，PIL 自带的解压炸弹检查不能被关掉。"""

from __future__ import annotations

import base64
import json
import struct
import zlib

import numpy as np
import pytest
from PIL import Image

from conftest import png_bytes
from metaverse_recon.errors import InputRejected
from metaverse_recon.processing.glb import GlbMesh, write_glb
from metaverse_recon.processing.modelimport import load_model
from metaverse_recon.processing.scan import inspect_glb, load_scan
from metaverse_recon.processing.sniff import sniff_upload

MAX_PIXELS = 8192 * 8192
BIN = 0x004E4942


def png_header(width: int, height: int) -> bytes:
    """只有文件头的 PNG：IHDR 声明尺寸，IDAT 是空的。读尺寸不用解码，真要解码会按声明的尺寸分配内存。"""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"")) + chunk(b"IEND", b"")
    )


def small_png(side: int = 16) -> bytes:
    rng = np.random.default_rng(1)
    return png_bytes(rng.integers(0, 255, (side, side, 3), dtype=np.uint8))


def quad_glb(image: bytes | None = None) -> bytes:
    vertices = np.array([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], np.float64)
    faces = np.array([[0, 1, 2], [0, 2, 3]], np.int64)
    uv = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], np.float64)
    return write_glb(GlbMesh(vertices, faces, uv=uv, image=image or small_png(), image_mime="image/png"))


def split_glb(data: bytes) -> tuple[dict, bytes]:
    json_len = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20 : 20 + json_len])
    bin_len = struct.unpack_from("<I", data, 20 + json_len)[0]
    start = 20 + json_len + 8
    return doc, data[start : start + bin_len]


def join_glb(doc: dict, bin_data: bytes | None, *, bin_type: int = BIN) -> bytes:
    js = json.dumps(doc).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    body = struct.pack("<II", len(js), 0x4E4F534A) + js
    if bin_data is not None:
        padded = bin_data + b"\0" * ((4 - len(bin_data) % 4) % 4)
        body += struct.pack("<II", len(padded), bin_type) + padded
    return struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body


def data_uri(data: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64," + base64.b64encode(data).decode()


def with_uri_image(image: bytes) -> bytes:
    """贴图改成 `images[0].uri = data:...`，不经过 bufferView（检查以前跳过的写法）。"""
    doc, bin_data = split_glb(quad_glb())
    doc["images"][0] = {"uri": data_uri(image), "mimeType": "image/png"}
    return join_glb(doc, bin_data)


def with_buffer_uri_image(image: bytes) -> bytes:
    """贴图放在第二个数据块里，这个数据块是 `data:` uri（bufferView 指向它，而不是 BIN 块）。"""
    doc, bin_data = split_glb(quad_glb())
    doc["buffers"].append({"byteLength": len(image), "uri": data_uri(image, "application/octet-stream")})
    doc["bufferViews"].append({"buffer": 1, "byteOffset": 0, "byteLength": len(image)})
    doc["images"][0] = {"bufferView": len(doc["bufferViews"]) - 1, "mimeType": "image/png"}
    return join_glb(doc, bin_data)


def write(tmp_path, name: str, data: bytes) -> str:
    path = tmp_path / name
    path.write_bytes(data)
    return str(path)


# ---------------------------------------------------------------------------- glb 里的各种贴图位置


def test_data_uri_texture_within_limit_still_loads(tmp_path):
    path = write(tmp_path, "ok.glb", with_uri_image(small_png(16)))
    assert inspect_glb(path, 100, MAX_PIXELS) == 2
    mesh = load_scan(path)
    assert mesh.texture is not None and mesh.texture.shape == (16, 16, 3)
    loaded, _colors, _base = load_model(path, None, max_triangles=100, max_texture_pixels=MAX_PIXELS)
    assert loaded.texture is not None and loaded.texture.shape[:2] == (16, 16)


def test_data_uri_texture_over_limit_rejected_before_decode(tmp_path):
    bomb = png_header(20000, 20000)  # 4 亿像素，文件只有几十字节
    path = write(tmp_path, "bomb.glb", with_uri_image(bomb))
    with pytest.raises(InputRejected, match="超过上限"):
        inspect_glb(path, 100, MAX_PIXELS)
    with pytest.raises(InputRejected, match="超过上限"):
        load_scan(path, max_texture_pixels=MAX_PIXELS)
    with pytest.raises(InputRejected, match="超过上限"):
        load_model(path, None, max_triangles=100, max_texture_pixels=MAX_PIXELS)


def test_texture_in_data_uri_buffer_is_checked(tmp_path):
    ok = write(tmp_path, "ok.glb", with_buffer_uri_image(small_png(8)))
    assert inspect_glb(ok, 100, MAX_PIXELS) == 2
    bomb = write(tmp_path, "bomb.glb", with_buffer_uri_image(png_header(20000, 20000)))
    with pytest.raises(InputRejected, match="超过上限"):
        inspect_glb(bomb, 100, MAX_PIXELS)
    with pytest.raises(InputRejected, match="超过上限"):
        load_scan(bomb, max_texture_pixels=MAX_PIXELS)


def test_bin_chunk_texture_still_checked(tmp_path):
    ok = write(tmp_path, "ok.glb", quad_glb(small_png(32)))
    assert inspect_glb(ok, 100, MAX_PIXELS) == 2
    with pytest.raises(InputRejected, match="超过上限"):
        inspect_glb(ok, 100, 32 * 32 - 1)


def test_textures_that_cannot_be_checked_are_rejected(tmp_path):
    doc, bin_data = split_glb(quad_glb())

    external = dict(doc, images=[{"uri": "texture.png"}])
    with pytest.raises(InputRejected, match="外部文件"):
        inspect_glb(write(tmp_path, "external.glb", join_glb(external, bin_data)), 100, MAX_PIXELS)

    external_buffer = json.loads(json.dumps(doc))
    external_buffer["buffers"].append({"byteLength": 64, "uri": "other.bin"})
    external_buffer["bufferViews"].append({"buffer": 1, "byteOffset": 0, "byteLength": 64})
    external_buffer["images"][0] = {"bufferView": len(external_buffer["bufferViews"]) - 1}
    with pytest.raises(InputRejected, match="外部文件"):
        inspect_glb(
            write(tmp_path, "external-buffer.glb", join_glb(external_buffer, bin_data)), 100, MAX_PIXELS
        )

    # 第二个数据块没写 uri：trimesh 会去读后面的块，我们读不到同一个位置
    second_bin = json.loads(json.dumps(doc))
    second_bin["buffers"].append({"byteLength": 64})
    second_bin["bufferViews"].append({"buffer": 1, "byteOffset": 0, "byteLength": 64})
    second_bin["images"][0] = {"bufferView": len(second_bin["bufferViews"]) - 1}
    with pytest.raises(InputRejected, match="第一个数据块"):
        inspect_glb(write(tmp_path, "second-bin.glb", join_glb(second_bin, bin_data)), 100, MAX_PIXELS)

    # JSON 之后先放一个未知类型的块：trimesh 会跳过它去读后面的 BIN，我们读的位置就对不上了
    with pytest.raises(InputRejected, match="BIN"):
        inspect_glb(
            write(tmp_path, "unknown-chunk.glb", join_glb(doc, bin_data, bin_type=0x12345678)),
            100,
            MAX_PIXELS,
        )

    bad_view = dict(doc, images=[{"bufferView": 99}])
    with pytest.raises(InputRejected, match="编号不合法"):
        inspect_glb(write(tmp_path, "bad-view.glb", join_glb(bad_view, bin_data)), 100, MAX_PIXELS)

    bad_base64 = dict(doc, images=[{"uri": "data:image/png;base64,A"}])
    with pytest.raises(InputRejected, match="base64"):
        inspect_glb(write(tmp_path, "bad-base64.glb", join_glb(bad_base64, bin_data)), 100, MAX_PIXELS)


# ---------------------------------------------------------------------------- trimesh 打开的贴图


def obj_with_material(tmp_path, texture: bytes) -> str:
    """obj 的材质引用同目录下的贴图：trimesh 加载模型时会打开它（处理服务没有单独检查过这张图）。"""
    (tmp_path / "m.mtl").write_text("newmtl m\nmap_Kd tex.png\n")
    (tmp_path / "tex.png").write_bytes(texture)
    obj = tmp_path / "model.obj"
    obj.write_text(
        "mtllib m.mtl\nusemtl m\n"
        "v 0 0 0\nv 1 0 0\nv 1 0 1\nv 0 0 1\n"
        "vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\n"
        "f 1/1 2/2 3/3\nf 1/1 3/3 4/4\n"
    )
    return str(obj)


def test_texture_opened_by_trimesh_checked_before_decode(tmp_path):
    path = obj_with_material(tmp_path, small_png(40))
    mesh = load_scan(path, max_texture_pixels=MAX_PIXELS)
    assert mesh.texture is not None and mesh.texture.shape == (40, 40, 3)
    with pytest.raises(InputRejected, match="超过上限"):
        load_scan(path, max_texture_pixels=40 * 40 - 1)
    with pytest.raises(InputRejected, match="超过上限"):
        load_model(path, None, max_triangles=100, max_texture_pixels=40 * 40 - 1)


def test_separate_texture_checked_before_model_is_loaded(tmp_path):
    """压缩包里单独给的贴图如果也被 obj 的材质引用，trimesh 加载模型时就会打开它，所以要先检查。"""
    bomb = png_header(9000, 9000)
    path = obj_with_material(tmp_path, bomb)
    texture = str(tmp_path / "tex.png")
    with pytest.raises(InputRejected, match="超过上限"):
        load_scan(path, texture, max_texture_pixels=MAX_PIXELS)
    with pytest.raises(InputRejected, match="超过上限"):
        load_model(path, texture, max_triangles=100, max_texture_pixels=MAX_PIXELS)


def test_pil_decompression_bomb_check_stays_on(tmp_path):
    """PIL 的检查按任务的上限打开，不能是 None；大到 PIL 直接拒绝打开的图也报成像素超限。"""
    path = write(tmp_path, "ok.glb", quad_glb())
    load_scan(path, max_texture_pixels=4096)
    assert Image.MAX_IMAGE_PIXELS == 4096
    limits = {"max_texture_side": 8192, "max_texture_pixels": 4096, "max_ops_bytes": 1, "max_zip_bytes": 1}
    with pytest.raises(InputRejected, match="超过上限"):
        sniff_upload(write(tmp_path, "big.png", png_header(100, 100)), "texture", limits)
    assert Image.MAX_IMAGE_PIXELS == 4096
