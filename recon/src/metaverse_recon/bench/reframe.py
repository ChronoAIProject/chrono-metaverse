"""reframe：把物件记录在两个对齐坐标系之间换算。

两种对齐都从同一份原始扫描算出（`--scan`）：

- `compute`：`processing.scan.compute_alignment`（`scripts/reconstruct_lobby.py` 和概念验证用的：
  只绕竖直轴旋转，地面取 y 的 1% 分位，原点取 x、z 的最小值）；
- `align`：`processing.align.auto_align`（`align`、`prepare` 首次自动对齐的坐标系，原处理服务的
  `scan_import` 也用它：先摆正倾斜，地面取低处朝上面的众数，原点取 x、z 的 0.05% 分位；
  旧名 `scan_import`、`worker` 照旧认）；
- 也可以给变换文件（prepare 的 `transform.json`，或 16 个数的列主序 4×4，扫描坐标 → 空间坐标）。

换算 `C = M_目标 · M_原⁻¹`。每个物件只改最外层的 `transform`：
`位置' = C · 位置`；旋转在两个坐标系倾斜差不超过 `--max-tilt` 度时只加偏航差（数字干净，误差在毫米级），
否则精确合成（`Ry·Rx·Rz` 按 YXZ 顺序重新分解）。模板是局部坐标，不变；包围盒重算。
"""

from __future__ import annotations

import math
import os
import tempfile

import numpy as np

from ..processing.align import auto_align
from ..processing.limits import default_limits
from ..processing.scan import compute_alignment, matrix_from_column_major
from . import core as wc
from . import models as md
from . import shapes_ext as sx
from .base import parse_records
from .prepare import scan_input


def frame_matrix(spec: str, mesh) -> np.ndarray:
    if spec == "compute":
        return compute_alignment(mesh.vertices, mesh.faces).matrix
    # scan_import、worker 是改名前的叫法，照旧认
    if spec in ("align", "prepare", "scan_import", "worker"):
        return auto_align(mesh).matrix
    data = wc.read_json(spec)
    values = data.get("transform") if isinstance(data, dict) else data
    return matrix_from_column_major(values)


def euler_yxz(R: np.ndarray) -> tuple[float, float, float]:
    """R = Ry(yaw)·Rx(pitch)·Rz(roll) → (yaw, pitch, roll)，度（与 three.js 的 YXZ 顺序相同）。"""
    m12 = max(-1.0, min(1.0, float(R[1, 2])))
    pitch = math.asin(-m12)
    if abs(m12) < 0.9999999:
        yaw = math.atan2(R[0, 2], R[2, 2])
        roll = math.atan2(R[1, 0], R[1, 1])
    else:
        yaw = math.atan2(-R[2, 0], R[0, 0])
        roll = 0.0
    return math.degrees(yaw), math.degrees(pitch), math.degrees(roll)


def change_info(C: np.ndarray) -> dict:
    R = C[:3, :3]
    yaw = math.degrees(math.atan2(R[0, 2], R[0, 0]))
    tilt = math.degrees(math.acos(max(-1.0, min(1.0, float(R[1, 1])))))
    return {
        "yawDeg": round(yaw, 4),
        "tiltDeg": round(tilt, 4),
        "translation": [round(float(v), 4) for v in C[:3, 3]],
    }


def _clean(v: float, digits: int = 4) -> float:
    out = round(float(v), digits)
    return 0.0 if out == 0 else out


def reframe_transform(xf: dict | None, C: np.ndarray, max_tilt: float) -> dict:
    """最外层 transform 换到新坐标系：M' = C · M。"""
    xf = dict(xf or {})
    M = md.transform_matrix(xf)
    info = change_info(C)
    pos = C[:3, :3] @ M[:3, 3] + C[:3, 3]
    out = dict(xf)
    out["position"] = [_clean(v) for v in pos]
    if info["tiltDeg"] <= max_tilt:
        # 偏航差按 0.01° 取整：两种对齐的墙方向一致时差值只是浮点噪声
        out["yaw"] = _clean((float(xf.get("yaw", 0)) + round(info["yawDeg"], 2) + 180) % 360 - 180, 3)
    else:
        scale = np.array([float(v) for v in xf.get("scale") or [1, 1, 1]])
        R_old = M[:3, :3] / scale  # M 的 3×3 = R·S：按列除掉缩放
        yaw, pitch, roll = euler_yxz(C[:3, :3] @ R_old)
        out.update(yaw=_clean(yaw, 4), pitch=_clean(pitch, 4), roll=_clean(roll, 4))
    for key in ("yaw", "pitch", "roll"):
        if key in out and out[key] == 0:
            del out[key]
    return out


