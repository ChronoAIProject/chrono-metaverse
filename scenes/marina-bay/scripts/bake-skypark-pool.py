"""Extract the three SkyPark pool sections from the surveyed hotel roof."""

import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from skypark_geometry import ACROSS, ALONG, HOTEL_ID, ORIGIN

ROOT = Path(__file__).resolve().parents[1]
# Survey vertices around each stretch of blue water. The three inland spikes
# in the colour mask belong to deck objects and are excluded at the waterline.
BASINS = [
    [(-104.432, 12.004), (-102.04, 11.488), (-99.2, 10.828), (-90.84, 9.272),
     (-83.212, 8.028), (-70.172, 5.884), (-65.068, 5.144), (-64.0, 13.616),
     (-66.408, 13.92), (-77.004, 15.456), (-86.548, 17.064), (-94.516, 18.636), (-102.688, 20.176)],
    [(-61.936, 4.728), (-56.916, 4.10), (-39.892, 2.484), (-32.856, 2.08), (-30.012, 2.04),
     (-24.348, 1.688), (-11.516, 1.184), (-6.148, .812), (-6.096, 9.308), (-6.368, 9.424),
     (-15.212, 9.608), (-27.156, 10.256), (-40.084, 11.14), (-54.064, 12.36), (-60.876, 13.212)],
    [(-3.036, .792), (-.636, .780), (7.228, .776), (15.56, .94), (18.24, 1.196),
     (36.58, 2.176), (35.948, 10.748), (34.192, 10.596), (23.996, 9.944), (11.216, 9.536),
     (4.452, 9.44), (-1.528, 9.348), (-2.984, 9.292)],
]


def tile_finish():
    # An eight-tile repeat across two metres. Create a standard glTF fallback
    # with metric grout and a gently rippled normal even in a static viewer.
    y, x = np.indices((256, 256))
    gx, gy = x % 32, y % 32
    rng = np.random.default_rng(948)
    varied = rng.normal(0, 2.2, (8, 8))[y // 32, x // 32]
    rgb = np.array([72, 135, 136])[None, None, :] + varied[:, :, None]
    rgb += ((gx == 0) | (gy == 0))[:, :, None] * np.array([-6, -9, -9])
    color = Image.fromarray(np.uint8(rgb))
    color.format = "PNG"
    u, v = 2 * np.pi * x / 256, 2 * np.pi * y / 256
    dx = .13 * np.cos(3*u + 2*v + .7*np.sin(u - v)) + .06 * np.cos(5*v - 2*u)
    dy = .10 * np.cos(3*u + 2*v + .7*np.sin(u - v)) - .12 * np.cos(5*v - 2*u)
    normal = np.stack((dx, dy, np.ones_like(dx)), axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    ripple = Image.fromarray(np.uint8((normal * .5 + .5) * 255))
    ripple.format = "PNG"
    return PBRMaterial(name="SkyPark pool water", baseColorTexture=color, normalTexture=ripple,
                       roughnessFactor=.19, metallicFactor=0)


def pool(building):
    from shapely import constrained_delaunay_triangles
    from shapely.geometry import Polygon

    source = trimesh.load_scene(ROOT / "assets" / (building["assetHash"] + ".glb"), process=False)
    mesh, = [m for m in source.geometry.values() if isinstance(m.visual, TextureVisuals)]
    low, high = np.array([building["bounds"][k] for k in ("min", "max")])
    center = (low + high) / 2
    center[1] = low[1]
    vertices = mesh.vertices + center
    planar = (vertices[:, [0, 2]] - ORIGIN) @ np.array([ALONG, ACROSS]).T
    water = vertices[np.abs(vertices[:, 1] - 133.8) < .055]
    shore = planar[np.abs(vertices[:, 1] - 133.8) < .055]
    triangles = []
    for ring in BASINS:
        delta = np.linalg.norm(shore[:, None, :] - ring, axis=2)
        if delta.min(axis=0).max() > .018:
            raise ValueError("Pool edge does not match the measured hotel roof")
        measured = water[delta.argmin(axis=0)]
        polygon = Polygon(measured[:, [0, 2]])
        plane = np.linalg.lstsq(np.column_stack((measured[:, 0], measured[:, 2], np.ones(len(measured)))),
                                measured[:, 1], rcond=None)[0]
        for face in constrained_delaunay_triangles(polygon).geoms:
            xz = np.asarray(face.exterior.coords)[:3]
            xyz = np.column_stack((xz[:, 0], xz @ plane[:2] + plane[2] + .094, xz[:, 1]))
            if np.cross(xyz[1] - xyz[0], xyz[2] - xyz[0])[1] < 0:
                xyz = xyz[::-1]
            triangles.append(xyz)
    xyz = np.concatenate(triangles)
    low, high = xyz.min(axis=0), xyz.max(axis=0)
    center = (low + high) / 2
    center[1] = low[1]
    # Align the grain with the swimming lanes so the tile direction has a
    # natural metric reference when looking across the deck.
    uv = (xyz[:, [0, 2]] - ORIGIN) @ np.array([ALONG, ACROSS]).T / 2
    mesh = trimesh.Trimesh(vertices=xyz - center, faces=np.arange(len(xyz)).reshape(-1, 3),
                           visual=TextureVisuals(uv=uv, material=tile_finish()), process=False)
    mesh.merge_vertices()

    def tag_water(document):
        document["materials"][0]["extras"] = {"waterSurface": "pool"}

    data = trimesh.exchange.gltf.export_glb(trimesh.Scene(mesh), include_normals=True, tree_postprocessor=tag_water)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    return dict(entityId="bay.sands-skypark-pool", layer="ext", kind="structure", regionId=building["regionId"],
                label="滨海湾金沙 · 空中花园泳池", assetHash=digest, bounds={"min": low.tolist(), "max": high.tolist()},
                material={"shading": "albedo"}, props={"background": True, "surfaceRole": "landscape",
                    "来源": "Map Data © Singapore Land Authority / OneMap。三段水面沿酒店测绘网格轮廓配准。",
                    "材质": "池底颜色、泳池砖尺度及小波纹为日间视觉近似。"})


if __name__ == "__main__":
    buildings = json.loads((ROOT / "build/onemap-entities.json").read_text())
    record = pool(next(e for e in buildings if e["entityId"] == HOTEL_ID))
    path = ROOT / "build/streetscape.json"
    entities = {e["entityId"]: e for e in json.loads(path.read_text())}
    entities[record["entityId"]] = record
    path.write_text(json.dumps(list(entities.values()), ensure_ascii=False, indent=2) + "\n")
    print(record["assetHash"], record["bounds"])
