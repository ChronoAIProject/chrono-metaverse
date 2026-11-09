"""GridFS 桶 `assets` 里的大文件（设计 6.1、13.2）。

- 每个资源是一个标准 GridFS 文件：`assets.files { _id, length, chunkSize, uploadDate, filename, metadata }`
  + `assets.chunks { files_id, n, data }`；
- **文件名 = 内容的 sha256**（小写十六进制），`assets.files.filename` 上有唯一索引；
- 数据块固定 256 KiB（`ASSET_CHUNK_SIZE`），GridFS 要求同一文件的数据块大小一致，而单个文档不能超过 16MB；
- 分片上传：接口服务把每一片切成 256 KiB 的数据块写入，`files_id` = 上传编号，序号按片号推算
  （`n = 片号 × 每片块数 + i`）；完成后由处理服务流式核对整体哈希，再插入 `assets.files` 文档登记成资源；
- 同一内容被并发登记时，唯一索引冲突的一方删掉自己的数据块，复用已有资源。

先写数据块、最后插入 `files` 文档：`files` 文档出现时，数据块一定已经完整。
"""

from __future__ import annotations

import hashlib
import io
import os
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, BinaryIO

from bson import Binary, ObjectId
from pymongo.client_session import ClientSession

from .canonical import is_sha256_hex
from .store import C, Store, is_duplicate_key

ASSET_CHUNK_SIZE = 256 * 1024
_INSERT_BATCH = 32  # 一次 insert_many 最多 8MiB


class AssetError(RuntimeError):
    pass


@dataclass(frozen=True)
class AssetInfo:
    hash: str
    length: int
    files_id: Any
    created: bool  # True：本次新登记；False：复用了已有资源


def _now() -> datetime:
    return datetime.now(UTC)


def find_asset(store: Store, sha256: str, session: ClientSession | None = None) -> dict[str, Any] | None:
    if not is_sha256_hex(sha256):
        return None
    return store.col(C.ASSET_FILES).find_one({"filename": sha256}, session=session)


def touch_asset(store: Store, sha256: str) -> None:
    """标记资源刚被复用，清理时按 max(上传时间, touchedAt) 计算 7 天宽限。"""
    store.col(C.ASSET_FILES).update_one({"filename": sha256}, {"$set": {"metadata.touchedAt": _now()}})


def delete_file_chunks(store: Store, files_id: Any) -> int:
    return store.col(C.ASSET_CHUNKS).delete_many({"files_id": files_id}).deleted_count


def _write_chunks(store: Store, files_id: Any, blocks: Iterator[bytes], first_n: int = 0) -> int:
    chunks = store.col(C.ASSET_CHUNKS)
    batch: list[dict[str, Any]] = []
    n = first_n
    for block in blocks:
        batch.append({"files_id": files_id, "n": n, "data": Binary(block)})
        n += 1
        if len(batch) >= _INSERT_BATCH:
            chunks.insert_many(batch, ordered=True)
            batch = []
    if batch:
        chunks.insert_many(batch, ordered=True)
    return n - first_n


def _blocks(stream: BinaryIO, size: int = ASSET_CHUNK_SIZE) -> Iterator[bytes]:
    while True:
        block = stream.read(size)
        if not block:
            return
        # 读到的可能少于 size（管道等），补满一块再交出去，保证除最后一块外大小一致。
        while len(block) < size:
            more = stream.read(size - len(block))
            if not more:
                break
            block += more
        yield block


def _file_sha256(path: str) -> tuple[str, int]:
    digest = hashlib.sha256()
    length = 0
    with open(path, "rb") as fh:
        for block in _blocks(fh, 1 << 20):
            digest.update(block)
            length += len(block)
    return digest.hexdigest(), length


