"""Restore exposed soil and aggregate beside the Marina Centre flyovers."""
from importlib import import_module
import json

import numpy as np
from shapely import union_all
from shapely.geometry import Polygon
import trimesh

from bridge_geometry import BridgeFrame
from scanned_canopy import ROOT, write_tree_asset

terrain = import_module("bake-straits-boulevard")
CREDIT = "Terrain interpretation © Singapore Land Authority / OneMap. Dirt Aerial 02 and Gravel Floor 02 by Poly Haven (CC0)."


def bake():
    ref = json.loads((ROOT / "references/marina-centre-yard.json").read_text())
    frame = BridgeFrame()
    regions = {"earth": [], "gravel": []}
    for patch in ref["patches"]:
        boundary, *holes = [frame.project({"coordinates": ring}) for ring in patch["rings"]]
        regions[patch["material"]].append(Polygon(boundary, holes))
    gravel = union_all(regions["gravel"])
    earth = union_all(regions["earth"]).difference(gravel)
    environment = json.loads((ROOT / "build/environment.json").read_text())["props"]["environment"]
    placement = json.loads((ROOT / "build/placement.json").read_text())
    ground = environment["map"]["origin"][1] - placement["translation"][1]
    tones = np.array(ref["tones"])
    positions = frame.project({"coordinates": tones[:, :2]})
    samples = np.column_stack((positions, tones[:, 2:]))
    scene = trimesh.Scene()
    for kind, area in [("earth", earth), ("gravel", gravel)]:
        material = terrain.soil_material(kind, aggregate="gravel_floor_02" if kind == "gravel" else None)
        # Match the surrounding ground in the bay daylight rig at the flyover viewpoint.
        material.baseColorFactor = [128, 128, 124, 255]
        mesh = terrain.soil_mesh(area, material, ground, frame.shift[[0, 2]], samples, kind,
                                 low_rgb=(57, 59, 53), high_rgb=(175, 171, 156), min_tint=0, gravel_width=2.0)
        coords = mesh.vertices[:, [0, 2]]
        # Shift the registered scans over several metres without repeating the same gravel streak.
        uv = mesh.visual.uv.copy()
        uv[:, 0] += .37 * np.sin(coords[:, 1] / 8.1) + .18 * np.cos(coords[:, 1] / 4.4)
        uv[:, 1] += .28 * np.sin(coords[:, 0] / 7.4 + uv[:, 0] * .12)
        mesh.visual.uv = uv
        scene.add_geometry(mesh, geom_name=material.name)
    digest, bounds = write_tree_asset(scene, copyright=CREDIT)
    row = dict(entityId="bay.marina-centre-worksite", label="滨海中心 · 淡马锡道高架旁场地", kind="structure",
               layer="ext", regionId="marina-bay-exterior", assetHash=digest, bounds=bounds,
               material={"shading": "albedo"}, props={"background": True, "surfaceRole": "landscape",
               "版权": CREDIT, "依据": "OneMap 航片内的裸土与压实通道。材质分界、色泽及地形起伏为估值。"})
    manifest = ROOT / "build/streetscape.json"
    rows = {item["entityId"]: item for item in json.loads(manifest.read_text())}
    rows[row["entityId"]] = row
    manifest.write_text(json.dumps(list(rows.values()), ensure_ascii=False, indent=2) + "\n")
    print(digest, round(earth.area), round(gravel.area))


if __name__ == "__main__":
    bake()
