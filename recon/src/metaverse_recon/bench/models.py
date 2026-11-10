"""外部模型物件（模型库里找来的现成模型）：读取、变换、包围盒、本地文件查找、记录校验。

物件记录（AI 物件集的外部模型物件，打包时按它下载、核对、重新导出，换成 assetHash）：

```json
{ "entityId": "sofa-01", "layer": "rebuilt", "kind": "object", "label": "沙发",
  "model": { "url": "https://huggingface.co/…/<uid>.glb", "sha256": "…", "size": 123456, "format": "glb" },
  "transform": { "position": [x, y, z], "yaw": 0, "pitch": 0, "roll": 0, "scale": [sx, sy, sz] },
  "bounds": { "min": […], "max": […] },
  "material": { "tint": [r, g, b] },                       // 可选：给整个模型调色
  "props": { "category": "sofa",
             "source": { "library": "objaverse", "id": "<uid>", "page": "https://sketchfab.com/3d-models/<uid>",
                         "author": "…", "license": "CC-BY-4.0", "title": "…" } } }
```

- **坐标**：`transform` 作用于模型按 `processing.modelimport.load_model` 读出的坐标（glTF 的节点变换已经展开，
  单位按米理解），顺序与 SHAPES 相同：`M = T · Ry(yaw) · Rx(pitch) · Rz(roll) · S`。所以向上轴不对的模型用
  `pitch` / `roll` 的 90° 倍数摆正，`scale` 是沿模型原始坐标轴的缩放。
- **格式**：`glb`（一个文件）；`gltf`（Poly Haven：`url` 是 .gltf 文件，`files` 是
  `{相对 .gltf 的路径: {url, sha256, size}}`，列出它引用的 .bin 和贴图；`pack_gltf` 把它们打包成 glb）；
  `gltf-zip`（压缩包里一个 .gltf 加它引用的文件）。与打包流程收的格式相同（`metaverse_recon.authored`）。
- **material**：`{tint?, opacity?, unlit?, shading?}`，`tint` 打包时烘进模型，其余留在物件上（`shading`
  不写时打包写成 `albedo`）。
- **单位**：处理服务把旋转、缩放烘进模型之后才检查 ±1000 米的坐标上限，厘米单位的模型缩放后可以用。
- **bounds** 按变换后的模型算（`world_bounds`）。
"""

from __future__ import annotations

import functools
import hashlib
import io
import json
import math
import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import numpy as np
from PIL import Image

from .. import shapes as sh
from ..authored import AuthoredError, model_material, parse_model, validate_source
from ..fetch import host_allowed, parse_hosts
from ..processing import shape_mesh as sm
from ..processing.modelexport import SourceModel, read_model
from ..records import rotated_model_bounds
from .core import Box, ReconError, r
from .env import cache_dir

MAX_MODEL_TRIANGLES = 3_000_000
MAX_MODEL_PIXELS = 8192 * 8192
PROCESSING_COORD_LIMIT = 1000.0  # 处理服务拒收缩放后坐标超过 ±1000 米的外部模型


def allowed_hosts() -> tuple[str, ...]:
    """外部模型允许的主机：与打包下载用同一份列表和匹配规则（`fetch.parse_hosts`、`fetch.host_allowed`）。"""
    return parse_hosts(os.environ.get("METAVERSE_RECON_MODEL_HOSTS"))


def models_dir() -> str:
    path = os.path.join(cache_dir(), "models")
    os.makedirs(path, exist_ok=True)
    return path


def transform_matrix(xf: Mapping[str, Any] | None) -> np.ndarray:
    return sm.transform_matrix(xf or {})


def column_major(m: np.ndarray) -> list[float]:
    return [float(v) for v in np.asarray(m, float).T.reshape(-1)]


