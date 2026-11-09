"""`model_import` `{assetHash}`：校验物件模型并重新导出受限的 glb（设计 4.4、6.1）。

子进程里读模型（glb、obj、drc，或含它们的 zip）→ 解析前检查 → 减面、缩小贴图 → 写 glb；父进程登记处理后的
资源（`metadata.kind = model`，`metadata.sourceHash` = 原始资源），任务完成：

`result = {modelHash, sourceHash, bytes, triangles, vertices, sourceTriangles, textureSide, bounds}`。

不写提交：放物件时由调用方引用 `modelHash`。
"""

from __future__ import annotations

from typing import Any

from ..assets import put_asset
from ..errors import SpaceGone
from ..jobs.lease import mark_done
from .context import JobContext, require_hash


def run(ctx: JobContext) -> dict[str, Any]:
    asset_hash = require_hash(ctx.params, "assetHash")
    if ctx.store.spaces.find_one(ctx.lease.scope.space_filter(), {"_id": 1}) is None:
        # 空间不在了、或任务创建之后被删除重建：结果不能成为新空间里"本空间完成的物件模型"
        raise SpaceGone(ctx.lease.space_id)
    path = ctx.download(asset_hash, "model.bin", ctx.config.max_model_bytes)
    out = ctx.compute(
        "metaverse_worker.processing.tasks:model_task", path=path, workdir=ctx.workdir, limits=ctx.limits()
    )
    ctx.check_cancel()
    info = put_asset(
        ctx.store,
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
    mark_done(ctx.store, ctx.lease, result=result)
    return result
