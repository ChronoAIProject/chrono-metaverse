"""重建工作台的公共部分：路径、范围、扫描读写与裁剪、地面高度、表面采样、物件记录、渲染调度、图片输出。"""

from __future__ import annotations

import io
import json
import math
import os
import struct
import subprocess
import tempfile
import time
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
# 基线数据（reconstruct_lobby.py 的输出目录：scan.glb、objects.json 等），用 WB_BASE 指定。
BASE = os.environ.get("WB_BASE", os.path.normpath(os.path.join(HERE, "..", "base")))
# 默认用仓库里网站的 three 包（先在 web/ 下 npm ci）。
THREE = os.environ.get(
    "WB_THREE", os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "web", "node_modules", "three"))
)
PLAYWRIGHT = os.environ.get("WB_PLAYWRIGHT", "/opt/node22/lib/node_modules/playwright")
RENDER_JS = os.path.join(HERE, "render", "render.js")
FONT_PATH = os.environ.get("WB_FONT", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc")


def log(msg: str) -> None:
    print(msg, flush=True)


def r(v, d: int = 4):
    """数字或数组按 d 位小数取整（JSON 输出用）。"""
    if isinstance(v, (list, tuple, np.ndarray)):
        return [r(x, d) for x in v]
    if v is None:
        return None
    f = round(float(v), d)
    return 0.0 if f == 0 else f


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


def load_objects(path: str) -> dict[str, dict]:
    """base/objects.json：entityId → body（也接受 body 列表）。"""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, list):
        return {b["entityId"]: b for b in data}
    if isinstance(data, dict) and "objects" in data and isinstance(data["objects"], (list, dict)):
        return load_objects_from(data["objects"])
    return data


def load_objects_from(data) -> dict[str, dict]:
    return {b["entityId"]: b for b in data} if isinstance(data, list) else dict(data)


def parse_box(text: str) -> Box:
    """`x0,y0,z0,x1,y1,z1` 或 `{"min":[..],"max":[..]}`。"""
    text = text.strip()
    if text.startswith("{"):
        d = json.loads(text)
        lo, hi = np.array(d["min"], float), np.array(d["max"], float)
    else:
        v = [float(x) for x in text.replace(" ", ",").split(",") if x]
        if len(v) != 6:
            raise SystemExit("--box 需要 6 个数：x0,y0,z0,x1,y1,z1")
        lo, hi = np.array(v[:3]), np.array(v[3:])
    return Box(np.minimum(lo, hi), np.maximum(lo, hi))


def resolve_box(args) -> tuple[Box, str | None]:
    """--box 优先，否则按 --object 到 objects.json 里取 bounds。返回 (包围盒, entityId)。"""
    if getattr(args, "box", None):
        return parse_box(args.box), getattr(args, "object", None)
    if getattr(args, "object", None):
        objs = load_objects(args.objects)
        body = objs.get(args.object)
        if body is None or "bounds" not in body:
            raise SystemExit(f"objects.json 里没有 {args.object} 的 bounds")
        b = body["bounds"]
        return Box(np.array(b["min"], float), np.array(b["max"], float)), args.object
    raise SystemExit("需要 --box 或 --object")


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


def _read_glb(path: str) -> tuple[dict, bytes]:
    with open(path, "rb") as fh:
        b = fh.read()
    magic, _, _ = struct.unpack("<4sII", b[:12])
    if magic != b"glTF":
        raise SystemExit(f"{path} 不是 glb")
    off, js, binb = 12, None, b""
    while off + 8 <= len(b):
        ln, typ = struct.unpack("<I4s", b[off : off + 8])
        chunk = b[off + 8 : off + 8 + ln]
        if typ == b"JSON":
            js = json.loads(chunk)
        elif typ == b"BIN\0":
            binb = chunk
        off += 8 + ln
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
    """读单网格、单贴图的扫描 glb（base/scan.glb 已在空间坐标里：米，y 向上）。多个图元会合并。"""
    js, binb = _read_glb(path)
    Vs, Fs, UVs, off = [], [], [], 0
    image, mime = None, "image/jpeg"
    for node in js.get("nodes", []):
        if "mesh" not in node:
            continue
        if any(k in node for k in ("matrix", "translation", "rotation", "scale")):
            raise SystemExit("扫描 glb 的节点带变换，工作台只支持已对齐到空间坐标的扫描")
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
        raise SystemExit("扫描 glb 里没有网格")
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


