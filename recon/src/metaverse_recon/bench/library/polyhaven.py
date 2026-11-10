"""Poly Haven（https://polyhaven.com）：全部资源 CC0。模型用公开接口 api.polyhaven.com 列出和下载。

- 资源清单 `GET /assets?t=models`（缓存 7 天）：名称、标签、类别、作者、面数、尺寸（毫米，Blender 的 x、y、z，
  z 向上）、缩略图；
- 文件 `GET /files/<编号>`：glTF 按分辨率给出 .gltf 地址和它引用的 .bin、贴图（`include`），都在
dl.polyhaven.org。
"""

from __future__ import annotations

import json
import time
from typing import Any

from ..core import log
from ..env import cache_dir
from . import http
from .text import BM25, expand_query

API = "https://api.polyhaven.com"
LICENSE = "CC0-1.0"
WEEK = 7 * 24 * 3600


def _cached_json(url: str, name: str, max_age: float, offline: bool) -> Any:
    path = cache_dir() / "polyhaven" / name
    if path.exists() and (offline or time.time() - path.stat().st_mtime < max_age):
        return json.loads(path.read_text(encoding="utf-8"))
    if offline:
        raise http.DownloadError(f"离线模式下没有 Poly Haven 缓存 {name}")
    data = http.get_json(url)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def assets(offline: bool = False) -> dict[str, dict]:
    return _cached_json(f"{API}/assets?t=models", "assets.json", WEEK, offline)


def files(asset_id: str, offline: bool = False) -> dict:
    return _cached_json(f"{API}/files/{asset_id}", f"files-{asset_id}.json", WEEK, offline)


def thumbnail_url(asset_id: str, info: dict) -> str:
    url = (
        info.get("thumbnail_url")
        or f"https://cdn.polyhaven.com/asset_img/thumbs/{asset_id}.png?width=256&height=256"
    )
    return url.replace("format=webp", "format=png")


def dims_m(info: dict) -> list[float] | None:
    """尺寸换成 [宽 x, 高 y, 深 z]（米，y 向上）。"""
    d = info.get("dimensions")
    if not (isinstance(d, list) and len(d) == 3):
        return None
    return [round(d[0] / 1000, 3), round(d[2] / 1000, 3), round(d[1] / 1000, 3)]


def candidate(asset_id: str, info: dict, score: float) -> dict:
    authors = ", ".join((info.get("authors") or {}).keys()) or "Poly Haven"
    return {
        "library": "polyhaven",
        "id": asset_id,
        "title": info.get("name") or asset_id,
        "author": authors,
        "license": LICENSE,
        "page": f"https://polyhaven.com/a/{asset_id}",
        "faceCount": info.get("polycount"),
        "download": {"api": f"{API}/files/{asset_id}", "format": "gltf"},
        "thumbnail": thumbnail_url(asset_id, info),
        "tags": info.get("tags") or [],
        "category": info.get("category") or "/".join(info.get("categories") or []),
        "dimensionsM": dims_m(info),
        "description": (info.get("description") or "")[:240],
        "score": round(score, 3),
    }


def search(query: str, category: str | None, max_faces: int, limit: int, offline: bool = False) -> list[dict]:
    try:
        catalog = assets(offline)
    except http.DownloadError as e:
        log(f"  Poly Haven：{e}")
        return []
    ids = list(catalog)
    docs = []
    for k in ids:
        a = catalog[k]
        docs.append(
            {
                "name": a.get("name", k),
                "tags": " ".join(a.get("tags") or []),
                "categories": " ".join(a.get("categories") or [])
                + " "
                + (a.get("category") or "").replace("/", " "),
                "description": a.get("description") or "",
            }
        )
    q = expand_query(" ".join(x for x in (query, category or "") if x))
    scores = BM25(docs, {"name": 3.0, "tags": 2.0, "categories": 2.0, "description": 0.6}).scores(q)
    cat_q = expand_query(category) if category else []
    out = []
    for k, s, doc in zip(ids, scores, docs, strict=True):
        info = catalog[k]
        if s <= 0:
            continue
        if cat_q and not any(
            c in expand_query(doc["name"] + " " + doc["tags"] + " " + doc["categories"]) for c in cat_q
        ):
            continue
        faces = info.get("polycount")
        if isinstance(faces, int) and faces > max_faces:
            continue
        out.append(candidate(k, info, s))
    out.sort(key=lambda c: -c["score"])
    return out[: max(limit * 3, limit)]


def gltf_files(asset_id: str, resolution: str = "1k", offline: bool = False) -> dict:
    """某个分辨率的 glTF：{"url", "size", "md5", "include": {相对路径: {url, size, md5}}}。"""
    f = files(asset_id, offline)
    gl = f.get("gltf") or {}
    if resolution not in gl:
        if not gl:
            raise http.DownloadError(f"Poly Haven {asset_id} 没有 glTF 文件")
        resolution = sorted(gl, key=lambda r: int(r.rstrip("k") or 0))[0]
    entry = gl[resolution].get("gltf")
    if not entry:
        raise http.DownloadError(f"Poly Haven {asset_id} 的 {resolution} 没有 glTF")
    return {**entry, "resolution": resolution}
