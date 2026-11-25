"""Rebuild the Straits Boulevard surface and exposed ground on the southern approach."""
from importlib import import_module
import hashlib
import json

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
from scipy.spatial import cKDTree
from shapely import distance, get_parts, points, union_all
from shapely.geometry import GeometryCollection, LineString, Polygon, box
import trimesh
from trimesh.visual.material import PBRMaterial

from bridge_geometry import BridgeFrame
from ground_materials import scanned_pavers
from scanned_canopy import ROOT

roads = import_module("bake-marina-centre-roads")
surface = roads.fullerton.surface
REFERENCE = ROOT / "references/straits-boulevard"
CREDIT = ("Roads © OpenStreetMap contributors (ODbL). Terrain reference © Singapore Land Authority / OneMap. "
          "Asphalt 01, Granite Tile 04, Dirt Aerial 02 and Sandy Gravel 02 by Poly Haven (CC0).")


def soil_material(kind):
    def scan(role):
        with Image.open(REFERENCE / f"{kind}-{role}.jpg") as image:
            return np.asarray(image.convert("RGB"), float)

    pixels = scan("color")
    # Leave room for a linear vertex tint measured across the work site.
    variation = (pixels - np.median(pixels, axis=(0, 1))) * (1.08 if kind == "earth" else .88)
    if kind == "earth":
        # Keep the scan's small clods, then recover the larger colour field from the survey.
        variation -= .72 * gaussian_filter(variation, (15, 15, 0), mode="wrap")
    base = Image.fromarray(np.uint8(np.clip([207, 199, 182] + variation, 0, 255)))
    base.format = "JPEG"
    normal = Image.open(REFERENCE / f"{kind}-normal.jpg")
    rough = np.uint8(scan("rough")[:, :, 0])
    mr = Image.fromarray(np.dstack([np.full_like(rough, 255), rough, np.zeros_like(rough)]))
    mr.format = "JPEG"
    return PBRMaterial(name="Graded soil" if kind == "earth" else "Compacted gravel",
                       baseColorFactor=[171, 127, 98, 255] if kind == "earth" else [182, 152, 119, 255],
                       baseColorTexture=base, normalTexture=normal, metallicRoughnessTexture=mr,
                       metallicFactor=0, roughnessFactor=1)


def soil_mesh(area, material, ground, datum, tones, kind):
    cells = []
    for part in get_parts(area):
        if part.area < .01:
            continue
        x0, z0, x1, z1 = part.bounds
        for x in np.arange(np.floor(x0 / 4) * 4, x1, 4):
            for z in np.arange(np.floor(z0 / 4) * 4, z1, 4):
                piece = part.intersection(box(x, z, x + 4, z + 4))
                if piece.area > .001:
                    cells.extend(poly for poly in get_parts(piece) if poly.geom_type == "Polygon")
    mesh = surface(GeometryCollection(cells), material, ground, datum, height=.058,
                   tile_width=20 if kind == "earth" else 2.53)
    xz = mesh.vertices[:, [0, 2]]
    # Introduce a shallow undulation within the bare earth, tapering back to road and plot edges.
    edge = np.clip(distance(points(xz), area.boundary) / 7, 0, 1)
    x, z = xz.T
    height = (.25 + .13 * np.sin(x / 14 + z / 24) + .11 * np.cos(z / 11 - x / 20))
    mesh.vertices[:, 1] += edge * height * (1 if kind == "earth" else .30)
    dist, ix = cKDTree(tones[:, :2]).query(xz, k=4)
    weight = 1 / np.maximum(1, dist)**2
    rgb = np.sum(tones[ix, 2:] * weight[:, :, None], axis=1) / weight.sum(axis=1)[:, None]
    # The aerial gives broad variations in soil moisture. Keep the scan's own aggregate in the colour map.
    rgb = np.clip(rgb, [110, 101, 86], [195, 183, 166])
    tint = np.clip((rgb / [207, 199, 182])**2.2, .12, 1)
    mesh.visual.vertex_attributes["color"] = np.uint8(255 * np.c_[tint, np.ones(len(xz))])
    return mesh


