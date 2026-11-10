"""外部模型物件（模型库里找来的现成模型）：读取、变换、包围盒、本地文件查找、记录校验。

物件记录（AI 物件集的外部模型物件，写回路径按它下载、核对、重新导出、登记成 assetHash）：

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
  `gltf-zip`（压缩包里一个 .gltf 加它引用的文件）。与写回路径收的格式相同（`metaverse_recon.authored`）。
- **material**：`{tint?, opacity?, unlit?}`，`tint` 写回时烘进模型，`opacity`、`unlit` 留在物件上。
- **单位**：处理服务把旋转、缩放烘进模型之后才检查 ±1000 米的坐标上限，厘米单位的模型缩放后可以用。
- **bounds** 按变换后的模型算（`world_bounds`）。
"""

from __future__ import annotations

import functools
import json
import math
import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import numpy as np

from .. import shapes as sh
from ..authored import AuthoredError, model_material, parse_model, validate_source
from ..processing import shape_mesh as sm
from .core import Box, ReconError, r
from .env import cache_dir

DEFAULT_HOSTS = ("dl.polyhaven.org", "huggingface.co")
MAX_MODEL_TRIANGLES = 3_000_000
MAX_MODEL_PIXELS = 8192 * 8192
PROCESSING_COORD_LIMIT = 1000.0  # 处理服务拒收缩放后坐标超过 ±1000 米的外部模型


def allowed_hosts() -> tuple[str, ...]:
    env = os.environ.get("METAVERSE_RECON_MODEL_HOSTS")
    if env:
        return tuple(h.strip().lower() for h in env.split(",") if h.strip())
    return DEFAULT_HOSTS


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
    path: str
    vertices: np.ndarray  # 模型坐标
    faces: np.ndarray
    uv: np.ndarray | None
    texture: np.ndarray | None
    colors: np.ndarray | None
    base_color: tuple[float, float, float, float]

    @property
    def triangles(self) -> int:
        return len(self.faces)

    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        return self.vertices.min(0), self.vertices.max(0)

    def surface_colors(self, n: int = 20000, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
        """表面采样点（模型坐标）和颜色（sRGB 0–255，没有贴图时用顶点色或底色）。"""
        V, F = self.vertices, self.faces
        a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
        area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
        rng = np.random.default_rng(seed)
        p = area / max(area.sum(), 1e-12)
        idx = rng.choice(len(F), size=n, p=p)
        r1, r2 = rng.random(n), rng.random(n)
        s = np.sqrt(r1)
        w = np.c_[1 - s, s * (1 - r2), s * r2]
        f = F[idx]
        P = (V[f] * w[:, :, None]).sum(1)
        if self.texture is not None and self.uv is not None:
            t = (self.uv[f] * w[:, :, None]).sum(1)
            H, W = self.texture.shape[:2]
            px = np.clip((np.mod(t[:, 0], 1.0) * W).astype(int), 0, W - 1)
            py = np.clip((np.mod(t[:, 1], 1.0) * H).astype(int), 0, H - 1)
            C = self.texture[py, px][:, :3].astype(float)
            C *= np.array(self.base_color[:3])
        elif self.colors is not None:
            C = (self.colors[f][:, :, :3].astype(float) * w[:, :, None]).sum(1)
        else:
            C = np.tile(np.array(self.base_color[:3]) * 255, (n, 1))
        return P, np.clip(C, 0, 255)


@functools.lru_cache(maxsize=8)
def _load_cached(path: str, mtime: float) -> LoadedModel:
    from ..errors import InputRejected
    from ..processing.modelimport import load_model

    try:
        mesh, colors, base = load_model(
            path, None, max_triangles=MAX_MODEL_TRIANGLES, max_texture_pixels=MAX_MODEL_PIXELS
        )
    except InputRejected as e:
        raise ReconError(f"读不了模型 {path}：{e}") from e
    return LoadedModel(path, mesh.vertices, mesh.faces, mesh.uv, mesh.texture, colors, base)


def load_model_file(path: str) -> LoadedModel:
    """用处理服务同一个函数读模型（坐标与写回时一致）。"""
    if not os.path.exists(path):
        raise ReconError(f"找不到模型文件 {path}")
    return _load_cached(os.path.abspath(path), os.path.getmtime(path))


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
    # load_model 的贴图坐标是左上角原点（glTF），网格模块用 v 向上
    uv = np.c_[model.uv[:, 0], 1.0 - model.uv[:, 1]] if model.uv is not None else np.zeros((len(V), 2))
    return sm.Mesh(V, vn, uv, F.astype(np.int64))


def world_bounds(body: Mapping[str, Any], model: LoadedModel) -> dict:
    V = world_vertices(body, model)
    return sh.rounded_bounds({"min": V.min(0).tolist(), "max": V.max(0).tolist()})


def model_parts(body: Mapping[str, Any], model: LoadedModel) -> list[sm.Part]:
    mat = {"color": [round(c * 255) for c in model.base_color[:3]]}
    return [sm.Part(world_mesh(body, model), mat, "$model")]


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
    """署名：规则与写回路径、物件记录相同（`authored.validate_source` → `records.validate_model_source`）。"""
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
    if host not in hosts:
        errors.append(f"{what} 的主机 {host} 不在允许的列表里（{', '.join(hosts)}）")


def model_ref(model: Mapping[str, Any]) -> dict[str, Any]:
    """写回用的 `model`：只留 url、sha256、size、format，gltf 的附属文件写成 `{相对路径: {url, sha256, size}}`
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
    """外部模型物件的校验：返回 (错误, 提示)。`model`、`material`、署名按写回路径的规则
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
