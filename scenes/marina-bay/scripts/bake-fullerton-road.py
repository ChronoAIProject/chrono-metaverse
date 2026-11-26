"""Build the Fullerton carriageways from an OSM extract and Poly Haven's Asphalt 01 scan."""

import argparse
import hashlib
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image, ImageEnhance
from shapely import constrained_delaunay_triangles, get_parts, orient_polygons, union_all
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import substring
from ground_materials import turf_colour
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parents[1] / "recon/src"))
from metaverse_recon.context.convert import frame
from context_geometry import geographic_point

CARRIAGEWAYS = ((22919331, 670664313), (635276800, 479332225, 634751407, 1124074831))
CROSSOVER = 1083770146
DRIVEWAY = 679952923
SIDEWALK = 515143393
LANE_WIDTH = 3.1
ENTITY_ID = "bay.fullerton-carriageways"


def read_roads(extract, config):
    osm = ET.parse(extract)
    origin, rotation = frame(config["oneMap"])
    shift = json.loads((ROOT / "build/alignment.json").read_text())["shift"]
    nodes = {node.get("id"): node for node in osm.findall("node")}

    def position(node):
        return geographic_point(float(node.get("lon")), float(node.get("lat")), origin, rotation, shift)[[0, 2]]

    roads = {}
    for way_id in [*CARRIAGEWAYS[0], *CARRIAGEWAYS[1], CROSSOVER, DRIVEWAY, SIDEWALK]:
        way = osm.find(f'way[@id="{way_id}"]')
        if way is None:
            raise ValueError(f"OSM extract is missing way {way_id}")
        line = LineString([position(nodes[nd.get("ref")]) for nd in way.findall("nd")])
        roads[way_id] = (line, {t.get("k"): t.get("v") for t in way.findall("tag")})
    return roads


def carriageway(roads, ids):
    # Follow OSM travel direction. Carry dash phase and the cross-section through way boundaries.
    points = []
    sections = []
    distance = 0.0
    for way_id in ids:
        line, tags = roads[way_id]
        if points and points[-1] != line.coords[0]:
            raise ValueError(f"Disconnected carriageway at {way_id}")
        points.extend(list(line.coords)[int(bool(points)):])
        sections.append((distance, distance + line.length, int(tags["lanes"]), tags.get("busway:left") == "lane"))
        distance += line.length
    line = LineString(points)
    # Extra stations at the ends of the turn pocket make its taper independent of OSM node density.
    stations = sorted({*np.arange(0, line.length, 2.0), line.length,
                       *[line.project(Point(p)) for p in points]})
    centers = np.array([line.interpolate(s).coords[0] for s in stations])
    directions = np.diff(centers, axis=0)
    directions /= np.linalg.norm(directions, axis=1)[:, None]
    normals = directions[:, [1, 0]] * [1, -1]
    summed = normals[:-1] + normals[1:]
    miters = summed / np.sum(summed * normals[:-1], axis=1)[:, None]
    normals = np.vstack((normals[0], miters, normals[-1]))

    pocket = np.zeros(len(stations))
    for start, end, lanes, _ in sections:
        if lanes > 4:
            pocket += (lanes - 4) * np.clip(np.minimum(np.array(stations) - start, end - np.array(stations)) / 12, 0, 1)
    half_width = (4 + pocket) * LANE_WIDTH / 2

    def side(offset):
        return centers + normals * np.broadcast_to(offset, half_width.shape)[:, None]

    area = Polygon(np.vstack((side(half_width), side(-half_width)[::-1])))
    white, yellow = [], []
    for lane in range(1, 5):
        boundary = side(half_width - lane * LANE_WIDTH)
        for start, end, lanes, bus in sections:
            if lane >= lanes:
                continue
            # Clip each dash by centerline station so neighboring lanes stay aligned on bends.
            for dash in np.arange(np.floor(start / 6) * 6, end, 6):
                low, high = max(dash, start), min(dash + 2, end)
                if high <= low:
                    continue
                if lane == 4 and np.interp((low + high) / 2, stations, pocket) < 0.7:
                    continue
                knots = [low, *[s for s in stations if low < s < high], high]
                stripe = LineString(np.column_stack([np.interp(knots, stations, axis) for axis in boundary.T]))
                # Bus-lane extents are tagged. Individual paint endpoints are reconstructed.
                (yellow if bus and lane == 1 else white).append(stripe.buffer(0.06, cap_style="flat"))
    return area, white, yellow


