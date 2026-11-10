"""贴图工作台：`refshot`（从扫描取参考图）和 `texture`（把贴图写进物件的工作副本、标定、出对比图）。

**refshot**：对物件（`--object` 的 bounds 或 `--box`）的一个面做正交展开——每个像素沿面的法向找离观察者最近、
深度在窗口内（`--depth`）、朝向和法向一致的扫描三角形，插值贴图坐标后双线性取色（清晰度只受扫描贴图限制，
`--texture` 给原始的 8K 贴图更清楚）。输出 `refshot.png`（RGBA，没采到的像素透明）和 `refshot.json`：
每像素米数 `pxM`、面的原点 `origin` 和 `u`、`v`、`n` 轴（像素 (i, j) 的中心 = origin + (i + 0.5)·pxM·u +
(j + 0.5)·pxM·v）、采到的比例 `coverage`、稳健中位色 `median`（去掉最亮、最暗各 3% 后逐通道取中位数，sRGB 和
线性两种写法）、建议的平铺尺寸 `suggestedTile`（亮度高频部分的自相关周期；找不到明显周期时取面的尺寸，
最长 2 米）。

**texture**：把颜色、法线（OpenGL 约定）、粗糙度贴图复制进物件文件旁边的 `textures/`（文件名是哈希前 12 位），
在物件的工作副本里写成 `{file: textures/<名字>}`，带上 `uv`、`tile`、`offset`、`rotate`、`shading`
（SHAPES 2 的材质字段）；`bundle` 打包时这些文件作为贴图进包、记录里换成哈希。

- `--calibrate`：按 `refshot.json` 的中位色，在网站同样的光照下标定整体增益——正对这个面正交渲染（固有色
  完整受光），取部件像素的中位色，与扫描的中位色比，逐通道的增益限制在亮度比的 0.8–1.25 倍之间，乘到颜色贴图
  上（线性空间）再渲染，迭代 3 次，结果烘进贴图副本（原文件不动）；
- `--preview`：出 扫描 | 之前 | 之后 的对比图（正对这个面和斜看各一行），算部件区域的中位色与扫描的色差
  （CIELAB ΔE）。
"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import math
import os
import shutil
import tempfile
from typing import Any

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import binary_erosion

from . import core as wc
from .core import Box, ReconError
from .i18n import t

FACES = ("top", "bottom", "front", "back", "left", "right")
HIGHLIGHT_Q = 0.97
SHADOW_Q = 0.03
MIN_TILE = 0.2
MAX_TILE = 2.0
GAIN_ITERATIONS = 3
# 建议平铺：亮度高频部分的剖面起伏小于它（线性亮度）时，当作没有纹理周期
MIN_PROFILE_STD = 0.003
BACKGROUND = 0xFF00FF
SHEET_BACKGROUND = (58, 60, 66)


# ---------------------------------------------------------------------------- 颜色


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = np.asarray(c, np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(np.asarray(c, np.float64), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055) * 255.0


def luminance(lin: np.ndarray) -> np.ndarray:
    return lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722


def robust_median(rgb: np.ndarray) -> np.ndarray:
    """像素（N×3，sRGB 0–255）的稳健中位色：去掉亮度最高、最低各 3%（高光、阴影和缝），逐通道取中位数。"""
    rgb = np.asarray(rgb, np.float64).reshape(-1, 3)
    if len(rgb) == 0:
        raise ReconError("没有像素")
    lum = luminance(srgb_to_linear(rgb))
    lo, hi = np.quantile(lum, [SHADOW_Q, HIGHLIGHT_Q])
    keep = (lum >= lo) & (lum <= hi)
    return np.median(rgb[keep] if keep.sum() >= 10 else rgb, axis=0)


def lab(srgb: np.ndarray) -> np.ndarray:
    """sRGB 0–255 → CIELAB（D65）。"""
    lin = srgb_to_linear(srgb)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = lin @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def delta_e(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.linalg.norm(lab(np.asarray(a, float)) - lab(np.asarray(b, float))))


# ---------------------------------------------------------------------------- 正交展开


def face_frame(box: Box, face: str, front_deg: float) -> tuple[dict[str, list[float]], float, float]:
    """面的坐标系：origin 是图像左上角（世界坐标），u 向右、v 向下，n 指向观察者；返回 (frame, 宽 米, 高 米)。

    物件的局部 +z 是正面（`--front` 方位角，SHAPES 偏航）：top 俯视（正面在图像下方），front 正对正面，
    back、left、right 依此类推，bottom 仰视。"""
    if face not in FACES:
        raise ReconError(f"--face 只能是 {'、'.join(FACES)}")
    a = math.radians(front_deg)
    ex = np.array([math.cos(a), 0.0, -math.sin(a)])
    ez = np.array([math.sin(a), 0.0, math.cos(a)])
    up = np.array([0.0, 1.0, 0.0])
    axes = {
        "top": (ex, ez, up),
        "bottom": (ex, -ez, -up),
        "front": (ex, -up, ez),
        "back": (-ex, -up, -ez),
        "right": (-ez, -up, ex),
        "left": (ez, -up, -ex),
    }
    u, v, n = axes[face]
    corners = np.array(
        [
            [x, y, z]
            for x in (box.lo[0], box.hi[0])
            for y in (box.lo[1], box.hi[1])
            for z in (box.lo[2], box.hi[2])
        ]
    )
    pu, pv, pn = corners @ u, corners @ v, corners @ n
    origin = u * pu.min() + v * pv.min() + n * pn.max()
    frame = {"origin": origin.tolist(), "u": u.tolist(), "v": v.tolist(), "n": n.tolist()}
    return frame, float(pu.max() - pu.min()), float(pv.max() - pv.min())


def bilinear(tex: np.ndarray, uv: np.ndarray) -> np.ndarray:
    """贴图坐标（左上角原点，0–1）→ 双线性取色（N×3 float）。"""
    H, W = tex.shape[:2]
    x = uv[:, 0] * W - 0.5
    y = uv[:, 1] * H - 0.5
    x0 = np.clip(np.floor(x).astype(np.int64), 0, W - 1)
    y0 = np.clip(np.floor(y).astype(np.int64), 0, H - 1)
    x1, y1 = np.clip(x0 + 1, 0, W - 1), np.clip(y0 + 1, 0, H - 1)
    fx = np.clip(x - x0, 0, 1)[:, None]
    fy = np.clip(y - y0, 0, 1)[:, None]
    t_ = tex.astype(np.float64)
    return (
        t_[y0, x0] * (1 - fx) * (1 - fy)
        + t_[y0, x1] * fx * (1 - fy)
        + t_[y1, x0] * (1 - fx) * fy
        + t_[y1, x1] * fx * fy
    )


def ortho_extract(
    V: np.ndarray,
    F: np.ndarray,
    UV: np.ndarray,
    tex: np.ndarray,
    frame: dict,
    px: float,
    size: tuple[int, int],
    depth: tuple[float, float],
    cos_min: float = 0.5,
    chunk: int = 4_000_000,
) -> tuple[np.ndarray, np.ndarray]:
    """逐像素光栅化扫描网格（见模块说明）。返回 (颜色 H×W×3 float，sRGB 0–255；掩码 H×W bool)。"""
    org, U, Vv, N = (np.asarray(frame[k], float) for k in ("origin", "u", "v", "n"))
    W, H = size
    dlo, dhi = depth
    tri = V[F]
    nn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    nn /= np.maximum(np.linalg.norm(nn, axis=1, keepdims=True), 1e-12)
    C = tri.mean(1)
    cu, cv, cd = (C - org) @ U / px, (C - org) @ Vv / px, (C - org) @ N
    sel = (cu > -50) & (cu < W + 50) & (cv > -50) & (cv < H + 50) & (cd > dlo - 0.1) & (cd < dhi + 0.1)
    sel &= nn @ N > cos_min
    fids = np.nonzero(sel)[0]
    pu, pv, pd = (V - org) @ U / px, (V - org) @ Vv / px, (V - org) @ N
    t3 = F[fids]
    x, y, z = pu[t3], pv[t3], pd[t3]
    xmin = np.clip(np.floor(x.min(1) - 0.5).astype(np.int64), 0, W - 1)
    xmax = np.clip(np.ceil(x.max(1) - 0.5).astype(np.int64), 0, W - 1)
    ymin = np.clip(np.floor(y.min(1) - 0.5).astype(np.int64), 0, H - 1)
    ymax = np.clip(np.ceil(y.max(1) - 0.5).astype(np.int64), 0, H - 1)
    bw = np.maximum(xmax - xmin + 1, 0)
    cnt = bw * np.maximum(ymax - ymin + 1, 0)
    zbuf = np.full(H * W, -np.inf)
    ubuf = np.zeros((H * W, 2))
    cum = np.cumsum(cnt)
    start = 0
    while start < len(fids):
        base = cum[start - 1] if start else 0
        end = max(int(np.searchsorted(cum, base + chunk, side="right")), start + 1)
        k = cnt[start:end]
        ti = np.repeat(np.arange(start, end), k)
        off = np.arange(k.sum()) - np.repeat(np.cumsum(k) - k, k)
        gx = xmin[ti] + off % np.maximum(bw[ti], 1)
        gy = ymin[ti] + off // np.maximum(bw[ti], 1)
        qx, qy = gx + 0.5, gy + 0.5
        x0, x1, x2 = x[ti, 0], x[ti, 1], x[ti, 2]
        y0, y1, y2 = y[ti, 0], y[ti, 1], y[ti, 2]
        den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        ok = np.abs(den) > 1e-12
        den = np.where(ok, den, 1.0)
        w0 = ((y1 - y2) * (qx - x2) + (x2 - x1) * (qy - y2)) / den
        w1 = ((y2 - y0) * (qx - x2) + (x0 - x2) * (qy - y2)) / den
        w2 = 1 - w0 - w1
        inside = ok & (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        d = w0 * z[ti, 0] + w1 * z[ti, 1] + w2 * z[ti, 2]
        inside &= (d >= dlo) & (d <= dhi)
        if inside.any():
            ii = np.nonzero(inside)[0]
            lin = gy[ii] * W + gx[ii]
            order = np.lexsort((d[ii], lin))
            lin_s = lin[order]
            last = np.r_[lin_s[1:] != lin_s[:-1], True]
            pick, lin_p = ii[order[last]], lin_s[last]
            better = d[pick] > zbuf[lin_p]
            pick, lin_p = pick[better], lin_p[better]
            tt = t3[ti[pick]]
            ubuf[lin_p] = (
                UV[tt[:, 0]] * w0[pick][:, None]
                + UV[tt[:, 1]] * w1[pick][:, None]
                + UV[tt[:, 2]] * w2[pick][:, None]
            )
            zbuf[lin_p] = d[pick]
        start = end
    mask = np.isfinite(zbuf)
    rgb = np.zeros((H * W, 3))
    rgb[mask] = bilinear(tex, ubuf[mask])
    return rgb.reshape(H, W, 3), mask.reshape(H, W)


def suggest_tile(rgb: np.ndarray, mask: np.ndarray, px: float, size_m: tuple[float, float]) -> dict:
    """建议的平铺尺寸：亮度高频部分沿 u、v 的自相关周期（相关系数 ≥ 0.3 才算）；没有明显周期时取面的尺寸
    （最长 `MAX_TILE` 米），四舍五入到 5 厘米。"""
    from scipy import ndimage

    g = luminance(srgb_to_linear(rgb))
    hp = g - ndimage.uniform_filter(g, max(3, int(0.05 / px)))
    hp[~mask] = 0
    out = []
    basis = []
    for axis, extent in ((0, size_m[0]), (1, size_m[1])):
        valid = mask.sum(axis=0) if axis == 0 else mask.sum(axis=1)
        p = (hp.sum(axis=0) if axis == 0 else hp.sum(axis=1)) / np.maximum(valid, 1)
        p = p - p.mean()
        lo, hi = int(MIN_TILE / px), min(len(p) - 1, int(min(MAX_TILE, extent * 0.6) / px))
        period = None
        if hi > lo + 2 and p.std() > MIN_PROFILE_STD:
            ac = np.correlate(p, p, "full")[len(p) - 1 :]
            ac /= ac[0]
            k = lo + int(np.argmax(ac[lo:hi]))
            if ac[k] >= 0.3:
                period = k * px
        if period is None:
            out.append(round(min(extent, MAX_TILE) * 20) / 20 or MIN_TILE)
            basis.append("extent")
        else:
            out.append(round(period * 20) / 20)
            basis.append("period")
    return {"tile": out, "basis": basis}


def _scan_arrays(
    base_scan: str, texture_path: str | None
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    scan = wc.load_scan(base_scan)
    if scan.UV is None:
        raise ReconError("扫描没有贴图坐标")
    if texture_path:
        Image.MAX_IMAGE_PIXELS = 1 << 28
        with Image.open(texture_path) as im:
            tex = np.asarray(im.convert("RGB"))
    else:
        tex = scan.texture()
        if tex is None:
            raise ReconError("扫描没有贴图")
    return scan.V, scan.F, scan.UV, tex


def cmd_refshot(args) -> dict:
    from .base import from_args, resolve_box

    base = from_args(args)
    box, _ = resolve_box(args, base)
    if args.margin:
        box = box.grow(args.margin)
    frame, w_m, h_m = face_frame(box, args.face, args.front)
    W, H = max(1, round(w_m / args.px)), max(1, round(h_m / args.px))
    if W * H > 40_000_000:
        raise ReconError(f"图太大（{W}×{H}）：把 --px 调大")
    V, F, UV, tex = _scan_arrays(base.scan, args.texture)
    rgb, mask = ortho_extract(V, F, UV, tex, frame, args.px, (W, H), (-args.depth, args.depth))
    coverage = float(mask.mean())
    if mask.sum() < 50:
        raise ReconError(f"这个面上几乎没有扫描（采到 {int(mask.sum())} 个像素）：换 --face 或调 --depth")
    os.makedirs(args.out, exist_ok=True)
    rgba = np.dstack([np.clip(np.round(rgb), 0, 255), mask * 255]).astype(np.uint8)
    png = os.path.join(args.out, "refshot.png")
    Image.fromarray(rgba, "RGBA").save(png)
    median = robust_median(rgb[mask])
    tile = suggest_tile(rgb, mask, args.px, (w_m, h_m))
    info = {
        "image": "refshot.png",
        "face": args.face,
        "front": args.front,
        "pxM": args.px,
        "sizePx": [W, H],
        "sizeM": [round(w_m, 4), round(h_m, 4)],
        **{k: wc.r(v, 6) for k, v in frame.items()},
        "depthM": args.depth,
        "coverage": round(coverage, 4),
        "median": {
            "srgb": [round(float(c), 1) for c in median],
            "linear": [round(float(c), 5) for c in srgb_to_linear(median)],
        },
        "suggestedTile": tile["tile"],
        "tileBasis": tile["basis"],
        "box": box.as_dict(),
        "source": os.path.abspath(args.texture) if args.texture else os.path.abspath(base.scan),
    }
    wc.write_json(os.path.join(args.out, "refshot.json"), info)
    print(
        json.dumps(
            {k: info[k] for k in ("sizePx", "sizeM", "coverage", "median", "suggestedTile", "tileBasis")},
            ensure_ascii=False,
        )
    )
    return info


# ---------------------------------------------------------------------------- texture


def _node(shape: dict, path: str) -> dict:
    from ..authored import node_at

    try:
        return node_at(shape, path)
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise ReconError(f"部件路径 {path} 不对：{error}") from error


def _copy_texture(src: str, folder: str, model_dir: str) -> dict[str, str]:
    """贴图复制进工作副本旁边的目录（文件名是内容哈希前 12 位），返回 `{file: 相对物件文件的路径}`。"""
    from ..bundle.textures import image_info

    with open(src, "rb") as fh:
        data = fh.read()
    ext, _, _, _ = image_info(data)
    sha = hashlib.sha256(data).hexdigest()
    os.makedirs(os.path.join(model_dir, folder), exist_ok=True)
    name = f"{sha[:12]}.{ext}"
    dest = os.path.join(model_dir, folder, name)
    if not os.path.exists(dest):
        shutil.copyfile(src, dest)
    return {"file": f"{folder}/{name}"}


def _write_bytes(data: bytes, ext: str, folder: str, model_dir: str) -> dict[str, str]:
    sha = hashlib.sha256(data).hexdigest()
    os.makedirs(os.path.join(model_dir, folder), exist_ok=True)
    name = f"{sha[:12]}.{ext}"
    with open(os.path.join(model_dir, folder, name), "wb") as fh:
        fh.write(data)
    return {"file": f"{folder}/{name}"}


def preview_body(body: dict, model_dir: str) -> tuple[dict, dict[str, bytes]]:
    """物件的预览副本：`{file}` 贴图换成内容哈希，返回 (副本, {哈希: 字节})（工作台的 glb 导出
    按哈希取贴图）。"""
    from ..bundle.textures import inline_file_textures

    doc = {"entities": [copy.deepcopy(body)]}
    textures = inline_file_textures(doc, model_dir)
    return doc["entities"][0], textures


def _part_bounds(body: dict, part: str, templates: dict) -> Box:
    from .shapes_ext import build_parts

    parts = [
        p
        for p in build_parts(body["shape"], templates)
        if p.path == part or p.path.startswith(part + ".") or part == "$"
    ]
    if not parts:
        raise ReconError(f"找不到部件 {part}")
    pts = np.concatenate([p.mesh.positions for p in parts])
    return Box(pts.min(0), pts.max(0))


FACE_VIEW = {
    "top": (0.0, 90.0),
    "front": (0.0, 0.0),
    "back": (180.0, 0.0),
    "right": (90.0, 0.0),
    "left": (-90.0, 0.0),
    "bottom": (0.0, -90.0),
}


def _render_part(
    base,
    bodies: dict[str, dict],
    templates: dict,
    textures: dict[str, bytes],
    face_box: Box,
    face: str,
    front: float,
    size: tuple[int, int],
    workdir: str,
    oblique: bool = False,
) -> dict[str, np.ndarray]:
    """正对这个面（`oblique` 时斜看）渲染：扫描、每个物件版本，以及部件的掩码。返回 {名字: H×W×3 sRGB}。"""
    from .glbout import export_glb
    from .render import run_render

    models: dict[str, Any] = {"scan": base.scan}
    for name, body in bodies.items():
        glb = os.path.join(workdir, f"{name}.glb")
        export_glb({body["entityId"]: body}, templates, textures, glb)
        models[name] = glb
        mask_glb = os.path.join(workdir, f"{name}-mask.glb")
        flat = copy.deepcopy(body)
        flat["shape"] = _flat(flat["shape"])
        export_glb({flat["entityId"]: flat}, templates, {}, mask_glb)
        models[f"{name}#mask"] = mask_glb
    az, el = FACE_VIEW[face]
    az += front
    if oblique:
        az, el = az + 35.0, 35.0 if face != "bottom" else -35.0
    clip = face_box.grow(0.03)
    views = []
    out = {}
    names = ["scan", *bodies, *(f"{n}#mask" for n in bodies)]
    for name in names:
        path = os.path.join(workdir, f"v-{name.replace('#', '-')}-{int(oblique)}.png")
        spec = {
            "out": path,
            "size": list(size),
            "az": az,
            "el": el,
            "ortho": not oblique,
            "fov": 30,
            "frame": face_box.as_dict(),
            "clip": clip.as_dict(),
            "clipModels": ["scan"],
            "show": [name],
            "overlay": {"tag": None},
            "background": BACKGROUND,
        }
        if face == "top" and not oblique:
            spec["cut"] = float(face_box.hi[1]) + 0.02
        views.append(spec)
        out[name] = path
    run_render(models, views, workdir)
    images = {}
    for name, path in out.items():
        with Image.open(path) as im:
            images[name] = np.asarray(im.convert("RGB")).astype(np.float64)
        os.remove(path)
    return images


def _flat(shape: Any) -> Any:
    """掩码用：每个形状（组合除外）的材质换成不打光的纯白。"""
    if isinstance(shape, dict):
        out = {k: _flat(v) for k, v in shape.items() if k != "material"}
        if out.get("type") != "group":
            out["material"] = {"color": [255, 255, 255], "unlit": True}
        return out
    if isinstance(shape, list):
        return [_flat(v) for v in shape]
    return shape


def _mask(img: np.ndarray) -> np.ndarray:
    return np.abs(img - np.array([255.0, 0.0, 255.0])).sum(-1) > 60


def _apply_gain(data: bytes, gain: np.ndarray) -> tuple[bytes, str]:
    with Image.open(io.BytesIO(data)) as im:
        alpha = "A" in im.getbands()
        arr = np.asarray(im.convert("RGBA" if alpha else "RGB")).astype(np.float64)
    arr[..., :3] = linear_to_srgb(srgb_to_linear(arr[..., :3]) * gain)
    out = Image.fromarray(np.clip(np.round(arr), 0, 255).astype(np.uint8))
    buf = io.BytesIO()
    if alpha:
        out.save(buf, format="PNG", optimize=True)
        return buf.getvalue(), "png"
    out.save(buf, format="JPEG", quality=92, optimize=True)
    return buf.getvalue(), "jpg"


def cmd_texture(args) -> dict:
    from .base import from_args, load_records
    from .render import available

    model_path = os.path.abspath(args.model)
    model_dir = os.path.dirname(model_path)
    raw = wc.read_json(model_path)
    rs = load_records(model_path)
    if args.entity:
        if args.entity not in rs.bodies:
            raise ReconError(f"{args.model} 里没有物件 {args.entity}")
        eid = args.entity
    elif len(rs.bodies) == 1:
        eid = next(iter(rs.bodies))
    else:
        raise ReconError("文件里有几个物件，用 --entity 指定")
    body = rs.bodies[eid]
    if body.get("shape") is None:
        raise ReconError(f"{eid} 没有形状（外部模型的贴图不在这里改）")
    before = copy.deepcopy(body)
    node = _node(body["shape"], args.part)
    if node.get("type") == "group":
        raise ReconError("部件是 group：贴图写在具体的形状上（--part 指到子形状）")
    material = dict(node.get("material") or {})
    for key in (
        "color",
        "bake",
        "texture",
        "normalMap",
        "normalScale",
        "roughnessMap",
        "tile",
        "offset",
        "rotate",
        "tint",
    ):
        material.pop(key, None)
    if not args.color:
        raise ReconError("要给 --color（颜色贴图）")
    material["texture"] = _copy_texture(args.color, args.textures_dir, model_dir)
    material["uv"] = args.uv
    material["shading"] = args.shading
    if args.tile:
        material["tile"] = [float(v) for v in args.tile.split(",")]
    if args.offset:
        material["offset"] = [float(v) for v in args.offset.split(",")]
    if args.rotate is not None:
        material["rotate"] = args.rotate
    if args.normal:
        material["normalMap"] = _copy_texture(args.normal, args.textures_dir, model_dir)
    if args.roughness:
        material["roughnessMap"] = _copy_texture(args.roughness, args.textures_dir, model_dir)
    node["material"] = material
    body.pop("textures", None)
    from ..bundle.textures import check_authored

    try:
        check_authored({"version": 1, "entities": [{k: v for k, v in body.items() if k != "fit"}]})
    except Exception as error:  # 材质字段的组合不合法（SHAPES 2）
        raise ReconError(f"写进去的材质不合法：{error}") from error
    result: dict[str, Any] = {"entityId": eid, "part": args.part, "material": material}
    need_render = args.calibrate or args.preview
    if need_render and not available():
        raise ReconError("--calibrate、--preview 要渲染工具（metaverse-recon doctor）")
    ref = None
    if args.refshot:
        ref = wc.read_json(args.refshot)
    if args.calibrate and ref is None:
        raise ReconError("--calibrate 要 --refshot（refshot.json，扫描的中位色）")
    base = from_args(args) if need_render else None
    if args.calibrate:
        result["calibration"] = _calibrate(args, base, rs, body, material, ref, model_dir)
    _save_model(model_path, raw, eid, body)
    if args.preview:
        result["preview"] = _preview(args, base, rs, before, body, ref, model_dir)
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return result


def _calibrate(args, base, rs, body: dict, material: dict, ref: dict, model_dir: str) -> dict:
    face, front = ref.get("face", "top"), float(ref.get("front", 0.0))
    target = np.asarray(ref["median"]["srgb"], float)
    target_lin = srgb_to_linear(target)
    color_file = os.path.join(model_dir, material["texture"]["file"])
    with open(color_file, "rb") as fh:
        original = fh.read()
    gain = np.ones(3)
    log = []
    folder = os.path.join(model_dir, args.textures_dir)
    existing = set(os.listdir(folder))
    with tempfile.TemporaryDirectory() as work:
        for it in range(GAIN_ITERATIONS + 1):
            data, ext = (
                _apply_gain(original, gain) if it else (original, os.path.splitext(color_file)[1].lstrip("."))
            )
            material["texture"] = (
                _write_bytes(data, ext, args.textures_dir, model_dir) if it else material["texture"]
            )
            pbody, textures = preview_body(body, model_dir)
            fbox = _part_bounds(pbody, args.part, rs.templates)
            imgs = _render_part(
                base, {"cur": pbody}, rs.templates, textures, fbox, face, front, (480, 480), work
            )
            mask = _mask(imgs["cur#mask"])
            if mask.sum() < 50:
                raise ReconError("渲染里看不到这个部件：refshot 的面和这个部件对不上")
            got = robust_median(imgs["cur"][mask])
            de = delta_e(got, target)
            log.append(
                {
                    "gain": [round(float(g), 4) for g in gain],
                    "rendered": [round(float(c), 1) for c in got],
                    "dE": round(de, 2),
                }
            )
            if it == GAIN_ITERATIONS:
                break
            ratio = target_lin / np.maximum(srgb_to_linear(got), 1e-4)
            lr = float(luminance(target_lin[None])[0] / max(luminance(srgb_to_linear(got)[None])[0], 1e-4))
            gain = gain * np.clip(ratio, lr * 0.8, lr * 1.25)
    # 中间几轮写出的副本只是试探，留下最后一轮（和标定前已有的文件）
    final = os.path.basename(material["texture"]["file"])
    for name in set(os.listdir(folder)) - existing - {final}:
        os.remove(os.path.join(folder, name))
    return {"target": [round(float(c), 1) for c in target], "iterations": log, "texture": material["texture"]}


def _preview(args, base, rs, before: dict, after: dict, ref: dict | None, model_dir: str) -> dict:
    face = (ref or {}).get("face", "top")
    front = float((ref or {}).get("front", 0.0))
    b_body, b_tex = preview_body(before, model_dir) if _has_files(before) else (before, base.textures())
    a_body, a_tex = preview_body(after, model_dir)
    textures = {**base.textures(), **b_tex, **a_tex}
    a_body = {**a_body, "entityId": a_body["entityId"] + "-after"}
    fbox = _part_bounds(a_body, args.part, rs.templates)
    rows = []
    metrics = {}
    with tempfile.TemporaryDirectory() as work:
        for oblique in (False, True):
            imgs = _render_part(
                base,
                {"before": b_body, "after": a_body},
                rs.templates,
                textures,
                fbox,
                face,
                front,
                (420, 380),
                work,
                oblique,
            )
            rows.append(imgs)
            if not oblique:
                mask = _mask(imgs["after#mask"])
                scan_px = imgs["scan"][mask & _mask(imgs["scan"])] if mask.any() else np.zeros((0, 3))
                scan_med = np.asarray(ref["median"]["srgb"], float) if ref else robust_median(scan_px)
                for name in ("before", "after"):
                    m = _mask(imgs[f"{name}#mask"])
                    med = robust_median(imgs[name][m])
                    metrics[name] = {
                        "median": [round(float(c), 1) for c in med],
                        "dE": round(delta_e(med, scan_med), 2),
                    }
                metrics["scan"] = [round(float(c), 1) for c in scan_med]
    cols = [("scan", t("扫描", "scan")), ("before", t("之前", "before")), ("after", t("之后", "after"))]
    cw, ch = 420, 380
    sheet = Image.new("RGB", (cw * 3, (ch + 24) * 2 + 30), (24, 26, 30))
    d = ImageDraw.Draw(sheet)
    before_de, after_de = metrics["before"]["dE"], metrics["after"]["dE"]
    title = t(
        f"{after['entityId']} {args.part} · ΔE 之前 {before_de} → 之后 {after_de}",
        f"{after['entityId']} {args.part} · dE before {before_de} → after {after_de}",
    )
    d.text((8, 6), title, font=wc.font(15), fill=(255, 255, 255))
    for r, imgs in enumerate(rows):
        y = 30 + r * (ch + 24)
        for c, (name, label) in enumerate(cols):
            d.text((c * cw + 6, y + 3), label, font=wc.font(13), fill=(255, 220, 120))
            # 渲染用品红底色分出部件，拼图里换成中性灰，免得品红干扰看颜色（边缘抗锯齿混了品红的
            # 一圈像素也去掉）
            keep = binary_erosion(_mask(imgs[name]), iterations=1)
            shown = np.where(keep[..., None], imgs[name], np.array(SHEET_BACKGROUND, float))
            sheet.paste(Image.fromarray(np.clip(shown, 0, 255).astype(np.uint8)), (c * cw, y + 22))
    os.makedirs(os.path.dirname(os.path.abspath(args.preview)) or ".", exist_ok=True)
    wc.save_jpeg(sheet, args.preview, 600_000)
    metrics["image"] = args.preview
    with open(os.path.splitext(args.preview)[0] + ".json", "w", encoding="utf-8") as fh:
        json.dump(metrics, fh, ensure_ascii=False, indent=1)
    return metrics


def _has_files(body: dict) -> bool:
    from ..bundle.textures import texture_slots

    return any(isinstance(m[k], dict) for _, m, k in texture_slots({"entities": [body]}))


def _save_model(path: str, raw: Any, eid: str, body: dict) -> None:
    """改过的物件写回文件（旧的存成 .bak），文件的其余部分不动。"""
    shutil.copyfile(path, path + ".bak")

    def replace(items):
        return [body if isinstance(b, dict) and b.get("entityId") == eid else b for b in items]

    if isinstance(raw, list):
        raw = replace(raw)
    elif isinstance(raw, dict) and raw.get("entityId") == eid:
        raw = body
    elif isinstance(raw, dict):
        for key in ("entities", "bodies", "objects"):
            if isinstance(raw.get(key), list):
                raw[key] = replace(raw[key])
            elif isinstance(raw.get(key), dict) and eid in raw[key]:
                raw[key][eid] = body
    wc.write_json(path, raw)


__all__ = ["cmd_refshot", "cmd_texture", "face_frame", "ortho_extract", "robust_median", "suggest_tile"]
