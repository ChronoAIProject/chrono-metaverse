"""结构重建：墙面补洞、墙的贴图面板与纯色墙体、玻璃（纯色玻璃、竖梃、窗台）。"""

import numpy as np
import pytest

from metaverse_recon.processing.bake import band_medians, fill_unobserved
from metaverse_recon.processing.rebuild import body_textures, structure_entities
from metaverse_recon.processing.shape_mesh import build_parts
from metaverse_recon.processing.structure import (
    Element,
    StructureParams,
    StructureResult,
    element_props,
    element_shape,
    extract_structure,
    glazing_parts,
    hint_boxes,
    inside_hints,
)
from synthetic import ROOM_COLORS, _Builder, room_mesh

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


def test_wall_tops_are_unified_except_low_partitions():
    """三面 2.6 米、一面 2.2 米高的墙（矮隔断）：接近的统一到中位数，差得多的保持自己的高度。"""
    b = _Builder()
    b.plane([0, 0, 0], [0, 0, 4], [5, 0, 0], ROOM_COLORS["floor"])
    for name, (x0, z0), (x1, z1), h in (
        ("south", (0, 0), (5, 0), 2.6),
        ("east", (5, 0), (5, 4), 2.55),
        ("north", (5, 4), (0, 4), 2.62),
        ("west", (0, 4), (0, 0), 2.2),
    ):
        b.plane([x0, 0, z0], [x1 - x0, 0, z1 - z0], [0, h, 0], ROOM_COLORS[name])
    res = extract_structure(b.build())
    tops = {tuple(np.round(e.info["normal"], 3)): e.info["y"][1] for e in res.elements if e.kind == "wall"}
    assert len(tops) == 4
    top = res.stats["wall_top"]
    assert 2.54 <= top <= 2.62  # 四面墙顶部的中位数（矮隔断也参与中位数，但只有一面）
    for n in ((0.0, 1.0), (-1.0, 0.0), (0.0, -1.0)):
        assert tops[n] == pytest.approx(top, abs=1e-3)
    assert tops[(1.0, 0.0)] == pytest.approx(2.2, abs=0.03)


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


# ---------------------------------------------------------------------------- 玻璃


def _grid(x0, x1, y0, y1, z, step=0.02):
    xs, ys = np.meshgrid(np.arange(x0, x1, step), np.arange(y0, y1, step))
    return np.stack([xs.ravel(), ys.ravel(), np.full(xs.size, z)], 1)


def _glazing_scene():
    """z = 10 处朝 −z（朝房间）的玻璃，x ∈ [0, 9]：室外景色散落在玻璃外侧，前面一道 0.45 米高、0.3 米深的
    窗台，每 1.5 米一根 0.2 米宽的竖梃（x = 5.5 那根被一个 1.2 米宽的柜子挡住）。"""
    rng = np.random.default_rng(3)
    parts = []  # (点, 法线, 颜色)
    k = 20000
    glass = np.stack([rng.uniform(0, 9, k), rng.uniform(0.5, 2.8, k), 10 + rng.uniform(0, 0.3, k)], 1)
    parts.append((glass, [0, 0, -1], [60, 100, 140]))
    parts.append((_grid(0, 9, 0, 0.45, 9.7), [0, 0, -1], [200, 180, 150]))  # 窗台前脸
    top = _grid(0, 9, 9.7, 10, 0)[:, [0, 2, 1]]
    top[:, 1] = 0.45
    parts.append((top, [0, 1, 0], [205, 185, 155]))  # 窗台顶面
    for x in (1.0, 2.5, 4.0, 7.0, 8.5):
        parts.append((_grid(x - 0.1, x + 0.1, 0.45, 2.8, 9.8), [0, 0, -1], [235, 235, 230]))
    parts.append((_grid(5.0, 6.2, 0, 2.5, 9.7), [0, 0, -1], [30, 30, 35]))  # 柜子
    P = np.concatenate([p for p, _, _ in parts])
    N = np.concatenate([np.tile(n, (len(p), 1)) for p, n, _ in parts]).astype(float)
    C = np.concatenate([np.tile(c, (len(p), 1)) for p, _, c in parts]).astype(np.uint8)
    return P, C, N


GLASS_FRAME = (np.array([0.0, -1.0]), np.array([-1.0, 0.0]), -10.0, (-9.0, 0.0), (0.0, 2.8))


