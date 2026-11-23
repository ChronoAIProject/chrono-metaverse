"""Restore the two low landings beside the Fullerton Pavilion from OneMap orthophotography."""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from shapely import constrained_delaunay_triangles, get_parts
from shapely.geometry import Polygon
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parents[1] / "recon/src"))
from metaverse_recon.context.convert import frame

# WGS84 longitude, latitude. Traced on the OneMap zoom-20 imagery.
EDGE = [(103.85393813, 1.28449348), (103.85397434, 1.28449214),
        (103.85395423, 1.28411136), (103.85390326, 1.28411404),
        (103.85390326, 1.28413282), (103.85390997, 1.28413818),
        (103.85391936, 1.28429639), (103.85391131, 1.28429907),
        (103.85391533, 1.28436075), (103.85392204, 1.28436343),
        (103.85392740, 1.28445058), (103.85393411, 1.28445326)]
GUIDES = [(103.85397837, 1.28446801), (103.85397166, 1.28437281),
          (103.85391131, 1.28428700), (103.85390997, 1.28420119),
          (103.85390460, 1.28412879)]

WEST_EDGE = [(103.85382816, 1.28470800), (103.85384962, 1.28470666),
             (103.85382012, 1.28416633), (103.85379866, 1.28416499)]


def projected(points):
    site = json.loads((ROOT / "context.json").read_text())["oneMap"]
    origin, rotation = frame(site)
    shift = json.loads((ROOT / "build/alignment.json").read_text())["shift"]
    lon, lat = np.radians(points).T
    eccentricity = 6.6943799901413165e-3
    radius = 6378137 / np.sqrt(1 - eccentricity * np.sin(lat) ** 2)
    xyz = np.column_stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon),
                           (1 - eccentricity) * np.sin(lat)]) * radius[:, None]
    return ((xyz - origin) @ rotation.T + shift)[:, [0, 2]]


def deck_material(path):
    wood = np.asarray(Image.open(path).convert("RGB").resize((512, 512)), dtype=float)
    # Transverse boards, weathered to the pale brown visible in the orthophoto.
    wood = wood / np.median(wood, axis=(0, 1)) * [153, 137, 111]
    rng = np.random.default_rng(321)
    for row in range(0, 512, 64):
        wood[row:row + 64] = np.roll(wood[row:row + 64], int(rng.integers(512)), axis=1)
        wood[row:row + 64] *= rng.uniform(.95, 1.04)
        wood[row:row + 2] *= .48
    image = Image.fromarray(np.uint8(np.clip(wood, 0, 255)))
    image.format = "JPEG"
    return PBRMaterial(name="Weathered landing boards", baseColorTexture=image,
                       metallicFactor=0, roughnessFactor=.84)


