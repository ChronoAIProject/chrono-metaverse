"""实际扫描导入的来源、下载边界及打包约定。"""

import io
import json
import zipfile
from typing import ClassVar

import pytest

from metaverse_recon.bench.core import ReconError
from metaverse_recon.bench.source import _download, prepare_source, scaniverse_url


class Response(io.BytesIO):
    headers: ClassVar[dict] = {}


class Scaniverse:
    def __init__(self, model_type="mesh", host="scaniverse.com"):
        self.urls = []
        props = {
            "scanModel": {
                "id": "one",
                "modelType": model_type,
                "media": {"meshUrl": f"https://{host}/mesh.drc", "texUrl": f"https://{host}/tex.jpg"},
            }
        }
        self.page = '<script id="__NEXT_DATA__">' + json.dumps({"props": {"pageProps": props}}) + "</script>"

    def open(self, request, timeout):
        self.urls.append(request.full_url)
        return Response(self.page.encode() if "/scan/" in request.full_url else b"model-bytes")


def test_scaniverse_mesh_prepares_the_real_pipeline_zip(tmp_path):
    remote = Scaniverse()
    result = prepare_source("https://scaniverse.com/scan/one?share=yes", str(tmp_path), opener=remote)
    assert result["kind"] == "scaniverse"
    assert remote.urls == [
        "https://scaniverse.com/scan/one",
        "https://scaniverse.com/mesh.drc",
        "https://scaniverse.com/tex.jpg",
    ]
    with zipfile.ZipFile(result["scan"]) as archive:
        assert archive.namelist() == ["mesh.drc", "tex.jpg"]
        assert archive.read("mesh.drc") == b"model-bytes"
    assert json.loads((tmp_path / "source.json").read_text())["sha256"] == result["sha256"]


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.test/scan/one",
        "http://scaniverse.com/scan/one",
        "https://scaniverse.com@evil.test/scan/one",
        "https://scaniverse.com/other",
    ],
)
def test_scaniverse_only_accepts_the_fixed_public_source(url):
    with pytest.raises(ReconError):
        scaniverse_url(url)


@pytest.mark.parametrize("remote", [Scaniverse("splat"), Scaniverse(host="evil.test")])
def test_unsupported_scan_never_downloads_or_publishes_a_fake_mesh(tmp_path, remote):
    with pytest.raises(ReconError, match="网格"):
        prepare_source("https://scaniverse.com/scan/one", str(tmp_path), opener=remote)
    assert len(remote.urls) == 1
    assert not (tmp_path / "source.json").exists()
    assert not (tmp_path / "scan.zip").exists()


def test_local_glb_and_download_size_bound(tmp_path):
    model = tmp_path / "input.glb"
    model.write_bytes(b"glTF\x02\x00\x00\x00")
    result = prepare_source(str(model), str(tmp_path / "out"))
    assert result["size"] == 8
    assert result["kind"] == "file"
    with pytest.raises(ReconError, match="上限"):
        _download("https://scaniverse.com/mesh.drc", tmp_path / "bounded", 4, Scaniverse())
    with pytest.raises(ReconError, match="已有内容"):
        prepare_source(str(model), str(tmp_path / "out"))
