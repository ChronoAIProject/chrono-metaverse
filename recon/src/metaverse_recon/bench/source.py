"""把 Scaniverse 网格分享或本地 GLB/ZIP 准备为重建输入，不连接 metaverse 服务。"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from ..bundle.scanzip import pack_stored_zip
from ..fetch import build_opener, host_allowed
from .core import ReconError

MAX_SCAN_BYTES = 1 << 30
MAX_TEXTURE_BYTES = 128 << 20
MAX_PAGE_BYTES = 2 << 20
SCAN_PATH = re.compile(r"/scan/([A-Za-z0-9_-]{1,80})/?$")


def scaniverse_url(value: str) -> tuple[str, str]:
    """分享参数不参与下载，只接受 Scaniverse 的固定扫描页面。"""
    parsed = urlsplit(value)
    match = SCAN_PATH.fullmatch(parsed.path)
    if not host_allowed(value, ("scaniverse.com",)) or not match:
        raise ReconError("请使用 https://scaniverse.com/scan/… 分享链接")
    return f"https://scaniverse.com/scan/{match[1]}", match[1]


def _download(url: str, dest: Path, maximum: int, opener) -> tuple[str, int]:
    current = url
    for _ in range(6):
        if not host_allowed(current, ("scaniverse.com",)):
            raise ReconError("Scaniverse 返回了不支持的下载主机")
        request = urllib.request.Request(
            current, headers={"User-Agent": "metaverse-recon", "Accept-Encoding": "identity"}
        )
        try:
            response = opener.open(request, timeout=120)
        except urllib.error.HTTPError as error:
            location = error.headers.get("Location") if error.headers else None
            error.close()
            if error.code in (301, 302, 303, 307, 308) and location:
                current = urljoin(current, location)
                continue
            raise ReconError(f"Scaniverse 下载失败（HTTP {error.code}），请检查分享或导出 GLB/ZIP") from None
        except (urllib.error.URLError, OSError, TimeoutError):
            raise ReconError("Scaniverse 下载中断，请重试") from None
        digest = hashlib.sha256()
        total = 0
        with response, dest.open("wb") as output:
            declared = response.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > maximum:
                raise ReconError("扫描来源超过本地重建大小上限")
            while block := response.read(1 << 20):
                total += len(block)
                if total > maximum:
                    raise ReconError("扫描来源超过本地重建大小上限")
                digest.update(block)
                output.write(block)
            if total == 0 or (declared and declared.isdigit() and total != int(declared)):
                raise ReconError("Scaniverse 文件不完整，请重试")
        return digest.hexdigest(), total
    raise ReconError("Scaniverse 下载重定向次数过多")


def _media(page: str, scan_id: str) -> tuple[str, str, str]:
    match = re.search(r'<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>(.*?)</script>', page, re.S)
    try:
        props = json.loads(match[1])["props"]["pageProps"] if match else {}
        model = props["scanModel"]
        media = model["media"]
        mesh, texture = media["meshUrl"], media["texUrl"]
        if model.get("modelType") != "mesh" or model["id"] != scan_id:
            raise ValueError
        for value in (mesh, texture):
            if not isinstance(value, str) or not host_allowed(value, ("scaniverse.com",)):
                raise ValueError
        return mesh, texture, str(props.get("scan", {}).get("caption", ""))[:200]
    except (KeyError, TypeError, ValueError):
        raise ReconError("该分享没有可重建的网格；请从 Scaniverse 导出 GLB/ZIP 后上传") from None


def prepare_source(source: str, out: str, *, opener=None) -> dict:
    destination = Path(out).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".source-", dir=destination) as temp:
        work = Path(temp)
        title = ""
        if source.startswith(("https://", "http://")):
            url, scan_id = scaniverse_url(source)
            opener = opener or build_opener()
            page = work / "page.html"
            _download(url, page, MAX_PAGE_BYTES, opener)
            mesh, texture, title = _media(page.read_text(encoding="utf-8"), scan_id)
            _download(mesh, work / "mesh.drc", MAX_SCAN_BYTES - MAX_TEXTURE_BYTES, opener)
            _download(texture, work / "tex.jpg", MAX_TEXTURE_BYTES, opener)
            local = work / "scan.zip"
            pack_stored_zip(
                [("mesh.drc", str(work / "mesh.drc")), ("tex.jpg", str(work / "tex.jpg"))], str(local)
            )
            kind = "scaniverse"
        else:
            original = Path(source)
            if not original.is_file() or original.suffix.lower() not in (".glb", ".zip"):
                raise ReconError("请选择本地 GLB 或包含网格与贴图的 ZIP")
            if not 0 < original.stat().st_size <= MAX_SCAN_BYTES:
                raise ReconError("模型文件为空或超过 1 GiB")
            with original.open("rb") as file:
                magic = file.read(4)
            if magic not in (b"glTF", b"PK\x03\x04"):
                raise ReconError("文件内容不是 GLB 或 ZIP")
            local = work / ("scan.glb" if magic == b"glTF" else "scan.zip")
            shutil.copyfile(original, local)
            kind = "file"
        digest = hashlib.sha256()
        with local.open("rb") as file:
            for block in iter(lambda: file.read(1 << 20), b""):
                digest.update(block)
        sha = digest.hexdigest()
        target = destination / local.name
        manifest = destination / "source.json"
        if target.exists() or manifest.exists():
            raise ReconError("来源输出目录已有内容，请使用新的目录")
        result = {
            "kind": kind,
            "scan": str(target),
            "size": local.stat().st_size,
            "sha256": sha,
            "title": title,
        }
        os.replace(local, target)
        manifest.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return result


def cmd_source(args) -> None:
    print(json.dumps(prepare_source(args.source, args.out), ensure_ascii=False, indent=2))
