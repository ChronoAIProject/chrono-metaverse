"""search：在模型库里找"看起来差不多"的现成模型，输出候选清单和带编号的缩略图拼图（给大模型看图挑选）。

许可过滤是硬性的：Poly Haven 全部 CC0；Objaverse 逐个对象读元数据里的许可；Sketchfab（要令牌）按接口返回的
许可；只保留 CC0 和 CC-BY（`licenses.py`）。

输出目录：
- `candidates.json`：
`{query, category, libraries, objaverse: 索引状态, candidates: [{n, library, id, title, author,
  license, page, faceCount, download, thumbnail, tags, category, dimensionsM?, score}]}`，n 是拼图上的编号；
- `sheet.jpg`：带编号的缩略图拼图（每格写着库、许可、面数、标题）。
"""

from __future__ import annotations

import math
import os
import time
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageDraw

from .. import core as wc
from ..i18n import t
from . import http, objaverse, polyhaven, sketchfab

LIBRARIES = ("polyhaven", "objaverse", "sketchfab")
DEFAULT_LIBRARIES = ("polyhaven", "objaverse")


def aspect_bonus(dims: list[float] | None, size: list[float] | None) -> float:
    """尺寸比例相近的加分（可以等比缩放，所以只比比例）：水平两边按长短排序，加上高度。"""
    if not dims or not size:
        return 0.0
    a = [*sorted([dims[0], dims[2]]), dims[1]]
    b = [*sorted([size[0], size[2]]), size[1]]
    if min(a) <= 0 or min(b) <= 0:
        return 0.0
    logs = [math.log(x / y) for x, y in zip(a, b, strict=True)]
    mean = sum(logs) / 3
    err = sum(abs(v - mean) for v in logs) / 3
    return 1.5 * math.exp(-err / 0.15)


def interleave(groups: list[list[dict]], limit: int) -> list[dict]:
    out: list[dict] = []
    i = 0
    while len(out) < limit and any(i < len(g) for g in groups):
        for g in groups:
            if i < len(g) and len(out) < limit:
                out.append(g[i])
        i += 1
    return out


def _thumb(url: str) -> Image.Image | None:
    if not url:
        return None
    try:
        path = http.cached(url, "thumbs", max_bytes=8 << 20)
        with Image.open(path) as im:
            im = im.convert("RGBA")
            bg = Image.new("RGBA", im.size, (236, 238, 242, 255))
            return Image.alpha_composite(bg, im).convert("RGB")
    except (http.DownloadError, OSError):
        return None


