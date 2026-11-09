"""AI 物件集的计算部分（设计 6.3，子进程里调用，不碰数据库和网络）。

输入是 `authored.parse_authored` 整理过的物件集和父进程下载好的外部模型文件，输出与 `rebuild.rebuild` 同样的
`{entities, textures, ...}`，另加处理后的模型文件、逐件偏差和烘焙统计：

1. **结构**：`keep` 时在扫描上跑结构算法（地面、墙、玻璃，与平常的重建相同），`replace` 时只用物件集里
   `kind: structure` 的物件；
2. **外部模型**：读模型（glb；gltf-zip 先安全解压，gltf 由父进程按相对路径摆好）→ 把 `transform`（旋转、缩放）
   和 `tint` 烘进网格 → 按物件模型的限制减面、缩小贴图 → 以包围盒的底面中心为原点写成 glb（网站按物件
   `bounds` 的底面中心摆放只有 `assetHash` 的物件，平移落在 `bounds` 上）。旋转、缩放、调色都相同的物件
   共用同一个 glb；
3. **烘焙**：带 `bake` 的部件按网站同样的投影展开 UV（同一个材质节点下的部件共用一张图），每个纹素落到
   部件表面的一点，取扫描最近表面（法线相容优先）的颜色，没采到的纹素用 push-pull 补；附近完全没有扫描时
   退回后备纯色；
4. **偏差**：物件包围盒水平和向上各外扩 5 厘米、底面以上 1 厘米（不算地面）范围内的扫描表面密集采样，
   求到物件网格的距离，写成 `fit {meanCm, p90Cm, coverage3cm}`；范围里几乎没有扫描时不写。

采样的随机数按物件编号固定，同样的输入得到同样的贴图、偏差和记录哈希（重新重建没有变化就不提交）。
"""

from __future__ import annotations

import copy
import hashlib
import math
import os
import posixpath
import zipfile
import zlib
from collections.abc import Mapping
from typing import Any

import numpy as np

from .. import shapes as sh
from ..authored import node_at, shape_textures
from ..canonical import canonical_json
from ..errors import InputRejected, PermanentJobError
from ..records import RecordError, validate_entity_body
from ..shapes import ShapeError
from .bake import FaceTable, push_pull
from .fit_texture import (
    ColorSource,
    SurfaceIndex,
    TextureParams,
    _rasterize,
    encode_jpeg,
    fit_stats,
)
from .modelimport import MAX_MODEL_COORD, load_model, simplify_for_export, write_model
from .rebuild import structure_entities
from .scan import ScanMesh
from .shape_mesh import Mesh, build_parts, merge_meshes, transform_matrix
from .sniff import MAX_ZIP_MEMBERS, _copy_member
from .structure import StructureParams, extract_structure

FIT_MARGIN = 0.05  # 偏差范围：包围盒水平和向上外扩 5 厘米
FIT_FLOOR_SKIP = 0.01  # 包围盒底面以上 1 厘米以下的扫描不算（地面）
FIT_DENSITY = 20_000.0  # 每平方米采样点数
MAX_FIT_POINTS = 20_000
MIN_FIT_POINTS = 20
BAKE_MARGIN = 0.05
BAKE_DENSITY = 40_000.0
MAX_BAKE_POINTS = 400_000
MAX_GLTF_ZIP_MEMBERS = 64
GLTF_MAIN = "model.gltf"  # 父进程摆好的 gltf 主文件名（format gltf）


def _seed(*parts: str) -> int:
    return zlib.crc32("\0".join(parts).encode())


# ---------------------------------------------------------------------------- 扫描采样


