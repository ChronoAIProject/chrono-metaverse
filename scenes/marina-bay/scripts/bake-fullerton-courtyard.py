"""Place the two OneMap crowns in the paved gap between the waterfront awnings."""

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from courtyard_tree import load_tree

ROOT = Path(__file__).resolve().parents[1]
TREE_ASSET = "9a9adc6e6c5b9ea0a5665793c88ae813487e84ced68a4043e23270683cbcef3a"
PHOTO = "https://commons.wikimedia.org/wiki/File:One_Fullerton_12-05-2024(5).jpg"
GROUND = .22


def box(dimensions, center):
    mesh = trimesh.creation.box(dimensions)
    mesh.apply_translation(center)
    return mesh


def surface(meshes, material):
    mesh = trimesh.util.concatenate(meshes)
    xyz = mesh.vertices[mesh.faces].reshape(-1, 3)
    mesh = trimesh.Trimesh(vertices=xyz, faces=np.arange(len(xyz)).reshape(-1, 3), process=False)
    mesh.vertex_normals = np.repeat(mesh.face_normals, 3, axis=0)
    mesh.visual = TextureVisuals(uv=np.column_stack((xyz[:, 2], xyz[:, 0] + xyz[:, 1])) / 1.2, material=material)
    return mesh


def specimens(source):
    bark, leaves = load_tree(source)
    bottom = bark.vertices[:, 1].min()
    foot = bark.vertices[bark.vertices[:, 1] < bottom + .09][:, [0, 2]].mean(axis=0)
    height = leaves.vertices[:, 1].max() - bottom
    placed = [[], []]
    for trunk, crown, dimensions, angle in [
        ([4.66, 57.35], [4.45, 57.20], [6.5, 7.2, 6.05], .61),
        ([4.26, 65.15], [3.40, 65.30], [6.7, 7.75, 7.15], -1.4),
    ]:
        co, si = math.cos(angle), math.sin(angle)
        rotation = np.array([[co, -si], [si, co]])
        canopy = (leaves.vertices[:, [0, 2]] - foot) @ rotation
        scale = np.array(dimensions)[[0, 2]] / np.ptp(canopy, axis=0)
        lean = np.array(crown) - trunk - (canopy.max(axis=0) + canopy.min(axis=0)) / 2 * scale
        for meshes, source_mesh in zip(placed, [bark, leaves], strict=True):
            mesh = source_mesh.copy()
            xyz = mesh.vertices.copy()
            h = np.clip((xyz[:, 1] - bottom) / height, 0, 1)
            spread = .66 + .34 * np.clip(h / .38, 0, 1)
            xyz[:, [0, 2]] = ((xyz[:, [0, 2]] - foot) @ rotation * scale * spread[:, None]
                              + trunk + np.clip(h / .45, 0, 1)[:, None] * lean)
            xyz[:, 1] = GROUND + .29 + dimensions[1] * (.75 * h + .25 * (1 - np.exp(-6 * h)) / (1 - np.exp(-6)))
            mesh.vertices = xyz
            if source_mesh is leaves:
                normals = source_mesh.vertex_normals.copy()
                normals[:, [0, 2]] = normals[:, [0, 2]] @ rotation / scale
                normals[:, 1] /= dimensions[1] / height
                mesh.vertex_normals = normals / np.linalg.norm(normals, axis=1)[:, None]
            meshes.append(mesh)
    result = {}
    for meshes in placed:
        first, second = meshes
        material = first.visual.material
        result[material.name] = trimesh.Trimesh(
            vertices=np.vstack((first.vertices, second.vertices)),
            faces=np.vstack((first.faces, second.faces + len(first.vertices))),
            vertex_normals=np.vstack((first.vertex_normals, second.vertex_normals)),
            visual=TextureVisuals(uv=np.vstack((first.visual.uv, second.visual.uv)), material=material), process=False)
    return result


