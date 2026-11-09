"""`model_import` `{assetHash}`：校验物件模型并重新导出受限的 glb（设计 4.4、6.1）。

子进程里读模型（glb、obj、drc，或含它们的 zip）→ 解析前检查 → 减面、缩小贴图 → 写 glb；父进程登记处理后的
资源（`metadata.kind = model`，`metadata.sourceHash` = 原始资源），任务完成：

`result = {modelHash, sourceHash, bytes, triangles, vertices, sourceTriangles, textureSide, bounds}`。

不写提交：放物件时由调用方引用 `modelHash`。

**存储用量**：处理后的模型是一份新的、可以被提交永久引用的资源，而原始上传过了宽限期没人引用就会被清理、
用量减回。所以处理后的模型单独计入发起任务的空间：同一个事务里任务标记完成、写 `storageBytes`（计入的字节
数，复用已有资源也算，与上传相同）、空间的 `storageUsedBytes` 加上它；这份模型被定期清理删掉以后，由
`uploads.release_model_storage` 成对减回。
"""

from __future__ import annotations

from typing import Any

from bson.int64 import Int64
from pymongo.client_session import ClientSession

from ..assets import put_asset
from ..errors import SpaceGone
from ..jobs.lease import mark_done
from .context import JobContext, require_hash


def run(ctx: JobContext) -> dict[str, Any]:
    asset_hash = require_hash(ctx.params, "assetHash")
    store, scope = ctx.store, ctx.lease.scope
    if store.spaces.find_one(scope.space_filter(), {"_id": 1}) is None:
        # 空间不在了、或任务创建之后被删除重建：结果不能成为新空间里"本空间完成的物件模型"
        raise SpaceGone(ctx.lease.space_id)
    path = ctx.download(asset_hash, "model.bin", ctx.config.max_model_bytes)
    out = ctx.compute(
        "metaverse_worker.processing.tasks:model_task", path=path, workdir=ctx.workdir, limits=ctx.limits()
    )
    ctx.check_cancel()
    info = put_asset(
        store,
        out["path"],
        content_type="model/gltf-binary",
        kind="model",
        space_id=ctx.lease.space_id,
        extra={"sourceHash": asset_hash},
    )
    result = {
        "modelHash": info.hash,
        "sourceHash": asset_hash,
        **{k: v for k, v in out.items() if k != "path"},
    }

    def txn(session: ClientSession) -> None:
        # 任务完成和计入用量在同一个事务里：租约丢了就一起放弃，不会多计或漏计
        if store.spaces.find_one(scope.space_filter(), {"_id": 1}, session=session) is None:
            raise SpaceGone(ctx.lease.space_id)
        mark_done(
            store, ctx.lease, result=result, extra={"storageBytes": Int64(info.length)}, session=session
        )
        store.add_storage_used(scope.space_filter(), info.length, session=session)

    store.run_transaction(txn)
    return result
