"""Rebuild the concrete shared path and planted ground along Marina Promenade."""
import json
from importlib import import_module

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree
from shapely import get_parts, intersection, box
from shapely.geometry import GeometryCollection, Polygon
import trimesh
from trimesh.visual.material import PBRMaterial

from bridge_geometry import BridgeFrame
from ground_materials import scanned_turf, turf_wear
from scanned_canopy import ROOT, write_tree_asset

surface = import_module("bake-fullerton-road").surface


def patch_cells(polygons, frame, pitch):
    cells = []
    for rings in polygons:
        shell, *holes = [frame.project({"coordinates": ring}) for ring in rings]
        area = Polygon(shell, holes)
        if not area.is_valid:
            area = area.buffer(0)
        x0, z0, x1, z1 = area.bounds
        x, z = np.meshgrid(np.arange(np.floor(x0 / pitch) * pitch, x1, pitch),
                           np.arange(np.floor(z0 / pitch) * pitch, z1, pitch))
        cuts = intersection(box(x.ravel(), z.ravel(), x.ravel() + pitch, z.ravel() + pitch), area)
        cells.extend(p for p in get_parts(cuts) if p.geom_type == "Polygon" and p.area > .001)
    return GeometryCollection(cells)


def concrete():
    folder = ROOT / "references/skyline-finishes/ConcreteRoof"
    rgb = np.asarray(Image.open(folder / "Color.jpg").convert("RGB"), dtype=float)
    grain = rgb - np.mean(rgb, axis=(0, 1))
    colour = Image.fromarray(np.uint8(np.clip([139, 137, 131] + .62 * grain, 0, 255)))
    colour.format = "JPEG"
    rough = Image.open(folder / "Roughness.jpg").convert("L")
    packed = Image.merge("RGB", (Image.new("L", rough.size, 255), rough, Image.new("L", rough.size)))
    packed.format = "JPEG"
    return PBRMaterial(name="Marina Promenade concrete", baseColorTexture=colour,
                       normalTexture=Image.open(folder / "NormalGL.jpg"),
                       metallicRoughnessTexture=packed, roughnessFactor=.96,
                       metallicFactor=0)


def bake():
    survey = json.loads((ROOT / "references/marina-promenade-ground.json").read_text())
    frame = BridgeFrame()
    terrain = json.loads((ROOT / "build/environment.json").read_text())["props"]["environment"]["map"]
    placement = json.loads((ROOT / "build/placement.json").read_text())
    datum = terrain["origin"][1] - placement["translation"][1]
    origin = frame.shift[[0, 2]]
    turf = scanned_turf("Marina Promenade ground cover", [133, 139, 105])
    lawn = surface(patch_cells(survey["turf"], frame, 6.5), turf, datum, origin, height=.068, tile_width=1.4)
    tones = np.array(survey["tones"])
    samples = frame.project({"coordinates": tones[:, :2]})
    positions = lawn.vertices[:, [0, 2]]
    distances, ids = cKDTree(samples).query(positions, k=4)
    weights = 1 / np.maximum(distances, 1.5)**2
    measured = np.sum(tones[ids, 2:] * weights[:, :, None], axis=1) / weights.sum(axis=1)[:, None]
    # Aerial crowns and their shadows can cover the underlying turf. Retain the
    # broad ground colour within the shade/sun range observed on this park corridor.
    pigment = np.clip(measured * [.89, 1.00, .86], [76, 87, 47], [127, 134, 94])
    tint = np.clip((pigment / [133, 139, 105])**2.2 * turf_wear(positions), .06, 1)
    lawn.visual.vertex_attributes["color"] = np.uint8(np.rint(255 * np.c_[tint, np.ones(len(tint))]))
    paving = surface(patch_cells(survey["concrete"], frame, 12), concrete(), datum, origin,
                     height=.116, tile_width=2.9)
    scene = trimesh.Scene()
    for mesh in (lawn, paving):
        scene.add_geometry(mesh, geom_name=mesh.visual.material.name)
    credit = ("OpenStreetMap contributors (ODbL). Land-cover survey derived from OneMap orthophotography, "
              "Singapore Land Authority. Grass 004 by ambientCG and concrete scan by Poly Haven (CC0).")
    digest, bounds = write_tree_asset(scene, copyright=credit)
    row = dict(entityId="bay.marina-promenade-park-ground", label="滨海步道 · 河岸草地与混凝土慢行道",
               kind="structure", layer="ext", regionId="marina-bay-exterior", bounds=bounds, assetHash=digest,
               material={"shading": "albedo"}, props={"background": True, "surfaceRole": "landscape",
               "版权": credit, "依据": "OSM 公园边界与步道中心线、OneMap z18 影像的植被和陆岸边界。草地色泽与路面宽度为视觉估值。"})
    manifest = ROOT / "build/streetscape.json"
    rows = {r["entityId"]: r for r in json.loads(manifest.read_text())}
    rows[row["entityId"]] = row
    manifest.write_text(json.dumps(list(rows.values()), ensure_ascii=False, indent=2) + "\n")
    print(digest)


if __name__ == "__main__":
    bake()
