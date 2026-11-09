"""接口服务部署配置种子打包的 zip，处理服务读得懂（跨语言向量）。

向量 `api/crates/metaverse-api/tests/vectors/demo_seed_zip.json` 由接口服务的测试生成和核对（字节与
Rust 实现 `demo_seed::pack::stored_zip` 一致）。这里用处理服务自己的格式嗅探、解包读同一份字节，并核对
接口服务登记资源时写的 `metadata.format` / `contentType` 与处理服务嗅探出来的相同（`register_upload`
登记的就是嗅探结果）。

目录不存在时（例如只检出了 worker/）跳过；也可以用 `METAVERSE_API_VECTORS_DIR` 指定别的目录。
"""

import base64
import hashlib
import json
import os
import zipfile
from pathlib import Path

import pytest

from metaverse_worker.processing.sniff import check_model_file, extract_model, sniff_upload

VECTORS = Path(
    os.environ.get("METAVERSE_API_VECTORS_DIR")
    or Path(__file__).resolve().parents[2] / "api" / "crates" / "metaverse-api" / "tests" / "vectors"
)
VECTOR = VECTORS / "demo_seed_zip.json"

pytestmark = pytest.mark.skipif(not VECTOR.is_file(), reason=f"没有测试向量 {VECTOR}")

LIMITS = {"max_zip_bytes": 1 << 30, "max_texture_side": 8192, "max_texture_pixels": 8192 * 8192}


@pytest.fixture
def vector():
    return json.loads(VECTOR.read_text("utf-8"))


def _members(vector) -> dict[str, bytes]:
    out = {}
    for member in vector["members"]:
        data = base64.b64decode(member["base64"])
        assert hashlib.sha256(data).hexdigest() == member["sha256"]
        out[member["name"]] = data
    return out


def test_packed_zip_is_a_scan_the_worker_accepts(vector, tmp_path):
    data = base64.b64decode(vector["zipBase64"])
    assert hashlib.sha256(data).hexdigest() == vector["zipSha256"]
    path = tmp_path / "scan.zip"
    path.write_bytes(data)

    # 与上传校验（upload_verify → sniff_upload）同一条路径：嗅探结果就是接口服务登记的 format / contentType。
    found = sniff_upload(str(path), "scan", LIMITS)
    registered = vector["registered"]
    assert found.format == registered["format"]
    assert found.content_type == registered["contentType"]
    assert found.detail == registered["detail"]
    assert check_model_file(str(path), 1 << 30) == found

    # scan_import 读扫描时的解包：取出的网格和贴图就是种子下载的原文件。
    members = _members(vector)
    model, texture = extract_model(str(path), str(tmp_path / "out"), 1 << 30)
    assert Path(model).name == "model.drc"
    assert Path(model).read_bytes() == members["mesh.drc"]
    assert texture is not None and Path(texture).name == "texture.jpg"
    assert Path(texture).read_bytes() == members["tex.jpg"]


def test_packed_zip_is_a_plain_stored_archive(vector, tmp_path):
    path = tmp_path / "scan.zip"
    path.write_bytes(base64.b64decode(vector["zipBase64"]))
    members = _members(vector)
    with zipfile.ZipFile(path) as zf:
        assert zf.testzip() is None  # CRC 都对
        infos = zf.infolist()
        assert [i.filename for i in infos] == list(members)
        for info in infos:
            assert info.compress_type == zipfile.ZIP_STORED
            assert info.date_time == (1980, 1, 1, 0, 0, 0)
            assert info.flag_bits == 0
            assert zf.read(info) == members[info.filename]


def test_single_mesh_is_registered_with_the_worker_format(vector, tmp_path):
    single = vector["single"]
    path = tmp_path / single["name"]
    path.write_bytes(_members(vector)[single["name"]])
    found = sniff_upload(str(path), "scan", LIMITS)
    assert found.format == single["format"]
    assert found.content_type == single["contentType"]
