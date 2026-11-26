"""Reconstruct the surveyed SkyPark poolside platforms and their sun loungers."""

from timber_decks import apply_deck_scans

import hashlib
import json
import math
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image, ImageDraw, ImageFilter, ImageOps
from shapely import constrained_delaunay_triangles, set_precision, union_all
from shapely.geometry import LineString, MultiPoint, Polygon
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from skypark_geometry import ACROSS, ALONG, HOTEL_ID, ORIGIN

ROOT = Path(__file__).resolve().parents[1]
PHOTO = "https://commons.wikimedia.org/wiki/File:Infinity_pool_at_Sands_Sky_Park,_Marina_Bay_Sands_Hotel,_Singapore_-_20100820.jpg"
# Approximate furniture groups from the hotel image atlas, metres along the
# roof. The horizontal survey faces determine the available depth at each seat.
PLATFORMS = [
    (-96, 133.94, [-96.8, -94.6, -92.3, -91.3, -90, -87.1, -81.7, -80.2, -78.1, -76.5, -74.1, -71.4]),
    (-25, 134.103, [-55.6, -54, -52.6, -50.1, -49, -47.2, -41.8, -40.5, -28.6,
                    -27.1, -24.9, -23.4, -21.8, -20.1, -18, -16.4, -15, -12.3]),
    (8, 133.93, [-2.6, -1.6, 3.3, 4.6, 6.3, 7.8, 9.5, 11.1, 13.2, 14.7, 18.95,
                 20.1, 24.6, 26.1, 27.9, 29.3, 30.9, 35.1]),
]
LIFT = .018


def platforms(building):
    scene = trimesh.load_scene(ROOT / "assets" / (building["assetHash"] + ".glb"), process=False)
    shell, = [m for m in scene.geometry.values() if isinstance(m.visual, TextureVisuals)]
    lo, hi = [np.array(building["bounds"][k]) for k in ("min", "max")]
    anchor = (lo + hi) / 2
    anchor[1] = lo[1]
    tri = shell.triangles + anchor
    sx = (tri[:, :, [0, 2]] - ORIGIN) @ np.stack((ALONG, ACROSS)).T
    for inside, height, centers in PLATFORMS + [(-64, 134.14, [])]:
        level = np.abs(tri[:, :, 1] - height).max(axis=1) < .031
        rings = [Polygon(t) for t in sx[level]]
        outline = union_all([set_precision(t, .005) for t in rings if t.area > .005])
        polygon, = [p for p in getattr(outline, "geoms", [outline])
                    if p.area > 20 and p.bounds[0] < inside < p.bounds[2] and p.bounds[1] < 9]
        mask = np.array([r.area > .005 and polygon.covers(r.representative_point()) for r in rings])
        st = sx[level][mask].reshape(-1, 2)
        y = tri[level][mask, :, 1].ravel()
        basis = np.column_stack((st, np.ones(len(st))))
        plane = np.linalg.lstsq(basis, y, rcond=None)[0]
        if np.max(np.abs(basis @ plane - y)) > .012:
            raise ValueError("Poolside survey heights no longer fit the selected platform")
        yield polygon, plane, centers


def cushion(length, width, thickness):
    # Three corner samples per quadrant and four inset rings round off both
    # the silhouette and the reflection on the edge of the fabric.
    verts, faces = [], []
    for z, inset in [(0, .024), (.017, .002), (thickness - .022, 0), (thickness, .033)]:
        for corner, (a, b) in enumerate([(1, 1), (-1, 1), (-1, -1), (1, -1)]):
            for angle in np.linspace(corner * math.pi / 2, (corner + 1) * math.pi / 2, 3):
                radius = .065 - inset
                verts.append([(length / 2 - .065) * a + radius * math.cos(angle), z,
                              (width / 2 - .065) * b + radius * math.sin(angle)])
    count = 12
    for ring in range(3):
        for i in range(count):
            a, b = ring * count + i, ring * count + (i + 1) % count
            faces.extend([[a, b, a + count], [b, b + count, a + count]])
    for i in range(1, count - 1):
        faces.extend([[0, i + 1, i], [36, 36 + i, 37 + i]])
    mesh = trimesh.Trimesh(verts, faces, process=False)
    mesh.fix_normals()
    return mesh


