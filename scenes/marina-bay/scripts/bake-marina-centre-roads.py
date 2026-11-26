"""Build ground-level asphalt and markings around the Raffles Boulevard / Temasek Avenue junction."""

from collections import defaultdict
import hashlib
from importlib import import_module
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates
from shapely import get_parts, line_merge, union_all
from shapely.geometry import LineString, MultiPoint, Point, Polygon
from shapely.ops import substring
import trimesh
from trimesh.visual.material import PBRMaterial

from marina_centre_flyovers import add_flyovers
from marina_centre_verges import add_verges

fullerton = import_module("bake-fullerton-road")
ROOT = Path(__file__).resolve().parents[1]
REFERENCES = ROOT / "references/marina-centre-roads"
LANE = 3.15
ID = "bay.marina-centre-carriageways"


def cross_section(line, distance):
    p = np.asarray(line.interpolate(distance).coords[0])
    a = np.asarray(line.interpolate(max(0, distance - .5)).coords[0])
    b = np.asarray(line.interpolate(min(line.length, distance + .5)).coords[0])
    forward = (b - a) / np.linalg.norm(b - a)
    return p, forward, np.array([-forward[1], forward[0]])


def road_surfaces(survey, nodes):
    carriageways, stripes, interruptions = [], [], []
    ends = defaultdict(list)
    lanes = defaultdict(list)
    crossings = set()
    for road in survey["roads"]:
        ids = road["nodes"]
        line = LineString([nodes[i] for i in ids])
        count = road["lanes"]
        width = LANE * count / 2
        carriageways.append(line.buffer(width, cap_style="flat", join_style="round"))
        for node, distance in [(ids[0], 0), (ids[-1], line.length)]:
            p, _, normal = cross_section(line, distance)
            ends[node].extend([p + width * normal, p - width * normal])
        lanes[(road["name"], count)].append(line)
        for node in ids:
            kind = survey["crossings"].get(str(node))
            if not kind or node in crossings:
                continue
            crossings.add(node)
            p, forward, normal = cross_section(line, line.project(Point(nodes[node])))
            interrupts = 11 if kind == "traffic_signals" else 3.2
            interruptions.append(Point(p).buffer(interrupts))
            if kind == "traffic_signals":
                continue
            if kind == "dots":
                for offset in [-1.35, 1.35]:
                    for across in np.arange(-width + .28, width - .1, .82):
                        center = p + offset * forward + across * normal
                        stripes.append(LineString([center - .13 * normal, center + .13 * normal])
                                       .buffer(.11, cap_style="flat"))
            else:
                for across in np.arange(-width + .48, width - .35, .97):
                    center = p + across * normal
                    stripes.append(LineString([center - 1.45 * forward, center + 1.45 * forward])
                                   .buffer(.21, cap_style="flat"))

    for points in ends.values():
        if len(points) >= 4:
            carriageways.append(MultiPoint(points).convex_hull)
    area = union_all(carriageways)
    # Keep ground-level asphalt continuous through the grade-separated crossings.
    bridges = [LineString([nodes[i] for i in road["nodes"]]).buffer(road["lanes"] * LANE / 2 + 1.35)
               for road in survey["overpasses"]]
    clear = union_all(interruptions)
    for (_, count), lines in lanes.items():
        for line in get_parts(line_merge(union_all(lines))):
            for lane in range(1, count):
                boundary = line.offset_curve((count / 2 - lane) * LANE)
                for start in np.arange(1., boundary.length - .3, 6.0):
                    dash = substring(boundary, start, min(start + 2., boundary.length))
                    stripes.append(dash.buffer(.065, cap_style="flat").difference(clear))
    paint = union_all(stripes).intersection(area)
    return area.difference(paint), paint, area, bridges