def write_scan_glb(scan: Scan, path: str) -> None:
    """裁剪后的扫描写成不打光、带原贴图的 glb（渲染用）。"""
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
    acc.append({"bufferView": view(pos.tobytes(), 34962), "componentType": 5126, "count": len(pos), "type": "VEC3",
                "min": pos.min(0).tolist(), "max": pos.max(0).tolist()})  # fmt: skip
    prim = {"attributes": {"POSITION": 0}, "indices": None, "material": 0}
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
    doc: dict = {"asset": {"version": "2.0", "generator": "wb"}, "scene": 0, "scenes": [{"nodes": [0]}],
                 "nodes": [{"name": "scan", "mesh": 0}], "meshes": [{"primitives": [prim]}]}  # fmt: skip
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
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    binary = b"".join(chunks)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(binary)))
        fh.write(struct.pack("<I4s", len(js), b"JSON"))
        fh.write(js)
        fh.write(struct.pack("<I4s", len(binary), b"BIN\0"))
        fh.write(binary)


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
        & (cen[:, 0] >= lo[0]) & (cen[:, 0] <= hi[0]) & (cen[:, 2] >= lo[2]) & (cen[:, 2] <= hi[2])
        & (cen[:, 1] <= box.lo[1] + 0.12) & (cen[:, 1] >= box.lo[1] - 0.4)
    )  # fmt: skip
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


# ---------------------------------------------------------------------------- 物件记录


def load_textures(*dirs: str) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            stem, ext = os.path.splitext(name)
            if ext.lower() in (".jpg", ".jpeg", ".png") and len(stem) == 64:
                with open(os.path.join(d, name), "rb") as fh:
                    out[stem] = fh.read()
    return out


def load_records(path: str) -> tuple[dict[str, dict], dict[str, dict], list[str]]:
    """模型师的物件记录文件。支持：单个 body、body 列表、entityId → body 的对象、
    `{"bodies"|"objects": [...], "templates": {编号: 形状}}`，以及裸形状（有 type 字段）。
    返回 (物件 entityId → body, 模板编号 → 形状, 读取时的提示)。"""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    notes: list[str] = []
    templates: dict[str, dict] = {}
    bodies: list[dict] = []
    if isinstance(data, dict) and "type" in data and "shape" not in data:
        notes.append("文件是裸形状，按 entityId=model 的物件处理")
        bodies = [{"entityId": "model", "kind": "object", "shape": data}]
    elif isinstance(data, list):
        bodies = data
    elif isinstance(data, dict) and ("shape" in data or "entityId" in data):
        bodies = [data]
    elif isinstance(data, dict):
        for key in ("bodies", "objects", "entities"):
            if key in data:
                v = data[key]
                bodies = list(v.values()) if isinstance(v, dict) else list(v)
        if not bodies and "templates" not in data:
            bodies = [dict(v, entityId=v.get("entityId", k)) for k, v in data.items() if isinstance(v, dict)]
        for k, v in (data.get("templates") or {}).items():
            templates[k] = v.get("shape", v) if isinstance(v, dict) else v
    out: dict[str, dict] = {}
    for i, b in enumerate(bodies):
        if not isinstance(b, dict):
            raise SystemExit(f"第 {i} 个记录不是对象")
        eid = b.get("entityId") or f"model-{i + 1}"
        if b.get("kind") == "template":
            templates[eid] = b.get("shape")
        else:
            out[eid] = b
    return out, templates, notes


# ---------------------------------------------------------------------------- 相机与视图


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
            return ("+" if v[i] > 0 else "−") + n
    return "(" + ", ".join(f"{x:.2f}" for x in v) + ")"


