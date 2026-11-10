"""重建工作台的公共部分：范围、扫描 glb 读写与裁剪、地面高度与高度图、表面采样、二维图底板、图片输出。

扫描 `scan.glb` 是 `prepare` 输出的对齐后扫描（空间坐标：米，y 向上，与处理服务 `scan_import` 相同）。
"""

from __future__ import annotations

import functools
import io
import json
import math
import os
import struct
import sys
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .env import find_font


class ReconError(SystemExit):
    """命令行可以直接报给用户的错误（退出码 2）。"""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def r(v, d: int = 4):
    """数字或数组按 d 位小数取整（JSON 输出用）。"""
    if isinstance(v, list | tuple | np.ndarray):
        return [r(x, d) for x in v]
    if v is None:
        return None
    f = round(float(v), d)
    return 0.0 if f == 0 else f


def write_json(path: str, data) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
        fh.write("\n")


def read_json(path: str):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError as e:
        raise ReconError(f"找不到文件 {path}") from e
    except json.JSONDecodeError as e:
        raise ReconError(f"{path} 不是合法的 JSON：{e}") from e


# ---------------------------------------------------------------------------- 范围


@dataclass
class Box:
    lo: np.ndarray
    hi: np.ndarray

    @property
    def size(self) -> np.ndarray:
        return self.hi - self.lo

    @property
    def center(self) -> np.ndarray:
        return (self.lo + self.hi) / 2

    def grow(self, m: float) -> Box:
        return Box(self.lo - m, self.hi + m)

    def contains(self, P: np.ndarray) -> np.ndarray:
        return np.all((self.lo <= P) & (self.hi >= P), axis=1)

    def as_dict(self) -> dict:
        return {"min": r(self.lo), "max": r(self.hi)}

    @staticmethod
    def of(bounds: dict) -> Box:
        return Box(np.array(bounds["min"], float), np.array(bounds["max"], float))

    def union(self, other: Box) -> Box:
        return Box(np.minimum(self.lo, other.lo), np.maximum(self.hi, other.hi))


def parse_box(text: str) -> Box:
    """`x0,y0,z0,x1,y1,z1` 或 `{"min":[..],"max":[..]}`。"""
    text = text.strip()
    if text.startswith("{"):
        d = json.loads(text)
        lo, hi = np.array(d["min"], float), np.array(d["max"], float)
    else:
        try:
            v = [float(x) for x in text.replace(" ", ",").split(",") if x]
        except ValueError as e:
            raise ReconError(f"包围盒格式不对：{text}") from e
        if len(v) != 6:
            raise ReconError("包围盒需要 6 个数：x0,y0,z0,x1,y1,z1")
        lo, hi = np.array(v[:3]), np.array(v[3:])
    return Box(np.minimum(lo, hi), np.maximum(lo, hi))


# ---------------------------------------------------------------------------- 扫描


@dataclass
class Scan:
    V: np.ndarray  # (N,3) float64
    F: np.ndarray  # (M,3) int64
    UV: np.ndarray | None  # (N,2) glTF 约定（左上角原点）
    image: bytes | None  # 贴图原始字节（JPEG/PNG）
    mime: str = "image/jpeg"
    _tex: np.ndarray | None = field(default=None, repr=False)

    def texture(self) -> np.ndarray | None:
        if self._tex is None and self.image is not None:
            Image.MAX_IMAGE_PIXELS = 1 << 28
            with Image.open(io.BytesIO(self.image)) as im:
                self._tex = np.asarray(im.convert("RGB"))
        return self._tex


_DT = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
_NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(path: str) -> tuple[dict, bytes]:
    with open(path, "rb") as fh:
        b = fh.read()
    if len(b) < 12:
        raise ReconError(f"{path} 不是 glb")
    magic, _, _ = struct.unpack("<4sII", b[:12])
    if magic != b"glTF":
        raise ReconError(f"{path} 不是 glb")
    off, js, binb = 12, None, b""
    while off + 8 <= len(b):
        ln, typ = struct.unpack("<I4s", b[off : off + 8])
        chunk = b[off + 8 : off + 8 + ln]
        if typ == b"JSON":
            js = json.loads(chunk)
        elif typ == b"BIN\0":
            binb = chunk
        off += 8 + ln
    if js is None:
        raise ReconError(f"{path} 没有 JSON 块")
    return js, binb


