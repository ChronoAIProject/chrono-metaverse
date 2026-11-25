"""Bake four neighbouring window walls around the stepped Concourse building parts."""

import numpy as np
import trimesh
from shapely import get_parts, union_all
from shapely.geometry import Point, Polygon
from shapely.geometry.polygon import orient
from trimesh.visual.texture import TextureVisuals


def concourse_meshes(groups):
    # Each finish repeats over metres. All storeys of a tower share a UV origin.
    repeat = {
        "SilverRibbonGlazing": (26.4, 29.4),
        "BalconyBays": (25.6, 29.4),
        "GalleryScreens": (23.2, 29.4),
        "LimestonePiers": (25.2, 31.95),
    }
    parts = []
    samples = []
    for group in groups:
        for part in group["parts"]:
            outline = np.asarray(part["outline"])
            plan = Polygon(outline[:, [0, 2]])
            # Bring the skin clear of the resident vector wall at grazing angles.
            skin = plan.buffer(.30, join_style="mitre", mitre_limit=2)
            parts.append((part["minHeight"], part["height"], group["finish"], skin))
            samples.extend(outline)
    samples = np.asarray(samples)
    design = np.column_stack((samples[:, 0], samples[:, 2], np.ones(len(samples))))
    grade = np.linalg.lstsq(design, samples[:, 1], rcond=None)[0]
    levels = sorted({elevation for bottom, top, _, _ in parts for elevation in (bottom, top)})
    faces = {name: [] for name in repeat}
    uvs = {name: [] for name in repeat}
    for bottom, top in zip(levels, levels[1:]):
        active = [(name, skin) for lo, hi, name, skin in parts if lo <= bottom and top <= hi]
        if not active:
            continue
        # Discard interior walls, including overlapping crowns and adjoining wings.
        for polygon in get_parts(union_all([skin for _, skin in active])):
            polygon = orient(polygon, sign=1)
            for ring in (polygon.exterior, *polygon.interiors):
                coords = np.asarray(ring.coords)
                for a, b in zip(coords, coords[1:]):
                    delta = b - a
                    length = np.linalg.norm(delta)
                    if length < .001:
                        continue
                    tangent = delta / length
                    midpoint = Point((a + b) / 2)
                    name, _ = min(active, key=lambda item: item[1].boundary.distance(midpoint))
                    width, height = repeat[name]
                    for point, elevation in ((a, bottom), (a, top), (b, top), (b, bottom)):
                        x, z = point
                        faces[name].append((x, grade @ [x, z, 1] + elevation, z))
                        uvs[name].append(((point - [-100, 2400]) @ tangent / width, elevation / height))
    pieces = {}
    for name, vertices in faces.items():
        quads = np.arange(len(vertices)).reshape(-1, 4)
        indices = quads[:, [0, 1, 2, 0, 2, 3]].reshape(-1, 3)
        mesh = trimesh.Trimesh(vertices=vertices, faces=indices, process=False)
        mesh.visual = TextureVisuals(uv=np.asarray(uvs[name]))
        pieces[name] = [mesh]
    return pieces
