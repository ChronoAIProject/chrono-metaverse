"""Reconstruct the surveyed Sindora row at the Marina Boulevard waterfront."""

import argparse
import json
from pathlib import Path

import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from fullerton_shrubs import combined
from grove_occlusion import assign_occlusion, neighbouring_sky, use_occlusion_uv
from scanned_canopy import ROOT, sample_scan, slices, write_tree_asset


def bake(scan_folder):
    reference = json.loads((ROOT / "references/marina-boulevard-sindora.json").read_text())
    trees = reference["trees"]
    points, albedo, canopy, bark = sample_scan(scan_folder, "tree_small_02")
    xyz, uv, normals, faces, atlas = slices(points, albedo, canopy, fit_opacity=True)
    paint = PBRMaterial(name="Marina Boulevard Sindora crowns", baseColorTexture=atlas,
                        metallicFactor=0, roughnessFactor=.97, alphaMode="MASK", alphaCutoff=.40)
    crown = trimesh.Trimesh(vertices=xyz, faces=faces, vertex_normals=normals,
                             visual=TextureVisuals(uv=uv, material=paint), process=False)
    bark.visual.material.name = "Marina Boulevard Sindora bark"
    foot = np.median(bark.vertices[bark.vertices[:, 1] < .08], axis=0)
    foot[1] = bark.bounds[0, 1]
    median = np.array(reference["aerialReferenceRGB"])
    crowns, trunks, tones = [], [], []
    for tree in trees + reference["waterfrontCrowns"]:
        diameter = tree["crownDiameterMetres"]
        if "estimatedHeightMetres" in tree:
            height = tree["estimatedHeightMetres"]
            axes = [diameter, height, diameter]
            angle = np.radians(tree["sourceYawDegrees"])
        else:
            rng = np.random.default_rng(int(tree["treeId"]))
            height = tree["heightUpper"] - rng.uniform(.6, 2.4)
            axes = [diameter, height, diameter * rng.uniform(.86, 1)]
            angle = rng.uniform(-np.pi, np.pi)
        basis = trimesh.transformations.rotation_matrix(angle, [0, 1, 0])[:3, :3]
        transform = basis @ np.diag(axes)
        fit = tree.get("crownFit")
        if fit:
            major = np.array(fit["majorLocalXZ"])
            major /= np.linalg.norm(major)
            horizontal = np.stack((major, [-major[1], major[0]]))
            stretch = fit["stretch"]
            warp = np.eye(3)
            warp[np.ix_([0, 2], [0, 2])] = horizontal.T @ np.diag([stretch, 1 / stretch]) @ horizontal
            warp[[0, 2], 1] = np.array(fit["leanLocalXZ"]) / (.7 * height)
            transform = warp @ transform
        inverse = np.linalg.inv(transform)
        x, z = tree["localXZ"]
        ground = np.array([x, tree["groundY"] - .03, z])
        for source, group in [(crown, crowns), (bark, trunks)]:
            mesh = source.copy()
            mesh.vertices = (source.vertices - foot) @ transform.T + ground
            n = source.vertex_normals @ inverse
            mesh.vertex_normals = n / np.linalg.norm(n, axis=1)[:, None]
            group.append(mesh)
        tone = np.uint8(230 * np.clip((np.asarray(tree["aerialRGB"]) / median)**.68, .72, 1.10))
        tones.append(np.tile([*tone, 255], (len(xyz), 1)))

    foliage = combined(crowns)
    foliage.visual.vertex_attributes["color"] = np.vstack(tones).astype(np.uint8)
    wood = combined(trunks)
    wood.visual.vertex_attributes["color"] = np.tile(bark.visual.vertex_attributes["color"], (len(trunks), 1))
    visibility = neighbouring_sky([c.vertices for c in crowns], [c.vertex_normals for c in crowns],
                                  trunks, [uv] * len(crowns), faces[::2], atlas, paint.alphaCutoff)
    assign_occlusion(foliage, np.concatenate([leaf for leaf, _ in visibility]))
    assign_occlusion(wood, np.concatenate([stem for _, stem in visibility]))
    scene = trimesh.Scene()
    scene.add_geometry(foliage, geom_name=paint.name)
    scene.add_geometry(wood, geom_name=bark.visual.material.name)
    digest, bounds = write_tree_asset(scene, use_occlusion_uv)
    return dict(entityId="bay.marina-boulevard-sindora", regionId="marina-bay-exterior", layer="ext",
                kind="structure", label="滨海大道 · 两侧行道树", assetHash=digest, bounds=bounds,
                material={"shading": "albedo"},
                props={"background": True, "surfaceRole": "landscape", "树木名录": reference["source"],
                       "树木依据": f"{len(trees)} 株 Sindora wallichii 的树位和高度档取自 NParks 2021 名录。冠幅、偏向与色差按 OneMap 航拍估读，档内高度与枝形为估值。",
                       "滨水步道":"03391 站朝湾一侧另有两株树，冠幅与冠心来自航拍，树种未确认。树高分别估为 12 米和 9 米，枝形借用同一扫描。",
                       "树形素材": "Poly Haven · Tree Small 02 · CC0。使用 Burkea africana 的枝叶与主干近似同为豆科的 Sindora。"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Directory containing the 1k Tree Small 02 glTF")
    record = bake(parser.parse_args().folder)
    path = ROOT / "build/streetscape.json"
    entries = {entry["entityId"]: entry for entry in json.loads(path.read_text())}
    entries[record["entityId"]] = record
    path.write_text(json.dumps(list(entries.values()), ensure_ascii=False, indent=2) + "\n")
    print(record["assetHash"])