def _accessor(js: dict, binb: bytes, i: int) -> np.ndarray:
    a = js["accessors"][i]
    v = js["bufferViews"][a["bufferView"]]
    n = _NC[a["type"]]
    dt = np.dtype(_DT[a["componentType"]])
    start = v.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = v.get("byteStride")
    if stride and stride != dt.itemsize * n:
        raw = np.frombuffer(binb, np.uint8, count=stride * a["count"], offset=start).reshape(
            a["count"], stride
        )
        return raw[:, : dt.itemsize * n].copy().view(dt).reshape(a["count"], n)
    return np.frombuffer(binb, dt, count=a["count"] * n, offset=start).reshape(a["count"], n)


def load_scan(path: str) -> Scan:
    """读对齐后的扫描 glb（单贴图；节点不能带变换）。多个图元会合并。"""
    if not os.path.exists(path):
        raise ReconError(f"找不到扫描 {path}（先运行 metaverse-recon prepare，或用 --base / --scan 指定）")
    js, binb = read_glb(path)
    Vs, Fs, UVs, off = [], [], [], 0
    image, mime = None, "image/jpeg"
    for node in js.get("nodes", []):
        if "mesh" not in node:
            continue
        if any(k in node for k in ("matrix", "translation", "rotation", "scale")):
            raise ReconError("扫描 glb 的节点带变换：工作台只用 prepare 输出的、已对齐到空间坐标的扫描")
        for prim in js["meshes"][node["mesh"]]["primitives"]:
            V = _accessor(js, binb, prim["attributes"]["POSITION"]).astype(np.float64)
            F = _accessor(js, binb, prim["indices"]).reshape(-1, 3).astype(np.int64)
            uv_i = prim["attributes"].get("TEXCOORD_0")
            UV = _accessor(js, binb, uv_i).astype(np.float64) if uv_i is not None else np.zeros((len(V), 2))
            Vs.append(V)
            Fs.append(F + off)
            UVs.append(UV)
            off += len(V)
            if image is None and "material" in prim:
                mat = js["materials"][prim["material"]]
                tex = mat.get("pbrMetallicRoughness", {}).get("baseColorTexture")
                if tex is not None:
                    img = js["images"][js["textures"][tex["index"]]["source"]]
                    bv = js["bufferViews"][img["bufferView"]]
                    s = bv.get("byteOffset", 0)
                    image = bytes(binb[s : s + bv["byteLength"]])
                    mime = img.get("mimeType", mime)
    if not Vs:
        raise ReconError("扫描 glb 里没有网格")
    return Scan(np.concatenate(Vs), np.concatenate(Fs), np.concatenate(UVs), image, mime)


def crop_scan(scan: Scan, box: Box) -> Scan:
    """保留至少一个顶点落在 box 里的三角形（精确裁剪交给渲染时的剖切平面）。"""
    inside = box.contains(scan.V)
    keep = inside[scan.F].any(axis=1)
    F = scan.F[keep]
    used = np.unique(F)
    remap = np.full(len(scan.V), -1, np.int64)
    remap[used] = np.arange(len(used))
    out = Scan(scan.V[used], remap[F], scan.UV[used] if scan.UV is not None else None, scan.image, scan.mime)
    out._tex = scan._tex
    return out


def glb_bytes(doc: dict, chunks: list[bytes]) -> bytes:
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    binary = b"".join(chunks)
    head = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(binary))
    return (
        head
        + struct.pack("<I4s", len(js), b"JSON")
        + js
        + struct.pack("<I4s", len(binary), b"BIN\0")
        + binary
    )


