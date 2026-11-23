"""Fit scanned shrubs to the four existing One Fullerton promenade troughs."""

import argparse
import hashlib
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

ROOT = Path(__file__).resolve().parents[1]
TROUGHS = "10b26f08617ccd5b234fa588dd95e3e468d2dc239c70c841c64130ab2dbd95da"
ID = "bay.fullerton-planting"


def specimens(folder, alpha_path):
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
        source = {"position": mesh.vertices.ravel().tolist(), "faces": mesh.faces.ravel().tolist(), "targetTriangles": 250,
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


def hedge(folder, alpha):
    near, far = specimens(folder, alpha)
    quay = json.loads((ROOT / "context.json").read_text())["quay"]
    start, end = [np.asarray(quay[k]) for k in ("start", "end")]
    along = end - start
    along[1] = 0
    along /= np.linalg.norm(along)
    inland = np.array([along[2], 0, -along[0]])
    # These are the original troughs fitted to the green bands along the roof
    # survey. Derive each bed's planting line directly from its existing shell.
    model = trimesh.load_scene(ROOT / "assets" / (TROUGHS + ".glb"), process=False)
    shell, = [m for m in model.geometry.values() if m.visual.material.name == "Planting trough"]
    # The original asset anchor is the base centre of its surveyed entity bounds.
    shell = shell.copy()
    original = np.array([[261.62083824805416, -59.7922, 466.5661777064784],
                         [268.03682781048474, -58.869606386352174, 528.589962951647]])
    anchor = original.mean(axis=0)
    anchor[1] = original[0, 1]
    shell.apply_translation(anchor)
    shells = trimesh.graph.connected_components(shell.edges_unique, nodes=np.arange(len(shell.vertices)))
    rim = []
    for part in shells:
        points = shell.vertices[part] - start
        s, x = points @ along, points @ inland
        rim.append((s.min(), s.max(), (x.min() + x.max()) / 2, points[:, 1].max()))
    if len(rim) != 4:
        raise ValueError("Expected four connected planter shells")
    rng = np.random.default_rng(7304)
    groups = [[], [], []]
    soil_parts = []
    soil_asset = "9740d4d4ed2e439fca65a882ad55ea5707ea5307c6739bde8a2c5d10d01d9efb"
    soil = trimesh.load_scene(ROOT / "assets" / (soil_asset + ".glb"), process=False).geometry["Tree beds"].visual.material
    for s0, s1, x, top in sorted(rim):
        corners = np.array([[x-.20, s0+.065], [x-.20, s1-.065], [x+.20, s1-.065], [x+.20, s0+.065]])
        dirt = start + corners[:, :1] * inland + corners[:, 1:] * along + [0, top - .042, 0]
        soil_parts.append(trimesh.Trimesh(vertices=dirt, faces=[[0, 1, 2], [0, 2, 3]],
                          visual=TextureVisuals(uv=corners / .6, material=soil), process=False))
        count = max(1, round((s1 - s0) / .26))
        span = (s1 - s0) / count
        for j in range(count):
            s = s0 + (j + .5) * span + rng.uniform(-.036, .036)
            ix = int(rng.integers(len(near)))
            rotation = trimesh.transformations.rotation_matrix(rng.uniform(-np.pi, np.pi), [0, 1, 0])
            projected = near[ix].vertices @ rotation[:3, :3].T
            width = np.ptp(projected @ inland)
            length = np.ptp(projected @ along)
            height = np.ptp(projected[:, 1])
            dims = np.array([rng.uniform(.50, .67) / width,
                             rng.uniform(.42, .60) / height, rng.uniform(.58, .78) / length])
            basis = np.column_stack([inland, [0, 1, 0], along])
            rotation[:3, :3] = (basis * dims) @ basis.T @ rotation[:3, :3]
            rotation[:3, 3] = start + along * s + inland * (x + rng.uniform(-.025, .025)) + [0, top - .04, 0]
            for dest, proto in zip(groups[:2], (near[ix], far[ix])):
                m = proto.copy()
                # Preserve the source normals under a nonuniform scale.
                normals = m.vertex_normals @ np.linalg.inv(rotation[:3, :3])
                m.apply_transform(rotation)
                m.vertex_normals = normals / np.linalg.norm(normals, axis=1)[:, None]
                dest.append(m)
            # Fill the interior with neighbouring stems captured from the full
            # specimen. Offset them on both sides of the planted centreline.
            for side in (-1, 1):
                card = far[(ix + j + 1) % 4].copy()
                extra = trimesh.transformations.rotation_matrix(rng.uniform(-1.4, 1.4), [0, 1, 0])
                extra[:3, :3] *= rng.uniform(.64, .88)
                extra[:3, 3] = rng.uniform(.022, .036) * side * inland
                card.apply_transform(rotation @ extra)
                groups[2].append(card)
    dirt = combined(soil_parts)
    outer, inner, distant = combined(groups[0]), combined(groups[2]), combined(groups[1] + groups[2])
    canopy_shade(outer, [outer, inner, distant])
    return [(outer, inner, shell.copy(), dirt.copy()), (distant, shell.copy(), dirt.copy())]


def record(parts, template, focus, far):
    result = trimesh.Scene()
    for mesh in parts:
        result.add_geometry(mesh, geom_name=mesh.visual.material.name)
    low, high = result.bounds
    center = (low + high) / 2
    center[1] = low[1]
    for m in result.geometry.values():
        m.apply_translation(-center)
    def normal_strength(document):
        for mat in document["materials"]:
            if "normalTexture" in mat:
                mat["normalTexture"]["scale"] = .5
    data = trimesh.exchange.gltf.export_glb(result, include_normals=True, tree_postprocessor=normal_strength)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    return dict(template, entityId=ID + ("-distant" if far else ""), label="浮尔顿步道 · 灌木花槽" + ("远景" if far else ""),
                assetHash=digest, bounds={"min": low.tolist(), "max": high.tolist()},
                props={**template["props"], "source": {"library": "polyhaven", "id": "shrub_04",
                       "page": "https://polyhaven.com/a/shrub_04", "title": "Shrub 04", "author": "Rico Cilliers", "license": "CC0-1.0"},
                       "植被": "保留四个花槽的原位置及槽体。采用 Poly Haven 四株灌木参考样本，树种、株数和冠幅为估值。",
                       "backgroundView": {"focus": focus, "minDistance" if far else "maxDistance": 115}})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Directory containing the Poly Haven Shrub 04 1k glTF and textures")
    parser.add_argument("alpha", type=Path, help="Shrub 04 opacity map")
    args = parser.parse_args()
    parts = hedge(args.folder, args.alpha)
    path = ROOT / "build/streetscape.json"
    entities = {r["entityId"]: r for r in json.loads(path.read_text())}
    base = entities[ID]
    focus = parts[0][0].bounds.mean(axis=0).tolist()
    for i, pair in enumerate(parts):
        rec = record(pair, base, focus, bool(i))
        entities[rec["entityId"]] = rec
        print(rec["assetHash"], sum(len(m.faces) for m in pair))
    path.write_text(json.dumps(list(entities.values()), ensure_ascii=False, indent=2) + "\n")
