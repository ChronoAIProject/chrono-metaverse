"""Shared scanned shrub geometry, leaf cards and canopy occlusion."""

import json
import subprocess
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from scipy.ndimage import maximum_filter
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from skypark_canopy import tree_cards

def specimens(folder, alpha_path, triangle_budget=250):
    scene = trimesh.load_scene(folder / "shrub_04.gltf", process=False)
    texture = Image.open(folder / "textures/shrub_04_diff_1k.jpg").convert("RGBA")
    texture.putalpha(Image.open(alpha_path).convert("L").resize(texture.size, Image.Resampling.LANCZOS))
    texture = texture.resize((512, 512), Image.Resampling.LANCZOS)
    texture.format = "PNG"
    normal = Image.open(folder / "textures/shrub_04_nor_gl_1k.jpg").resize((512, 512), Image.Resampling.LANCZOS)
    normal.format = "JPEG"
    leaves = PBRMaterial(name="Promenade shrub leaves and branches", baseColorTexture=texture,
                         normalTexture=normal, baseColorFactor=[162, 179, 146, 255],
                         metallicFactor=0, roughnessFactor=.87, doubleSided=True, alphaMode="MASK", alphaCutoff=.44)
    near, far = [], []
    atlas = Image.new("RGBA", (384, 384))
    # Poly Haven packs four different cuttings in one mesh. Their root centres
    # are 0.17 m apart on X, including the translation in the source glTF.
    name, = scene.graph.nodes_geometry
    transform, key = scene.graph[name]
    all_shoots = scene.geometry[key].copy()
    all_shoots.apply_transform(transform)
    nearest_root = np.abs(all_shoots.triangles_center[:, :1] - [0, .17, .345, .515]).argmin(axis=1)
    for row in range(4):
        mesh = all_shoots.submesh([np.flatnonzero(nearest_root == row)], append=True)
        low, high = mesh.bounds
        mesh.apply_translation(-np.array([(low[0] + high[0]) / 2, low[1], (low[2] + high[2]) / 2]))
        mesh.visual.material = leaves
        source = {"position": mesh.vertices.ravel().tolist(), "faces": mesh.faces.ravel().tolist(), "targetTriangles": triangle_budget,
                  "attributes": np.column_stack([mesh.vertex_normals, mesh.visual.uv]).ravel().tolist()}
        proc = subprocess.run(["node", str(Path(__file__).with_name("simplify-skypark-tree.mjs"))],
                              input=json.dumps(source), text=True, check=True, capture_output=True)
        faces = np.asarray(json.loads(proc.stdout)).reshape(-1, 3)
        compact, indices = np.unique(faces, return_inverse=True)
        shrub = trimesh.Trimesh(vertices=mesh.vertices[compact], faces=indices.reshape(-1, 3),
                                vertex_normals=mesh.vertex_normals[compact],
                                visual=TextureVisuals(uv=mesh.visual.uv[compact], material=leaves), process=False)
        near.append(shrub)
        cards = tree_cards(mesh, normal_lift=.08)
        atlas.paste(cards.visual.material.baseColorTexture, (0, row * 96))
        cards.visual.uv[:, 1] = (cards.visual.uv[:, 1] + 3 - row) / 4
        far.append(cards)
    atlas.format = "PNG"
    distant = PBRMaterial(name="Distant promenade shrubs", baseColorTexture=atlas,
                          baseColorFactor=leaves.baseColorFactor, doubleSided=True, alphaMode="MASK",
                          alphaCutoff=.38, roughnessFactor=.9, metallicFactor=0)
    for cards in far:
        cards.visual.material = distant
    return near, far


def combined(meshes):
    vertices = np.vstack([m.vertices for m in meshes])
    offsets = np.cumsum([0] + [len(m.vertices) for m in meshes[:-1]])
    return trimesh.Trimesh(vertices=vertices, faces=np.vstack([m.faces + n for m, n in zip(meshes, offsets)]),
                           vertex_normals=np.vstack([m.vertex_normals for m in meshes]),
                           visual=TextureVisuals(uv=np.vstack([m.visual.uv for m in meshes]),
                                                 material=meshes[0].visual.material), process=False)


def canopy_shade(reference, meshes):
    # Sample nine sky directions on a 6 cm grid. Only vertices behind other
    # foliage lose diffuse light; the upper leaves retain their photographed colour.
    cloud = reference.vertices
    sky = [[0, 1, 0]] + [[.82*np.cos(a), .57, .82*np.sin(a)] for a in np.arange(8) * np.pi / 4]
    blocked = [np.zeros(len(m.vertices)) for m in meshes]
    for ray in np.asarray(sky):
        side = np.array([1, 0, 0]) if ray[1] == 1 else np.cross(ray, [0, 1, 0])
        side = side / np.linalg.norm(side)
        plane = np.column_stack([side, np.cross(ray, side)])
        projected = np.floor(cloud @ plane / .06).astype(int)
        low = projected.min(axis=0)
        indices = projected - low
        depth = np.full(indices.max(axis=0) + 1, -np.inf)
        np.maximum.at(depth, tuple(indices.T), cloud @ ray)
        depth = maximum_filter(depth, size=3)
        for mesh, shade in zip(meshes, blocked):
            pos = np.floor(mesh.vertices @ plane / .06).astype(int) - low
            inside = ((pos >= 0) & (pos < depth.shape)).all(axis=1)
            overlap = depth[tuple(pos[inside].T)] - mesh.vertices[inside] @ ray
            shade[inside] += 1 - np.exp(-np.maximum(0, overlap - .035) / .16)
    for mesh, coverage in zip(meshes, blocked):
        value = np.uint8(255 * (1 - .54 * coverage / len(sky)))
        mesh.visual.vertex_attributes["color"] = np.column_stack([value, value, value, np.full_like(value, 255)])
