"""按用途嗅探上传文件的格式（设计 6.1），以及从压缩包里取出扫描模型。

| 用途 | 接受的格式 |
|---|---|
| `scan`、`model` | glb、drc、obj，或 zip 压缩包（一个 glb / drc / obj 模型 + 贴图，如 Scaniverse 导出） |
| `texture` | png、jpeg、webp，单边不超过 8192 像素（只读文件头，不解码） |
| `ops` | NDJSON（每行一个 JSON 对象），可以 gzip 压缩；解压后的大小有上限，防压缩炸弹 |
| `script` | 纯文本：UTF-8，不含 NUL 字符 |

不认识或不合规时抛 `InputRejected`（不可重试）。这里的函数都在子进程里调用（解析不可信的文件）。
"""

from __future__ import annotations

import gzip
import json
import os
import zipfile
from dataclasses import dataclass

from PIL import Image

from ..errors import InputRejected
from .scan import sniff_format

PURPOSES = ("scan", "model", "texture", "ops", "script")
MODEL_FORMATS = ("glb", "draco", "obj")
IMAGE_FORMATS = ("png", "jpeg", "webp")

CONTENT_TYPES = {
    "glb": "model/gltf-binary",
    "draco": "application/x-draco",
    "obj": "model/obj",
    "zip": "application/zip",
    "png": "image/png",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "ndjson": "application/x-ndjson",
    "ndjson+gzip": "application/gzip",
    "text": "text/plain; charset=utf-8",
}

MAX_ZIP_MEMBERS = 256
MAX_LINE_BYTES = 16 << 20

Image.MAX_IMAGE_PIXELS = None  # 像素上限由我们自己在解码前检查


@dataclass(frozen=True)
class Sniffed:
    format: str  # CONTENT_TYPES 的键
    content_type: str
    detail: dict


def _is_zip(head: bytes) -> bool:
    return head.startswith(b"PK\x03\x04")


def _is_gzip(head: bytes) -> bool:
    return head.startswith(b"\x1f\x8b")


def image_size(path: str) -> tuple[str, int, int]:
    """只读文件头取格式和尺寸。"""
    with open(path, "rb") as fh:
        fmt = sniff_format(fh.read(64))
    if fmt not in IMAGE_FORMATS:
        raise InputRejected("贴图只接受 png、jpeg、webp")
    try:
        with Image.open(path) as img:
            w, h = img.size
    except Exception as error:
        raise InputRejected(f"贴图无法识别：{error}") from error
    return fmt, w, h


def check_texture(path: str, max_side: int, max_pixels: int) -> Sniffed:
    fmt, w, h = image_size(path)
    if w < 1 or h < 1 or w > max_side or h > max_side:
        raise InputRejected(f"贴图尺寸 {w}×{h} 超过上限 {max_side}×{max_side}")
    if w * h > max_pixels:
        raise InputRejected(f"贴图像素 {w}×{h} 超过上限")
    return Sniffed(fmt, CONTENT_TYPES[fmt], {"width": w, "height": h})


def _member_kind(name: str, head: bytes) -> str | None:
    lower = name.lower()
    if lower.endswith(".mtl"):
        return "mtl"
    fmt = sniff_format(head)
    if fmt == "obj" and not lower.endswith(".obj"):
        return None  # 文本文件的嗅探比较宽松，obj 还要看扩展名
    return fmt


@dataclass(frozen=True)
class ZipPlan:
    model: str  # 压缩包里的模型文件名
    model_format: str
    texture: str | None
    mtl: str | None


