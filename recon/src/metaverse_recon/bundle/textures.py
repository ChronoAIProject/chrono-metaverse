"""物件集里形状材质引用的贴图（`texture`、`normalMap`、`roughnessMap`）：三种写法都换成进包的贴图文件。

- 资源哈希（64 位小写十六进制）：本地已有的贴图（基线、工作区），在给的目录里按 `<哈希>.<扩展名>` 找文件；
- 外链 `{url, sha256, size}`：材质库、仓库里的文件，按外部模型同样的规则下载（https、主机列表
  `METAVERSE_RECON_MODEL_HOSTS`、逐跳检查重定向、核对大小和 sha256），单个不超过
  `METAVERSE_RECON_MAX_TEXTURE_BYTES`（默认 16 MiB）；
- 本地文件 `{file: 相对路径}`：工作台 `texture` 命令写进工作副本的贴图，相对物件集文件所在的目录读，不能是
  绝对路径、不能有 `..`。

文件读进来以后按贴图用途的上限检查（`limits.json` 的 `texture`：png、jpeg、webp，边长、像素、大小）；超了就
等比缩小、重新编码（不透明的存 JPEG，带透明的存 PNG），记录里换成缩小后的哈希。所以重建包和提交里的物件
记录只有哈希（SHAPES 2 合法条件第 5 条），包里不再有外链贴图。

外链对象、本地文件的写法错了，在下载之前就拒绝（向量 `api/crates/metaverse-core/tests/vectors/authored/`）。
"""

from __future__ import annotations

import copy
import hashlib
import io
import os
import posixpath
import re
from collections.abc import Callable, Iterable, Iterator, Mapping
from typing import Any
from urllib.parse import urlsplit

from PIL import Image

from ..authored import AuthoredError, parse_authored
from ..canonical import is_sha256_hex
from ..fetch import build_opener, fetch, parse_hosts

TEXTURE_KEYS = ("texture", "normalMap", "roughnessMap")
MAX_TEXTURE_BYTES_ENV = "METAVERSE_RECON_MAX_TEXTURE_BYTES"
DEFAULT_MAX_TEXTURE_BYTES = 16 << 20
MAX_URL = 2048
_FILE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_. -]*(?:/[A-Za-z0-9_][A-Za-z0-9_. -]*)*$")
_FORMATS = {"PNG": ("png", "image/png"), "JPEG": ("jpg", "image/jpeg"), "WEBP": ("webp", "image/webp")}


def max_texture_bytes() -> int:
    value = os.environ.get(MAX_TEXTURE_BYTES_ENV)
    return int(value) if value and value.isdigit() and int(value) > 0 else DEFAULT_MAX_TEXTURE_BYTES


def _walk(shape: Any, path: str) -> Iterator[tuple[str, dict]]:
    if not isinstance(shape, dict):
        return
    yield path, shape
    if shape.get("type") == "group":
        for i, child in enumerate(shape.get("children") or []):
            yield from _walk(child, f"{path}.children[{i}]")


def texture_slots(doc: Mapping[str, Any]) -> Iterator[tuple[str, dict, str]]:
    """物件集里每个贴图引用：(出错时报告的路径, 材质对象, 字段名)。"""
    for group in ("templates", "entities"):
        for i, body in enumerate(doc.get(group) or []):
            if not isinstance(body, dict):
                continue
            prefix = f"{group}[{i}]." if group == "templates" or len(doc.get(group) or []) > 1 else ""
            for path, node in _walk(body.get("shape"), "shape"):
                material = node.get("material")
                if not isinstance(material, dict):
                    continue
                where = f"{prefix}{path}.material" if path != "shape" else f"{prefix}shape.material"
                for key in TEXTURE_KEYS:
                    if key in material:
                        yield where, material, key


def _https(value: Any) -> bool:
    if not isinstance(value, str) or len(value) > MAX_URL or any(ord(c) < 0x21 for c in value):
        return False
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    return (
        parts.scheme == "https" and bool(parts.hostname) and parts.username is None and parts.password is None
    )


