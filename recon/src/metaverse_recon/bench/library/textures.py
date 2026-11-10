"""材质库：`texsearch`、`texfetch`（Poly Haven 和 ambientCG，只收 CC0）。

- **Poly Haven**：贴图清单 `GET https://api.polyhaven.com/assets?t=textures`（缓存 7 天：名称、标签、类别、
  实际尺寸
  `dimensions` 毫米），文件 `GET /files/<编号>`：`Diffuse`、`nor_gl`（OpenGL 约定的法线）、`Rough` 按分辨率给
  jpg 地址，都在 dl.polyhaven.org；全部 CC0；
- **ambientCG**：`GET https://ambientcg.com/api/v2/full_json?type=Material&q=...`（名称、标签、实际尺寸
  `dimensionX`/`dimensionY` 厘米、各分辨率的 zip 下载）；zip 里有 `_Color`、`_NormalGL`（只有 `_NormalDX` 时把
  绿色通道翻转成 OpenGL 约定）、`_Roughness`；全部 CC0。

`texsearch` 按描述打分（BM25），输出 `candidates.json` 和带编号的缩略图拼图；`texfetch` 下载颜色、法线、粗糙度
三张图到 `<缓存>/textures/<库>/<编号>/`（或 `--out`），写 `texture.json`：来源页、作者、许可、实际尺寸（米，
平铺尺寸 `tile` 就填它）、每张图的文件名、宽高、sha256。只收许可是 CC0 的；材质库的接口都是公开的，
不需要令牌。

"""

from __future__ import annotations

import io
import json
import os
import time
import zipfile
from typing import Any

import numpy as np
from PIL import Image

from ..core import ReconError, write_json
from ..env import cache_dir
from . import http
from .text import BM25, expand_query

PH_API = "https://api.polyhaven.com"
ACG_API = "https://ambientcg.com/api/v2/full_json"
LICENSE = "CC0-1.0"
WEEK = 7 * 24 * 3600
MAX_TEXTURE_DOWNLOAD = 256 << 20
LIBRARIES = ("polyhaven", "ambientcg")


# ---------------------------------------------------------------------------- 清单


def _cached_json(url: str, name: str) -> Any:
    path = cache_dir() / "textures" / "meta" / name
    if path.exists() and time.time() - path.stat().st_mtime < WEEK:
        return json.loads(path.read_text(encoding="utf-8"))
    data = http.get_json(url)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def polyhaven_candidates() -> list[dict]:
    assets = _cached_json(f"{PH_API}/assets?t=textures", "polyhaven-textures.json")
    out = []
    for aid, info in sorted(assets.items()):
        dims = info.get("dimensions")
        size = (
            [round(dims[0] / 1000, 3), round(dims[1] / 1000, 3)]
            if isinstance(dims, list) and len(dims) >= 2
            else None
        )
        out.append(
            {
                "library": "polyhaven",
                "id": aid,
                "title": info.get("name") or aid,
                "author": ", ".join(sorted((info.get("authors") or {}).keys())) or "Poly Haven",
                "license": LICENSE,
                "page": f"https://polyhaven.com/a/{aid}",
                "sizeM": size,
                "thumbnail": f"https://cdn.polyhaven.com/asset_img/thumbs/{aid}.png?width=256&height=256",
                "text": " ".join(
                    [
                        aid.replace("_", " "),
                        info.get("name") or "",
                        *(info.get("tags") or []),
                        *(info.get("categories") or []),
                    ]
                ),
            }
        )
    return out


def ambientcg_candidates(query: str, limit: int) -> list[dict]:
    from urllib.parse import quote

    url = (
        f"{ACG_API}?type=Material&q={quote(query)}&limit={max(limit * 3, 30)}"
        "&include=dimensionsData,tagData,displayData"
    )
    data = http.get_json(url)
    out = []
    for a in data.get("foundAssets") or []:
        aid = a.get("assetId")
        if not aid:
            continue
        dx, dy = a.get("dimensionX"), a.get("dimensionY")
        out.append(
            {
                "library": "ambientcg",
                "id": aid,
                "title": a.get("displayName") or aid,
                "author": "ambientCG",
                "license": LICENSE,
                "page": f"https://ambientcg.com/view?id={aid}",
                "sizeM": [round(dx / 100, 3), round((dy or dx) / 100, 3)] if dx else None,
                "thumbnail": f"https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/256-PNG/{aid}.png",
                "text": " ".join([aid, a.get("displayName") or "", *(a.get("tags") or [])]),
            }
        )
    return out


