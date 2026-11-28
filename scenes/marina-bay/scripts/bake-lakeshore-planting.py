"""Fit four scanned shrub specimens to the surveyed planting beside Dragonfly Lake."""
import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import trimesh

from fullerton_shrubs import combined, specimens
from scanned_canopy import ROOT, write_tree_asset


def bake(folder, alpha):
    survey = json.loads((ROOT / "references/dragonfly-lake-understorey.json").read_text())
    shrubs, _ = specimens(folder, alpha, triangle_budget=190)
    blocks = defaultdict(list)
    for index, (x, z, height, radius) in enumerate(survey["placements"]):
        source = shrubs[index % len(shrubs)]
        mesh = source.copy()
        low, high = mesh.bounds
        foot = (low + high) / 2
        foot[1] = low[1]
        width, source_height, depth = high - low
        horizontal = 2 * radius / max(width, depth)
        rotation = trimesh.transformations.rotation_matrix(index * 2.39996 + .12 * height, [0, 1, 0])
        basis = rotation[:3, :3] @ np.diag([horizontal, height / source_height, horizontal])
        mesh.vertices = (mesh.vertices - foot) @ basis.T + [x, survey["groundY"], z]
        normals = source.vertex_normals @ np.linalg.inv(basis)
        mesh.vertex_normals = normals / np.linalg.norm(normals, axis=1)[:, None]
        mesh.visual.material.name = "Lakeshore shrub foliage"
        # The strip follows the long axis of the lake. Keep one mesh per reach.
        sector = int(np.floor((z + 140) / 200))
        blocks[sector].append(mesh)

    scene = trimesh.Scene()
    for sector, meshes in blocks.items():
        scene.add_geometry(combined(meshes), geom_name=f"Lakeshore planting {sector}")
    credit = ("Shrub 04, Poly Haven, CC0. Placement estimated from OneMap imagery, "
              "Meta/WRI canopy heights and OpenStreetMap contributors (ODbL).")
    digest, bounds = write_tree_asset(scene, copyright=credit)
    manifest = ROOT / "build/dragonfly-lake-understorey.json"
    entity = json.loads(manifest.read_text())
    entity.update(assetHash=digest, bounds=bounds)
    manifest.write_text(json.dumps(entity, ensure_ascii=False, indent=2) + "\n")
    print(f"{len(survey['placements'])} planting locations, {digest}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Poly Haven Shrub 04 1k glTF folder")
    parser.add_argument("alpha", type=Path, help="Shrub 04 leaf opacity map")
    args = parser.parse_args()
    bake(args.folder, args.alpha)
