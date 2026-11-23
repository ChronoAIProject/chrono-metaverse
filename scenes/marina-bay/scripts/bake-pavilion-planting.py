"""Fit the visible pier planting to the OneMap aerial image and deck triangle heights."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh

from fullerton_shrubs import canopy_shade, combined, specimens

ROOT = Path(__file__).resolve().parents[1]
ENTITY = "bay.fullerton-pavilion-pier-planting"
# Crown centres in the original OneMap model frame. Each retained site has an
# upward-facing deck triangle directly beneath the orthophoto crown centre.
SITES = [
    (250.908, -59.14, 428.794), (242.717, -59.14, 408.403),
    (241.777, -59.14, 406.388), (241.170, -59.14, 404.380),
    (240.105, -59.14, 402.096), (239.373, -59.14, 399.820),
    (238.559, -59.14, 398.073), (237.692, -59.14, 395.861),
    (236.155, -59.14, 391.506), (235.539, -59.14, 389.831),
    (234.859, -59.14, 388.021), (228.518, -59.13, 372.656),
    (227.786, -59.13, 370.380),
]


def bake(folder, alpha):
    near, _ = specimens(folder, alpha, triangle_budget=150)
    near[0].visual.material.baseColorFactor = [193, 205, 154, 255]
    rng = np.random.default_rng(5293)
    shoots = []
    for site in SITES:
        phase = rng.uniform(0, 2 * np.pi)
        height = rng.uniform(.58, .82)
        for j in range(5):
            shoot = near[int(rng.integers(len(near)))].copy()
            angle = phase + j * 2 * np.pi / 5
            rotation = trimesh.transformations.rotation_matrix(angle, [0, 1, 0])
            extent = np.ptp(shoot.vertices, axis=0)
            scale = np.array([.74, height * rng.uniform(.85, 1.0), .72]) / extent
            rotation[:3, :3] *= scale
            rotation[:3, 3] = np.array(site) + [.22 * np.cos(angle), -.035, .22 * np.sin(angle)]
            normals = shoot.vertex_normals @ np.linalg.inv(rotation[:3, :3])
            shoot.apply_transform(rotation)
            shoot.vertex_normals = normals / np.linalg.norm(normals, axis=1)[:, None]
            shoots.append(shoot)
    plants = combined(shoots)
    canopy_shade(plants, [plants])
    low, high = plants.bounds.copy()
    focus = (low + high) / 2
    plants.apply_translation(-np.array([focus[0], low[1], focus[2]]))
    scene = trimesh.Scene()
    scene.add_geometry(plants, geom_name="Pier planting")
    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    return dict(entityId=ENTITY, layer="ext", regionId="marina-bay-exterior", kind="object",
                label="浮尔顿圆亭栈桥 · 岸侧植被", assetHash=digest,
                bounds={"min": low.tolist(), "max": high.tolist()}, material={"shading": "albedo"},
                props={"background": True, "backgroundView": {"focus": focus.tolist(), "maxDistance": 185},
                       "影像来源": "Map Data © Singapore Land Authority / OneMap",
                       "植被位置": "十三处冠丛中心取自 20 级正射影像，根部放在 SLA 栈桥三角面上。树种、冠高、枝形为估值。",
                       "植被素材": "Poly Haven · Shrub 04 · Rico Cilliers · CC0 · https://polyhaven.com/a/shrub_04"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("alpha", type=Path)
    args = parser.parse_args()
    rec = bake(args.folder, args.alpha)
    path = ROOT / "build/streetscape.json"
    records = {e["entityId"]: e for e in json.loads(path.read_text())}
    records[ENTITY] = rec
    path.write_text(json.dumps(list(records.values()), ensure_ascii=False, indent=2) + "\n")
    print(rec["assetHash"])