def underplanting(material):
    rng = np.random.default_rng(56066)
    vertices, faces, uv = [], [], []
    for center_x, center_z in [(4.86, 57.60), (4.80, 64.87)]:
        for x in [-.72, -.24, .24, .72]:
            for z in [-.90, -.45, 0, .45, .90]:
                if abs(x) < .3 and abs(z) < .46:
                    continue
                base = np.array([center_x + x + rng.uniform(-.07, .07), GROUND + .29,
                                 center_z + z + rng.uniform(-.06, .06)])
                for i in range(9):
                    angle = i * 2.4 + rng.uniform(-.5, .5)
                    horizontal = np.array([math.cos(angle), 0, math.sin(angle)])
                    side = np.array([-math.sin(angle), 0, math.cos(angle)])
                    height, spread = rng.uniform(.30, .65), rng.uniform(.14, .36)
                    tile, start = rng.integers(4), len(vertices)
                    for t in [0, .52, 1]:
                        middle = base + horizontal * spread * t ** 1.35 + [0, height * math.sin(t * 1.9), 0]
                        for sign in [-1, 1]:
                            vertices.append(middle + sign * side * .105)
                            uv.append([(tile % 2 + .5 + sign * .485) / 2, (tile // 2 + .012 + t * .976) / 2])
                    faces.extend([[start + i for i in face] for face in [(0, 3, 1), (0, 2, 3), (2, 5, 3), (2, 4, 5)]])
    return trimesh.Trimesh(vertices=vertices, faces=faces, visual=TextureVisuals(uv=uv, material=material), process=False)


def courtyard(source):
    config = json.loads((ROOT / "context.json").read_text())
    model = trimesh.load_scene(ROOT / "assets" / f"{TREE_ASSET}.glb", process=False)
    geometry = specimens(source)
    shrubs = trimesh.load_scene(ROOT / "assets/10b26f08617ccd5b234fa588dd95e3e468d2dc239c70c841c64130ab2dbd95da.glb", process=False)
    geometry["Low planting"] = underplanting(shrubs.geometry["geometry_0"].visual.material)
    stone = Image.open(ROOT / "assets" / (config["quay"]["granite"]["color"] + ".webp")).convert("RGB")
    stone.thumbnail((384, 384))
    stone.format = "JPEG"
    paving = PBRMaterial(name="Courtyard paving", baseColorTexture=stone, baseColorFactor=[132, 131, 122, 255],
                         metallicFactor=0, roughnessFactor=.89)
    edging = PBRMaterial(name="Dark planter edging", baseColorTexture=stone, baseColorFactor=[35, 38, 37, 255],
                         metallicFactor=.12, roughnessFactor=.72)
    flags = []
    left, right, start_z, end_z = 3.48, 11.22, 56.23, 66.32
    rows = 13
    step = (right - left) / rows
    for row in range(rows):
        boundaries = [start_z, *np.arange(start_z + (.6 if row % 2 else 1.2), end_z - .02, 1.2), end_z]
        for z0, z1 in zip(boundaries, boundaries[1:]):
            flags.append(box([step - .006, .12, z1 - z0 - .007],
                             [left + (row + .5) * step, GROUND - .06, (z0 + z1) / 2]))
    geometry["Coursed stone"] = surface(flags, paving)
    rims, soil = [], []
    for x, z in [(4.86, 57.60), (4.80, 64.87)]:
        width, length, rim, height = 2.17, 2.53, .115, .37
        for side in [-1, 1]:
            rims.append(box([rim, height, length], [x + side * (width - rim) / 2, GROUND + height / 2, z]))
            rims.append(box([width - 2 * rim, height, rim], [x, GROUND + height / 2, z + side * (length - rim) / 2]))
        soil.append(box([width - 2 * rim, .08, length - 2 * rim], [x, GROUND + .25, z]))
    geometry["Planter edging"] = surface(rims, edging)
    geometry["Tree beds"] = surface(soil, model.geometry["Root litter"].visual.material)
    start, end = (np.array(config["quay"][key]) for key in ["start", "end"])
    direction = (end - start)[[0, 2]]
    direction /= np.linalg.norm(direction)
    inland = direction[[1, 0]] * [1, -1]
    scene = trimesh.Scene()
    for name, mesh in geometry.items():
        v = mesh.vertices.copy()
        normals = mesh.vertex_normals.copy()
        mesh.vertices = np.column_stack((start[0] + inland[0] * v[:, 0] + direction[0] * v[:, 2],
                                         start[1] + v[:, 1],
                                         start[2] + inland[1] * v[:, 0] + direction[1] * v[:, 2]))
        normals[:, [0, 2]] = normals[:, [0, 2]] @ np.array([inland, direction])
        mesh.vertex_normals = normals
        scene.add_geometry(mesh, geom_name=name)
    low, high = scene.bounds
    origin = (low + high) / 2
    origin[1] = low[1]
    for mesh in scene.geometry.values():
        mesh.apply_translation(-origin)
    # Accumulate area-weighted normals in the final coordinate frame. Thin bark
    # triangles along a UV seam can cancel after simplification; use an adjacent
    # valid normal there so the reflected lighting stays finite at grazing angles.
    bark = scene.geometry["Island tree bark"]
    tri = bark.triangles
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    normals = np.zeros_like(bark.vertices)
    for column in bark.faces.T:
        np.add.at(normals, column, cross)
    lengths = np.linalg.norm(normals, axis=1)
    good = lengths > 1e-9
    normals[good] /= lengths[good, None]
    if not good.all():
        from scipy.spatial import cKDTree
        _, near = cKDTree(bark.vertices[good]).query(bark.vertices[~good])
        normals[~good] = normals[good][near]
    bark.vertex_normals = normals
    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    file = ROOT / "build/streetscape.json"
    records = {entity["entityId"]: entity for entity in json.loads(file.read_text())}
    entity_id = "bay.fullerton-courtyard-trees"
    records[entity_id] = dict(entityId=entity_id, regionId=records["bay.fullerton-middle-terraces"]["regionId"],
                              label="One Fullerton · 临水树池与石铺小广场", kind="structure", layer="ext",
                              assetHash=digest, bounds={"min": low.tolist(), "max": high.tolist()},
                              material={"shading": "albedo"},
                              props={"background": True, "surfaceRole": "landscape", "现场参考": PHOTO,
                                     "树模型": "https://polyhaven.com/a/island_tree_01", "树冠参考": "OneMap OrthoJPG，20 级，南段与中段雨棚间两处树冠。",
                                     "定位": "树冠中心和宽度按航拍估读。树干位置、高度、树池及铺装接缝为估值，树种未核实。",
                                     "素材": "Poly Haven · Island Tree 01、Shrub 01、Brown Mud Leaves 01 及花岗岩 · CC0。"})
    file.write_text(json.dumps(list(records.values()), ensure_ascii=False, indent=2) + "\n")
    print(digest, len(data))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tree", type=Path, help="Directory with the Poly Haven Island Tree 01 1k glTF, binary and diffuse maps")
    courtyard(parser.parse_args().tree)
