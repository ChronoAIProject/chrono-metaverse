"""Survey coordinates and material batches shared by the two Bayfront bridges."""
import json
import sys

import numpy as np
from scipy.interpolate import CubicSpline
from shapely import orient_polygons, union_all
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import linemerge
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from context_geometry import geographic_point
from scanned_canopy import ROOT

sys.path.insert(0, str(ROOT.parents[1] / "recon/src"))
from metaverse_recon.context.convert import frame


class BridgeFrame:
    def __init__(self):
        config = json.loads((ROOT / "context.json").read_text())["oneMap"]
        self.origin, self.rotation = frame(config)
        self.shift = np.array(json.loads((ROOT / "build/alignment.json").read_text())["shift"])

    def project(self, row):
        return np.asarray([geographic_point(*ll, self.origin, self.rotation, self.shift)[[0, 2]]
                           for ll in row["coordinates"]])


class HelixDeck:
    def __init__(self, survey):
        frame = BridgeFrame()
        ways = [LineString(frame.project(row)) for row in survey["alignment"]]
        points = np.asarray(linemerge(ways).coords)
        if not np.allclose(points[0], ways[-1].coords[-1]):
            points = points[::-1]
        distances = np.r_[0, np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))]
        self.curve = CubicSpline(distances, points, bc_type="natural")
        self.length = distances[-1]
        self.stations = np.linspace(0, self.length, 220)
        self.line = LineString(self.curve(self.stations))
        map_config = json.loads((ROOT / "build/environment.json").read_text())["props"]["environment"]["map"]
        self.ground = map_config["origin"][1] - np.linalg.norm(self.curve(140) - frame.shift[[0, 2]])**2 / (2 * 6371000)
        platforms = [Polygon(frame.project(row)) for row in survey["lookouts"]]
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
