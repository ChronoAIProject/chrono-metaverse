"""Reconstruct the stone path on OSM way 467451181 at Queen Elizabeth Walk."""

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from context_geometry import geographic_point
from grove_occlusion import sky_below_crown, use_occlusion_uv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parents[1] / "recon/src"))
from metaverse_recon.context.convert import frame

# Distances along the OSM centreline, then widths towards the river and park.
# Estimated from cross sections of the SLA orthophoto, with the exposed stone
# embankment and the staggered viewing terraces outside the path.
SECTIONS = [(0, 1.8, 2.1), (7, 2.5, 2.0), (20, 3.25, 1.7), (47, 3.5, 1.8),
            (63, 3.8, 1.7), (80, 3.15, 1.8), (106, 2.7, 2.25), (143, 2.45, 2.55)]


def paving_material():
    assets = ROOT.parents[1] / "web/src/assets/geography"
    color = Image.open(assets / "pavers-color.webp").convert("RGB").resize((768, 768), Image.Resampling.LANCZOS)
    # Sampled paving at the viewing terrace is pale grey. Preserve joints and
    # grain from the scan, adjusting its brown cast to the adjacent stone.
    rgb = np.asarray(color, dtype=float)
    luminance = rgb @ np.array([.2126, .7152, .0722])
    color = Image.fromarray(np.uint8(np.clip(1.12 * luminance[:, :, None] + 24
                                            + .22 * (rgb - luminance[:, :, None]), 0, 255)))
    color.format = "JPEG"
    # The site's packed map stores tangent X/Y and roughness, in that order.
    packed = np.asarray(Image.open(assets / "pavers-surface.webp").resize((512, 512), Image.Resampling.LANCZOS))
    xy = (packed[:, :, :2] / 127.5 - 1) * .70
    z = np.sqrt(np.maximum(0, 1 - (xy ** 2).sum(axis=2)))
    normal = Image.fromarray(np.uint8(np.clip(np.dstack((xy, z)) * 127.5 + 127.5, 0, 255)))
    normal.format = "JPEG"
    roughness = Image.fromarray(np.dstack((np.full_like(z, 255, dtype=np.uint8),
                                           np.maximum(packed[:, :, 2], 128), np.zeros_like(packed[:, :, 2]))))
    roughness.format = "PNG"
    return PBRMaterial(name="Queen Elizabeth Walk paving stones", baseColorTexture=color,
                       baseColorFactor=[245, 242, 236, 255], normalTexture=normal,
                       metallicRoughnessTexture=roughness, metallicFactor=0, roughnessFactor=1)


def bake_tree_shade(mesh, stations, directions=96, pitch=.22):
    rows = json.loads((ROOT / "build/streetscape.json").read_text())
    row = next(row for row in rows if row["entityId"] == "bay.queen-elizabeth-walk-trees")
    scene = trimesh.load_scene(ROOT / "assets" / (row["assetHash"] + ".glb"), process=False)
    node = "Island tree branch clusters"
    transform, geometry = scene.graph[node]
    leaves = scene.geometry[geometry]
    center = np.mean([row["bounds"]["min"], row["bounds"]["max"]], axis=0)
    center[1] = row["bounds"]["min"][1]
    crown = trimesh.transform_points(leaves.vertices, transform) + center
    paint = leaves.visual.material
    alpha = np.asarray(paint.baseColorTexture.convert("RGBA"))[:, :, 3].astype(np.float32) / 255

    # Give the top and the two vertical faces their own lightmap strips. At each
    # texel interpolate the same triangles and normals that the viewer draws.
    widths = (6, 36, 6)
    height, width = 768, sum(widths)
    along = np.linspace(0, stations[-1], height)
    section = np.clip(np.searchsorted(stations, along, side="right") - 1, 0, len(stations) - 2)
    v = ((along - stations[section]) / np.diff(stations)[section])[:, None, None]
    n = len(stations)
    uvs, positions, normals = [], [], []
    for strip, pixels in enumerate(widths):
        u = np.linspace(0, 1, pixels)[None, :, None]
        diagonal = np.minimum(u, v)
        for attribute, result in [(mesh.vertices, positions), (mesh.vertex_normals, normals)]:
            a, b = attribute[2*strip*n:(2*strip+2)*n].reshape(2, n, 3)
            value = (a[section, None] * (1 - np.maximum(u, v)) + b[section+1, None] * diagonal
                     + a[section+1, None] * (v - diagonal) + b[section, None] * (u - diagonal))
            result.append(value)
        for end in (0, pixels - 1):
            column = (sum(widths[:strip]) + end + .5) / width
            uvs.append(np.column_stack((np.full(n, column), (.5 + stations / stations[-1] * (height - 1)) / height)))
    samples = np.concatenate(positions, axis=1).reshape(-1, 3)
    shading = np.concatenate(normals, axis=1).reshape(-1, 3)
    shading /= np.linalg.norm(shading, axis=1)[:, None]
    visibility = sky_below_crown(samples, shading, crown, leaves.faces, leaves.visual.uv,
                                 alpha, paint.alphaCutoff, directions, pitch)
    image = Image.fromarray(np.rint(255 * visibility.reshape(height, width)).astype(np.uint8)).convert("RGB")
    image.format = "PNG"
    mesh.visual.material.occlusionTexture = image
    mesh.vertex_attributes["_OCCLUSIONUV"] = np.vstack(uvs).astype(np.float32)