def inspect_zip(path: str, max_total_bytes: int) -> ZipPlan:
    """检查压缩包：成员数、解压后总大小、路径；找出模型（glb > drc > obj）和贴图。"""
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as error:
        raise InputRejected(f"压缩包无法打开：{error}") from error
    with zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if not infos or len(infos) > MAX_ZIP_MEMBERS:
            raise InputRejected(f"压缩包的文件数必须在 1–{MAX_ZIP_MEMBERS} 之间")
        total = sum(i.file_size for i in infos)
        if total > max_total_bytes:
            raise InputRejected("压缩包解压后超过大小上限")
        models: dict[str, list[str]] = {f: [] for f in MODEL_FORMATS}
        textures: list[tuple[int, str]] = []
        mtls: list[str] = []
        for info in infos:
            name = info.filename
            base = os.path.basename(name)
            if base.startswith(".") or "__MACOSX" in name.split("/"):
                continue
            if info.flag_bits & 0x1:
                raise InputRejected("不支持加密的压缩包")
            with zf.open(info) as fh:
                head = fh.read(64)
            kind = _member_kind(name, head)
            if kind in MODEL_FORMATS:
                models[kind].append(name)
            elif kind in IMAGE_FORMATS:
                textures.append((info.file_size, name))
            elif kind == "mtl":
                mtls.append(name)
        for fmt in MODEL_FORMATS:
            if len(models[fmt]) > 1:
                raise InputRejected(f"压缩包里有多个 {fmt} 模型，无法确定用哪个")
            if models[fmt]:
                model, model_format = models[fmt][0], fmt
                break
        else:
            raise InputRejected("压缩包里没有 glb、drc 或 obj 模型")
        texture = None
        mtl = mtls[0] if model_format == "obj" and mtls else None
        if mtl is not None:
            # obj：按 mtl 里的 map_Kd 找贴图
            wanted = _mtl_texture(zf.read(mtl))
            if wanted:
                for _, name in textures:
                    if os.path.basename(name).lower() == os.path.basename(wanted).lower():
                        texture = name
                        break
        if texture is None and textures and model_format != "glb":
            texture = max(textures)[1]  # 最大的那张图就是扫描贴图
        return ZipPlan(model, model_format, texture, mtl)


def _mtl_texture(data: bytes) -> str | None:
    for line in data.decode("utf-8", "replace").splitlines():
        parts = line.strip().split()
        if len(parts) >= 2 and parts[0] == "map_Kd":
            return parts[-1].replace("\\", "/")
    return None


def extract_model(path: str, out_dir: str, max_total_bytes: int) -> tuple[str, str | None]:
    """从压缩包里取出模型和贴图，写成 `out_dir` 下的固定文件名（不用包里的路径，防目录穿越）。

    返回 (模型路径, 贴图路径或 None)。obj 的 mtl 不需要：贴图直接交给加载函数。
    """
    plan = inspect_zip(path, max_total_bytes)
    os.makedirs(out_dir, exist_ok=True)
    ext = {"glb": ".glb", "draco": ".drc", "obj": ".obj"}[plan.model_format]
    model_path = os.path.join(out_dir, "model" + ext)
    texture_path = None
    with zipfile.ZipFile(path) as zf:
        _copy_member(zf, plan.model, model_path, max_total_bytes)
        if plan.texture is not None:
            with zf.open(plan.texture) as fh:
                tfmt = sniff_format(fh.read(64))
            texture_path = os.path.join(
                out_dir, "texture." + {"png": "png", "jpeg": "jpg", "webp": "webp"}[tfmt]
            )
            _copy_member(zf, plan.texture, texture_path, max_total_bytes)
    return model_path, texture_path


def _copy_member(zf: zipfile.ZipFile, name: str, dest: str, limit: int) -> None:
    written = 0
    with zf.open(name) as src, open(dest, "wb") as out:
        while True:
            block = src.read(1 << 20)
            if not block:
                break
            written += len(block)
            if written > limit:
                raise InputRejected("压缩包成员解压后超过大小上限")
            out.write(block)


