"""重建工作台测试用的合成数据：盒子拼成的场景、基线目录、候选模型文件。"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import numpy as np

from conftest import jpeg_bytes
from metaverse_recon.bench import core as wc
from metaverse_recon.processing.glb import GlbMesh, write_glb
from metaverse_recon.processing.scan import ScanMesh
from synthetic import _Builder


def ry(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rx(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def box_planes(b: _Builder, lo, hi, color, R=None, t=(0, 0, 0), cell=0.05) -> None:
    """实心盒子的六个面（局部轴对齐，再按 R、t 摆放），法线朝外。"""
    R = np.eye(3) if R is None else R
    t = np.asarray(t, float)
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    d = hi - lo
    ex, ey, ez = np.array([d[0], 0, 0]), np.array([0, d[1], 0]), np.array([0, 0, d[2]])

    def pl(o, u, v):
        b.plane(R @ o + t, R @ u, R @ v, color, cell=cell)

    pl(lo, ez, ey)
    pl(lo + ex, ey, ez)
    pl(lo, ex, ez)
    pl(lo + ey, ez, ex)
    pl(lo, ey, ex)
    pl(lo + ez, ex, ey)


# 一把"椅子"：座面 + 靠背（在 −z 一侧，所以朝向唯一）+ 四条腿；局部坐标，y 向上，底在 y = 0
CHAIR_BOXES = [
    ([-0.25, 0.45, -0.25], [0.25, 0.53, 0.25]),
    ([-0.25, 0.53, -0.25], [0.25, 0.98, -0.19]),
    ([-0.24, 0.0, -0.24], [-0.2, 0.45, -0.2]),
    ([0.2, 0.0, -0.24], [0.24, 0.45, -0.2]),
    ([-0.24, 0.0, 0.2], [-0.2, 0.45, 0.24]),
    ([0.2, 0.0, 0.2], [0.24, 0.45, 0.24]),
]


def chair_scene(yaw: float, pos, floor_size: float = 3.0) -> ScanMesh:
    """地面 + 按 yaw、pos 摆好的椅子（扫描用）。"""
    b = _Builder(tiles_per_row=4)
    h = floor_size / 2
    b.plane([pos[0] - h, 0, pos[2] - h], [0, 0, floor_size], [floor_size, 0, 0], (150, 120, 90), cell=0.25)
    for lo, hi in CHAIR_BOXES:
        box_planes(b, lo, hi, (190, 160, 120), ry(yaw), pos)
    return b.build()


def chair_mesh_raw(scale: float = 100.0, up: str = "+z") -> tuple[np.ndarray, np.ndarray]:
    """候选模型：同一把椅子，单位厘米（×100），向上轴是 +z（glTF 的 y 轴朝前）。"""
    verts, faces = [], []
    for lo, hi in CHAIR_BOXES:
        lo, hi = np.asarray(lo), np.asarray(hi)
        c = np.array(
            [
                [
                    lo[0] if i & 1 == 0 else hi[0],
                    lo[1] if i & 2 == 0 else hi[1],
                    lo[2] if i & 4 == 0 else hi[2],
                ]
                for i in range(8)
            ]
        )
        f = np.array(
            [
                [0, 2, 1],
                [1, 2, 3],
                [4, 5, 6],
                [5, 7, 6],
                [0, 1, 4],
                [1, 5, 4],
                [2, 6, 3],
                [3, 6, 7],
                [0, 4, 2],
                [2, 4, 6],
                [1, 3, 5],
                [3, 7, 5],
            ]
        )
        faces.append(f + sum(len(v) for v in verts))
        verts.append(c)
    V = np.concatenate(verts) * scale
    if up == "+z":
        V = V @ rx(90).T
    return V, np.concatenate(faces)


def write_scan_glb(mesh: ScanMesh, path: Path) -> None:
    wc.write_scan_glb(wc.Scan(mesh.vertices, mesh.faces, mesh.uv, jpeg_bytes(mesh.texture)), str(path))


def make_base(tmp: Path, mesh: ScanMesh, objects: dict | None = None, structure: dict | None = None) -> Path:
    d = tmp / "base"
    d.mkdir(parents=True, exist_ok=True)
    write_scan_glb(mesh, d / "scan.glb")
    (d / "objects.json").write_text(json.dumps(objects or {}, ensure_ascii=False))
    (d / "structure.json").write_text(json.dumps(structure or {}, ensure_ascii=False))
    return d


def object_body(eid: str, lo, hi, category: str = "chair", label: str = "椅子") -> dict:
    lo, hi = [float(v) for v in lo], [float(v) for v in hi]
    size = [h - low for low, h in zip(lo, hi, strict=True)]
    shape = {
        "type": "box",
        "size": size,
        "transform": {"position": [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2]},
    }
    return {
        "entityId": eid,
        "layer": "rebuilt",
        "kind": "object",
        "label": label,
        "shape": shape,
        "bounds": {"min": lo, "max": hi},
        "props": {"category": category},
    }


def write_candidate(tmp: Path, V: np.ndarray, F: np.ndarray, license: str = "CC-BY-4.0") -> Path:
    """候选模型（glb）和 fetch 写的那种旁注 model.json。"""
    d = tmp / "candidate"
    d.mkdir(parents=True, exist_ok=True)
    data = write_glb(GlbMesh(V, F, base_color=(0.95, 0.9, 0.85, 1.0), unlit=False))
    (d / "model.glb").write_bytes(data)
    sha = hashlib.sha256(data).hexdigest()
    side = {
        "library": "objaverse",
        "id": "0123456789abcdef0123456789abcdef",
        "title": "Test Chair",
        "author": "tester",
        "license": license,
        "page": "https://sketchfab.com/3d-models/0123456789abcdef0123456789abcdef",
        "model": {
            "url": "https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-000/x.glb",
            "sha256": sha,
            "size": len(data),
            "format": "glb",
        },
        "local": {"path": "model.glb", "sha256": sha, "size": len(data)},
        "warnings": [],
    }
    (d / "model.json").write_text(json.dumps(side))
    return d / "model.json"