def test_glazing_parts_finds_ledge_and_regular_mullions():
    P, C, N = _glazing_scene()
    parts = glazing_parts(P, C, N, *GLASS_FRAME, StructureParams())
    info = parts["info"]
    ledge = info["ledge"]
    assert ledge is not None
    assert ledge["top"] == pytest.approx(0.45, abs=0.02) and ledge["depth"] == pytest.approx(0.3, abs=0.03)
    assert np.abs(np.array(ledge["color"]) - [200, 180, 150]).max() <= 10
    xs = sorted(-m["u"] for m in info["mullions"])
    assert info["mullions_detected"] == 5  # 柜子太宽，不算竖梃
    assert np.allclose(xs, [1.0, 2.5, 4.0, 5.5, 7.0, 8.5], atol=0.06)  # 被挡住的那根按等距补上
    m = info["mullions"][0]
    assert 0.15 <= m["width"] <= 0.3 and m["depth"] == pytest.approx(0.2, abs=0.03)
    assert np.abs(np.array(info["frame_color"]) - [235, 235, 230]).max() <= 10
    assert info["glass_color"] == list(StructureParams().glass_color)
    assert parts["observed"].shape == (28, 90) and parts["observed"].any()


def test_glazing_parts_without_ledge_or_mullions():
    P, C, N = _glazing_scene()
    keep = P[:, 2] >= 10  # 只留室外景色
    info = glazing_parts(P[keep], C[keep], N[keep], *GLASS_FRAME, StructureParams())["info"]
    assert info["ledge"] is None and info["mullions"] == [] and info["mullions_detected"] == 0
    assert info["frame_color"] == [220, 220, 215]


def _glazing_element(**extra):
    info = {
        "normal": [0.0, -1.0],
        "tangent": [-1.0, 0.0],
        "offset": -10.0,
        "u": [-9.0, 0.0],
        "y": [0.0, 2.8],
        "thickness": 0.1,
        "axis": "z",
        "direction_deg": -90.0,
        "support_pts": 100,
        "fill_above_1m": 0.6,
        "max_drift": 0.0,
        "glass_color": [172, 192, 206],
        "glass_thickness": 0.02,
        "frame_color": [230, 230, 225],
        "ledge": {"top": 0.45, "depth": 0.3, "color": [200, 180, 150]},
        "mullions": [{"u": -1.0, "width": 0.2, "depth": 0.2}, {"u": -2.5, "width": 0.2, "depth": 0.2}],
        "mullions_detected": 2,
    }
    info.update(extra)
    return Element(
        id="glazing-z10-1", kind="glazing", texture=None, observed=np.ones((3, 3), bool), info=info
    )


def test_glazing_shape_is_plain_glass_mullions_and_ledge():
    e = _glazing_element()
    shape = element_shape(e)
    assert shape["type"] == "group"
    ledge, glass, *mullions = shape["children"]
    assert ledge["material"] == {"color": [200, 180, 150]}
    assert glass["material"] == {"color": [172, 192, 206]} and len(mullions) == 2
    parts = build_parts(shape)
    assert all("texture" not in p.material for p in parts)
    lo = np.min([p.mesh.bounds()[0] for p in parts], axis=0)
    hi = np.max([p.mesh.bounds()[1] for p in parts], axis=0)
    assert lo[0] == pytest.approx(0) and hi[0] == pytest.approx(9)
    # 玻璃 2 厘米厚（在玻璃面外侧），窗台伸进房间 0.3 米
    assert hi[2] == pytest.approx(10.02) and lo[2] == pytest.approx(9.7)
    assert lo[1] == pytest.approx(0) and hi[1] == pytest.approx(2.8)
    glass_lo = build_parts(shape)[1].mesh.bounds()[0]
    assert glass_lo[1] == pytest.approx(0.45)  # 玻璃从窗台顶开始
    props = element_props(e)
    assert props["mullions"] == 2 and props["ledgeTopM"] == 0.45 and "metresPerPixel" not in props
    bare = element_shape(_glazing_element(ledge=None, mullions=[]))
    assert len(bare["children"]) == 1


def test_structure_entities_without_texture():
    result = StructureResult(floor_y=0.0, elements=[_glazing_element()], footprint=None, footprint_cell=0.1)
    bodies, textures = structure_entities(result)
    body = bodies["glazing-z10-1"]
    assert textures == {} and "textures" not in body and body_textures(body) == set()
    assert body["props"]["structure"] == "glazing"
    with pytest.raises(ValueError):
        element_shape(
            Element(id="wall-1", kind="wall", texture=None, observed=np.ones((1, 1), bool), info={})
        )


