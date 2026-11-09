"""`voxelize` `{scanAssetHash?, style?}`：把扫描体素化成重建层的区块和方块表（设计 4.2、4.3）。

`style` 有两种写法：
- **风格名**（字符串，接口服务的 `POST .../voxelize {style}` 和命令行 `--style` 都传这个）：
  `default`（64 种颜色）、`coarse`（16 种）、`fine`（256 种）；不认识的风格名不可重试，直接失败；
- **对象** `{paletteSize?}`：直接给颜色数（1–1024，默认 64）。

1. 扫描默认是当前扫描；用它最近一次提交的变换放到空间坐标里；
2. 子进程里体素化（只保留实体区）、颜色量化（颜色数由 `style` 决定）、按只追加规则分配方块
   编号（从 2 开始）、编码区块；
3. 事务外写区块和新方块表（按内容哈希幂等）；
4. 一次提交：重建层的区块清单换成这次的结果（旧清单里有、新结果里没有的区块写 null），方块表变了才带
   `paletteHash`。事务里重新读 head 的方块表，和计算时用的不一致（期间有人追加了方块）就放弃、稍后重试；
5. 和当前状态完全相同就不提交，任务直接完成（`result.unchanged = true`）。

`result = {scanAssetHash, style?, cells, chunks, colors, paletteSize, paletteHash?, newBlocks,
changedChunks, …}`。
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
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
from .context import JobContext, require_hash
from .scan import _space, physical_boxes

log = logging.getLogger(__name__)

LAYER = "rebuilt"
DEFAULT_PALETTE_SIZE = 64
MAX_PALETTE_SIZE = 1024

# 风格名 → 体素化参数
STYLES: dict[str, dict[str, Any]] = {
    "default": {"paletteSize": DEFAULT_PALETTE_SIZE},
    "coarse": {"paletteSize": 16},
    "fine": {"paletteSize": 256},
}


def palette_size_of(style: Any) -> int:
    """任务参数 `style` → 颜色数。不合法时抛 PermanentJobError（不可重试）。"""
    if style is None:
        return DEFAULT_PALETTE_SIZE
    if isinstance(style, str):
        preset = STYLES.get(style)
        if preset is None:
            known = "、".join(STYLES)
            raise PermanentJobError(f"不认识的体素化风格：{style[:64]}（可用：{known}）")
        return int(preset["paletteSize"])
    if not isinstance(style, Mapping):
        raise PermanentJobError("参数 style 必须是风格名（字符串）或对象 {paletteSize}")
    unknown = set(style) - {"paletteSize"}
    if unknown:
        raise PermanentJobError(f"参数 style 有不认识的字段：{sorted(unknown)}")
    size = style.get("paletteSize", DEFAULT_PALETTE_SIZE)
    if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= MAX_PALETTE_SIZE:
        raise PermanentJobError(f"style.paletteSize 必须是 1–{MAX_PALETTE_SIZE} 的整数")
    return size


class PaletteChanged(RuntimeError):
    """计算期间方块表被别的提交改了：放弃这次结果，任务退回队列重做（可重试）。"""


def run(ctx: JobContext) -> dict[str, Any]:
    params = ctx.params
    store, scope, config = ctx.store, ctx.lease.scope, ctx.config
    target = require_hash(params, "scanAssetHash", optional=True)
    palette_size = palette_size_of(params.get("style"))
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
    if isinstance(params.get("style"), str):
        result["style"] = params["style"]
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