def bake():
    ref = json.loads((REFERENCE / "survey.json").read_text())
    frame = BridgeFrame()
    placement = json.loads((ROOT / "build/placement.json").read_text())
    env = json.loads((ROOT / "build/environment.json").read_text())["props"]["environment"]["map"]
    ground = env["origin"][1] - placement["translation"][1]
    datum = frame.shift[[0, 2]]
    nodes = {}
    survey = {"roads": [], "overpasses": [], "crossings": {}}
    for row in ref["roads"]:
        ids = []
        for ll, xz in zip(row["coordinates"], frame.project(row)):
            key = tuple(ll)
            nodes[key] = xz
            ids.append(key)
        survey["roads"].append({"name": "Straits Boulevard", "lanes": row["lanes"], "nodes": ids})
    road, paint, carriageway, _ = roads.road_surfaces(survey, nodes)
    maps = roads.lane_textures()
    asphalt = PBRMaterial(name="Straits Boulevard asphalt", baseColorTexture=maps["color"],
                          normalTexture=maps["normal"], metallicRoughnessTexture=maps["roughness"],
                          metallicFactor=0, roughnessFactor=1)
    scene = trimesh.Scene()
    pavement = surface(road, asphalt, ground, datum, height=.085)
    pavement.visual.uv = roads.lane_coordinates(pavement, survey, nodes)
    scene.add_geometry(pavement, geom_name=asphalt.name)
    stripe = PBRMaterial(name="Straits Boulevard lane paint", baseColorFactor=[212, 209, 195, 255],
                         normalTexture=maps["normal"], metallicFactor=0, roughnessFactor=.89)
    scene.add_geometry(surface(paint, stripe, ground, datum, height=.085), geom_name=stripe.name)
    paths = union_all([LineString(frame.project(row)).buffer(1.48, cap_style="flat")
                       for row in ref["footways"]]).difference(carriageway)
    blocks = scanned_pavers("Straits Boulevard footway", [157, 155, 144], [.48, .30])
    walk = surface(paths, blocks, ground, datum, height=.20, walls=paths)
    walk.visual.uv *= [2.08 / (4 * .48), 2.08 / (6 * .30)]
    scene.add_geometry(walk, geom_name=blocks.name)
    excluded = union_all([carriageway.buffer(.2), paths.buffer(.12)])
    for kind in ["gravel", "earth"]:
        outlines, tones = [], []
        for row in ref["plots"]:
            if row["surface"] == kind:
                outlines.append(Polygon(frame.project({"coordinates": row["outline"]})))
                sample = np.asarray(row["tones"])
                positions = frame.project({"coordinates": sample[:, :2]})
                tones.extend(np.column_stack([positions, sample[:, 2:]]))
        area = union_all(outlines).difference(excluded)
        material = soil_material(kind)
        scene.add_geometry(soil_mesh(area, material, ground, datum, np.asarray(tones), kind),
                           geom_name=material.name)
        excluded = excluded.union(area)
        print(kind, round(area.area), "m²")
    bounds = scene.bounds.copy()
    anchor = bounds.mean(axis=0)
    anchor[1] = bounds[0, 1]
    for mesh in scene.geometry.values():
        mesh.apply_translation(-anchor)

    def credit(doc):
        doc["asset"]["copyright"] = CREDIT

    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True, tree_postprocessor=credit)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    row = dict(entityId="bay.straits-boulevard", label="海峡大道与沿线地面", kind="structure",
               layer="ext", regionId="marina-bay-exterior", assetHash=digest, material={"shading": "albedo"},
               bounds={"min": bounds[0].tolist(), "max": bounds[1].tolist()},
               props={"background": True, "surfaceRole": "landscape", "版权": CREDIT,
                      "依据": "OSM 车行道及步道中心线、车道数与 OneMap 航片裸土范围。地表起伏、铺装宽度和路缘高度为视觉估值。"})
    manifest = ROOT / "build/streetscape.json"
    entries = {e["entityId"]: e for e in json.loads(manifest.read_text())}
    entries[row["entityId"]] = row
    manifest.write_text(json.dumps(list(entries.values()), ensure_ascii=False, indent=2) + "\n")
    print(digest, len(data))


if __name__ == "__main__":
    bake()
