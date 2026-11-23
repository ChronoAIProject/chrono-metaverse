"""Build the inland Esplanade Park canopy from census trees and depth slices of a scanned broadleaf."""
import argparse
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from fullerton_shrubs import combined
from scanned_canopy import ROOT, sample_scan, slices, write_tree_asset

RAIN_TREE_HEADROOM = 1.4
# Median linear-light gain on the registered crowns after opening the foliage mask.
RAIN_TREE_MASK_GAIN = 1.045


def bake(folder, spreading_tree):
    ref = json.loads((ROOT/"references/esplanade-park-stand.json").read_text())
    points, colors, canopy, compact_bark_mesh = sample_scan(folder, "island_tree_01")
    compact_xyz, uv, compact_normals, faces, compact = slices(points, colors, canopy, fit_opacity=True)
    points, colors, canopy, spreading_bark_mesh = sample_scan(spreading_tree, "jacaranda_tree")
    spreading_xyz, _, spreading_normals, _, spreading = slices(points, colors, canopy, fit_opacity=True)
    stems = {0: [], 1: []}
    atlas = Image.new("RGBA", (compact.width, compact.height * 2))
    atlas.paste(compact, (0, 0))
    # Reserve linear tint range for the brighter surveyed crowns. Decode and re-encode
    # sRGB here because glTF vertex colours multiply the sampled texture in linear light.
    encoded = np.arange(256) / 255
    linear = np.where(encoded <= .04045, encoded / 12.92, ((encoded + .055) / 1.055)**2.4)
    boosted = np.minimum(1, linear * RAIN_TREE_HEADROOM)
    lut = np.rint(255 * np.where(boosted <= .0031308, 12.92 * boosted,
                                1.055 * boosted**(1/2.4) - .055)).astype(np.uint8)
    pixels = np.array(spreading)
    pixels[:, :, :3] = lut[pixels[:, :, :3]]
    atlas.paste(Image.fromarray(pixels), (0, compact.height))
    atlas.format = "PNG"
    paint = PBRMaterial(name="Esplanade Park layered broadleaf canopy", baseColorTexture=atlas,
                        metallicFactor=0, roughnessFactor=.98, alphaMode="MASK", alphaCutoff=.40)
    vertices, shading, tones, texcoords = [], [], [], []
    widths = {"Samanea saman":1.38,"Tabebuia rosea":.69,"Pterocarpus indicus":1.05,
              "Peltophorum pterocarpum":1.12}
    aerial_median = np.median([t["aerialRGB"] for t in ref["trees"]],axis=0)
    avenue = json.loads((ROOT / "references/connaught-drive-rain-trees.json").read_text())
    along = np.array(avenue["crownSurvey"]["alongLocalXZ"])
    along /= np.linalg.norm(along)
    road_axes = np.array([along, [-along[1], along[0]]])
    trees = ref["trees"] + avenue["trees"]
    for tree in trees:
        # Both source volumes use the same slice grid. Select its UV region for each crown.
        if tree["species"] == "Samanea saman":
            xyz, normals, bark, atlas_offset = spreading_xyz, spreading_normals, spreading_bark_mesh, 0
        else:
            xyz, normals, bark, atlas_offset = compact_xyz, compact_normals, compact_bark_mesh, 1
        tree_uv = uv.copy()
        tree_uv[:, 1] = (tree_uv[:, 1] + atlas_offset) / 2
        texcoords.extend(tree_uv)
        rng = np.random.default_rng(int(tree["treeId"]))
        height = tree["heightUpper"] - rng.uniform(.5,2.5)
        width = widths[tree["species"]] * height
        axes = np.array([width*rng.uniform(.86,1.07),height,width*rng.uniform(.84,1.04)])
        angle = rng.uniform(-np.pi,np.pi)
        basis = trimesh.transformations.rotation_matrix(angle,[0,1,0])[:3,:3]
        transform = basis @ np.diag(axes)
        fit = tree.get("crownFit")
        if fit:
            warp = np.eye(3)
            horizontal = np.ix_([0, 2], [0, 2])
            warp[horizontal] = road_axes.T @ np.diag(fit["scaleAlongAcross"]) @ road_axes
            # Shear from ground level so the visible crown can lean beyond the stem.
            warp[[0, 2], 1] = (fit["offsetAlongAcrossMetres"] @ road_axes) / (.70 * height)
            transform = warp @ transform
        x,z = tree["localXZ"]
        ground = np.array([x, tree["groundY"] - .04, z])
        normal_transform = np.linalg.inv(transform)
        mapped = (xyz - [.5, 0, .5]) @ transform.T + ground
        n = normals @ normal_transform
        vertices.extend(mapped)
        trunk = bark.copy()
        trunk.vertices = (bark.vertices - [.5, 0, .5]) @ transform.T + ground
        trunk_normals = bark.vertex_normals @ normal_transform
        trunk.vertex_normals = trunk_normals / np.linalg.norm(trunk_normals, axis=1)[:, None]
        stems[atlas_offset].append(trunk)
        shading.extend(n/np.linalg.norm(n,axis=1)[:,None])
        tint = np.clip((np.array(tree["aerialRGB"])/aerial_median)**.65,.70,1.13)
        color = np.minimum(255, 231*tint)
        if tree["species"] == "Samanea saman":
            color = (color * np.array(tree.get("foliageGainLinear", [1, 1, 1]))
                     * RAIN_TREE_MASK_GAIN / RAIN_TREE_HEADROOM)
        color = np.uint8(np.clip(np.rint(color), 0, 255)).tolist()
        tones.extend(np.tile([*color, 255], (len(xyz), 1)))
    visual = TextureVisuals(uv=np.asarray(texcoords), material=paint)
    visual.vertex_attributes["color"] = np.asarray(tones,np.uint8)
    mesh = trimesh.Trimesh(vertices=vertices,faces=np.vstack([faces+i*len(xyz) for i in range(len(trees))]),
                           vertex_normals=shading,visual=visual,process=False)
    scene = trimesh.Scene(mesh)
    for bark_source, group in [(spreading_bark_mesh, stems[0]), (compact_bark_mesh, stems[1])]:
        trunk_mesh = combined(group)
        trunk_mesh.visual.vertex_attributes["color"] = np.tile(bark_source.visual.vertex_attributes["color"], (len(group), 1))
        scene.add_geometry(trunk_mesh, geom_name=trunk_mesh.visual.material.name)
    digest, bounds = write_tree_asset(scene)
    return dict(entityId="bay.esplanade-park-stand",regionId="marina-bay-exterior",layer="ext",kind="structure",
                label="滨海公园 · 步道与康乐通道林冠",assetHash=digest,bounds=bounds,
                material={"shading":"albedo"},props={"background":True,"surfaceRole":"landscape","树木名录":ref["source"],
                "树木依据":"树位、树种与树高档来自 NParks 2021 名录。航拍参考树冠色差。各树枝形、冠径与档内高度为估值。",
                "林荫道":"康乐通道两侧额外 41 株雨树，树根高度取自浏览器地表。33 株树冠按 OneMap 航拍估读纵横冠幅及偏向。",
                "道路位置":avenue["road"],
                "树形素材":"Poly Haven · Island Tree 01、Jacaranda Tree · CC0。雨树借用蓝花楹展开的分枝形态，按名录高度和估计冠宽拟合；其余树使用 Island Tree 01。"})


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tree",type=Path)
    parser.add_argument("spreading_tree", type=Path, help="Directory containing the 1k Jacaranda Tree glTF")
    args = parser.parse_args()
    entry = bake(args.tree, args.spreading_tree)
    path=ROOT/"build/streetscape.json"
    records={r["entityId"]:r for r in json.loads(path.read_text())}
    records[entry["entityId"]]=entry
    path.write_text(json.dumps(list(records.values()),ensure_ascii=False,indent=2)+"\n")
    print(entry["assetHash"])
