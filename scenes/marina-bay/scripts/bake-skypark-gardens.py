"""Build the two surveyed canopy groups on the Sands SkyPark garden deck."""

import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image, ImageOps
from shapely import constrained_delaunay_triangles, contains_xy, set_precision, union_all
from shapely.geometry import Point, Polygon, box
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from skypark_canopy import tree_cards

from skypark_geometry import ACROSS, ALONG, HOTEL_ID, ORIGIN

ROOT = Path(__file__).resolve().parents[1]
COURTYARD = "9740d4d4ed2e439fca65a882ad55ea5707ea5307c6739bde8a2c5d10d01d9efb"
# Along the SkyPark, across the deck, canopy diameter. Located by projecting
# the original SLA roof triangles and their colour atlas down onto the deck.
CROWNS = [
    (-126.88, 2.88, 3.25), (-125.12, -5.38, 6.95), (-118.38, -.88, 4.95),
    (-110.62, -8.62, 6.08), (-110.12, -2.88, 4.65), (-100.88, -9.88, 6.0),
    (12.12, -13.88, 3.78), (18.12, -19.38, 6.20), (19.12, -13.88, 3.88),
    (31.62, -18.88, 7.85), (32.62, -11.62, 5.75), (39.62, -17.88, 7.63),
    (51.88, -16.12, 6.12), (60.38, -17.12, 4.55), (77.62, -12.88, 5.33),
    (78.12, -6.12, 3.80),
]




def garden_decks(building):
    scene = trimesh.load_scene(ROOT / "assets" / (building["assetHash"] + ".glb"), process=False)
    mesh, = [m for m in scene.geometry.values() if isinstance(m.visual, TextureVisuals)]
    low, high = np.array([building["bounds"][k] for k in ("min", "max")])
    center = (low + high) / 2
    center[1] = low[1]
    triangles = mesh.triangles + center
    # Both gardens occupy gently sloping planes. Union their actual surveyed
    # faces before clipping to the two planted areas, leaving service roofs free.
    terraces = triangles[(np.abs(triangles[:, :, 1] - 135.86) < .064).all(axis=1)]
    frame = np.stack((ALONG, ACROSS))
    outlines = (terraces[:, :, [0, 2]] - ORIGIN) @ frame.T
    polygons = [Polygon(ring) for ring in outlines]
    footprint = union_all([set_precision(poly, .02) for poly in polygons if poly.area > .001])
    gardens = footprint.intersection(union_all([box(-134.5, -26, -81.7, 12), box(9.5, -26, 80.2, 12)]))
    points = terraces.reshape(-1, 3)
    plane = np.linalg.lstsq(np.column_stack((points[:, 0], points[:, 2], np.ones(len(points)))),
                            points[:, 1], rcond=None)[0]
    return gardens, plane


def deck_surface(polygon, lift, plane, material, uv_origin, uv_span):
    rings = [np.asarray(t.exterior.coords)[:3] for t in constrained_delaunay_triangles(polygon).geoms]
    local = np.concatenate(rings)
    xz = ORIGIN + local[:, :1] * ALONG + local[:, 1:] * ACROSS
    y = xz @ plane[:2] + plane[2] + lift
    xyz = np.column_stack((xz[:, 0], y, xz[:, 1]))
    faces = np.arange(len(xyz)).reshape(-1, 3)
    tri = xyz[faces]
    down = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])[:, 1] < 0
    faces[down] = faces[down, ::-1]
    return trimesh.Trimesh(vertices=xyz, faces=faces,
                           visual=TextureVisuals(uv=(local - uv_origin) / uv_span, material=material), process=False)


