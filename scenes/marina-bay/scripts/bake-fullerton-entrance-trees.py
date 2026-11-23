"""Fit two waterfront tree crowns to the aerial view beside the One Fullerton entrance."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from courtyard_tree import fit_crown, load_masked_tree, preserve_crown_normals, tag_foliage
from fullerton_shrubs import combined

ROOT = Path(__file__).resolve().parents[1]
COURTYARD = "9740d4d4ed2e439fca65a882ad55ea5707ea5307c6739bde8a2c5d10d01d9efb"
# Metres inland / along the registered quay. Adjacent outlines are read from
# the orthophoto. The stem locations, heights and girths are visual estimates.
TREES = [
    ((4.9, 108.0), (-.32, 104.55), (6.64, 111.27), 7.25, .76, .83),
    ((4.8, 114.2), (.27, 111.32), (7.09, 116.95), 6.85, .71, -1.37),
]


def planting_bed(materials):
    # The image resolves a planted margin. The kerb and soil level are estimated.
    # The base sits just below the browser ground hits at -60.289 m.
    outer = np.array([[3.52, 104.90], [6.62, 105.55], [6.62, 117.4], [3.52, 117.4]])
    inner = outer + [[.09, .11], [-.09, .075], [-.09, -.09], [.09, -.09]]
    def ring(outline, y):
        return np.column_stack((outline[:, 0], np.full(4, y), outline[:, 1]))

    border = np.concatenate([ring(outer, -.30), ring(outer, .355), ring(inner, .355), ring(inner, .28)])
    faces = []
    for index in range(4):
        following = (index + 1) % 4
        for a in [0, 4, 8]:
            faces.extend([[a+index, a+4+index, a+following], [a+following, a+4+index, a+4+following]])
    # The courtyard uses the scan as small cutout root decals. A raised bed
    # exposes the entire soil surface, including the corners of each repeat.
    litter = materials["Tree beds"].baseColorTexture.convert("RGB")
    litter.format = "JPEG"
    soil = PBRMaterial(name="Fullerton planted soil", baseColorTexture=litter,
                       roughnessFactor=1, metallicFactor=0)
    result = []
    for vertices, indices, material in [
        (border, faces, materials["Planter edging"]),
        (ring(inner, .284), [[0, 2, 1], [0, 3, 2]], soil),
    ]:
        # Split the top and sides at the stone arris, keeping planar normals and
        # a continuous soil pattern across the two top triangles.
        xyz = vertices[np.array(indices)].reshape(-1, 3)
        mesh = trimesh.Trimesh(vertices=xyz, faces=np.arange(len(xyz)).reshape(-1, 3),
                               visual=TextureVisuals(uv=np.c_[xyz[:, 0]+xyz[:, 1], xyz[:, 2]+xyz[:, 1]],
                                                     material=material), process=False)
        result.append(mesh)
    return result


def bake(folder):
    quay = json.loads((ROOT / "context.json").read_text())["quay"]
    start, end = np.array(quay["start"]), np.array(quay["end"])
    along = end - start
    along[1] = 0
    along /= np.linalg.norm(along)
    inland = np.cross([0, 1, 0], along)
    frame = np.array([inland, [0, 1, 0], along])
    bark, leaves = load_masked_tree(folder)
    specimens = []
    for stem, low, high, height, girth, yaw in TREES:
        x, s = stem
        foot = start + x*inland + s*along + [0, .264, 0]
        specimens.append(fit_crown(bark, leaves, height, girth, yaw, foot,
                                   np.subtract(low, stem), np.subtract(high, stem), frame))
    scene = trimesh.Scene()
    for meshes in zip(*specimens, strict=True):
        mesh = combined(meshes)
        if mesh.visual.material.name == "Island tree branch clusters":
            preserve_crown_normals(mesh)
        scene.add_geometry(mesh, geom_name=mesh.visual.material.name)
    courtyard = trimesh.load_scene(ROOT / "assets" / (COURTYARD + ".glb"), process=False)
    materials = {name: mesh.visual.material for name, mesh in courtyard.geometry.items()}
    transform = np.eye(4)
    transform[:3, :3], transform[:3, 3] = frame.T, start
    for mesh in planting_bed(materials):
        mesh.apply_transform(transform)
        scene.add_geometry(mesh, geom_name=mesh.visual.material.name)

    low, high = scene.bounds
    origin = (low + high) / 2
    origin[1] = low[1]
    for mesh in scene.geometry.values():
        mesh.apply_translation(-origin)
    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True, tree_postprocessor=tag_foliage)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    return dict(entityId="bay.fullerton-entrance-trees", kind="structure", layer="ext",
                regionId="marina-bay-exterior", label="One Fullerton · 入口北侧两株临水树", assetHash=digest,
                bounds={"min": low.tolist(), "max": high.tolist()}, material={"shading": "albedo"},
                props={"background": True, "surfaceRole": "landscape",
                       "影像来源": "Map Data © Singapore Land Authority / OneMap · OrthoJPG z20",
                       "实景参照": "https://commons.wikimedia.org/wiki/File:Singapore_-_panoramio_(109).jpg",
                       "植被依据": "两株树冠边界依正射影像估读。邻接冠缘、树干位置、树高、胸围和树池细部为估值。此处树种未经树木名录核实。",
                       "树形素材": "Poly Haven · Island Tree 01 · CC0 · https://polyhaven.com/a/island_tree_01"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Poly Haven Island Tree 01, 1k glTF and original leaf opacity")
    entry = bake(parser.parse_args().folder)
    path = ROOT / "build/streetscape.json"
    records = {e["entityId"]: e for e in json.loads(path.read_text())}
    records[entry["entityId"]] = entry
    path.write_text(json.dumps(list(records.values()), indent=2, ensure_ascii=False) + "\n")
    print(entry["assetHash"])
