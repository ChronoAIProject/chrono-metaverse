"""Build the southern service yard and its approach from the surveyed ground outlines."""
from importlib import import_module
import json

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
from scipy.spatial import cKDTree
from shapely import box, get_parts, intersection, make_valid, union_all
from shapely.geometry import GeometryCollection, LineString, Polygon
import trimesh
from trimesh.visual.material import PBRMaterial

from bridge_geometry import BridgeFrame
from scanned_canopy import ROOT, write_tree_asset

surface = import_module("bake-fullerton-road").surface
CREDIT = "Ground outlines and colour samples © Singapore Land Authority / OneMap. Concrete Floor 02 and Asphalt 01 by Poly Haven (CC0)."


def pavement_material(kind):
    if kind == "concrete":
        folder = ROOT / "references/skyline-finishes/ConcreteRoof"
        names = ["Color.jpg", "NormalGL.jpg", "Roughness.jpg"]
    else:
        folder = ROOT / "references/marina-centre-roads"
        names = ["asphalt-color.jpg", "asphalt-normal.jpg", "asphalt-roughness.jpg"]
    size = 1024 if kind == "concrete" else 512
    scans = []
    for name in names:
        with Image.open(folder / name) as source:
            scans.append(np.asarray(source.convert("RGB").resize((size, size), Image.Resampling.LANCZOS), float))
    colour, normal, rough = scans
    grain = colour - gaussian_filter(colour, (size/65, size/65, 0), mode="wrap")
    relief = normal
    finish = rough[:, :, 0]
    tone = 0.0
    if kind == "concrete":
        # A 20 x 24 m set of poured panels. Neighbouring pours share joints while the
        # aggregate, pigment and wet-weather response vary from panel to panel.
        y, x = np.indices((size, size))
        u, v = (x + .5) / size * 4, (y + .5) / size * 4
        row = v.astype(int)
        u += np.array([0, .22, .08, .35])[row]
        col = u.astype(int) % 4
        rng = np.random.default_rng(8191)
        start = rng.uniform(0, 1, (4, 4, 2))
        ix = ((u * 2.1 + start[row, col, 0])*size).astype(int) % size
        iy = ((v * 2.5 + start[row, col, 1])*size).astype(int) % size
        dx = np.minimum(u % 1, 1-u % 1)*5
        dy = np.minimum(v % 1, 1-v % 1)*6
        seal = np.clip(1-np.minimum(dx,dy)/.050, 0, 1)
        tone = rng.uniform(-15, 13, (4, 4))[row,col] - 47*seal
        grain = grain[iy, ix]
        relief = normal[iy, ix].copy()
        depth = -.006 * seal
        for axis, scale in [(1,20), (0,24)]:
            gradient = (np.roll(depth,-1,axis)-np.roll(depth,1,axis))*size/(2*scale)
            relief[:, :, 1-axis] -= 100*gradient
        finish = np.clip(rough[iy, ix, 0] + 8*seal, 145, 255)
    albedo = Image.fromarray(np.uint8(np.clip(190 + grain + np.asarray(tone)[..., None], 0, 255)))
    normal_image = Image.fromarray(np.uint8(np.clip(relief, 0, 255))).resize((512,512), Image.Resampling.LANCZOS)
    rough_image = Image.fromarray(np.uint8(finish)).resize((512,512), Image.Resampling.BOX)
    packed = Image.merge("RGB", (Image.new("L", rough_image.size, 255), rough_image, Image.new("L", rough_image.size)))
    albedo.format = normal_image.format = packed.format = "JPEG"
    # Calibrated against the pre-existing aerial ground at the same exposure.
    return PBRMaterial(name="South court " + kind, baseColorTexture=albedo, normalTexture=normal_image,
                       metallicRoughnessTexture=packed, roughnessFactor=1, metallicFactor=0,
                       baseColorFactor=[137, 135, 128, 255] if kind == "concrete" else [148, 144, 135, 255])


