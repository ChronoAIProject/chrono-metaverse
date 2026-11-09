"""测试公用的夹具：真实本地 MongoDB（随机库名，测试结束删除）、配置、空间 / 任务 / 上传的构造。"""

from __future__ import annotations

import hashlib
import io
import os
import uuid
import zipfile
from typing import Any

import numpy as np
import pytest
from PIL import Image

from metaverse_worker.assets import write_upload_part
from metaverse_worker.config import Config
from metaverse_worker.processing.glb import GlbMesh, write_glb
from metaverse_worker.processing.scan import ScanMesh
from metaverse_worker.store import Store
from metaverse_worker.timeutil import now_ts

MONGO_URI = os.environ.get("METAVERSE_TEST_MONGODB_URI", "mongodb://127.0.0.1:27018/?replicaSet=rs0")
SPACE = "front-hall"
OWNER = {"kind": "person", "id": "alice"}
ACTOR = {"sub": "alice", "nyxServiceId": "dev-service"}


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


def make_config(database: str = "unused", **overrides: Any) -> Config:
    values: dict[str, Any] = {
        "mongodb_uri": MONGO_URI,
        "mongodb_database": database,
        "worker_id": "test-worker",
        "poll_seconds": 0.05,
        "job_memory_mb": 4096,
        "job_timeout_seconds": 600,
        "health_port": 0,
        "health_host": "127.0.0.1",
    }
    values.update(overrides)
    return Config(**values)


@pytest.fixture(autouse=True)
def _restore_pil_pixel_limit():
    """读模型时按任务的上限设置 PIL 的进程级像素上限（`scan.guard_pixels`）；测试之间恢复原值。"""
    saved = Image.MAX_IMAGE_PIXELS
    yield
    Image.MAX_IMAGE_PIXELS = saved


@pytest.fixture
def config(tmp_path) -> Config:
    return make_config(workdir=str(tmp_path))


@pytest.fixture
def store():
    from pymongo import MongoClient
    from pymongo.errors import PyMongoError

    client: MongoClient = MongoClient(MONGO_URI, serverSelectionTimeoutMS=2000, tz_aware=True)
    try:
        client.admin.command("ping")
    except PyMongoError:
        client.close()
        pytest.skip("本地 MongoDB 不可用")
    name = f"mvw_test_{uuid.uuid4().hex[:12]}"
    s = Store(client, name)
    s.ensure_indexes()
    try:
        yield s
    finally:
        client.drop_database(name)
        client.close()


@pytest.fixture
def db_config(store, tmp_path) -> Config:
    return make_config(store.db.name, workdir=str(tmp_path))


def make_space(
    store: Store, space_id: str = SPACE, regions: list | None = None, owner: dict | None = None
) -> None:
    now = now_ts(store.clock)
    store.spaces.insert_one(
        {
            "_id": space_id,
            "name": "前厅",
            "description": "",
            "owner": owner or OWNER,
            "visibility": "unlisted",
            "shareTokens": [],
            "head": {"seq": 0, "at": now},
            "regions": regions or [],
            "plots": [],
            "storageLimitBytes": 1 << 30,
            "storageUsedBytes": 0,
            "createdAt": now,
            "updatedAt": now,
        }
    )


def make_job(store: Store, kind: str, params: dict, space_id: str = SPACE, job_id: str | None = None) -> str:
    job_id = job_id or uuid.uuid4().hex
    store.jobs.insert_one(
        {
            "_id": job_id,
            "spaceId": space_id,
            "owner": OWNER,
            "kind": kind,
            "params": params,
            "status": "queued",
            "attempt": 0,
            "maxAttempts": 3,
            "createdAt": now_ts(store.clock),
            "actor": ACTOR,
        }
    )
    return job_id


def make_upload(
    store: Store,
    data: bytes,
    purpose: str,
    *,
    declared_sha: str | None = None,
    part_size: int = 256 * 1024 * 4,
    status: str = "complete",
    skip_parts: tuple[int, ...] = (),
    space_id: str = SPACE,
) -> str:
    upload_id = uuid.uuid4().hex
    for part_no, start in enumerate(range(0, len(data), part_size)):
        if part_no in skip_parts:
            continue
        write_upload_part(store, upload_id, part_no, part_size, data[start : start + part_size])
    store.uploads.insert_one(
        {
            "_id": upload_id,
            "spaceId": space_id,
            "owner": OWNER,
            "purpose": purpose,
            "size": len(data),
            "sha256": declared_sha or hashlib.sha256(data).hexdigest(),
            "partSize": part_size,
            "status": status,
            "createdAt": now_ts(store.clock),
        }
    )
    return upload_id


def upload_asset(store: Store, data: bytes, purpose: str, kind: str = "scan") -> str:
    """直接登记一个资源（跳过上传校验），返回内容哈希。"""
    from metaverse_worker.assets import put_asset

    return put_asset(store, data, content_type="application/octet-stream", kind=kind, space_id=SPACE).hash