def scan_points(
    table: FaceTable, lo: np.ndarray, hi: np.ndarray, density: float, max_points: int, seed: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """盒子 [lo, hi] 里的扫描表面密集采样：返回 (点, 颜色 uint8, 法线)，最多 `max_points` 个点。"""
    ids = table.faces_in_box(lo, hi)
    if len(ids) == 0:
        return np.zeros((0, 3)), np.zeros((0, 3), np.uint8), np.zeros((0, 3))
    area = float(table.area[ids].sum())
    rng = np.random.default_rng(seed)
    P, C, N = table.dense(ids, min(density, max_points / max(area, 1e-9)), rng)
    inside = np.all((lo <= P) & (hi >= P), axis=1)
    P, C, N = P[inside], C[inside], N[inside]
    if len(P) > max_points:
        keep = np.sort(rng.choice(len(P), max_points, replace=False))
        P, C, N = P[keep], C[keep], N[keep]
    return P, C, N


def fit_box(bounds: Mapping[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    lo = np.asarray(bounds["min"], float) - [FIT_MARGIN, 0.0, FIT_MARGIN]
    lo[1] = float(bounds["min"][1]) + FIT_FLOOR_SKIP
    hi = np.asarray(bounds["max"], float) + FIT_MARGIN
    return lo, hi


def entity_fit(
    meshes: list[Mesh], table: FaceTable, bounds: Mapping[str, Any], eid: str
) -> tuple[dict[str, float] | None, int]:
    """扫描点到物件网格的偏差（见模块说明第 4 条）。返回 (fit 或 None, 采样点数)。"""
    meshes = [m for m in meshes if len(m.indices)]
    if not meshes:
        return None, 0
    lo, hi = fit_box(bounds)
    P, _, _ = scan_points(table, lo, hi, FIT_DENSITY, MAX_FIT_POINTS, _seed("fit", eid))
    if len(P) < MIN_FIT_POINTS:
        return None, len(P)
    index = SurfaceIndex.build(meshes, spacing=0.01, seed=_seed("surface", eid))
    d, _, _ = index.query(P, k=4)
    return fit_stats(d), len(P)


# ---------------------------------------------------------------------------- 烘焙


def uv_extents(mesh: Mesh) -> tuple[float, float]:
    """贴图 u、v 方向每单位对应的世界长度（按面积加权的中位数），用来定贴图的像素数。"""
    tri = mesh.positions[mesh.indices]
    uv = mesh.uvs[mesh.indices]
    e1, e2 = tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]
    d1, d2 = uv[:, 1] - uv[:, 0], uv[:, 2] - uv[:, 0]
    det = d1[:, 0] * d2[:, 1] - d2[:, 0] * d1[:, 1]
    ok = np.abs(det) > 1e-12
    if not ok.any():
        return 0.0, 0.0
    e1, e2, d1, d2, det = e1[ok], e2[ok], d1[ok], d2[ok], det[ok]
    # [e1 e2] = J · [d1 d2]，J 的两列就是 dP/du、dP/dv
    du = (e1 * d2[:, 1:2] - e2 * d1[:, 1:2]) / det[:, None]
    dv = (e2 * d1[:, 0:1] - e1 * d2[:, 0:1]) / det[:, None]
    area = np.linalg.norm(np.cross(e1, e2), axis=1)

    def weighted_median(v: np.ndarray) -> float:
        order = np.argsort(v)
        cum = np.cumsum(area[order])
        return float(v[order][np.searchsorted(cum, cum[-1] / 2)])

    return weighted_median(np.linalg.norm(du, axis=1)), weighted_median(np.linalg.norm(dv, axis=1))


def bake_mesh(mesh: Mesh, src: ColorSource, mode: str, size_hint: float, tp: TextureParams) -> bytes | None:
    """按网格自己的 UV 烘焙一张贴图（JPEG）。附近没有扫描颜色时返回 None。"""
    if len(mesh.indices) == 0 or src.tree is None:
        return None
    texel = float(np.interp(size_hint, [1.0, 3.0], [tp.texel_small, tp.texel_large]))
    max_px = tp.max_px_large if size_hint > 1.5 else tp.max_px
    eu, ev = uv_extents(mesh)
    W = int(np.clip(math.ceil(eu / texel), 16, max_px))
    H = int(np.clip(math.ceil(ev / texel), 16, max_px))
    tri_p = mesh.positions[mesh.indices]
    tri_n = np.cross(tri_p[:, 1] - tri_p[:, 0], tri_p[:, 2] - tri_p[:, 0])
    tri_n /= np.maximum(np.linalg.norm(tri_n, axis=1, keepdims=True), 1e-12)
    if mode == "cylindrical":
        center = (mesh.positions.min(0) + mesh.positions.max(0)) / 2
        radial = tri_p.mean(1) - center
        radial[:, 1] = 0
        radial /= np.maximum(np.linalg.norm(radial, axis=1, keepdims=True), 1e-9)
        priority = (tri_n * radial).sum(1)
    else:
        # 正反两面落在同一纹素时，扫描里看得更多的那一面优先
        pref = src.N.mean(0)
        priority = tri_n @ (pref / max(float(np.linalg.norm(pref)), 1e-9))
    pos, nrm, covered = _rasterize(mesh, W, H, priority)
    flat = covered.ravel()
    cols, ok = src.colors_at(pos.reshape(-1, 3)[flat], nrm.reshape(-1, 3)[flat])
    acc = np.zeros((H * W, 3))
    weight = np.zeros(H * W)
    hit = np.nonzero(flat)[0][ok]
    acc[hit] = cols[ok]
    weight[hit] = 1.0
    if weight.sum() < 16:
        return None
    filled = push_pull(acc.reshape(H, W, 3), weight.reshape(H, W))
    return encode_jpeg(np.clip(np.round(filled), 0, 255).astype(np.uint8), tp.jpeg_quality)


def bake_entity(
    eid: str,
    body: dict[str, Any],
    bakes: list[Mapping[str, Any]],
    templates: Mapping[str, Any],
    table: FaceTable,
    textures: dict[str, bytes],
    tp: TextureParams | None = None,
) -> dict[str, int]:
    """把物件形状里的烘焙指令换成贴图（就地修改 `body["shape"]`）。返回 {parts, textured, fallback}。"""
    tp = tp or TextureParams()
    shape = body["shape"]
    marks: dict[str, Mapping[str, Any]] = {}
    for b in bakes:
        mark = hashlib.sha256(f"bake\0{eid}\0{b['path']}".encode()).hexdigest()
        node_at(shape, b["path"])["material"] = {"texture": mark, "uv": b["uv"]}
        marks[mark] = b
    parts = build_parts(shape, templates)
    lo = np.asarray(body["bounds"]["min"], float) - BAKE_MARGIN
    hi = np.asarray(body["bounds"]["max"], float) + BAKE_MARGIN
    P, C, N = scan_points(table, lo, hi, BAKE_DENSITY, MAX_BAKE_POINTS, _seed("bake", eid))
    src = ColorSource(P, C, N)
    size_hint = float(np.max(hi - lo))
    stats = {"parts": len(marks), "textured": 0, "fallback": 0}
    for mark, b in marks.items():
        mesh = merge_meshes([p.mesh for p in parts if (p.material or {}).get("texture") == mark])
        data = bake_mesh(mesh, src, b["uv"], size_hint, tp)
        node = node_at(shape, b["path"])
        if data is None:
            node["material"] = {"color": list(b["fallback"]), **b["keep"]}
            stats["fallback"] += 1
            continue
        sha = hashlib.sha256(data).hexdigest()
        textures[sha] = data
        node["material"] = {"texture": sha, "uv": b["uv"], **b["keep"]}
        stats["textured"] += 1
    return stats


# ---------------------------------------------------------------------------- 外部模型


def extract_gltf_zip(path: str, out_dir: str, max_total_bytes: int) -> str:
    """gltf-zip：按包里的相对路径安全解压（不许绝对路径和 ..），返回唯一的 `.gltf` 的路径。"""
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as error:
        raise InputRejected(f"gltf-zip 无法打开：{error}") from error
    with zf:
        infos = [
            i
            for i in zf.infolist()
            if not i.is_dir()
            and "__MACOSX" not in i.filename.split("/")
            and not posixpath.basename(i.filename).startswith(".")
        ]
        if not infos or len(infos) > min(MAX_GLTF_ZIP_MEMBERS, MAX_ZIP_MEMBERS):
            raise InputRejected(f"gltf-zip 的文件数必须在 1–{MAX_GLTF_ZIP_MEMBERS} 之间")
        if sum(i.file_size for i in infos) > max_total_bytes:
            raise InputRejected("gltf-zip 解压后超过大小上限")
        names = []
        for info in infos:
            name = info.filename
            if info.flag_bits & 0x1:
                raise InputRejected("不支持加密的压缩包")
            if (
                "\\" in name
                or name.startswith("/")
                or ".." in name.split("/")
                or posixpath.normpath(name) != name
            ):
                raise InputRejected(f"gltf-zip 里的路径 {name!r} 不合法")
            names.append(name)
        gltfs = [n for n in names if n.lower().endswith(".gltf")]
        if len(gltfs) != 1:
            raise InputRejected("gltf-zip 里必须正好有一个 .gltf 文件")
        root = os.path.realpath(out_dir)
        for info, name in zip(infos, names, strict=True):
            dest = os.path.realpath(os.path.join(root, name))
            if not dest.startswith(root + os.sep):
                raise InputRejected(f"gltf-zip 里的路径 {name!r} 不合法")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            _copy_member(zf, info.filename, dest, max_total_bytes)
        return os.path.join(root, gltfs[0])


def load_source(source: Mapping[str, Any], workdir: str, limits: Mapping[str, int]):
    """父进程下载好的外部模型 → (网格 + 可选贴图, 顶点颜色或 None, 材质底色)。"""
    fmt, path = source["format"], source["path"]
    if fmt == "gltf-zip":
        path = extract_gltf_zip(path, os.path.join(workdir, "unzipped"), int(limits["max_model_bytes"]) * 4)
    elif fmt == "gltf":
        path = os.path.join(path, GLTF_MAIN)
    elif fmt != "glb":
        raise PermanentJobError(f"不认识的模型格式 {fmt}")
    try:
        return load_model(
            path,
            None,
            max_triangles=int(limits["max_triangles"]),
            max_texture_pixels=int(limits["max_texture_pixels"]),
            coord_limit=None,  # 模型库的模型常用厘米等单位：缩放之后再检查（placed_mesh）
        )
    except InputRejected:
        raise
    except Exception as error:  # 第三方库读不了的文件（缺文件、格式错误等）
        raise InputRejected(f"读不了模型：{type(error).__name__}: {error}") from error


def _linear(transform: Mapping[str, Any]) -> np.ndarray:
    xf = {k: v for k, v in transform.items() if k != "position"}
    return transform_matrix(xf)[:3, :3]


def placed_mesh(
    mesh: ScanMesh, colors: np.ndarray | None, base: tuple, transform: Mapping[str, Any], tint: Any
) -> tuple[ScanMesh, np.ndarray | None, tuple]:
    """把旋转、缩放（不含平移）和调色烘进网格。镜像时翻转三角形绕向。缩放后的坐标超出 ±1000 米时拒收。"""
    lin = _linear(transform)
    faces = mesh.faces if np.linalg.det(lin) > 0 else mesh.faces[:, [0, 2, 1]]
    out = ScanMesh(mesh.vertices @ lin.T, faces, mesh.uv, mesh.texture)
    if np.abs(out.vertices).max() > MAX_MODEL_COORD:
        raise InputRejected(f"模型缩放后的坐标超出 ±{MAX_MODEL_COORD:g} 米（scale 是不是没按模型单位换算）")
    if tint is not None:
        k = np.asarray(tint, np.float64) / 255.0
        if out.texture is not None:
            tex = out.texture.astype(np.float64)
            tex[..., :3] *= k
            out.texture = np.clip(np.round(tex), 0, 255).astype(np.uint8)
        if colors is not None:
            c = colors.astype(np.float64)
            c[:, :3] *= k
            colors = np.clip(np.round(c), 0, 255).astype(np.uint8)
        base = (base[0] * k[0], base[1] * k[1], base[2] * k[2], base[3])
    return out, colors, base


def export_models(
    authored: Mapping[str, Any],
    sources: Mapping[str, Mapping[str, Any]],
    workdir: str,
    limits: Mapping[str, int],
) -> tuple[dict[str, dict], dict[str, dict]]:
    """外部模型物件 → glb 文件。返回 ({资源哈希: 文件信息}, {物件编号: {hash, origin, mesh}})。

    `origin` 是 glb 原点在空间里的位置（物件平移 + 包围盒底面中心），`mesh` 是导出后的网格（局部坐标）。
    """
    os.makedirs(os.path.join(workdir, "models"), exist_ok=True)
    loaded: dict[str, Any] = {}
    exported: dict[str, tuple[str, np.ndarray, Mesh]] = {}
    files: dict[str, dict] = {}
    placed: dict[str, dict] = {}
    for eid, item in sorted(authored["models"].items()):
        key = item["source"]
        if key not in loaded:
            if key not in sources:
                raise PermanentJobError(f"物件 {eid} 的模型没有下载")
            loaded[key] = load_source(sources[key], os.path.join(workdir, f"src-{key[:16]}"), limits)
        transform = item.get("transform") or {}
        variant = canonical_json(
            {
                "source": key,
                "xf": {k: v for k, v in transform.items() if k != "position"},
                "tint": item.get("tint"),
            }
        )
        if variant not in exported:
            mesh, colors, base = placed_mesh(*loaded[key], transform, item.get("tint"))
            source_triangles = mesh.triangle_count
            mesh, colors = simplify_for_export(mesh, colors, int(limits["model_max_triangles"]))
            lo, hi = mesh.vertices.min(axis=0), mesh.vertices.max(axis=0)
            c0 = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2])
            local = ScanMesh(mesh.vertices - c0, mesh.faces, mesh.uv, mesh.texture)
            model = write_model(
                local,
                colors,
                base,
                max_texture_side=int(limits["model_max_texture_side"]),
                source_triangles=source_triangles,
            )
            sha = hashlib.sha256(model.data).hexdigest()
            path = os.path.join(workdir, "models", f"{sha}.glb")
            with open(path, "wb") as fh:
                fh.write(model.data)
            files[sha] = {
                "path": path,
                "bytes": len(model.data),
                "triangles": model.triangles,
                "vertices": model.vertices,
                "textureSide": model.texture_side,
                "sourceTriangles": model.source_triangles,
                "source": key,
            }
            fit_mesh = Mesh(
                local.vertices, np.zeros_like(local.vertices), np.zeros((len(local.vertices), 2)), local.faces
            )
            exported[variant] = (sha, c0, fit_mesh)
        sha, c0, fit_mesh = exported[variant]
        position = np.asarray(transform.get("position") or [0, 0, 0], float)
        placed[eid] = {"hash": sha, "origin": c0 + position, "mesh": fit_mesh}
    return files, placed


