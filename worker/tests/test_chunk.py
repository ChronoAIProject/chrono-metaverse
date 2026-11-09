"""区块编码（SHAPES 4）。期望哈希与接口服务生成的测试向量相同（内联一份）。"""

import base64
import hashlib
import zlib

import numpy as np
import pytest

from metaverse_worker import chunk as ch


def test_layout_and_byte_order():
    assert ch.cell_index(1, 0, 0) == 1
    assert ch.cell_index(0, 0, 1) == 32
    assert ch.cell_index(0, 1, 0) == 1024
    assert ch.cell_index(31, 31, 31) == ch.CHUNK_CELLS - 1
    with pytest.raises(ch.ChunkError):
        ch.cell_index(32, 0, 0)
    cells = ch.empty_chunk()
    cells[1, 0, 0] = 0x0302  # y=1
    data = ch.canonical_bytes(cells)
    assert len(data) == ch.CHUNK_BYTES
    assert data[2048:2050] == bytes([0x02, 0x03])


def test_empty_chunk_hash():
    empty = ch.empty_chunk()
    assert ch.is_empty(empty)
    assert ch.chunk_hash(empty) == hashlib.sha256(b"\x01" + bytes(65536)).hexdigest()


def test_single_origin_vector():
    cells = ch.empty_chunk()
    cells[0, 0, 0] = 2
    data = ch.canonical_bytes(cells)
    assert (
        hashlib.sha256(data).hexdigest() == "ad931d4b4e5bcf32b55169f325f5d2b31d7b82a7366d4788be50bcc003c69606"
    )
    assert ch.chunk_hash(cells) == "79d3ba5b33373bb6ae7dd3d787b1a96f8a9991c92fc8e238b96de6463e7c1a81"
    rust_compressed = base64.b64decode(
        "eJztwAENAAAAwqDP/qEtAgsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        "AAAAAADqAC0AAw=="
    )
    assert np.array_equal(ch.decompress(rust_compressed), cells)


def test_floor_and_wall_vector():
    cells = ch.empty_chunk()
    cells[0:1, 0:32, 0:32] = 2  # y = 0 整层
    cells[0:8, 0:32, 0:1] = 3  # x = 0 一面墙（后写覆盖先写）
    cells[1, 16, 16] = 7  # (x=16, y=1, z=16)
    assert ch.cell_index(16, 1, 16) == 1552
    data = ch.canonical_bytes(cells)
    assert data[3104:3106] == bytes([7, 0])
    assert ch.non_zero_count(cells) == 1249
    assert ch.chunk_hash(cells) == "efd44341e0be3a763bbbf7dabe1b56ef389065afdc96d9067713344ba3317586"
    assert (
        hashlib.sha256(data).hexdigest() == "49bd5865866c3e52399995463851d9b774c540a3bd24104c037da7c1cf6d20b3"
    )


def test_round_trip_and_corruption():
    cells = ch.empty_chunk()
    cells[4, 5, 3] = 7
    cells[31, 31, 31] = ch.BLOCK_AIR
    restored = ch.decompress(ch.compress(cells))
    assert np.array_equal(restored, cells)
    assert ch.chunk_hash(restored) == ch.chunk_hash(cells)
    with pytest.raises(ch.ChunkError):
        ch.decompress(b"not zlib")
    with pytest.raises(ch.ChunkError):
        ch.decompress(zlib.compress(bytes(ch.CHUNK_BYTES + 2)))
    with pytest.raises(ch.ChunkError):
        ch.decompress(zlib.compress(bytes(ch.CHUNK_BYTES))[:-6])  # 截断
    with pytest.raises(ch.ChunkError):
        ch.from_canonical_bytes(bytes(10))


def test_locate_negative_cells_by_floor_division():
    chunk_xyz, local = ch.locate_cells(np.array([[-1, 0, 33], [-32, -33, 0]]))
    assert chunk_xyz.tolist() == [[-1, 0, 1], [-1, -2, 0]]
    assert local.tolist() == [[31, 0, 1], [0, 31, 0]]


def test_build_chunks_groups_cells():
    cells = np.array([[0, 0, 0], [33, 1, 2], [-1, 0, 0], [5, 5, 5]])
    blocks = np.array([2, 3, 4, 0])
    out = ch.build_chunks(cells, blocks)
    assert set(out) == {(0, 0, 0), (1, 0, 0), (-1, 0, 0)}
    assert out[(1, 0, 0)][1, 2, 1] == 3
    assert out[(-1, 0, 0)][0, 0, 31] == 4
    assert out[(0, 0, 0)][5, 5, 5] == 0  # 0 号不会产生内容
