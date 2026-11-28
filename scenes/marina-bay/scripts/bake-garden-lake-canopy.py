"""Build the planted area around Dragonfly Lake from the two Poly Haven tree scans."""

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from fullerton_shrubs import combined
from scanned_canopy import ROOT, scan_reflectance, slices, write_tree_asset


def bake_species(folder, species, group, survey, median):
    points, colors, shade, leaves, bark = scan_reflectance(folder, species, bark_triangles=90)
    sampling = dict(fit_opacity=True, layer_count=3, cells=2)
    positions, uv, normals, faces, atlas = slices(points, colors, leaves, **sampling)
    *_, shaded_atlas = slices(points, np.uint8(colors * shade[:, None]), leaves, **sampling)

    # Match the previous skylight response in linear light while leaving the scanned
    # base colour available to direct sun. Both atlases use the same cutout footprint.
    def luminance(image):
        rgb = np.asarray(image)[:, :, :3] / 255
        linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
        return linear @ [.2126, .7152, .0722]

    unshaded = luminance(atlas)
    visibility = np.divide(luminance(shaded_atlas), unshaded,
                           out=np.ones_like(unshaded), where=unshaded > 0)
    occlusion = Image.fromarray(np.uint8(np.rint(255 * np.clip(visibility, 0, 1))))
    occlusion.format = "PNG"
    paint = PBRMaterial(name=f"{species} garden crown", baseColorTexture=atlas,
                        occlusionTexture=occlusion,
                        roughnessFactor=.97, metallicFactor=0, alphaMode="MASK", alphaCutoff=.4)
    crown = trimesh.Trimesh(vertices=positions, faces=faces, vertex_normals=normals,
                            visual=TextureVisuals(uv=uv, material=paint), process=False)
    foot = np.median(bark.vertices[bark.vertices[:, 1] < .06], axis=0)
    foot[1] = bark.bounds[0, 1]
    batches = defaultdict(list)
    colors_by_batch = defaultdict(list)
    for i in range(group, len(survey["trees"]), 2):
        tree = survey["trees"][i]
        if tree.get("palmId"):
            continue
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
            vertex_colors = np.tile(np.uint8([*color, 255]), (len(mesh.vertices), 1))
            if name == "crown":
                # The normals point out of each crown, including its two-sided leaf cards.
                # Calibrate the upper canopy and the lake-facing sides in the same bake.
                upward = np.clip(mesh.vertex_normals[:, 1], 0, 1)
                gain = 1.50 + (0.62 - 1.50) * upward**2.4
                vertex_colors[:, :3] = np.rint(np.clip(vertex_colors[:, :3] * gain[:, None], 0, 255))
            colors_by_batch[key].append(vertex_colors)

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
                  "attribution": attribution,
                  "树冠高光": "根据步行与跨湖全景估算整簇叶片的镜面反射，给受光树冠保留柔和亮部。",
                  "crownSpecular": {"material": paint.name, "intensity": .30}},
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