def cmd_texsearch(args) -> list[dict]:
    from .search import contact_sheet

    libs = args.library or list(LIBRARIES)
    pool: list[dict] = []
    if "polyhaven" in libs:
        pool += polyhaven_candidates()
    if "ambientcg" in libs:
        pool += ambientcg_candidates(args.query, args.limit)
    if not pool:
        raise ReconError("材质库没有返回任何候选")
    terms = expand_query(args.query)
    bm = BM25([{"text": c["text"]} for c in pool], {"text": 1.0})
    scores = bm.scores(terms)
    order = sorted(range(len(pool)), key=lambda i: (-scores[i], pool[i]["library"], pool[i]["id"]))
    picked = [dict(pool[i], score=round(float(scores[i]), 3)) for i in order if scores[i] > 0][: args.limit]
    if not picked:
        raise ReconError(f"没有找到和“{args.query}”相关的材质（换个英文描述）")
    os.makedirs(args.out, exist_ok=True)
    for i, c in enumerate(picked, 1):
        c["pick"] = i
        c.pop("text", None)
    write_json(os.path.join(args.out, "candidates.json"), picked)
    sheet = [
        dict(
            c,
            n=c["pick"],
            title=c["title"] + (f" · {c['sizeM'][0]}×{c['sizeM'][1]}m" if c.get("sizeM") else ""),
        )
        for c in picked
    ]
    contact_sheet(sheet, os.path.join(args.out, "sheet.jpg"), f"材质候选：{args.query}")
    print(
        json.dumps(
            [{k: c.get(k) for k in ("pick", "library", "id", "title", "sizeM", "score")} for c in picked],
            ensure_ascii=False,
        )
    )
    return picked


# ---------------------------------------------------------------------------- 下载


def _image_info(path: str) -> dict:
    with Image.open(path) as im:
        w, h = im.size
    return {
        "file": os.path.basename(path),
        "width": w,
        "height": h,
        "sha256": http.sha256_file(path),
        "size": os.path.getsize(path),
    }


def dx_to_gl(data: bytes) -> bytes:
    """DirectX 约定的法线贴图（绿色朝贴图下方）→ OpenGL 约定（绿色朝贴图上方）：翻转绿色通道。"""
    with Image.open(io.BytesIO(data)) as im:
        arr = np.asarray(im.convert("RGB")).copy()
    arr[..., 1] = 255 - arr[..., 1]
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def fetch_polyhaven(aid: str, resolution: str, out: str) -> dict[str, str]:
    files = http.get_json(f"{PH_API}/files/{aid}")
    paths = {}
    for role, key in (("color", "Diffuse"), ("normal", "nor_gl"), ("roughness", "Rough")):
        entry = ((files.get(key) or {}).get(resolution) or {}).get("jpg") or (
            (files.get(key) or {}).get(resolution) or {}
        ).get("png")
        if not entry:
            if role == "color":
                raise ReconError(f"Poly Haven 的 {aid} 没有 {resolution} 的颜色贴图")
            continue
        ext = os.path.splitext(entry["url"].split("?")[0])[1] or ".jpg"
        dest = os.path.join(out, f"{role}{ext}")
        http.download(entry["url"], dest, max_bytes=MAX_TEXTURE_DOWNLOAD)
        paths[role] = dest
    return paths