@dataclass
class LoadedModel:
    """读进来的外部模型（`processing.modelexport.read_model`：节点变换已经展开，按材质分开）。"""

    path: str
    source: SourceModel
    vertices: np.ndarray  # 模型坐标，全部图元合在一起
    faces: np.ndarray
    face_material: np.ndarray

    @property
    def triangles(self) -> int:
        return len(self.faces)

    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        return self.vertices.min(0), self.vertices.max(0)

    @property
    def textured(self) -> bool:
        return any(m.image is not None for m in self.source.materials)

    def texture_sides(self) -> list[int]:
        """每张底色贴图的长边（只读文件头）。"""
        out = []
        for i in sorted({m.image for m in self.source.materials if m.image is not None}):
            with Image.open(io.BytesIO(self.source.images[i])) as img:
                out.append(int(max(img.size)))
        return out

    def surface_colors(self, n: int = 20000, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
        """表面采样点（模型坐标）和颜色（sRGB 0–255）：贴图按重复采样（平铺贴图照样对），乘上材质底色。"""
        V, F = self.vertices, self.faces
        a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
        area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
        rng = np.random.default_rng(seed)
        idx = rng.choice(len(F), size=n, p=area / max(area.sum(), 1e-12))
        r1, r2 = rng.random(n), rng.random(n)
        s = np.sqrt(r1)
        w = np.c_[1 - s, s * (1 - r2), s * r2]
        P = (V[F[idx]] * w[:, :, None]).sum(1)
        out = np.zeros((n, 3))
        offsets = np.cumsum([0] + [len(p.faces) for p in self.source.primitives])
        bases = np.cumsum([0] + [len(p.positions) for p in self.source.primitives])
        prim_of = np.searchsorted(offsets, idx, side="right") - 1
        for pi, prim in enumerate(self.source.primitives):
            rows = np.nonzero(prim_of == pi)[0]
            if not len(rows):
                continue
            mat = self.source.materials[prim.material]
            lin = np.asarray(mat.base_color[:3], float)
            local = F[idx[rows]] - bases[pi]
            if mat.image is not None and prim.uv is not None:
                tex = self._texture(mat.image)
                t = (prim.uv[local] * w[rows][:, :, None]).sum(1)
                H, W = tex.shape[:2]
                px = np.clip((np.mod(t[:, 0], 1.0) * W).astype(int), 0, W - 1)
                py = np.clip((np.mod(t[:, 1], 1.0) * H).astype(int), 0, H - 1)
                rgb = _srgb_to_linear(tex[py, px][:, :3] / 255.0) * lin
            elif prim.colors is not None:
                rgb = (prim.colors[local][:, :, :3] * w[rows][:, :, None]).sum(1) * lin
            else:
                rgb = np.tile(lin, (len(rows), 1))
            out[rows] = _linear_to_srgb(rgb) * 255
        return P, np.clip(out, 0, 255)

    def _texture(self, image: int) -> np.ndarray:
        cache = self.__dict__.setdefault("_textures", {})
        if image not in cache:
            with Image.open(io.BytesIO(self.source.images[image])) as img:
                img.thumbnail((1024, 1024))
                cache[image] = np.asarray(img.convert("RGB"))
        return cache[image]


def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


@functools.lru_cache(maxsize=8)
def _load_cached(path: str, mtime: float) -> LoadedModel:
    from ..errors import InputRejected

    try:
        source = read_model(path, max_triangles=MAX_MODEL_TRIANGLES, max_pixels=MAX_MODEL_PIXELS)
    except InputRejected as e:
        raise ReconError(f"读不了模型 {path}：{e}") from e
    vertices, faces, face_material = source.merged()
    return LoadedModel(path, source, vertices, faces, face_material)


def load_model_file(path: str) -> LoadedModel:
    """用打包同一个读取函数读模型（坐标与 `models`、`bundle` 导出时一致）。"""
    if not os.path.exists(path):
        raise ReconError(f"找不到模型文件 {path}")
    return _load_cached(os.path.abspath(path), os.path.getmtime(path))


# ---------------------------------------------------------------------------- 按导出后的样子看


@dataclass(frozen=True)
class Exported:
    """外部模型按打包时同样的步骤导出后的 glb（缓存在 `<缓存>/exports/`）和它在空间里的摆法。"""

    path: str  # 导出的 glb
    sha256: str
    yaw: float  # 写进物件记录 transform 的偏航
    origin: np.ndarray  # glb 原点在空间里的位置
    local_bounds: dict  # glb 自己的包围盒（原点在底面中心）
    bounds: dict  # 记录要写的 bounds（模型包围盒按偏航转过之后的外包，摆到 origin）
    triangles: int
    bytes: int
    textures: list
    materials: int
    source_triangles: int

    @property
    def matrix(self) -> np.ndarray:
        """glb 坐标 → 空间坐标：`T(origin) · Ry(yaw)`。"""
        m = transform_matrix({"yaw": self.yaw})
        m[:3, 3] = self.origin
        return m


def _file_sha(path: str) -> str:
    return _file_sha_cached(os.path.abspath(path), os.path.getmtime(path), os.path.getsize(path))


@functools.lru_cache(maxsize=64)
def _file_sha_cached(path: str, mtime: float, size: int) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def export_limits() -> dict[str, int]:
    """工作台导出用的上限：工作区里有 limits.json 时按它（与打包相同），否则用默认值。"""
    from ..bundle.limits import load_upload_limits, processing_limits
    from ..processing.authored_build import export_limits as caps
    from .workspace import LIMITS_FILE, default_path

    return caps(processing_limits(load_upload_limits(default_path(None, LIMITS_FILE))))


def export_model_file(local: str, transform: Mapping[str, Any] | None, tint: Any) -> Exported:
    """外部模型按打包时同样的步骤导出（`processing.modelexport.export_model`：缩放、俯仰、翻滚、调色烘进模型，
    减面、缩小贴图），导出结果按（文件、烘进去的变换、调色、上限）缓存；偏航和平移只决定摆法。"""
    from ..processing.authored_build import split_transform
    from ..processing.modelexport import export_model, variant_key

    xf = dict(transform or {})
    lin, yaw, position = split_transform(xf)
    caps = export_limits()
    key = variant_key(_file_sha(local), lin, tint, caps)
    folder = os.path.join(cache_dir(), "exports")
    os.makedirs(folder, exist_ok=True)
    glb, meta = os.path.join(folder, f"{key}.glb"), os.path.join(folder, f"{key}.json")
    info = None
    if os.path.exists(glb) and os.path.exists(meta):
        try:
            with open(meta, encoding="utf-8") as fh:
                info = json.load(fh)
        except (OSError, ValueError):
            info = None
    if info is None:
        from ..errors import InputRejected

        try:
            model = export_model(
                load_model_file(local).source,
                linear=lin,
                tint=tint,
                max_triangles=caps["triangles"],
                max_texture_side=caps["side"],
                max_texture_pixels=caps["pixels"],
                max_decode_pixels=MAX_MODEL_PIXELS,
            )
        except InputRejected as e:
            raise ReconError(f"导出模型 {local} 失败：{e}") from e
        with open(glb, "wb") as fh:
            fh.write(model.data)
        info = {
            "sha256": hashlib.sha256(model.data).hexdigest(),
            "origin": model.origin,
            "bounds": model.bounds,
            "triangles": model.triangles,
            "bytes": len(model.data),
            "textures": model.textures,
            "materials": model.materials,
            "sourceTriangles": model.source_triangles,
        }
        with open(meta, "w", encoding="utf-8") as fh:
            json.dump(info, fh)
    rot = {"yaw": yaw} if yaw else {}
    origin = position + transform_matrix(rot)[:3, :3] @ np.asarray(info["origin"], float)
    turned = rotated_model_bounds(info["bounds"], rot)
    bounds = sh.rounded_bounds(
        {
            "min": (np.asarray(turned["min"]) + origin).tolist(),
            "max": (np.asarray(turned["max"]) + origin).tolist(),
        }
    )
    return Exported(
        path=glb,
        sha256=info["sha256"],
        yaw=yaw,
        origin=origin,
        local_bounds=info["bounds"],
        bounds=bounds,
        triangles=int(info["triangles"]),
        bytes=int(info["bytes"]),
        textures=list(info["textures"]),
        materials=int(info["materials"]),
        source_triangles=int(info["sourceTriangles"]),
    )


def exported_render(body: Mapping[str, Any], local: str, **extra: Any) -> dict[str, Any]:
    """渲染页的模型选项：导出后的 glb，按记录的摆法放好；着色方式按物件的 `material.shading`（打包时外部模型
    默认 albedo），调色已经烘进模型。"""
    look = body.get("material") or {}
    ex = export_model_file(local, body.get("transform"), look.get("tint"))
    out = {
        "path": ex.path,
        "matrix": column_major(ex.matrix),
        "lit": True,
        "shading": look.get("shading") or "albedo",
        "opacity": look.get("opacity"),
        "unlit": look.get("unlit"),
    }
    out.update(extra)
    return out


def exported_mesh(body: Mapping[str, Any], local: str) -> sm.Mesh:
    """导出后的模型摆好以后的网格（空间坐标），偏差计算用：与打包时算 `fit` 的网格相同。"""
    from ..processing.modelexport import read_gltf

    look = body.get("material") or {}
    ex = export_model_file(local, body.get("transform"), look.get("tint"))
    src = read_gltf(ex.path, max_triangles=MAX_MODEL_TRIANGLES, max_pixels=MAX_MODEL_PIXELS)
    V, F, _ = src.merged()
    m = ex.matrix
    W = V @ m[:3, :3].T + m[:3, 3]
    return sm.Mesh(W, np.zeros_like(W), np.zeros((len(W), 2)), F.astype(np.int64))


def world_vertices(body: Mapping[str, Any], model: LoadedModel) -> np.ndarray:
    m = transform_matrix(body.get("transform"))
    return model.vertices @ m[:3, :3].T + m[:3, 3]


def world_mesh(body: Mapping[str, Any], model: LoadedModel) -> sm.Mesh:
    V = world_vertices(body, model)
    F = model.faces
    if np.linalg.det(transform_matrix(body.get("transform"))[:3, :3]) < 0:
        F = F[:, [0, 2, 1]]
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    fn = np.cross(b - a, c - a)
    vn = np.zeros_like(V)
    for k in range(3):
        np.add.at(vn, F[:, k], fn)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
    return sm.Mesh(V, vn, np.zeros((len(V), 2)), F.astype(np.int64))


def world_bounds(body: Mapping[str, Any], model: LoadedModel) -> dict:
    V = world_vertices(body, model)
    return sh.rounded_bounds({"min": V.min(0).tolist(), "max": V.max(0).tolist()})


def model_parts(body: Mapping[str, Any], model: LoadedModel) -> list[sm.Part]:
    """偏差计算用的网格块：按导出后的样子（与打包时算 `fit` 的网格相同）。"""
    return [sm.Part(exported_mesh(body, model.path), {"color": [200, 200, 200]}, "$model")]


# ---------------------------------------------------------------------------- 本地文件


def sidecars(extra_dirs: list[str] | None = None):
    """缓存目录和额外目录下的全部 model.json（fetch 写的旁注）。"""
    roots = [models_dir(), *(extra_dirs or [])]
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, _, files in os.walk(root):
            if "model.json" in files:
                path = os.path.join(dirpath, "model.json")
                try:
                    with open(path, encoding="utf-8") as fh:
                        yield path, json.load(fh)
                except (OSError, json.JSONDecodeError):
                    continue


def find_local(body: Mapping[str, Any], extra_dirs: list[str] | None = None) -> str | None:
    """找物件引用的模型在本机的文件（fetch 下载、打包好的 glb）：按 model.sha256 和来源（库 + 编号）匹配。"""
    model = body.get("model") or {}
    sha = model.get("sha256")
    src = (body.get("props") or {}).get("source") or {}
    best = None
    for path, side in sidecars(extra_dirs):
        local = os.path.join(os.path.dirname(path), (side.get("local") or {}).get("path", "model.glb"))
        if not os.path.exists(local):
            continue
        if sha and (side.get("model") or {}).get("sha256") == sha:
            return local
        if src and side.get("library") == src.get("library") and str(side.get("id")) == str(src.get("id")):
            best = best or local
    return None if sha else best


# ---------------------------------------------------------------------------- 校验


def _check_transform(xf: Any, errors: list[str]) -> None:
    try:
        sh._validate_transform("$.transform", xf)
    except sh.ShapeError as e:
        errors.append(f"transform 不合法：{e}")


def check_source(src: Any) -> list[str]:
    """署名：规则与打包流程、物件记录相同（`authored.validate_source` → `records.validate_model_source`）。"""
    if not isinstance(src, Mapping):
        return ["缺少 props.source（署名：library、id、page、author、license、title）"]
    try:
        validate_source(src, "props.source")
    except AuthoredError as e:
        return [str(e)]
    return []


def _check_url(url: Any, what: str, hosts: tuple[str, ...], errors: list[str]) -> None:
    if not isinstance(url, str) or not url.startswith("https://"):
        return  # 结构问题由 parse_model 报
    host = (urlparse(url).hostname or "").lower()
    if not host_allowed(url, hosts):
        errors.append(f"{what} 的主机 {host} 不在允许的列表里（{', '.join(hosts)}）")


def model_ref(model: Mapping[str, Any]) -> dict[str, Any]:
    """打包用的 `model`：只留 url、sha256、size、format，gltf 的附属文件写成 `{相对路径: {url, sha256, size}}`
    （旧版 fetch 旁注里是 `[{path, url, sha256, size}]`，这里一并换过来）。"""
    out = {k: model[k] for k in ("url", "sha256", "size", "format") if k in model}
    files = model.get("files")
    if isinstance(files, list):
        files = {
            f["path"]: {k: f[k] for k in ("url", "sha256", "size") if k in f}
            for f in files
            if isinstance(f, Mapping) and isinstance(f.get("path"), str)
        }
    if files:
        out["files"] = {p: dict(files[p]) for p in sorted(files)}
    return out


def check_model_entity(
    body: Mapping[str, Any], hosts: tuple[str, ...] | None = None
) -> tuple[list[str], list[str]]:
    """外部模型物件的校验：返回 (错误, 提示)。`model`、`material`、署名按打包流程的规则
    （`metaverse_recon.authored`），另外检查地址的主机在允许列表里、bounds 已经算好。"""
    hosts = hosts or allowed_hosts()
    errors: list[str] = []
    warnings: list[str] = []
    if body.get("shape") is not None:
        errors.append("外部模型物件不能同时有 shape")
    if body.get("assetHash") is not None:
        errors.append("AI 物件集不能带 assetHash：外部模型用 model（url、sha256、size、format）给出")
    model = body.get("model")
    if not isinstance(model, Mapping):
        errors.append("缺少 model（url、sha256、size、format）")
    else:
        try:
            parsed = parse_model(model, "model")
        except AuthoredError as e:
            errors.append(str(e))
        else:
            _check_url(parsed["url"], "model.url", hosts, errors)
            for f in parsed["files"]:
                _check_url(f["url"], f"model.files[{f['path']!r}].url", hosts, errors)
    xf = body.get("transform")
    if xf is None:
        warnings.append("没有 transform：按模型原始坐标摆放")
    else:
        _check_transform(xf, errors)
    if not isinstance(body.get("bounds"), Mapping):
        errors.append("缺少 bounds（用 place 或 assemble 按模型算）")
    try:
        model_material(body.get("material"), "material")
    except AuthoredError as e:
        errors.append(str(e))
    errors += check_source((body.get("props") or {}).get("source"))
    return errors, warnings


def yaw_of(xf: Mapping[str, Any] | None) -> float:
    return float((xf or {}).get("yaw", 0.0))


def describe_transform(xf: Mapping[str, Any]) -> str:
    s = xf.get("scale", [1, 1, 1])
    return (
        f"位置 {r(xf.get('position', [0, 0, 0]), 3)} 偏航 {xf.get('yaw', 0)}° 俯仰 {xf.get('pitch', 0)}° "
        f"翻滚 {xf.get('roll', 0)}° 缩放 {r(s, 4)}"
    )


def bounds_of(V: np.ndarray) -> Box:
    return Box(V.min(0), V.max(0))


def angle_close(a: float, b: float, tol: float) -> bool:
    d = (a - b + 180) % 360 - 180
    return abs(d) <= tol or math.isclose(abs(d), 0, abs_tol=tol)