def beds_and_paving(near, far, outline, plane, tree):
    # Crown centres are visible in the atlas. Bed edges below the foliage are
    # estimated as planted patches around these groups, leaving a clear walkway.
    plots = union_all([Point(s, x).buffer(max(.84, diameter * .34), quad_segs=7)
                       for s, x, diameter in CROWNS]).intersection(outline.buffer(-.10))
    pavers = Image.open(ROOT.parents[1] / "web/src/assets/geography/pavers-color.webp").convert("RGB")
    pavers.thumbnail((512, 512), Image.Resampling.LANCZOS)
    # The garden paths read as pale stone in the surveyed texture. Preserve
    # the grain and joints of the scan while matching that local surface.
    pavers = ImageOps.colorize(ImageOps.grayscale(pavers), black=(114, 112, 102), white=(240, 236, 223))
    pavers.format = "JPEG"
    paving = PBRMaterial(name="SkyPark garden pavers", baseColorTexture=pavers, baseColorFactor=[180, 176, 160, 255],
                         roughnessFactor=.83, metallicFactor=0)
    edging = PBRMaterial(name="SkyPark stone edging", baseColorFactor=[106, 103, 95, 255],
                         metallicFactor=0, roughnessFactor=.82)
    soil_image = tree.geometry["Tree beds"].visual.material.baseColorTexture.convert("RGB")
    soil_image.format = "JPEG"
    soil = PBRMaterial(name="Garden soil", baseColorTexture=soil_image, roughnessFactor=1, metallicFactor=0)
    for polygon, lift, material in [
        (outline.difference(plots), .030, paving), (plots.difference(plots.buffer(-.095)), .037, edging),
        (plots.buffer(-.095), .034, soil),
    ]:
        mesh = deck_surface(polygon, lift, plane, material, 0, 2)
        near.add_geometry(mesh, geom_name=material.name)
    # Keep the pale paving and dark soil at long range. Their measured deck
    # outline needs only a few triangles once individual stone edges are subpixel.
    low, high = np.asarray(outline.bounds).reshape(2, 2)
    dimensions = np.ceil((high - low) * 4).astype(int)
    s, x = np.meshgrid(np.linspace(low[0], high[0], dimensions[0]), np.linspace(high[1], low[1], dimensions[1]))
    paving_color = np.asarray(pavers.resize((1, 1), Image.Resampling.BOX))[0, 0] / 255
    linear = ((paving_color + .055) / 1.055) ** 2.4 * (paving.baseColorFactor[:3] / 255)
    paving_color = np.uint8(255 * (1.055 * linear ** (1 / 2.4) - .055))
    soil_color = np.asarray(soil_image.resize((1, 1), Image.Resampling.BOX))[0, 0]
    rgb = np.where(contains_xy(plots, s, x)[:, :, None], soil_color, paving_color)
    image = Image.fromarray(rgb)
    image.format = "PNG"
    finish = PBRMaterial(name="Distant garden paths", baseColorTexture=image, roughnessFactor=.85, metallicFactor=0)
    mesh = deck_surface(outline.simplify(.075), .030, plane, finish, low, high - low)
    far.add_geometry(mesh, geom_name=finish.name)


def prototype(scene, name):
    # Reuse the southern courtyard specimen. The two scanned trees have disjoint
    # longitudinal bounds, so this split preserves all of one tree's UV islands.
    source = scene.geometry[name]
    selected = source.faces[source.triangles_center[:, 2] < 0]
    vertices, inverse = np.unique(selected, return_inverse=True)
    return trimesh.Trimesh(vertices=source.vertices[vertices], faces=inverse.reshape(-1, 3),
                            vertex_normals=source.vertex_normals[vertices],
                            visual=TextureVisuals(uv=source.visual.uv[vertices],
                                                  material=source.visual.material), process=False)


def compact_bark(mesh):
    source = {"faces": mesh.faces.ravel().tolist(), "position": mesh.vertices.ravel().tolist(),
              "attributes": np.column_stack((mesh.vertex_normals, mesh.visual.uv)).ravel().tolist()}
    result = subprocess.run(["node", str(Path(__file__).with_name("simplify-skypark-tree.mjs"))],
                            input=json.dumps(source), text=True, capture_output=True, check=True)
    faces = np.asarray(json.loads(result.stdout)).reshape(-1, 3)
    vertices, inverse = np.unique(faces, return_inverse=True)
    material = mesh.visual.material
    image = material.baseColorTexture.convert("RGB").resize((384, 384), Image.Resampling.LANCZOS)
    image.format = "JPEG"
    material.baseColorTexture = image
    return trimesh.Trimesh(vertices=mesh.vertices[vertices], faces=inverse.reshape(-1, 3),
                            vertex_normals=mesh.vertex_normals[vertices],
                            visual=TextureVisuals(uv=mesh.visual.uv[vertices], material=material), process=False)


