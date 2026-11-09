"""结构重建：墙面补洞、墙的贴图面板与纯色墙体。"""

import numpy as np
import pytest

from metaverse_worker.processing.bake import band_medians, fill_unobserved
from metaverse_worker.processing.shape_mesh import build_parts
from metaverse_worker.processing.structure import element_shape, extract_structure
from synthetic import ROOM_COLORS, room_mesh

TEX = "ab" * 32


@pytest.fixture(scope="module")
def room_structure():
    return extract_structure(room_mesh())


# ---------------------------------------------------------------------------- 补洞


def _two_tone(h: int = 40, w: int = 200) -> tuple[np.ndarray, np.ndarray]:
    """左半红、右半蓝的墙面贴图，左半中间有一大块没扫到。"""
    img = np.zeros((h, w, 3))
    img[:, : w // 2] = [200, 40, 40]
    img[:, w // 2 :] = [40, 40, 200]
    obs = np.ones((h, w), bool)
    obs[:, 20:80] = False
    return img, obs


def test_band_medians_follow_the_wall():
    img, obs = _two_tone()
    cols = band_medians(img, obs, 20)
    assert cols.shape == (200, 3)
    assert np.allclose(cols[5], [200, 40, 40]) and np.allclose(cols[195], [40, 40, 200])
    # 全部没扫到的段用两侧插值，不会凭空出现别的颜色
    assert np.all(cols[:, 1] == 40)


def test_band_medians_falls_back_to_global_median():
    img = np.zeros((10, 10, 3))
    obs = np.zeros((10, 10), bool)
    obs[0, 0] = True
    img[0, 0] = [10, 20, 30]
    assert np.allclose(band_medians(img, obs, 4), [10, 20, 30])


def test_fill_unobserved_uses_same_wall_colour_far_from_scan():
    img, obs = _two_tone()
    # 洞中间放一个孤立的绿色采样：不应该把绿色带进整个洞
    img[20, 50] = [0, 255, 0]
    obs[20, 50] = True
    out = fill_unobserved(img, obs, near_px=3, far_px=10, band_px=20)
    assert np.allclose(out[obs], img[obs])  # 扫到的纹素不变
    far = np.zeros(obs.shape, bool)
    far[5:35, 35:65] = True
    far[15:26, 45:56] = False  # 孤立采样本身和它的近邻
    assert np.abs(out[far] - [200, 40, 40]).max() < 1e-6  # 远离扫描的地方 = 同段中位色
    # 洞边（离扫到的区域 near 以内）是推拉的局部平滑，和边上的颜色接得上
    assert np.abs(out[20, 21] - [200, 40, 40]).max() < 30
    # 推拉不会把右半的蓝色拉进左半的洞
    assert out[:, 20:80, 2].max() < 60


def test_fill_unobserved_without_any_scan():
    out = fill_unobserved(np.zeros((4, 5, 3)), np.zeros((4, 5), bool), near_px=1, far_px=2, band_px=2)
    assert out.shape == (4, 5, 3) and np.all(out == 160.0)


# ---------------------------------------------------------------------------- 墙的形状


def test_wall_is_textured_face_plus_plain_body(room_structure):
    walls = [e for e in room_structure.elements if e.kind == "wall"]
    assert len(walls) >= 4
    for e in walls:
        shape = element_shape(e, TEX)
        assert shape["type"] == "group"
        face, body = shape["children"]
        assert face["material"] == {"texture": TEX, "uv": "planar"}
        assert "color" in body["material"] and "texture" not in body["material"]
        ft, t = face["size"][2], e.info["thickness"]
        assert ft == pytest.approx(e.info["face_thickness"]) and body["size"][2] == pytest.approx(t - ft)
        # 面板在房间一侧（局部 z ∈ [−ft, 0]），墙体在它后面
        assert face["transform"]["position"][2] == pytest.approx(-ft / 2)
        assert body["transform"]["position"][2] == pytest.approx(-ft - (t - ft) / 2)


def test_wall_body_colour_and_visible_face(room_structure):
    colours = {tuple(c) for c in ROOM_COLORS.values()}
    for e in room_structure.elements:
        if e.kind != "wall":
            continue
        body = np.array(e.info["body_color"])
        assert min(np.abs(body - np.array(c)).max() for c in colours) <= 12
        parts = build_parts(element_shape(e, TEX))
        textured = [p for p in parts if p.material.get("texture") == TEX]
        assert len(textured) == 1
        # 贴图面板的可见面就在墙面上（房间一侧），法线朝房间
        n = np.array(e.info["normal"])
        pos = textured[0].mesh.positions[:, [0, 2]] @ n
        assert pos.max() == pytest.approx(e.info["offset"], abs=1e-3)