def check_model_file(path: str, max_total_bytes: int) -> Sniffed:
    """scan / model 用途：glb、drc、obj 或含模型的 zip。"""
    with open(path, "rb") as fh:
        head = fh.read(64)
    if _is_zip(head):
        plan = inspect_zip(path, max_total_bytes)
        return Sniffed(
            "zip",
            CONTENT_TYPES["zip"],
            {"model": plan.model_format, "texture": plan.texture is not None},
        )
    fmt = sniff_format(head)
    if fmt not in MODEL_FORMATS:
        raise InputRejected("模型只接受 glb、drc、obj，或包含它们的 zip 压缩包")
    if fmt == "glb":
        _check_glb_header(path)
    return Sniffed(fmt, CONTENT_TYPES[fmt], {})


def _check_glb_header(path: str) -> None:
    import struct

    with open(path, "rb") as fh:
        header = fh.read(20)
    if len(header) < 20:
        raise InputRejected("glb 文件太短")
    magic, version, length, _json_len, json_type = struct.unpack("<4sIIII", header)
    if magic != b"glTF" or version != 2 or json_type != 0x4E4F534A:
        raise InputRejected("不是 glTF 2.0 的 glb 文件")
    if length != os.path.getsize(path):
        raise InputRejected("glb 文件头里的长度与实际不符")


def check_ops(path: str, max_bytes: int) -> Sniffed:
    """NDJSON（可 gzip）：每个非空行都是 JSON 对象。解压后超过 max_bytes 就拒绝。"""
    with open(path, "rb") as fh:
        compressed = _is_gzip(fh.read(2))
    opener = gzip.open if compressed else open
    lines = 0
    total = 0
    try:
        with opener(path, "rb") as fh:
            pending = b""
            while True:
                block = fh.read(1 << 20)
                if not block:
                    break
                total += len(block)
                if total > max_bytes:
                    raise InputRejected(f"ops 解压后超过上限 {max_bytes} 字节")
                pending += block
                *complete, pending = pending.split(b"\n")
                if len(pending) > MAX_LINE_BYTES:
                    raise InputRejected("ops 有一行超过 16MB")
                for line in complete:
                    lines += _check_ops_line(line, lines + 1)
            if pending.strip():
                lines += _check_ops_line(pending, lines + 1)
    except (OSError, EOFError, gzip.BadGzipFile) as error:
        raise InputRejected(f"ops 文件无法读取：{error}") from error
    if lines == 0:
        raise InputRejected("ops 文件是空的")
    fmt = "ndjson+gzip" if compressed else "ndjson"
    return Sniffed(fmt, CONTENT_TYPES[fmt], {"lines": lines, "bytes": total})


def _check_ops_line(line: bytes, number: int) -> int:
    line = line.strip()
    if not line:
        return 0
    try:
        value = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InputRejected(f"ops 第 {number} 行不是合法的 JSON：{error}") from error
    if not isinstance(value, dict):
        raise InputRejected(f"ops 第 {number} 行不是 JSON 对象")
    return 1


def check_script(path: str) -> Sniffed:
    """纯文本：UTF-8（流式解码），不含 NUL。"""
    import codecs

    decoder = codecs.getincrementaldecoder("utf-8")()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(1 << 20)
            if b"\x00" in block:
                raise InputRejected("脚本含 NUL 字符，不是纯文本")
            try:
                decoder.decode(block, final=not block)
            except UnicodeDecodeError as error:
                raise InputRejected("脚本不是 UTF-8 文本") from error
            if not block:
                break
    return Sniffed("text", CONTENT_TYPES["text"], {})


def sniff_upload(path: str, purpose: str, limits: dict) -> Sniffed:
    """按用途检查上传文件。`limits`：max_texture_side、max_texture_pixels、max_ops_bytes、max_zip_bytes。"""
    if purpose in ("scan", "model"):
        return check_model_file(path, int(limits["max_zip_bytes"]))
    if purpose == "texture":
        return check_texture(path, int(limits["max_texture_side"]), int(limits["max_texture_pixels"]))
    if purpose == "ops":
        return check_ops(path, int(limits["max_ops_bytes"]))
    if purpose == "script":
        return check_script(path)
    raise InputRejected(f"不认识的上传用途：{purpose}")
