# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "trimesh>=4.6,<5"]
# ///
"""从前厅快照生成悬浮玻璃看台、露天光场、LED 屏镜像和地块操作清单。"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from itertools import pairwise
from math import cos, pi, sin
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

DISTANCE = 116
SHELL_DISTANCE = 138
RX, RZ = 8.35, 10.75
ARENA_SCALE = 2.0
ROWS = 8
SCREEN_SCALE = 2.26  # 原屏扫描尺寸，上一次悬浮镜像的两倍。
UP = np.array([0.0, 1.0, 0.0])
SIDES = (("east", "东"), ("south", "南"), ("west", "西"), ("north", "北"))
# 颜色是 sRGB；不透明度在玻璃本体、抛光切面及发光夹层分别取值。
SURFACES = {
    "veil": ("538ed8", 0.055),
    "veil-edge": ("9ccdff", 0.34),
    "weave": ("73dcf9", 0.47),
    "weave-violet": ("b3a0f6", 0.44),
    "crystal": ("62becf", 0.24),
    "edge": ("70cede", 0.58),
    "prism": ("486fbe", 0.27),
    "balustrade": ("77bad5", 0.18),
    "sheen": ("b6f3fa", 0.12),
    "laminate": ("284e72", 0.75),
    "seat": ("193852", 1),
    "seat-top": ("39617a", 1),
    "seat-seam": ("88b6c9", 1),
    "cyan": ("7af2ff", 1),
    "ice": ("c4ffff", 1),
    "aqua": ("27b8d4", 1),
    "violet": ("9984ef", 1),
    "magenta": ("ff69b0", 1),
    "rim": ("39577e", 1),
    "beam": ("53cbdc", 0.045),
    "plinth": ("20304b", 1),
}
UV = ((0, 0), (1, 0), (1, 1), (0, 1))


class Mesh:
    def __init__(self):
        self.panels = defaultdict(list)
        self.uvs = defaultdict(list)
        self.seats = 0

    def quad(self, material, a, b, c, d, uv=None):
        self.panels[material].append((a, b, c, d))
        if uv is not None:
            self.uvs[material].append(uv)

    def strip(self, material, angles, first, second):
        for a, b in pairwise(angles):
            self.quad(material, first(a), first(b), second(b), second(a))

    def rail(self, material, angles, path, width, depth):
        # 扁椭圆剖面给倾斜檐线和切边留出高光面。
        def edge(t, n):
            p = path(t)
            tangent = path(t + 0.0001) - path(t - 0.0001)
            normal = np.array([tangent[2], 0, -tangent[0]])
            normal /= np.linalg.norm(normal)
            return (
                p + normal * (width * cos(n * pi / 3)) + UP * (depth * sin(n * pi / 3))
            )

        for n in range(6):
            self.strip(
                material,
                angles,
                lambda t, n=n: edge(t, n),
                lambda t, n=n: edge(t, n + 1),
            )


def curve(t, r, y):
    # 微微方圆的轮廓让四片玻璃沿前厅四壁展开。
    c, s = cos(t), sin(t)
    normalizer = (abs(c) ** 3 + abs(s) ** 3) ** (-1 / 3)
    return np.array(
        [
            ARENA_SCALE * (RX + r) * c * normalizer,
            y,
            ARENA_SCALE * (RZ + r) * s * normalizer,
        ]
    )


def seat(mesh, t, r, y, accent):
    origin = curve(t, r, y)
    front = curve(t + 0.001, r, y) - curve(t - 0.001, r, y)
    front /= np.linalg.norm(front)
    radial = np.cross(UP, front)

    def p(distance, lateral, height):
        return origin + distance * radial + lateral * front + height * UP

    # 每个座位是一片折弯壳；座面略亮，靠背有一条激光刻线。
    profile = [
        (-0.25, 0.23, 0.20),
        (-0.21, 0.29, 0.24),
        (0.11, 0.27, 0.24),
        (0.22, 0.55, 0.21),
        (0.27, 0.54, 0.19),
        (0.15, 0.23, 0.18),
    ]
    for (ra, ha, wa), (rb, hb, wb), color in zip(
        profile,
        profile[1:],
        ["seat", "seat-top", "seat", "seat-seam", "seat"],
        strict=False,
    ):
        mesh.quad(color, p(ra, -wa, ha), p(ra, wa, ha), p(rb, wb, hb), p(rb, -wb, hb))
    mesh.quad(
        accent,
        p(0.225, -0.13, 0.528),
        p(0.225, 0.13, 0.528),
        p(0.23, 0.13, 0.546),
        p(0.23, -0.13, 0.546),
    )
    mesh.seats += 1


def glass_stand(mesh, axis, side):
    half = 0.665
    a, b = axis - half, axis + half
    wave = lambda t: max(0.0, cos((t - axis) * pi / (2 * half))) ** 2

    # 平台尖端收细，中央的玻璃托盘具有下凸的透镜形剖面。
    def shell(t, u):
        width = 0.65 + 3.12 * wave(t) ** 0.52
        return curve(t, 0.05 + width * u, 1.04 + 0.31 * u + 0.30 * wave(t))

    angles = np.linspace(a, b, 65)
    for u, v, mat in (
        (0, 0.13, "edge"),
        (0.13, 0.58, "crystal"),
        (0.58, 0.91, "prism"),
        (0.91, 1, "edge"),
    ):
        mesh.strip(mat, angles, lambda t, u=u: shell(t, u), lambda t, v=v: shell(t, v))
    for u, mat in ((0, "cyan"), (1, "ice")):
        path = lambda t, u=u: shell(t, u)
        mesh.rail(mat, angles, path, 0.035, 0.026)
        mesh.strip(
            "edge",
            angles,
            path,
            lambda t, path=path: path(t) - UP * (0.06 + 0.17 * wave(t)),
        )
    mesh.strip(
        "crystal",
        angles,
        lambda t: shell(t, 0.02) - UP * 0.12,
        lambda t: shell(t, 0.61) - UP * (0.18 + 0.35 * wave(t)),
    )
    mesh.strip(
        "prism",
        angles,
        lambda t: shell(t, 0.61) - UP * (0.18 + 0.35 * wave(t)),
        lambda t: shell(t, 0.99) - UP * 0.15,
    )
    # 透镜内仅留少数斜切面，透过玻璃可以看见其下方的光晕。
    for t in np.linspace(a + 0.04, b - 0.085, 10):
        mesh.quad(
            "sheen",
            shell(t, 0.06),
            shell(t + 0.024, 0.06),
            shell(t + 0.079, 0.96),
            shell(t + 0.066, 0.96),
        )
    for row in range(ROWS):
        arc = half - 0.023 - 0.16 * row / (ROWS - 1)
        intervals = [(axis - arc, axis - 0.048), (axis + 0.048, axis + arc)]
        r, y = 0.24 + 0.82 * row / ARENA_SCALE, 1.57 + 0.34 * row
        for lo, hi in intervals:
            points = np.linspace(lo, hi, 32)

            def ledge(t, offset=0, height=0, r=r, y=y):
                return curve(t, r + offset, y + height + 0.09 * wave(t))

            mesh.strip("crystal", points, ledge, lambda t: ledge(t, 0.72 / ARENA_SCALE))
            mesh.strip("edge", points, ledge, lambda t: ledge(t, 0.04, -0.115))
            mesh.rail(
                "aqua" if row in (0, ROWS - 1) else "rim",
                points,
                lambda t: ledge(t, 0, -0.046),
                0.020,
                0.016,
            )
            length = sum(
                np.linalg.norm(ledge(t1) - ledge(t0)) for t0, t1 in pairwise(points)
            )
            count = int((length - 0.40) / 0.66)
            # 按实际弧长排座，给中央通道和两端退距。
            arc_lengths = np.r_[
                0,
                np.cumsum(
                    [
                        np.linalg.norm(ledge(t1) - ledge(t0))
                        for t0, t1 in pairwise(points)
                    ]
                ),
            ]
            for t in np.interp(
                np.linspace(0.39, length - 0.39, count), arc_lengths, points
            ):
                seat(
                    mesh,
                    t,
                    r + 0.32 / ARENA_SCALE,
                    y + 0.09 * wave(t),
                    "violet" if side == 3 else "aqua",
                )

    # 上缘的弯玻璃伸过末排，头部透光；两侧的灯带在角区前终止。
    def top(t):
        return curve(t, 3.70, 4.40 + 1.02 * wave(t) + 0.42 * sin(2 * (t - axis)))

    rail_angles = np.linspace(a + 0.11, b - 0.11, 51)
    mesh.strip(
        "balustrade", rail_angles, top, lambda t: top(t) - UP * (0.34 + 0.51 * wave(t))
    )
    mesh.rail("violet" if side == 3 else "cyan", rail_angles, top, 0.036, 0.028)
    mesh.rail(
        "rim",
        rail_angles,
        lambda t: top(t) - UP * (0.34 + 0.51 * wave(t)),
        0.023,
        0.021,
    )
    # 在两个外侧翼缘留一道悬浮光弧和扫线，端头逐渐收窄。
    if side in (0, 2):

        def wing(t):
            u = (t - axis + 0.48) / 0.96
            return curve(
                t,
                4.22 + 0.42 * sin(u * pi),
                4.71 + 1.39 * sin(pi * u) + 0.67 * (u - 0.5),
            )

        span = np.linspace(axis - 0.48, axis + 0.48, 55)
        mesh.strip(
            "prism",
            span,
            wing,
            lambda t: wing(t) - UP * (0.04 + 0.26 * sin(pi * (t - axis + 0.48) / 0.96)),
        )
        mesh.rail("magenta" if side == 2 else "ice", span, wing, 0.042, 0.029)
        for lo, hi in ((-0.42, -0.20), (-0.14, -0.09), (0.18, 0.37)):
            micro = np.linspace(axis + lo, axis + hi, 10)
            mesh.rail("aqua", micro, lambda t: wing(t) + UP * 0.19, 0.019, 0.013)


def access_bridge(mesh, axis, opening):
    normal = np.array([cos(axis), 0, sin(axis)])
    tangent = np.cross(normal, UP)
    inside = opening[0] if abs(cos(axis)) > 0.5 else opening[1]
    outer = np.linalg.norm(curve(axis, 0.31, 0))

    def edge(t, grow, y):
        c, s = cos(t), sin(t)
        d = 1 / max(abs(c), abs(s))
        return np.array([d * c * (opening[0] + grow), y, d * s * (opening[1] + grow)])

    points = np.linspace(axis - pi / 4, axis + pi / 4, 48)
    mesh.strip(
        "plinth", points, lambda t: edge(t, 0, -0.07), lambda t: edge(t, 0.48, -0.07)
    )
    mesh.strip(
        "edge", points, lambda t: edge(t, 0.48, -0.07), lambda t: edge(t, 0.42, -0.25)
    )
    mesh.strip(
        "aqua", points, lambda t: edge(t, 0.42, -0.19), lambda t: edge(t, 0.42, -0.22)
    )
    for i in range(9):
        u, v = i / 9, (i + 1) / 9

        def deck(k, w):
            return (
                normal * (inside + 0.47 + k * (outer - inside - 0.47))
                + tangent * w
                + UP * (-0.06 + 1.70 * k)
            )

        corners = [deck(u, -0.53), deck(u, 0.53), deck(v, 0.53), deck(v, -0.53)]
        mesh.quad("crystal", *corners)
        mesh.quad(
            "edge",
            corners[0],
            corners[1],
            corners[1] - 0.058 * UP,
            corners[0] - 0.058 * UP,
        )
        for lateral in (-0.53, 0.53):
            mesh.quad(
                "cyan",
                deck(u, lateral),
                deck(v, lateral),
                deck(v, lateral) + UP * 0.024,
                deck(u, lateral) + UP * 0.024,
            )


def projection_image():
    # 光线落到悬浮台下的雾面；在透明托盘和阴影之间留下可辨的高度差。
    size = 768
    line = (np.arange(size) + 0.5) / size * 40 - 20
    x, z = np.meshgrid(line, -line)
    radial = ((abs(x) / 10.7) ** 3 + (abs(z) / 13.1) ** 3) ** (1 / 3)
    a = np.arctan2(z / 13.1, x / 10.7)
    banks = 0.38 + 0.62 * (0.5 + 0.5 * np.cos(4 * a)) ** 1.9
    light = np.exp(-(((radial - 1.06) / 0.18) ** 2)) * banks
    pink = np.exp(-((a - pi) ** 2) / 0.5) + np.exp(-((a + pi) ** 2) / 0.5)
    dist = np.hypot(x, z)
    glow = np.exp(-(((radial - 1.05) / 0.84) ** 2))
    rgb = np.zeros((size, size, 3)) + [10, 16, 31]
    rgb += glow[:, :, None] * [4, 11, 19]
    rgb += light[:, :, None] * ([6, 47, 58] + pink[:, :, None] * [45, -24, 8])
    # 坐标刻度逐渐淡出，避免地面变成另一个实体平台。
    grid = np.exp(-((np.abs((x + 0.75) % 1.5 - 0.75) / 0.021) ** 2)) + np.exp(
        -((np.abs((z + 0.75) % 1.5 - 0.75) / 0.021) ** 2)
    )
    ticks = (np.abs((x + 0.75) % 1.5 - 0.75) < 0.052) & (
        np.abs((z + 0.75) % 1.5 - 0.75) < 0.052
    )
    rgb += (
        (grid * 0.55 + ticks * 1.7)[:, :, None]
        * np.exp(-((dist / 26) ** 2))[:, :, None]
        * [11, 22, 29]
    )
    for r, intensity in ((1.31, 1.0), (1.34, 0.62), (0.79, 0.53)):
        arc = np.exp(-(((radial - r) / 0.0029) ** 2)) * (np.sin(5 * a + 0.7) > -0.35)
        rgb += arc[:, :, None] * [15 * intensity, 44 * intensity, 50 * intensity]
    rng = np.random.default_rng(71)
    rgb += rng.uniform(-0.85, 0.85, (size, size, 1))
    alpha = (
        np.clip((1.39 - radial) / 0.28, 0, 1)
        * np.clip((radial - 0.46) / 0.16, 0, 1)
        * 0.80
    )
    return Image.fromarray(np.uint8(np.clip(np.dstack((rgb, alpha * 255)), 0, 255)))


def material(color, image=None):
    rgb, alpha = SURFACES.get(color, ("ffffff", 1.0))
    srgb = np.array([int(rgb[i : i + 2], 16) / 255 for i in (0, 2, 4)])
    linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
    # 使用实体材质的自发光分量给透明切边留光，夜景背景采用原色贴图。
    return PBRMaterial(
        name=color,
        baseColorFactor=np.rint(np.r_[linear, alpha] * 255).astype("uint8"),
        baseColorTexture=image,
        metallicFactor=0.06,
        roughnessFactor=0.28,
        doubleSided=True,
        alphaMode="BLEND" if alpha < 1 or image is not None else "OPAQUE",
        emissiveFactor=linear
        * (1.15 if color in ("cyan", "aqua", "ice", "magenta", "violet") else 0.15)
        if image is None
        else None,
    )


def write_mesh(mesh, directory, part, center, textures=None):
    textures = textures or {}
    scene = trimesh.Scene()
    all_points = np.vstack([np.asarray(f).reshape(-1, 3) for f in mesh.panels.values()])
    low, high = all_points.min(0), all_points.max(0)
    origin = (low + high) / 2
    origin[1] = low[1]
    for surface, faces in mesh.panels.items():
        panels = np.asarray(faces) - origin
        vertices = panels.reshape(-1, 3)
        indices = (
            np.arange(len(vertices))
            .reshape(-1, 4)[:, [0, 1, 2, 0, 2, 3]]
            .reshape(-1, 3)
        )
        normals = np.cross(panels[:, 1] - panels[:, 0], panels[:, 3] - panels[:, 0])
        normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
        model = trimesh.Trimesh(
            vertices=vertices,
            faces=indices,
            vertex_normals=normals.repeat(4, axis=0),
            process=False,
        )
        uv = np.asarray(mesh.uvs[surface]).reshape(-1, 2) if mesh.uvs[surface] else None
        model.visual = TextureVisuals(
            uv=uv, material=material(surface, textures.get(surface))
        )
        scene.add_geometry(model, geom_name=surface)
    data = scene.export(file_type="glb", include_normals=True)
    (directory / f"{part}.glb").write_bytes(data)
    bounds = {
        "min": (low + center).round(5).tolist(),
        "max": (high + center).round(5).tolist(),
    }
    return {"assetHash": hashlib.sha256(data).hexdigest(), "bounds": bounds}


def hologram_dome():
    # 整片穹顶的下缘高于实体区；仰视时能从同一层薄膜和光纹间看到真实天空。
    mesh = Mesh()
    rx, rz = 14.8 * ARENA_SCALE, 17.4 * ARENA_SCALE
    bottom, rise = 5.15, 10.85

    def point(a, v):
        return np.array(
            [rx * cos(v) * cos(a), bottom + rise * sin(v), rz * cos(v) * sin(a)]
        )

    angles = np.linspace(0, 2 * pi, 129)
    elevations = np.linspace(0, pi / 2, 21)
    for lo, hi in pairwise(elevations):
        mesh.strip(
            "veil", angles, lambda a, lo=lo: point(a, lo), lambda a, hi=hi: point(a, hi)
        )
    # 纬线只保留底圈和极冠；旋转的菱格经线使曲面从上、下两个方向都可读。
    for v, r in ((0, 0.065), (0.035, 0.026), (1.425, 0.04)):
        mesh.rail("veil-edge", angles, lambda a, v=v: point(a, v), r, r * 0.64)
    for n in range(12):
        meridian = 2 * pi * n / 12
        for direction in (-1, 1):

            def longitude(v, az=meridian, sign=direction):
                return az + sign * (0.86 * v + 0.09 * sin(2 * v))

            values = np.linspace(0.028, 1.425, 50)

            def stroke(v, sign, lon=longitude):
                spread = 0.032 / max(1.0, rx * cos(v))
                return point(lon(v) + sign * spread, v)

            mesh.strip(
                "weave" if direction == 1 else "weave-violet",
                values,
                lambda v, stroke=stroke: stroke(v, -1),
                lambda v, stroke=stroke: stroke(v, 1),
            )
            # 光纹每隔几格点亮一小截，提供在城市亮背景上的纵深线索。
            start = 0.13 + (n % 3) * 0.21
            vals = np.linspace(start, start + 0.13, 7)
            mesh.strip(
                "ice" if n % 4 else "magenta",
                vals,
                lambda v, lon=longitude: point(lon(v) - 0.0017, v),
                lambda v, lon=longitude: point(lon(v) + 0.0017, v),
            )
    return mesh


def shape_screen(source, center, region, face_path):
    face = source["shape"]
    chain = [face]
    for index in face_path:
        face = face["children"][index]
        chain.append(face)
    if face.get("type") != "plate" or len(face.get("points", [])) != 4 or not face.get("material", {}).get("texture"):
        raise ValueError("镜像来源需要指向带贴图的四边形面板")
    points = np.array(face["points"], dtype=float)
    for node in reversed(chain):
        transform = node.get("transform", {})
        points *= transform.get("scale", 1)
        for axis, key in (([0,0,1], "roll"), ([1,0,0], "pitch"), ([0,1,0], "yaw")):
            if key in transform:
                rotation = trimesh.transformations.rotation_matrix(np.deg2rad(transform[key]), axis)
                points = points @ rotation[:3,:3].T
        points += transform.get("position", [0,0,0])
    width = np.linalg.norm(points[1] - points[0]) * SCREEN_SCALE
    height = np.linalg.norm(points[2] - points[1]) * SCREEN_SCALE
    # 屏幕浮在原屏上方、略朝向场内；板的原始 UV 在应用旋转前投影。
    midpoint = points.mean(0) + [0, 6.2, -1.65]
    shape = {
        "type": "group",
        "transform": {"position": midpoint.round(5).tolist(), "yaw": -18},
        "children": [],
    }
    children = shape["children"]

    def plate(x1, y1, x2, y2, z, mat):
        children.append(
            {
                "type": "plate",
                "points": [[x1, y1, z], [x2, y1, z], [x2, y2, z], [x1, y2, z]],
                "thickness": 0.002,
                "material": mat,
            }
        )

    w, h = width / 2, height / 2
    tex = face["material"]["texture"]
    plate(-w, -h, w, h, 0, {**face["material"], "opacity": 0.68})
    for y in np.linspace(-h + 0.021, h - 0.02, 45):
        plate(
            -w,
            float(y),
            w,
            float(y + 0.009),
            0.011,
            {"color": [13, 61, 86], "opacity": 0.31, "unlit": True},
        )
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = sx * (w + 0.115), sy * (h + 0.095)
            mat = {
                "color": [156, 249, 255] if sx == sy else [216, 157, 247],
                "unlit": True,
            }
            plate(
                *[min(x, x - sx * 0.35), y - 0.013, max(x, x - sx * 0.35), y + 0.013],
                0.015,
                mat,
            )
            plate(
                x - 0.013,
                min(y, y - sy * 0.17),
                x + 0.013,
                max(y, y - sy * 0.17),
                0.016,
                mat,
            )
    for sign in (-1, 1):
        children.append(
            {
                "type": "plate",
                "thickness": 0.002,
                "points": [
                    [sign * w * 0.42, -h - 0.56, -0.03],
                    [sign * w * 0.92, -h, -0.03],
                    [sign * w * 0.20, -h, -0.03],
                ],
                "material": {"color": [82, 205, 239], "opacity": 0.11, "unlit": True},
            }
        )
    for i in range(9):
        x = -w + 0.18 * i
        plate(
            x,
            -h - 0.068,
            x + 0.115,
            -h - 0.045,
            0.013,
            {"color": [111, 236, 250], "unlit": True},
        )
    angle = np.deg2rad(18)
    ext = np.array(
        [(w + 0.14) * cos(angle) + 0.05, h + 0.13, (w + 0.14) * sin(angle) + 0.10]
    )
    return {
        "entityId": "tide-arena.mirror",
        "regionId": region,
        "layer": "ext",
        "kind": "object",
        "label": "前厅 LED · 悬浮全息镜像",
        "shape": shape,
        "bounds": {
            "min": (midpoint - ext - [0, 0.53, 0]).tolist(),
            "max": (midpoint + ext).tolist(),
        },
        "textures": [tex],
        "props": {
            "background": True,
            "backgroundView": {"focus": center.tolist(), "maxDistance": DISTANCE},
            "镜像来源": source["entityId"],
        },
    }


def build(snapshot, root, bindings=None):
    if bindings is None:
        bindings = json.loads(Path(__file__).with_name("bindings.json").read_text())[snapshot["spaceId"]]
    regions = {r["id"]: r for r in snapshot["regions"]}
    region = bindings["outputRegion"]
    if region not in regions:
        raise ValueError(f"快照缺少输出区域 {region}")
    boxes = np.asarray(regions[bindings["infieldRegion"]]["boxes"], dtype=float) * 0.05
    box = np.concatenate((boxes[:, :3].min(0), boxes[:, 3:].max(0)))
    center = np.round((box[:3] + box[3:]) / 2, 5)
    center[1] = bindings.get("floorY", box[1])
    existing = {e["id"]: e["body"] for e in snapshot["entities"]}
    screen = bindings.get("screen")
    upper_id = bindings.get("upperBuilding")
    slab_id = bindings.get("floorSlab")
    facades = set(bindings.get("facades", []))
    visible = set(bindings.get("alwaysVisible", []))
    entry = bindings.get("entrance")
    references = facades | visible | {k for k in (upper_id, slab_id, entry) if k}
    if screen:
        references.add(screen["entity"])
    missing = references - existing.keys()
    if missing:
        raise ValueError(f"快照缺少绑定物件 {sorted(missing)}")
    opening = (box[[3, 5]] - box[[0, 2]]) / 2 + 0.08
    root.mkdir(parents=True, exist_ok=True)
    entities = []

    def add(part, label, mesh, textures=None, unlit=False, props=None):
        entities.append(
            {
                "entityId": "tide-arena." + part,
                "label": label,
                "regionId": region,
                "layer": "ext",
                "kind": "structure",
                "material": {"shading": "albedo", **({"unlit": True} if unlit else {})},
                "props": {
                    "background": True,
                    "backgroundView": {
                        "focus": center.tolist(),
                        "maxDistance": DISTANCE,
                    },
                    **(props or {}),
                },
                **write_mesh(mesh, root, part, center, textures),
            }
        )

    pool = projection_image()
    for side, (part, label) in enumerate(SIDES):
        bank = Mesh()
        glass_stand(bank, side * pi / 2, side)
        # 两枚小型投影环使托盘与地面的空隙在低角度也清晰可见。
        for offset in (-0.34, 0.34):
            origin = curve(side * pi / 2 + offset, 1.55, 0.04)

            def ring(t, r, h, origin=origin):
                return origin + np.array([r * cos(t), h, r * sin(t)])

            angles = np.linspace(0, 2 * pi, 37)
            for r, mat in ((0.30, "cyan"), (0.48, "violet")):
                bank.strip(
                    mat,
                    angles,
                    lambda t, r=r, ring=ring: ring(t, r, 0),
                    lambda t, r=r, ring=ring: ring(t, r + 0.035, 0),
                )
            bank.strip(
                "beam",
                angles,
                lambda t, ring=ring: ring(t, 0.18, 0.025),
                lambda t, ring=ring: ring(t, 0.63, 1.12),
            )
        access_bridge(bank, side * pi / 2, opening)
        props = {"座席数": bank.seats}
        if side == 0:
            props["landmark"] = {
                "label": "内场视角",
                "position": (center + [6.9, 3.5, -1]).tolist(),
                "maxDistance": 90,
                "azimuth": -15,
                "elevation": 5,
                "focusBounds": {
                    "min": (center + [-7.5, -0.2, -12]).tolist(),
                    "max": (center + [7.8, 11.15, -0.2]).tolist(),
                },
            }
        if side == 2:
            props["landmark"] = {
                "label": "拉远看楼体",
                "position": (center + [-11.5, 5, -11]).tolist(),
                "overview": True,
                "maxDistance": 90,
                "azimuth": 20,
                "elevation": 14,
                "focusBounds": {
                    "min": (center + [-31, -51, -36]).tolist(),
                    "max": (center + [43, 118, 36]).tolist(),
                },
            }
        add(part, "星潮 · " + label + "侧浮空玻璃看台", bank, props=props)
        # 光池只投在看台的正下方，边缘自然消退，缝隙里仍能看到城市。
        glow = Mesh()
        a, b = side * pi / 2 - pi / 4, side * pi / 2 + pi / 4
        for t, v in pairwise(np.linspace(a, b, 65)):

            def corner(k):
                c, s = cos(k), sin(k)
                d = 1 / max(abs(c), abs(s))
                return np.array([d * c * opening[0], -0.08, d * s * opening[1]])

            quad = (corner(t), corner(v), curve(v, 8, -0.08), curve(t, 8, -0.08))
            span = 40 * ARENA_SCALE
            uv = [(q[0] / span + 0.5, q[2] / span + 0.5) for q in quad]
            glow.quad("pool", *quad, uv=uv)
        # 非零的几何厚度用于地块范围核对；侧缘随同透明画面一起隐去。
        q = corner(a)
        glow.quad(
            "pool",
            q,
            q + [0.005, 0, 0],
            q + [0.005, -0.006, 0],
            q + [0, -0.006, 0],
            uv=[(0, 0)] * 4,
        )
        add("light-" + part, "星潮 · 投影光池", glow, {"pool": pool}, True)
    add(
        "dome",
        "星潮 · 透景全息罩",
        hologram_dome(),
        props={
            "backgroundView": {"focus": center.tolist(), "maxDistance": SHELL_DISTANCE}
        },
    )
    if screen:
        entities.append(shape_screen(existing[screen["entity"]], center, region, screen.get("facePath", [])))
    focus = center.tolist()

    def view(lo, hi=None):
        return {
            "focus": focus,
            "minDistance": lo,
            **({"maxDistance": hi} if hi is not None else {}),
        }

    # 楼外与楼内之间沿用同一栋官方楼体。过渡距离内只绘制一份立面。
    if upper_id:
        upper = existing[upper_id]
        for tag, lo, hi, alpha in (
            ("outer", 96, SHELL_DISTANCE, 0.36),
            ("inner", 0, 96, 0.086),
        ):
            entities.append(
                {
                    **upper,
                    "entityId": "tide-arena.shell-" + tag,
                    "label": "楼体过渡投影",
                    "material": {
                        "tint": [142, 221, 246],
                        "opacity": alpha,
                        "shading": "albedo",
                    },
                    "props": {**upper["props"], "backgroundView": view(lo, hi)},
                }
            )
    arena_bounds = {
        "min": (center + [-25.0, -0.45, -30.2]).tolist(),
        "max": (center + [25.0, 14.1, 30.2]).tolist(),
    }
    changes = []
    for key, entity in existing.items():
        props = {**entity.get("props", {})}
        if key == upper_id:
            props["backgroundView"] = view(SHELL_DISTANCE)
        elif key in facades:
            props["backgroundView"] = view(96)
        elif key == entry:
            props["landmark"] = {
                **props.get("landmark", {}),
                "label": "进入前厅 · 全息看台",
                "minDistance": 74,
                "position": (center + [0, 17, 0]).tolist(),
                "azimuth": -30,
                "elevation": 24,
                "focusBounds": arena_bounds,
            }
        elif key in visible:
            props.pop("backgroundView", None)
        else:
            continue
        if props != entity.get("props", {}):
            changes.append({**entity, "props": props})
    if slab_id:
        slab = existing[slab_id]
        entities.append(
            {
                **slab,
                "entityId": "tide-arena.deck",
                "label": "投影玻璃基面",
                "material": {"shading": "albedo", "tint": [42, 59, 81], "opacity": 0.57},
                "props": {**slab["props"], "backgroundView": view(0, 80)},
            }
        )
        # 实景楼板在剖开楼身的过渡段承接玻璃基面。
        changes.append(
            {**slab, "props": {**slab["props"], "backgroundView": view(80, SHELL_DISTANCE)}}
        )
    ops = [
        {"op": "placeEntity", "entity": e}
        for e in [*entities, *changes]
        if existing.get(e["entityId"]) != e
    ]
    for file, value in (("entities.json", entities), ("ops.json", ops)):
        (root / file).write_text(json.dumps(value, ensure_ascii=False, indent=2))
    print(
        "共",
        sum(e["props"].get("座席数", 0) for e in entities),
        "席，",
        len(ops),
        "项变更",
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--bindings", type=Path, help="该场景的区域、屏幕和楼体绑定 JSON")
    args = parser.parse_args()
    build(json.loads(args.snapshot.read_text()), args.output, json.loads(args.bindings.read_text()) if args.bindings else None)