def gardens(building):
    tree = trimesh.load_scene(ROOT / "assets" / (COURTYARD + ".glb"), process=False)
    bark = compact_bark(prototype(tree, "Island tree bark"))
    leaves = prototype(tree, "Island tree branch clusters")
    bounds = leaves.bounds
    foot = bark.vertices[bark.vertices[:, 1] < bark.vertices[:, 1].min() + .16].mean(axis=0)
    foot[1] = bark.vertices[:, 1].min()
    width = np.mean((bounds[1] - bounds[0])[[0, 2]])
    height = bounds[1, 1] - foot[1]
    cards = tree_cards(bark, leaves)
    parts = [(bark, []), (leaves, []), (cards, [])]
    rng = np.random.default_rng(1957)
    outline, plane = garden_decks(building)
    for s, x, diameter in CROWNS:
        if not outline.covers(Point(s, x)):
            raise ValueError("Tree falls outside the surveyed roof terrace")
        xz = ORIGIN + s * ALONG + x * ACROSS
        pos = np.array([xz[0], xz @ plane[:2] + plane[2] + .018, xz[1]])
        angle = rng.uniform(0, 2 * np.pi)
        rotation = trimesh.transformations.rotation_matrix(angle, [0, 1, 0])[:3, :3]
        scale = np.array([diameter / width, (1.05 + diameter * .83) / height, diameter / width])
        for src, instances in parts:
            v = ((src.vertices - foot) * scale) @ rotation.T + pos
            normal = (src.vertex_normals / scale) @ rotation.T
            normal /= np.linalg.norm(normal, axis=1)[:, None]
            instances.append((v, normal))
    near, far = trimesh.Scene(), trimesh.Scene()
    for src, instances in parts:
        count = len(src.vertices)
        mesh = trimesh.Trimesh(vertices=np.vstack([v for v, n in instances]),
                               faces=np.vstack([src.faces + i * count for i in range(len(instances))]),
                               vertex_normals=np.vstack([n for v, n in instances]),
                               visual=TextureVisuals(uv=np.tile(src.visual.uv, (len(instances), 1)),
                                                     material=src.visual.material), process=False)
        scene = far if src is cards else near
        scene.add_geometry(mesh, geom_name=src.visual.material.name)
    beds_and_paving(near, far, outline, plane, tree)
    low, high = near.bounds
    focus = ((low + high) / 2).tolist()
    return [record(near, building, focus, False), record(far, building, focus, True)]


def record(result, building, focus, distant):
    low, high = result.bounds
    center = (low + high) / 2
    center[1] = low[1]
    for mesh in result.geometry.values():
        mesh.apply_translation(-center)
    data = trimesh.exchange.gltf.export_glb(result, include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    return dict(entityId="bay.sands-skypark-distant-canopy" if distant else "bay.sands-skypark-gardens", layer="ext", kind="structure",
                regionId=building["regionId"], label="滨海湾金沙 · 空中花园树群远景" if distant else "滨海湾金沙 · 空中花园树群", assetHash=digest,
                bounds={"min": low.tolist(), "max": high.tolist()}, material={"shading": "albedo"},
                props={"background": True, "surfaceRole": "landscape",
                       "backgroundView": {"focus": focus, "minDistance" if distant else "maxDistance": 425},
                       "建筑与冠幅": "Map Data © Singapore Land Authority / OneMap。两片树群的位置及冠幅由模型屋顶原始影像估计，根部高程依实测露台平面。",
                       "树木来源": "Poly Haven Island Tree 01 · CC0 · https://polyhaven.com/a/island_tree_01",
                       "说明": "按屋顶图像中可单独辨识的 16 处树冠配设阔叶树。树种、株数、树干位置和树高为近似。硬质铺地沿实测露台平面，树池边界及石材为估值。"})


if __name__ == "__main__":
    buildings = json.loads((ROOT / "build/onemap-entities.json").read_text())
    records = gardens(next(e for e in buildings if e["entityId"] == HOTEL_ID))
    path = ROOT / "build/streetscape.json"
    entities = {e["entityId"]: e for e in json.loads(path.read_text())}
    for rec in records:
        entities[rec["entityId"]] = rec
    path.write_text(json.dumps(list(entities.values()), ensure_ascii=False, indent=2) + "\n")
    print([rec["assetHash"] for rec in records])
