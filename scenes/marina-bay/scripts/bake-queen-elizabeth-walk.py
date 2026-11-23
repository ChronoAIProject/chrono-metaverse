"""Place the ten NParks yellow flame trees along Queen Elizabeth Walk."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from scipy.optimize import brentq
from scipy.spatial import ConvexHull

from courtyard_tree import compact_bark, load_tree
from fullerton_shrubs import combined

ROOT = Path(__file__).resolve().parents[1]
REGISTER = ROOT / "references/queen-elizabeth-walk-trees.json"
HEIGHTS = {">9 but ≤12": (9, 12), ">12 but ≤15": (12, 15), ">15 but ≤18": (15, 18)}
GIRTHS = {"1.1 - 1.5": (1.1, 1.5), "> 1.5": (1.6, 2.25)}


def fit_tree(bark, leaves, record, compass):
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
    lift = .53
    def relative_height(h):
        return h + lift * h * (1 - h) * (2 - h)

    breast = top * brentq(lambda h: height * relative_height(h) - 1.3, 0, 1)
    section = trimesh.intersections.mesh_plane(bark, [0, 1, 0], [0, bottom + breast, 0])
    perimeter = ConvexHull(section.reshape(-1, 3)[:, [0, 2]]).area
    stem = girth / perimeter
    angle = rng.uniform(0, 2 * np.pi)
    rotation = trimesh.transformations.rotation_matrix(angle, [0, 1, 0])[:3, :3]
    # Work in geographic east/north so the source rotation never rotates the
    # measured footprint. Bark and leaves receive the same continuous warp.
    cardinal = rotation @ compass.T
    crown = (leaves.vertices - foot) @ cardinal
    extent = record["crownExtentMetres"]
    lo, hi = np.array([-extent["west"], -extent["south"]]), np.array([extent["east"], extent["north"]])
    spread = (hi - lo) / np.ptp(crown[:, [0, 2]], axis=0)
    lean = lo - crown[:, [0, 2]].min(axis=0) * spread
    x, z = record["localXZ"]
    result = []
    for source in (bark, leaves):
        mesh = source.copy()
        xyz = (mesh.vertices - foot) @ cardinal
        h = np.clip(xyz[:, 1] / top, 0, 1)
        blend = np.clip((h - .12) / .24, 0, 1)
        weight = (blend**2 * (3 - 2 * blend))[:, None]
        slope = (6 * blend * (1 - blend) / (.24 * top))[:, None]
        scale = stem + weight * (spread - stem)
        dxz_dy = slope * (xyz[:, [0, 2]] * (spread - stem) + lean)
        dy = vertical * (1 + 2 * lift - 6 * lift * h + 3 * lift * h**2)
        normals = source.vertex_normals.copy()
        bad = np.linalg.norm(normals, axis=1) < 1e-6
        normals[bad] = trimesh.geometry.mean_vertex_normals(
            len(mesh.vertices), mesh.faces, mesh.face_normals)[bad]
        normals = normals @ cardinal
        normals[:, [0, 2]] /= scale
        normals[:, 1] = (normals[:, 1] - (dxz_dy * normals[:, [0, 2]]).sum(axis=1)) / dy
        xyz[:, [0, 2]] = xyz[:, [0, 2]] * scale + weight * lean
        xyz[:, 1] = height * relative_height(h)
        mesh.vertices = xyz @ compass + [x, record["groundY"] - .035, z]
        normals = normals @ compass
        lengths = np.linalg.norm(normals, axis=1)
        normals[lengths < 1e-8] = [0, 1, 0]
        mesh.vertex_normals = normals / np.linalg.norm(normals, axis=1)[:, None]
        result.append(mesh)
    return result


def bake(folder):
    register = json.loads(REGISTER.read_text())
    mask = folder / "textures/island_tree_01_leaves_alpha_1k.png"
    if hashlib.sha256(mask.read_bytes()).hexdigest() != "f4341f147988dbe6b58d9ca841a8f0e4bcff25bc40d05f9877da82006d489c39":
        raise ValueError("Expected the original 1k Island Tree 01 leaf opacity map")
    with Image.open(mask) as source:
        raw = np.asarray(source)
        leaf_mask = Image.fromarray(np.uint8(raw.astype(float) * (255 / np.iinfo(raw.dtype).max))).convert("L")
    bark, leaves = load_tree(folder, leaf_mask)
    bark = compact_bark(bark)
    heading = np.radians(json.loads((ROOT / "context.json").read_text())["oneMap"]["headingDegrees"])
    compass = np.array([[-np.cos(heading), 0, np.sin(heading)], [0, 1, 0],
                        [np.sin(heading), 0, np.cos(heading)]])
    shapes = [fit_tree(bark, leaves, tree, compass) for tree in register["trees"]]
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
                       "定位": "经纬度、树种、树高和胸围档取自名录。根部依浏览器地表交点，单株冠幅按 SLA / OneMap 正射影像四向估读。相接冠缘、档内高度、胸围和枝形为估值。",
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