def lane_textures(site="Marina Centre"):
    # One tile spans a traffic lane and four lengths of the aggregate scan.
    # The wheel paths are slightly smoother and darker than the lane centre.
    height, width = 1024, 512
    row, col = np.indices((height, width))
    u = (col + .5) / width
    v = (row + .5) / height
    rng = np.random.default_rng(int.from_bytes(hashlib.sha256(site.encode()).digest()[:8], "little"))
    # Use periodic fields so the source offsets and wheel wear meet at all four edges.
    positions = np.stack((v * 7, u * 5))
    field = map_coordinates(rng.uniform(-1, 1, (7, 5)), positions, mode="grid-wrap")
    phase = rng.uniform(0, 2 * np.pi, 2)
    wander = .042 * np.sin(v * 2 * np.pi + phase[0]) + .018 * np.sin(v * 4 * np.pi + phase[1])
    distance = np.abs(np.abs((u - .5) * LANE + wander) - .74)
    wear = np.exp(-.5 * (distance / .23) ** 2) * (1 + .38 * field)
    # Mix translated copies of the scan. Colour, tangent normals and roughness
    # share the same weights and coordinates, with no rotation of the tangent axes.
    offsets = rng.integers(0, 256, (3, 2))
    selector = np.clip((field + .48) / .96, 0, 1) * 2
    blend = np.clip(3 * (selector[..., None] - np.array([.5, 1.5])) + .5, 0, 1)
    weights = [1 - blend[..., 0], blend[..., 0] - blend[..., 1], blend[..., 1]]
    images = {}
    for role in ["color", "normal", "roughness"]:
        with Image.open(REFERENCES / f"asphalt-{role}.jpg") as source:
            tile = np.asarray(source.convert("RGB").resize((width // 2, height // 4), Image.Resampling.LANCZOS))
        pixels = sum(weight[..., None] * tile[(row + dy) % len(tile), (col + dx) % tile.shape[1]]
                     for weight, (dy, dx) in zip(weights, offsets))
        if role == "color":
            median = np.median(tile, axis=(0, 1))
            pixels = [101, 104, 104] + .94 * (pixels - median) + (4.2 * field - 8 * wear)[:, :, None]
        elif role == "normal":
            normal = pixels / 127.5 - 1
            pixels = 127.5 * (1 + normal / np.maximum(np.linalg.norm(normal, axis=2, keepdims=True), 1e-5))
        elif role == "roughness":
            pixels[:, :, 1] -= 19 * wear
        image = Image.fromarray(np.uint8(pixels.clip(0, 255)))
        image.format = "JPEG"
        images[role] = image
    return images


def lane_coordinates(mesh, survey, nodes):
    # Each triangle follows the nearest segment of the carriageway. Use one
    # reference for all three vertices so UVs stay continuous across dash gaps.
    starts, vectors, offsets, widths = [], [], [], []
    for road in survey["roads"]:
        path = np.array([nodes[i] for i in road["nodes"]])
        edges = np.diff(path, axis=0)
        lengths = np.linalg.norm(edges, axis=1)
        starts.extend(path[:-1])
        vectors.extend(edges)
        offsets.extend(np.r_[0, np.cumsum(lengths[:-1])])
        widths.extend([road["lanes"] / 2] * len(edges))
    starts, vectors = np.array(starts), np.array(vectors)
    lengths = np.linalg.norm(vectors, axis=1)
    unit = vectors / lengths[:, None]
    points = mesh.vertices[mesh.faces][:, :, [0, 2]]
    delta = points.mean(axis=1)[:, None, :] - starts
    station = np.clip(np.sum(delta * unit, axis=2), 0, lengths)
    nearest = np.argmin(np.sum((delta - station[:, :, None] * unit) ** 2, axis=2), axis=1)
    delta = points - starts[nearest, None, :]
    along = unit[nearest, None, :]
    lateral = delta[:, :, 1] * along[:, :, 0] - delta[:, :, 0] * along[:, :, 1]
    dist = np.sum(delta * along, axis=2) + np.asarray(offsets)[nearest, None]
    uv = np.empty((len(mesh.vertices), 2))
    uv[mesh.faces] = np.stack([lateral / LANE + np.asarray(widths)[nearest, None], -dist / 8.32], axis=2)
    return uv


def bake():
    config = json.loads((ROOT / "context.json").read_text())
    placement = json.loads((ROOT / "build/placement.json").read_text())
    shift = np.asarray(json.loads((ROOT / "build/alignment.json").read_text())["shift"])
    origin, rotation = fullerton.frame(config["oneMap"])
    survey = json.loads((REFERENCES / "survey.json").read_text())
    verge_survey = json.loads((REFERENCES / "verges.json").read_text())

    def project(point):
        return fullerton.geographic_point(*point, origin, rotation, shift)[[0, 2]]

    nodes = {int(k): project(lonlat) for k, lonlat in survey["nodes"].items()}
    asphalt, markings, carriageway, bridges = road_surfaces(survey, nodes)
    # The hotel drop-off and turning lanes widen beyond the nominal OSM lane count.
    # Keep the existing planted islands and footways inside its surveyed outline.
    margins = verge_survey["surfaces"]
    turning = union_all([Polygon([project(p) for p in s["ring"]]) for s in margins if s["surface"] == "asphalt"])
    protected = [Polygon([project(p) for p in s["ring"]]) for s in margins if s["surface"] != "asphalt"]
    protected.extend(Polygon([project(p) for p in ring]) for ring in verge_survey["coveredFootprints"])
    turning = turning.difference(union_all(protected)).difference(carriageway)
    # Use the same road-paint material for the tapered dividers in the widened lanes.
    lines = [LineString([project(p) for p in line]).buffer(divider["widthMetres"] / 2, cap_style="flat")
             for divider in verge_survey.get("paintedDividers", []) for line in divider["lines"]]
    divider_paint = union_all(lines).intersection(turning)
    markings = markings.union(divider_paint)
    asphalt = asphalt.union(turning.difference(divider_paint))
    carriageway = carriageway.union(turning)
    color = Image.open(REFERENCES / "asphalt-color.jpg")
    normal = Image.open(REFERENCES / "asphalt-normal.jpg")
    rough = Image.open(REFERENCES / "asphalt-roughness.jpg")
    lane = lane_textures()
    road = PBRMaterial(name="Marina Centre asphalt", baseColorTexture=lane["color"], normalTexture=lane["normal"],
                       metallicRoughnessTexture=lane["roughness"], metallicFactor=0, roughnessFactor=1)
    grain = np.asarray(color.convert("L"), dtype=float)
    paint = Image.fromarray(np.uint8(np.clip(195 + .87 * (grain - np.median(grain)), 140, 230))).convert("RGB")
    paint.format = "JPEG"
    stripe = PBRMaterial(name="Marina Centre road paint", baseColorTexture=paint, normalTexture=normal,
                         metallicRoughnessTexture=rough, metallicFactor=0, roughnessFactor=.87)
    env = json.loads((ROOT / "build/environment.json").read_text())["props"]["environment"]["map"]
    ground = env["origin"][1] - placement["translation"][1]
    scene = trimesh.Scene()
    for poly, material in [(asphalt, road), (markings, stripe)]:
        mesh = fullerton.surface(poly, material, ground, shift[[0, 2]], height=.047)
        if material is road:
            mesh.visual.uv = lane_coordinates(mesh, survey, nodes)
        scene.add_geometry(mesh, geom_name=material.name)
    areas = add_verges(scene, verge_survey, project, carriageway, bridges, ground, shift[[0, 2]], fullerton.surface)
    flyovers = json.loads((REFERENCES / "flyovers.json").read_text())
    add_flyovers(scene, flyovers, project, ground, shift[[0, 2]], road, stripe, fullerton.surface)
    print(f"Planted {areas[0]} m², paved {areas[1]} m²")
    low, high = scene.bounds
    anchor = (low + high) / 2
    anchor[1] = low[1]
    for mesh in scene.geometry.values():
        mesh.apply_translation(-anchor)
    credit = ("Roads © OpenStreetMap contributors (ODbL). Map Data © Singapore Land Authority / OneMap. "
              "Asphalt 01, Concrete Floor 02, Granite Tile 04 and Leafy Grass by Poly Haven (CC0).")

    def credit_asset(doc):
        doc["asset"]["copyright"] = credit

    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True, tree_postprocessor=credit_asset)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    entity = {
        "entityId": ID, "kind": "structure", "layer": "ext", "regionId": "marina-bay-exterior",
        "label": "滨海中心 · 莱佛士林荫道与淡马锡道", "assetHash": digest, "material": {"shading": "albedo"},
        "bounds": {"min": low.tolist(), "max": high.tolist()},
        "props": {"background": True, "surfaceRole": "landscape", "版权": credit,
                  "高架道路": "OSM 中心线与车道数，桥面高程、断面尺寸及墩位为视觉估值。",
                  "路旁地面": "按正射影像描绘绿地和铺装。石板尺寸、路缘高度、草色为估值。",
                  "道路材质": "扫描沥青与路面涂料。车道数和道路线形取自 OSM，路宽、标线及磨耗为视觉近似。"}
    }
    file = ROOT / "build/streetscape.json"
    records = {e["entityId"]: e for e in json.loads(file.read_text())}
    records[ID] = entity
    file.write_text(json.dumps(list(records.values()), ensure_ascii=False, indent=2) + "\n")
    print(digest, len(data))


if __name__ == "__main__":
    bake()
