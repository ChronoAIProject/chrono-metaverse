"""体素化（设计 6.3 第 9 步、4.2、4.3；验证见 `spikes/voxelize/voxelize.py`）。

把已对齐到空间坐标的扫描按 `GRID_UNIT`（5 厘米）体素化，颜色量化成少量方块：

1. **表面采样**：每个格子面积约 9 个采样点，按贴图取色；
2. **体素**：采样点落到哪一格就占哪一格，颜色在线性空间里取平均；采样点少于 2 个的格子和很小的连通块
   （少于 max(8, (0.15 / 格子)²) 格，26 邻接）去掉，都是噪点；
3. **只保留实体区**：空间定义了实体区（`regions` 里 `kind: physical` 的盒子，单位是格，半开区间）时，
   只保留落在这些盒子里的格子；没定义时保留全部；
4. **颜色量化**：在 Lab 空间做 k-means（默认 64 种，固定随机种子，同一扫描结果相同），每一类取线性空间
   平均色，换回 sRGB 作为方块颜色；
5. **方块表**（只追加，设计 4.3）：编号 0（空）、1（空气覆盖）保留，方块表从 2 开始。量化出的颜色如果在当前
   方块表里已经有完全相同的扫描方块（`tags` 含 `scan`、颜色相同）就复用那个编号，否则追加新编号
   （当前最大编号 + 1）。旧编号永远保留；
6. **区块**：32³ 一个区块，编码见 `chunk.py`（SHAPES 4），全 0 的区块不输出。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import ndimage
from scipy.cluster.vq import kmeans2

from ..chunk import FIRST_PALETTE_BLOCK, GRID_UNIT, build_chunks, chunk_hash, compress
from ..errors import InputRejected
from .scan import ScanMesh, sample_surface

SCAN_TAG = "scan"
MAX_BLOCK_ID = 0xFFFF


@dataclass
class VoxelResult:
    cells: np.ndarray  # (N, 3) int64，格坐标 (x, y, z)
    labels: np.ndarray  # (N,) 每格的颜色类别 0..K-1
    colors: np.ndarray  # (K, 3) uint8 sRGB，每类的方块颜色
    stats: dict


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = np.asarray(c, np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055) * 255


def linear_to_lab(c: np.ndarray) -> np.ndarray:
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], 1)


def in_boxes(cells: np.ndarray, boxes: list[list[int]]) -> np.ndarray:
    """格子是否落在任一盒子 `[x0, y0, z0, x1, y1, z1]`（半开区间）里。"""
    keep = np.zeros(len(cells), bool)
    for b in boxes:
        lo, hi = np.asarray(b[:3]), np.asarray(b[3:])
        keep |= np.all((cells >= lo) & (cells < hi), axis=1)
    return keep


def voxelize_mesh(
    mesh: ScanMesh,
    *,
    grid: float = GRID_UNIT,
    palette_size: int = 64,
    physical_boxes: list[list[int]] | None = None,
    max_cells: int = 50_000_000,
    seed: int = 0,
) -> VoxelResult:
    """mesh 已在空间坐标里（米）。"""
    density = 9.0 / (grid * grid)
    P, C, _, _ = sample_surface(mesh, density, seed=seed)
    if len(P) == 0:
        raise InputRejected("扫描表面为空，无法体素化")
    idx = np.floor(P / grid + 1e-9).astype(np.int64)
    lo = idx.min(axis=0)
    rel = idx - lo
    dims = tuple(int(d) for d in rel.max(axis=0) + 1)
    if int(np.prod(dims, dtype=np.float64)) > max_cells:
        raise InputRejected(f"体素包围盒 {dims} 超过上限 {max_cells} 格")
    key = np.ravel_multi_index(rel.T, dims)
    uniq, inv, counts = np.unique(key, return_inverse=True, return_counts=True)
    inv = inv.reshape(-1)
    acc = np.zeros((len(uniq), 3))
    np.add.at(acc, inv, srgb_to_linear(C))
    mean_lin = acc / counts[:, None]
    occ = np.stack(np.unravel_index(uniq, dims), 1)
    keep = counts >= 2
    occ, mean_lin = occ[keep], mean_lin[keep]
    stats: dict = {"samples": len(P), "rawCells": len(uniq)}
    if len(occ):
        g = np.zeros(dims, bool)
        g[tuple(occ.T)] = True
        lab, _ = ndimage.label(g, structure=np.ones((3, 3, 3)))
        sizes = np.bincount(lab.ravel())
        min_comp = max(8, int(0.15 / grid) ** 2)
        good = sizes[lab[tuple(occ.T)]] >= min_comp
        occ, mean_lin = occ[good], mean_lin[good]
    cells = occ + lo
    if physical_boxes:
        inside = in_boxes(cells, physical_boxes)
        cells, mean_lin = cells[inside], mean_lin[inside]
    stats["cells"] = len(cells)
    if len(cells) == 0:
        return VoxelResult(cells, np.zeros(0, np.int64), np.zeros((0, 3), np.uint8), stats)
    k = int(min(max(1, palette_size), len(cells)))
    if k == 1:
        labels = np.zeros(len(cells), np.int64)
    else:
        _, labels = kmeans2(linear_to_lab(mean_lin), k, seed=seed, minit="++", iter=20)
    present = np.unique(labels)
    remap = np.full(k, -1, np.int64)
    remap[present] = np.arange(len(present))
    labels = remap[labels]
    pal_lin = np.array([mean_lin[labels == i].mean(0) for i in range(len(present))])
    colors = np.clip(np.round(linear_to_srgb(pal_lin)), 0, 255).astype(np.uint8)
    stats["colors"] = len(colors)
    return VoxelResult(cells, labels, colors, stats)


def assign_blocks(existing: list[dict], colors: np.ndarray) -> tuple[list[dict], np.ndarray]:
    """按方块表只追加的规则给每种颜色分配编号。返回 (新的完整方块表, 每类的编号)。"""
    blocks = [dict(b) for b in existing]
    reuse: dict[tuple[int, int, int], int] = {}
    for b in blocks:
        if (
            b.get("kind") == "solid"
            and SCAN_TAG in (b.get("tags") or [])
            and isinstance(b.get("color"), list)
        ):
            reuse.setdefault(tuple(int(c) for c in b["color"]), int(b["id"]))
    next_id = max([FIRST_PALETTE_BLOCK - 1] + [int(b["id"]) for b in blocks]) + 1
    ids = np.zeros(len(colors), np.int64)
    for i, color in enumerate(colors):
        key = tuple(int(c) for c in color)
        if key in reuse:
            ids[i] = reuse[key]
            continue
        if next_id > MAX_BLOCK_ID:
            raise InputRejected("方块表编号已用完")
        blocks.append(
            {
                "id": next_id,
                "name": f"扫描色 #{key[0]:02x}{key[1]:02x}{key[2]:02x}",
                "kind": "solid",
                "color": list(key),
                "tags": [SCAN_TAG],
            }
        )
        reuse[key] = next_id
        ids[i] = next_id
        next_id += 1
    return blocks, ids


def encode_chunks(cells: np.ndarray, block_ids: np.ndarray) -> dict[tuple[int, int, int], tuple[str, bytes]]:
    """`{(cx, cy, cz): (区块哈希, zlib 压缩字节)}`，全 0 的区块不输出。"""
    out: dict[tuple[int, int, int], tuple[str, bytes]] = {}
    for key, arr in build_chunks(cells, block_ids).items():
        out[key] = (chunk_hash(arr), compress(arr))
    return out