def write_scan_glb(scan: Scan, path: str) -> None:
    """扫描写成不打光、带原贴图的 glb。"""
    chunks: list[bytes] = []
    views: list[dict] = []
    acc: list[dict] = []
    offset = 0

    def view(data: bytes, target=None) -> int:
        nonlocal offset
        pad = (-len(data)) % 4
        v = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target:
            v["target"] = target
        views.append(v)
        chunks.append(data + b"\0" * pad)
        offset += len(data) + pad
        return len(views) - 1

    pos = scan.V.astype(np.float32)
    acc.append(
        {
            "bufferView": view(pos.tobytes(), 34962),
            "componentType": 5126,
            "count": len(pos),
            "type": "VEC3",
            "min": pos.min(0).tolist(),
            "max": pos.max(0).tolist(),
        }
    )
    prim: dict = {"attributes": {"POSITION": 0}, "material": 0}
    if scan.UV is not None:
        uv = scan.UV.astype(np.float32)
        acc.append(
            {"bufferView": view(uv.tobytes(), 34962), "componentType": 5126, "count": len(uv), "type": "VEC2"}
        )
        prim["attributes"]["TEXCOORD_0"] = 1
    idx = scan.F.astype(np.uint32).reshape(-1)
    acc.append(
        {"bufferView": view(idx.tobytes(), 34963), "componentType": 5125, "count": len(idx), "type": "SCALAR"}
    )
    prim["indices"] = len(acc) - 1
    pbr: dict = {"metallicFactor": 0.0, "roughnessFactor": 0.9}
    doc: dict = {
        "asset": {"version": "2.0", "generator": "metaverse-recon"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "scan", "mesh": 0}],
        "meshes": [{"primitives": [prim]}],
    }
    if scan.image is not None and scan.UV is not None:
        doc["images"] = [{"bufferView": view(scan.image), "mimeType": scan.mime}]
        doc["textures"] = [{"source": 0, "sampler": 0}]
        doc["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
        pbr["baseColorTexture"] = {"index": 0}
    doc["materials"] = [
        {"pbrMetallicRoughness": pbr, "doubleSided": True, "extensions": {"KHR_materials_unlit": {}}}
    ]
    doc["extensionsUsed"] = ["KHR_materials_unlit"]
    doc["accessors"] = acc
    doc["bufferViews"] = views
    doc["buffers"] = [{"byteLength": offset}]
    with open(path, "wb") as fh:
        fh.write(glb_bytes(doc, chunks))


def face_normals(V: np.ndarray, F: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    n = np.cross(b - a, c - a)
    ln = np.linalg.norm(n, axis=1)
    return n / np.maximum(ln, 1e-12)[:, None], ln / 2


def estimate_floor(scan: Scan, box: Box, ring: float = 0.4) -> float:
    """地面高度：包围盒外扩 ring 范围内、朝上的近水平三角形，按面积加权的高度中位数（只看包围盒底附近）。"""
    n, area = face_normals(scan.V, scan.F)
    cen = scan.V[scan.F].mean(axis=1)
    lo, hi = box.lo - ring, box.hi + ring
    m = (
        (n[:, 1] > 0.92)
        & (cen[:, 0] >= lo[0])
        & (cen[:, 0] <= hi[0])
        & (cen[:, 2] >= lo[2])
        & (cen[:, 2] <= hi[2])
        & (cen[:, 1] <= box.lo[1] + 0.12)
        & (cen[:, 1] >= box.lo[1] - 0.4)
    )
    if m.sum() < 20:
        return float(box.lo[1])
    y, w = cen[m, 1], area[m]
    order = np.argsort(y)
    cw = np.cumsum(w[order])
    return float(y[order][np.searchsorted(cw, cw[-1] / 2)])


def sample_points(scan: Scan, density: float, seed: int = 0):
    """面积加权表面采样：返回 (点, 颜色 uint8, 法线, 三角形编号)。颜色按贴图取（左上角原点的 UV）。"""
    n, area = face_normals(scan.V, scan.F)
    rng = np.random.default_rng(seed)
    counts = rng.poisson(area * density)
    idx = np.repeat(np.arange(len(scan.F)), counts)
    r1, r2 = rng.random(len(idx)), rng.random(len(idx))
    s = np.sqrt(r1)
    w0, w1, w2 = 1 - s, s * (1 - r2), s * r2
    f = scan.F[idx]
    P = scan.V[f[:, 0]] * w0[:, None] + scan.V[f[:, 1]] * w1[:, None] + scan.V[f[:, 2]] * w2[:, None]
    tex = scan.texture()
    if tex is None or scan.UV is None:
        C = np.full((len(f), 3), 160, np.uint8)
    else:
        UV = scan.UV
        t = UV[f[:, 0]] * w0[:, None] + UV[f[:, 1]] * w1[:, None] + UV[f[:, 2]] * w2[:, None]
        H, W = tex.shape[:2]
        px = np.clip((t[:, 0] * W).astype(np.int64), 0, W - 1)
        py = np.clip((t[:, 1] * H).astype(np.int64), 0, H - 1)
        C = tex[py, px]
    return P, C, n[idx], idx


# ---------------------------------------------------------------------------- 地面高度图


def floor_heightmap(scan: Scan, region: Box, floor_y: float, cell: float = 0.05):
    """地面高度图（cell 米一格）：范围内朝上、离估计地面 ±10 厘米的三角形中心高度的中位数；
    看不到地面的格子（物体底下）取最近的有值格子，再做 3×3 中值平滑。返回 (x0, z0, cell, 高度数组[iz, ix])。
    """
    from scipy import ndimage

    n, _ = face_normals(scan.V, scan.F)
    c = scan.V[scan.F].mean(axis=1)
    m = (n[:, 1] > 0.9) & (np.abs(c[:, 1] - floor_y) < 0.1)
    m &= (
        (c[:, 0] >= region.lo[0])
        & (c[:, 0] <= region.hi[0])
        & (c[:, 2] >= region.lo[2])
        & (c[:, 2] <= region.hi[2])
    )
    nx = max(1, int(np.ceil((region.hi[0] - region.lo[0]) / cell)))
    nz = max(1, int(np.ceil((region.hi[2] - region.lo[2]) / cell)))
    H = np.full((nz, nx), np.nan)
    if m.sum() >= 5:
        ix = np.clip(((c[m, 0] - region.lo[0]) / cell).astype(int), 0, nx - 1)
        iz = np.clip(((c[m, 2] - region.lo[2]) / cell).astype(int), 0, nz - 1)
        key = iz * nx + ix
        order = np.argsort(key, kind="stable")
        ks, ys = key[order], c[m, 1][order]
        uniq, start = np.unique(ks, return_index=True)
        for k, s0, s1 in zip(uniq, start, [*start[1:], len(ks)], strict=True):
            H.flat[k] = np.median(ys[s0:s1])
    valid = ~np.isnan(H)
    if not valid.any():
        H[:] = floor_y
    else:
        _, (iz, ix) = ndimage.distance_transform_edt(~valid, return_indices=True)
        H = H[iz, ix]
        H = ndimage.median_filter(H, size=3, mode="nearest")
    return float(region.lo[0]), float(region.lo[2]), cell, H


def flat_heightmap(region: Box, y: float):
    return float(region.lo[0]), float(region.lo[2]), 1.0, np.full((1, 1), y)


def floor_at(hm, P: np.ndarray) -> np.ndarray:
    """地面高度图在点 P 处的值（高度图范围外取边上的格子）。"""
    x0, z0, cell, H = hm
    nz, nx = H.shape
    ix = np.clip(((P[:, 0] - x0) / cell).astype(int), 0, nx - 1)
    iz = np.clip(((P[:, 2] - z0) / cell).astype(int), 0, nz - 1)
    return H[iz, ix]


def draped_grid(
    hm, region: Box, lift: float = 0.008, step: float = 0.05, unit: float = 0.1, major: int = 5, big: int = 10
) -> dict:
    """贴着地面高度图的网格线（unit 一格；分成细线、每 major 格、每 big 格三组，
    每组是平铺的线段端点坐标）。"""
    x0, z0, cell, H = hm
    nz, nx = H.shape

    def h(x, z):
        ix = np.clip(((x - x0) / cell).astype(int), 0, nx - 1)
        iz = np.clip(((z - z0) / cell).astype(int), 0, nz - 1)
        return H[iz, ix] + lift

    groups: dict[str, list[float]] = {"minor": [], "major": [], "unit": []}

    def line(xs, zs, k):
        ys = h(xs, zs)
        P = np.stack([xs, ys, zs], axis=1)
        seg = np.stack([P[:-1], P[1:]], axis=1).reshape(-1)
        g = "unit" if k % big == 0 else "major" if k % major == 0 else "minor"
        groups[g].extend(np.round(seg, 4).tolist())

    lo, hi = region.lo, region.hi
    for k in range(int(np.ceil(lo[0] / unit)), int(np.floor(hi[0] / unit)) + 1):
        zs = np.append(np.arange(lo[2], hi[2], step), hi[2])
        line(np.full(len(zs), k * unit), zs, k)
    for k in range(int(np.ceil(lo[2] / unit)), int(np.floor(hi[2] / unit)) + 1):
        xs = np.append(np.arange(lo[0], hi[0], step), hi[0])
        line(xs, np.full(len(xs), k * unit), k)
    return groups


# ---------------------------------------------------------------------------- 相机


def cam_vectors(az: float, el: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """方位角 az（绕 y，0 = 相机在 +z 侧）、仰角 el（度）→ (指向相机的方向, 画面右方, 画面上方)。"""
    a, e = math.radians(az), math.radians(el)
    d = np.array([math.cos(e) * math.sin(a), math.sin(e), math.cos(e) * math.cos(a)])
    up = np.array([-math.sin(a), 0, -math.cos(a)]) if abs(d[1]) > 0.999 else np.array([0.0, 1, 0])
    fwd = -d
    right = np.cross(fwd, up)
    right /= np.linalg.norm(right)
    tup = np.cross(right, fwd)
    return d, right, tup / np.linalg.norm(tup)


def axis_name(v: np.ndarray, tol: float = 0.999) -> str:
    for i, n in enumerate("XYZ"):
        if abs(v[i]) > tol:
            return ("+" if v[i] > 0 else "-") + n
    return "(" + ", ".join(f"{x:.2f}" for x in v) + ")"


def screen_map(info: dict) -> dict | None:
    """正交图的像素 ↔ 空间坐标换算（画面右方、上方沿坐标轴时）。"""
    if not info.get("scale"):
        return None
    s = info["scale"]
    t = info["target"]
    out: dict = {"metersPerPixel": r(s, 6)}
    for key, vec, base, sign_px in (
        ("x", info["right"], info["left"], 1),
        ("y", info["up"], info["top"], -1),
    ):
        v = np.array(vec)
        name = axis_name(v)
        if len(name) == 2:
            i = "XYZ".index(name[1])
            sg = 1 if name[0] == "+" else -1
            out[f"px{key}"] = {
                "axis": name[1],
                "at0": r(t[i] + sg * base, 4),
                "perPixel": r(sg * sign_px * s, 6),
            }
    return out


# ---------------------------------------------------------------------------- 图片


@functools.cache
def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    path = find_font()
    if path:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    for name in ("DejaVuSans.ttf", "Arial.ttf", "Helvetica.ttc"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def save_jpeg(img: Image.Image, path: str, max_bytes: int = 200_000) -> tuple[int, int]:
    """存 JPEG，逐步降低质量直到不超过 max_bytes。返回 (字节数, 质量)。"""
    img = img.convert("RGB")
    data, q = b"", 90
    for sub, qs in ((0, (90, 86, 82, 78)), (2, (86, 82, 78, 74, 70, 65, 60, 55, 50, 45, 40, 35))):
        for q in qs:
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=q, optimize=True, progressive=True, subsampling=sub)
            data = buf.getvalue()
            if len(data) <= max_bytes:
                break
        if len(data) <= max_bytes:
            break
    with open(path, "wb") as fh:
        fh.write(data)
    return len(data), q


def heat_color(v: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """0..1 的连续色带（深蓝 → 青 → 绿 → 黄 → 红），用于高度图。"""
    stops = np.array([[40, 50, 150], [30, 140, 200], [60, 190, 110], [240, 220, 60], [230, 70, 50]], float)
    t = np.clip((v - lo) / max(hi - lo, 1e-9), 0, 1) * (len(stops) - 1)
    i = np.minimum(t.astype(int), len(stops) - 2)
    f = (t - i)[..., None]
    return (stops[i] * (1 - f) + stops[i + 1] * f).astype(np.uint8)


PALETTE = [
    (255, 99, 99),
    (99, 200, 255),
    (255, 200, 60),
    (140, 230, 120),
    (220, 130, 255),
    (255, 150, 60),
    (80, 230, 210),
    (250, 120, 190),
    (180, 180, 255),
    (200, 220, 90),
    (255, 255, 255),
    (150, 110, 80),
]


def draw_rulers(img, origin, px_per_m, u0, v0, size_px, u_name, v_name, v_down=True) -> None:
    """在图像区域（origin 起，size_px 大小）的上边和左边画米制刻度：10 厘米小刻度、50 厘米标数字。"""
    d = ImageDraw.Draw(img)
    f = font(12)
    ox, oy = origin
    w, h = size_px
    lab_every = 5 if px_per_m * 0.1 >= 6 else 10
    for k in range(math.ceil(u0 * 10 - 1e-6), math.floor((u0 + w / px_per_m) * 10 + 1e-6) + 1):
        x = ox + (k / 10 - u0) * px_per_m
        L = 10 if k % 10 == 0 else 7 if k % 5 == 0 else 3
        d.line([(x, oy - L), (x, oy)], fill=(230, 233, 238))
        if k % lab_every == 0:
            d.text((x, oy - 12), f"{k / 10:.1f}", font=f, fill=(230, 233, 238), anchor="md")
    sgn = 1 if v_down else -1
    vend = v0 + sgn * h / px_per_m
    for k in range(math.ceil(min(v0, vend) * 10 - 1e-6), math.floor(max(v0, vend) * 10 + 1e-6) + 1):
        y = oy + (k / 10 - v0) * px_per_m * sgn
        L = 10 if k % 10 == 0 else 7 if k % 5 == 0 else 3
        d.line([(ox - L, y), (ox, y)], fill=(230, 233, 238))
        if k % lab_every == 0:
            d.text((ox - 12, y), f"{k / 10:.1f}", font=f, fill=(230, 233, 238), anchor="rm")
    d.text(
        (ox - 4, oy - 4),
        f"{u_name}→ {v_name}{'↓' if v_down else '↑'}",
        font=font(12),
        fill=(159, 211, 255),
        anchor="rb",
    )


def grid_overlay(img, origin, px_per_m, u0, v0, size_px, v_down=True) -> Image.Image:
    """图像区域里的淡网格（10 厘米细线、50 厘米亮线）。返回叠好网格的图。"""
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    ox, oy = origin
    w, h = size_px
    for k in range(math.ceil(u0 * 10), math.floor((u0 + w / px_per_m) * 10) + 1):
        x = ox + (k / 10 - u0) * px_per_m
        a = 110 if k % 10 == 0 else 70 if k % 5 == 0 else 28
        d.line([(x, oy), (x, oy + h)], fill=(255, 255, 255, a))
    sgn = 1 if v_down else -1
    vend = v0 + sgn * h / px_per_m
    for k in range(math.ceil(min(v0, vend) * 10), math.floor(max(v0, vend) * 10) + 1):
        y = oy + (k / 10 - v0) * px_per_m * sgn
        a = 110 if k % 10 == 0 else 70 if k % 5 == 0 else 28
        d.line([(ox, y), (ox + w, y)], fill=(255, 255, 255, a))
    return Image.alpha_composite(img.convert("RGBA"), over).convert("RGB")


def wrap_text(text: str, width: int, f) -> list[str]:
    lines = []
    for para in text.split("\n"):
        cur = ""
        for ch in para:
            if f.getlength(cur + ch) > width:
                lines.append(cur)
                cur = ""
            cur += ch
        lines.append(cur)
    return lines


class Panel:
    """二维图底板：深色背景 + 淡网格 + 上边、左边米制刻度 + 标题。

    坐标 (u, v)：u 向右增大，v 向下或向上增大。"""

    def __init__(
        self,
        u0,
        u1,
        v0,
        v1,
        *,
        v_down: bool,
        u_name: str,
        v_name: str,
        title: str,
        sub: str = "",
        max_w: int = 860,
        max_h: int = 860,
        right: int = 16,
        ppm: float | None = None,
        min_w: int = 560,
    ):
        self.u0, self.u1, self.v0, self.v1, self.v_down = u0, u1, v0, v1, v_down
        title, sub = title.replace("−", "-"), sub.replace("−", "-")  # 有的中文字体没有 U+2212
        self.ppm = ppm or min(max_w / max(u1 - u0, 1e-6), max_h / max(v1 - v0, 1e-6))
        self.w, self.h = round((u1 - u0) * self.ppm), round((v1 - v0) * self.ppm)
        f12 = font(12)
        min_w = max(min_w if sub else 0, int(font(15).getlength(title)) + 16)
        width = max(self.w + 62 + right, min_w)
        lines = wrap_text(sub, width - 16, f12) if sub else []
        self.L, self.T = 62, 54 + 17 * len(lines) if lines else 50
        img = Image.new("RGB", (width, self.h + self.T + 16), (24, 26, 30))
        ImageDraw.Draw(img).rectangle([self.L, self.T, self.L + self.w, self.T + self.h], fill=(34, 36, 40))
        self.vtop = v0 if v_down else v1
        self.img = grid_overlay(img, (self.L, self.T), self.ppm, u0, self.vtop, (self.w, self.h), v_down)
        self.draw = ImageDraw.Draw(self.img, "RGBA")
        self.draw.text((8, 6), title, font=font(15), fill=(255, 255, 255))
        for i, line in enumerate(lines):
            self.draw.text((8, 28 + 17 * i), line, font=f12, fill=(200, 205, 214))
        self.u_name, self.v_name = u_name, v_name

    def px(self, u, v):
        sg = 1 if self.v_down else -1
        return self.L + (np.asarray(u) - self.u0) * self.ppm, self.T + (
            np.asarray(v) - self.vtop
        ) * self.ppm * sg

    def set_image(self, img: Image.Image) -> None:
        self.img = img
        self.draw = ImageDraw.Draw(self.img, "RGBA")

    def finish(self) -> Image.Image:
        draw_rulers(
            self.img,
            (self.L, self.T),
            self.ppm,
            self.u0,
            self.vtop,
            (self.w, self.h),
            self.u_name,
            self.v_name,
            self.v_down,
        )
        return self.img


def plot_points(panel: Panel, U: np.ndarray, V: np.ndarray, colors: np.ndarray, size: int = 2) -> None:
    """把散点（已排好绘制顺序）画到底板上。"""
    arr = np.asarray(panel.img).copy()
    u, v = panel.px(U, V)
    ui, vi = np.round(u).astype(int), np.round(v).astype(int)
    for du in range(size):
        for dv in range(size):
            ok = (ui + du >= 0) & (ui + du < arr.shape[1]) & (vi + dv >= 0) & (vi + dv < arr.shape[0])
            arr[vi[ok] + dv, ui[ok] + du] = colors[ok]
    panel.set_image(Image.fromarray(arr))
