"""最小的 glTF 2.0 二进制（glb）写出器：单个网格、单个材质，不用 Draco/meshopt 压缩（共同约定第 4 条）。

自己写而不用 trimesh 导出，是为了：

- 输出逐字节确定（同样的输入得到同样的内容哈希，重做的任务复用同一个资源）；
- 完全控制贴图坐标约定：glTF 的贴图坐标原点就在左上角，和 `ScanMesh.uv` 相同，原样写入，不做翻转；
- 只写网站需要的东西：位置、法线、贴图坐标或顶点颜色、一张内嵌底色贴图（JPEG 或 PNG）。

材质不设金属度（`metallicFactor = 0`、`roughnessFactor = 1`），并声明 `KHR_materials_unlit`：
扫描贴图里已经带了真实光照，网站按不受光的材质显示最接近原样（不支持这个扩展的查看器会退回普通材质）。
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass

import numpy as np

_FLOAT = 5126
_UBYTE = 5121
_USHORT = 5123
_UINT = 5125
_ARRAY_BUFFER = 34962
_ELEMENT_ARRAY_BUFFER = 34963


@dataclass
class GlbMesh:
    positions: np.ndarray  # (N, 3) float
    faces: np.ndarray  # (M, 3) int
    normals: np.ndarray | None = None  # (N, 3) float，单位向量
    uv: np.ndarray | None = None  # (N, 2) float，左上角原点
    colors: np.ndarray | None = None  # (N, 4) uint8 RGBA（sRGB，写出时换成线性值）
    image: bytes | None = None  # 编码好的贴图
    image_mime: str = "image/jpeg"
    base_color: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0)
    name: str = "mesh"
    unlit: bool = True
    double_sided: bool = False


def vertex_normals(positions: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """面积加权的顶点法线（单位向量；孤立顶点给 +y）。"""
    v = np.asarray(positions, np.float64)
    f = np.asarray(faces, np.int64)
    cross = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])  # 长度 = 2 × 面积
    out = np.zeros_like(v)
    for k in range(3):
        np.add.at(out, f[:, k], cross)
    length = np.linalg.norm(out, axis=1, keepdims=True)
    out = np.where(length > 1e-20, out / np.maximum(length, 1e-20), np.array([0.0, 1.0, 0.0]))
    return out


def _srgb_to_linear_u8(colors: np.ndarray) -> np.ndarray:
    c = colors.astype(np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return np.clip(np.round(lin * 255.0), 0, 255).astype(np.uint8)


def _pad4(data: bytes, fill: bytes = b"\x00") -> bytes:
    return data + fill * ((4 - len(data) % 4) % 4)


def write_glb(mesh: GlbMesh) -> bytes:
    """把网格写成 glb 字节。"""
    positions = np.ascontiguousarray(mesh.positions, dtype="<f4")
    faces = np.asarray(mesh.faces, np.int64)
    n = len(positions)
    if positions.ndim != 2 or positions.shape[1] != 3 or n == 0:
        raise ValueError("positions 必须是非空的 (N, 3) 数组")
    if faces.ndim != 2 or faces.shape[1] != 3 or len(faces) == 0:
        raise ValueError("faces 必须是非空的 (M, 3) 数组")
    if faces.min() < 0 or faces.max() >= n:
        raise ValueError("faces 引用了不存在的顶点")
    if not np.all(np.isfinite(positions)):
        raise ValueError("positions 含非有限值")

    blobs: list[bytes] = []
    views: list[dict] = []
    accessors: list[dict] = []
    offset = 0

    def add_view(data: bytes, target: int | None) -> int:
        nonlocal offset
        view: dict = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        views.append(view)
        padded = _pad4(data)
        blobs.append(padded)
        offset += len(padded)
        return len(views) - 1

    def add_accessor(array: np.ndarray, component: int, kind: str, *, normalized=False, bounds=False) -> int:
        target = _ELEMENT_ARRAY_BUFFER if kind == "SCALAR" else _ARRAY_BUFFER
        view = add_view(array.tobytes(), target)
        acc: dict = {"bufferView": view, "componentType": component, "count": len(array), "type": kind}
        if normalized:
            acc["normalized"] = True
        if bounds:
            acc["min"] = [float(x) for x in array.min(axis=0)]
            acc["max"] = [float(x) for x in array.max(axis=0)]
        accessors.append(acc)
        return len(accessors) - 1

    attributes: dict[str, int] = {"POSITION": add_accessor(positions, _FLOAT, "VEC3", bounds=True)}
    normals = mesh.normals if mesh.normals is not None else vertex_normals(positions, faces)
    attributes["NORMAL"] = add_accessor(np.ascontiguousarray(normals, dtype="<f4"), _FLOAT, "VEC3")
    has_texture = mesh.image is not None and mesh.uv is not None
    if has_texture:
        uv = np.ascontiguousarray(mesh.uv, dtype="<f4")
        if uv.shape != (n, 2):
            raise ValueError("uv 必须是 (N, 2)")
        attributes["TEXCOORD_0"] = add_accessor(uv, _FLOAT, "VEC2")
    if mesh.colors is not None:
        colors = np.asarray(mesh.colors, np.uint8)
        if colors.shape == (n, 3):
            colors = np.concatenate([colors, np.full((n, 1), 255, np.uint8)], axis=1)
        if colors.shape != (n, 4):
            raise ValueError("colors 必须是 (N, 3) 或 (N, 4) uint8")
        lin = colors.copy()
        lin[:, :3] = _srgb_to_linear_u8(colors[:, :3])
        attributes["COLOR_0"] = add_accessor(np.ascontiguousarray(lin), _UBYTE, "VEC4", normalized=True)
    if n <= 65535:
        indices = np.ascontiguousarray(faces.reshape(-1), dtype="<u2")
        index_type = _USHORT
    else:
        indices = np.ascontiguousarray(faces.reshape(-1), dtype="<u4")
        index_type = _UINT
    index_accessor = add_accessor(indices, index_type, "SCALAR")

    pbr: dict = {"metallicFactor": 0.0, "roughnessFactor": 1.0}
    if any(c != 1.0 for c in mesh.base_color):
        pbr["baseColorFactor"] = [float(c) for c in mesh.base_color]
    gltf: dict = {
        "asset": {"version": "2.0", "generator": "metaverse-recon"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": mesh.name}],
        "meshes": [
            {
                "name": mesh.name,
                "primitives": [
                    {"attributes": attributes, "indices": index_accessor, "material": 0, "mode": 4}
                ],
            }
        ],
        "materials": [{"name": f"{mesh.name}-material", "pbrMetallicRoughness": pbr}],
    }
    material = gltf["materials"][0]
    if mesh.double_sided:
        material["doubleSided"] = True
    if mesh.unlit:
        material["extensions"] = {"KHR_materials_unlit": {}}
        gltf["extensionsUsed"] = ["KHR_materials_unlit"]
    if has_texture:
        image_view = add_view(mesh.image, None)
        gltf["images"] = [{"bufferView": image_view, "mimeType": mesh.image_mime}]
        # 9729 = LINEAR，9987 = LINEAR_MIPMAP_LINEAR，33071 = CLAMP_TO_EDGE
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
        gltf["textures"] = [{"sampler": 0, "source": 0}]
        pbr["baseColorTexture"] = {"index": 0}
    gltf["accessors"] = accessors
    gltf["bufferViews"] = views
    binary = b"".join(blobs)
    gltf["buffers"] = [{"byteLength": len(binary)}]

    json_chunk = _pad4(json.dumps(gltf, separators=(",", ":"), ensure_ascii=True).encode("ascii"), b" ")
    total = 12 + 8 + len(json_chunk) + 8 + len(binary)
    out = bytearray()
    out += struct.pack("<4sII", b"glTF", 2, total)
    out += struct.pack("<I4s", len(json_chunk), b"JSON") + json_chunk
    out += struct.pack("<I4s", len(binary), b"BIN\x00") + binary
    return bytes(out)


def read_glb_json(data: bytes) -> dict:
    """读出 glb 的 JSON 块（测试和校验用）。"""
    magic, version, _ = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2:
        raise ValueError("不是 glTF 2.0 的 glb")
    length, kind = struct.unpack_from("<I4s", data, 12)
    if kind != b"JSON":
        raise ValueError("glb 的第一块不是 JSON")
    return json.loads(data[20 : 20 + length])
