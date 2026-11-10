"""views：只渲染包围盒附近的扫描，出带米制刻度的多角度图（正面、背面、左、右、俯视、斜 45°）+ 任意相机。"""

from __future__ import annotations

import os
import time

import numpy as np
from PIL import Image

from . import core as wc
from .base import Base, from_args, resolve_box
from .i18n import t
from .render import run_render

# 名字 → (中文名, 英文名, 相对正面的方位角, 仰角, 正交)
VIEWS = {
    "front": ("正面", "front", 0.0, 0.0, True),
    "back": ("背面", "back", 180.0, 0.0, True),
    "left": ("左面", "left", -90.0, 0.0, True),
    "right": ("右面", "right", 90.0, 0.0, True),
    "top": ("俯视", "top", 0.0, 90.0, True),
    "oblique": ("斜 45°", "oblique 45°", 45.0, 30.0, False),
    "oblique-back": ("斜后 45°", "back oblique 45°", 225.0, 30.0, False),
}
DEFAULT_VIEWS = ["front", "back", "left", "right", "top", "oblique"]


def view_title(name: str) -> str:
    zh, en, *_ = VIEWS[name]
    return t(zh, en)


def parse_cam(text: str) -> tuple[str, str, float, float, bool]:
    """`名字:az,el[,ortho|persp]`（az 是空间方位角，不随 --front 转）。"""
    name, rest = text.split(":", 1) if ":" in text else ("cam", text)
    parts = [p.strip() for p in rest.split(",")]
    if len(parts) < 2:
        raise wc.ReconError("--cam 格式：名字:方位角,仰角[,ortho|persp]")
    ortho = len(parts) > 2 and parts[2].lower().startswith("o")
    return name, t(f"自定义 {name}", f"custom {name}"), float(parts[0]), float(parts[1]), ortho


def describe_camera(az: float, el: float) -> tuple[str, str, str]:
    d, right, up = wc.cam_vectors(az, el)
    if abs(d[1]) > 0.999:
        where = t("相机在正上方，看向 -Y", "camera above, looking -Y")
    elif abs(el) < 1e-6 and len(wc.axis_name(d)) == 2:
        where = t(
            f"相机在 {wc.axis_name(d)} 侧，看向 {wc.axis_name(-d)}", f"camera on {wc.axis_name(d)} side"
        )
    else:
        where = t(f"相机方位角 {az:g}°、仰角 {el:g}°", f"camera az {az:g}°, el {el:g}°")
    return where, wc.axis_name(right), wc.axis_name(up)


def view_spec(
    *,
    name: str,
    title: str,
    az: float,
    el: float,
    ortho: bool,
    box: wc.Box,
    clip: wc.Box,
    floor_y: float,
    cut: float | None,
    near_clip: bool,
    size,
    show: list[str],
    clip_models: list[str],
    overlay: dict,
    out: str,
    grid: dict | None = None,
    floor_range=None,
    header_extra: str = "",
    frame: wc.Box | None = None,
) -> dict:
    d, _, _ = wc.cam_vectors(az, el)
    where, rname, uname = describe_camera(az, el)
    if len(rname) != 2 or len(uname) != 2:
        # 画面轴不沿坐标轴时，整幅淡网格会和地面网格交错，只留刻度尺（读数是相对画面中心的距离 Δ）
        overlay = {**overlay, "grid2d": False}
    frame = frame or clip
    spec: dict = {
        "out": out,
        "size": list(size),
        "az": az,
        "el": el,
        "ortho": ortho,
        "fov": 32,
        "frame": frame.as_dict(),
        "clip": clip.as_dict(),
        "show": show,
        "clipModels": clip_models,
        "box": box.as_dict(),
        "floorGrid": grid
        or {
            "x0": float(clip.lo[0]),
            "x1": float(clip.hi[0]),
            "z0": float(clip.lo[2]),
            "z1": float(clip.hi[2]),
            "y": float(floor_y) + 0.012,
        },
        "overlay": overlay,
    }
    if ortho and abs(el) < 10:
        spec.pop("floorGrid")  # 平视的正交图里地面网格只是一条线，改由整幅淡网格和刻度尺读数
    if cut is not None:
        spec["cut"] = float(cut)
    if near_clip:
        c = box.center
        corners = np.array(
            [
                [
                    box.lo[0] if i & 1 == 0 else box.hi[0],
                    box.lo[1] if i & 2 == 0 else box.hi[1],
                    box.lo[2] if i & 4 == 0 else box.hi[2],
                ]
                for i in range(8)
            ]
        )
        reach = float(((corners - c) @ d).max())
        spec["nearClip"] = {"point": wc.r(c + d * (reach + 0.02))}
    lo, hi = box.lo, box.hi
    proj = t("正交", "ortho") if ortho else t("透视", "persp.")
    spec["header"] = [
        t(
            f"{title}（{name}） · {proj} · {where} · 画面右 = {rname}，上 = {uname}",
            f"{title} ({name}) · {proj} · {where} · right = {rname}, up = {uname}",
        ),
        t(
            f"包围盒 x {lo[0]:.2f}–{hi[0]:.2f}  y {lo[1]:.2f}–{hi[1]:.2f}  z {lo[2]:.2f}–{hi[2]:.2f} 米 · "
            f"地面 y={floor_y:.3f}",
            f"box x {lo[0]:.2f}–{hi[0]:.2f}  y {lo[1]:.2f}–{hi[1]:.2f}  z {lo[2]:.2f}–{hi[2]:.2f} m · floor "
            f"y={floor_y:.3f}",
        )
        + (
            t(
                f"（附近 {floor_range[0]:.2f}–{floor_range[1]:.2f}）",
                f" ({floor_range[0]:.2f}–{floor_range[1]:.2f})",
            )
            if floor_range
            else ""
        )
        + t(
            " · 黄框=包围盒 · 地面网格 10 厘米（白亮线 50 厘米，蓝线整米）",
            " · yellow = box · floor grid 10 cm",
        )
        + (t(f" · 剖切 y≤{cut:.2f}", f" · cut y≤{cut:.2f}") if cut is not None else "")
        + header_extra,
    ]
    return spec


