"""测试公用的夹具：合成扫描写成 glb / zip、图片编码、重建工作台的缓存目录、PIL 像素上限的恢复。

本地工具不连数据库，测试也不需要 MongoDB。
"""

from __future__ import annotations

import io
import zipfile

import numpy as np
import pytest
from PIL import Image

from metaverse_recon.processing.glb import GlbMesh, write_glb
from metaverse_recon.processing.scan import ScanMesh


@pytest.fixture(autouse=True)
def _recon_cache(tmp_path_factory, monkeypatch):
    """重建工作台的缓存（模型库索引、下载的模型）放进临时目录：不碰本机的 ~/.cache/metaverse-recon，
    也不会在本机缓存里找到别的模型旁注。"""
    monkeypatch.setenv("METAVERSE_RECON_CACHE", str(tmp_path_factory.mktemp("recon-cache")))


def png_bytes(texture: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(texture).save(buf, format="PNG")
    return buf.getvalue()


def jpeg_bytes(texture: np.ndarray, quality: int = 90) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(texture).save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def scan_glb(mesh: ScanMesh) -> bytes:
    """合成扫描写成带贴图的 glb（贴图坐标左上角原点，与 Scaniverse 相同）。"""
    return write_glb(
        GlbMesh(mesh.vertices, mesh.faces, uv=mesh.uv, image=png_bytes(mesh.texture), image_mime="image/png")
    )


def scan_zip(mesh: ScanMesh) -> bytes:
    """合成扫描写成 Scaniverse 导出那样的压缩包：Draco 网格 + 贴图。"""
    import DracoPy

    drc = DracoPy.encode(
        np.asarray(mesh.vertices, np.float32),
        np.asarray(mesh.faces, np.uint32),
        quantization_bits=16,
        tex_coord=np.asarray(mesh.uv, np.float64),
        preserve_order=True,
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("export/mesh.drc", drc)
        zf.writestr("export/texture.jpg", jpeg_bytes(mesh.texture))
        zf.writestr("export/readme.txt", "Scaniverse")
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _restore_pil_pixel_limit():
    """读模型时按任务的上限设置 PIL 的进程级像素上限（`scan.guard_pixels`）；测试之间恢复原值。"""
    saved = Image.MAX_IMAGE_PIXELS
    yield
    Image.MAX_IMAGE_PIXELS = saved
