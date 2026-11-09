"""fetch：下载候选模型到本地缓存，记录哈希、大小、署名。

每个模型一个目录 `<缓存>/models/<库>/<编号>[@分辨率]/`：

- `model.glb`：本地用的 glb（Poly Haven 的 glTF 打包成 glb，只留底色贴图）；
- `src/`（只有 Poly Haven）：下载的 .gltf、.bin 和贴图原文件；
- `model.json`：旁注 —— 署名（`library、id、title、author、license、page`）、写回用的 `model`（`url、sha256、
  size、format`，gltf 格式另有 `files: {相对路径: {url, sha256, size}}`）、本地文件信息（三角形数、包围盒、
  贴图尺寸）和提示。

大小上限默认 50 MB（与处理服务的物件模型上限相同）。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time

from .. import core as wc
from ..models import PROCESSING_COORD_LIMIT, load_model_file, models_dir
from . import http, objaverse, polyhaven, sketchfab
from .gltf import pack_gltf
from .licenses import allowed, normalize
from .search import load_candidate

PROCESSING_MAX_TRIANGLES = 100_000  # 处理服务重新导出时减到这个三角形数以内


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.@-]", "_", name)[:120]


def model_dir(library: str, model_id: str, variant: str | None = None) -> str:
    leaf = _safe(model_id) + (f"@{_safe(variant)}" if variant else "")
    return os.path.join(models_dir(), library, leaf)


def attribution(c: dict) -> dict:
    lic = normalize(c.get("license"))
    if not allowed(lic):
        raise wc.ReconError(f"{c.get('library')}:{c.get('id')} 的许可 {c.get('license')!r} 不允许使用")
    return {
        "library": c["library"],
        "id": str(c["id"]),
        "title": c.get("title") or str(c["id"]),
        "author": c.get("author") or "unknown",
        "license": lic,
        "page": c.get("page") or "",
    }


def _fetch_polyhaven(c: dict, resolution: str, max_bytes: int, d: str) -> dict:
    g = polyhaven.gltf_files(c["id"], resolution)
    include = g.get("include") or {}
    total = (g.get("size") or 0) + sum(int(v.get("size") or 0) for v in include.values())
    if total > max_bytes:
        raise wc.ReconError(
            f"Poly Haven {c['id']} 的 {g['resolution']} glTF 共 {total} 字节，超过上限 {max_bytes}"
        )
    src = os.path.join(d, "src")
    gltf_name = os.path.basename(g["url"])
    sha, size = http.download(g["url"], os.path.join(src, gltf_name), max_bytes=max_bytes)
    files: dict[str, dict] = {}
    blobs: dict[str, bytes] = {}
    for rel in sorted(include):
        info = include[rel]
        if rel.startswith("/") or ".." in rel.split("/"):
            raise wc.ReconError(f"Poly Haven 文件路径不安全：{rel}")
        fsha, fsize = http.download(info["url"], os.path.join(src, rel), max_bytes=max_bytes)
        files[rel] = {"url": info["url"], "sha256": fsha, "size": fsize}
        with open(os.path.join(src, rel), "rb") as fh:
            blobs[rel] = fh.read()
    with open(os.path.join(src, gltf_name), "rb") as fh:
        glb = pack_gltf(fh.read(), blobs)
    with open(os.path.join(d, "model.glb"), "wb") as fh:
        fh.write(glb)
    return {
        "url": g["url"],
        "sha256": sha,
        "size": size,
        "format": "gltf",
        "files": files,
        "resolution": g["resolution"],
    }


def _fetch_glb(url: str, max_bytes: int, d: str, headers=None) -> tuple[str, int]:
    return http.download(url, os.path.join(d, "model.glb"), max_bytes=max_bytes, headers=headers)


def fetch_one(c: dict, resolution: str = "1k", max_bytes: int = 50 << 20) -> dict:
    lib = c["library"]
    src = attribution(c)
    variant = resolution if lib == "polyhaven" else None
    d = model_dir(lib, str(c["id"]), variant)
    side_path = os.path.join(d, "model.json")
    if os.path.exists(side_path) and os.path.exists(os.path.join(d, "model.glb")):
        wc.log(f"  {lib}:{c['id']} 已在缓存 {d}")
        with open(side_path, encoding="utf-8") as fh:
            return {**json.load(fh), "sidecar": side_path}
    os.makedirs(d, exist_ok=True)
    warnings: list[str] = []
    wc.log(f"  下载 {lib}:{c['id']}（{src['title']}）…")
    if lib == "polyhaven":
        model = _fetch_polyhaven(c, resolution, max_bytes, d)
    elif lib == "objaverse":
        url = (c.get("download") or {}).get("url")
        if not url:
            info = objaverse.lookup(str(c["id"]))
            url = (info or {}).get("download", {}).get("url")
        if not url:
            raise wc.ReconError(f"Objaverse 里没有 {c['id']}")
        sha, size = _fetch_glb(url, max_bytes, d)
        model = {"url": url, "sha256": sha, "size": size, "format": "glb"}
    elif lib == "sketchfab":
        mirror = objaverse.mirror_url(str(c["id"]))
        if mirror:
            sha, size = _fetch_glb(mirror, max_bytes, d)
            model = {"url": mirror, "sha256": sha, "size": size, "format": "glb"}
            warnings.append(
                "Sketchfab 模型在 Objaverse 镜像里，改用 huggingface.co 的镜像地址（处理服务能下载）"
            )
        else:
            url, _ = sketchfab.download_url(str(c["id"]))
            sha, size = _fetch_glb(url, max_bytes, d)
            model = {"url": None, "sha256": sha, "size": size, "format": "glb"}
            warnings.append(
                "Sketchfab 的下载地址是临时的、处理服务也没有令牌：这个模型不能按地址写回"
                "（AI 物件集只收按地址下载的模型），只能本地对照，写回请换候选"
            )
    else:
        raise wc.ReconError(f"不认识的模型库 {lib}")

    glb = os.path.join(d, "model.glb")
    m = load_model_file(glb)
    lo, hi = m.bounds()
    if max(abs(lo).max(), abs(hi).max()) > PROCESSING_COORD_LIMIT:
        warnings.append(
            "模型原始坐标超过 ±1000 米（单位多半是厘米）：place 会按扫描缩放，"
            "写回时处理服务按缩放后的坐标检查"
        )
    if m.triangles > PROCESSING_MAX_TRIANGLES:
        warnings.append(f"三角形 {m.triangles} 个，写回时处理服务会减到 {PROCESSING_MAX_TRIANGLES} 以内")
    if m.texture is None:
        warnings.append("没有贴图（颜色来自顶点色或材质底色）")
    side = {
        **src,
        "authorUrl": c.get("authorUrl") or "",
        "faceCount": c.get("faceCount"),
        "model": model,
        "local": {
            "path": "model.glb",
            "sha256": http.sha256_file(glb),
            "size": os.path.getsize(glb),
            "triangles": m.triangles,
            "vertices": len(m.vertices),
            "textureSide": int(max(m.texture.shape[:2])) if m.texture is not None else 0,
            "bounds": {"min": wc.r(lo, 4), "max": wc.r(hi, 4)},
            "extent": wc.r(hi - lo, 4),
        },
        "warnings": warnings,
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "note": "model 是写回用的来源文件（处理服务按 url 下载、核对 sha256 和 size）；local 是本机打包好的 "
        "glb",
    }
    wc.write_json(side_path, side)
    return {**side, "sidecar": side_path}


def resolve_candidates(args) -> list[dict]:
    if args.source:
        if not args.pick:
            raise wc.ReconError("--from 需要配 --pick 编号")
        return [load_candidate(f"{args.source}#{n.strip()}") for n in args.pick.split(",") if n.strip()]
    if args.library and args.id:
        if args.library == "objaverse":
            c = objaverse.lookup(args.id)
            if c is None:
                raise wc.ReconError(f"Objaverse 里没有 {args.id}")
            return [c]
        if args.library == "polyhaven":
            catalog = polyhaven.assets()
            if args.id not in catalog:
                raise wc.ReconError(f"Poly Haven 里没有 {args.id}")
            return [polyhaven.candidate(args.id, catalog[args.id], 0)]
        item = sketchfab.model_info(args.id)
        c = sketchfab.candidate(item, 0)
        if c is None:
            raise wc.ReconError(f"Sketchfab {args.id} 的许可不允许使用")
        return [c]
    raise wc.ReconError("需要 --from candidates.json --pick n，或 --library 和 --id")


def cmd_fetch(args) -> list[dict]:
    out = []
    for c in resolve_candidates(args):
        try:
            side = fetch_one(c, args.resolution, args.max_bytes)
        except http.DownloadError as e:
            shutil.rmtree(
                model_dir(
                    c["library"], str(c["id"]), args.resolution if c["library"] == "polyhaven" else None
                ),
                ignore_errors=True,
            )
            raise wc.ReconError(str(e)) from e
        path = side["sidecar"]
        out.append({"n": c.get("n"), **side})
        loc = side["local"]
        print(
            f"  #{c.get('n') or '-'} {side['library']}:{side['id']}  {side['title']}  {side['license']}  — "
            f"{side['author']}"
        )
        print(
            f"     本地 {os.path.join(os.path.dirname(path), loc['path'])}  {loc['triangles']} 个三角形  "
            f"尺寸 {loc['extent']} 米"
            f"  贴图 {loc['textureSide']} 像素"
        )
        print(
            f"     来源 {side['model']['url']}  {side['model']['size']} 字节  sha256 "
            f"{side['model']['sha256'][:16]}…"
        )
        for w in side["warnings"]:
            print(f"     提示：{w}")
        print(f"     旁注 {path}（place --candidate 可以直接用它）")
    if args.out:
        wc.write_json(args.out, out)
    return out