def bake():
    feature = json.loads((ROOT / "references/queen-elizabeth-walk.geojson").read_text())
    shift = np.array(json.loads((ROOT / "build/alignment.json").read_text())["shift"])
    origin, rotation = frame(json.loads((ROOT / "context.json").read_text())["oneMap"])
    path = np.array([geographic_point(lon, lat, origin, rotation, shift) for lon, lat in feature["geometry"]["coordinates"]])
    xz = path[:, [0, 2]]
    segments = np.diff(xz, axis=0)
    lengths = np.linalg.norm(segments, axis=1)
    distances = np.r_[0, np.cumsum(lengths)]
    width_stations, riverside, parkside = np.array(SECTIONS).T
    # Add cross sections where the width changes while retaining every surveyed bend.
    stations = np.unique(np.r_[distances, width_stations[width_stations < distances[-1]]])
    pivots = np.column_stack([np.interp(stations, distances, axis) for axis in xz.T])
    runs = np.diff(pivots, axis=0)
    dirs = runs[:, [1, 0]] * [1, -1] / np.linalg.norm(runs, axis=1)[:, None]
    normal = np.vstack([dirs[0], dirs[1:] + dirs[:-1], dirs[-1]])
    normal /= np.linalg.norm(normal, axis=1)[:, None]
    normal /= np.einsum("ij,ij->i", normal, np.vstack([dirs, dirs[-1]]))[:, None]
    map_y = json.loads((ROOT / "build/environment.json").read_text())["props"]["environment"]["map"]["origin"][1]
    ground = map_y - np.sum((pivots - shift[[0, 2]]) ** 2, axis=1) / (2 * 6371000)
    water = -np.interp(stations, width_stations, riverside)
    park = np.interp(stations, width_stations, parkside)
    vertices, uv, faces = [], [], []
    # The existing viewing terrace is 0.34 m above the map. Meet its surface
    # from below so its mapped zigzag edge remains visible where they overlap.
    # Duplicate edge vertices to keep the vertical faces out of the top normals.
    level = .324
    cross_section = [(water, -.01, water - level), (water, level, water),
                     (park, level, park), (park, -.01, park + level)]
    n = len(stations)
    for left, right in zip(cross_section, cross_section[1:]):
        start = len(vertices)
        for cross, lift, along_uv in [left, right]:
            xz = pivots + normal * cross[:, None]
            vertices.extend(np.column_stack((xz[:, 0], ground + lift, xz[:, 1])))
            uv.extend(np.column_stack((along_uv, stations)) / 2)
        for i in range(n - 1):
            a = start + i
            faces.extend([(a, a+1, a+n+1), (a, a+n+1, a+n)])
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, visual=TextureVisuals(uv=uv, material=paving_material()),
                           process=False)
    if mesh.vertex_normals[2*n:4*n, 1].min() < .99:
        raise ValueError("Inverted paving strip")
    bake_tree_shade(mesh, stations)
    low, high = mesh.bounds.copy()
    center = (low + high) / 2
    center[1] = low[1]
    mesh.apply_translation(-center)
    data = trimesh.exchange.gltf.export_glb(trimesh.Scene(mesh), include_normals=True,
                                            tree_postprocessor=use_occlusion_uv)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    return dict(entityId="bay.queen-elizabeth-walk-paving", kind="structure", layer="ext",
                regionId="marina-bay-exterior", label="伊丽莎白女王步道 · 临河铺石", assetHash=digest,
                bounds={"min": low.tolist(), "max": high.tolist()}, material={"shading": "albedo"},
                props={"background": True, "surfaceRole": "landscape", "路线": feature["properties"]["source"],
                       "地图来源": feature["properties"]["attribution"],
                       "影像来源": "Map Data © Singapore Land Authority / OneMap",
                       "铺装": "中心线、铺石类型来自 OSM。两侧宽度依正射影像估读，石材、砖缝及路面高程为估值。",
                       "材质来源": "Poly Haven · Granite Tile 04 · CC0 · https://polyhaven.com/a/granite_tile_04"})


if __name__ == "__main__":
    rec = bake()
    path = ROOT / "build/streetscape.json"
    entries = {entity["entityId"]: entity for entity in json.loads(path.read_text())}
    entries[rec["entityId"]] = rec
    path.write_text(json.dumps(list(entries.values()), ensure_ascii=False, indent=2) + "\n")
    print(rec["assetHash"])