def put_asset(
    store: Store,
    data: bytes | str | os.PathLike[str],
    *,
    content_type: str,
    kind: str,
    space_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> AssetInfo:
    """把一段字节或一个本地文件登记成资源（按内容哈希去重）。处理服务生成的贴图、网页用模型都走这里。"""
    if isinstance(data, bytes | bytearray | memoryview):
        raw = bytes(data)
        sha, length = hashlib.sha256(raw).hexdigest(), len(raw)

        def opener() -> BinaryIO:
            return io.BytesIO(raw)
    else:
        path = os.fspath(data)
        sha, length = _file_sha256(path)

        def opener() -> BinaryIO:
            return open(path, "rb")  # 由调用方 with 关闭

    existing = find_asset(store, sha)
    if existing is not None:
        touch_asset(store, sha)
        return AssetInfo(sha, int(existing["length"]), existing["_id"], False)
    files_id = ObjectId()
    try:
        with opener() as stream:
            _write_chunks(store, files_id, _blocks(stream))
        return _insert_files_doc(store, files_id, sha, length, content_type, kind, space_id, extra)
    except BaseException:
        delete_file_chunks(store, files_id)
        raise


def _insert_files_doc(
    store: Store,
    files_id: Any,
    sha: str,
    length: int,
    content_type: str,
    kind: str,
    space_id: str | None,
    extra: dict[str, Any] | None = None,
    session: ClientSession | None = None,
) -> AssetInfo:
    metadata: dict[str, Any] = {"sha256": sha, "contentType": content_type, "kind": kind}
    if space_id:
        metadata["spaceId"] = space_id
    if extra:
        metadata.update(extra)
    doc = {
        "_id": files_id,
        "length": length,
        "chunkSize": ASSET_CHUNK_SIZE,
        "uploadDate": _now(),
        "filename": sha,
        "metadata": metadata,
    }
    try:
        store.col(C.ASSET_FILES).insert_one(doc, session=session)
    except Exception as error:
        if not is_duplicate_key(error):
            raise
        # 同一内容被并发登记：删掉本次的数据块，复用已有资源。
        existing = find_asset(store, sha)
        if existing is None:
            raise
        if existing["_id"] == files_id:
            # 重做的任务：上次已经登记过，就是这一份。
            return AssetInfo(sha, int(existing["length"]), files_id, True)
        delete_file_chunks(store, files_id)
        touch_asset(store, sha)
        return AssetInfo(sha, int(existing["length"]), existing["_id"], False)
    return AssetInfo(sha, length, files_id, True)


def iter_file_chunks(
    store: Store, files_id: Any, length: int, chunk_size: int = ASSET_CHUNK_SIZE
) -> Iterator[bytes]:
    """按序号流式读出一个文件的全部数据块，并核对序号连续、块大小一致、总长度正确。"""
    expected_chunks = (length + chunk_size - 1) // chunk_size
    cursor = (
        store.col(C.ASSET_CHUNKS)
        .find({"files_id": files_id}, {"_id": 0, "n": 1, "data": 1})
        .sort("n", 1)
        .batch_size(16)
    )
    seen = 0
    total = 0
    for doc in cursor:
        if doc["n"] != seen:
            raise AssetError(f"数据块序号不连续：期望 {seen}，实际 {doc['n']}")
        data = bytes(doc["data"])
        is_last = seen == expected_chunks - 1
        if seen >= expected_chunks or (not is_last and len(data) != chunk_size):
            raise AssetError("数据块数量或大小与声明的总长度不符")
        total += len(data)
        seen += 1
        yield data
    if seen != expected_chunks or total != length:
        raise AssetError(f"数据不完整：{total} / {length} 字节，{seen} / {expected_chunks} 块")


def stream_sha256(store: Store, files_id: Any, length: int) -> str:
    """流式计算一个文件（或上传会话的分片）的整体 sha256。数据不完整时抛 AssetError。"""
    digest = hashlib.sha256()
    for data in iter_file_chunks(store, files_id, length):
        digest.update(data)
    return digest.hexdigest()


def download_asset(store: Store, sha256: str, path: str, max_bytes: int | None = None) -> int:
    """把资源写到本地文件，边写边核对内容哈希（防止数据库里的数据被篡改或损坏）。"""
    doc = find_asset(store, sha256)
    if doc is None:
        raise AssetError(f"资源不存在：{sha256}")
    length = int(doc["length"])
    if max_bytes is not None and length > max_bytes:
        raise AssetError(f"资源超过大小上限：{length} > {max_bytes}")
    digest = hashlib.sha256()
    with open(path, "wb") as out:
        for data in iter_file_chunks(store, doc["_id"], length, int(doc.get("chunkSize", ASSET_CHUNK_SIZE))):
            digest.update(data)
            out.write(data)
    if digest.hexdigest() != sha256:
        os.unlink(path)
        raise AssetError(f"资源内容与哈希不符：{sha256}")
    return length


def read_asset(store: Store, sha256: str, max_bytes: int = 64 << 20) -> bytes:
    doc = find_asset(store, sha256)
    if doc is None:
        raise AssetError(f"资源不存在：{sha256}")
    length = int(doc["length"])
    if length > max_bytes:
        raise AssetError(f"资源超过大小上限：{length} > {max_bytes}")
    data = b"".join(iter_file_chunks(store, doc["_id"], length, int(doc.get("chunkSize", ASSET_CHUNK_SIZE))))
    if hashlib.sha256(data).hexdigest() != sha256:
        raise AssetError(f"资源内容与哈希不符：{sha256}")
    return data


def write_upload_part(store: Store, upload_id: Any, part_no: int, part_size: int, data: bytes) -> str:
    """把一片数据写成 256 KiB 的数据块（接口服务的分片上传做同样的事，这里给测试和本地工具用）。

    同一片重传时先删掉它原有的数据块，所以重传是幂等的。返回这一片的 sha256。
    """
    if part_size % ASSET_CHUNK_SIZE != 0 or part_size <= 0:
        raise AssetError("分片大小必须是 256KiB 的整数倍")
    if len(data) > part_size or not data:
        raise AssetError("分片长度不对")
    per_part = part_size // ASSET_CHUNK_SIZE
    first = part_no * per_part
    store.col(C.ASSET_CHUNKS).delete_many(
        {"files_id": upload_id, "n": {"$gte": first, "$lt": first + per_part}}
    )
    _write_chunks(store, upload_id, _blocks(io.BytesIO(data)), first_n=first)
    return hashlib.sha256(data).hexdigest()


def register_upload(
    store: Store,
    upload_id: Any,
    sha: str,
    length: int,
    *,
    content_type: str,
    kind: str,
    space_id: str | None,
    session: ClientSession | None = None,
    extra: dict[str, Any] | None = None,
) -> AssetInfo:
    """把已核对的上传分片登记成资源：插入 `files` 文档（`_id` = 上传编号）。

    重名时删掉本次分片，复用已有资源。
    """
    return _insert_files_doc(
        store,
        upload_id,
        sha,
        length,
        content_type,
        kind,
        space_id,
        {"uploadId": str(upload_id), **(extra or {})},
        session,
    )


def delete_asset(store: Store, sha256: str) -> bool:
    """删除资源：先删 `files` 文档（不再可见），再删数据块。"""
    doc = store.col(C.ASSET_FILES).find_one_and_delete({"filename": sha256})
    if doc is None:
        return False
    delete_file_chunks(store, doc["_id"])
    return True
