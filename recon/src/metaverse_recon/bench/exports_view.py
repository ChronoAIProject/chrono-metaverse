"""`models --render`：每个导出的 glb 出一张对照图——上一行是导出后的样子（网站看到的），下一行是原文件，
同样的转台角度、网站同样的灯光，都按固有色（albedo）完整受光。看导出有没有把贴图、外形弄坏。"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

import numpy as np
from PIL import Image, ImageDraw

from . import core as wc
from .i18n import t
from .render import available, run_render

ANGLES = ((30, 15), (120, 15), (210, 15), (300, 35))


def _norm(lo, hi, extra: np.ndarray | None = None) -> list[float]:
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    k = 1.0 / max(float(np.max(hi - lo)), 1e-9)
    m = np.eye(4)
    m[:3, :3] *= k
    m[:3, 3] = -(lo + hi) / 2 * k
    if extra is not None:
        m = m @ extra
    return m.T.reshape(-1).tolist()


def turntable(rows: list[tuple[str, dict]], out: str, title: str, cell=(320, 260)) -> str:
    """rows：(标签, 渲染页的模型选项，含 path、matrix)，每行一个模型转台 4 个角度。"""
    wd = os.path.dirname(os.path.abspath(out))
    models: dict[str, Any] = {}
    views = []
    for r, (_, opt) in enumerate(rows):
        models[f"m{r}"] = {"lit": True, "shading": "albedo", **opt}
        for i, (az, el) in enumerate(ANGLES):
            views.append(
                {
                    "out": os.path.join(wd, f"_tt_{r}_{i}.png"),
                    "size": list(cell),
                    "az": az,
                    "el": el,
                    "ortho": False,
                    "fov": 30,
                    "frame": {"min": [-0.5, -0.5, -0.5], "max": [0.5, 0.5, 0.5]},
                    "show": [f"m{r}"],
                    "overlay": {"tag": None},
                    "background": 0xD8DADF,
                }
            )
    run_render(models, views, wd)
    sheet = Image.new("RGB", (cell[0] * len(ANGLES), (cell[1] + 22) * len(rows) + 28), (24, 26, 30))
    d = ImageDraw.Draw(sheet)
    d.text((8, 5), title, font=wc.font(15), fill=(255, 255, 255))
    for r, (label, _) in enumerate(rows):
        y = 28 + r * (cell[1] + 22)
        d.text((8, y + 2), label, font=wc.font(13), fill=(255, 220, 120))
        for i in range(len(ANGLES)):
            p = os.path.join(wd, f"_tt_{r}_{i}.png")
            with Image.open(p) as img:
                sheet.paste(img.convert("RGB"), (i * cell[0], y + 20))
            os.remove(p)
    wc.save_jpeg(sheet, out, 400_000)
    return out


def render_exports(
    parsed: Mapping[str, Any],
    sources: Mapping[str, Mapping[str, str]],
    files: Mapping[str, Mapping[str, Any]],
    placed: Mapping[str, Mapping[str, Any]],
    out_dir: str,
) -> list[str]:
    """每个导出的文件一张对照图（第一个用到它的物件的摆法、调色）。没有渲染工具时返回空列表。"""
    if not available():
        wc.log("  没有渲染工具（metaverse-recon doctor），不出对照图")
        return []
    from ..processing.authored_build import split_transform
    from ..processing.modelexport import read_model

    images = []
    done: set[str] = set()
    for eid, p in sorted(placed.items()):
        sha = p["hash"]
        if sha in done:
            continue
        done.add(sha)
        item = parsed["models"][eid]
        src = sources[item["source"]]
        if src["format"] != "glb":
            continue
        lin, _, _ = split_transform(item.get("transform") or {})
        orig = read_model(src["path"], max_triangles=5_000_000, max_pixels=1 << 28)
        lo, hi = orig.bounds()
        corners = (
            np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
            @ lin.T
        )
        extra = np.eye(4)
        extra[:3, :3] = lin
        info = files[sha]
        b = info["bounds"]
        rows = [
            (
                t(
                    f"导出后 {info['triangles']:,} 三角 {info['bytes'] / 1e6:.2f} MB "
                    f"材质 {info['materials']}",
                    f"exported {info['triangles']:,} tris {info['bytes'] / 1e6:.2f} MB",
                ),
                {"path": files[sha]["path"], "matrix": _norm(b["min"], b["max"])},
            ),
            (
                t(f"原文件 {info['sourceTriangles']:,} 三角", f"source {info['sourceTriangles']:,} tris"),
                {
                    "path": src["path"],
                    "matrix": _norm(corners.min(0), corners.max(0), extra),
                    **({"tint": item["tint"]} if item.get("tint") else {}),
                },
            ),
        ]
        images.append(turntable(rows, os.path.join(out_dir, f"{sha[:12]}.jpg"), f"{eid} · {sha[:12]}"))
    return images


__all__ = ["render_exports", "turntable"]