def _shifted(mesh: Mesh, offset: np.ndarray) -> Mesh:
    return Mesh(mesh.positions + offset, mesh.normals, mesh.uvs, mesh.indices)


# ---------------------------------------------------------------------------- 总流程


def authored_rebuild(
    mesh_space: ScanMesh,
    authored: Mapping[str, Any],
    sources: Mapping[str, Mapping[str, Any]],
    *,
    workdir: str,
    limits: Mapping[str, int],
    hints: Mapping[str, Any] | None = None,
    structure_params: StructureParams | None = None,
) -> dict[str, Any]:
    """见模块说明。`sources = {来源键: {format, path}}`（父进程下载好的文件，gltf 是摆好文件的目录）。"""
    authored = copy.deepcopy(dict(authored))
    entities: dict[str, dict] = {}
    textures: dict[str, bytes] = {}
    metrics: dict[str, Any] = {}
    if authored["structure"] == "keep":
        try:
            structure = extract_structure(mesh_space, structure_params, hints=hints)
        except ValueError as error:
            raise PermanentJobError(f"结构重建失败：{error}") from error
        bodies, structure_textures = structure_entities(structure)
        clash = sorted(set(bodies) & (set(authored["entities"]) | set(authored["templates"])))
        if clash:
            raise PermanentJobError(f"物件编号与结构算法的编号重复：{clash[:5]}（请换个编号）")
        entities.update(bodies)
        textures.update(structure_textures)
        structure_ids = sorted(bodies)
        metrics["structure"] = {"entities": len(bodies), "source": "algorithm"}
    else:
        structure_ids = sorted(e for e, b in authored["entities"].items() if b["kind"] == "structure")
        metrics["structure"] = {"entities": len(structure_ids), "source": "authored"}

    templates = authored["templates"]
    template_shapes = {eid: body["shape"] for eid, body in templates.items()}
    table = FaceTable(mesh_space)
    model_files, placed = export_models(authored, sources, workdir, limits)

    bake_stats = {"entities": 0, "parts": 0, "textured": 0, "fallback": 0}
    fits: list[dict[str, Any]] = []
    for eid, body in sorted(authored["entities"].items()):
        if eid in placed:
            item = placed[eid]
            body["assetHash"] = item["hash"]
            local = item["mesh"].bounds()
            body["bounds"] = sh.rounded_bounds(
                {"min": (local[0] + item["origin"]).tolist(), "max": (local[1] + item["origin"]).tolist()}
            )
            meshes = [_shifted(item["mesh"], item["origin"])]
        else:
            if eid in authored["bakes"]:
                stats = bake_entity(eid, body, authored["bakes"][eid], template_shapes, table, textures)
                bake_stats["entities"] += 1
                for k in ("parts", "textured", "fallback"):
                    bake_stats[k] += stats[k]
                used = shape_textures(body["shape"])
                body.pop("textures", None)
                if used:
                    body["textures"] = sorted(used)
            meshes = [p.mesh for p in build_parts(body["shape"], template_shapes)]
        fit, points = entity_fit(meshes, table, body["bounds"], eid)
        if fit is not None:
            body["fit"] = fit
        fits.append({"entityId": eid, "points": points, **(fit or {})})
        try:
            validate_entity_body(body, template_shapes)
        except (RecordError, ShapeError) as error:
            raise PermanentJobError(f"物件 {eid} 处理后不合法：{error}") from error
        entities[eid] = body
    for eid, body in templates.items():
        entities[eid] = body
    object_ids = sorted(e for e in [*authored["entities"], *templates] if e not in structure_ids)
    metrics["objects"] = {
        "entities": len(object_ids),
        "source": "authored",
        "models": len(placed),
        "modelFiles": len(model_files),
        "shapes": len(authored["entities"]) - len(placed),
        "templates": len(templates),
    }
    return {
        "entities": entities,
        "textures": textures,
        "structureIds": structure_ids,
        "objectIds": object_ids,
        "objectsSkipped": None,
        "metrics": metrics,
        "models": model_files,
        "fit": fits,
        "bake": bake_stats,
    }


__all__ = [
    "authored_rebuild",
    "bake_entity",
    "bake_mesh",
    "entity_fit",
    "export_models",
    "extract_gltf_zip",
    "load_source",
    "scan_points",
    "uv_extents",
]
