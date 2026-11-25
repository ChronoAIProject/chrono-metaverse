"""Textured flyover decks and ground visible beneath the Marina Centre approaches."""

import numpy as np
from scipy.interpolate import PchipInterpolator
from PIL import Image
from scipy.spatial import cKDTree
from shapely import get_parts, union_all
from shapely.geometry import GeometryCollection, LineString, Point
import trimesh
from trimesh.visual.material import PBRMaterial

from bridge_geometry import SurfaceBatch


class Ramp:
    def __init__(self, record, project, ground, datum):
        paths = [np.asarray([project(p) for p in row["coordinates"]]) for row in record["segments"]]
        if any(not np.allclose(a[-1], b[0]) for a, b in zip(paths, paths[1:])):
            raise ValueError("Disconnected ramp centre lines")
        points = np.concatenate([paths[0], *(p[1:] for p in paths[1:])])
        self.chain = np.r_[0, np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))]
        self.curve = PchipInterpolator(self.chain, points, axis=0)
        self.tangent = self.curve.derivative()
        self.start, self.end = record["start"], record["end"]
        self.ground, self.datum = ground, datum
        profile = np.asarray(record["profile"])
        self.elevation = PchipInterpolator(*profile.T, extrapolate=False)
        self.profile_range = profile[[0, -1], 0]
        self.tones = np.asarray(record["groundTones"])
        # Change road width continuously on the approach to each lane-count transition.
        starts = np.r_[0, np.cumsum([LineString(p).length for p in paths])]
        self.width_stations, self.lanes = [0], [record["segments"][0]["lanes"]]
        for s, seg in zip(starts[1:], record["segments"][1:]):
            if seg["lanes"] != self.lanes[-1]:
                self.width_stations.extend([s - 24, s + 12])
                self.lanes.extend([self.lanes[-1], seg["lanes"]])

    def height(self, s):
        return self.elevation(np.clip(s, *self.profile_range))

    def lane_count(self, s):
        return np.interp(s, self.width_stations, self.lanes)

    def position(self, s, lateral=0, above=0, on_ground=False):
        center = self.curve(s)
        tangent = self.tangent(s)
        tangent /= np.linalg.norm(tangent, axis=-1, keepdims=True)
        side = np.stack([-tangent[..., 1], tangent[..., 0]], axis=-1)
        plan = center + np.asarray(lateral)[..., None] * side
        level = self.ground - np.sum((plan - self.datum)**2, axis=-1) / (2 * 6371000)
        if not on_ground:
            level += .078 + self.height(s)
        return np.stack([plan[..., 0], level + above, plan[..., 1]], axis=-1)


def strip(batch, left, right, *, reverse=False, uv=None):
    # Facing follows the road tangent throughout a bend.
    vertices = np.stack([left, right], axis=1).reshape(-1, 3)
    i = 2 * np.arange(len(left) - 1)
    faces = np.concatenate([np.stack([i, i + 1, i + 2], axis=1),
                            np.stack([i + 1, i + 3, i + 2], axis=1)])
    if reverse:
        faces = faces[:, ::-1]
    batch.add(vertices, faces, uv)


def add_undercroft(scene, ramp, name, s, streets, surface):
    ground, datum = ramp.ground, ramp.datum
    # Reconstruct the narrow strip hidden in the orthophoto beneath each original deck.
    # Leave mapped streets and paths clear. Interpolate colour from both verges at each station.
    margin = PBRMaterial(name=name + " undercroft", metallicFactor=0, roughnessFactor=1)
    coverage = []
    for a, b in zip(s, s[1:]):
        mid = (a + b) * .5
        if ramp.height(mid) < .6:
            continue
        width = ramp.lane_count(mid) * 3.15 / 2 + 1.2
        outline = LineString(ramp.curve([a, b])).buffer(width, cap_style="flat")
        coverage.append(outline.difference(streets))
    # Keep the station boundaries so a run across planted ground retains its measured colour changes.
    mesh = surface(GeometryCollection(coverage), margin, ground, datum, height=.032)
    xz = mesh.vertices[:, [0, 2]]
    _, idx = cKDTree(ramp.curve(ramp.tones[:, 0])).query(xz)
    stations = ramp.tones[idx, 0]
    pos = ramp.position(stations)[:, [0, 2]]
    side = ramp.position(stations, 1)[:, [0, 2]] - pos
    weight = (.5 - np.sum((xz - pos) * side, axis=1) / 16).clip(0, 1)[:, None]
    srgb = (ramp.tones[idx, 1:4] * (1 - weight) + ramp.tones[idx, 4:7] * weight) / 255
    color = np.where(srgb <= .04045, srgb / 12.92, ((srgb + .055) / 1.055)**2.4)
    mesh.visual.vertex_attributes["color"] = np.uint8(np.c_[color, np.ones(len(color))] * 255)
    scene.add_geometry(mesh, geom_name=margin.name)


