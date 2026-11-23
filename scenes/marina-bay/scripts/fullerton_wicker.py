"""Build the wraparound dining chairs under One Fullerton's pale awning."""

import math

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial

PHOTO = "https://commons.wikimedia.org/wiki/File:One_Fullerton_12-05-2024(8).jpg"


def cane_material():
    # Two crossings alternate over and under. The alpha gaps let the deck
    # show through the backrest. One tile covers 44 mm on the chair.
    y, x = (np.indices((128, 128)) + .5) / 64
    dx, dy = np.abs((x % 1) - .5), np.abs((y % 1) - .5)
    over = (np.floor(x) + np.floor(y)) % 2 == 0
    width = .235
    vertical = (dx < width) & (over | (dy >= width))
    distance = np.where(vertical, dx, dy)
    crown = np.sqrt(np.clip(1 - (distance / width) ** 2, 0, 1))
    below = (vertical & ~over) | (~vertical & over)
    shadow = below * np.maximum(0, 1 - (np.where(vertical, dy, dx) - width) / .15)
    strand = np.where(vertical, x, y)
    tone = .70 + .30 * crown - .14 * shadow + .025 * np.cos(strand * math.tau * 6)
    rgb = np.uint8(np.clip(tone[..., None] * [165, 133, 91], 0, 255))
    alpha = np.uint8(255 * np.clip((width - np.minimum(dx, dy)) * 64 + .5, 0, 1))
    texture = Image.fromarray(np.dstack((rgb, alpha)))
    texture.format = "PNG"
    return PBRMaterial(name="Woven dining cane", baseColorTexture=texture, metallicFactor=0,
                       roughnessFactor=.66, doubleSided=True, alphaMode="MASK", alphaCutoff=.38)


def rounded_board(width, depth, thickness, radius, bevel, center):
    """A level cap, rounded plan corners and separate narrow edge highlights."""
    contour = []
    for cx, cz, start in [(1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)]:
        for angle in np.deg2rad(np.linspace(start, start + 90, 4)):
            contour.append(([cx * (width / 2 - radius), cz * (depth / 2 - radius)],
                            [np.cos(angle), np.sin(angle)]))
    corners, normals = np.array(contour).transpose(1, 0, 2)
    levels = [(bevel, -thickness / 2), (0, -thickness / 2 + bevel),
              (0, thickness / 2 - bevel), (bevel, thickness / 2)]
    rings = []
    for inset, height in levels:
        x, z = (corners + normals * (radius - inset)).T
        rings.append(np.column_stack([x, np.full_like(x, height), z]))
    n = len(contour)
    faces = []
    for level in range(3):
        for i in range(n):
            a, b = level * n + i, level * n + (i + 1) % n
            faces.extend([[a, a+n, b], [b, a+n, b+n]])
    for i in range(1, n-1):
        faces.extend([[0, i, i+1], [3*n, 3*n+i+1, 3*n+i]])
    board = trimesh.Trimesh(vertices=np.vstack(rings), faces=faces, process=False)
    board.apply_translation(center)
    return board


def binding(path, radius):
    tangent = np.gradient(path, axis=0)
    tangent /= np.linalg.norm(tangent, axis=1)[:, None]
    outward = np.cross(tangent, [0, 1, 0])
    outward /= np.linalg.norm(outward, axis=1)[:, None]
    up = np.cross(outward, tangent)
    ring = np.arange(6) * math.tau / 6
    vertices = path[:, None, :] + radius * (up[:, None, :] * np.cos(ring)[None, :, None]
                                             + outward[:, None, :] * np.sin(ring)[None, :, None])
    faces = []
    for row in range(len(path) - 1):
        for i in range(6):
            a, b = row * 6 + i, row * 6 + (i + 1) % 6
            faces.extend([[a, b, a+6], [b, b+6, a+6]])
    mesh = trimesh.Trimesh(vertices=vertices.reshape(-1, 3), faces=faces, process=False)
    # Both open ends meet a front upright.
    return mesh


def woven_chair(strut):
    # The arms sweep around the occupant and climb toward the back. Points
    # follow the centre of the cane binding, including the straight side runs.
    angle = np.linspace(0, np.pi, 11)
    rim = np.vstack([[.245, -.19], [.25, .078],
                     np.column_stack([.25 * np.cos(angle), .132 + .101 * np.sin(angle)]),
                     [-.25, .078], [-.245, -.19]])
    arc = np.r_[0, np.cumsum(np.linalg.norm(np.diff(rim, axis=0), axis=1))]
    high = .625 + .221 * np.clip((rim[:, 1] + .19) / .423, 0, 1) ** 1.3
    vertices, uv = [], []
    for t in [0, .5, 1]:
        x, z = (rim * (.94 + .06 * t)).T
        y = .418 + t * (high - .418)
        vertices.append(np.column_stack([x, y, z + .025*t]))
        uv.append(np.column_stack([arc, y]) / .044)
    n = len(rim)
    faces = []
    for start in [0, n]:
        for i in range(start, start + n - 1):
            faces.extend([[i, i+n, i+1], [i+1, i+n, i+n+1]])
    back = trimesh.Trimesh(vertices=np.vstack(vertices), faces=faces, process=False)
    back.vertex_attributes["_CANE_UV"] = np.vstack(uv)
    rails = [binding(vertices[0], .012), binding(vertices[-1], .015)]
    for i in [0, -1]:
        rails.append(strut(vertices[0][i], vertices[-1][i], .012, 6))
    seat = rounded_board(.46, .41, .043, .045, .006, [0, .425, .014])
    feet = []
    for x in [-.195, .195]:
        for z in [-.155, .162]:
            feet.append(strut([x * 1.12, .001, z*1.15], [x, .412, z], .015, 6))
    return {"Cane": back, "Teak": trimesh.util.concatenate([*rails, seat]),
            "Metal": trimesh.util.concatenate(feet)}