def fetch_ambientcg(aid: str, resolution: str, out: str) -> dict[str, str]:
    res = resolution.upper() if resolution.upper().endswith("K") else resolution
    url = f"https://ambientcg.com/get?file={aid}_{res}-JPG.zip"
    zpath = os.path.join(out, "download.zip")
    http.download(url, zpath, max_bytes=MAX_TEXTURE_DOWNLOAD)
    paths = {}
    try:
        with zipfile.ZipFile(zpath) as zf:
            names = zf.namelist()

            def member(*suffixes: str) -> str | None:
                for s in suffixes:
                    hit = [n for n in names if n.endswith(s) and "/" not in n.strip("/")]
                    if hit:
                        return hit[0]
                return None

            for role, suffixes in (
                ("color", ("_Color.jpg", "_Color.png")),
                ("normal", ("_NormalGL.jpg", "_NormalGL.png")),
                ("roughness", ("_Roughness.jpg", "_Roughness.png")),
            ):
                name = member(*suffixes)
                if name is None and role == "normal":
                    dx = member("_NormalDX.jpg", "_NormalDX.png")
                    if dx is not None:
                        dest = os.path.join(out, "normal.png")
                        with open(dest, "wb") as fh:
                            fh.write(dx_to_gl(zf.read(dx)))
                        paths[role] = dest
                    continue
                if name is None:
                    if role == "color":
                        raise ReconError(f"ambientCG 的 {aid} 包里没有颜色贴图")
                    continue
                dest = os.path.join(out, f"{role}{os.path.splitext(name)[1]}")
                with open(dest, "wb") as fh:
                    fh.write(zf.read(name))
                paths[role] = dest
    except zipfile.BadZipFile as e:
        raise ReconError(f"ambientCG 的 {aid} 下载的不是 zip：{e}") from e
    finally:
        os.remove(zpath)
    return paths


def _from_candidates(spec: str) -> dict:
    path, _, pick = spec.partition("#")
    with open(path, encoding="utf-8") as fh:
        cands = json.load(fh)
    for c in cands:
        if str(c.get("pick")) == pick:
            return c
    raise ReconError(f"{path} 里没有编号 {pick}")


def cmd_texfetch(args) -> dict:
    if args.source:
        cand = _from_candidates(args.source)
    elif args.library and args.id:
        if args.library == "polyhaven":
            cand = next((c for c in polyhaven_candidates() if c["id"] == args.id), None)
        else:
            cand = next((c for c in ambientcg_candidates(args.id, 5) if c["id"] == args.id), None)
        if cand is None:
            raise ReconError(f"{args.library} 里没有 {args.id}")
    else:
        raise ReconError("给 --from candidates.json#编号，或 --library 和 --id")
    if cand.get("license") != LICENSE:
        raise ReconError(f"只收 CC0 的材质（{cand['library']}:{cand['id']} 是 {cand.get('license')}）")
    out = args.out or str(cache_dir() / "textures" / cand["library"] / cand["id"] / args.resolution)
    os.makedirs(out, exist_ok=True)
    fetcher = fetch_polyhaven if cand["library"] == "polyhaven" else fetch_ambientcg
    paths = fetcher(cand["id"], args.resolution, out)
    info = {
        "library": cand["library"],
        "id": cand["id"],
        "title": cand.get("title"),
        "author": cand.get("author"),
        "license": LICENSE,
        "page": cand.get("page"),
        "sizeM": cand.get("sizeM"),
        "resolution": args.resolution,
        "normalConvention": "opengl",
        "files": {role: _image_info(p) for role, p in sorted(paths.items())},
        "note": "sizeM 是材质库标注的实际尺寸（米）：texture --tile 就填它；"
        "法线贴图是 OpenGL 约定（绿色朝贴图上方）",
    }
    write_json(os.path.join(out, "texture.json"), info)
    print(
        json.dumps(
            {"out": out, **{k: info[k] for k in ("library", "id", "sizeM")}, "files": sorted(paths)},
            ensure_ascii=False,
        )
    )
    return info


__all__ = [
    "LIBRARIES",
    "ambientcg_candidates",
    "cmd_texfetch",
    "cmd_texsearch",
    "dx_to_gl",
    "fetch_ambientcg",
    "fetch_polyhaven",
    "polyhaven_candidates",
]
