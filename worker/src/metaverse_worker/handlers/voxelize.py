"""`voxelize` `{scanAssetHash?, style?: {paletteSize?}}`：把扫描体素化成重建层的区块和方块表
（设计 4.2、4.3）。

1. 扫描默认是当前扫描；用它最近一次提交的变换放到空间坐标里；
2. 子进程里体素化（只保留实体区）、颜色量化（`style.paletteSize`，默认 64，1–1024）、按只追加规则分配方块
   编号（从 2 开始）、编码区块；
3. 事务外写区块和新方块表（按内容哈希幂等）；
4. 一次提交：重建层的区块清单换成这次的结果（旧清单里有、新结果里没有的区块写 null），方块表变了才带
   `paletteHash`。事务里重新读 head 的方块表，和计算时用的不一致（期间有人追加了方块）就放弃、稍后重试；
5. 和当前状态完全相同就不提交，任务直接完成（`result.unchanged = true`）。

`result = {scanAssetHash, cells, chunks, colors, paletteSize, paletteHash?, newBlocks, changedChunks, …}`。
"""

from __future__ import annotations

import logging
from typing import Any

from ..errors import PermanentJobError
from ..jobs.lease import mark_done
from ..jobs.writeback import (
    CommitPlan,
    current_chunks,
    diff_chunks,
    head_palette_doc,
    put_chunks,
    put_palette,
    scan_commit,
    write_back,
)
from .context import JobContext, optional_dict, require_hash
from .scan import _space, physical_boxes

log = logging.getLogger(__name__)

LAYER = "rebuilt"


class PaletteChanged(RuntimeError):
    """计算期间方块表被别的提交改了：放弃这次结果，任务退回队列重做（可重试）。"""


def run(ctx: JobContext) -> dict[str, Any]:
    params = ctx.params
    store, scope, config = ctx.store, ctx.lease.scope, ctx.config
    target = require_hash(params, "scanAssetHash", optional=True)
    style = optional_dict(params, "style")
    palette_size = style.get("paletteSize", 64)
    if not isinstance(palette_size, int) or isinstance(palette_size, bool) or not 1 <= palette_size <= 1024:
        raise PermanentJobError("style.paletteSize 必须是 1–1024 的整数")
    space = _space(ctx)
    commit = scan_commit(store, scope, target)
    if commit is None:
        raise PermanentJobError("空间还没有导入扫描" if target is None else f"空间里没有扫描 {target}")
    scan_ref = commit["scan"]
    palette_hash, blocks = head_palette_doc(store, scope)
    scan_path = ctx.download(scan_ref["assetHash"], "scan.bin", config.max_scan_bytes)
    out = ctx.compute(
        "metaverse_worker.processing.tasks:voxelize_task",
        scan_path=scan_path,
        workdir=ctx.workdir,
        limits=ctx.limits(),
        transform=list(scan_ref["transform"]),
        palette_size=palette_size,
        existing_blocks=blocks,
        physical_boxes=physical_boxes(space),
        max_cells=min(config.max_grid_cells, 100_000_000),
    )
    ctx.check_cancel()
    new_chunks = {(c[0], c[1], c[2]): c[3] for c in out["chunks"]}
    put_chunks(store, {c[3]: bytes(c[4]) for c in out["chunks"]})
    new_palette_hash = put_palette(store, scope, out["blocks"]) if out["paletteChanged"] else None
    result: dict[str, Any] = {
        "scanAssetHash": scan_ref["assetHash"],
        "paletteSize": palette_size,
        "newBlocks": len(out["blocks"]) - len(blocks),
        **out["stats"],
    }
    if new_palette_hash:
        result["paletteHash"] = new_palette_hash

    old = current_chunks(store, scope, LAYER)
    if not diff_chunks(LAYER, old, new_chunks) and not new_palette_hash:
        result.update(unchanged=True, changedChunks=0)
        mark_done(store, ctx.lease, result=result)
        return result

    def build(session, space_doc) -> CommitPlan:
        current_hash, _ = head_palette_doc(store, scope, session=session)
        if current_hash != palette_hash:
            raise PaletteChanged("计算期间方块表变了，稍后重做")
        changed = diff_chunks(LAYER, current_chunks(store, scope, LAYER, session=session), new_chunks)
        return CommitPlan(
            message=f"体素化扫描 {scan_ref['assetHash'][:12]}（{len(new_chunks)} 个区块）",
            changed_chunks=changed,
            palette_hash=new_palette_hash,
            result={**result, "changedChunks": len(changed)},
        )

    commit_result = write_back(store, ctx.lease, build)
    return {"commitId": commit_result.commit_id, "seq": commit_result.seq, **result}