def describe_camera(az: float, el: float) -> tuple[str, str, str]:
    d, right, up = cam_vectors(az, el)
    if abs(d[1]) > 0.999:
        where = "相机在正上方，看向 −Y"
    elif abs(el) < 1e-6 and axis_name(d)[0] in "+−" and len(axis_name(d)) == 2:
        where = f"相机在 {axis_name(d)} 侧，看向 {axis_name(-d)}"
    else:
        where = f"相机方位角 {az:g}°、仰角 {el:g}°（方向 {axis_name(d)}）"
    return where, axis_name(right), axis_name(up)


def screen_map(info: dict) -> dict | None:
    """正交图的像素 ↔ 空间坐标换算（画面右方、上方沿坐标轴时）。"""
    if not info.get("scale"):
        return None
    s = info["scale"]
    t = info["target"]
    out = {"metersPerPixel": r(s, 6)}
    for key, vec, base, sign_px in (
        ("x", info["right"], info["left"], 1),
        ("y", info["up"], info["top"], -1),
    ):
        v = np.array(vec)
        name = axis_name(v)
        if len(name) == 2:
            i = "XYZ".index(name[1])
            sg = 1 if name[0] == "+" else -1
            # 坐标 = t_i + sg·(base + sign_px·像素·s)
            out[f"px{key}"] = {
                "axis": name[1],
                "at0": r(t[i] + sg * base, 4),
                "perPixel": r(sg * sign_px * s, 6),
            }
    return out


