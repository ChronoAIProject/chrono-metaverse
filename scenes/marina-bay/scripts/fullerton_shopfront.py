"""Recess the ground-floor shopfront below the surveyed courtyard facade."""

from collections import defaultdict

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

GLASS = "Courtyard entrance glass"
PHOTO = "https://commons.wikimedia.org/wiki/File:One_Fullerton_12-05-2024(10).jpg"
# The two duplicated triangles share these vertices in both source encodings.
CORNERS = [[11.2205, -.0049, 56.1892], [11.2749, -.0064, 73.4628],
           [11.2750, 3.5485, 73.4631], [11.2206, 2.7524, 56.1894]]


def shopfront_patch(local, faces):
    distances = np.linalg.norm(local[:, None, :] - CORNERS, axis=2)
    selected = (distances.min(axis=1)[faces] < .013).all(axis=1)
    if selected.sum() != 4:
        raise ValueError("Missing One Fullerton's surveyed courtyard wall")
    corners = local[distances.argmin(axis=0)]
    return selected, corners


def wall_finish(grain, span, height, fixtures):
    # Bake the falloff of the ceiling wall washers into the plaster. The
    # projected light depends on beam angle, incidence and inverse square distance.
    w, h = 1024, 160
    z, y = np.meshgrid(np.linspace(0, span, w), np.linspace(height, 0, h))
    tex = np.asarray(grain)
    noise = tex[(y * 210).astype(int) % tex.shape[0], (z * 210).astype(int) % tex.shape[1]] / 255
    light = np.zeros((h, w))
    for lamp in fixtures:
        down, offset = 2.66 - y, z - lamp
        distance = np.sqrt(.52 ** 2 + down ** 2 + offset ** 2)
        alignment = np.clip((.52 * .46 + down * .888) / distance, 0, 1)
        light += alignment ** 12 * .52 / distance ** 3
    bounce = .65 + .35 * np.sin(np.pi * np.clip(y / height, 0, 1)) ** .4
    rgb = (np.array([.10, .081, .066]) + light[..., None] * [.99, .71, .46])
    rgb *= (noise * bounce)[..., None]
    image = Image.fromarray(np.uint8(np.clip(1.055 * rgb ** (1 / 2.4) - .055, 0, 1) * 255))
    image.format = "JPEG"
    return image


