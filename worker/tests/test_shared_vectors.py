"""跨语言测试向量：`api/crates/metaverse-core/tests/vectors/`（由 Rust 生成，三种语言共用）。

目录不存在时（例如只检出了 worker/）跳过；也可以用 `METAVERSE_VECTORS_DIR` 指定别的目录。
"""

import base64
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pytest

from metaverse_worker import chunk as ch
from metaverse_worker import shapes as sh
from metaverse_worker.canonical import CanonicalError, canonicalize_text
from metaverse_worker.processing import shape_mesh as sm
from metaverse_worker.records import record_hash

VECTORS = Path(
    os.environ.get("METAVERSE_VECTORS_DIR")
    or Path(__file__).resolve().parents[2] / "api" / "crates" / "metaverse-core" / "tests" / "vectors"
)


def _load(prefix: str):
    if not VECTORS.is_dir():
        return [pytest.param(None, marks=pytest.mark.skip(reason=f"没有测试向量目录 {VECTORS}"))]
    files = sorted(VECTORS.glob(f"{prefix}_*.json"))
    return [pytest.param(json.loads(f.read_text("utf-8")), id=f.stem) for f in files]


@pytest.mark.parametrize("vector", _load("canonical"))
def test_canonical_vectors(vector):
    if vector.get("error"):
        with pytest.raises(CanonicalError) as err:
            canonicalize_text(vector["input"])
        assert err.value.code == vector["error"]
        return
    out = canonicalize_text(vector["input"])
    assert out == vector["canonical"]
    assert hashlib.sha256(out.encode()).hexdigest() == vector["sha256"]
    if vector.get("record"):
        rec = vector["record"]
        assert record_hash(rec["kind"], rec["spaceId"], json.loads(vector["input"])) == rec["hash"]


@pytest.mark.parametrize("vector", _load("chunk"))
def test_chunk_vectors(vector):
    cells = ch.empty_chunk()
    for fill in vector["fills"]:
        (x0, y0, z0), (x1, y1, z1) = fill["min"], fill["max"]
        cells[y0:y1, z0:z1, x0:x1] = fill["block"]
    for cell in vector["cells"]:
        assert ch.cell_index(cell["x"], cell["y"], cell["z"]) == cell["index"]
        cells[cell["y"], cell["z"], cell["x"]] = cell["block"]
    data = ch.canonical_bytes(cells)
    assert len(data) == vector["byteLength"]
    for check in vector["byteChecks"]:
        assert data[check["offset"]] == check["value"]
    assert ch.non_zero_count(cells) == vector["nonZeroCount"]
    assert ch.is_empty(cells) == vector["isEmpty"]
    assert hashlib.sha256(data).hexdigest() == vector["canonicalBytesSha256"]
    assert ch.chunk_hash(cells) == vector["hash"]
    assert np.array_equal(ch.decompress(base64.b64decode(vector["compressedBase64"])), cells)
    assert np.array_equal(ch.decompress(ch.compress(cells)), cells)


@pytest.mark.parametrize("vector", _load("shape"))
def test_shape_vectors(vector):
    templates = vector.get("templates") or {}
    if not vector["valid"]:
        with pytest.raises(sh.ShapeError):
            sh.validate_shape(vector["shape"])
            for template in templates.values():
                sh.validate_shape(template)
            sh.shape_bounds(vector["shape"], templates)
        return
    sh.validate_shape(vector["shape"])
    b = sh.shape_bounds(vector["shape"], templates)
    tol = vector.get("tolerance", 1e-9)
    assert b["min"] == pytest.approx(vector["bounds"]["min"], abs=tol)
    assert b["max"] == pytest.approx(vector["bounds"]["max"], abs=tol)
    if "triangles" not in vector:
        return
    # 网格（与网站同样的生成方式）：三角形数按向量；局部网格的包围盒按变换的 8 个角点取包围盒，与向量相同。
    local = {k: v for k, v in vector["shape"].items() if k != "transform"}
    mesh = sm.shape_mesh(local, templates)
    assert mesh.triangle_count == vector["triangles"]
    lo, hi = mesh.bounds()
    got = sh.transform_bounds(vector["shape"].get("transform"), {"min": list(lo), "max": list(hi)})
    assert got["min"] == pytest.approx(vector["bounds"]["min"], abs=1e-9)
    assert got["max"] == pytest.approx(vector["bounds"]["max"], abs=1e-9)
    # 三角形朝外：几何法线与顶点法线同向。
    tri = mesh.positions[mesh.indices]
    face = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    assert (np.einsum("ij,ij->i", face, mesh.normals[mesh.indices[:, 0]]) > 0).all()


def test_triangle_vectors_present():
    if not VECTORS.is_dir():
        pytest.skip(f"没有测试向量目录 {VECTORS}")
    counted = [
        f.stem for f in VECTORS.glob("shape_*.json") if "triangles" in json.loads(f.read_text("utf-8"))
    ]
    assert any("plate" in name for name in counted) and any("hull" in name for name in counted)