def landing(timber):
    origin_y = json.loads((ROOT / "build/environment.json").read_text())["props"]["environment"]["map"]["origin"][1]
    water = origin_y + .30
    top = water + .62
    corners, uv, colors, trim = [], [], [], []
    # Use the west/east median board colours in the same orthophoto exposure.
    # glTF vertex colours multiply the shared wood texture in linear space.
    def linear(rgb):
        return ((np.asarray(rgb) / 255 + .055) / 1.055) ** 2.4
    west_tint = np.rint(255 * linear([128, 120, 111]) / linear([163, 145, 128])).astype("u1")
    for boundary, tint in [(EDGE, [255, 255, 255]), (WEST_EDGE, west_tint)]:
        outline = projected(boundary)
        polygon = Polygon(outline)
        if not polygon.is_valid:
            raise ValueError("Invalid OneMap outline")
        across = outline[1] - outline[0]
        across /= np.linalg.norm(across)
        along = np.array([-across[1], across[0]])
        for triangle in get_parts(constrained_delaunay_triangles(polygon)):
            for x, z in list(triangle.exterior.coords)[:3]:
                p = np.array([x, z]) - outline[0]
                corners.append([x, top, z])
                uv.append([p @ across / 1.70, p @ along / 1.20])
                colors.append([*tint, 255])
        for a, b in zip(outline, np.roll(outline, -1, axis=0)):
            delta = b - a
            length = np.linalg.norm(delta)
            yaw = math.atan2(delta[0], delta[1])
            for height, width, center_y, color in [
                (.83, .12, top - .42, [114, 111, 100, 255]),
                (.15, .16, top - .19, [52, 55, 54, 255]),
            ]:
                rail = trimesh.creation.box([width, height, length])
                rail.apply_transform(trimesh.transformations.rotation_matrix(yaw, [0, 1, 0]))
                center = (a + b) / 2
                rail.apply_translation([center[0], center_y, center[1]])
                rail.visual.face_colors = color
                trim.append(rail)
    deck = trimesh.Trimesh(vertices=corners, faces=np.arange(len(corners)).reshape(-1, 3), process=False)
    deck.faces[deck.face_normals[:, 1] < 0] = deck.faces[deck.face_normals[:, 1] < 0][:, ::-1]
    deck.visual = TextureVisuals(uv=np.asarray(uv), material=deck_material(timber))
    deck.visual.vertex_attributes["color"] = np.asarray(colors, dtype="u1")
    for x, z in projected(GUIDES):
        for radius, height, center_y, color in [
            (.32, 1.28, water + .47, [150, 150, 143, 255]),
            (.35, .065, water + 1.13, [201, 197, 181, 255]),
        ]:
            guide = trimesh.creation.cylinder(radius=radius, height=height, sections=16)
            guide.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0]))
            guide.apply_translation([x, center_y, z])
            guide.visual.face_colors = color
            trim.append(guide)
    model = trimesh.Scene()
    model.add_geometry(deck, geom_name="Pontoon decking")
    model.add_geometry(trimesh.util.concatenate(trim), geom_name="Landing edges and guides")
    low, high = model.bounds
    center = (low + high) / 2
    for mesh in model.geometry.values():
        mesh.apply_translation([-center[0], -low[1], -center[2]])
    def set_edge_material(document):
        # Keep the vertex colours while explicitly identifying painted, nonmetallic surfaces.
        material_index = len(document["materials"])
        document["materials"].append({
            "name": "Pontoon edging and painted guides",
            "pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": .78},
        })
        for item in document["meshes"]:
            if item["name"] == "Landing edges and guides":
                for primitive in item["primitives"]:
                    primitive["material"] = material_index

    data = trimesh.exchange.gltf.export_glb(model, include_normals=True,
                                            tree_postprocessor=set_edge_material)
    return data, low, high


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("timber", type=Path, help="Poly Haven teak_veneer_diff_1k.jpg")
    args = parser.parse_args()
    data, low, high = landing(args.timber)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    path = ROOT / "build/streetscape.json"
    records = {e["entityId"]: e for e in json.loads(path.read_text())}
    entity_id = "bay.fullerton-pavilion-pontoon"
    records[entity_id] = dict(entityId=entity_id, layer="ext", kind="structure",
        regionId="marina-bay-exterior", label="浮尔顿水上圆亭 · 南侧与西侧平台", assetHash=digest,
        bounds={"min": low.tolist(), "max": high.tolist()}, material={"shading": "albedo"},
        props={"background": True, "岸线参考": "https://www.openstreetmap.org/way/1173004263",
               "影像来源": "Map Data © Singapore Land Authority / OneMap",
               "木材来源": "Poly Haven · Teak Veneer · CC0 · https://polyhaven.com/a/teak_veneer",
               "建模依据": "两座平台轮廓及南侧五处圆形构件按 OneMap 20 级正射影像描绘。西侧平台约长 60 米、宽 2.4 米，两座铺板的相对颜色取自同幅影像。平台离水 0.62 米、导桩高度、护舷截面和铺板材料为估值。"})
    path.write_text(json.dumps(list(records.values()), ensure_ascii=False, indent=2) + "\n")
    print(digest, len(data), high - low)
