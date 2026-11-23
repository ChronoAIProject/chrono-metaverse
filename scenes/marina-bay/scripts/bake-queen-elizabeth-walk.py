"""Place the ten NParks yellow flame trees along Queen Elizabeth Walk."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh

from courtyard_tree import fit_crown, load_masked_tree, preserve_crown_normals
from fullerton_shrubs import combined

ROOT = Path(__file__).resolve().parents[1]
REGISTER = ROOT / "references/queen-elizabeth-walk-trees.json"
HEIGHTS = {">9 but ≤12": (9, 12), ">12 but ≤15": (12, 15), ">15 but ≤18": (15, 18)}
GIRTHS = {"1.1 - 1.5": (1.1, 1.5), "> 1.5": (1.6, 2.25)}


def adjust_crown_outline(mesh, foot, compass, gains):
    """Fit the outer branch spread between eight compass bearings."""
    local = (mesh.vertices - foot) @ compass.T
    horizontal = local[:, [0, 2]].copy()
    radius = np.linalg.norm(horizontal, axis=1)
    radial = horizontal / np.maximum(radius[:, None], 1e-8)
    tangent = np.column_stack((-radial[:, 1], radial[:, 0]))
    sector = np.mod(np.arctan2(horizontal[:, 1], horizontal[:, 0]), 2 * np.pi) * len(gains) / (2 * np.pi)
    left = np.floor(sector).astype(int) % len(gains)
    frac = sector - np.floor(sector)
    delta = gains[(left + 1) % len(gains)] - gains[left]
    gain = gains[left] - 1 + delta * frac**2 * (3 - 2 * frac)
    angular_slope = delta * 6 * frac * (1 - frac) * len(gains) / (2 * np.pi)
    # Keep the root and the first metre of the trunk fixed. The full measured
    # spread begins at three metres from the stem, around the outer branches.
    f = np.clip((radius - 1) / 2, 0, 1)
    blend = f**2 * (3 - 2 * f)
    scale = 1 + blend * gain
    gradient = (gain * 3 * f * (1 - f))[:, None] * radial
    gradient += (blend * angular_slope / np.maximum(radius, 1e-8))[:, None] * tangent
    jacobian = scale[:, None, None] * np.eye(2) + horizontal[:, :, None] * gradient[:, None, :]
    normals = mesh.vertex_normals @ compass.T
    normals[:, [0, 2]] = np.linalg.solve(jacobian.transpose(0, 2, 1), normals[:, [0, 2], None])[:, :, 0]
    local[:, [0, 2]] *= scale[:, None]
    mesh.vertices = local @ compass + foot
    mesh.vertex_normals = (normals @ compass) / np.linalg.norm(normals, axis=1)[:, None]


def fit_tree(bark, leaves, record, compass):
    rng = np.random.default_rng(int(record["treeId"]))
    height = rng.uniform(*HEIGHTS[record["heightBand"]])
    girth = rng.uniform(*GIRTHS[record["girthBand"]])
    angle = rng.uniform(0, 2 * np.pi)
    extent = record["crownExtentMetres"]
    lo = np.array([-extent["west"], -extent["south"]])
    hi = np.array([extent["east"], extent["north"]])
    x, z = record["localXZ"]
    foot = [x, record["groundY"]-.035, z]
    fit = record.get("crownOutlineFit")
    if fit:
        angle = np.radians(fit["sourceRotationDegrees"])
    meshes = fit_crown(bark, leaves, height, girth, angle, foot, lo, hi, compass)
    if fit:
        for mesh in meshes:
            adjust_crown_outline(mesh, foot, compass, np.asarray(fit["radialScale"]))
    return meshes


def bake(folder):
    register = json.loads(REGISTER.read_text())
    bark, leaves = load_masked_tree(folder)
    # Match the projected leaf area of a 16x linear-resolution reference across the bay.
    leaves.visual.material.alphaCutoff = .27
    heading = np.radians(json.loads((ROOT / "context.json").read_text())["oneMap"]["headingDegrees"])
    compass = np.array([[-np.cos(heading), 0, np.sin(heading)], [0, 1, 0],
                        [np.sin(heading), 0, np.cos(heading)]])
    shapes = [fit_tree(bark, leaves, tree, compass) for tree in register["trees"]]
    scene = trimesh.Scene()
    for group in zip(*shapes, strict=True):
        mesh = combined(group)
        if mesh.visual.material.name == "Island tree branch clusters":
            preserve_crown_normals(mesh)
            # glTF vertex colour multiplies albedo in linear light.
            tints = [np.rint(255 * np.array([*tree.get("foliageGainLinear", [1, 1, 1]), 1]))
                     for tree in register["trees"]]
            mesh.visual.vertex_attributes["color"] = np.repeat(
                np.asarray(tints, dtype=np.uint8), [len(crown.vertices) for crown in group], axis=0)
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
