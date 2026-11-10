"""扫描加载与对齐（设计 6.2，验证见 `spikes/voxelize/voxelize.py`、`spikes/parametric/common.py`）。

- **贴图坐标原点在左上角**（Scaniverse 和 glTF 都是图片坐标习惯）：纹素 = (u·W, v·H)。
  这里统一用这个约定；用 trimesh 读进来的 glb/obj（trimesh 内部是左下角原点）会翻转 v。
- **对齐**（首次扫描）：
  1. 按近似竖直的面（墙）的水平法线方向，模 90° 做面积加权直方图，取峰值，绕竖直轴旋转让墙和网格轴对齐；
  2. 地面取旋转后 y 的 1% 分位数，平移到 y = 0；
  3. 原点定在 x、z 的最小角。
  结果是一个 4×4 变换（扫描坐标 → 空间坐标），按列主序存进提交的 `scan.transform`。
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import struct
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image
from scipy import ndimage

from ..errors import InputRejected

_GLB_BIN = 0x004E4942
_IMAGE_HEAD_BYTES = 1 << 20  # 读图片尺寸只需要文件头


def guard_pixels(max_pixels: int) -> None:
    """让 PIL 自带的解压炸弹检查兜底：像素超过上限两倍的图片在 `Image.open` 时就报错，不会解码。

    像素上限首先由我们自己在解码前按文件头检查（`inspect_image`、`inspect_glb`）；这里防的是漏网的路径，
    例如第三方库在内部打开的贴图。`Image.MAX_IMAGE_PIXELS` 是进程级的值；解析都在子进程里做，每个子进程
    只跑一个任务，所以按本次任务的上限设置。不能设成 None（那样 PIL 的检查就被关掉了）。
    """
    Image.MAX_IMAGE_PIXELS = max(1, int(max_pixels))


def image_dimensions(source: Any, what: str = "贴图") -> tuple[int, int]:
    """只读文件头取图片尺寸（不解码）。`source` 是路径或文件对象；认不出、或大到 PIL 拒绝打开都算不合规。"""
    try:
        with Image.open(source) as img:
            return img.size
    except Image.DecompressionBombError as error:
        raise InputRejected(f"{what}像素超过上限：{error}") from error
    except Exception as error:
        raise InputRejected(f"{what}无法识别：{error}") from error


def check_pixels(width: int, height: int, max_pixels: int) -> None:
    if width * height > max_pixels:
        raise InputRejected(f"贴图像素 {width}×{height} 超过上限 {max_pixels}")


@dataclass
class ScanMesh:
    """三角网格 + 可选的贴图。`uv` 是左上角原点；`texture` 是 (H, W, 3) uint8。"""

    vertices: np.ndarray  # (N, 3) float64
    faces: np.ndarray  # (M, 3) int64
    uv: np.ndarray | None = None  # (N, 2) float64
    texture: np.ndarray | None = None

    def transformed(self, matrix: np.ndarray) -> ScanMesh:
        return ScanMesh(apply_matrix(self.vertices, matrix), self.faces, self.uv, self.texture)

    @property
    def triangle_count(self) -> int:
        return len(self.faces)


# ---------------------------------------------------------------------------- 格式与解析前检查


def sniff_format(head: bytes) -> str | None:
    if head.startswith(b"DRACO"):
        return "draco"
    if head.startswith(b"glTF"):
        return "glb"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    text = head.lstrip()[:2]
    if text in (b"v ", b"# ", b"o ", b"mt", b"g ", b"vt", b"vn", b"us", b"s ", b"f "):
        return "obj"
    return None


def sniff_file(path: str) -> str | None:
    with open(path, "rb") as fh:
        return sniff_format(fh.read(64))


def inspect_image(path: str, max_pixels: int) -> tuple[int, int]:
    """只读文件头取尺寸（不解码），超过像素上限就拒绝。"""
    w, h = image_dimensions(path)
    check_pixels(w, h, max_pixels)
    return w, h


def decoded_image(image: Any, max_pixels: int, mode: str) -> np.ndarray:
    """把第三方库打开的图片（`Image.open` 只读了文件头）解码成数组；解码前先按尺寸检查像素上限。"""
    w, h = image.size
    check_pixels(w, h, max_pixels)
    return np.asarray(image.convert(mode))


def _base64_uri(uri: Any, what: str) -> bytes:
    """与 trimesh 相同的判断：含 `base64,` 的 uri 按 base64 解码；其他 uri 指向外部文件，一律拒绝。"""
    if not isinstance(uri, str):
        raise InputRejected(f"glb 里{what}的 uri 不合法")
    index = uri.find("base64,")
    if index < 0:
        raise InputRejected(f"glb 里{what}引用了外部文件，只接受内嵌的数据")
    try:
        return base64.b64decode(uri[index + 7 :])
    except (binascii.Error, ValueError) as error:
        raise InputRejected(f"glb 里{what}的 base64 数据不合法：{error}") from error


def _index(value: Any, size: int, what: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value < size:
        raise InputRejected(f"glb 里{what}的编号不合法")
    return value


def _glb_image_head(
    path: str, image: dict[str, Any], doc: dict[str, Any], bin_offset: int, bin_len: int
) -> bytes | None:
    """一张贴图的开头（最多 1MB，够读尺寸）。取数据的位置与 trimesh 加载时相同：

    - 有 `bufferView`：所在数据块写了 `uri` 的按 base64 解码；没写的只能是第一个数据块，即 glb 的 BIN 块；
    - 只有 `uri`：按 base64 解码（`data:` 内嵌）；
    - 两样都没有：trimesh 会跳过这张图，返回 None。

    指向外部文件、或者我们找不到对应位置的贴图都直接拒绝：检查不了尺寸的贴图不能交给解码。
    """
    if "bufferView" in image:
        views = doc.get("bufferViews") or []
        view = views[_index(image["bufferView"], len(views), "贴图的 bufferView")]
        buffers = doc.get("buffers") or []
        buffer_index = _index(view.get("buffer"), len(buffers), "bufferView 的数据块")
        start = view.get("byteOffset", 0)
        length = view.get("byteLength", 0)
        if not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in (start, length)):
            raise InputRejected("glb 里贴图的 bufferView 范围不合法")
        buffer = buffers[buffer_index]
        if "uri" in buffer:
            data = _base64_uri(buffer["uri"], "数据块")
            if start + length > len(data):
                raise InputRejected("glb 里的贴图超出了数据块")
            return data[start : start + min(length, _IMAGE_HEAD_BYTES)]
        if buffer_index != 0:
            raise InputRejected("glb 里只有第一个数据块可以不写 uri")
        if start + length > bin_len:
            raise InputRejected("glb 里的贴图超出了数据块")
        with open(path, "rb") as fh:
            fh.seek(bin_offset + start)
            return fh.read(min(length, _IMAGE_HEAD_BYTES))
    if "uri" in image:
        return _base64_uri(image["uri"], "贴图")[:_IMAGE_HEAD_BYTES]
    return None


def inspect_glb(path: str, max_triangles: int, max_pixels: int) -> int:
    """读 glb 的 JSON 块，按访问器数量估算三角形数；每张贴图的尺寸在解码前读文件头检查。

    贴图内嵌在 BIN 块、`data:` 数据块还是 `data:` 图片里都要检查；引用外部文件的直接拒绝。
    """
    with open(path, "rb") as fh:
        header = fh.read(20)
        if len(header) < 20:
            raise InputRejected("glb 文件太短")
        magic, version, _length, json_len, json_type = struct.unpack("<4sIIII", header)
        if magic != b"glTF" or version != 2 or json_type != 0x4E4F534A:
            raise InputRejected("不是 glTF 2.0 的 glb 文件")
        if json_len > 64 << 20:
            raise InputRejected("glb 的 JSON 块过大")
        try:
            doc = json.loads(fh.read(json_len))
        except ValueError as error:
            raise InputRejected(f"glb 的 JSON 块不合法：{error}") from error
        if not isinstance(doc, dict):
            raise InputRejected("glb 的 JSON 块不是对象")
        bin_header = fh.read(8)
        bin_offset = 20 + json_len + 8
        bin_len = 0
        if len(bin_header) == 8:
            bin_len, bin_type = struct.unpack("<II", bin_header)
            # trimesh 把第一个没写 uri 的数据块对到 JSON 之后的那个块；这里读贴图的位置必须和它一致
            if bin_type != _GLB_BIN:
                raise InputRejected("glb 的 JSON 块之后不是 BIN 数据块")
    if "KHR_draco_mesh_compression" in (doc.get("extensionsRequired") or []):
        raise InputRejected("暂不支持 Draco 压缩的 glb，请上传 .drc + 贴图或未压缩的 glb")
    accessors = doc.get("accessors") or []
    triangles = 0
    for mesh in doc.get("meshes") or []:
        for prim in mesh.get("primitives") or []:
            mode = prim.get("mode", 4)
            if mode != 4:
                continue
            idx = prim.get("indices")
            if idx is not None:
                triangles += int(accessors[idx].get("count", 0)) // 3
            else:
                pos = (prim.get("attributes") or {}).get("POSITION")
                if pos is not None:
                    triangles += int(accessors[pos].get("count", 0)) // 3
    if triangles > max_triangles:
        raise InputRejected(f"三角形数 {triangles} 超过上限 {max_triangles}")
    for image in doc.get("images") or []:
        if not isinstance(image, dict):
            raise InputRejected("glb 里的贴图记录不合法")
        head = _glb_image_head(path, image, doc, bin_offset, bin_len)
        if head is None:
            continue
        w, h = image_dimensions(io.BytesIO(head), "glb 里的贴图")
        check_pixels(w, h, max_pixels)
    return triangles


# ---------------------------------------------------------------------------- 加载


def _load_texture(path: str | None, max_pixels: int) -> np.ndarray | None:
    if path is None:
        return None
    inspect_image(path, max_pixels)
    with Image.open(path) as img:
        return decoded_image(img, max_pixels, "RGB")


def load_draco(path: str, max_triangles: int) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    import DracoPy

    with open(path, "rb") as fh:
        mesh = DracoPy.decode(fh.read())
    faces = np.asarray(mesh.faces, np.int64).reshape(-1, 3)
    if len(faces) > max_triangles:
        raise InputRejected(f"三角形数 {len(faces)} 超过上限 {max_triangles}")
    vertices = np.asarray(mesh.points, np.float64).reshape(-1, 3)
    uv = getattr(mesh, "tex_coord", None)
    uv = None if uv is None or len(uv) == 0 else np.asarray(uv, np.float64).reshape(-1, 2)
    return vertices, faces, uv


def _from_trimesh(path: str, fmt: str, max_triangles: int, max_pixels: int) -> ScanMesh:
    import trimesh

    loaded = trimesh.load(path, file_type=fmt, process=False, force="mesh")
    if not isinstance(loaded, trimesh.Trimesh):
        raise InputRejected("模型里没有三角网格")
    if len(loaded.faces) > max_triangles:
        raise InputRejected(f"三角形数 {len(loaded.faces)} 超过上限 {max_triangles}")
    uv = None
    texture = None
    visual = loaded.visual
    if isinstance(visual, trimesh.visual.TextureVisuals) and visual.uv is not None:
        uv = np.asarray(visual.uv, np.float64).copy()
        uv[:, 1] = 1.0 - uv[:, 1]  # trimesh 内部是左下角原点
        image = getattr(visual.material, "baseColorTexture", None) or getattr(visual.material, "image", None)
        if image is not None:
            texture = decoded_image(image, max_pixels, "RGB")
    return ScanMesh(np.asarray(loaded.vertices, np.float64), np.asarray(loaded.faces, np.int64), uv, texture)


def load_scan(
    mesh_path: str,
    texture_path: str | None = None,
    *,
    max_triangles: int = 5_000_000,
    max_texture_pixels: int = 8192 * 8192,
) -> ScanMesh:
    """读扫描模型：`.drc`（+ 单独的贴图）、`.glb`（内嵌贴图）或 `.obj`。

    单独给的贴图在加载模型之前就检查：obj 的材质可能引用同一张图，trimesh 加载模型时就会打开它。
    """
    guard_pixels(max_texture_pixels)
    if texture_path is not None:
        inspect_image(texture_path, max_texture_pixels)
    fmt = sniff_file(mesh_path)
    if fmt == "draco":
        vertices, faces, uv = load_draco(mesh_path, max_triangles)
        texture = _load_texture(texture_path, max_texture_pixels)
        mesh = ScanMesh(vertices, faces, uv, texture)
    elif fmt == "glb":
        inspect_glb(mesh_path, max_triangles, max_texture_pixels)
        mesh = _from_trimesh(mesh_path, "glb", max_triangles, max_texture_pixels)
        if texture_path is not None:
            mesh.texture = _load_texture(texture_path, max_texture_pixels)
    elif fmt == "obj":
        mesh = _from_trimesh(mesh_path, "obj", max_triangles, max_texture_pixels)
        if texture_path is not None:
            mesh.texture = _load_texture(texture_path, max_texture_pixels)
    else:
        raise InputRejected("扫描模型格式不认识（支持 drc、glb、obj）")
    if len(mesh.faces) == 0:
        raise InputRejected("模型没有三角面")
    if mesh.faces.min() < 0 or mesh.faces.max() >= len(mesh.vertices):
        raise InputRejected("三角面引用了不存在的顶点")
    if not np.all(np.isfinite(mesh.vertices)):
        raise InputRejected("顶点坐标含非有限值")
    if mesh.uv is not None and len(mesh.uv) != len(mesh.vertices):
        mesh.uv = None
    return mesh


# ---------------------------------------------------------------------------- 对齐


@dataclass(frozen=True)
class Alignment:
    rotation_deg: float  # 绕 y 轴的旋转（度）
    matrix: np.ndarray  # 4×4，扫描坐标 → 空间坐标
    floor_y: float  # 旋转后、平移前的地面高度
    size: tuple[float, float, float]  # 对齐后的范围（米）

    def column_major(self) -> list[float]:
        return [float(v) for v in self.matrix.T.reshape(-1)]


def face_normals(vertices: np.ndarray, faces: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    a, b, c = vertices[faces[:, 0]], vertices[faces[:, 1]], vertices[faces[:, 2]]
    cross = np.cross(b - a, c - a)
    area2 = np.linalg.norm(cross, axis=1)
    return cross / np.maximum(area2[:, None], 1e-12), area2 / 2


def wall_rotation(vertices: np.ndarray, faces: np.ndarray) -> float:
    """墙面主方向：近似竖直的面的水平法线角度模 90°，面积加权直方图（360 格，±2 格平滑）的峰值。返回弧度。"""
    normals, area = face_normals(vertices, faces)
    horiz = np.abs(normals[:, 1]) < 0.3
    if not np.any(horiz):
        return 0.0
    ang4 = np.mod(np.arctan2(normals[horiz, 2], normals[horiz, 0]), np.pi / 2)
    weights = area[horiz]
    hist, edges = np.histogram(ang4, bins=360, range=(0, np.pi / 2), weights=weights)
    hist = ndimage.uniform_filter1d(hist, 5, mode="wrap")
    k = int(np.argmax(hist))
    peak = (edges[k] + edges[k + 1]) / 2
    # 直方图格子宽 0.25°：再用峰值 ±1.5° 内法线角度的加权圆周平均精化（周期 90°，所以乘 4 再取平均）。
    near = np.abs(np.mod(ang4 - peak + np.pi / 4, np.pi / 2) - np.pi / 4) < np.radians(1.5)
    if near.any():
        w = weights[near]
        mean4 = np.arctan2((np.sin(4 * ang4[near]) * w).sum(), (np.cos(4 * ang4[near]) * w).sum()) / 4
        peak = float(np.mod(mean4, np.pi / 2))
    # 与验证代码一致：峰值在 [0°, 90°)，旋转 −峰值（前厅实测约 −61°，坐标轴与验证结果相同）。
    return -peak


def rotation_y(theta: float) -> np.ndarray:
    """与验证代码相同的绕 y 旋转：x' = x·cos − z·sin，z' = x·sin + z·cos。"""
    cs, sn = np.cos(theta), np.sin(theta)
    return np.array([[cs, 0, -sn], [0, 1, 0], [sn, 0, cs]])


def compute_alignment(vertices: np.ndarray, faces: np.ndarray) -> Alignment:
    theta = wall_rotation(vertices, faces)
    rot = rotation_y(theta)
    rotated = vertices @ rot.T
    floor_y = float(np.percentile(rotated[:, 1], 1))
    rotated[:, 1] -= floor_y
    lo = rotated.min(axis=0)
    translation = np.array([-lo[0], -floor_y, -lo[2]])
    matrix = np.eye(4)
    matrix[:3, :3] = rot
    matrix[:3, 3] = translation
    aligned_max = rotated.max(axis=0) - np.array([lo[0], 0, lo[2]])
    return Alignment(
        float(np.degrees(theta)),
        matrix,
        floor_y,
        (float(aligned_max[0]), float(aligned_max[1]), float(aligned_max[2])),
    )


def apply_matrix(vertices: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    return vertices @ matrix[:3, :3].T + matrix[:3, 3]


def matrix_from_column_major(values) -> np.ndarray:
    arr = np.asarray(values, np.float64)
    if arr.shape != (16,) or not np.all(np.isfinite(arr)):
        raise InputRejected("scan.transform 必须是 16 个有限数字")
    return arr.reshape(4, 4).T


# ---------------------------------------------------------------------------- 表面采样


def sample_surface(mesh: ScanMesh, density: float, seed: int = 0):
    """面积加权的表面采样（每平方米约 density 个点）。

    返回 (点 (K,3), 颜色 uint8 (K,3)，没有贴图时为灰色, 单位法线 (K,3), 所在三角面 (K,))。
    """
    V, F = mesh.vertices, mesh.faces
    normals, area = face_normals(V, F)
    rng = np.random.default_rng(seed)
    counts = rng.poisson(area * density)
    idx = np.repeat(np.arange(len(F)), counts)
    r1, r2 = rng.random(len(idx)), rng.random(len(idx))
    s = np.sqrt(r1)
    w0, w1, w2 = 1 - s, s * (1 - r2), s * r2
    f = F[idx]
    points = V[f[:, 0]] * w0[:, None] + V[f[:, 1]] * w1[:, None] + V[f[:, 2]] * w2[:, None]
    colors = texture_lookup(mesh, f, w0, w1, w2)
    return points, colors, normals[idx], idx


def texture_lookup(mesh: ScanMesh, f: np.ndarray, w0, w1, w2) -> np.ndarray:
    """按重心坐标插值贴图坐标再取色（左上角原点）。没有贴图时返回中灰。"""
    if mesh.uv is None or mesh.texture is None:
        return np.full((len(f), 3), 160, np.uint8)
    UV, tex = mesh.uv, mesh.texture
    H, W = tex.shape[:2]
    t = UV[f[:, 0]] * w0[:, None] + UV[f[:, 1]] * w1[:, None] + UV[f[:, 2]] * w2[:, None]
    px = np.clip((t[:, 0] * W).astype(np.int64), 0, W - 1)
    py = np.clip((t[:, 1] * H).astype(np.int64), 0, H - 1)
    return tex[py, px]
