"""上色：材质组（同组的部件取同一个颜色）、浅色单一材质的取色（最亮的部分，近白按白色）、定死的颜色。"""

from __future__ import annotations

import numpy as np

from metaverse_recon import shapes as sh
from metaverse_recon.processing.fit_templates import part
from metaverse_recon.processing.fit_texture import (
    ColorSource,
    TextureParams,
    bright_albedo,
    finalize_materials,
)
from test_objects import sample_shape


def _scan(shapes_colors, seed: int = 0):
    P, C, N = [], [], []
    for k, (shape, color_fn) in enumerate(shapes_colors):
        p, n = sample_shape(shape, 20_000, seed=seed + k)
        P.append(p)
        N.append(n)
        C.append(color_fn(len(p), np.random.default_rng(seed + k)))
    P, C, N = np.concatenate(P), np.concatenate(C).astype(np.uint8), np.concatenate(N)
    return P, C, N


def test_group_parts_share_one_color():
    """两块一组的部件：一块偏亮、一块偏暗，同组后取整组的颜色（同一个）；不在组里的照旧各取各的。"""
    a = sh.box([0.4, 0.3, 0.4], xf=sh.transform(position=[-0.5, 0, 0]))
    b = sh.box([0.4, 0.3, 0.4], xf=sh.transform(position=[0.5, 0, 0]))
    c = sh.box([0.4, 0.3, 0.4], xf=sh.transform(position=[1.5, 0, 0]))
    P, C, N = _scan(
        [
            (a, lambda n, r: np.full((n, 3), 180)),
            (b, lambda n, r: np.full((n, 3), 120)),
            (c, lambda n, r: np.full((n, 3), 60)),
        ]
    )
    shape = sh.group(
        [
            part(sh.box([0.4, 0.3, 0.4], xf=a["transform"]), "a", prefer="color", group="g"),
            part(sh.box([0.4, 0.3, 0.4], xf=b["transform"]), "b", prefer="color", group="g"),
            part(sh.box([0.4, 0.3, 0.4], xf=c["transform"]), "c", prefer="color"),
        ]
    )
    finalize_materials(shape, P, C, N, ColorSource(P, C, N), TextureParams(), 2.0, {})
    ca, cb, cc = (k["material"]["color"] for k in shape["children"])
    assert ca == cb
    assert 120 <= ca[0] <= 180
    assert cc == [60, 60, 60]


def test_bright_albedo_ignores_baked_shadow():
    """白色的面上有一半是烘焙的阴影（亮度 90）：取色用亮的那一半，得到接近 220 的白色；不声明时是中位数。"""
    box = sh.box([1.0, 0.8, 1.0])

    def shaded(n, r):
        v = np.where(r.random(n) < 0.55, 90, 220)
        return np.repeat(v[:, None], 3, axis=1)

    P, C, N = _scan([(box, shaded)])
    plain = sh.group([part(sh.box([1.0, 0.8, 1.0]), "body", prefer="color")])
    bright = sh.group([part(sh.box([1.0, 0.8, 1.0]), "body", prefer="color")])
    bright["children"][0]["_part"]["albedo"] = "bright"
    finalize_materials(plain, P, C, N, ColorSource(P, C, N), TextureParams(), 1.0, {})
    finalize_materials(bright, P, C, N, ColorSource(P, C, N), TextureParams(), 1.0, {})
    assert plain["children"][0]["material"]["color"][0] == 90
    # 最亮的那部分是 220 的中性色：按白色处理（亮度 235）
    assert bright["children"][0]["material"]["color"] == [235, 235, 235]


def test_bright_albedo_keeps_tinted_and_dim_colors():
    """浅色单一材质：带颜色的（米色）、不够亮的只去掉阴影，不往白色归一。"""
    tp = TextureParams()
    rng = np.random.default_rng(3)
    beige = np.where(rng.random(400)[:, None] < 0.5, [110, 95, 75], [220, 190, 150])
    assert bright_albedo(beige, tp).tolist() == [220, 190, 150]
    gray = np.where(rng.random(400)[:, None] < 0.5, [60, 60, 60], [150, 150, 150])
    assert bright_albedo(gray, tp).tolist() == [150, 150, 150]


def test_fixed_color_is_not_sampled():
    """拟合时定好颜色的部件（大屏的机身）：不从附近的扫描点取色（附近全是彩色的画面）。"""
    box = sh.box([1.0, 0.8, 1.0])

    def screen(n, r):
        return np.c_[r.integers(0, 80, n), r.integers(100, 200, n), np.full(n, 230)]

    P, C, N = _scan([(box, screen)])
    shape = sh.group([part(sh.box([1.0, 0.8, 1.0]), "body", prefer="color")])
    shape["children"][0]["_part"]["color"] = [15, 15, 20]
    finalize_materials(shape, P, C, N, ColorSource(P, C, N), TextureParams(), 1.0, {})
    assert shape["children"][0]["material"] == {"color": [15, 15, 20]}
