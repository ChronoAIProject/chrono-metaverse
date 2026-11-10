"""Sketchfab（https://sketchfab.com）：只在设置了环境变量 `SKETCHFAB_TOKEN` 时启用（下载要令牌）。

- 检索：`GET https://api.sketchfab.com/v3/search?type=models&downloadable=true&q=…`，结果按许可过滤，只要
  CC0 和 CC-BY（`licenses.normalize`，Standard / Editorial / NC / ND / SA 一律不要）；
- 下载：`GET /v3/models/<uid>/download`（请求头 `Authorization: Token <令牌>`）给出临时地址（几分钟后失效）。
  所以打包时不能用这个地址：模型在 Objaverse 镜像里时改用 huggingface.co 上的镜像地址，否则 place
  会提示先把模型作为物件模型上传。

令牌只放在请求头里，不写进任何文件、日志或物件记录。
"""

from __future__ import annotations

import os
import urllib.parse

from ..core import log
from . import http
from .licenses import normalize

API = "https://api.sketchfab.com/v3"


def token() -> str | None:
    tok = os.environ.get("SKETCHFAB_TOKEN", "").strip()
    return tok or None


def enabled() -> bool:
    return token() is not None


def _headers() -> dict[str, str]:
    tok = token()
    return {"Authorization": f"Token {tok}"} if tok else {}


def _thumb(item: dict) -> str:
    imgs = (item.get("thumbnails") or {}).get("images") or []
    best = None
    for im in imgs:
        w = im.get("width") or 0
        if best is None or abs(w - 256) < abs((best.get("width") or 0) - 256):
            best = im
    return (best or {}).get("url") or ""


def candidate(item: dict, rank: int) -> dict | None:
    lic = normalize(item.get("license"))
    if lic is None or item.get("isAgeRestricted"):
        return None
    uid = item.get("uid")
    if not uid:
        return None
    user = item.get("user") or {}
    return {
        "library": "sketchfab",
        "id": uid,
        "title": item.get("name") or uid,
        "author": user.get("displayName") or user.get("username") or "unknown",
        "authorUrl": user.get("profileUrl") or "",
        "license": lic,
        "page": item.get("viewerUrl") or f"https://sketchfab.com/3d-models/{uid}",
        "faceCount": item.get("faceCount"),
        "download": {"api": f"{API}/models/{uid}/download", "format": "glb"},
        "thumbnail": _thumb(item),
        "tags": [t.get("name") for t in item.get("tags") or [] if isinstance(t, dict)][:12],
        "category": " ".join(c.get("name", "") for c in item.get("categories") or [] if isinstance(c, dict)),
        "description": (item.get("description") or "")[:240],
        "score": round(10.0 / (1 + rank), 3),
    }


def filter_results(items: list[dict]) -> list[dict]:
    out = []
    for i, item in enumerate(items):
        c = candidate(item, i)
        if c is not None:
            out.append(c)
    return out


def search(query: str, category: str | None, max_faces: int, limit: int) -> list[dict]:
    if not enabled():
        return []
    params = {
        "type": "models",
        "downloadable": "true",
        "q": " ".join(x for x in (query, category or "") if x),
        "max_face_count": str(max_faces),
        "count": str(min(48, max(24, limit * 3))),
    }
    url = f"{API}/search?{urllib.parse.urlencode(params)}"
    try:
        data = http.get_json(url, headers=_headers())
    except http.DownloadError as e:
        log(f"  Sketchfab：{e}")
        return []
    return filter_results(data.get("results") or [])


def model_info(uid: str) -> dict:
    return http.get_json(f"{API}/models/{uid}", headers=_headers())


def download_url(uid: str) -> tuple[str, int | None]:
    """临时的 glb 下载地址（不要写进任何文件）。"""
    if not enabled():
        raise http.DownloadError("Sketchfab 下载需要环境变量 SKETCHFAB_TOKEN")
    data = http.get_json(f"{API}/models/{uid}/download", headers=_headers())
    glb = data.get("glb") or {}
    if not glb.get("url"):
        raise http.DownloadError(f"Sketchfab {uid} 没有 glb 下载")
    return glb["url"], glb.get("size")