def reframe_bounds(bounds: dict, C: np.ndarray) -> dict:
    lo, hi = np.array(bounds["min"], float), np.array(bounds["max"], float)
    corners = np.array(
        [[(lo, hi)[i & 1][0], (lo, hi)[(i >> 1) & 1][1], (lo, hi)[(i >> 2) & 1][2]] for i in range(8)]
    )
    P = corners @ C[:3, :3].T + C[:3, 3]
    return {"min": [_clean(v) for v in P.min(0)], "max": [_clean(v) for v in P.max(0)]}


def reframe_body(body: dict, C: np.ndarray, templates: dict, max_tilt: float) -> dict:
    out = dict(body)
    if body.get("kind") == "template":
        return out
    if body.get("shape") is not None:
        shape = dict(body["shape"])
        shape["transform"] = reframe_transform(shape.get("transform"), C, max_tilt)
        out["shape"] = shape
        try:
            out["bounds"] = sx.rounded_shape_bounds(shape, templates)
        except Exception:  # 形状本身不合法时退回按角点换算
            if "bounds" in body:
                out["bounds"] = reframe_bounds(body["bounds"], C)
    else:
        out["transform"] = reframe_transform(body.get("transform"), C, max_tilt)
        local = md.find_local(out) if body.get("model") else None
        if local:
            out["bounds"] = md.world_bounds(out, md.load_model_file(local))
        elif "bounds" in body:
            out["bounds"] = reframe_bounds(body["bounds"], C)
    return out


def reframe_data(data, C: np.ndarray, max_tilt: float):
    """按输入的格式原样写回（AI 物件集、列表、{编号: body}、单个 body、裸形状）。"""
    rs = parse_records(data)
    templates = {k: v for k, v in rs.templates.items() if v is not None}
    new = {k: reframe_body(b, C, templates, max_tilt) for k, b in rs.bodies.items()}
    if isinstance(data, list):
        return [
            new.get(b.get("entityId"), b) if isinstance(b, dict) and b.get("kind") != "template" else b
            for b in data
        ]
    if isinstance(data, dict) and "type" in data and "shape" not in data and "entityId" not in data:
        return next(iter(new.values()))["shape"]
    if isinstance(data, dict) and ("shape" in data or "entityId" in data or "model" in data):
        return next(iter(new.values()))
    out = dict(data)
    for key in ("entities", "bodies", "objects"):
        if key in data:
            v = data[key]
            if isinstance(v, dict):
                out[key] = {k: new.get(b.get("entityId", k), b) for k, b in v.items()}
            else:
                out[key] = [new.get(b.get("entityId"), b) if b.get("kind") != "template" else b for b in v]
            return out
    return {k: new.get(v.get("entityId", k), v) if isinstance(v, dict) else v for k, v in data.items()}


def cmd_reframe(args) -> dict:
    with tempfile.TemporaryDirectory() as work:
        from ..processing.tasks import read_scan

        mesh = read_scan(scan_input(args.scan, args.texture, work), work, default_limits())
    M_from = frame_matrix(args.src, mesh)
    M_to = frame_matrix(args.dst, mesh)
    C = M_to @ np.linalg.inv(M_from)
    info = change_info(C)
    print(
        f"换算 {args.src} → {args.dst}：偏航 {info['yawDeg']}°，倾斜 {info['tiltDeg']}°，平移 "
        f"{info['translation']} 米"
        + (
            "（倾斜在 --max-tilt 以内：只改偏航和位置）"
            if info["tiltDeg"] <= args.max_tilt
            else "（精确合成旋转）"
        )
    )
    outs = []
    names = [os.path.basename(p) for p in args.inp]
    for path in args.inp:
        data = wc.read_json(path)
        new = reframe_data(data, C, args.max_tilt)
        if len(args.inp) == 1 and not os.path.isdir(args.out):
            target = args.out
        else:
            # 文件名重复时（例如 models/*/model.json）按上一级目录分开放，不能互相覆盖
            name = os.path.basename(path)
            if names.count(name) > 1:
                name = os.path.join(os.path.basename(os.path.dirname(os.path.abspath(path))), name)
            target = os.path.join(args.out, name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
        wc.write_json(target, new)
        outs.append(target)
        print(f"  {path} → {target}")
    return {"change": info, "outputs": outs}