def ref_kind(value: Any, where: str) -> str:
    """一个贴图引用的写法：`hash`、`url` 或 `file`；写错时抛 `AuthoredError`（说明里带字段路径）。"""
    if isinstance(value, str):
        if is_sha256_hex(value):
            return "hash"
        raise AuthoredError(f"{where} 必须是 64 位小写十六进制的资源哈希、外链对象或本地文件 {{file}}")
    if not isinstance(value, dict):
        raise AuthoredError(f"{where} 只能是资源哈希字符串、外链对象 {{url, sha256, size}} 或 {{file}}")
    if set(value) == {"file"}:
        path = value["file"]
        if (
            not isinstance(path, str)
            or len(path) > 255
            or not _FILE.fullmatch(path)
            or posixpath.normpath(path) != path
            or ".." in path.split("/")
        ):
            raise AuthoredError(
                f"{where}.file 必须是相对路径（不能是绝对路径、不能有 ..，只含字母、数字、_ . - 空格和 /）"
            )
        return "file"
    unknown = set(value) - {"url", "sha256", "size"}
    if unknown:
        raise AuthoredError(f"{where}.{sorted(unknown)[0]}：外链对象只能有 url、sha256、size")
    for key in ("url", "sha256", "size"):
        if key not in value:
            raise AuthoredError(f"{where}.{key}：url、sha256、size 都必须给")
    if not _https(value["url"]):
        raise AuthoredError(f"{where}.url 必须是 https 地址（不带用户名）")
    if not is_sha256_hex(value["sha256"]):
        raise AuthoredError(f"{where}.sha256 必须是 64 位小写十六进制")
    size = value["size"]
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        raise AuthoredError(f"{where}.size 必须是正整数（字节）")
    if size > max_texture_bytes():
        raise AuthoredError(f"{where}.size 超过 {max_texture_bytes()} 字节")
    return "url"


def check_authored(doc: Any) -> dict[str, int]:
    """物件集的完整校验（贴图引用的三种写法 + `authored.parse_authored`），不下载、不读文件。

    返回 `{entities, templates, models, textureUrls, textureFiles}`（外链、本地文件按去重后的个数算）。
    """
    if not isinstance(doc, Mapping):
        raise AuthoredError("物件集必须是 JSON 对象")
    placeholder = copy.deepcopy(dict(doc))
    urls: set[str] = set()
    files: set[str] = set()
    for where, material, key in texture_slots(placeholder):
        value = material[key]
        kind = ref_kind(value, f"{where}.{key}")
        if kind == "url":
            urls.add(value["url"])
            material[key] = value["sha256"]
        elif kind == "file":
            files.add(value["file"])
            material[key] = hashlib.sha256(value["file"].encode()).hexdigest()
    parsed = parse_authored(placeholder)
    return {
        "entities": len(parsed["entities"]),
        "templates": len(parsed["templates"]),
        "models": len(parsed["models"]),
        "textureUrls": len(urls),
        "textureFiles": len(files),
    }


# ---------------------------------------------------------------------------- 读文件、守上限


def image_info(data: bytes) -> tuple[str, int, int, bool]:
    """(格式 png/jpeg/webp, 宽, 高, 是否带透明通道)；不是这三种格式时抛 `AuthoredError`。"""
    try:
        with Image.open(io.BytesIO(data)) as img:
            fmt = img.format
            w, h = img.size
            alpha = "A" in img.getbands() or (img.mode == "P" and "transparency" in img.info)
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise AuthoredError(f"贴图读不了：{error}") from error
    if fmt not in _FORMATS:
        raise AuthoredError(f"贴图只能是 png、jpeg、webp（这张是 {fmt}）")
    return _FORMATS[fmt][0], w, h, alpha


