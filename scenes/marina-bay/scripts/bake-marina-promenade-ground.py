"""Rebuild the concrete shared path and planted ground along Marina Promenade."""
import json
from importlib import import_module

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree
from shapely import box, distance, get_parts, intersection, points
from shapely.geometry import GeometryCollection, LineString, Polygon
import trimesh
from trimesh.visual.material import PBRMaterial

from bridge_geometry import BridgeFrame
from ground_materials import scanned_turf, turf_wear
from scanned_canopy import ROOT, write_tree_asset

surface = import_module("bake-fullerton-road").surface


def patch_cells(polygons, frame, pitch, exclude=None):
    cells = []
    for rings in polygons:
        shell, *holes = [frame.project({"coordinates": ring}) for ring in rings]
        area = Polygon(shell, holes)
        if not area.is_valid:
            area = area.buffer(0)
        if exclude is not None:
            area = area.difference(exclude)
        if area.is_empty:
            continue
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


def bank_surfaces(survey, frame, datum, origin, turf):
    shore = LineString(frame.project({"coordinates": survey["shore"]}))
    gravel = import_module("bake-straits-boulevard").soil_material("gravel")
    yard_edge = LineString(frame.project({"coordinates": survey["yardEdge"]}))
    gravel.name = "Marina Promenade compacted gravel"
    gravel.baseColorFactor = [182, 182, 179, 255]
    for kind, material, pitch in [("turf", turf, 1.4), ("gravel", gravel, 2.53)]:
        patch = survey[kind]
        mesh = surface(patch_cells(patch["rings"], frame, 1.5), material, datum, origin,
                       height=.069, tile_width=pitch)
        xz = mesh.vertices[:, [0, 2]]
        inland = distance(points(xz), shore)
        # A low bank at the waterline grades back into the existing park surface.
        crest = np.clip(inland / 2.3, 0, 1) * np.clip(1 - inland / 9, 0, 1)
        mesh.vertices[:, 1] += .60 * crest
        samples = np.asarray(patch["tones"])
        locations = frame.project({"coordinates": samples[:, :2]})
        offsets, ids = cKDTree(locations).query(xz, k=4)
        weights = 1 / (1 + offsets**2)
        rgb = np.sum(samples[ids, 2:] * weights[:, :, None], axis=1) / weights.sum(axis=1)[:, None]
        # The photographed shore is darker at its toe. Apply this on the land side
        # of the surveyed water edge and let the material grain continue through it.
        damp = 1 - .26 * np.exp(-inland / 1.25)
        # Both sides of the gravel track carry a strip of soil and sparse grass.
        # Blend in metres so the land-cover outline does not read as a cutout.
        wear = turf_wear(xz)
        edge = np.clip(distance(points(xz), yard_edge) / 4.6, 0, 1)
        amount = (edge * edge * (3 - 2 * edge))[:, None]
        soil = np.array([106, 107, 85]) * wear**.36
        if kind == "turf":
            pigment = np.clip(rgb * [.93, .99, .88], [72, 78, 46], [130, 135, 101]) * wear**.40
            midtone = [133, 139, 105]
        else:
            pigment = np.clip(rgb * [.89, .87, .81], [80, 78, 71], [149, 145, 132])
            midtone = np.array([207, 199, 182]) * gravel.baseColorFactor[:3] / 255
            # Shift aggregate features over several metres. All PBR maps share these UVs.
            mesh.visual.uv += np.column_stack((.31 * np.sin(xz[:, 1] / 6.1), .28 * np.cos(xz[:, 0] / 8.7)))
        pigment = soil + amount * (pigment - soil)
        tint = (pigment / midtone)**2.2
        tint = np.clip(tint * damp[:, None], .03, 1)
        mesh.visual.vertex_attributes["color"] = np.uint8(np.rint(255 * np.c_[tint, np.ones(len(tint))]))
        yield mesh


def bake():
    survey = json.loads((ROOT / "references/marina-promenade-ground.json").read_text())
    frame = BridgeFrame()
    terrain = json.loads((ROOT / "build/environment.json").read_text())["props"]["environment"]["map"]
    placement = json.loads((ROOT / "build/placement.json").read_text())
    datum = terrain["origin"][1] - placement["translation"][1]
    origin = frame.shift[[0, 2]]
    turf = scanned_turf("Marina Promenade ground cover", [133, 139, 105])
    bank = json.loads((ROOT / "references/marina-promenade-bank.json").read_text())
    margin = Polygon(frame.project({"coordinates": bank["margin"][0]}))
    lawn = surface(patch_cells(survey["turf"], frame, 6.5, exclude=margin), turf, datum, origin, height=.068, tile_width=1.4)
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
    for mesh in bank_surfaces(bank, frame, datum, origin, turf):
        scene.add_geometry(mesh, geom_name=mesh.visual.material.name + " along the bank")
    credit = ("OpenStreetMap contributors (ODbL). Land-cover survey derived from OneMap orthophotography, "
              "Singapore Land Authority. Grass 004 by ambientCG and concrete and Sandy Gravel 02 scans by Poly Haven (CC0).")
    digest, bounds = write_tree_asset(scene, copyright=credit)
    row = dict(entityId="bay.marina-promenade-park-ground", label="滨海步道 · 河岸草地与混凝土慢行道",
               kind="structure", layer="ext", regionId="marina-bay-exterior", bounds=bounds, assetHash=digest,
               material={"shading": "albedo"}, props={"background": True, "surfaceRole": "landscape",
               "版权": credit, "依据": "OSM 公园边界与步道中心线、OneMap z18 影像的植被和陆岸边界。临水作业地、碎石与草坡取自 OneMap z19 航片，岸坡高度、地表磨损与路面宽度为视觉估值。"})
    manifest = ROOT / "build/streetscape.json"
    rows = {r["entityId"]: r for r in json.loads(manifest.read_text())}
    rows[row["entityId"]] = row
    manifest.write_text(json.dumps(list(rows.values()), ensure_ascii=False, indent=2) + "\n")
    print(digest)


if __name__ == "__main__":
    bake()