def planting_islands(config, roads, asphalt):
    # Outlines traced on OneMap OrthoJPG at z20. Coordinates are metres inland and along the quay.
    outlines = [
        [(45.9, -11), (50.7, -12), (54.2, -10), (52.0, 16), (49.5, 43),
         (48.2, 48), (44.5, 51), (44.6, 8)],
        [(43.3, 55), (47.5, 54), (48.3, 66), (44.2, 68)],
        [(43.2, 76), (47.6, 76), (48.7, 115), (47.1, 119), (44.3, 116)],
        [(45.6, 137), (50.0, 137), (52.9, 158), (49.4, 158)],
        [(68.8, -27), (72.2, -26), (69.8, 16), (67.7, 44), (65.9, 53),
         (63.3, 54), (62.8, 52), (64.8, 27)],
        [(62.4, 68), (65.7, 65), (66.4, 72), (66.7, 102), (67.9, 121),
         (63.7, 121), (62.4, 100), (61.6, 76)],
    ]
    start = np.array(config["quay"]["start"])[[0, 2]]
    along = np.array(config["quay"]["end"])[[0, 2]] - start
    along /= np.linalg.norm(along)
    inland = along[[1, 0]] * [1, -1]
    polygons = [Polygon([start + x * inland + z * along for x, z in outline]) for outline in outlines]
    # Round the small corner returns and keep sidewalk and vehicle entrances clear.
    islands = union_all(polygons).buffer(-0.35).buffer(0.35, quad_segs=3)
    return islands.difference(asphalt).difference(roads[SIDEWALK][0].buffer(1.60)).difference(
        roads[DRIVEWAY][0].buffer(2.0))


def surface(polygon, material, ground_y, height_origin, height=0.035, tile_width=2.08, walls=None):
    triangles = constrained_delaunay_triangles(polygon).geoms
    planar = np.array([list(t.exterior.coords)[:3] for t in triangles]).reshape(-1, 2)
    # Approximate the local tangent-plane drop across this 300 m road, matching the curved map.
    delta = planar - height_origin
    y = ground_y - np.sum(delta * delta, axis=1) / (2 * 6371000) + height
    vertices = np.column_stack((planar[:, 0], y, planar[:, 1]))
    faces = np.arange(len(vertices)).reshape(-1, 3)
    wrong = np.cross(vertices[faces[:, 1]] - vertices[faces[:, 0]],
                     vertices[faces[:, 2]] - vertices[faces[:, 0]])[:, 1] < 0
    faces[wrong] = faces[wrong, ::-1]
    # The published scan covers 2.08 m. Keep UV precision near zero over the whole section.
    uv = (planar - height_origin) * [1 / tile_width, -1 / tile_width]
    if walls is not None:
        wall_vertices, wall_faces = [], []
        for part in get_parts(orient_polygons(walls)):
            for ring in (part.exterior, *part.interiors):
                for a, b in zip(ring.coords, list(ring.coords)[1:]):
                    index = len(vertices) + len(wall_vertices)
                    for (x, z), h in [(a, height), (b, height), (b, 0.01), (a, 0.01)]:
                        drop = np.sum((np.array([x, z]) - height_origin) ** 2) / (2 * 6371000)
                        wall_vertices.append((x, ground_y - drop + h, z))
                    wall_faces.extend([(index, index + 1, index + 2), (index, index + 2, index + 3)])
        vertices = np.vstack((vertices, wall_vertices))
        faces = np.vstack((faces, wall_faces))
        uv = np.vstack((uv, np.zeros((len(wall_vertices), 2))))
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False,
                           visual=TextureVisuals(uv=uv, material=material))