def prepare_scan(args, box: wc.Box, margin: float, workdir: str, base: Base | None = None):
    """读扫描 → 估地面 → 裁出 (包围盒 + 边距) 写成小 glb。
    返回 (裁剪范围, 地面高度, glb 路径, 附近的扫描, 贴地网格, 地面高度范围, 高度图)。"""
    start = time.time()
    base = base or from_args(args)
    scan = wc.load_scan(base.scan)
    near = wc.crop_scan(scan, box.grow(max(margin, 0.45) + 0.1))
    floor_given = getattr(args, "floor", None)
    floor_y = floor_given if floor_given is not None else wc.estimate_floor(near, box)
    clip = box.grow(margin)
    hm = (
        wc.flat_heightmap(clip, floor_y)
        if floor_given is not None
        else wc.floor_heightmap(near, clip, floor_y)
    )
    floor_range = (float(np.percentile(hm[3], 5)), float(np.percentile(hm[3], 95)))
    clip.lo[1] = min(floor_range[0] - getattr(args, "floor_keep", 0.03), box.lo[1] - 0.01)
    if max(clip.size[0], clip.size[2]) < 6:
        grid = wc.draped_grid(hm, clip)
    else:  # 整房：50 厘米一格，整米亮线，5 米蓝线
        grid = wc.draped_grid(hm, clip, step=0.25, unit=0.5, major=2, big=10)
    part = wc.crop_scan(near, clip.grow(0.05))
    path = os.path.join(workdir, "_scan_crop.glb")
    wc.write_scan_glb(part, path)
    wc.log(
        f"  扫描 {len(scan.F)} 个三角形 → 范围内 {len(part.F)} 个；地面 y={floor_y:.3f}"
        f"（附近 5%–95%：{floor_range[0]:.3f}–{floor_range[1]:.3f}）；{time.time() - start:.1f} 秒"
    )
    return clip, floor_y, path, near, grid, floor_range, hm


def cmd_views(args) -> dict:
    start = time.time()
    base = from_args(args)
    box, eid = resolve_box(args, base)
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    wc.log(f"views：{eid or ''} 包围盒 {wc.r(box.lo, 3)} – {wc.r(box.hi, 3)}，外扩 {args.margin} 米")
    clip, floor_y, glb, _, grid, floor_range, _ = prepare_scan(args, box, args.margin, out_dir, base)
    size = [int(v) for v in args.size.lower().split("x")]
    names = [n.strip() for n in args.only.split(",")] if args.only else list(DEFAULT_VIEWS)
    jobs = []
    overlay = {"header": True, "rulers": True, "grid2d": not args.no_grid, "dims": True, "gizmo": True}
    for n in names:
        if n not in VIEWS:
            raise wc.ReconError(f"不认识的视图 {n}（可选：{', '.join(VIEWS)}）")
        _, _, daz, el, ortho = VIEWS[n]
        az = (args.front + daz) if n != "top" else args.front
        jobs.append((n, view_title(n), az, el, ortho))
    for c in args.cam or []:
        jobs.append(parse_cam(c))
    specs = []
    for n, title, az, el, ortho in jobs:
        png = os.path.join(out_dir, f"{args.prefix}{n}.png")
        specs.append(
            view_spec(
                name=n,
                title=title,
                az=az,
                el=el,
                ortho=ortho,
                box=box,
                clip=clip,
                floor_y=floor_y,
                cut=args.cut,
                near_clip=not args.no_near_clip,
                size=size,
                show=["scan"],
                clip_models=["scan"],
                overlay=overlay,
                out=png,
                grid=grid,
                floor_range=floor_range,
            )
        )
    try:
        infos = run_render({"scan": glb}, specs, out_dir)
    finally:
        os.remove(glb)
    meta = []
    for (n, title, az, el, ortho), spec, info in zip(jobs, specs, infos, strict=True):
        jpg = spec["out"][:-4] + ".jpg"
        with Image.open(spec["out"]) as img:
            nbytes, q = wc.save_jpeg(img, jpg, args.max_bytes)
            w, h = img.size
        os.remove(spec["out"])
        where, rname, uname = describe_camera(az, el)
        meta.append(
            {
                "name": n,
                "title": title,
                "file": jpg,
                "bytes": nbytes,
                "quality": q,
                "az": az,
                "el": el,
                "projection": "ortho" if ortho else "perspective",
                "camera": where,
                "screenRight": rname,
                "screenUp": uname,
                "toCamera": wc.r(info["dir"]),
                "pixelToWorld": wc.screen_map(info),
            }
        )
        wc.log(f"  {os.path.basename(jpg)}  {w}×{h}  {nbytes // 1024} KB  {where}；右 {rname} 上 {uname}")
    summary = {
        "entityId": eid,
        "box": box.as_dict(),
        "margin": args.margin,
        "clip": clip.as_dict(),
        "floorY": wc.r(floor_y),
        "floorRange5to95": wc.r(floor_range),
        "front": args.front,
        "cut": args.cut,
        "views": meta,
    }
    wc.write_json(os.path.join(out_dir, f"{args.prefix}views.json"), summary)
    print(
        f"完成：{len(meta)} 张图 → {out_dir}（说明在 {args.prefix}views.json），共 {time.time() - start:.1f} "
        "秒"
    )
    return summary
