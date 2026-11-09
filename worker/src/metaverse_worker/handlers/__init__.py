"""各任务种类的处理函数（设计 6.4）。父进程里运行：读写数据库，重计算交给子进程。

| 种类 | 参数 | 结果 |
|---|---|---|
| `upload_verify` | `{uploadId}` | 上传标记 done + `assetHash`；`result = {assetHash, reused, format, …}` |
| `scan_import` | `{assetHash, observedAt?, transform?, rebuild?, voxelize?, hints?}` | 一次提交 |
| `rebuild` | `{scanAssetHash?, hints?}` | 一次提交（没变化时不提交） |
| `voxelize` | `{scanAssetHash?, style?: {paletteSize?}}` | 一次提交（没变化时不提交） |
| `model_import` | `{assetHash}` | `result = {modelHash, …}` |

`ops_from_upload` 由接口服务自己处理，处理服务不领取。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from . import model_import, scan, upload_verify, voxelize
from .context import JobContext

Handler = Callable[[JobContext], dict[str, Any]]

HANDLERS: dict[str, Handler] = {
    "upload_verify": upload_verify.run,
    "scan_import": scan.run_import,
    "rebuild": scan.run_rebuild,
    "voxelize": voxelize.run,
    "model_import": model_import.run,
}

# 产生提交的种类：领取后先查是否已经有带这个任务编号的提交（设计 6.4）
COMMITTING_KINDS = frozenset({"scan_import", "rebuild", "voxelize"})

__all__ = ["COMMITTING_KINDS", "HANDLERS", "Handler", "JobContext"]