def shopfront(corners, timber, stone_path):
    south, north = corners[:2, [0, 2]]
    span = np.linalg.norm(north - south)
    along = (north - south) / span
    inland = along[[1, 0]] * [1, -1]
    floor, lintel, glass_x, back = .22, 2.72, .80, 3.28
    fixtures = [1.43, 4.83, 7.07, 10.01, 12.35, 15.62]
    grain = Image.open(stone_path).convert("L").resize((320, 320), Image.Resampling.LANCZOS)
    grain = grain.point(lambda value: 104 + value * .59)
    grain.format = "JPEG"
    materials = {
        "Courtyard plaster": PBRMaterial(name="Wall washed plaster", baseColorTexture=wall_finish(grain, span, lintel - floor, fixtures),
                                         metallicFactor=0, roughnessFactor=.90),
        "Recessed lamps": PBRMaterial(name="Interior downlights", baseColorFactor=[248, 226, 196, 255],
                                     emissiveFactor=[.80, .58, .34], metallicFactor=0, roughnessFactor=.54),
        "Exterior cladding": PBRMaterial(name="Recessed shop cladding", baseColorTexture=grain, metallicFactor=.07, roughnessFactor=.69),
        "Shop joinery": PBRMaterial(name="Interior timber joinery", baseColorTexture=timber, metallicFactor=0, roughnessFactor=.64),
        "Shop frames": PBRMaterial(name="Entrance aluminium", metallicFactor=.46, roughnessFactor=.42),
        GLASS: PBRMaterial(name=GLASS, baseColorFactor=[91, 143, 147, 45], metallicFactor=.10,
                           roughnessFactor=.19, alphaMode="BLEND"),
    }
    sections = defaultdict(list)
    colors = defaultdict(list)

    def add(name, tint, x0, x1, y0, y1, z0, z1):
        b = trimesh.creation.box([x1 - x0, y1 - y0, z1 - z0])
        b.apply_translation([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2])
        sections[name].append(b)
        colors[name].append(np.tile(tint, (b.faces.size, 1)))

    shell, wood, metal = "Exterior cladding", "Shop joinery", "Shop frames"
    stone, lining, frame = [164, 155, 140], [113, 107, 93], [70, 77, 76]
    # Leave the adjoining survey triangle in place. The cladding laps it at
    # the top edge and the recessed opening fits below its lowest point.
    add(shell, [71, 77, 77], -.08, .035, lintel, 3.55, 0, span)
    joints = np.linspace(0, span, 13)
    for a, b in zip(joints[:-1], joints[1:]):
        add(shell, [144, 148, 143], -.098, -.079, lintel + .085, 3.535, a + .006, b - .006)
        add(shell, lining, .035, back, lintel, lintel + .07, a, b)
    add(shell, [74, 76, 73], -.025, back, .02, floor - .018, 0, span)
    # Separate the flags at the threshold from the timber floor behind the glass.
    for a, b in zip(joints[:-1], joints[1:]):
        add(shell, [165, 162, 152], -.012, glass_x + .04, floor - .018, floor + .004, a + .003, b - .003)
    add(wood, [146, 124, 100], glass_x + .04, back, floor - .018, floor, 0, span)
    add("Courtyard plaster", [255, 255, 255], back, back + .08, floor, lintel, 0, span)
    for z in fixtures:
        add(metal, [89, 89, 83], back - .62, back - .42, lintel - .027, lintel, z - .10, z + .10)
        add("Recessed lamps", [255, 255, 255], back - .58, back - .46, lintel - .036, lintel - .027, z - .06, z + .06)
    # Paired access panels and a low skirting give the clear entrance aisle a rear boundary.
    for a, b in [(4.04, 4.94), (4.95, 5.85)]:
        add(wood, [135, 125, 109], back - .07, back - .01, floor, 2.25, a, b)
        add(metal, [167, 161, 144], back - .12, back - .07, 1.17, 1.20, (a + b) / 2, (a + b) / 2 + .135)
    add(wood, [120, 107, 88], back - .045, back, floor, floor + .12, .17, span - .17)
    for left in [0, span - .17]:
        add(shell, stone, -.08, back, floor, lintel, left, left + .17)
    # Set structural piers forward of the glass. Narrow joints separate the
    # cladding panels. This spacing and the interior fixtures are approximations.
    for z in [3.38, 8.22, 13.36]:
        add(shell, [81, 84, 80], -.055, glass_x + .13, floor, lintel, z - .22, z + .22)
        for y0, y1 in [(floor + .075, 1.1), (1.11, 1.96), (1.97, lintel)]:
            add(shell, stone, -.07, glass_x + .15, y0, y1, z - .228, z + .228)

    # The glazing, door pull and sill use separate depths so they move past
    # each other when walking. A single front-facing pane avoids blending its rear surface.
    pane = trimesh.Trimesh(vertices=[[glass_x, floor, .17], [glass_x, floor, span - .17],
                                     [glass_x, lintel, span - .17], [glass_x, lintel, .17]],
                           faces=[[0, 1, 2], [0, 2, 3]], process=False)
    sections[GLASS].append(pane)
    for z in [.18, 1.80, 3.38, 4.74, 5.66, 6.58, 8.22, 9.92, 11.65, 13.36, 15.24, span - .18]:
        add(metal, frame, glass_x - .055, glass_x + .055, floor, lintel, z - .026, z + .026)
    for y in [floor + .045, 2.35, lintel - .04]:
        add(metal, frame, glass_x - .047, glass_x + .044, y - .026, y + .026, .17, span - .17)
    for z in [5.58, 5.74]:
        add(metal, [171, 163, 143], glass_x - .129, glass_x - .101, .91, 1.58, z - .015, z + .015)
        for y in [.94, 1.54]:
            add(metal, frame, glass_x - .115, glass_x, y, y + .024, z - .016, z + .016)

    # Interior volumes carry parallax beyond the threshold even at a side angle.
    # Keep the entrance aisle clear between the bank of seats and counter.
    for a, b in [(.34, 3.16), (8.53, 11.55), (11.6, 13.10)]:
        add(wood, [132, 109, 86], 2.24, back, floor, .62, a, b)
        add(shell, [96, 71, 56], 2.38, 2.95, .62, .72, a, b)
        add(shell, [96, 71, 56], 2.89, 3.15, .68, 1.30, a, b)
        z = (a + b) / 2
        add(metal, frame, 1.99, 2.09, floor, .93, z - .07, z + .07)
        add(wood, [181, 155, 128], 1.69, 2.41, .93, .972, z - .53, z + .53)
    add(wood, [144, 122, 90], 1.98, 2.85, floor, 1.13, 13.81, span - .26)
    add(shell, stone, 1.90, 2.89, 1.13, 1.19, 13.75, span - .21)
    for a, b in [(.25, 3.20), (8.38, 13.19), (13.61, span - .25)]:
        for z in np.arange(a, b - .05, .14):
            add(wood, [146, 125, 102], back - .05, back, 1.36, 2.52, z, z + .085)
    result = []
    for name, meshes in sections.items():
        combined = trimesh.util.concatenate(meshes)
        xyz = combined.vertices[combined.faces].reshape(-1, 3)
        # Align the geometry with the two actual measured bottom corners.
        coords = xyz.copy()
        coords[:, [0, 2]] = south + xyz[:, :1] * inland + xyz[:, 2:] * along
        mesh = trimesh.Trimesh(vertices=coords, faces=np.arange(len(coords)).reshape(-1, 3), process=False)
        mesh.vertex_normals = np.repeat(mesh.face_normals, 3, axis=0)
        mesh.visual = TextureVisuals(material=materials[name])
        if name in {shell, wood, metal}:
            # Linear vertex colors encode finish tints and the loss of indirect
            # daylight with distance into the recess.
            rgb = np.vstack(colors[name]) / 255
            ambient = .34 + .66 * np.exp(-.64 * np.maximum(xyz[:, 0], 0))
            color = np.uint8(np.round(255 * ((rgb + .055) / 1.055) ** 2.4 * ambient[:, None]))
            mesh.visual.vertex_attributes["color"] = np.column_stack((color, np.full(len(color), 255, dtype=np.uint8)))
        if name == shell:
            # Box-project the mineral texture on each face at a constant metric scale.
            axes = np.abs(np.repeat(combined.face_normals, 3, axis=0)).argmax(axis=1)
            u = np.where(axes == 2, xyz[:, 0], xyz[:, 2])
            v = np.where(axes == 1, xyz[:, 0], xyz[:, 1])
            mesh.visual.uv = np.column_stack((u, v)) / 1.35
        if name == "Courtyard plaster":
            mesh.visual.uv = np.column_stack((xyz[:, 2] / span, (xyz[:, 1] - floor) / (lintel - floor)))
        if name == wood:
            mesh.visual.uv = np.column_stack((xyz[:, 2] / 1.55, (xyz[:, 0] + xyz[:, 1]) / .96))
        result.append(mesh)
    return result