def contact_sheet(cands: list[dict], path: str, title: str, cols: int = 4, cell: int = 256) -> int:
    with ThreadPoolExecutor(max_workers=6) as pool:
        thumbs = list(pool.map(lambda c: _thumb(c.get("thumbnail") or ""), cands))
    rows = max(1, math.ceil(len(cands) / cols))
    text_h = 64
    W, H = cols * (cell + 8) + 8, 40 + rows * (cell + text_h + 8)
    img = Image.new("RGB", (W, H), (24, 26, 30))
    d = ImageDraw.Draw(img)
    d.text((10, 10), title, font=wc.font(16), fill=(255, 255, 255))
    for i, (c, th) in enumerate(zip(cands, thumbs, strict=True)):
        x = 8 + (i % cols) * (cell + 8)
        y = 40 + (i // cols) * (cell + text_h + 8)
        if th is not None:
            th.thumbnail((cell, cell), Image.LANCZOS)
            box = Image.new("RGB", (cell, cell), (236, 238, 242))
            box.paste(th, ((cell - th.size[0]) // 2, (cell - th.size[1]) // 2))
            img.paste(box, (x, y))
        else:
            d.rectangle([x, y, x + cell, y + cell], fill=(60, 62, 68))
            d.text(
                (x + cell / 2, y + cell / 2),
                t("没有缩略图", "no thumbnail"),
                font=wc.font(14),
                fill=(200, 200, 200),
                anchor="mm",
            )
        d.rectangle([x, y, x + 44, y + 34], fill=(255, 212, 0))
        d.text((x + 22, y + 17), str(c["n"]), font=wc.font(24), fill=(0, 0, 0), anchor="mm")
        faces = c.get("faceCount")
        dims = c.get("dimensionsM")
        line1 = f"{c['library']} · {c['license']}" + (f" · {faces:,} {t('面', 'faces')}" if faces else "")
        if dims:
            line1 += f" · {dims[0]:.2f}×{dims[1]:.2f}×{dims[2]:.2f}m"
        f13 = wc.font(13)
        title_text = c.get("title") or c["id"]
        while f13.getlength(title_text) > cell and len(title_text) > 4:
            title_text = title_text[:-2]
        while wc.font(12).getlength(line1) > cell and len(line1) > 4:
            line1 = line1[:-2]
        d.text((x, y + cell + 6), line1, font=wc.font(12), fill=(170, 200, 255))
        d.text((x, y + cell + 24), title_text, font=f13, fill=(240, 240, 240))
        author = c.get("author") or ""
        while wc.font(12).getlength(author) > cell and len(author) > 4:
            author = author[:-2]
        d.text((x, y + cell + 43), author, font=wc.font(12), fill=(170, 175, 185))
    nbytes, _ = wc.save_jpeg(img, path, 900_000)
    return nbytes


def run_search(
    query: str,
    libraries: list[str],
    category: str | None,
    max_faces: int,
    limit: int,
    size: list[float] | None = None,
    max_new_shards: int = 48,
    offline: bool = False,
) -> dict:
    groups = []
    status: dict = {}
    for lib in libraries:
        if lib == "polyhaven":
            cs = polyhaven.search(query, category, max_faces, limit, offline)
            for c in cs:
                c["score"] = round(c["score"] + aspect_bonus(c.get("dimensionsM"), size), 3)
            cs.sort(key=lambda c: -c["score"])
        elif lib == "objaverse":
            cs, status["objaverse"] = objaverse.search(
                query, category, max_faces, limit, max_new_shards, offline
            )
        else:
            if not sketchfab.enabled():
                wc.log("  Sketchfab：没有设置 SKETCHFAB_TOKEN，跳过")
                status["sketchfab"] = "没有设置 SKETCHFAB_TOKEN，未启用"
                continue
            cs = sketchfab.search(query, category, max_faces, limit)
        wc.log(f"  {lib}：{len(cs)} 个许可允许的候选")
        groups.append(cs)
    cands = interleave(groups, limit)
    for i, c in enumerate(cands):
        c["n"] = i + 1
    return {
        "query": query,
        "category": category,
        "libraries": libraries,
        "maxFaces": max_faces,
        "size": size,
        **status,
        "candidates": cands,
    }


def cmd_search(args) -> dict:
    start = time.time()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    libs = args.library or list(DEFAULT_LIBRARIES)
    size = [float(v) for v in args.size.split(",")] if args.size else None
    wc.log(
        f"search：{args.query!r}"
        + (f"（类别 {args.category}）" if args.category else "")
        + f"，库 {', '.join(libs)}"
    )
    res = run_search(
        args.query, libs, args.category, args.max_faces, args.limit, size, args.max_new_shards, args.offline
    )
    res["createdAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    res["note"] = (
        "只列许可允许商用的模型（CC0、CC-BY）。CC-BY 必须署名：place 会把作者、来源页、许可写进物件的 "
        "props.source。n = sheet.jpg 上的编号；fetch --pick n 下载，place --candidate candidates.json#n 摆放"
    )
    wc.write_json(os.path.join(out_dir, "candidates.json"), res)
    sheet = os.path.join(out_dir, "sheet.jpg")
    nbytes = 0
    if res["candidates"]:
        nbytes = contact_sheet(
            res["candidates"],
            sheet,
            t(
                f"检索：{args.query}（{len(res['candidates'])} 个候选）",
                f"search: {args.query} ({len(res['candidates'])})",
            ),
        )
    print(f"\n== 候选（{len(res['candidates'])} 个；只含 CC0 / CC-BY）")
    for c in res["candidates"]:
        dims = f" 尺寸 {c['dimensionsM']}" if c.get("dimensionsM") else ""
        print(
            f"  #{c['n']:<2} {c['library']:<9} {c['license']:<10} 面 {c.get('faceCount') or '?':>7}  "
            f"{c['title'][:48]}"
            f"  — {c['author'][:24]}{dims}"
        )
    if "objaverse" in res:
        st = res["objaverse"]
        print(
            f"\nObjaverse 索引：{st.get('shardsIndexed')}/{st.get('shardsTotal')} 个分片（这次新下载 "
            f"{st.get('newShards', 0)}）"
            + (f"；LVIS 类别 {', '.join(st['lvis'][:8])}" if st.get("lvis") else "")
        )
    if res["candidates"]:
        print(f"拼图：{sheet}（{nbytes // 1024} KB）")
    print(f"清单：{os.path.join(out_dir, 'candidates.json')}；共 {time.time() - start:.1f} 秒")
    return res


def load_candidate(spec: str) -> dict:
    """`candidates.json#3` → 第 3 号候选。"""
    path, _, num = spec.rpartition("#")
    if not path or not num.isdigit():
        raise wc.ReconError(f"候选写成 candidates.json#编号：{spec}")
    data = wc.read_json(path)
    for c in data.get("candidates") or []:
        if c.get("n") == int(num):
            return c
    raise wc.ReconError(f"{path} 里没有 {num} 号候选")
