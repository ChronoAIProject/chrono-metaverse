"""Bake the two carriageways alongside the Beach Road shophouses."""
from importlib import import_module
import json
from pathlib import Path

import numpy as np
from PIL import Image
from shapely import union_all
from shapely.geometry import LineString
import trimesh
from trimesh.visual.material import PBRMaterial

from scanned_canopy import write_tree_asset

streets = import_module("bake-marina-centre-roads")
road = streets.fullerton
ROOT = Path(__file__).resolve().parents[1]
CREDIT = ("Roads © OpenStreetMap contributors (ODbL). Map Data © Singapore Land Authority / OneMap. "
          "Asphalt 01 by Poly Haven (CC0).")


def bake():
    data = json.loads((ROOT / "references/beach-road-carriageways.json").read_text())
    config = json.loads((ROOT / "context.json").read_text())
    origin, rotation = road.frame(config["oneMap"])
    shift = np.array(json.loads((ROOT / "build/alignment.json").read_text())["shift"])
    settings = json.loads((ROOT / "build/environment.json").read_text())["props"]["environment"]["map"]
    placement = json.loads((ROOT / "build/placement.json").read_text())
    ground = settings["origin"][1] - placement["translation"][1]

    def project(ll):
        return road.geographic_point(*ll, origin, rotation, shift)[[0, 2]]

    nodes = {int(key): project(ll) for key, ll in data["nodes"].items()}
    survey = {"roads": data["roads"], "crossings": {}, "overpasses": []}
    _, markings, carriageways, _ = streets.road_surfaces(survey, nodes)
    junctions = [LineString([project(ll) for ll in entry["line"]]).buffer(5.2)
                 for entry in data["junctions"]]
    markings = markings.difference(union_all(junctions))

    lane = streets.lane_textures("Beach Road")
    # Match the darker, neutral carriageway tones in open sections of the local aerial.
    asphalt = PBRMaterial(name="Beach Road asphalt", baseColorTexture=lane["color"],
                          baseColorFactor=[138, 127, 116, 255], normalTexture=lane["normal"],
                          metallicRoughnessTexture=lane["roughness"], metallicFactor=0., roughnessFactor=1.)
    grain = np.asarray(lane["color"].convert("L"), float)
    weathered = np.clip(184 + .7 * (grain - np.median(grain)), 130, 222)
    paint = Image.fromarray(weathered.astype(np.uint8)).convert("RGB")
    paint.format = "JPEG"
    stripe = PBRMaterial(name="Beach Road worn lane markings", baseColorTexture=paint,
                         normalTexture=lane["normal"], metallicRoughnessTexture=lane["roughness"],
                         metallicFactor=0., roughnessFactor=.92)
    scene = trimesh.Scene()
    for polygon, material in [(carriageways.difference(markings), asphalt), (markings, stripe)]:
        mesh = road.surface(polygon, material, ground, shift[[0, 2]], height=.044)
        mesh.visual.uv = streets.lane_coordinates(mesh, survey, nodes)
        scene.add_geometry(mesh, geom_name=material.name)
    digest, bounds = write_tree_asset(scene, copyright=CREDIT)
    return {"entityId": "bay.beach-road-carriageways", "kind": "structure", "layer": "ext",
            "regionId": "marina-bay-exterior", "assetHash": digest, "bounds": bounds,
            "label": "美芝路 · 店屋沿街车道", "material": {"shading": "albedo"},
            "props": {"background": True, "surfaceRole": "landscape", "版权": CREDIT,
                      "道路材质": "中心线与车道数取自 OSM。沥青色调参考 OneMap 航片，路宽与标线间距为估值。"}}


if __name__ == "__main__":
    entity = bake()
    target = ROOT / "build/streetscape.json"
    records = {row["entityId"]: row for row in json.loads(target.read_text())}
    records[entity["entityId"]] = entity
    target.write_text(json.dumps(list(records.values()), ensure_ascii=False, indent=2) + "\n")
    print(entity["assetHash"])
