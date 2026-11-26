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
    gravel = import_module("bake-straits-boulevard").soil_material("gravel", aggregate="gravel_ground_01")
    # Grass, bare soil and aggregate share the same measured colour field across
    # the work yard. The geometry boundary only chooses the close-range grain.
    samples = np.asarray(survey["turf"]["tones"] + survey["gravel"]["tones"])
    locations = frame.project({"coordinates": samples[:, :2]})
    tree = cKDTree(locations)
    gravel.name = "Marina Promenade compacted gravel"
    gravel.baseColorFactor = [182, 182, 179, 255]
    for kind, material, pitch in [("turf", turf, 1.4), ("gravel", gravel, 3.0)]:
        patch = survey[kind]
        mesh = surface(patch_cells(patch["rings"], frame, 1.5), material, datum, origin,
                       height=.069, tile_width=pitch)
        xz = mesh.vertices[:, [0, 2]]
        inland = distance(points(xz), shore)
        # A low bank at the waterline grades back into the existing park surface.
        crest = np.clip(inland / 2.3, 0, 1) * np.clip(1 - inland / 9, 0, 1)
        mesh.vertices[:, 1] += .60 * crest
        offsets, ids = tree.query(xz, k=12)
        # The survey has a 2.4 m pitch. A local kernel preserves connected bare
        # patches and tapers to the surrounding samples where the yard was occluded.
        radius = np.maximum(1.5, offsets[:, 0] + 1.0)
        weights = np.exp(-.5 * (offsets / radius[:, None])**2)
        rgb = np.sum(samples[ids, 2:] * weights[:, :, None], axis=1) / weights.sum(axis=1)[:, None]
        grass_share = np.sum(weights * (ids < len(survey["turf"]["tones"])), axis=1) / weights.sum(axis=1)
        dry_aggregate = np.array([.91, .88, .84])
        vegetation = np.array([.88, .94, .78])
        pigment = rgb * (dry_aggregate + grass_share[:, None] * (vegetation - dry_aggregate))
        # Warm dry grass and compacted soil change together, even when their
        # boundary crosses triangles carrying different scans.
        wear = turf_wear(xz)
        pigment *= wear**.28
        damp_width = 1.35 * wear[:, 1]**-1.4
        damp = 1.0 - .36 * np.exp(-inland / damp_width)
        if kind == "turf":
            scan = np.array([133, 139, 105])
            factor = 1.0
        else:
            scan = np.array([207, 199, 182])
            factor = gravel.baseColorFactor[:3] / 255
            mesh.visual.uv += np.column_stack((.31 * np.sin(xz[:, 1] / 6.1), .28 * np.cos(xz[:, 0] / 8.7)))
        # The colour texture is sRGB. glTF vertex colour and baseColorFactor
        # multiply its decoded linear radiance.
        tint = ((pigment + 14.025) / (scan + 14.025))**2.4 / factor
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
    turf = scanned_turf("Marina Promenade ground cover", [133, 139, 105], cover="leafy_grass")
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
              "Singapore Land Authority. Leafy Grass, concrete and Gravel Ground 01 scans by Poly Haven (CC0).")
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
