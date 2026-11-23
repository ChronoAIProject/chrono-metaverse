"""Reconstruct the layered planting beside the One Fullerton entrance from its daylight photo."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial

from fullerton_shrubs import canopy_shade, combined, specimens

ROOT = Path(__file__).resolve().parents[1]


def foliage_atlas(near, distant):
    # Three photographed colour groups, applied to the same scanned leaf veins
    # and twig cutouts. The original UVs have margins inside each tile.
    atlas = Image.new("RGBA", (1024, 1536))
    for col, parts in enumerate([near, distant]):
        image = parts[0].visual.material.baseColorTexture.convert("RGBA")
        image = image.resize((512, 512), Image.Resampling.LANCZOS)
        pixels = np.array(image)
        rgb = pixels[:, :, :3].astype(float)
        # Keep brown twigs. For each leaf, preserve its local light variations.
        leaf = np.clip((rgb[:, :, 1] - rgb[:, :, 0] + 18) / 24, 0, 1)[:, :, None]
        for row, tint in enumerate([[1.13, 1.28, .75], [.76, 1.13, .70], [1.43, .63, .62]]):
            tile = pixels.copy()
            tile[:, :, :3] = np.uint8(np.clip(rgb * (1 + leaf*(np.array(tint)-1)), 0, 255))
            atlas.paste(Image.fromarray(tile), (col*512, row*512))
    # Retain four edge-coverage levels for the viewer's multisampled leaf cutouts.
    colors = atlas.convert("RGB").quantize(64, method=Image.Quantize.MEDIANCUT)
    coverage = np.rint(np.asarray(atlas.getchannel("A"), dtype=float)/85).astype(np.uint8)
    packed = Image.frombytes("P", atlas.size, (np.asarray(colors) + 64*coverage).tobytes())
    packed.putpalette(colors.getpalette()[:192]*4)
    packed.info["transparency"] = bytes(alpha for alpha in (0, 85, 170, 255) for _ in range(64))
    packed.format = "PNG"
    return PBRMaterial(name="Fullerton entrance shrub foliage", baseColorTexture=packed,
                       alphaMode="MASK", alphaCutoff=.43, metallicFactor=0, roughnessFactor=.93, doubleSided=True)


def shrub_shape(x, s):
    # Silhouette and ordering read from the 2014 view across the bay. The actual
    # cultivars and individual planting centres are not recorded.
    border = x < 4.12 or s < 106.65
    if border:
        return 0, .30 + .08*np.sin(s*1.2)
    mounds = [(5.24, 108.22, .74, 1.12, .54), (5.46, 111.0, 1.00, 1.63, .68),
              (4.95, 115.27, .85, 1.55, .49)]
    rises = [h*np.exp(-.58*(((x-cx)/w)**2 + ((s-cs)/length)**2)) for cx,cs,w,length,h in mounds]
    return (2 if s > 113.35 + .48*np.cos(2*x) else 1), .32 + max(rises)


def bake(folder, alpha):
    near, distant = specimens(folder, alpha, triangle_budget=130)
    shared = foliage_atlas(near, distant)
    quay = json.loads((ROOT / "context.json").read_text())["quay"]
    start = np.array(quay["start"])
    along = np.array(quay["end"]) - start
    along[1] = 0
    along /= np.linalg.norm(along)
    inland = np.cross([0, 1, 0], along)
    basis = np.column_stack((inland, [0, 1, 0], along))
    rng = np.random.default_rng(53108)
    plants = []
    for row, lane in enumerate([3.92, 4.39, 4.90, 5.4, 5.91, 6.22]):
        for station in np.arange(105.33 + .20*(row%2), 117.16, .39):
            x, s = lane + rng.uniform(-.08, .08), station + rng.uniform(-.10, .10)
            if s < 105.22 + .21*(x-3.52) or min(np.hypot(x-4.9, s-108), np.hypot(x-4.8, s-114.2)) < .47:
                continue
            tone, height = shrub_shape(x, s)
            height *= rng.uniform(.92, 1.07)
            # Carry real leaf geometry along the two exposed edges. Each inner
            # cutting uses four photographed views of the same 3D specimen.
            close = (row == 0 or s < 106.4) and rng.random() < .68
            ix = rng.integers(4)
            mesh = (near if close else distant)[ix].copy()
            turn = trimesh.transformations.rotation_matrix(rng.uniform(-np.pi, np.pi), [0, 1, 0])[:3,:3]
            bounds = np.ptp(near[ix].vertices @ turn.T, axis=0)
            span = rng.uniform(.65, .85)
            transform = np.eye(4)
            transform[:3,:3] = basis @ np.diag(np.array([span, height, span])/bounds) @ turn
            transform[:3,3] = start + x*inland + s*along + [0,.265,0]
            normals = mesh.vertex_normals @ np.linalg.inv(transform[:3,:3])
            mesh.apply_transform(transform)
            mesh.vertex_normals = normals / np.maximum(np.linalg.norm(normals, axis=1)[:,None], 1e-12)
            mesh.visual.uv = (mesh.visual.uv + [int(not close), 2-tone]) / [2,3]
            mesh.visual.material = shared
            plants.append(mesh)
    mass = combined(plants)
    canopy_shade(mass, [mass])
    low, high = mass.bounds.copy()
    origin = (low + high) / 2
    origin[1] = low[1]
    mass.apply_translation(-origin)
    data = trimesh.exchange.gltf.export_glb(trimesh.Scene(mass), include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    return dict(entityId="bay.fullerton-entrance-shrubs", kind="structure", layer="ext",
                regionId="marina-bay-exterior", label="One Fullerton · 入口北侧矮篱与红叶种植带",
                assetHash=digest, bounds={"min": low.tolist(), "max": high.tolist()}, material={"shading": "albedo"},
                props={"background": True, "surfaceRole": "landscape",
                       "实景参照": "https://commons.wikimedia.org/wiki/File:Singapore_-_panoramio_(109).jpg",
                       "种植依据": "拟合 2014 年实景中临水侧矮篱、中央绿篱、北端红叶灌木的相对顺序和高度。株位、颜色、品种及当代修剪状态未经现场核实。",
                       "素材": "Poly Haven · Shrub 04 · Rico Cilliers · CC0 · https://polyhaven.com/a/shrub_04"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Poly Haven Shrub 04 1k glTF folder")
    parser.add_argument("alpha", type=Path, help="Shrub 04 opacity map")
    args = parser.parse_args()
    entry = bake(args.folder, args.alpha)
    path = ROOT / "build/streetscape.json"
    records = {e["entityId"]: e for e in json.loads(path.read_text())}
    records[entry["entityId"]] = entry
    path.write_text(json.dumps(list(records.values()), indent=2, ensure_ascii=False) + "\n")
    print(entry["assetHash"])