def paved_mesh(region, kind, frame, ground, tones, along):
    cells = []
    for polygon in get_parts(region):
        x0, z0, x1, z1 = polygon.bounds
        x, z = np.meshgrid(np.arange(np.floor(x0 / 4) * 4, x1, 4), np.arange(np.floor(z0 / 4) * 4, z1, 4))
        clipped = intersection(box(x.ravel(), z.ravel(), x.ravel() + 4, z.ravel() + 4), polygon)
        cells.extend(p for p in get_parts(clipped) if p.geom_type == "Polygon" and p.area > .001)
    mesh = surface(GeometryCollection(cells), pavement_material(kind), ground, frame.shift[[0, 2]], height=.065)
    coords = mesh.vertices[:, [0, 2]]
    if kind == "concrete":
        across = along[[1, 0]] * [1, -1]
        mesh.visual.uv = np.column_stack((coords @ across / 20, coords @ along / 24))
    else:
        mesh.visual.uv += np.column_stack((.39*np.sin(coords[:, 1]/10.2), .31*np.cos(coords[:, 0]/8.4)))
    samples = np.asarray(tones)
    positions = frame.project({"coordinates": samples[:, :2]})
    dist, idx = cKDTree(positions).query(coords, k=4)
    weights = 1 / (dist**2 + 2.0**2)
    rgb = (samples[idx, 2:] * weights[:, :, None]).sum(axis=1) / weights.sum(axis=1)[:, None]
    tint = np.clip(((rgb + 14.025) / 204.025)**2.4, .035, 1)
    mesh.visual.vertex_attributes["color"] = np.uint8(np.rint(255*np.c_[tint, np.ones(len(tint))]))
    return mesh


def painted_lines(reference, frame, concrete, asphalt):
    project = lambda row: frame.project({"coordinates": row})
    lines = [LineString(project(r)).buffer(.06, cap_style="flat") for r in reference["guides"]]
    for row in reference["rows"]:
        start, end = project(row)
        direction = (end - start) / np.linalg.norm(end - start)
        across = direction[[1, 0]] * [1, -1]
        lines.append(LineString([start, end]).buffer(.055, cap_style="flat"))
        for station in np.arange(3, np.linalg.norm(end-start)-1, 6.1):
            point = start + station * direction
            for tip in (point + 1.10*across, point - 1.10*across):
                lines.append(LineString([point, tip]).buffer(.065, cap_style="flat"))
    return union_all(lines).intersection(concrete.union(asphalt))


def bake():
    ref = json.loads((ROOT / "references/south-service-court.json").read_text())
    frame = BridgeFrame()
    regions = {"concrete": [], "asphalt": []}
    for patch in ref["patches"]:
        outer, *holes = [frame.project({"coordinates": ring}) for ring in patch["rings"]]
        regions[patch["surface"]].extend(p for p in get_parts(make_valid(Polygon(outer, holes)))
                                         if p.geom_type == "Polygon")
    asphalt = union_all(regions["asphalt"])
    concrete = union_all(regions["concrete"]).difference(asphalt)
    ground = json.loads((ROOT / "build/environment.json").read_text())["props"]["environment"]["map"]["origin"][1]
    placement = json.loads((ROOT / "build/placement.json").read_text())
    ground -= placement["translation"][1]
    first, last = frame.project({"coordinates": ref["rows"][0]})
    along = (last-first)/np.linalg.norm(last-first)
    scene = trimesh.Scene()
    for kind, region in [("concrete", concrete), ("asphalt", asphalt)]:
        scene.add_geometry(paved_mesh(region, kind, frame, ground, ref["tones"][kind], along), geom_name=kind)
    paint = painted_lines(ref, frame, concrete, asphalt)
    stripes = pavement_material("asphalt")
    stripes.name = "South court faded guides"
    stripes.baseColorFactor = [195, 182, 141, 255]
    mesh = surface(paint, stripes, ground, frame.shift[[0, 2]], height=.072)
    scene.add_geometry(mesh, geom_name=stripes.name)
    digest, bounds = write_tree_asset(scene, copyright=CREDIT)
    entity_id = "bay.south-service-court"
    row = dict(entityId=entity_id, label="滨海南岸 · 作业场地与进场路", kind="structure", layer="ext",
               regionId="marina-bay-exterior", assetHash=digest, bounds=bounds, material={"shading": "albedo"},
               props={"background": True, "surfaceRole": "landscape", "版权": CREDIT,
                      "依据": "OneMap 航片可辨认的场地边界、路面和标线走向。表面标高、涂装宽度和磨损为视觉估值。"})
    manifest = ROOT / "build/streetscape.json"
    rows = {e["entityId"]:e for e in json.loads(manifest.read_text())}
    rows[entity_id] = row
    manifest.write_text(json.dumps(list(rows.values()), ensure_ascii=False, indent=2) + "\n")
    print(digest, round(concrete.area), round(asphalt.area), round(paint.area))


if __name__ == "__main__":
    bake()
