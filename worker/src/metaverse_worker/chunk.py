"""区块编码（设计 4.2、SHAPES 4），与接口服务 `metaverse-core/src/chunk.rs` 一致。

- 区块是 32×32×32 个 uint16 方块编号，下标 `index = x + 32·(z + 32·y)`；
- 规范字节：按下标顺序写小端 uint16，共 65,536 字节；
- 区块哈希：`sha256(0x01 ‖ 规范字节)` 的小写十六进制，0x01 是格式版本；
- 存储：zlib（deflate）压缩，哈希按未压缩的规范字节算。压缩结果不要求各语言逐字节一致，
  只要求能解回同一份规范字节。

这里用 numpy 数组表示区块：形状 `(32, 32, 32)`、下标顺序 `[y, z, x]`，于是 C 顺序展平后正好是
规范下标顺序。
"""

from __future__ import annotations

import hashlib
import zlib

import numpy as np

CHUNK_SIZE = 32
CHUNK_CELLS = CHUNK_SIZE**3
CHUNK_BYTES = CHUNK_CELLS * 2
CHUNK_FORMAT_VERSION = 0x01

BLOCK_EMPTY = 0
"""0：空，或者扩展层里"不覆盖"。"""
BLOCK_AIR = 1
"""1：空气覆盖，只在扩展层有效。"""
FIRST_PALETTE_BLOCK = 2
"""方块表的编号从 2 开始。"""

GRID_UNIT = 0.05
"""全局网格单位（米），SHAPES 1。"""


class ChunkError(ValueError):
    pass


def cell_index(x: int, y: int, z: int) -> int:
    if not (0 <= x < CHUNK_SIZE and 0 <= y < CHUNK_SIZE and 0 <= z < CHUNK_SIZE):
        raise ChunkError("格子坐标超出 0..32")
    return x + CHUNK_SIZE * (z + CHUNK_SIZE * y)


def empty_chunk() -> np.ndarray:
    """全 0 区块，下标顺序 `[y, z, x]`。"""
    return np.zeros((CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE), dtype=np.uint16)


def _check(cells: np.ndarray) -> np.ndarray:
    if cells.shape != (CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE):
        raise ChunkError("区块必须是 (32, 32, 32) 的数组，下标顺序 [y, z, x]")
    if cells.dtype != np.uint16:
        if cells.size and (cells.min() < 0 or cells.max() > 0xFFFF):
            raise ChunkError("方块编号必须在 0..65535")
        cells = cells.astype(np.uint16)
    return cells


def canonical_bytes(cells: np.ndarray) -> bytes:
    """规范字节：小端 uint16，按 `x + 32·(z + 32·y)` 顺序。"""
    return np.ascontiguousarray(_check(cells), dtype="<u2").tobytes()


def from_canonical_bytes(data: bytes) -> np.ndarray:
    if len(data) != CHUNK_BYTES:
        raise ChunkError("规范字节必须正好 65536 字节")
    return np.frombuffer(data, dtype="<u2").astype(np.uint16).reshape(CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE)


def chunk_hash_of_bytes(data: bytes) -> str:
    digest = hashlib.sha256()
    digest.update(bytes([CHUNK_FORMAT_VERSION]))
    digest.update(data)
    return digest.hexdigest()


def chunk_hash(cells: np.ndarray) -> str:
    """`sha256(0x01 ‖ 规范字节)` 的小写十六进制。"""
    return chunk_hash_of_bytes(canonical_bytes(cells))


def compress(cells: np.ndarray, level: int = 6) -> bytes:
    return zlib.compress(canonical_bytes(cells), level)


def decompress(data: bytes) -> np.ndarray:
    """解压存储字节。最多解出 65,537 字节，超出或不足都判为损坏（防压缩炸弹）。"""
    decoder = zlib.decompressobj()
    try:
        raw = decoder.decompress(data, CHUNK_BYTES + 1)
    except zlib.error as error:
        raise ChunkError("压缩数据无法解压") from error
    # 输出达到上限时 unconsumed_tail 非空；没到 eof 说明数据被截断。
    if len(raw) != CHUNK_BYTES or decoder.unconsumed_tail or not decoder.eof:
        raise ChunkError("压缩数据无法解压")
    return from_canonical_bytes(raw)


def is_empty(cells: np.ndarray) -> bool:
    """全 0 的区块不进清单（设计 4.2）。"""
    return not np.any(cells)


def non_zero_count(cells: np.ndarray) -> int:
    return int(np.count_nonzero(cells))


def locate_cells(cells: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """格坐标 `(N, 3)` → (区块坐标, 区块内坐标)。负坐标按向下取整处理。"""
    cells = np.asarray(cells, dtype=np.int64)
    return np.floor_divide(cells, CHUNK_SIZE), np.mod(cells, CHUNK_SIZE)


def build_chunks(cells: np.ndarray, blocks: np.ndarray) -> dict[tuple[int, int, int], np.ndarray]:
    """把格坐标 `(N, 3)`（x, y, z）和方块编号 `(N,)` 分装成区块。

    返回 `{(cx, cy, cz): 区块数组}`；全 0 的区块不返回。同一格出现多次时以最后一次为准。
    """
    cells = np.asarray(cells, dtype=np.int64).reshape(-1, 3)
    blocks = np.asarray(blocks).reshape(-1)
    if len(cells) != len(blocks):
        raise ChunkError("格子和方块编号的数量不一致")
    if len(blocks) and (blocks.min() < 0 or blocks.max() > 0xFFFF):
        raise ChunkError("方块编号必须在 0..65535")
    chunk_xyz, local = locate_cells(cells)
    out: dict[tuple[int, int, int], np.ndarray] = {}
    if not len(cells):
        return out
    keys, inverse = np.unique(chunk_xyz, axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)
    for k, key in enumerate(keys):
        sel = inverse == k
        arr = empty_chunk()
        lx, ly, lz = local[sel, 0], local[sel, 1], local[sel, 2]
        arr[ly, lz, lx] = blocks[sel].astype(np.uint16)
        if np.any(arr):
            out[(int(key[0]), int(key[1]), int(key[2]))] = arr
    return out