def add_ground_crossings(ramp, s, roads, project, pavement, lines):
    ground, datum = ramp.ground, ramp.datum
    # Include surface streets extending past the existing ground-level streetscape.
    # Repaint the part hidden by the photographed deck, including lane divisions.
    corridor = LineString(ramp.curve(s)).buffer(10 + .5 * 3.15)
    for road in roads:
        count = road.get("surfaceLanes")
        if not count:
            continue
        center = LineString([project(p) for p in road["coordinates"]])
        for part in get_parts(center.intersection(corridor)):
            if not isinstance(part, LineString) or part.length < .2:
                continue
            t = np.linspace(0, part.length, 1 + int(np.ceil(part.length / 2)))
            xz = np.asarray([part.interpolate(d).coords[0] for d in t])
            along = np.gradient(xz, axis=0)
            along /= np.linalg.norm(along, axis=1)[:, None]
            normal = np.column_stack([-along[:, 1], along[:, 0]])
            def street_points(offset, height):
                plan = xz + normal * offset
                level = ground - np.sum((plan - datum)**2, axis=1) / (2 * 6371000)
                return np.c_[plan[:, 0], level + height, plan[:, 1]]
            half_width = count * 3.15 / 2
            dist = t + center.project(Point(xz[0]))
            uv = np.stack([np.column_stack([np.full_like(t, edge), -dist / 8.32])
                           for edge in (0, count)], axis=1).reshape(-1, 2)
            strip(pavement, street_points(-half_width, .049), street_points(half_width, .049), uv=uv)
            for lane in range(1, count):
                offset = -half_width + lane * 3.15
                left, right = street_points(offset - .065, .064), street_points(offset + .065, .064)
                for k in np.flatnonzero((dist[:-1] % 6) < 2):
                    strip(lines, left[k:k+2], right[k:k+2])


def add_flyovers(scene, survey, project, ground, datum, asphalt, paint, surface):
    pavement = SurfaceBatch("Elevated asphalt", [255] * 4, 0, 1)
    pavement.material = asphalt
    lines = SurfaceBatch("Elevated lane markings", [255] * 4, 0, 1)
    lines.material = paint
    concrete = SurfaceBatch("Flyover parapets, box girders and piers", [172, 169, 160, 255],
                            0, .95, finish="concrete", repeat=2.6)
    # Cast concrete has a quieter diffuse variation than the original weathered floor scan.
    aggregate = np.asarray(concrete.material.baseColorTexture, dtype=float)
    cast = Image.fromarray(np.uint8(np.clip(202 + .30 * (aggregate - np.median(aggregate)), 0, 255)))
    cast.format = "JPEG"
    concrete.material.baseColorTexture = cast
    streets = union_all([LineString([project(p) for p in road["coordinates"]]).buffer(road["halfWidth"])
                         for road in survey["underlyingWays"]])
    for row in survey["ramps"]:
        ramp = Ramp(row, project, ground, datum)
        s = np.linspace(ramp.start, ramp.end, 1 + int(np.ceil((ramp.end - ramp.start) / 3)))
        half = ramp.lane_count(s) * 3.15 / 2 + .65
        uv = np.stack([np.stack([sign * half / 3.15, -s / 8.32], axis=1) for sign in [-1, 1]],
                      axis=1).reshape(-1, 2)
        # With lateral positive to the left in plan, left-to-right order here faces up in glTF.
        strip(pavement, ramp.position(s, -half), ramp.position(s, half), uv=uv)
        # Closed box girder and safety barriers taper to the height of the map at each end.
        depth = np.minimum(1.32, ramp.height(s) + .06)
        barrier = np.clip(np.minimum(s - ramp.start, ramp.end - s) / 14, 0, 1)
        section = [(-half, 0), (-half, .87 * barrier), (-half - .32, .87 * barrier),
                   (-half - .32, -.32 * depth), (-half + .83, -.49 * depth),
                   (-half + 1.16, -depth), (half - 1.16, -depth), (half - .83, -.49 * depth),
                   (half + .32, -.32 * depth), (half + .32, .87 * barrier),
                   (half, .87 * barrier), (half, 0)]
        for (u, h), (v, k) in zip(section, section[1:]):
            strip(concrete, ramp.position(s, u, h), ramp.position(s, v, k), reverse=True)
        for side in [-1, 1]:
            edge = side * (half - .32)
            strip(lines, ramp.position(s, edge - .065, .022), ramp.position(s, edge + .065, .022))
        for a in np.arange(ramp.start + 1, ramp.end - 2, 6):
            dash = np.array([a, a + 2])
            lanes = ramp.lane_count(dash)
            if lanes.min() < 1.65:
                continue
            offset = (2 - lanes) * 3.15 / 2
            strip(lines, ramp.position(dash, offset - .065, .022), ramp.position(dash, offset + .065, .022))
        for nominal in np.arange(ramp.start + 26, ramp.end, 28):
            for s0 in nominal + np.array([0, -3, 3, -6, 6, -9, 9]):
                if s0 >= ramp.end or ramp.height(s0) < 1.7 or streets.distance(Point(ramp.curve(s0))) < 1.35:
                    continue
                bottom = ramp.position(s0, on_ground=True, above=-.04)
                top = ramp.position(s0, above=-1.27)
                pier = trimesh.creation.cylinder(radius=.94, sections=12, segment=[bottom, top])
                concrete.add(pier.vertices, pier.faces)
                break
        add_undercroft(scene, ramp, row["name"], s, streets, surface)
        add_ground_crossings(ramp, s, survey["underlyingWays"], project, pavement, lines)
    for batch in [pavement, lines, concrete]:
        scene.add_geometry(batch.mesh(), geom_name=batch.material.name + " (flyovers)")
