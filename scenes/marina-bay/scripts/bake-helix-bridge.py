"""Build the Helix Bridge and its four mapped over-water lookouts for daylight views."""
import argparse
import json
import math
from pathlib import Path
import sys

import numpy as np
from PIL import Image
from scipy.interpolate import CubicSpline
from shapely import constrained_delaunay_triangles, orient_polygons, union_all
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import linemerge
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from context_geometry import geographic_point
from scanned_canopy import ROOT, write_tree_asset

sys.path.insert(0, str(ROOT.parents[1] / "recon/src"))
from metaverse_recon.context.convert import frame


class Deck:
    def __init__(self, survey):
        config = json.loads((ROOT / "context.json").read_text())["oneMap"]
        origin, rotation = frame(config)
        shift = np.array(json.loads((ROOT / "build/alignment.json").read_text())["shift"])

        def project(row):
            return [geographic_point(*ll, origin, rotation, shift)[[0, 2]] for ll in row["coordinates"]]

        ways = [LineString(project(row)) for row in survey["alignment"]]
        points = np.asarray(linemerge(ways).coords)
        if not np.allclose(points[0], ways[-1].coords[-1]):
            points = points[::-1]
        distances = np.r_[0, np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))]
        self.curve = CubicSpline(distances, points, bc_type="natural")
        self.length = distances[-1]
        self.stations = np.linspace(0, self.length, 220)
        self.line = LineString(self.curve(self.stations))
        map_config = json.loads((ROOT / "build/environment.json").read_text())["props"]["environment"]["map"]
        self.ground = map_config["origin"][1] - np.linalg.norm(self.curve(140) - shift[[0, 2]])**2 / (2 * 6371000)
        platforms = [Polygon(project(row)) for row in survey["lookouts"]]
        stems = [LineString([self.line.interpolate(self.line.project(p.centroid)), p.centroid])
                 .buffer(1.7, cap_style="flat") for p in platforms]
        self.surface = orient_polygons(union_all([self.line.buffer(3.35, cap_style="flat"),
                                                 *platforms, *stems]), exterior_cw=True)
        if self.surface.geom_type != "Polygon":
            raise ValueError("The four lookouts must connect to the surveyed walkway")

    def level(self, station):
        # Estimate the deck profile from the published elevation and meet the mapped bank paths.
        return self.ground + np.interp(station, [0, 26, 98, 178, 247, 272, self.length],
                                       [.4, 5.5, 8.1, 8.1, 6.5, 5.4, .42])

    def point(self, station, lateral=0, above=0):
        tangent = self.curve(station, 1)
        tangent /= np.linalg.norm(tangent, axis=-1, keepdims=True)
        normal = np.stack((-tangent[..., 1], tangent[..., 0]), axis=-1)
        xz = self.curve(station) + normal * np.asarray(lateral)[..., None]
        return np.stack((xz[..., 0], self.level(station) + above, xz[..., 1]), axis=-1)

    def surface_point(self, point, above=0):
        return np.array([point[0], self.level(self.line.project(Point(point))) + above, point[1]])

    def spiral(self, station, phase, radius, hand):
        angle = hand * (station - 1) * 2 * np.pi / 54 + phase
        ends = np.minimum(np.clip((station-1)/12, 0, 1), np.clip((273-station)/12, 0, 1))
        height = 1.75 + (.52 + .48 * ends) * (radius*np.sin(angle) + .72)
        return self.point(station, radius*np.cos(angle), height)


class SurfaceBatch:
    """Join disconnected pieces that share a material into a single draw."""
    def __init__(self, name, color, metalness, roughness, **properties):
        self.material = PBRMaterial(name=name, baseColorFactor=color, metallicFactor=metalness,
                                    roughnessFactor=roughness, **properties)
        self.vertices, self.faces, self.uv = [], [], []
        self.count = 0

    def add(self, vertices, faces, uv=None):
        self.vertices.append(vertices)
        self.faces.append(np.asarray(faces) + self.count)
        self.uv.append(uv if uv is not None else np.zeros((len(vertices), 2)))
        self.count += len(vertices)

    def tube(self, path, radius, sides=8):
        points = np.asarray(path, dtype=float)
        tangent = np.gradient(points, axis=0)
        tangent /= np.linalg.norm(tangent, axis=1)[:, None]
        axis = [0., 1., 0.] if abs(tangent[0, 1]) < .9 else [1., 0., 0.]
        normals = np.cross(tangent, axis)
        normals /= np.linalg.norm(normals, axis=1)[:, None]
        binormals = np.cross(tangent, normals)
        angles = np.arange(sides) * 2 * np.pi / sides
        rings = points[:, None, :] + radius * (
            normals[:, None, :] * np.cos(angles)[None, :, None] +
            binormals[:, None, :] * np.sin(angles)[None, :, None])
        start = np.arange((len(points)-1) * sides).reshape(-1, sides)
        end = np.roll(start, -1, axis=1)
        faces = np.concatenate((np.stack((start, end, end+sides), axis=-1).reshape(-1, 3),
                                np.stack((start, end+sides, start+sides), axis=-1).reshape(-1, 3)))
        self.add(rings.reshape(-1, 3), faces)

    def mesh(self):
        return trimesh.Trimesh(vertices=np.vstack(self.vertices), faces=np.vstack(self.faces),
                               process=False, visual=TextureVisuals(uv=np.vstack(self.uv), material=self.material))


def walkway(deck, asphalt, edge, steel):
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
        if along < .12 or along > deck.length - .12:
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
    deck = Deck(survey)
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
    walkway(deck, asphalt, edge, steel)
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
    return {"entityId": "bay.helix-bridge", "layer": "ext", "kind": "structure",
            "label": "双螺旋桥与四处观景台", "regionId": "marina-bay-exterior", "assetHash": digest,
            "bounds": bounds, "material": {"shading": "albedo"}, "props": {"background": True,
            "平面来源": survey["source"], "建筑参考": survey["design"], "材质版权": credit,
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
