"""Bake one pair of leaf and trunk meshes for a surveyed stand of small broadleaf trees."""

import hashlib

import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from fullerton_shrubs import combined
from grove_occlusion import assign_occlusion, neighbouring_sky, use_occlusion_uv
from scanned_canopy import sample_scan, slices, write_tree_asset


def bake_stand(scan_folder, trees, median, label, *, sky_survey=None):
    points, albedo, canopy, bark = sample_scan(scan_folder, "tree_small_02")
    xyz, uv, normals, faces, atlas = slices(points, albedo, canopy, fit_opacity=True)
    paint = PBRMaterial(name=label + " crowns", baseColorTexture=atlas,
                        metallicFactor=0, roughnessFactor=.97, alphaMode="MASK", alphaCutoff=.40)
    crown = trimesh.Trimesh(vertices=xyz, faces=faces, vertex_normals=normals,
                             visual=TextureVisuals(uv=uv, material=paint), process=False)
    bark.visual.material.name = label + " bark"
    foot = np.median(bark.vertices[bark.vertices[:, 1] < .08], axis=0)
    foot[1] = bark.bounds[0, 1]
    crowns, trunks, tones = [], [], []
    for tree in trees:
        diameter = tree["crownDiameterMetres"]
        rng = np.random.default_rng(int(tree["treeId"])) if "heightUpper" in tree else None
        height = tree["heightUpper"] - rng.uniform(.6, 2.4) if rng is not None else tree["estimatedHeightMetres"]
        if "sourceYawDegrees" in tree:
            axes = [diameter, height, diameter]
            angle = np.radians(tree["sourceYawDegrees"])
        else:
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
    leaf_visibility = np.concatenate([leaf for leaf, _ in visibility])
    if sky_survey is not None:
        with np.load(sky_survey, allow_pickle=False) as survey:
            positions = np.rint(foliage.vertices * 1000).astype("<i4")
            if hashlib.sha256(positions.tobytes()).hexdigest() != survey["positionDigest"].item():
                raise ValueError("The district skylight survey does not match these crown positions")
            leaf_visibility *= survey["visibility"].astype(float) / 65535
    assign_occlusion(foliage, leaf_visibility)
    assign_occlusion(wood, np.concatenate([stem for _, stem in visibility]))
    scene = trimesh.Scene()
    scene.add_geometry(foliage, geom_name=paint.name)
    scene.add_geometry(wood, geom_name=bark.visual.material.name)
    return write_tree_asset(scene, use_occlusion_uv)
