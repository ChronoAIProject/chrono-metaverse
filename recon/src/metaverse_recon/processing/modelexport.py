"""外部模型（模型库里找来的现成模型）读入与重新导出成物件模型 glb（设计 8.3 `models`、第 12 节）。

以前的做法（`modelimport.load_model` + `write_model`）用 trimesh 把多个网格合成一个，贴图拼成一张图集，
再整体减面：

- **多材质、平铺贴图会坏**：图集里每块贴图只占一小格，贴图坐标超出 0–1 的平铺（布纹、木纹按米重复）被压进
  格子以后重复采样就采到了邻居的格子——Round Table 的贴图成了彩色噪点，Sofa Aura 坐垫上出黑划痕、接缝发黑，
  Large 2 Seater Sofa 出方格压痕；
- **减面不管材质和接缝**：拼起来的网格整体减面时，不同材质、不同贴图块之间的接缝两侧各自折叠，Armchair 塌成
  多面体、布纹拉丝。

现在自己读 glTF（glb，或 .gltf 加同一目录里的文件），按材质分开处理：

1. **读**：从场景根节点往下走（不能成环、不能有两个父节点），节点变换烘进顶点；每个图元保留位置、法线、
   `TEXCOORD`（按材质用的那一套，`KHR_texture_transform` 算进去）、`COLOR_0`；材质保留底色贴图和底色、
   透明方式、双面、不受光照，粗糙度取原材质的值（有粗糙度贴图时乘它的平均值）。旧的高光—光泽度材质取漫反射
   贴图和颜色。不支持的几何压缩（Draco、meshopt）、稀疏访问器、骨骼动画都拒绝；
2. **烘焙**：摆放的缩放、俯仰、翻滚（偏航写进物件的 `transform`，见 SHAPES 3）烘进顶点，镜像时翻转绕向；
   调色 `tint` 乘到每个材质的底色上（glTF 里颜色 = 底色 × 贴图 × 顶点色，与网站给模型调色的算法相同）；
3. **减面**（超过上限时）：全部图元一起减。位置相同的顶点焊起来（接缝、材质分界两侧共用顶点，不会裂开），
   从低激进程度开始一遍遍减（默认的高激进程度会把平滑的大曲面成片折成平面）；每个面的角按自己原来那块
   （同一材质里贴图坐标连续的一块）取贴图坐标和法线，每个面保留自己的材质，所以不会跨材质串贴图；
4. **写出**：一个节点（单位变换）、一个网格，每个材质一个图元，各用各的贴图，采样器保留原来的重复方式（平铺
   贴图照常重复）。贴图逐张缩到边长上限以内，合计像素超过上限时一起按比例缩小；不透明的存 JPEG（质量 90），
   用到透明通道的存 PNG。法线贴图、粗糙度贴图不导出；金属度一律写 0（网站没有环境贴图，金属表面会发黑，与
   以前的导出相同）；
5. **原点**：以包围盒的底面中心为原点（网站按物件 `bounds` 摆放只有模型的物件）。

输出逐字节确定：同样的输入得到同样的 glb 和资源哈希。
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import struct
from dataclasses import dataclass, field, replace
from typing import Any
from urllib.parse import unquote, urlsplit

import numpy as np
from PIL import Image

from ..errors import InputRejected
from .scan import guard_pixels

MAX_GLTF_JSON_BYTES = 16 << 20
MAX_MODEL_COORD = 1000.0
MAX_NODES = 100_000
JPEG_QUALITY = 90
# 只放行材质、贴图坐标和量化类的必需扩展；几何压缩等读不了的直接拒绝
_REQUIRED_OK = ("KHR_materials_", "KHR_texture_transform", "KHR_mesh_quantization")
_COMPONENTS = {
    5120: np.dtype("i1"),
    5121: np.dtype("u1"),
    5122: np.dtype("<i2"),
    5123: np.dtype("<u2"),
    5125: np.dtype("<u4"),
    5126: np.dtype("<f4"),
}
_WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
_REPEAT, _CLAMP, _MIRROR = 10497, 33071, 33648


# ---------------------------------------------------------------------------- 数据结构


@dataclass
class Material:
    """导出用的材质（颜色都是线性值）。"""

    base_color: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0)
    image: int | None = None  # 源模型里的图片编号
    wrap: tuple[int, int] = (_REPEAT, _REPEAT)
    roughness: float = 1.0
    alpha_mode: str = "OPAQUE"
    alpha_cutoff: float = 0.5
    double_sided: bool = False
    unlit: bool = False
    emissive: tuple[float, float, float] = (0.0, 0.0, 0.0)

    def key(self) -> str:
        return json.dumps(
            [
                [round(c, 6) for c in self.base_color],
                self.image,
                list(self.wrap),
                round(self.roughness, 4),
                self.alpha_mode,
                round(self.alpha_cutoff, 4),
                self.double_sided,
                self.unlit,
                [round(c, 6) for c in self.emissive],
            ]
        )


@dataclass
class Primitive:
    positions: np.ndarray  # (N, 3) float64
    faces: np.ndarray  # (M, 3) int64
    material: int
    normals: np.ndarray | None = None  # (N, 3)
    uv: np.ndarray | None = None  # (N, 2)，glTF 约定（左上角原点）
    colors: np.ndarray | None = None  # (N, 4) float，线性值 0–1


@dataclass
class SourceModel:
    """读进来的模型：图元（坐标已烘进节点变换）、材质、图片（编码好的原始字节，用到时再解码）。"""

    primitives: list[Primitive]
    materials: list[Material]
    images: list[bytes] = field(default_factory=list)

    @property
    def triangles(self) -> int:
        return sum(len(p.faces) for p in self.primitives)

    def merged(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """全部图元合成一个网格：(顶点, 面, 每个面的材质)。"""
        verts, faces, mats = [], [], []
        base = 0
        for p in self.primitives:
            verts.append(p.positions)
            faces.append(p.faces + base)
            mats.append(np.full(len(p.faces), p.material, np.int64))
            base += len(p.positions)
        if not verts:
            return np.zeros((0, 3)), np.zeros((0, 3), np.int64), np.zeros(0, np.int64)
        return np.concatenate(verts), np.concatenate(faces), np.concatenate(mats)

    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        v = np.concatenate([p.positions for p in self.primitives])
        return v.min(axis=0), v.max(axis=0)


@dataclass
class ExportedModel:
    data: bytes
    triangles: int
    vertices: int
    source_triangles: int
    materials: int
    textures: list[list[int]]  # 每张贴图的 [宽, 高]
    bounds: dict  # 导出后的局部坐标（原点在底面中心），按写进文件的 float32 算
    origin: list[float]  # 原点在烘焙后坐标里的位置（包围盒的底面中心）
    positions: np.ndarray  # 局部坐标的全部顶点（偏差计算用）
    faces: np.ndarray

    @property
    def texture_side(self) -> int:
        return max((max(t) for t in self.textures), default=0)

    @property
    def texture_pixels(self) -> int:
        return sum(w * h for w, h in self.textures)


# ---------------------------------------------------------------------------- 读 glTF


def _gltf_doc(path: str) -> tuple[dict, bytes | None]:
    """读 glb 或 .gltf：返回 (JSON, glb 的 BIN 块)。"""
    with open(path, "rb") as fh:
        head = fh.read(12)
        if head[:4] == b"glTF":
            version, length = struct.unpack("<II", head[4:12])
            if version != 2:
                raise InputRejected("只支持 glTF 2.0")
            data = head + fh.read()
            if length != len(data):
                raise InputRejected("glb 头里的长度与文件大小不符")
            offset, doc, bin_chunk = 12, None, None
            while offset + 8 <= len(data):
                size, kind = struct.unpack("<II", data[offset : offset + 8])
                chunk = data[offset + 8 : offset + 8 + size]
                if len(chunk) != size:
                    raise InputRejected("glb 的数据块被截断")
                if kind == 0x4E4F534A and doc is None:
                    if size > MAX_GLTF_JSON_BYTES:
                        raise InputRejected("glb 的 JSON 块超过 16MB")
                    doc = json.loads(chunk.decode("utf-8"))
                elif kind == 0x004E4942 and bin_chunk is None:
                    bin_chunk = chunk
                offset += 8 + size
            if not isinstance(doc, dict):
                raise InputRejected("glb 里没有 JSON 块")
            return doc, bin_chunk
        if os.path.getsize(path) > MAX_GLTF_JSON_BYTES:
            raise InputRejected("gltf 文件超过 16MB")
        fh.seek(0)
        try:
            doc = json.loads(fh.read().decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            raise InputRejected(f"gltf 不是合法的 JSON：{error}") from error
        if not isinstance(doc, dict):
            raise InputRejected("gltf 不是 JSON 对象")
        return doc, None


def _uri_bytes(base_dir: str, uri: Any, what: str) -> bytes:
    """gltf 里的 uri：`data:...;base64,` 或同一目录树里的相对文件（不接受 http、绝对路径、`..`）。"""
    if not isinstance(uri, str) or not uri:
        raise InputRejected(f"gltf 里{what}的 uri 不合法")
    if uri.startswith("data:"):
        head, _, payload = uri.partition(",")
        if not head.endswith(";base64"):
            raise InputRejected(f"gltf 里{what}的 data 地址必须是 base64")
        try:
            return base64.b64decode(payload, validate=True)
        except ValueError as error:
            raise InputRejected(f"gltf 里{what}的 base64 不合法") from error
    if urlsplit(uri).scheme or uri.startswith(("/", "\\")):
        raise InputRejected(f"gltf 里{what}只能引用相对路径的文件")
    root = os.path.realpath(base_dir)
    path = os.path.realpath(os.path.join(root, unquote(uri)))
    if not path.startswith(root + os.sep) or not os.path.isfile(path):
        raise InputRejected(f"gltf 里{what}引用的文件 {unquote(uri)!r} 不在模型目录里")
    with open(path, "rb") as fh:
        return fh.read()


class _Reader:
    def __init__(self, path: str) -> None:
        self.doc, self.glb_bin = _gltf_doc(path)
        self.base_dir = os.path.dirname(os.path.abspath(path))
        doc = self.doc
        if str((doc.get("asset") or {}).get("version", "2.0")) != "2.0":
            raise InputRejected("只支持 glTF 2.0")
        for ext in doc.get("extensionsRequired") or []:
            if not (isinstance(ext, str) and ext.startswith(_REQUIRED_OK)):
                raise InputRejected(f"模型需要不支持的扩展 {ext}（请换不压缩几何的版本）")
        self._buffers: dict[int, bytes] = {}

    def _list(self, key: str) -> list:
        value = self.doc.get(key) or []
        if not isinstance(value, list):
            raise InputRejected(f"glTF 的 {key} 必须是数组")
        return value

    def _item(self, key: str, index: Any) -> dict:
        items = self._list(key)
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(items):
            raise InputRejected(f"glTF 里 {key} 的编号 {index!r} 不合法")
        item = items[index]
        if not isinstance(item, dict):
            raise InputRejected(f"glTF 的 {key}[{index}] 不是对象")
        return item

    def buffer(self, index: int) -> bytes:
        if index not in self._buffers:
            buf = self._item("buffers", index)
            if "uri" in buf:
                data = _uri_bytes(self.base_dir, buf["uri"], f"第 {index} 个 buffer")
            elif index == 0 and self.glb_bin is not None:
                data = self.glb_bin
            else:
                raise InputRejected(f"第 {index} 个 buffer 没有数据")
            if len(data) < int(buf.get("byteLength", 0)):
                raise InputRejected(f"第 {index} 个 buffer 比声明的短")
            self._buffers[index] = data
        return self._buffers[index]

    def view_bytes(self, index: int) -> tuple[bytes, int, int, int | None]:
        view = self._item("bufferViews", index)
        data = self.buffer(view.get("buffer", 0))
        offset = int(view.get("byteOffset", 0))
        length = int(view.get("byteLength", 0))
        if offset < 0 or length < 0 or offset + length > len(data):
            raise InputRejected(f"缓冲区视图 {index} 超出 buffer")
        stride = view.get("byteStride")
        return data, offset, length, (int(stride) if stride is not None else None)

    def accessor(self, index: Any, *, normalize: bool = True) -> np.ndarray:
        acc = self._item("accessors", index)
        if "sparse" in acc:
            raise InputRejected("不支持稀疏访问器")
        dtype = _COMPONENTS.get(acc.get("componentType"))
        width = _WIDTH.get(acc.get("type"))
        count = acc.get("count")
        if dtype is None or width is None or not isinstance(count, int) or count < 0:
            raise InputRejected(f"访问器 {index} 的类型不合法")
        if "bufferView" not in acc:
            return np.zeros((count, width), np.float64)
        data, view_offset, view_length, stride = self.view_bytes(acc["bufferView"])
        elem = dtype.itemsize * width
        stride = stride or elem
        start = view_offset + int(acc.get("byteOffset", 0))
        if count and (stride < elem or start + stride * (count - 1) + elem > view_offset + view_length):
            raise InputRejected(f"访问器 {index} 超出缓冲区视图")
        if count == 0:
            return np.zeros((0, width), np.float64)
        arr = np.ndarray((count, width), dtype, buffer=data, offset=start, strides=(stride, dtype.itemsize))
        out = arr.astype(np.float64)
        if normalize and acc.get("normalized") and dtype.kind in "iu":
            info = np.iinfo(dtype)
            out = np.maximum(out / info.max, -1.0)
        return out

    def image_bytes(self, index: int) -> bytes:
        image = self._item("images", index)
        if "bufferView" in image:
            data, offset, length, _ = self.view_bytes(image["bufferView"])
            return data[offset : offset + length]
        if "uri" in image:
            return _uri_bytes(self.base_dir, image["uri"], f"第 {index} 张图片")
        raise InputRejected(f"第 {index} 张图片没有数据")


def _node_matrix(node: dict) -> np.ndarray:
    if "matrix" in node:
        m = np.asarray(node["matrix"], np.float64)
        if m.shape != (16,) or not np.all(np.isfinite(m)):
            raise InputRejected("节点的 matrix 必须是 16 个有限数")
        return m.reshape(4, 4).T
    t = np.asarray(node.get("translation", [0, 0, 0]), np.float64)
    q = np.asarray(node.get("rotation", [0, 0, 0, 1]), np.float64)
    s = np.asarray(node.get("scale", [1, 1, 1]), np.float64)
    if t.shape != (3,) or q.shape != (4,) or s.shape != (3,) or not np.all(np.isfinite(np.r_[t, q, s])):
        raise InputRejected("节点的 translation / rotation / scale 不合法")
    n = float(np.linalg.norm(q))
    x, y, z, w = (q / n) if n > 0 else (0.0, 0.0, 0.0, 1.0)
    r = np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )
    m = np.eye(4)
    m[:3, :3] = r * s
    m[:3, 3] = t
    return m


def _scene_meshes(reader: _Reader) -> list[tuple[int, np.ndarray]]:
    """场景里每个引用网格的节点：(网格编号, 世界矩阵)。节点不能成环、不能有两个父节点。"""
    nodes = reader._list("nodes")
    if len(nodes) > MAX_NODES:
        raise InputRejected(f"节点数超过 {MAX_NODES}")
    scenes = reader._list("scenes")
    if scenes:
        scene = reader._item("scenes", reader.doc.get("scene", 0))
        roots = scene.get("nodes") or []
    else:
        children = {c for n in nodes if isinstance(n, dict) for c in n.get("children") or []}
        roots = [i for i in range(len(nodes)) if i not in children]
    out: list[tuple[int, np.ndarray]] = []
    seen: set[int] = set()
    stack = [(r, np.eye(4)) for r in reversed(roots)]
    while stack:
        index, parent = stack.pop()
        node = reader._item("nodes", index)
        if index in seen:
            raise InputRejected("节点成环或有两个父节点")
        seen.add(index)
        if node.get("skin") is not None:
            raise InputRejected("不支持骨骼蒙皮的模型")
        world = parent @ _node_matrix(node)
        if "mesh" in node:
            out.append((node["mesh"], world))
        for child in reversed(node.get("children") or []):
            stack.append((child, world))
    return out


def _texture_info(reader: _Reader, info: Any) -> tuple[int | None, int, tuple[int, int], np.ndarray | None]:
    """贴图引用 → (图片编号, 用哪套贴图坐标, 重复方式, KHR_texture_transform 的 3×3 矩阵或 None)。"""
    if not isinstance(info, dict) or "index" not in info:
        return None, 0, (_REPEAT, _REPEAT), None
    texture = reader._item("textures", info["index"])
    source = texture.get("source")
    exts = texture.get("extensions") or {}
    if source is None:
        for name in ("EXT_texture_webp", "KHR_texture_basisu", "MSFT_texture_dds"):
            if isinstance(exts.get(name), dict) and "source" in exts[name]:
                source = exts[name]["source"]
                break
    wrap = (_REPEAT, _REPEAT)
    if texture.get("sampler") is not None:
        sampler = reader._item("samplers", texture["sampler"])
        wrap = (int(sampler.get("wrapS", _REPEAT)), int(sampler.get("wrapT", _REPEAT)))
    coord = int(info.get("texCoord", 0))
    matrix = None
    xf = (info.get("extensions") or {}).get("KHR_texture_transform")
    if isinstance(xf, dict):
        ox, oy = (xf.get("offset") or [0.0, 0.0])[:2]
        rot = float(xf.get("rotation", 0.0))
        sx, sy = (xf.get("scale") or [1.0, 1.0])[:2]
        c, s = math.cos(rot), math.sin(rot)
        matrix = (
            np.array([[1, 0, ox], [0, 1, oy], [0, 0, 1]], np.float64)
            @ np.array([[c, s, 0], [-s, c, 0], [0, 0, 1]], np.float64)
            @ np.array([[sx, 0, 0], [0, sy, 0], [0, 0, 1]], np.float64)
        )
        coord = int(xf.get("texCoord", coord))
    return (int(source) if source is not None else None), coord, wrap, matrix


def _channel_mean(data: bytes, channel: int, max_pixels: int) -> float | None:
    """贴图某个通道的平均值（0–1），用来把粗糙度贴图折算成一个数。读不了时返回 None。"""
    try:
        with Image.open(io.BytesIO(data)) as img:
            w, h = img.size
            if w * h > max_pixels:
                return None
            small = img.convert("RGB").reduce(max(1, max(w, h) // 128))
            return float(np.asarray(small)[..., channel].mean()) / 255.0
    except (OSError, ValueError, Image.DecompressionBombError):
        return None


def _material(reader: _Reader, index: Any, max_pixels: int) -> tuple[Material, int, np.ndarray | None]:
    """材质 → (Material, 底色贴图用哪套贴图坐标, 贴图坐标变换)。"""
    m = reader._item("materials", index)
    pbr = m.get("pbrMetallicRoughness") or {}
    exts = m.get("extensions") or {}
    factor = pbr.get("baseColorFactor", [1.0, 1.0, 1.0, 1.0])
    color_info = pbr.get("baseColorTexture")
    spec = exts.get("KHR_materials_pbrSpecularGlossiness")
    if isinstance(spec, dict) and color_info is None:
        factor = spec.get("diffuseFactor", factor)
        color_info = spec.get("diffuseTexture")
    image, coord, wrap, matrix = _texture_info(reader, color_info)
    roughness = float(pbr.get("roughnessFactor", 1.0))
    mr_image, *_ = _texture_info(reader, pbr.get("metallicRoughnessTexture"))
    if mr_image is not None:
        mean = _channel_mean(reader.image_bytes(mr_image), 1, max_pixels)
        if mean is not None:
            roughness *= mean
    emissive = tuple(float(c) for c in (m.get("emissiveFactor") or [0.0, 0.0, 0.0])[:3])
    if m.get("emissiveTexture") is not None:
        emissive = (0.0, 0.0, 0.0)  # 自发光贴图不导出，只有颜色的自发光保留
    mat = Material(
        base_color=tuple(float(c) for c in [*list(factor), 1.0, 1.0, 1.0, 1.0][:4]),  # type: ignore[arg-type]
        image=image,
        wrap=wrap,
        roughness=float(np.clip(roughness, 0.0, 1.0)),
        alpha_mode=str(m.get("alphaMode", "OPAQUE")),
        alpha_cutoff=float(m.get("alphaCutoff", 0.5)),
        double_sided=bool(m.get("doubleSided", False)),
        unlit="KHR_materials_unlit" in exts,
        emissive=emissive,  # type: ignore[arg-type]
    )
    if mat.alpha_mode not in ("OPAQUE", "MASK", "BLEND"):
        mat.alpha_mode = "OPAQUE"
    return mat, coord, matrix


def _count_triangles(reader: _Reader, placed: list[tuple[int, np.ndarray]]) -> int:
    total = 0
    for mesh_index, _ in placed:
        mesh = reader._item("meshes", mesh_index)
        for prim in mesh.get("primitives") or []:
            if not isinstance(prim, dict) or prim.get("mode", 4) != 4:
                continue
            ref = prim.get("indices", (prim.get("attributes") or {}).get("POSITION"))
            if ref is not None:
                count = reader._item("accessors", ref).get("count", 0)
                total += int(count) // 3 if isinstance(count, int) else 0
    return total


def read_gltf(path: str, *, max_triangles: int, max_pixels: int) -> SourceModel:
    """读 glb / .gltf（见模块说明第 1 步）。三角形数在解码之前就按访问器的 `count` 检查。"""
    guard_pixels(max_pixels)
    reader = _Reader(path)
    placed = _scene_meshes(reader)
    total = _count_triangles(reader, placed)
    if total > max_triangles:
        raise InputRejected(f"三角形数 {total} 超过上限 {max_triangles}")
    materials: list[Material] = []
    mat_index: dict[Any, tuple[int, int, np.ndarray | None]] = {}
    primitives: list[Primitive] = []
    for mesh_index, world in placed:
        mesh = reader._item("meshes", mesh_index)
        for prim in mesh.get("primitives") or []:
            if not isinstance(prim, dict) or prim.get("mode", 4) != 4:
                continue  # 线、点不导出
            if prim.get("targets"):
                raise InputRejected("不支持变形目标")
            attrs = prim.get("attributes") or {}
            if "POSITION" not in attrs:
                continue
            key = prim.get("material")
            if key not in mat_index:
                if key is None:
                    mat, coord, matrix = Material(), 0, None
                else:
                    mat, coord, matrix = _material(reader, key, max_pixels)
                materials.append(mat)
                mat_index[key] = (len(materials) - 1, coord, matrix)
            mi, coord, uv_matrix = mat_index[key]
            pos = reader.accessor(attrs["POSITION"])
            if pos.shape[1] != 3:
                raise InputRejected("POSITION 必须是 VEC3")
            if "indices" in prim:
                idx = reader.accessor(prim["indices"], normalize=False).reshape(-1).astype(np.int64)
            else:
                idx = np.arange(len(pos), dtype=np.int64)
            if len(idx) % 3:
                raise InputRejected("三角形的下标数不是 3 的倍数")
            faces = idx.reshape(-1, 3)
            if len(faces) and (faces.min() < 0 or faces.max() >= len(pos)):
                raise InputRejected("三角面引用了不存在的顶点")
            lin = world[:3, :3]
            positions = pos @ lin.T + world[:3, 3]
            normals = None
            if "NORMAL" in attrs:
                n = reader.accessor(attrs["NORMAL"])[:, :3]
                # 法线按逆转置变换：行向量写法是 n · M⁻¹
                n = n @ np.linalg.inv(lin) if abs(np.linalg.det(lin)) > 1e-30 else n
                normals = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
            uv = None
            uv_key = f"TEXCOORD_{coord}"
            if materials[mi].image is not None and uv_key in attrs:
                uv = reader.accessor(attrs[uv_key])[:, :2]
                if uv_matrix is not None:
                    uv = np.c_[uv, np.ones(len(uv))] @ uv_matrix.T
                    uv = uv[:, :2]
            colors = None
            if "COLOR_0" in attrs:
                c = reader.accessor(attrs["COLOR_0"])
                colors = np.c_[c[:, :3], c[:, 3] if c.shape[1] > 3 else np.ones(len(c))]
            if np.linalg.det(lin) < 0:
                faces = faces[:, [0, 2, 1]]
            ok = np.all(np.isfinite(positions), axis=1)
            if not ok.all():
                raise InputRejected("顶点坐标含非有限值")
            primitives.append(Primitive(positions, faces, mi, normals, uv, colors))
    if not primitives or sum(len(p.faces) for p in primitives) == 0:
        raise InputRejected("模型里没有三角网格")
    used_images = sorted({m.image for m in materials if m.image is not None})
    images = [b""] * (max(used_images) + 1 if used_images else 0)
    for i in used_images:
        images[i] = reader.image_bytes(i)
    return SourceModel(primitives, materials, images)


def read_model(path: str, *, max_triangles: int, max_pixels: int) -> SourceModel:
    """读外部模型：glb、.gltf 用本模块；obj、drc（以前的物件模型导入收的格式）用 `modelimport.load_model`，
    整个模型当一个材质。"""
    from .scan import sniff_file

    fmt = "gltf" if path.lower().endswith(".gltf") else sniff_file(path)
    if fmt in ("glb", "gltf"):
        return read_gltf(path, max_triangles=max_triangles, max_pixels=max_pixels)
    from .modelimport import load_model

    mesh, colors, base = load_model(
        path, None, max_triangles=max_triangles, max_texture_pixels=max_pixels, coord_limit=None
    )
    images: list[bytes] = []
    material = Material(base_color=_srgb_tuple_to_linear(base) if base else (1.0, 1.0, 1.0, 1.0))
    uv = None
    if mesh.texture is not None and mesh.uv is not None:
        buf = io.BytesIO()
        Image.fromarray(mesh.texture).save(buf, format="PNG")
        images.append(buf.getvalue())
        material = Material(image=0)
        uv = np.asarray(mesh.uv, np.float64)
    lin_colors = None
    if colors is not None:
        c = colors.astype(np.float64) / 255.0
        lin_colors = np.c_[_srgb_to_linear(c[:, :3]), c[:, 3]]
    prim = Primitive(
        np.asarray(mesh.vertices, np.float64), np.asarray(mesh.faces, np.int64), 0, None, uv, lin_colors
    )
    return SourceModel([prim], [material], images)


def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _srgb_tuple_to_linear(base: tuple) -> tuple[float, float, float, float]:
    """`modelimport.load_model` 给的底色是 glTF 里原样的值（线性）；obj 的 mtl 颜色也按线性处理。"""
    return (float(base[0]), float(base[1]), float(base[2]), float(base[3]))


# ---------------------------------------------------------------------------- 烘焙摆放


def placed_model(
    model: SourceModel, linear: np.ndarray, tint: Any = None, *, coord_limit: float | None = MAX_MODEL_COORD
) -> SourceModel:
    """把线性变换（缩放、俯仰、翻滚，不含平移和偏航）烘进顶点，调色乘到每个材质的底色上。镜像时翻转绕向。"""
    lin = np.asarray(linear, np.float64)
    det = float(np.linalg.det(lin))
    if abs(det) < 1e-30:
        raise InputRejected("摆放的变换退化（缩放有 0）")
    inv = np.linalg.inv(lin)  # 法线按逆转置变换：行向量写法是 n · M⁻¹
    prims = []
    for p in model.primitives:
        normals = None
        if p.normals is not None:
            n = p.normals @ inv
            normals = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        faces = p.faces if det > 0 else p.faces[:, [0, 2, 1]]
        prims.append(replace(p, positions=p.positions @ lin.T, faces=faces, normals=normals))
    if coord_limit is not None:
        extent = max(float(np.abs(p.positions).max()) for p in prims if len(p.positions))
        if extent > coord_limit:
            raise InputRejected(f"模型摆放后的坐标超出 ±{coord_limit:g} 米（scale 是不是没按模型单位换算）")
    materials = list(model.materials)
    if tint is not None:
        k = _srgb_to_linear(np.asarray(tint, np.float64) / 255.0)
        materials = [
            replace(
                m,
                base_color=(
                    m.base_color[0] * k[0],
                    m.base_color[1] * k[1],
                    m.base_color[2] * k[2],
                    m.base_color[3],
                ),
            )
            for m in materials
        ]
    return SourceModel(prims, materials, model.images)


# ---------------------------------------------------------------------------- 减面


def smooth_normals(positions: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """面积加权的顶点法线，位置相同的顶点（贴图接缝两侧）共用一个法线。"""
    points, weld = np.unique(positions, axis=0, return_inverse=True)
    weld = weld.reshape(-1)
    f = weld[faces]
    cross = np.cross(points[f[:, 1]] - points[f[:, 0]], points[f[:, 2]] - points[f[:, 0]])
    acc = np.zeros_like(points)
    for k in range(3):
        np.add.at(acc, f[:, k], cross)
    length = np.linalg.norm(acc, axis=1, keepdims=True)
    acc = np.where(length > 1e-20, acc / np.maximum(length, 1e-20), np.array([0.0, 1.0, 0.0]))
    return acc[weld]


# 减面的激进程度：从低到高一遍遍减，每一遍接着上一遍的结果，直到减到目标以内（见 `welded_parents`）
SIMPLIFY_AGGRESSION = (1.0, 1.0, 2.0, 3.0, 5.0, 7.0)


def welded_parents(points: np.ndarray, faces: np.ndarray, target: int) -> np.ndarray:
    """焊接后的网格减到 `target` 个面以内，返回折叠历史（每个点被折叠进的点，没被折叠的指向自己）。

    减面库默认的激进程度（7）每一轮把误差门槛放得很快，平滑的大曲面（沙发、扶手椅的布面）先被成片折叠成大平面，
    外形塌成多面体，平铺贴图在大三角形上拉成条纹。这里从激进程度 1 开始：减面库在轮数用完时停下，没到目标就在
    结果上再来一遍，激进程度逐步加大；每一遍的折叠都接到同一份历史上（点的编号换回原来的）。
    """
    import fast_simplification

    from .webmodel import _nondegenerate, _roots

    parent = np.arange(len(points), dtype=np.int64)
    current = faces
    for agg in SIMPLIFY_AGGRESSION:
        if len(current) <= target:
            break
        alive = np.unique(current)
        compact = np.searchsorted(alive, current)
        _, _, collapses = fast_simplification.simplify(
            np.ascontiguousarray(points[alive]),
            np.ascontiguousarray(compact, np.int64),
            target_count=target,
            return_collapses=True,
            agg=agg,
        )
        c = alive[np.asarray(collapses, np.int64).reshape(-1, 2)]
        parent[c[:, 1]] = c[:, 0]
        current = _roots(parent)[faces]
        current = current[_nondegenerate(current)]
    return parent


def simplify_corners(
    vertices: np.ndarray, faces: np.ndarray, uv: np.ndarray, max_triangles: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """减面，返回 (保留的面在原来的编号, 每个角取位置的原始顶点, 每个角取贴图坐标、法线、颜色的原始顶点)。

    位置相同的顶点先焊起来（接缝、材质分界成了内部边，两侧共用顶点，不会裂开），按 `welded_parents` 减面；
    顶点位置取根的原始位置；贴图坐标等属性按"面的角"取（`webmodel._corner_uv_sources`：面原来属于哪一块，
    就取并入顶点在这一块里的那一份，不会跨到别的贴图块或别的材质上）。
    """
    from .webmodel import _components, _corner_uv_sources, _nondegenerate, _roots

    n = len(vertices)
    vertices = np.ascontiguousarray(vertices, np.float64)
    faces = np.ascontiguousarray(faces, np.int64)
    target = max(4, int(max_triangles * 0.98))
    points, weld = np.unique(vertices, axis=0, return_inverse=True)
    weld = weld.reshape(-1).astype(np.int64)
    welded = weld[faces]
    source = np.nonzero(_nondegenerate(welded))[0]
    welded = np.ascontiguousarray(welded[source])
    parent = welded_parents(points, welded, target)
    rf = _roots(parent)[welded]
    keep = _nondegenerate(rf)
    rf, source = rf[keep], source[keep]
    if len(rf) > max_triangles:
        # 极少数情况下停在目标之上：再按面数截一次（保留面积最大的面）
        a = points[rf]
        area = np.linalg.norm(np.cross(a[:, 1] - a[:, 0], a[:, 2] - a[:, 0]), axis=1)
        pick = np.sort(np.argsort(-area, kind="stable")[:max_triangles])
        rf, source = rf[pick], source[pick]
    corners = faces[source].reshape(-1)
    comp = _components(n, faces)
    attr = _corner_uv_sources(corners, rf.reshape(-1), weld, parent, comp, uv).reshape(-1, 3)
    rep = np.zeros(len(points), np.int64)
    rep[weld] = np.arange(n, dtype=np.int64)
    return source, rep[rf], attr


def transfer_attributes(
    points: np.ndarray,
    comps: np.ndarray,
    vertices: np.ndarray,
    faces: np.ndarray,
    vertex_comp: np.ndarray,
    attrs: list[np.ndarray],
    fallback: np.ndarray,
    k: int = 32,
) -> list[np.ndarray]:
    """在原网格上取属性：每个点在"同一块"（`comps`）的原始三角形里找最近的一个，按重心坐标插值 `attrs`。

    减面后有的角的位置（并入的顶点）不在这个角原来那块贴图里，以前沿折叠链取那块里最后一个顶点的贴图坐标，
    位置和贴图坐标对不上：平铺很密的贴图（布纹一米重复几十次）在这样的三角形上被压成条纹。这里按位置把贴图
    坐标、法线、颜色从原网格上投过来。附近 `k` 个三角形里没有同一块的，就用 `fallback` 给的顶点（沿折叠链
    找到的那一个，不插值）。
    """
    from scipy.spatial import cKDTree

    tri = vertices[faces]
    face_comp = vertex_comp[faces[:, 0]]
    tree = cKDTree(tri.mean(axis=1))
    k = min(k, len(faces))
    _, cand = tree.query(points, k=k)
    cand = np.asarray(cand).reshape(len(points), k)
    a, b, c = tri[cand, 0], tri[cand, 1], tri[cand, 2]  # (P, k, 3)
    p = points[:, None, :]
    e0, e1, v2 = b - a, c - a, p - a
    d00 = (e0 * e0).sum(-1)
    d01 = (e0 * e1).sum(-1)
    d11 = (e1 * e1).sum(-1)
    d20 = (v2 * e0).sum(-1)
    d21 = (v2 * e1).sum(-1)
    den = d00 * d11 - d01 * d01
    den = np.where(np.abs(den) > 1e-30, den, 1.0)
    w1 = (d11 * d20 - d01 * d21) / den
    w2 = (d00 * d21 - d01 * d20) / den
    w = np.clip(np.stack([1.0 - w1 - w2, w1, w2], -1), 0.0, None)
    w /= np.maximum(w.sum(-1, keepdims=True), 1e-30)
    q = (w[..., None] * np.stack([a, b, c], -2)).sum(-2)
    dist = np.linalg.norm(q - p, axis=-1)
    dist = np.where(face_comp[cand] == comps[:, None], dist, np.inf)
    best = np.argmin(dist, axis=1)
    rows = np.arange(len(points))
    found = np.isfinite(dist[rows, best])
    f = cand[rows, best]
    wb = w[rows, best]
    out = []
    for attr in attrs:
        vals = (attr[faces[f]] * wb[:, :, None]).sum(1)
        if not found.all():
            vals[~found] = attr[fallback[~found]]
        out.append(vals)
    return out


def simplified(model: SourceModel, max_triangles: int) -> SourceModel:
    """全部图元一起减到上限以内，每个面保留自己的材质（见模块说明第 3 步）。没超过上限时原样返回。"""
    from .webmodel import _components

    if model.triangles <= max_triangles:
        return model
    verts, faces, face_mat = model.merged()
    n = len(verts)
    uv = np.zeros((n, 2))
    normals = np.zeros((n, 3))
    colors = np.ones((n, 4))
    has_uv = np.zeros(n, bool)
    has_colors = any(p.colors is not None for p in model.primitives)
    base = 0
    for p in model.primitives:
        sl = slice(base, base + len(p.positions))
        if p.uv is not None:
            uv[sl] = p.uv
            has_uv[sl] = True
        normals[sl] = p.normals if p.normals is not None else smooth_normals(p.positions, p.faces)
        if p.colors is not None:
            colors[sl] = p.colors
        base += len(p.positions)
    src, pos_v, attr_v = simplify_corners(verts, faces, uv, max_triangles)
    comp = _components(n, faces)
    # 角的属性取自的顶点与角的位置不在同一处时，改按位置从原网格的同一块上插值（transfer_attributes）
    moved = np.any(verts[attr_v] != verts[pos_v], axis=-1)
    key = np.where(moved, -1 - comp[attr_v], attr_v)
    prims: list[Primitive] = []
    for mi in sorted(set(face_mat[src].tolist())):
        rows = face_mat[src] == mi
        pairs, first, inverse = np.unique(
            np.stack([pos_v[rows].reshape(-1), key[rows].reshape(-1)], 1),
            axis=0,
            return_index=True,
            return_inverse=True,
        )
        a = np.maximum(pairs[:, 1], 0)
        p_uv, p_normals, p_colors = uv[a].copy(), normals[a].copy(), colors[a].copy()
        far = pairs[:, 1] < 0
        if far.any():
            t_uv, t_n, t_c = transfer_attributes(
                verts[pairs[far, 0]],
                -1 - pairs[far, 1],
                verts,
                faces,
                comp,
                [uv, normals, colors],
                attr_v[rows].reshape(-1)[first[far]],
            )
            p_uv[far] = t_uv
            p_normals[far] = t_n / np.maximum(np.linalg.norm(t_n, axis=1, keepdims=True), 1e-12)
            p_colors[far] = t_c
        textured = bool(has_uv[np.maximum(pairs[:, 1], 0)][~far].all()) and bool(
            has_uv[faces[src[rows]].reshape(-1)].all()
        )
        prims.append(
            Primitive(
                positions=verts[pairs[:, 0]],
                faces=inverse.reshape(-1, 3).astype(np.int64),
                material=mi,
                normals=p_normals,
                uv=p_uv if textured else None,
                colors=p_colors if has_colors else None,
            )
        )
    return SourceModel(prims, model.materials, model.images)


# ---------------------------------------------------------------------------- 写 glb


def _decode_image(data: bytes, alpha: bool, max_pixels: int) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
        w, h = img.size
        if w * h > max_pixels:
            raise InputRejected(f"贴图 {w}×{h} 超过像素上限 {max_pixels}")
        img.load()
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise InputRejected(f"贴图读不了：{error}") from error
    has_alpha = "A" in img.getbands() or (img.mode == "P" and "transparency" in img.info)
    return img.convert("RGBA" if alpha and has_alpha else "RGB")


def _resize(img: Image.Image, scale: float) -> Image.Image:
    if scale >= 1.0:
        return img
    w, h = img.size
    size = (max(1, round(w * scale)), max(1, round(h * scale)))
    factor = int(1 / scale)
    if factor >= 2 and w % factor == 0 and h % factor == 0 and (w // factor, h // factor) == size:
        return img.reduce(factor)
    return img.resize(size, Image.Resampling.LANCZOS)


def _encode(img: Image.Image) -> tuple[bytes, str]:
    buf = io.BytesIO()
    if img.mode == "RGBA" and np.asarray(img)[..., 3].min() < 255:
        img.save(buf, format="PNG", optimize=True)
        return buf.getvalue(), "image/png"
    img.convert("RGB").save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=False)
    return buf.getvalue(), "image/jpeg"


def texture_scales(sizes: list[tuple[int, int]], max_side: int, max_pixels: int) -> list[float]:
    """每张贴图的缩放：先各自缩到边长上限以内，合计像素还超过上限就一起按比例再缩（只缩不放）。"""
    scales = [min(1.0, max_side / max(w, h)) for w, h in sizes]
    total = sum(w * h * s * s for (w, h), s in zip(sizes, scales, strict=True))
    if total > max_pixels:
        k = math.sqrt(max_pixels / total) * 0.999
        scales = [s * k for s in scales]
    return scales


class _GlbWriter:
    def __init__(self) -> None:
        self.chunks: list[bytes] = []
        self.offset = 0
        self.views: list[dict] = []
        self.accessors: list[dict] = []

    def view(self, data: bytes, target: int | None) -> int:
        pad = (-self.offset) % 4
        if pad:
            self.chunks.append(b"\x00" * pad)
            self.offset += pad
        entry: dict[str, Any] = {"buffer": 0, "byteOffset": self.offset, "byteLength": len(data)}
        if target is not None:
            entry["target"] = target
        self.chunks.append(data)
        self.offset += len(data)
        self.views.append(entry)
        return len(self.views) - 1

    def accessor(
        self, arr: np.ndarray, component: int, kind: str, target: int, *, bounds=False, normalized=False
    ) -> int:
        entry: dict[str, Any] = {
            "bufferView": self.view(np.ascontiguousarray(arr).tobytes(), target),
            "componentType": component,
            "count": len(arr),
            "type": kind,
        }
        if normalized:
            entry["normalized"] = True
        if bounds:
            entry["min"] = [float(v) for v in arr.min(axis=0)]
            entry["max"] = [float(v) for v in arr.max(axis=0)]
        self.accessors.append(entry)
        return len(self.accessors) - 1


def write_model_glb(
    model: SourceModel,
    *,
    max_texture_side: int,
    max_texture_pixels: int,
    source_triangles: int,
    max_decode_pixels: int,
) -> ExportedModel:
    """（已烘焙、已减面的）模型写成 glb，原点放在包围盒的底面中心（见模块说明第 4、5 步）。"""
    prims = [p for p in model.primitives if len(p.faces)]
    lo, hi = model.bounds()
    origin = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2])
    # 同一个材质的图元并在一起；材质按（导出后的内容）去重
    groups: dict[str, list[Primitive]] = {}
    order: list[str] = []
    for p in prims:
        key = model.materials[p.material].key()
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(p)
    # 贴图：用到的图片按编号逐张解码、缩放、编码；同一张图被几个材质用只存一次
    used = sorted({model.materials[groups[k][0].material].image for k in order} - {None})
    alpha_of = {
        i: any(
            model.materials[groups[k][0].material].image == i
            and model.materials[groups[k][0].material].alpha_mode != "OPAQUE"
            for k in order
        )
        for i in used
    }
    decoded = {i: _decode_image(model.images[i], alpha_of[i], max_decode_pixels) for i in used}
    scales = texture_scales([decoded[i].size for i in used], max_texture_side, max_texture_pixels)
    w = _GlbWriter()
    images: list[dict] = []
    image_index: dict[int, int] = {}
    tex_sizes: list[list[int]] = []
    for i, scale in zip(used, scales, strict=True):
        img = _resize(decoded[i], scale)
        data, mime = _encode(img)
        images.append({"bufferView": w.view(data, None), "mimeType": mime})
        image_index[i] = len(images) - 1
        tex_sizes.append([img.size[0], img.size[1]])
    samplers: list[dict] = []
    textures: list[dict] = []
    texture_index: dict[tuple, int] = {}

    def texture_of(image: int, wrap: tuple[int, int]) -> int:
        key = (image, wrap)
        if key not in texture_index:
            sampler = {"magFilter": 9729, "minFilter": 9987, "wrapS": wrap[0], "wrapT": wrap[1]}
            if sampler not in samplers:
                samplers.append(sampler)
            textures.append({"sampler": samplers.index(sampler), "source": image_index[image]})
            texture_index[key] = len(textures) - 1
        return texture_index[key]

    materials: list[dict] = []
    primitives: list[dict] = []
    uses_unlit = False
    all_pos, all_faces, base_index = [], [], 0
    for key in order:
        group = groups[key]
        mat = model.materials[group[0].material]
        textured = mat.image is not None and all(p.uv is not None for p in group)
        pbr: dict[str, Any] = {
            "baseColorFactor": [round(float(c), 6) for c in mat.base_color],
            "metallicFactor": 0.0,
            "roughnessFactor": round(float(mat.roughness), 4),
        }
        if textured:
            pbr["baseColorTexture"] = {"index": texture_of(mat.image, mat.wrap)}
        entry: dict[str, Any] = {"pbrMetallicRoughness": pbr}
        if mat.alpha_mode != "OPAQUE":
            entry["alphaMode"] = mat.alpha_mode
            if mat.alpha_mode == "MASK":
                entry["alphaCutoff"] = round(float(mat.alpha_cutoff), 4)
        if mat.double_sided:
            entry["doubleSided"] = True
        if any(mat.emissive):
            entry["emissiveFactor"] = [round(float(c), 6) for c in mat.emissive]
        if mat.unlit:
            entry["extensions"] = {"KHR_materials_unlit": {}}
            uses_unlit = True
        materials.append(entry)
        positions = np.concatenate([p.positions for p in group]) - origin
        offsets = np.cumsum([0] + [len(p.positions) for p in group[:-1]])
        faces = np.concatenate([p.faces + o for p, o in zip(group, offsets, strict=True)])
        normals = np.concatenate(
            [p.normals if p.normals is not None else smooth_normals(p.positions, p.faces) for p in group]
        )
        pos32 = positions.astype(np.float32)
        attrs = {
            "POSITION": w.accessor(pos32, 5126, "VEC3", 34962, bounds=True),
            "NORMAL": w.accessor(normals.astype(np.float32), 5126, "VEC3", 34962),
        }
        if textured:
            attrs["TEXCOORD_0"] = w.accessor(
                np.concatenate([p.uv for p in group]).astype(np.float32), 5126, "VEC2", 34962
            )
        if any(p.colors is not None for p in group):
            cols = np.concatenate(
                [p.colors if p.colors is not None else np.ones((len(p.positions), 4)) for p in group]
            )
            attrs["COLOR_0"] = w.accessor(
                np.clip(np.round(cols * 255), 0, 255).astype(np.uint8), 5121, "VEC4", 34962, normalized=True
            )
        if len(positions) < 65536:
            index_arr, component = faces.astype(np.uint16).reshape(-1), 5123
        else:
            index_arr, component = faces.astype(np.uint32).reshape(-1), 5125
        primitives.append(
            {
                "attributes": attrs,
                "indices": w.accessor(index_arr, component, "SCALAR", 34963),
                "material": len(materials) - 1,
            }
        )
        all_pos.append(pos32.astype(np.float64))
        all_faces.append(faces + base_index)
        base_index += len(positions)
    doc: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": "metaverse-recon models"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "model"}],
        "meshes": [{"name": "model", "primitives": primitives}],
        "materials": materials,
        "accessors": w.accessors,
        "bufferViews": w.views,
        "buffers": [{"byteLength": w.offset}],
    }
    if images:
        doc["images"] = images
        doc["samplers"] = samplers
        doc["textures"] = textures
    if uses_unlit:
        doc["extensionsUsed"] = ["KHR_materials_unlit"]
    data = _glb_bytes(doc, b"".join(w.chunks))
    positions = np.concatenate(all_pos)
    return ExportedModel(
        data=data,
        triangles=sum(len(p.faces) for p in prims),
        vertices=len(positions),
        source_triangles=int(source_triangles),
        materials=len(materials),
        textures=tex_sizes,
        bounds={"min": positions.min(axis=0).tolist(), "max": positions.max(axis=0).tolist()},
        origin=origin.tolist(),
        positions=positions,
        faces=np.concatenate(all_faces),
    )


def _glb_bytes(doc: dict, binary: bytes) -> bytes:
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    text += b" " * ((-len(text)) % 4)
    binary += b"\x00" * ((-len(binary)) % 4)
    total = 12 + 8 + len(text) + 8 + len(binary)
    return (
        struct.pack("<III", 0x46546C67, 2, total)
        + struct.pack("<II", len(text), 0x4E4F534A)
        + text
        + struct.pack("<II", len(binary), 0x004E4942)
        + binary
    )


# ---------------------------------------------------------------------------- 总流程


def export_model(
    model: SourceModel,
    *,
    linear: np.ndarray | None = None,
    tint: Any = None,
    max_triangles: int,
    max_texture_side: int,
    max_texture_pixels: int,
    max_decode_pixels: int,
    coord_limit: float | None = MAX_MODEL_COORD,
) -> ExportedModel:
    """烘焙摆放 → 减面 → 写 glb（模块说明第 2–5 步）。"""
    placed = placed_model(model, np.eye(3) if linear is None else linear, tint, coord_limit=coord_limit)
    source_triangles = placed.triangles
    reduced = simplified(placed, max_triangles)
    return write_model_glb(
        reduced,
        max_texture_side=max_texture_side,
        max_texture_pixels=max_texture_pixels,
        source_triangles=source_triangles,
        max_decode_pixels=max_decode_pixels,
    )


def variant_key(source: str, linear: np.ndarray, tint: Any, limits: dict[str, int]) -> str:
    """同一个导出结果的键：来源、烘进模型的线性变换、调色、导出上限（偏航不算：写进物件的 transform）。"""
    payload = {
        "source": source,
        "linear": [round(float(v), 9) for v in np.asarray(linear, np.float64).reshape(-1)],
        "tint": list(tint) if tint is not None else None,
        "limits": dict(sorted(limits.items())),
        "v": 1,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


__all__ = [
    "MAX_MODEL_COORD",
    "ExportedModel",
    "Material",
    "Primitive",
    "SourceModel",
    "export_model",
    "placed_model",
    "read_gltf",
    "read_model",
    "simplified",
    "simplify_corners",
    "smooth_normals",
    "texture_scales",
    "variant_key",
    "write_model_glb",
]