def fit_texture(data: bytes, limits: Mapping[str, Any]) -> tuple[bytes, str, bool]:
    """按贴图用途的上限（`limits.json` 的 `texture`）守住：返回 (字节, 扩展名, 是否缩小过)。"""
    ext, w, h, alpha = image_info(data)
    side, pixels, max_bytes = int(limits["maxSide"]), int(limits["maxPixels"]), int(limits["maxBytes"])
    if max(w, h) <= side and w * h <= pixels and len(data) <= max_bytes:
        return data, ext, False
    scale = min(1.0, side / max(w, h), (pixels / (w * h)) ** 0.5)
    for _ in range(8):
        size = (max(1, int(w * scale)), max(1, int(h * scale)))
        with Image.open(io.BytesIO(data)) as img:
            img.load()
            small = img.convert("RGBA" if alpha else "RGB").resize(size, Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        if alpha:
            small.save(buf, format="PNG", optimize=True)
            ext = "png"
        else:
            small.save(buf, format="JPEG", quality=90, optimize=True)
            ext = "jpg"
        if len(buf.getvalue()) <= max_bytes:
            return buf.getvalue(), ext, True
        scale *= 0.7
    raise AuthoredError("贴图缩小后仍超过大小上限")


def resolve_texture_refs(
    doc: Mapping[str, Any],
    *,
    base_dir: str,
    workdir: str,
    texture_limits: Mapping[str, Any],
    search_dirs: Iterable[str] = (),
    hosts: Iterable[str] | None = None,
    opener: Any = None,
    download: Callable[..., Any] = fetch,
) -> tuple[dict[str, Any], dict[str, str], dict[str, int]]:
    """把物件集里的贴图引用都换成哈希，并给每个哈希准备好本地文件（见模块说明）。

    返回 (换好的物件集, {哈希: 本地文件}, 统计 `{hashes, urls, files, shrunk}`)。资源哈希写法的贴图在
    `search_dirs` 里按 `<哈希>.<扩展名>` 找；找不到的不在返回的文件表里，交给后面的步骤（本次算出了同样的贴图
    就用，结构物件还能回退到算法结构的贴图）。
    """
    out = copy.deepcopy(dict(doc))
    os.makedirs(os.path.join(workdir, "textures"), exist_ok=True)
    allowed = (
        tuple(hosts) if hosts is not None else parse_hosts(os.environ.get("METAVERSE_RECON_MODEL_HOSTS"))
    )
    files: dict[str, str] = {}
    stats = {"hashes": 0, "urls": 0, "files": 0, "shrunk": 0}
    cache: dict[str, str] = {}  # 原始引用 → 换成的哈希
    local = _index_dirs(search_dirs)

    def keep(data: bytes) -> str:
        fitted, ext, shrunk = fit_texture(data, texture_limits)
        sha = hashlib.sha256(fitted).hexdigest()
        path = os.path.join(workdir, "textures", f"{sha}.{ext}")
        if not os.path.exists(path):
            with open(path, "wb") as fh:
                fh.write(fitted)
        files[sha] = path
        stats["shrunk"] += int(shrunk)
        return sha

    for where, material, key in list(texture_slots(out)):
        value = material[key]
        kind = ref_kind(value, f"{where}.{key}")
        if kind == "hash":
            stats["hashes"] += 1
            if value in local:
                if value not in cache:
                    with open(local[value], "rb") as fh:
                        cache[value] = keep(fh.read())
                material[key] = cache[value]
            continue
        ident = value["url"] if kind == "url" else os.path.realpath(os.path.join(base_dir, value["file"]))
        if ident not in cache:
            if kind == "url":
                dest = os.path.join(workdir, "downloads", value["sha256"])
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                download(
                    value["url"],
                    dest,
                    sha256=value["sha256"],
                    size=int(value["size"]),
                    hosts=allowed,
                    opener=opener if opener is not None else build_opener(),
                )
                stats["urls"] += 1
            else:
                root = os.path.realpath(base_dir)
                dest = ident
                if not dest.startswith(root + os.sep) or not os.path.isfile(dest):
                    raise AuthoredError(f"{where}.{key}.file：找不到 {value['file']}（相对 {base_dir}）")
                stats["files"] += 1
            with open(dest, "rb") as fh:
                cache[ident] = keep(fh.read())
        material[key] = cache[ident]
    return out, files, stats


def _index_dirs(dirs: Iterable[str]) -> dict[str, str]:
    """目录里按 `<哈希>.<扩展名>` 命名的贴图文件。"""
    out: dict[str, str] = {}
    for root in dirs:
        if not root or not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            stem = name.split(".", 1)[0]
            if is_sha256_hex(stem):
                out.setdefault(stem, os.path.join(root, name))
    return out


__all__ = [
    "DEFAULT_MAX_TEXTURE_BYTES",
    "TEXTURE_KEYS",
    "check_authored",
    "fit_texture",
    "image_info",
    "ref_kind",
    "resolve_texture_refs",
    "texture_slots",
]
