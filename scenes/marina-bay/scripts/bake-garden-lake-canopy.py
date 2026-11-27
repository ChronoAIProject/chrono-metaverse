"""Build the planted area around Dragonfly Lake from the two Poly Haven tree scans."""

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from fullerton_shrubs import combined
from scanned_canopy import ROOT, sample_scan, slices, write_tree_asset


def bake_species(folder, species, group, survey, median):
    points, colors, leaves, bark = sample_scan(folder, species, bark_triangles=90)
    positions, uv, normals, faces, atlas = slices(
        points, colors, leaves, fit_opacity=True, layer_count=3, cells=2,
    )
    paint = PBRMaterial(name=f"{species} garden crown", baseColorTexture=atlas,
                        roughnessFactor=.97, metallicFactor=0, alphaMode="MASK", alphaCutoff=.4)
    crown = trimesh.Trimesh(vertices=positions, faces=faces, vertex_normals=normals,
                            visual=TextureVisuals(uv=uv, material=paint), process=False)
    foot = np.median(bark.vertices[bark.vertices[:, 1] < .06], axis=0)
    foot[1] = bark.bounds[0, 1]
    batches = defaultdict(list)
    colors_by_batch = defaultdict(list)
    for i in range(group, len(survey["trees"]), 2):
        tree = survey["trees"][i]
        x, z = tree["localXZ"]
        diameter = tree["radius"] * 2
        height = tree["height"]
        angle = i * 2.399963 + .012 * height
        rotation = trimesh.transformations.rotation_matrix(angle, [0, 1, 0])[:3, :3]
        basis = rotation @ np.diag([diameter, height, diameter])
        inverse = np.linalg.inv(basis)
        # Keep groups small enough to cull the far side of the garden from a shore view.
        sector = (int(np.floor((x + 1375) / 160)), int(np.floor((z - 313) / 160)))
        tint = 228 * np.clip((np.asarray(tree["rgb"]) / median) ** .68, .72, 1.10)
        for name, source, color in [("crown", crown, tint), ("bark", bark, [225, 225, 225])]:
            mesh = source.copy()
            mesh.vertices = (source.vertices - foot) @ basis.T + [x, survey["groundY"], z]
            n = source.vertex_normals @ inverse
            mesh.vertex_normals = n / np.linalg.norm(n, axis=1)[:, None]
            key = (*sector, name)
            batches[key].append(mesh)
            colors_by_batch[key].append(np.tile(np.uint8([*color, 255]), (len(mesh.vertices), 1)))

    scene = trimesh.Scene()
    for key, meshes in batches.items():
        mesh = combined(meshes)
        mesh.visual.vertex_attributes["color"] = np.vstack(colors_by_batch[key])
        scene.add_geometry(mesh, geom_name=f"{species} {key[0]} {key[1]} {key[2]}")
    attribution = " | ".join(survey["sources"].values())
    digest, bounds = write_tree_asset(scene, copyright=attribution)
    return {
        "entityId": f"bay.garden-lake-canopy-{group + 1}", "kind": "structure",
        "layer": "ext", "regionId": "marina-bay-exterior", "label": f"滨海湾花园 · 蜻蜓湖林带 {group + 1}",
        "assetHash": digest, "bounds": bounds, "material": {"shading": "albedo"},
        "props": {"background": True, "surfaceRole": "landscape",
                  "survey": "Gardens by the Bay canopy reconstructed from aerial and satellite data. Individual trees are estimated.",
                  "attribution": attribution},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("small_tree", type=Path, help="Poly Haven Tree Small 02 1k glTF directory")
    parser.add_argument("island_tree", type=Path, help="Poly Haven Island Tree 01 1k glTF directory")
    args = parser.parse_args()
    survey = json.loads((ROOT / "references/garden-lake-canopy.json").read_text())
    median = np.median([tree["rgb"] for tree in survey["trees"]], axis=0)
    entities = [bake_species(folder, species, group, survey, median)
                for group, (folder, species) in enumerate([(args.small_tree, "tree_small_02"),
                                                            (args.island_tree, "island_tree_01")])]
    (ROOT / "build/garden-lake-canopy.json").write_text(json.dumps(entities, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
