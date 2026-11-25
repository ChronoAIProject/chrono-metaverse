"""Build the Helix Bridge and its four mapped over-water lookouts for daylight views."""
import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image
from shapely import constrained_delaunay_triangles
from shapely.geometry import LineString, Point
import trimesh

from helix_glazing import apply_glazing
from bridge_geometry import BridgeFrame, HelixDeck, SurfaceBatch
from scanned_canopy import ROOT, write_tree_asset


def walkway(deck, asphalt, edge, steel, crossing):
    for triangle in constrained_delaunay_triangles(deck.surface).geoms:
        planar = np.array(triangle.exterior.coords)[:3]
        top = np.array([deck.surface_point(p) for p in planar])
        face = [0, 1, 2] if np.cross(top[1]-top[0], top[2]-top[0])[1] > 0 else [2, 1, 0]
        asphalt.add(top, [face], (planar - deck.curve(0)) * [1, -1] / 2.08)
        edge.add(top - [0, .4, 0], [face[::-1]])
    outline = list(deck.surface.exterior.coords)
    for a, b in zip(outline, outline[1:]):
        top_a, top_b = deck.surface_point(a), deck.surface_point(b)
        edge.add([top_a, top_a-[0, .4, 0], top_b-[0, .4, 0], top_b], [[0, 1, 2], [0, 2, 3]])
    boundary = LineString(outline)
    stations = np.linspace(0, boundary.length, math.ceil(boundary.length/2.1)+1)
    posts = [deck.surface_point(boundary.interpolate(t).coords[0], .03) for t in stations]
    for a, b in zip(posts, posts[1:]):
        along = deck.line.project(Point(((a + b)/2)[[0, 2]]))
        midpoint = Point(((a + b)/2)[[0, 2]])
        if along < .12 or along > deck.length - .12 or crossing.distance(midpoint) < 1.8:
            continue
        for height, radius in [(1.13, .042), (.68, .016), (.30, .016)]:
            steel.tube([a+[0, height, 0], b+[0, height, 0]], radius, 6)
        edge.tube([a, a+[0, 1.13, 0]], .033, 6)


def shell(deck, steel, glass):
    phases = np.arange(3) * 2 * np.pi / 3
    for hand, radius in [(1, 5.30), (-1, 4.62)]:
        stations = np.linspace(1, 273, 365)
        for phase in phases:
            # COX lists a 273 mm outside diameter for the stainless tubes.
            steel.tube(deck.spiral(stations, phase, radius, hand), .1365)
    for t in np.linspace(1, 273, 147):
        for phase in phases:
            angle = (t-1)*4*np.pi/54 + phase
            partner = round(angle/(2*np.pi/3)) * 2*np.pi/3
            steel.tube([deck.spiral(t, phase, 5.30, 1), deck.spiral(t, partner, 4.62, -1)], .064, 6)
    for start in np.arange(11, 259, 13.5):
        stations = np.linspace(start, start+9.4, 6)
        angles = np.linspace(.69, 2.44, 7)
        grid = []
        for t in stations:
            theta = angles + (t-start)*.075
            grid.append(deck.point(t, 4.35*np.cos(theta), 2.25+4.28*np.sin(theta)))
        grid = np.asarray(grid)
        faces = []
        for j in range(len(stations)-1):
            for k in range(len(angles)-1):
                n = j*len(angles) + k
                faces.extend([[n, n+1, n+8], [n, n+8, n+7]])
        uv = [[(t-start)/.48, angle*4.35/.48] for t in stations for angle in angles]
        glass.add(grid.reshape(-1, 3), faces, uv)
        for rail in [grid[:, 0], grid[:, -1]]:
            steel.tube(rail, .034, 6)
        for rail in [grid[0], grid[-1]]:
            steel.tube(rail, .037, 6)


def bake(texture):
    survey = json.loads((ROOT / "references/helix-bridge.json").read_text())
    deck = HelixDeck(survey)
    scan = Image.open(texture).convert("RGB").resize((256, 256), Image.Resampling.LANCZOS)
    scan = scan.convert("L").convert("RGB")
    scan.format = "JPEG"
    yy, xx = np.indices((128, 128))
    dots = (xx%16-8)**2 + (yy%16-8)**2 < 16
    frit = Image.fromarray(np.where(dots[:, :, None], [218,223,221,170], [142,175,188,52]).astype(np.uint8))
    frit.format = "PNG"
    asphalt = SurfaceBatch("Asphalt wearing course", [236,236,236,255], 0, .92, baseColorTexture=scan)
    steel = SurfaceBatch("Duplex stainless steel", [185,191,194,255], .54, .34)
    edge = SurfaceBatch("Deck edge and crossbeams", [115,124,130,255], .40, .48)
    concrete = SurfaceBatch("Pier concrete", [156,153,142,255], 0, .9)
    glass = SurfaceBatch("Fritted canopy", [255,255,255,255], .08, .28, alphaMode="BLEND",
                         doubleSided=True, baseColorTexture=frit)
    bayfront = json.loads((ROOT / "references/bayfront-bridge.json").read_text())
    crossing = LineString(BridgeFrame().project(bayfront["link"])[1:])
    walkway(deck, asphalt, edge, steel, crossing)
    shell(deck, steel, glass)
    for station in [41, 105, 169, 234]:
        base = deck.point(station)
        base[1] = deck.ground - .34
        concrete.tube([base, base+[0, 1.40, 0]], 2.35, 14)
        for side in (-2.9, 2.9):
            for delta in (-3., 3.):
                edge.tube([base+[0, 1.36, 0], deck.point(station+delta, side, -.36)], .22)
    for side in (-2.7, 2.7):
        edge.tube(deck.point(deck.stations, side, -.46), .24, 6)
    scene = trimesh.Scene()
    for batch in [asphalt, steel, edge, concrete, glass]:
        scene.add_geometry(batch.mesh(), geom_name=batch.material.name)
    credit = ("Plan geometry © OpenStreetMap contributors (ODbL). Architectural proportions interpreted "
              "from COX Architecture, The Helix Bridge. Asphalt 01 by Poly Haven (CC0).")
    digest, bounds = write_tree_asset(scene, copyright=credit)
    digest = apply_glazing(ROOT / "assets" / (digest + ".glb"), ROOT / "references/helix-canopy")
    return {"entityId": "bay.helix-bridge", "layer": "ext", "kind": "structure",
            "label": "双螺旋桥与四处观景台", "regionId": "marina-bay-exterior", "assetHash": digest,
            "bounds": bounds, "material": {"shading": "albedo"}, "props": {"background": True,
            "平面来源": survey["source"], "建筑参考": survey["design"], "材质版权": credit,
            "遮棚玻璃": "参考 COX 日间照片估算夹胶玻璃的透光、丝印及板缝，按五处桥上视点为三个桥段估计局部反射。",
            "重建范围": "桥线与四处观景台据 OSM 和 OneMap 配准。桥面纵坡、净宽、螺旋节距、顶棚分段及支座比例参照建筑师立面与照片估读。"}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("texture", type=Path, help="Poly Haven Asphalt 01 diffuse scan")
    row = bake(parser.parse_args().texture)
    path = ROOT / "build/streetscape.json"
    rows = {entity["entityId"]: entity for entity in json.loads(path.read_text())}
    rows[row["entityId"]] = row
    path.write_text(json.dumps(list(rows.values()), ensure_ascii=False, indent=2) + "\n")
    print(row["assetHash"])
