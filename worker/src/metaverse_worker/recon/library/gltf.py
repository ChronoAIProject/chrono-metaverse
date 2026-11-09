"""glTF（.gltf + .bin + 贴图）打包成一个 glb，结果逐字节确定（同样的输入得到同样的输出）。

Poly Haven 的模型只有 glTF 分文件下载。打包时默认只留底色贴图（法线、粗糙度、环境光遮蔽这些网站用不上，
处理服务重新导出时也只保留底色），模型小得多。写回路径可以用同一个函数把下载到的文件打包后再交给
`processing.modelimport.load_model`。
"""

from __future__ import annotations

import base64
import json
import posixpath
from collections.abc import Mapping

from ..core import ReconError, glb_bytes

TEXTURE_KEYS = ("normalTexture", "occlusionTexture", "emissiveTexture")


def _resolve(uri: str, files: Mapping[str, bytes], base: str = "") -> bytes:
    if uri.startswith("data:"):
        head, _, data = uri.partition(",")
        return base64.b64decode(data) if head.endswith(";base64") else data.encode()
    from urllib.parse import unquote

    path = posixpath.normpath(posixpath.join(base, unquote(uri)))
    if path.startswith("../") or path.startswith("/"):
        raise ReconError(f"glTF 引用了目录外的文件：{uri}")
    if path not in files:
        raise ReconError(f"glTF 引用的文件没有下载：{path}")
    return files[path]


def _mime(data: bytes, uri: str) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    raise ReconError(f"贴图格式不认识：{uri}")


def _strip_textures(doc: dict) -> None:
    """只留底色贴图：去掉材质里其他贴图引用，重排 textures、images。"""
    used: list[int] = []
    for m in doc.get("materials") or []:
        for key in TEXTURE_KEYS:
            m.pop(key, None)
        pbr = m.get("pbrMetallicRoughness") or {}
        pbr.pop("metallicRoughnessTexture", None)
        for name in list((m.get("extensions") or {}).keys()):
            if name != "KHR_materials_unlit" and "Texture" in json.dumps(m["extensions"][name]):
                del m["extensions"][name]
        if not m.get("extensions"):
            m.pop("extensions", None)
        if "baseColorTexture" in pbr and pbr["baseColorTexture"]["index"] not in used:
            used.append(pbr["baseColorTexture"]["index"])
    textures = doc.get("textures") or []
    tex_map = {old: new for new, old in enumerate(sorted(used))}
    new_textures = [textures[i] for i in sorted(used) if i < len(textures)]
    img_used = sorted({t["source"] for t in new_textures if "source" in t})
    img_map = {old: new for new, old in enumerate(img_used)}
    images = doc.get("images") or []
    doc["images"] = [images[i] for i in img_used]
    for t in new_textures:
        if "source" in t:
            t["source"] = img_map[t["source"]]
    doc["textures"] = new_textures
    for m in doc.get("materials") or []:
        bct = (m.get("pbrMetallicRoughness") or {}).get("baseColorTexture")
        if bct is not None:
            bct["index"] = tex_map[bct["index"]]
    for key in ("textures", "images"):
        if not doc[key]:
            del doc[key]
    text = json.dumps({k: v for k, v in doc.items() if k not in ("extensionsUsed", "extensionsRequired")})
    for key in ("extensionsUsed", "extensionsRequired"):
        if key in doc:
            doc[key] = [e for e in doc[key] if f'"{e}"' in text]
            if not doc[key]:
                del doc[key]


def pack_gltf(
    gltf: bytes, files: Mapping[str, bytes], *, base_color_only: bool = True, base: str = ""
) -> bytes:
    """`files`：相对 .gltf 所在目录的路径 → 字节。返回 glb 字节。"""
    try:
        doc = json.loads(gltf)
    except json.JSONDecodeError as e:
        raise ReconError(f".gltf 不是合法的 JSON：{e}") from e
    if base_color_only:
        _strip_textures(doc)
    chunks: list[bytes] = []
    offset = 0
    starts = []
    for b in doc.get("buffers") or []:
        data = _resolve(b["uri"], files, base) if "uri" in b else b""
        data = data[: b.get("byteLength", len(data))]
        pad = (-len(data)) % 4
        starts.append(offset)
        chunks.append(data + b"\0" * pad)
        offset += len(data) + pad
    for v in doc.get("bufferViews") or []:
        v["byteOffset"] = v.get("byteOffset", 0) + starts[v.get("buffer", 0)]
        v["buffer"] = 0
    for img in doc.get("images") or []:
        if "uri" not in img:
            continue
        data = _resolve(img["uri"], files, base)
        mime = _mime(data, img["uri"])
        del img["uri"]
        pad = (-len(data)) % 4
        doc.setdefault("bufferViews", []).append({"buffer": 0, "byteOffset": offset, "byteLength": len(data)})
        img["bufferView"] = len(doc["bufferViews"]) - 1
        img["mimeType"] = mime
        chunks.append(data + b"\0" * pad)
        offset += len(data) + pad
    doc["buffers"] = [{"byteLength": offset}]
    return glb_bytes(doc, chunks)


def referenced_files(gltf: bytes) -> list[str]:
    """.gltf 引用的外部文件（相对路径）。"""
    doc = json.loads(gltf)
    out = []
    for item in [*(doc.get("buffers") or []), *(doc.get("images") or [])]:
        uri = item.get("uri")
        if uri and not uri.startswith("data:"):
            out.append(uri)
    return out
