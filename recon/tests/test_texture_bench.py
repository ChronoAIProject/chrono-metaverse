"""贴图工作台：`refshot`（正交展开、稳健中位色、建议平铺）、`texture`（{file} 引用、标定、对比图）、
`texsearch` / `texfetch`（材质库，网络用桩）。"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from metaverse_recon.bench import cli
from metaverse_recon.bench import texwork as tw
from metaverse_recon.bench.core import Box, ReconError
from metaverse_recon.bench.library import http
from metaverse_recon.bench.library import textures as lt
from metaverse_recon.bench.render import available
from metaverse_recon.bundle.textures import check_authored
from metaverse_recon.processing.scan import ScanMesh
from recon_support import make_base, object_body
from synthetic import _quad_grid, merged, room_mesh

A, B = (200, 180, 150), (60, 50, 40)


def striped_top(period: float = 0.25, size=(1.5, 0.75), y: float = 0.75) -> ScanMesh:
    """桌面（y = 0.75）：x 方向每 `period` 米一个周期的条纹，七成浅色、三成深色。"""
    verts, faces, st = _quad_grid([1.0, y, 2.0], [0, 0, size[1]], [size[0], 0, 0], 30, 60)
    # 法线 = u × v = z × x = +y（朝上）
    w = 512
    xs = (np.arange(w) + 0.5) / w * size[0]
    row = np.where((xs % period) < 0.7 * period, 0, 1)
    tex = np.zeros((8, w, 3), np.uint8)
    tex[:, row == 0] = A
    tex[:, row == 1] = B
    uv = np.c_[st[:, 1], np.full(len(st), 0.5)]
    return ScanMesh(verts, faces, uv, tex)


def test_face_frames():
    box = Box(np.array([0.0, 0.0, 0.0]), np.array([2.0, 1.0, 1.0]))
    frame, w, h = tw.face_frame(box, "top", 0.0)
    assert frame["n"] == [0, 1, 0] and (w, h) == (2.0, 1.0) and frame["origin"] == [0.0, 1.0, 0.0]
    frame, w, h = tw.face_frame(box, "front", 0.0)
    assert np.allclose(frame["n"], [0, 0, 1]) and np.allclose(frame["v"], [0, -1, 0]) and (w, h) == (2.0, 1.0)
    frame, w, h = tw.face_frame(box, "front", 90.0)  # 正面朝 +x
    assert np.allclose(frame["n"], [1, 0, 0]) and np.isclose(w, 1.0)
    with pytest.raises(ReconError, match="--face"):
        tw.face_frame(box, "side", 0.0)


def test_robust_median_ignores_highlights():
    px = np.array([[100, 100, 100]] * 90 + [[255, 255, 255]] * 5 + [[0, 0, 0]] * 5, float)
    assert np.allclose(tw.robust_median(px), [100, 100, 100])
    assert tw.delta_e([100, 100, 100], [100, 100, 100]) == 0.0
    assert tw.delta_e([100, 100, 100], [110, 100, 100]) > 1


def test_refshot_top_of_a_table(tmp_path):
    mesh = merged(room_mesh(), striped_top())
    base = make_base(
        tmp_path,
        mesh,
        objects={"table-01": object_body("table-01", [1.0, 0, 2.0], [2.5, 0.75, 2.75], "table", "桌子")},
    )
    out = tmp_path / "ref"
    assert (
        cli.main(
            [
                "refshot",
                "--base",
                str(base),
                "--object",
                "table-01",
                "--face",
                "top",
                "--px",
                "0.005",
                "--out",
                str(out),
            ]
        )
        == 0
    )
    info = json.loads((out / "refshot.json").read_text())
    assert info["sizePx"] == [300, 150] and info["coverage"] > 0.95
    assert np.allclose(info["median"]["srgb"], A, atol=3)
    assert info["suggestedTile"][0] == pytest.approx(0.25, abs=0.01) and info["tileBasis"][0] == "period"
    assert info["tileBasis"][1] == "extent" and info["n"] == [0.0, 1.0, 0.0]
    img = Image.open(out / "refshot.png")
    assert img.mode == "RGBA" and img.size == (300, 150)
    # 窗口里没有扫描：报错
    assert (
        cli.main(
            [
                "refshot",
                "--base",
                str(base),
                "--box",
                "5,5,5,6,6,6",
                "--face",
                "top",
                "--out",
                str(tmp_path / "x"),
            ]
        )
        == 2
    )


def jpeg(color, size=(32, 32)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG", quality=92)
    return buf.getvalue()


def model_file(tmp_path) -> Path:
    body = {
        "entityId": "table-01",
        "layer": "rebuilt",
        "kind": "object",
        "label": "桌子",
        "shape": {
            "type": "group",
            "children": [
                {
                    "type": "box",
                    "size": [1.5, 0.04, 0.75],
                    "transform": {"position": [1.75, 0.71, 2.375]},
                    "material": {"color": [200, 200, 200]},
                },
                {"type": "box", "size": [0.1, 0.71, 0.1], "transform": {"position": [1.1, 0, 2.1]}},
            ],
        },
    }
    path = tmp_path / "work" / "table.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(body))
    return path


def test_texture_writes_file_references(tmp_path):
    path = model_file(tmp_path)
    (tmp_path / "c.jpg").write_bytes(jpeg((220, 210, 200)))
    (tmp_path / "n.jpg").write_bytes(jpeg((128, 128, 255)))
    assert (
        cli.main(
            [
                "texture",
                "--model",
                str(path),
                "--part",
                "$.children[0]",
                "--color",
                str(tmp_path / "c.jpg"),
                "--normal",
                str(tmp_path / "n.jpg"),
                "--tile",
                "1.3,1.0",
                "--offset",
                "0.1,0",
            ]
        )
        == 0
    )
    body = json.loads(path.read_text())
    mat = body["shape"]["children"][0]["material"]
    assert mat["shading"] == "albedo" and mat["tile"] == [1.3, 1.0] and mat["uv"] == "planar"
    assert set(mat["texture"]) == {"file"} and (path.parent / mat["texture"]["file"]).exists()
    assert mat["normalMap"]["file"].startswith("textures/") and "color" not in mat
    assert (path.parent / "table.json.bak").exists()
    assert check_authored({"version": 1, "entities": [body]})["textureFiles"] == 2
    # 部件路径不对、指到组合上、颜色材质不能带 offset 不带 tile：报错，文件不变
    before = path.read_text()
    assert (
        cli.main(
            ["texture", "--model", str(path), "--part", "$.children[5]", "--color", str(tmp_path / "c.jpg")]
        )
        == 2
    )
    assert cli.main(["texture", "--model", str(path), "--part", "$", "--color", str(tmp_path / "c.jpg")]) == 2
    assert (
        cli.main(
            [
                "texture",
                "--model",
                str(path),
                "--part",
                "$.children[1]",
                "--color",
                str(tmp_path / "c.jpg"),
                "--offset",
                "1,1",
            ]
        )
        == 2
    )
    assert path.read_text() == before


@pytest.mark.skipif(not available(), reason="没有渲染工具（metaverse-recon doctor）")
def test_texture_calibrate_and_preview(tmp_path):
    mesh = merged(room_mesh(), striped_top())
    base = make_base(tmp_path, mesh)
    path = model_file(tmp_path)
    ref = {"face": "top", "front": 0.0, "median": {"srgb": [200, 180, 150]}}
    (tmp_path / "ref.json").write_text(json.dumps(ref))
    (tmp_path / "c.jpg").write_bytes(jpeg((120, 120, 120)))
    preview = tmp_path / "cmp.jpg"
    assert (
        cli.main(
            [
                "texture",
                "--model",
                str(path),
                "--part",
                "$.children[0]",
                "--color",
                str(tmp_path / "c.jpg"),
                "--tile",
                "1,1",
                "--base",
                str(base),
                "--refshot",
                str(tmp_path / "ref.json"),
                "--calibrate",
                "--preview",
                str(preview),
            ]
        )
        == 0
    )
    metrics = json.loads(preview.with_suffix(".json").read_text())
    assert metrics["after"]["dE"] < 6 and metrics["after"]["dE"] < metrics["before"]["dE"]
    mat = json.loads(path.read_text())["shape"]["children"][0]["material"]
    assert (path.parent / mat["texture"]["file"]).exists() and preview.exists()


def test_texsearch_and_texfetch_with_stubbed_libraries(tmp_path, monkeypatch):
    ph_assets = {
        "marble_01": {
            "name": "Marble 01",
            "tags": ["marble", "white"],
            "categories": ["stone"],
            "dimensions": [2000, 2000],
            "authors": {"Rob Tuytel": "All"},
        },
        "brick_wall": {
            "name": "Brick Wall",
            "tags": ["brick"],
            "categories": ["wall"],
            "dimensions": [3000, 3000],
        },
    }
    acg = {
        "foundAssets": [
            {
                "assetId": "Marble012",
                "displayName": "Marble 012",
                "tags": ["marble", "white"],
                "dimensionX": 150,
                "dimensionY": 150,
            }
        ]
    }

    def fake_json(url, headers=None, retries=3):
        if "assets?t=textures" in url:
            return ph_assets
        if "ambientcg.com/api" in url:
            return acg
        if "/files/marble_01" in url:
            return {
                k: {"1k": {"jpg": {"url": f"https://dl.polyhaven.org/{k}.jpg"}}}
                for k in ("Diffuse", "nor_gl", "Rough")
            }
        raise AssertionError(url)

    def fake_download(url, dest, *, max_bytes, headers=None, retries=3):
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        if url.endswith(".zip"):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as zf:
                zf.writestr("Marble012_1K-JPG_Color.jpg", jpeg((230, 230, 225)))
                zf.writestr("Marble012_1K-JPG_NormalDX.jpg", jpeg((128, 60, 255)))
                zf.writestr("Marble012_1K-JPG_Roughness.jpg", jpeg((90, 90, 90)))
            Path(dest).write_bytes(buf.getvalue())
        else:
            Path(dest).write_bytes(jpeg((100, 100, 100)))
        return "x", 1

    monkeypatch.setattr(http, "get_json", fake_json)
    monkeypatch.setattr(http, "download", fake_download)
    monkeypatch.setattr("metaverse_recon.bench.library.search._thumb", lambda url: None)
    out = tmp_path / "s"
    assert cli.main(["texsearch", "--query", "white marble", "--out", str(out)]) == 0
    cands = json.loads((out / "candidates.json").read_text())
    assert {c["id"] for c in cands} == {"marble_01", "Marble012"} and (out / "sheet.jpg").exists()
    assert all(c["license"] == "CC0-1.0" for c in cands)
    by_id = {c["id"]: c for c in cands}
    assert by_id["marble_01"]["sizeM"] == [2.0, 2.0] and by_id["Marble012"]["sizeM"] == [1.5, 1.5]
    ph = tmp_path / "ph"
    assert (
        cli.main(
            [
                "texfetch",
                "--from",
                f"{out / 'candidates.json'}#{by_id['marble_01']['pick']}",
                "--out",
                str(ph),
            ]
        )
        == 0
    )
    info = json.loads((ph / "texture.json").read_text())
    assert set(info["files"]) == {"color", "normal", "roughness"} and info["sizeM"] == [2.0, 2.0]
    assert info["author"] == "Rob Tuytel" and info["normalConvention"] == "opengl"
    ac = tmp_path / "acg"
    assert (
        cli.main(
            [
                "texfetch",
                "--from",
                f"{out / 'candidates.json'}#{by_id['Marble012']['pick']}",
                "--out",
                str(ac),
            ]
        )
        == 0
    )
    info = json.loads((ac / "texture.json").read_text())
    assert info["files"]["normal"]["file"] == "normal.png"
    g = np.asarray(Image.open(ac / "normal.png"))[..., 1].mean()
    assert g == pytest.approx(255 - 60, abs=3)  # DirectX → OpenGL：绿色翻转
    assert not (ac / "download.zip").exists()


def test_dx_to_gl_flips_green():
    data = lt.dx_to_gl(jpeg((128, 10, 250)))
    arr = np.asarray(Image.open(io.BytesIO(data)))
    assert abs(arr[..., 1].mean() - 245) < 3 and abs(arr[..., 0].mean() - 128) < 3
