"""Place the ten NParks yellow flame trees along Queen Elizabeth Walk."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from scipy.spatial import ConvexHull

from courtyard_tree import compact_bark, load_tree
from fullerton_shrubs import combined

ROOT = Path(__file__).resolve().parents[1]
REGISTER = ROOT / "references/queen-elizabeth-walk-trees.json"
HEIGHTS = {">9 but ≤12": (9, 12), ">12 but ≤15": (12, 15), ">15 but ≤18": (15, 18)}
GIRTHS = {"1.1 - 1.5": (1.1, 1.5), "> 1.5": (1.6, 2.25)}


def fit_tree(bark, leaves, record):
    rng = np.random.default_rng(int(record["treeId"]))
    height = rng.uniform(*HEIGHTS[record["heightBand"]])
    girth = rng.uniform(*GIRTHS[record["girthBand"]])
    bottom = bark.bounds[0, 1]
    foot = bark.vertices[bark.vertices[:, 1] < bottom + .08].mean(axis=0)
    foot[1] = bottom
    top = leaves.bounds[1, 1] - bottom
    # Match estimated breast-height circumference before the first branch.
    # Lift the lowest branches of the compact source specimen onto a clear stem.
    vertical = height / top
    lift = .18
    breast = (1.3 / vertical) / (1 + 2 * lift)
    section = trimesh.intersections.mesh_plane(bark, [0, 1, 0], [0, bottom + breast, 0])
    perimeter = ConvexHull(section.reshape(-1, 3)[:, [0, 2]]).area
    stem = girth / perimeter
    spread = height * rng.uniform(.78, 1.03) / np.ptp(leaves.vertices[:, 0])
    angle = rng.uniform(0, 2 * np.pi)
    rotation = trimesh.transformations.rotation_matrix(angle, [0, 1, 0])[:3, :3]
    x, z = record["localXZ"]
    result = []
    for source in (bark, leaves):
        mesh = source.copy()
        xyz = mesh.vertices - foot
        h = np.clip(xyz[:, 1] / top, 0, 1)
        blend = np.clip((h - .16) / .36, 0, 1)
        scale = stem + (spread - stem) * blend**2 * (3 - 2 * blend)
        slope = (spread - stem) * 6 * blend * (1 - blend) / (.36 * top)
        dy = vertical * (1 + 2 * lift - 6 * lift * h + 3 * lift * h**2)
        normals = source.vertex_normals.copy()
        bad = np.linalg.norm(normals, axis=1) < 1e-6
        normals[bad] = trimesh.geometry.mean_vertex_normals(
            len(mesh.vertices), mesh.faces, mesh.face_normals)[bad]
        normals[:, [0, 2]] /= scale[:, None]
        normals[:, 1] = (normals[:, 1] - slope * (xyz[:, [0, 2]] * normals[:, [0, 2]]).sum(axis=1)) / dy
        xyz[:, [0, 2]] *= scale[:, None]
        xyz[:, 1] = height * (h + lift * h * (1 - h) * (2 - h))
        mesh.vertices = xyz @ rotation.T + [x, record["groundY"] - .035, z]
        normals = normals @ rotation.T
        lengths = np.linalg.norm(normals, axis=1)
        normals[lengths < 1e-8] = [0, 1, 0]
        mesh.vertex_normals = normals / np.linalg.norm(normals, axis=1)[:, None]
        result.append(mesh)
    return result


def bake(folder):
    register = json.loads(REGISTER.read_text())
    bark, leaves = load_tree(folder)
    bark = compact_bark(bark)
    shapes = [fit_tree(bark, leaves, tree) for tree in register["trees"]]
    scene = trimesh.Scene()
    for group in zip(*shapes, strict=True):
        mesh = combined(group)
        scene.add_geometry(mesh, geom_name=mesh.visual.material.name)
    low, high = scene.bounds
    center = (low + high) / 2
    center[1] = low[1]
    for mesh in scene.geometry.values():
        mesh.apply_translation(-center)
    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    return dict(entityId="bay.queen-elizabeth-walk-trees", kind="structure", layer="ext",
                regionId="marina-bay-exterior", label="伊丽莎白女王步道 · 十株双翼豆", assetHash=digest,
                bounds={"min": low.tolist(), "max": high.tolist()}, material={"shading": "albedo"},
                props={"background": True, "surfaceRole": "landscape", "树木名录": register["source"],
                       "树木来源": "NParks Trees.sg，2021 年快照。编号 10530702–10530711，双翼豆 Peltophorum pterocarpum。",
                       "定位": "经纬度、树种、树高和胸围档取自名录。根部依浏览器地表交点，档内高度、胸围、冠幅及枝形为估值。",
                       "树形素材": "Poly Haven · Island Tree 01 · CC0 · https://polyhaven.com/a/island_tree_01"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Directory containing the 1k Island Tree 01 glTF")
    rec = bake(parser.parse_args().folder)
    path = ROOT / "build/streetscape.json"
    entries = {entity["entityId"]: entity for entity in json.loads(path.read_text())}
    entries[rec["entityId"]] = rec
    path.write_text(json.dumps(list(entries.values()), ensure_ascii=False, indent=2) + "\n")
    print(rec["assetHash"])