def lounger(angle):
    # The local X axis points towards the water. Two linked cushions rest on
    # a low timber frame with splayed aluminium feet.
    seat = cushion(1.18, .78, .085)
    seat.apply_translation([.35, .32, 0])
    back = cushion(.74, .78, .09)
    back.apply_translation([-.37, 0, 0])
    back.apply_transform(trimesh.transformations.rotation_matrix(-angle, [0, 0, 1]))
    back.apply_translation([-.255, .32, 0])
    frame = []
    for side in (-.33, .33):
        rail = trimesh.creation.box(extents=[1.88, .082, .052])
        rail.apply_translation([0, .277, side])
        frame.append(rail)
        # Adjustable struts brace the lifted section against the lower rail.
        joint = [-.255 - .49 * math.cos(angle), .32 + .49 * math.sin(angle), side]
        frame.append(trimesh.creation.cylinder(radius=.018, sections=6,
                                               segment=[[-.83, .304, side], joint]))
        for sign in (-1, 1):
            leg = trimesh.creation.box(extents=[.046, .245, .042])
            leg.apply_transform(trimesh.transformations.rotation_matrix(sign * .23, [0, 0, 1]))
            leg.apply_translation([sign * .735, .12, side])
            frame.append(leg)
    for x in (-.88, .75):
        crossbar = trimesh.creation.box(extents=[.052, .055, .70])
        crossbar.apply_translation([x, .278, 0])
        frame.append(crossbar)
    support = trimesh.util.concatenate(frame)
    # Split the face normals on the extruded frame sections.
    support = trimesh.Trimesh(vertices=support.triangles.reshape(-1, 3),
                              faces=np.arange(support.faces.size).reshape(-1, 3),
                              vertex_normals=np.repeat(support.face_normals, 3, axis=0), process=False)
    support.merge_vertices(merge_norm=False)
    return trimesh.util.concatenate([seat, back]), support


def board_material(records):
    terrace = next(r for r in records if r["entityId"] == "bay.fullerton-dining-terraces")
    scene = trimesh.load_scene(ROOT / "assets" / (terrace["assetHash"] + ".glb"), process=False)
    source = next(m.visual.material for m in scene.geometry.values() if m.visual.material.name == "Outdoor timber")
    photo = ImageOps.grayscale(source.baseColorTexture).resize((512, 512), Image.Resampling.LANCZOS)
    wood = np.asarray(ImageOps.colorize(photo, (48, 39, 34), (151, 132, 110))).copy()
    rng = np.random.default_rng(57)
    for row in range(8):
        strip = np.roll(wood[row * 64:(row + 1) * 64].copy(), int(rng.integers(512)), axis=1)
        strip = np.uint8(np.clip(strip * rng.uniform(.87, 1.08), 0, 255))
        strip[:2] = [.42 * c for c in strip[2, 0]]
        strip[:, (row * 131) % 512] //= 2
        wood[row * 64:(row + 1) * 64] = strip
    timber = Image.fromarray(wood)
    timber.format = "JPEG"
    return PBRMaterial(name="Poolside timber boards", baseColorTexture=timber,
                       roughnessFactor=.75, metallicFactor=0)


def plank_mesh(polygon, plane, material):
    sx = np.concatenate([np.asarray(t.exterior.coords)[:3]
                         for t in constrained_delaunay_triangles(polygon).geoms])
    xyz = np.column_stack((sx[:, 1], sx @ plane[:2] + plane[2] + LIFT, sx[:, 0]))
    faces = np.arange(len(xyz)).reshape(-1, 3)
    tri = xyz[faces]
    down = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])[:, 1] < 0
    faces[down] = faces[down, ::-1]
    return trimesh.Trimesh(xyz, faces, visual=TextureVisuals(uv=sx / [2.7, 1.1], material=material),
                           process=False)