def bake(extract, texture):
    config = json.loads((ROOT / "context.json").read_text())
    roads = read_roads(extract, config)
    areas, whites, yellows = [], [], []
    for ids in CARRIAGEWAYS:
        area, white, yellow = carriageway(roads, ids)
        areas.append(area)
        whites.extend(white)
        yellows.extend(yellow)
    crossover = roads[CROSSOVER][0].buffer(LANE_WIDTH / 2, cap_style="flat")
    # Only include the public ends of the service road that enters the building passage.
    driveway = roads[DRIVEWAY][0]
    mouths = [substring(driveway, 0, 10), substring(driveway, driveway.length - 10, driveway.length)]
    junctions = union_all([crossover, *[line.buffer(1.9, cap_style="flat") for line in mouths]])
    footprint = union_all([*areas, junctions])
    white = union_all(whites).difference(junctions)
    yellow = union_all(yellows).difference(junctions)
    # Partition the surface so distant paint and asphalt never compete for the same depth.
    asphalt = footprint.difference(union_all([white, yellow]))
    scan = Image.open(texture).convert("RGB").resize((512, 512), Image.Resampling.LANCZOS)
    scan = ImageEnhance.Color(scan).enhance(0.22)
    scan.format = "JPEG"
    grain = np.asarray(scan.convert("L"), dtype=float)
    paint_grain = np.clip(212 + (grain - np.mean(grain)) * 1.8, 125, 240).astype(np.uint8)
    paint = Image.fromarray(paint_grain).convert("RGB")
    paint.format = "JPEG"
    alignment = json.loads((ROOT / "build/alignment.json").read_text())
    env = json.loads((ROOT / "build/environment.json").read_text())["props"]["environment"]["map"]
    placement = json.loads((ROOT / "build/placement.json").read_text())
    ground_y = env["origin"][1] - placement["translation"][1]
    height_origin = np.array(alignment["shift"])[[0, 2]]
    scene = trimesh.Scene()
    for name, poly, image, tint in [
        ("Asphalt", asphalt, scan, [227, 232, 237, 255]),
        ("Lane paint", white, paint, [224, 225, 215, 255]),
        ("Bus lane paint", yellow, paint, [228, 169, 40, 255]),
    ]:
        mat = PBRMaterial(name=name, baseColorTexture=image, baseColorFactor=tint,
                          metallicFactor=0, roughnessFactor=0.94)
        mesh = surface(poly, mat, ground_y, height_origin)
        scene.add_geometry(mesh, geom_name=name, node_name=name)
    islands = planting_islands(config, roads, footprint)
    turf_area = islands.buffer(-0.15, join_style="mitre")
    turf = turf_colour("sparse_grass", [99, 111, 53], (512, 512))
    grass = PBRMaterial(name="Fullerton verge grass", baseColorTexture=turf, baseColorFactor=[170, 179, 149, 255],
                        metallicFactor=0, roughnessFactor=1)
    kerb = PBRMaterial(name="Weathered kerb", baseColorFactor=[115, 114, 103, 255],
                       metallicFactor=0, roughnessFactor=0.96)
    scene.add_geometry(surface(turf_area, grass, ground_y, height_origin, 0.145, 1.4), geom_name="Tree verges")
    scene.add_geometry(surface(islands.difference(turf_area), kerb, ground_y, height_origin, 0.16,
                               walls=islands), geom_name="Kerb stones")
    low, high = scene.bounds
    anchor = (low + high) / 2
    anchor[1] = low[1]
    for mesh in scene.geometry.values():
        mesh.vertices -= anchor
    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / f"{digest}.glb").write_bytes(data)
    records_file = ROOT / "build/streetscape.json"
    records = json.loads(records_file.read_text())
    record = dict(entityId=ENTITY_ID, regionId=records[0]["regionId"], layer="ext", kind="structure",
                  assetHash=digest, label="浮尔顿路 · 沥青车道与标线", bounds=dict(min=low.tolist(), max=high.tolist()),
                  material={"shading": "albedo"}, props={
                      "background": True, "surfaceRole": "landscape",
                      "绿带轮廓": "Map Data © Singapore Land Authority / OneMap 正射影像；Sparse Grass · Poly Haven · CC0",
                      "道路来源": "https://www.openstreetmap.org/way/22919331", "道路编号": list(roads),
                      "材质来源": "https://polyhaven.com/a/asphalt_01",
                      "版权": "© OpenStreetMap contributors · ODbL；Asphalt 01 · Poly Haven · CC0",
                      "说明": "中心线、路口和车道数来自 OSM。路宽、渐变段、标线位置及磨耗为估值。",
                  })
    records = [r for r in records if r["entityId"] != ENTITY_ID] + [record]
    records_file.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    print(f"{digest}  {len(data):,} bytes, {sum(len(m.faces) for m in scene.geometry.values()):,} triangles")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("extract", type=Path, help="Fullerton area OSM XML extract")
    parser.add_argument("texture", type=Path, help="Poly Haven asphalt_01_diff_1k.jpg")
    args = parser.parse_args()
    bake(args.extract, args.texture)
