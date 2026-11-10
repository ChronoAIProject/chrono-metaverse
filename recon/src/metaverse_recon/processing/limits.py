"""读扫描、读模型时的解析前检查上限（本地工具的默认值）。

原来是处理服务的配置（`config.Config` 的 `max_*` 字段，环境变量 `WORKER_MAX_*`）；处理服务下线后搬到这里，
默认值不变，所以同一份扫描在本地算出的结果与原来处理服务导入的完全相同。

`default_limits()` 的键就是 `processing.tasks` 各入口的 `limits` 参数（`scan_task`、`voxelize_task`、
`model_task`、`sniff_task` 读其中用得到的几项）。
"""

from __future__ import annotations

# 扫描文件的大小上限；zip 压缩包解压后的合计上限是它的 2 倍
MAX_SCAN_BYTES = 1 << 30
# 读网格前检查：三角形数、贴图像素
MAX_TRIANGLES = 5_000_000
MAX_TEXTURE_PIXELS = 8192 * 8192
# 贴图单边像素上限
MAX_TEXTURE_SIDE = 8192
# 扫描包围盒（与实体区的交集）按 GRID_UNIT³ 计的格数上限
MAX_GRID_CELLS = 400_000_000
# 操作文件（NDJSON，可 gzip）解压后的大小上限
MAX_OPS_BYTES = 256 << 20
# 外部模型（含附属文件）的大小上限
MAX_MODEL_BYTES = 50 << 20
# 物件模型重新导出时的三角形数和贴图长边上限
MODEL_MAX_TRIANGLES = 100_000
MODEL_MAX_TEXTURE_SIDE = 2048
# 物件模型全部贴图的像素合计上限（与接口服务 `UPLOAD_MODEL_MAX_TEXTURE_PIXELS` 的默认值相同）
MODEL_MAX_TEXTURE_PIXELS = 4 * 2048 * 2048


def default_limits() -> dict[str, int]:
    """`processing.tasks` 用的上限表（每次返回新的字典，调用方可以改）。"""
    return {
        "max_scan_bytes": MAX_SCAN_BYTES,
        "max_zip_bytes": MAX_SCAN_BYTES * 2,
        "max_triangles": MAX_TRIANGLES,
        "max_texture_pixels": MAX_TEXTURE_PIXELS,
        "max_texture_side": MAX_TEXTURE_SIDE,
        "max_grid_cells": MAX_GRID_CELLS,
        "max_ops_bytes": MAX_OPS_BYTES,
        "max_model_bytes": MAX_MODEL_BYTES,
        "model_max_triangles": MODEL_MAX_TRIANGLES,
        "model_max_texture_side": MODEL_MAX_TEXTURE_SIDE,
        "model_max_texture_pixels": MODEL_MAX_TEXTURE_PIXELS,
    }


__all__ = [
    "MAX_GRID_CELLS",
    "MAX_MODEL_BYTES",
    "MAX_OPS_BYTES",
    "MAX_SCAN_BYTES",
    "MAX_TEXTURE_PIXELS",
    "MAX_TEXTURE_SIDE",
    "MAX_TRIANGLES",
    "MODEL_MAX_TEXTURE_PIXELS",
    "MODEL_MAX_TEXTURE_SIDE",
    "MODEL_MAX_TRIANGLES",
    "default_limits",
]