# ---------------------------------------------------------------------------- 提示里的物体不当墙


def test_hint_boxes_parse_and_rotate():
    boxes = hint_boxes(
        {
            "objects": [
                {"center": [1, 1, 1], "size": [2, 2, 0.2], "label": "屏幕", "yaw": 90},
                {"center": [1, 1], "size": [1, 1, 1]},  # 二维中心：没有盒子
                {"center": [0, 0, 0], "size": [1, -1, 1]},  # 尺寸不合法
                {"center": [0, 0, 0], "size": [1, 1, "x"]},
                {"center": [5, 1, 5], "size": [1, 1, 1], "kind": "cabinet"},
                "不是对象",
            ]
        }
    )
    assert [b.label for b in boxes] == ["屏幕", "cabinet"]
    assert hint_boxes(None) == [] and hint_boxes({"objects": "x"}) == []
    # 偏航 90°：局部 x（2 米宽）转到世界 z 方向
    pts = np.array([[1.0, 1.0, 1.9], [1.9, 1.0, 1.0], [1.0, 1.0, 0.05], [5.2, 1.2, 5.2]])
    assert inside_hints(pts, boxes, 0.0).tolist() == [True, False, True, True]
    assert inside_hints(pts, boxes[:1], 0.0).tolist() == [True, False, True, False]


def test_hinted_object_is_not_a_wall():
    room = room_mesh(diagonal=False)
    plain = extract_structure(room)
    hints = {"objects": [{"center": [4.85, 1.3, 2.0], "size": [0.4, 2.7, 4.2], "label": "整面的柜子"}]}
    hinted = extract_structure(room, hints=hints)

    def normals(res):
        return sorted(tuple(np.round(e.info["normal"], 3)) for e in res.elements if e.kind != "floor")

    assert (-1.0, 0.0) in normals(plain)  # x = 5 的东墙
    assert (-1.0, 0.0) not in normals(hinted)  # 落在提示物体里 → 留给物体重建
    assert len(normals(hinted)) == len(normals(plain)) - 1
    assert hinted.stats["walls_hinted_out"] == ["整面的柜子"]
    assert all(e.kind != "glazing" for e in hinted.elements)  # 也不会被当成玻璃
    # 只盖住墙的一小段的提示物体不影响墙
    small = {"objects": [{"center": [4.85, 0.4, 2.0], "size": [0.4, 0.8, 0.6]}]}
    assert normals(extract_structure(room, hints=small)) == normals(plain)


def test_hinted_object_against_wall_is_not_baked_into_wall():
    """贴着西墙（x = 0）2 厘米放一块绿色的椅背：不给提示时会印进墙面贴图，给了提示就补成墙的颜色。"""
    b = _Builder()
    b.plane([0, 0, 0], [0, 0, 4], [5, 0, 0], ROOM_COLORS["floor"])
    for name, (x0, z0), (x1, z1) in (
        ("south", (0, 0), (5, 0)),
        ("east", (5, 0), (5, 4)),
        ("north", (5, 4), (0, 4)),
        ("west", (0, 4), (0, 0)),
    ):
        b.plane([x0, 0, z0], [x1 - x0, 0, z1 - z0], [0, 2.6, 0], ROOM_COLORS[name])
    green = (60, 200, 60)
    b.plane([0.02, 0.2, 2.0], [0, 0, -0.5], [0, 0.7, 0], green, cell=0.1)  # 法线 +x，朝房间
    mesh = b.build()
    hints = {"objects": [{"center": [0.3, 0.5, 1.75], "size": [0.5, 1.0, 0.6], "label": "椅子"}]}

    def chair_texel(res):
        (west,) = [e for e in res.elements if e.kind == "wall" and e.info["normal"][0] > 0.9]
        u0 = west.info["u"][0]
        y1 = west.info["y"][1]
        u = np.array(west.info["tangent"]) @ [0.02, 1.75]
        col, row = int((u - u0) / west.info["px"]), int((y1 - 0.55) / west.info["px"])
        return west.texture[row, col].astype(int)

    plain = chair_texel(extract_structure(mesh))
    assert plain[1] - ROOM_COLORS["west"][1] > 50  # 不给提示：椅背和墙面混在一起印进贴图（明显偏绿）
    hinted = chair_texel(extract_structure(mesh, hints=hints))
    assert np.abs(hinted - ROOM_COLORS["west"]).max() < 20  # 给了提示：墙的颜色
