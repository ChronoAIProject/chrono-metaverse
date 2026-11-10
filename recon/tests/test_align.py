"""对齐（设计 6.2）：首次扫描自动摆正、重扫配准、给定变换的校验。"""

import math

import numpy as np
import pytest

from metaverse_recon.errors import InputRejected
from metaverse_recon.processing.align import (
    auto_align,
    column_major,
    floor_height,
    level_rotation,
    matrix_from_params,
    register_rescan,
)
from metaverse_recon.processing.scan import ScanMesh, rotation_y
from synthetic import box_mesh, room_mesh


def rigid(theta_deg: float, t, tilt_deg: float = 0.0) -> np.ndarray:
    m = np.eye(4)
    rx = np.eye(3)
    if tilt_deg:
        a = math.radians(tilt_deg)
        rx = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
    m[:3, :3] = rotation_y(math.radians(theta_deg)) @ rx
    m[:3, 3] = t
    return m


def merge(a: ScanMesh, b: ScanMesh) -> ScanMesh:
    return ScanMesh(np.vstack([a.vertices, b.vertices]), np.vstack([a.faces, b.faces + len(a.vertices)]))


def test_auto_align_undoes_rotation_tilt_and_offset():
    room = room_mesh()
    scanned = room.transformed(rigid(-61.4, [2.0, 1.3, -4.0], tilt_deg=1.5))
    result = auto_align(scanned)
    assert result.method == "auto"
    assert result.tilt_deg == pytest.approx(1.5, abs=0.05)
    aligned = scanned.transformed(result.matrix)
    lo, hi = aligned.vertices.min(0), aligned.vertices.max(0)
    # 墙和坐标轴对齐（房间是 5×4 米，转 90° 的倍数后范围是 5×4 或 4×5），地面在 y = 0，角点在原点
    assert sorted([round(hi[0] - lo[0], 2), round(hi[2] - lo[2], 2)]) == [4.0, 5.0]
    assert lo[1] == pytest.approx(0, abs=0.01) and hi[1] == pytest.approx(2.6, abs=0.02)
    assert lo[0] == pytest.approx(0, abs=0.02) and lo[2] == pytest.approx(0, abs=0.02)
    summary = result.summary()
    assert summary["method"] == "auto" and "rotationDeg" in summary


def test_level_rotation_ignores_large_tilt_and_flat():
    room = room_mesh()
    rot, tilt = level_rotation(room.vertices, room.faces)
    assert tilt == 0.0 and np.allclose(rot, np.eye(3))
    steep = room.transformed(rigid(0, [0, 0, 0], tilt_deg=12))
    rot, tilt = level_rotation(steep.vertices, steep.faces)
    assert np.allclose(rot, np.eye(3)) and tilt > 10


def test_floor_height_uses_mode():
    room = merge(room_mesh(), box_mesh([1, 0, 1], [3, 0.75, 2]))  # 桌面不影响地面高度
    assert floor_height(room.vertices, room.faces) == pytest.approx(0.0, abs=0.01)


def test_register_rescan_recovers_transform_despite_furniture_change():
    room = room_mesh()
    ref = auto_align(room)
    ref_space = room.transformed(ref.matrix)
    truth = rigid(127.3, [3.0, 0.2, -2.0])
    rescan = merge(room, box_mesh([1, 0, 1], [2, 0.75, 2])).transformed(truth)
    result = register_rescan(rescan, ref_space)
    assert result.method == "registered"
    assert result.error_cm < 0.5 and result.overlap > 0.9
    assert len(result.candidates) == 4
    # 新扫描坐标 → 空间坐标 = 参考变换 · 真实变换的逆
    np.testing.assert_allclose(result.matrix @ truth, ref.matrix, atol=2e-3)


def test_register_rescan_flags_a_different_room():
    room = room_mesh()
    ref_space = room.transformed(auto_align(room).matrix)
    other = room_mesh(diagonal=False).transformed(rigid(17, [1, 0, 1]))
    other = ScanMesh(other.vertices * np.array([1.6, 1.0, 0.7]), other.faces)
    result = register_rescan(other, ref_space)
    assert result.error_cm > 3.0


def test_register_requires_walls():
    flat = box_mesh([0, 0, 0], [4, 0.01, 4])
    with pytest.raises(InputRejected):
        register_rescan(flat, flat)


def test_matrix_from_params_validation():
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    assert np.allclose(matrix_from_params(identity), np.eye(4))
    m = rigid(30, [1, 2, 3])
    assert np.allclose(matrix_from_params(column_major(m)), m)
    for bad in (
        identity[:15],
        "x" * 16,
        [*identity[:15], float("nan")],
        [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],  # 最后一行不是 0 0 0 1
        [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],  # 镜像
        [True, *identity[1:]],
        [*identity[:12], 1e9, 0, 0, 1],
    ):
        with pytest.raises(InputRejected):
            matrix_from_params(bad)


def test_column_major_layout():
    m = rigid(0, [1, 2, 3])
    values = column_major(m)
    assert values[12:15] == [1.0, 2.0, 3.0] and values[15] == 1.0
