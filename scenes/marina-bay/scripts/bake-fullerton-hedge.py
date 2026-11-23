"""Fit scanned shrubs to the four existing One Fullerton promenade troughs."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from trimesh.visual.texture import TextureVisuals

from fullerton_shrubs import canopy_shade, combined, specimens

ROOT = Path(__file__).resolve().parents[1]
TROUGHS = "10b26f08617ccd5b234fa588dd95e3e468d2dc239c70c841c64130ab2dbd95da"
ID = "bay.fullerton-planting"


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