def poolside(building, records):
    wood = board_material(records)
    platforms_mesh, pad_mesh, frames = [], [], []
    footprints = []
    rng = np.random.default_rng(842)
    for polygon, plane, centers in platforms(building):
        platforms_mesh.append(plank_mesh(polygon, plane, wood))
        for s in centers:
            line = polygon.intersection(LineString([(s, -15), (s, 25)]))
            outer = line.bounds[3]
            x = outer - 1.24
            # Use the gently curving landward edge to orient the chairs. Its
            # measured tangent is stable across the notches in the water edge.
            sample = polygon.intersection(LineString([(s + .2, -15), (s + .2, 25)]))
            slope = (sample.bounds[1] - line.bounds[1]) / .2
            yaw = math.atan(np.clip(slope, -.25, .25)) + rng.uniform(-.025, .025)
            rot = trimesh.transformations.rotation_matrix(yaw, [0, 1, 0])
            rot[:3, 3] = [x, np.dot([s, x, 1], plane) + LIFT, s]
            pad, frame = lounger(rng.uniform(.13, .46))
            for mesh in (pad, frame):
                mesh.apply_transform(rot)
            footprint = MultiPoint(pad.vertices[:, [2, 0]]).convex_hull
            if not polygon.covers(footprint) or footprint.bounds[1] - line.bounds[1] < 1.45:
                raise ValueError(f"Sun lounger at {s:g} crosses the deck or narrows the aisle")
            pad_mesh.append(pad)
            frames.append(frame)
            footprints.append(footprint)

    deck = trimesh.util.concatenate(platforms_mesh)
    # Retain the grain UV across the merged survey faces and a unique secondary
    # UV for diffuse contact shading beneath each low cushion.
    deck.visual = TextureVisuals(uv=np.concatenate([m.visual.uv for m in platforms_mesh]), material=wood)
    sx = deck.vertices[:, [2, 0]]
    low, high = sx.min(axis=0), sx.max(axis=0)
    pixels_per_metre = min(16.0, 2047 / float(max(high - low)))
    size = np.ceil((high - low) * pixels_per_metre).astype(int) + 1
    shade = Image.new("L", tuple(size), 255)
    draw = ImageDraw.Draw(shade)
    for outline in footprints:
        draw.polygon([tuple(p) for p in (np.asarray(outline.exterior.coords) - low) * pixels_per_metre], fill=145)
    ao = shade.filter(ImageFilter.GaussianBlur(.19 * pixels_per_metre))
    ao.format = "PNG"
    wood.occlusionTexture = ao
    deck.vertex_attributes["_CONTACT_UV"] = (sx - low) * pixels_per_metre / (size - 1)
    result = trimesh.Scene()
    pad = trimesh.util.concatenate(pad_mesh)
    # A little canvas tooth at close range. The sun and the cushion's rolled
    # edges supply most of the tonal variation.
    y, x = np.indices((96, 96))
    weave = np.uint8(234 + 3 * np.cos(x * np.pi / 2) + 2 * np.cos(y * np.pi / 2))
    canvas = Image.fromarray(weave).convert("RGB")
    canvas.format = "PNG"
    pad.visual = TextureVisuals(uv=pad.vertices[:, [0, 2]] / .3,
                               material=PBRMaterial(name="Ivory lounger cushions", baseColorTexture=canvas,
                                                    baseColorFactor=[219, 208, 193, 255], roughnessFactor=.92,
                                                    metallicFactor=0))
    frame = trimesh.util.concatenate(frames)
    frame.visual = TextureVisuals(material=PBRMaterial(name="Lounger frames", baseColorFactor=[67, 54, 44, 255],
                                                       roughnessFactor=.65, metallicFactor=.15))
    world = np.array([[ACROSS[0], 0, ALONG[0], ORIGIN[0]], [0, 1, 0, 0],
                      [ACROSS[1], 0, ALONG[1], ORIGIN[1]], [0, 0, 0, 1]])
    for mesh in (deck, pad, frame):
        mesh.apply_transform(world)
        result.add_geometry(mesh, geom_name=mesh.visual.material.name)
    lo, hi = result.bounds
    anchor = (lo + hi) / 2
    anchor[1] = lo[1]
    for mesh in result.geometry.values():
        mesh.apply_translation(-anchor)

    def contact_channel(tree):
        for mat in tree["materials"]:
            if "occlusionTexture" in mat:
                mat["occlusionTexture"]["texCoord"] = 1
        for mesh in tree["meshes"]:
            for prim in mesh["primitives"]:
                attrs = prim["attributes"]
                if "_CONTACT_UV" in attrs:
                    attrs["TEXCOORD_1"] = attrs.pop("_CONTACT_UV")

    data = trimesh.exchange.gltf.export_glb(result, include_normals=True, tree_postprocessor=contact_channel)
    data = apply_deck_scans(data, "Poolside timber boards", "pool")
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    return dict(entityId="bay.sands-skypark-poolside", layer="ext", kind="structure", regionId=building["regionId"],
                label="滨海湾金沙 · 池畔木平台与日光躺椅", assetHash=digest,
                bounds={"min": lo.tolist(), "max": hi.tolist()}, material={"shading": "albedo"},
                props={"background": True, "surfaceRole": "landscape",
                       "backgroundView": {"focus": ((lo + hi) / 2).tolist(), "maxDistance": 320},
                       "平台来源": "Map Data © Singapore Land Authority / OneMap。铺面配准分段测绘网格。",
                       "现场参考": PHOTO, "木材来源": "Poly Haven · Wooden Planks、Weathered Planks 与 Teak Veneer · CC0",
                       "说明": f"依影像估配 {len(footprints)} 张躺椅。椅型、面料、木板宽度和具体间距为视觉近似。"})


if __name__ == "__main__":
    buildings = json.loads((ROOT / "build/onemap-entities.json").read_text())
    path = ROOT / "build/streetscape.json"
    records = json.loads(path.read_text())
    rec = poolside(next(e for e in buildings if e["entityId"] == HOTEL_ID), records)
    entities = {e["entityId"]: e for e in records}
    entities[rec["entityId"]] = rec
    path.write_text(json.dumps(list(entities.values()), ensure_ascii=False, indent=2) + "\n")
    print(rec["assetHash"], rec["props"]["说明"])
