"""`upload_verify`：上传完成后的整体校验（设计 6.1）。参数 `{uploadId}`。

上传会话（`uploads` 集合，接口服务创建；字段见 README）：

1. 状态已经是 `done`：之前做完了，直接把任务标记为完成（`result.assetHash` 取上传记录里的）；
2. 状态不是 `complete`：不能校验，任务失败（不可重试）；
3. 已有同一内容哈希的资源，并且就是这次上传登记的（`files._id` = 上传编号）：上次登记成功、还没来得及
   改上传状态，补做第 7 步；
4. 流式读出全部数据块（序号连续、块大小一致、总长度等于声明的大小），边算 sha256 边写到本地临时文件；
   数据不完整或哈希与声明的不一致：先把上传标记为 `failed`（条件 `status: complete`），再删掉数据块，
   任务失败；
5. 按用途嗅探格式（子进程里做，见 `processing/sniff.py`）；不合规同样标记失败、删数据块；
6. 登记成资源（`assets.files` 文档，`_id` = 上传编号、文件名 = 内容哈希）。文件名唯一键冲突（同一内容
   被并发上传、或之前已有）时删掉本次数据块、复用已有资源；
7. 上传标记为 `done` 并写 `assetHash`，任务完成，`result = {assetHash, reused, format, contentType, bytes}`。

每一步都可以重做：崩溃后重新领取的任务按上面的判断从中间接着做。

任务因为输入以外的原因最终失败（子进程超时 / 内存超限、反复崩溃、重试次数用完）时，主循环调用
`on_failed`，让上传离开 `complete`（见 `uploads.settle_upload`），定期清理再兜底一遍。
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from ..assets import AssetError, find_asset, iter_file_chunks, register_upload, touch_asset
from ..errors import InputRejected, PermanentJobError
from ..jobs.lease import Lease, mark_done
from ..processing.sniff import PURPOSES
from ..store import C, Store, UploadStatus
from ..uploads import declared, fail_upload, find_upload, mark_upload_done, settle_upload
from .context import JobContext

log = logging.getLogger(__name__)

SCRIPT_MAX_BYTES = 16 << 20


def _purpose_limit(ctx: JobContext, purpose: str) -> int:
    c = ctx.config
    return {
        "scan": c.max_scan_bytes,
        "model": c.max_model_bytes,
        "texture": c.max_model_bytes,
        "ops": c.max_ops_bytes,
        "script": SCRIPT_MAX_BYTES,
    }[purpose]


class _Rejected(Exception):
    pass


def run(ctx: JobContext) -> dict[str, Any]:
    upload_id = ctx.params.get("uploadId")
    if not isinstance(upload_id, str) or not upload_id:
        raise PermanentJobError("参数 uploadId 必须是非空字符串")
    store = ctx.store
    doc = find_upload(store, ctx.lease.scope, upload_id)
    if doc is None:
        raise PermanentJobError(f"上传 {upload_id} 不存在，或不属于这个空间")
    files_id = doc["_id"]
    status = doc.get("status")
    if status == UploadStatus.DONE and doc.get("assetHash"):
        result = {"assetHash": doc["assetHash"], "reused": True}
        mark_done(store, ctx.lease, result=result)
        return result
    if status != UploadStatus.COMPLETE:
        raise PermanentJobError(f"上传 {upload_id} 的状态是 {status}，不能校验")

    sha, size, purpose = declared(doc)
    try:
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
            raise _Rejected("上传记录里声明的整体哈希不合法")
        if size is None or size < 0:
            raise _Rejected("上传记录里声明的大小不合法")
        if purpose not in PURPOSES:
            raise _Rejected(f"不认识的上传用途：{purpose}")
        if size > _purpose_limit(ctx, purpose):
            raise _Rejected(f"上传大小 {size} 超过用途 {purpose} 的上限")
    except _Rejected as error:
        _fail_upload(ctx, files_id, str(error))
        raise PermanentJobError(str(error)) from error

    existing = find_asset(store, sha)
    if existing is not None and existing["_id"] == files_id:
        log.info("上传 %s 之前已登记成资源，补做收尾", upload_id)
        meta = existing.get("metadata") or {}
        return _finish(ctx, files_id, sha, size, meta.get("format"), meta.get("contentType"), reused=False)
    has_chunks = store.col(C.ASSET_CHUNKS).find_one({"files_id": files_id}, {"_id": 1}) is not None
    if existing is not None and not has_chunks and doc.get("verifiedSha256") == sha:
        # 上次已核对通过、登记时发现重名并删掉了本次数据块，只差收尾
        touch_asset(store, sha)
        meta = existing.get("metadata") or {}
        return _finish(ctx, files_id, sha, size, meta.get("format"), meta.get("contentType"), reused=True)

    # 4. 流式核对整体哈希，同时写到本地文件（嗅探格式要用）
    local = ctx.path("upload.bin")
    digest = hashlib.sha256()
    try:
        with open(local, "wb") as out:
            for data in iter_file_chunks(store, files_id, size):
                digest.update(data)
                out.write(data)
    except AssetError as error:
        reason = f"上传数据不完整：{error}"
        _fail_upload(ctx, files_id, reason)
        raise PermanentJobError(reason) from error
    computed = digest.hexdigest()
    if computed != sha:
        reason = f"整体哈希不符：声明 {sha}，实际 {computed}"
        _fail_upload(ctx, files_id, reason)
        raise PermanentJobError(reason)

    # 5. 按用途嗅探格式
    try:
        sniffed = ctx.compute(
            "metaverse_worker.processing.tasks:sniff_task", path=local, purpose=purpose, limits=ctx.limits()
        )
    except InputRejected as error:
        reason = f"格式不符合用途 {purpose}：{error}"
        _fail_upload(ctx, files_id, reason)
        raise PermanentJobError(reason) from error
    ctx.check_cancel()

    # 6. 登记成资源
    store.uploads.update_one(
        {"_id": files_id, "status": UploadStatus.COMPLETE}, {"$set": {"verifiedSha256": sha}}
    )
    info = register_upload(
        store,
        files_id,
        sha,
        size,
        content_type=sniffed["contentType"],
        kind=purpose,
        space_id=ctx.lease.space_id,
        extra={"format": sniffed["format"]},
    )
    return _finish(
        ctx, files_id, sha, size, sniffed["format"], sniffed["contentType"], reused=not info.created
    )


def _finish(
    ctx: JobContext,
    files_id: Any,
    sha: str,
    size: int,
    fmt: str | None,
    content_type: str | None,
    *,
    reused: bool,
) -> dict[str, Any]:
    mark_upload_done(ctx.store, files_id, sha, fmt=fmt, content_type=content_type)
    result = {"assetHash": sha, "reused": reused, "bytes": size}
    if fmt:
        result["format"] = fmt
    if content_type:
        result["contentType"] = content_type
    mark_done(ctx.store, ctx.lease, result=result)
    log.info("上传 %s 校验通过：%s（%s）", files_id, sha, "复用已有资源" if reused else "新登记")
    return result


def on_failed(store: Store, lease: Lease, error: BaseException | str) -> str | None:
    """任务最终失败（不再重试）以后由主循环调用：上传还停在 `complete` 时让它离开这个状态。

    输入不合格的情况在 `run` 里已经标记过 `failed`，这里什么也不做；其他原因（子进程超时 / 内存超限、
    反复崩溃、数据库抖动导致重试次数用完）由这里处理，见 `uploads.settle_upload`。
    """
    upload_id = lease.params.get("uploadId")
    if not isinstance(upload_id, str) or not upload_id:
        return None
    text = error if isinstance(error, str) else f"{type(error).__name__}: {error}"
    return settle_upload(store, lease.scope, upload_id, f"校验任务失败：{text}")


def _fail_upload(ctx: JobContext, files_id: Any, reason: str) -> None:
    """先把上传标记为失败（之后不会再被当成可校验的上传），再删掉它的数据块。"""
    fail_upload(ctx.store, files_id, reason)
