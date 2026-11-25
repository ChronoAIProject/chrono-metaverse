"""Rebuild the Merlion lookout and three harbour landings from registered aerial outlines."""
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from shapely import constrained_delaunay_triangles
from shapely.geometry import Polygon

from bridge_geometry import BridgeFrame, SurfaceBatch
from context_geometry import geographic_point

ROOT = Path(__file__).resolve().parents[1]


def triangulate_cap(batch, polygon, elevation, uv_axes, upward):
    anchor = np.asarray(polygon.exterior.coords[0])
    for tri in constrained_delaunay_triangles(polygon).geoms:
        plan = np.asarray(tri.exterior.coords[:3])
        xyz = np.column_stack((plan[:, 0], elevation(plan), plan[:, 1]))
        face = [0, 1, 2]
        if (np.cross(xyz[1] - xyz[0], xyz[2] - xyz[0])[1] > 0) != upward:
            face.reverse()
        batch.add(xyz, [face], (plan - anchor) @ uv_axes)


def build_deck(plan, levels, thickness, surface, edge, underside, scale):
    polygon = Polygon(plan)
    if not polygon.is_valid or polygon.area <= 0:
        raise ValueError("Invalid landing footprint")
    # Flat floats and sloping gangways both have a planar top.
    plane = np.linalg.lstsq(np.column_stack((plan - plan[0], np.ones(len(plan)))), levels, rcond=None)[0]

    def top(xz):
        return (xz - plan[0]) @ plane[:2] + plane[2]

    lengths = np.linalg.norm(np.roll(plan, -1, axis=0) - plan, axis=1)
    i = lengths.argmax()
    axis = (plan[(i + 1) % len(plan)] - plan[i]) / lengths[i]
    uv_axes = np.column_stack((axis, [-axis[1], axis[0]])) / scale
    triangulate_cap(surface, polygon, top, uv_axes, True)
    triangulate_cap(underside, polygon, lambda xz: top(xz) - thickness, uv_axes, False)
    for i, (a, b) in enumerate(zip(plan, np.roll(plan, -1, axis=0))):
        ha, hb = top(a), top(b)
        verts = [[a[0], ha, a[1]], [b[0], hb, b[1]],
                 [b[0], hb - thickness, b[1]], [a[0], ha - thickness, a[1]]]
        faces = np.array([[0, 1, 2], [0, 2, 3]])
        if not polygon.exterior.is_ccw:
            faces = faces[:, ::-1]
        edge.add(verts, faces, [[0, 1], [lengths[i], 1], [lengths[i], 0], [0, 0]])


def guardrail(batch, a, b, height_a, height_b, posts):
    start = np.array([a[0], height_a, a[1]])
    end = np.array([b[0], height_b, b[1]])
    for h, radius in [(1.07, .032), (.76, .018), (.43, .018)]:
        batch.tube([start + [0, h, 0], end + [0, h, 0]], radius)
    for t in np.linspace(0, 1, max(1, int(np.ceil(np.linalg.norm(b - a) / 1.65))) + 1):
        foot = (1 - t) * start + t * end
        key = tuple(foot.round(4))
        if key not in posts:
            posts.add(key)
            batch.tube([foot, foot + [0, 1.07, 0]], .026)


def landing(frame, item, aggregate, datum_offset):
    coords = item["coordinates"]
    plan = frame.project(item)
    local_zero = geographic_point(*coords[0], frame.origin, frame.rotation, frame.shift)[1]
    local_zero += datum_offset
    top = local_zero + item["surfaceHeight"]
    lookout = bool(item.get("piles"))
    colour = np.asarray(aggregate, dtype=float)
    grain = colour / np.median(colour, axis=(0, 1))
    toned = np.uint8(np.clip(grain * item["surfaceColor"], 0, 255))
    image = Image.fromarray(toned)
    image.format = "JPEG"
    surface = SurfaceBatch("Landing wearing course", [255] * 4, 0, .83, baseColorTexture=image)
    edge = SurfaceBatch("Exposed deck edge", [156, 148, 136, 255] if lookout else [89, 83, 76, 255], 0, .96, finish="concrete", repeat=2.2)
    base = SurfaceBatch("Deck soffit and piles", [128, 122, 110, 255], 0, .98, finish="concrete", repeat=2.2)
    metal = SurfaceBatch("Waterfront handrails", [165, 169, 166, 255], .52, .58, finish="steel", repeat=.85)
    build_deck(plan, np.full(len(plan), top), item["thickness"], surface, edge, base, .85)
    posts = set()
    for i in item.get("railEdges", []):
        guardrail(metal, plan[i], plan[(i + 1) % len(plan)], top, top, posts)
    if lookout:
        for x, z in frame.project({"coordinates": item["piles"]}):
            base.tube([[x, local_zero, z], [x, top - item["thickness"] + .025, z]], .29, 14)
    if "ramp" in item:
        ramp = frame.project({"coordinates": item["ramp"]})
        shore = local_zero + item["rampLandHeight"]
        build_deck(ramp, [top, top, shore, shore], .13, surface, edge, base, .7)
        for i, j in [(0, 3), (1, 2)]:
            guardrail(metal, ramp[i], ramp[j], top, shore, posts)
    scene = trimesh.Scene()
    for batch in (surface, edge, base, metal):
        if batch.count:
            scene.add_geometry(batch.mesh(), geom_name=batch.material.name)
    low, high = scene.bounds
    origin = (high + low) / 2
    origin[1] = low[1]
    for mesh in scene.geometry.values():
        mesh.apply_translation(-origin)
    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    return dict(entityId="bay." + item["id"], layer="ext", kind="structure", regionId="marina-bay-exterior",
                label=item["label"], assetHash=digest, material={"shading": "albedo"},
                bounds={"min": low.tolist(), "max": high.tolist()},
                props={"background": True, "岸线": "https://www.openstreetmap.org/way/" + str(item["way"]),
                       "影像": "Map Data © Singapore Land Authority / OneMap",
                       "表面": "Granite Tile 04, Concrete Floor 02 and Metal Plate 02 · Poly Haven · CC0. Surface finish approximated from the aerial image.",
                       **({"现场照片": item["sourcePhoto"]} if "sourcePhoto" in item else {})})


if __name__ == "__main__":
    frame = BridgeFrame()
    ref = json.loads((ROOT / "references/bay-landings.json").read_text())
    granite = json.loads((ROOT / "context.json").read_text())["quay"]["granite"]["color"]
    aggregate = Image.open(ROOT / "assets" / (granite + ".webp")).convert("RGB")
    aggregate.thumbnail((256, 256), Image.Resampling.LANCZOS)
    map_config = json.loads((ROOT / "build/environment.json").read_text())["props"]["environment"]["map"]
    survey_zero = geographic_point(map_config["longitude"], map_config["latitude"],
                                   frame.origin, frame.rotation, frame.shift)[1]
    datum_offset = map_config["origin"][1] - survey_zero
    path = ROOT / "build/streetscape.json"
    records = {e["entityId"]: e for e in json.loads(path.read_text())}
    for item in ref["landings"]:
        record = landing(frame, item, aggregate, datum_offset)
        records[record["entityId"]] = record
        print(record["entityId"], record["assetHash"])
    path.write_text(json.dumps(list(records.values()), ensure_ascii=False, indent=2) + "\n")