def run_render(models: dict[str, str], views: list[dict], workdir: str, timeout: int = 300) -> list[dict]:
    job = {"three": THREE, "playwright": PLAYWRIGHT, "models": models, "views": views}
    fd, job_path = tempfile.mkstemp(prefix="render_", suffix=".json", dir=workdir)
    with os.fdopen(fd, "w") as fh:
        json.dump(job, fh)
    t = time.time()
    proc = subprocess.run(["node", RENDER_JS, job_path], capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise SystemExit(f"渲染失败：\n{proc.stdout}\n{proc.stderr}")
    with open(job_path + ".out.json") as fh:
        infos = json.load(fh)
    os.remove(job_path)
    os.remove(job_path + ".out.json")
    log(f"  渲染 {len(views)} 张，{time.time() - t:.1f} 秒")
    return infos


# ---------------------------------------------------------------------------- 图片


def font(size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except OSError:
        return ImageFont.load_default()


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


def draw_rulers(
    img: Image.Image,
    origin: tuple[int, int],
    px_per_m: float,
    u0: float,
    v0: float,
    size_px: tuple[int, int],
    u_name: str,
    v_name: str,
    v_down: bool = True,
) -> None:
    """在图像区域（origin 起，size_px 大小）的上边和左边画米制刻度：10 厘米小刻度、50 厘米标数字。
    像素 (i, j) 对应坐标 u = u0 + i/px_per_m，v = v0 ± j/px_per_m（v_down 时向下增大）。"""
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


def grid_overlay(
    img: Image.Image, origin, px_per_m: float, u0: float, v0: float, size_px, v_down=True
) -> None:
    """图像区域里的淡网格（10 厘米细线、50 厘米亮线）。"""
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
    img.alpha_composite(over) if img.mode == "RGBA" else img.paste(
        Image.alpha_composite(img.convert("RGBA"), over)
    )


# ---------------------------------------------------------------------------- 地面高度图与贴地网格


def floor_heightmap(scan: Scan, region: Box, floor_y: float, cell: float = 0.05):
    """地面高度图（cell 米一格）：范围内朝上、离估计地面 ±10 厘米的三角形中心高度的中位数；
    看不到地面的格子（物体底下）取最近的有值格子，再做 3×3 中值平滑。返回 (x0, z0, cell, 高度数组[iz, ix])。"""
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
        for k, s0, s1 in zip(uniq, start, list(start[1:]) + [len(ks)]):
            H.flat[k] = np.median(ys[s0:s1])
    valid = ~np.isnan(H)
    if not valid.any():
        H[:] = floor_y
    else:
        _, (iz, ix) = ndimage.distance_transform_edt(~valid, return_indices=True)
        H = H[iz, ix]
        H = ndimage.median_filter(H, size=3, mode="nearest")
    return float(region.lo[0]), float(region.lo[2]), cell, H


def draped_grid(hm, region: Box, lift: float = 0.008, step: float = 0.05) -> dict:
    """贴着地面高度图的 10 厘米网格线（分成细线、50 厘米线、整米线三组，每组是平铺的线段端点坐标）。"""
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
        g = "unit" if k % 10 == 0 else "major" if k % 5 == 0 else "minor"
        groups[g].extend(np.round(seg, 4).tolist())

    lo, hi = region.lo, region.hi
    for k in range(int(np.ceil(lo[0] * 10)), int(np.floor(hi[0] * 10)) + 1):
        zs = np.append(np.arange(lo[2], hi[2], step), hi[2])
        line(np.full(len(zs), k / 10), zs, k)
    for k in range(int(np.ceil(lo[2] * 10)), int(np.floor(hi[2] * 10)) + 1):
        xs = np.append(np.arange(lo[0], hi[0], step), hi[0])
        line(xs, np.full(len(xs), k / 10), k)
    return groups


class Panel:
    """二维图底板：深色背景 + 淡网格 + 上边、左边米制刻度 + 标题。坐标 (u, v)：u 向右增大，v 向下（v_down）或向上增大。"""

    def __init__(self, u0, u1, v0, v1, *, v_down: bool, u_name: str, v_name: str, title: str, sub: str = "",
                 max_w: int = 860, max_h: int = 860, right: int = 16, ppm: float | None = None,
                 min_w: int = 560):  # fmt: skip
        self.u0, self.u1, self.v0, self.v1, self.v_down = u0, u1, v0, v1, v_down
        title, sub = title.replace("−", "-"), sub.replace("−", "-")  # 文泉驿正黑没有 U+2212
        self.ppm = ppm or min(max_w / max(u1 - u0, 1e-6), max_h / max(v1 - v0, 1e-6))
        self.w, self.h = int(round((u1 - u0) * self.ppm)), int(round((v1 - v0) * self.ppm))
        # 副标题按宽度折行
        lines, f12 = [], font(12)
        min_w = max(min_w if sub else 0, int(font(15).getlength(title)) + 16)
        width = max(self.w + 62 + right, min_w)
        for para in sub.split("\n") if sub else []:
            cur = ""
            for ch in para:
                if f12.getlength(cur + ch) > width - 16:
                    lines.append(cur)
                    cur = ""
                cur += ch
            lines.append(cur)
        self.L, self.T = 62, 54 + 17 * len(lines) if lines else 50
        self.img = Image.new("RGB", (width, self.h + self.T + 16), (24, 26, 30))
        d = ImageDraw.Draw(self.img)
        d.rectangle([self.L, self.T, self.L + self.w, self.T + self.h], fill=(34, 36, 40))
        self.vtop = v0 if v_down else v1
        grid_overlay(self.img, (self.L, self.T), self.ppm, u0, self.vtop, (self.w, self.h), v_down)
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

    def finish(self) -> Image.Image:
        draw_rulers(self.img, (self.L, self.T), self.ppm, self.u0, self.vtop, (self.w, self.h), self.u_name,
                    self.v_name, self.v_down)  # fmt: skip
        return self.img


PALETTE = [(255, 99, 99), (99, 200, 255), (255, 200, 60), (140, 230, 120), (220, 130, 255), (255, 150, 60),
           (80, 230, 210), (250, 120, 190), (180, 180, 255), (200, 220, 90)]  # fmt: skip


def floor_at(hm, P: np.ndarray) -> np.ndarray:
    """地面高度图在点 P 处的值（高度图范围外取边上的格子）。"""
    x0, z0, cell, H = hm
    nz, nx = H.shape
    ix = np.clip(((P[:, 0] - x0) / cell).astype(int), 0, nx - 1)
    iz = np.clip(((P[:, 2] - z0) / cell).astype(int), 0, nz - 1)
    return H[iz, ix]


def flat_heightmap(region: Box, y: float):
    return float(region.lo[0]), float(region.lo[2]), 1.0, np.full((1, 1), y)
