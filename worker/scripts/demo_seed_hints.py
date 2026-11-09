"""把前厅的物体提示换算到处理服务 `scan_import` 实际对齐出来的空间坐标，写进部署种子的 `hints`。

为什么要换算：`scripts/lobby_hints.json` 是在 `scripts/reconstruct_lobby.py` 的坐标系里标的，那个脚本用
`processing.scan.compute_alignment` 摆正扫描（只绕竖直轴旋转；地面取 y 的 1% 分位；原点取 x、z 的最小值）。
处理服务首次导入扫描用的是 `processing.align.auto_align`（先摆正倾斜；地面取低处朝上面的众数；原点取
x、z 的 0.05% 分位）。前厅扫描在两个坐标系之间差约 (−0.29, −0.05, −0.26) 米平移和 0.09° 倾斜，而提示框
只向外放宽 3 厘米（`processing.fit_segment.apply_hints`），不换算就会认领错的点。

换算：p_处理服务 = M_auto · M_compute⁻¹ · p_脚本。物体中心按这个变换换算；尺寸是轴对齐框的长宽高，
两个坐标系只差零点几度的倾斜，原样保留；提示里有 `yaw` 时加上两个坐标系的偏航差。

用法（在 worker/ 下）：

    .venv/bin/python scripts/demo_seed_hints.py --scan <mesh.drc 或 zip> [--texture <tex.jpg>] \\
        [--hints scripts/lobby_hints.json] --seed ../infra/chrono-cd/demo-seed.json [--check]

- 改写种子文件的 `hints`（`{"objects": [...]}`），其余字段不动；`--check` 只核对种子里的提示是否就是
  换算结果（不一致时退出码 1），不写文件；
- 打印两种对齐的变换和差异，以及处理服务将得到的 `transform`（导入后与任务 `result.transform` 对照）。
- 改了种子以后同步 `infra/chrono-cd/app.json` 的 `METAVERSE_DEMO_SEED`（`node infra/chrono-cd/check-app.mjs`
  会检查两处一致）。

只适用于**新空间的第一次导入**（`auto_align`）。空间已经存在时坐标系已经固定，之后导入的扫描都配准到
原来的坐标系里，提示要保持原来的坐标，不要用新扫描重算。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import tempfile
from typing import Any

import numpy as np

from metaverse_worker.processing.align import auto_align
from metaverse_worker.processing.scan import compute_alignment, load_scan
from metaverse_worker.processing.tasks import read_scan

# 与处理服务默认的解析前检查一致（只用来读扫描，不影响对齐）。
_LIMITS = {
    "max_scan_bytes": 1 << 30,
    "max_triangles": 5_000_000,
    "max_texture_pixels": 8192 * 8192,
}


def frame_change(mesh) -> tuple[np.ndarray, dict[str, Any]]:
    """脚本坐标系 → 处理服务坐标系的 4×4 变换，和给人看的摘要。"""
    script = compute_alignment(mesh.vertices, mesh.faces)
    worker = auto_align(mesh)
    change = worker.matrix @ np.linalg.inv(script.matrix)
    yaw = math.degrees(math.atan2(change[0, 2], change[0, 0]))
    summary = {
        "script": {"rotationDeg": round(script.rotation_deg, 3), "floorY": round(script.floor_y, 4)},
        "worker": worker.summary(),
        "workerTransform": worker.column_major(),
        "translation": [round(float(v), 4) for v in change[:3, 3]],
        "yawDeg": round(yaw, 4),
    }
    return change, summary


def convert(hints: dict[str, Any], change: np.ndarray, yaw_deg: float) -> dict[str, Any]:
    """换算 `{"objects": [{center, size?, yaw?, label?, kind?}]}`；其他字段原样保留。"""
    objects = []
    for item in hints.get("objects") or []:
        out = dict(item)
        center = np.asarray(item["center"], np.float64)
        if center.shape != (3,):
            raise SystemExit(f"提示的 center 必须是 3 个数：{item}")
        moved = change[:3, :3] @ center + change[:3, 3]
        out["center"] = [round(float(v), 3) for v in moved]
        if isinstance(item.get("yaw"), int | float):
            out["yaw"] = round(float(item["yaw"]) + yaw_deg, 3)
        objects.append(out)
    return {**hints, "objects": objects}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scan", required=True, help="扫描网格（drc / glb / obj），或 Scaniverse 式的 zip")
    ap.add_argument("--texture", help="贴图（扫描是 drc 时可给；不影响对齐）")
    ap.add_argument("--hints", default="scripts/lobby_hints.json", help="脚本坐标系里的提示")
    ap.add_argument("--seed", required=True, help="部署种子（infra/chrono-cd/demo-seed.json）")
    ap.add_argument("--check", action="store_true", help="只核对，不写文件")
    ap.add_argument("--workdir", default=None, help="解 zip 用的临时目录（默认系统临时目录）")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory(dir=args.workdir) as workdir:
        # 与处理服务相同的读取（zip 先解出网格和贴图）；单独给贴图时直接读网格 + 贴图。
        mesh = load_scan(args.scan, args.texture) if args.texture else read_scan(args.scan, workdir, _LIMITS)
    change, summary = frame_change(mesh)
    print(json.dumps(summary, ensure_ascii=False, indent=1))

    with open(args.hints, encoding="utf-8") as fh:
        hints = json.load(fh)
    converted = convert(hints, change, summary["yawDeg"])
    with open(args.seed, encoding="utf-8") as fh:
        seed = json.load(fh)

    if args.check:
        if seed.get("hints") != converted:
            print("种子里的提示不是按处理服务坐标系换算的结果", file=sys.stderr)
            sys.exit(1)
        print("种子里的提示与换算结果一致")
        return
    seed["hints"] = converted
    with open(args.seed, "w", encoding="utf-8") as fh:
        json.dump(seed, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"已写入 {args.seed}：{len(converted['objects'])} 个物体提示")


if __name__ == "__main__":
    main()
