"""Reconstruct the mapped Bayfront Bridge carriageways and their link to the Helix."""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from shapely.geometry import LineString, Point
import trimesh

from bridge_geometry import BridgeFrame, HelixDeck, SurfaceBatch
from scanned_canopy import ROOT, write_tree_asset


class RoadDeck:
    def __init__(self, survey, helix):
        frame = BridgeFrame()
        ring = frame.project(survey["outline"])
        self.edges = [LineString(ring[[10, 11, 0, 1, 2]]), LineString(ring[[9, 8, 7, 6]])]
        self.length = sum(line.length for line in self.edges) / 2
        self.crossing = LineString(frame.project(survey["link"])[1:])
        meet = self.crossing.intersection(self.edges[0])
        self.link_station = self.edges[0].project(meet, normalized=True) * self.length
        self.ground = helix.ground
        self.link_y = helix.level(helix.line.project(Point(self.crossing.coords[0])))
        self.helix_edge = self.crossing.intersection(helix.surface.boundary)
        self.road_edge = meet
        # The surveyed side paths fix the walkable width on each outside edge.
        self.walks = [LineString(frame.project(w)) for w in survey["walkways"]]
        roads = sorted(survey["roads"], key=lambda w: min(c[0] for c in w["coordinates"]))
        self.lane_change = next(
            self.edges[1].project(Point(xz), normalized=True) * self.length
            for road in roads
            if road["lanes"] == 4
            for xz in [frame.project(road)[0]]
        )

    def position(self, station, fraction, height=0):
        west, east = (
            np.asarray(line.interpolate(station / self.length, normalized=True).coords[0])
            for line in self.edges
        )
        plan = west + fraction * (east - west)
        level = np.interp(
            station,
            [0, 58, 105, self.link_station, 300, self.length],
            [
                self.ground + 0.28,
                self.ground + 4.1,
                self.ground + 6.85,
                self.link_y - 0.15,
                self.ground + 7.3,
                self.ground + 0.30,
            ],
        )
        return np.array([plan[0], level + height, plan[1]])

    def sidewalk(self, station, side):
        a, b = (self.position(station, k)[[0, 2]] for k in (0, 1))
        walk = self.walks[side]
        mid = walk.interpolate(walk.project(Point((a, b)[side])))
        fraction = np.dot(np.asarray(mid.coords[0]) - a, b - a) / np.dot(b - a, b - a)
        return np.clip(2 * fraction, 0.13, 0.19) if side == 0 else np.clip(2 * fraction - 1, 0.83, 0.89)


def quad(batch, points, outward, uv=None):
    a, b, c = points[:3]
    faces = [[0, 1, 2], [0, 2, 3]]
    if np.dot(np.cross(b - a, c - a), outward) < 0:
        faces = [[0, 2, 1], [0, 3, 2]]
    batch.add(points, faces, uv)


def ribbon(batch, left, right, outward, scale=None):
    for i in range(len(left) - 1):
        ps = np.array([left[i], right[i], right[i + 1], left[i + 1]])
        uv = (ps[:, [0, 2]] - left[0][[0, 2]]) / scale if scale is not None else None
        quad(batch, ps, outward, uv)


def deck_structure(road, asphalt, walkway, concrete, kerb):
    stations = np.unique(np.r_[np.linspace(0, road.length, 94), road.link_station, 58, 105, 300])
    soffit = [road.position(s, 0) - road.position(s, 1) for s in (0, road.length)]
    westward = sum(soffit)
    west, east = ([road.sidewalk(s, side) for s in stations] for side in (0, 1))

    def path(fraction, height):
        fs = np.broadcast_to(fraction, len(stations))
        return np.array([road.position(s, f, height) for s, f in zip(stations, fs)])

    # Walks, curb faces, carriageways and central reservation meet along shared edges.
    up = [0, 1, 0]
    for left, right, height, batch in [
        (0, west, 0.15, walkway),
        (west, 0.475, 0, asphalt),
        (0.475, 0.55, 0.17, kerb),
        (0.55, east, 0, asphalt),
        (east, 1, 0.15, walkway),
    ]:
        ribbon(batch, path(left, height), path(right, height), up, 2.08)
    for f, h, normal in [
        (west, 0.15, -westward),
        (0.475, 0.17, westward),
        (0.55, 0.17, -westward),
        (east, 0.15, westward),
    ]:
        ribbon(kerb, path(f, 0), path(f, h), normal)
    # The carriageway parapets shade the inside edge of each sidewalk.
    for edge, direction in [(np.array(west), -1), (np.array(east), 1)]:
        sections = [(0, 0.15), (0, 0.35), (0.008, 0.70), (0.008, 0.88), (0.018, 0.88), (0.018, 0.15)]
        for (f, h), (g, k) in zip(sections, sections[1:]):
            left = path(edge + direction * f, h)
            right = path(edge + direction * g, k)
            normal = [0, 1, 0] if h == k else westward * direction * (1 if k > h else -1)
            ribbon(kerb, left, right, normal)
    # The exposed cantilevers taper into the deeper concrete webs in the side elevation.
    profile = [
        (0, 0.15),
        (0, -0.34),
        (0.13, -0.62),
        (0.20, -1.62),
        (0.80, -1.62),
        (0.87, -0.62),
        (1, -0.34),
        (1, 0.15),
    ]
    for (f, a), (g, b) in zip(profile, profile[1:]):
        n = np.array([0.0, -1.0, 0.0]) if g > f else (westward if f == 0 else -westward)
        ribbon(concrete, path(f, a), path(g, b), n)
    for s, sign in [(0, -1), (road.length, 1)]:
        along = (road.position(road.length, 0.5) - road.position(0, 0.5)) * sign
        for f, g, h, k in [
            (0, 0.13, -0.34, -0.62),
            (0.13, 0.20, -0.62, -1.62),
            (0.20, 0.80, -1.62, -1.62),
            (0.80, 0.87, -1.62, -0.62),
            (0.87, 1, -0.62, -0.34),
        ]:
            quad(
                concrete,
                [road.position(s, f), road.position(s, g), road.position(s, g, k), road.position(s, f, h)],
                along,
            )


def markings(road, paint):
    # Lateral offsets follow the rectified orthophoto. The short southbound split is in OSM.
    width = np.linalg.norm(road.position(road.link_station, 1) - road.position(road.link_station, 0))

    def stripe(start, end, f, metres=0.12):
        half = metres / (2 * width)
        for s, t in zip(start, end):
            quad(
                paint,
                [
                    road.position(s, f - half, 0.014),
                    road.position(s, f + half, 0.014),
                    road.position(t, f + half, 0.014),
                    road.position(t, f - half, 0.014),
                ],
                [0, 1, 0],
            )

    dashes = np.arange(1, road.length - 2, 8)
    for f in (0.29, 0.38, 0.647, 0.739):
        stripe(dashes, np.minimum(road.length, dashes + 2.5), f, 0.14)
    south = dashes[dashes < road.lane_change]
    stripe(south, np.minimum(road.lane_change, south + 2.5), 0.811)
    stations = np.linspace(0, road.length, 80)
    for f in (0.172, 0.466, 0.558, 0.851):
        stripe(stations[:-1], stations[1:], f)


def rails_and_supports(road, concrete, steel):
    for s in np.linspace(0, road.length, round(road.length / 2.2) + 1):
        for f in (0.008, 0.992):
            p = road.position(s, f, 0.17)
            if f < 0.5 and abs(s - road.link_station) < 2.1:
                continue
            steel.tube([p, p + [0, 1.15, 0]], 0.047, 6)
    for f in (0.008, 0.992):
        spans = (
            [(0, road.link_station - 2), (road.link_station + 2, road.length)]
            if f < 0.5
            else [(0, road.length)]
        )
        for a, b in spans:
            for h, r in [(0.48, 0.023), (0.81, 0.032), (1.30, 0.057)]:
                ps = [road.position(s, f, h) for s in np.linspace(a, b, max(2, round((b - a) / 3.5)))]
                steel.tube(ps, r, 8)
    # Paired piers on water-level pile caps; spacing and sections are visual estimates.
    for s in [70, 123, 176, 229, 282, 335]:
        for f in (0.28, 0.72):
            bottom = road.position(s, f)
            bottom[1] = road.ground - 0.48
            cap = bottom + [0, 1.38, 0]
            top = road.position(s, f, -1.58)
            pile_cap = trimesh.creation.cylinder(radius=2.7, sections=16, segment=[bottom, cap])
            concrete.add(pile_cap.vertices, pile_cap.faces)
            concrete.tube([cap, top], 1.23, 12)
    for s in np.arange(25, road.length, 34):
        base = road.position(s, 0.514, 0.17)
        steel.tube([base, base + [0, 8.9, 0]], 0.11)
        for f in (0.435, 0.593):
            tip = road.position(s, f, 9.15)
            steel.tube([base + [0, 8.5, 0], tip], 0.065, 6)
            steel.tube([tip, road.position(s, f + (0.012 if f > 0.5 else -0.012), 9.15)], 0.14, 6)


def connector(road, helix, walkway, concrete, steel):
    # Clip to the two deck edges so the footway reaches the opening in each parapet.
    a = np.asarray(road.helix_edge.coords[0])
    b = np.asarray(road.road_edge.coords[0])
    direction = b - a
    direction /= np.linalg.norm(direction)
    side = np.array([-direction[1], direction[0]]) * 1.82
    y0 = helix.level(helix.line.project(Point(a)))
    y1 = road.position(road.link_station, 0, 0.15)[1]

    def p(plan, y):
        return np.array([plan[0], y, plan[1]])

    corners = np.array([p(a - side, y0), p(a + side, y0), p(b + side, y1), p(b - side, y1)])
    quad(walkway, corners, [0, 1, 0], (corners[:, [0, 2]] - a) / 2.08)
    quad(concrete, corners - [0, 0.26, 0], [0, -1, 0])
    for u, v, sign in [(corners[0], corners[3], -1), (corners[1], corners[2], 1)]:
        quad(concrete, [u, v, v - [0, 0.26, 0], u - [0, 0.26, 0]], p(sign * side, 0))
        for t in np.linspace(0, 1, 5):
            base = u + t * (v - u)
            steel.tube([base, base + [0, 1.13, 0]], 0.035, 6)
        for h in (0.40, 0.75, 1.13):
            steel.tube([u + [0, h, 0], v + [0, h, 0]], 0.04, 6)


def bake(texture, concrete_scan):
    survey = json.loads((ROOT / "references/bayfront-bridge.json").read_text())
    helix = HelixDeck(json.loads((ROOT / "references/helix-bridge.json").read_text()))
    road = RoadDeck(survey, helix)
    with Image.open(texture) as img:
        scan = img.convert("L").resize((256, 256), Image.Resampling.LANCZOS).convert("RGB")
    scan.format = "JPEG"
    asphalt = SurfaceBatch("Bayfront asphalt", [221, 220, 216, 255], 0, 0.94, baseColorTexture=scan)
    # The orthophoto shows a muted, warm grey aggregate on the exposed paths.
    # Choose the diffuse level from the clear strip between the rail and its shadow.
    with Image.open(concrete_scan) as img:
        grain = np.asarray(img.convert("L").resize((512, 512), Image.Resampling.LANCZOS), dtype=float)
    color = np.clip([139, 135, 127] + (grain[:, :, None] - grain.mean()) * 0.56, 0, 255)
    paving = Image.fromarray(color.astype(np.uint8))
    paving.format = "JPEG"
    walkway = SurfaceBatch("Bridge footway aggregate", [225, 225, 225, 255], 0, 0.93, baseColorTexture=paving)
    concrete = SurfaceBatch("Deck and pier concrete", [118, 115, 107, 255], 0, 0.90)
    kerb = SurfaceBatch("Walkway kerbs and median", [177, 171, 152, 255], 0, 0.87)
    steel = SurfaceBatch("Bridge rails and lighting", [178, 185, 184, 255], 0.32, 0.42)
    paint = SurfaceBatch("Lane markings", [208, 205, 186, 255], 0, 0.84)
    deck_structure(road, asphalt, walkway, concrete, kerb)
    markings(road, paint)
    rails_and_supports(road, concrete, steel)
    connector(road, helix, walkway, concrete, steel)
    scene = trimesh.Scene()
    for batch in [asphalt, walkway, concrete, kerb, steel, paint]:
        scene.add_geometry(batch.mesh(), geom_name=batch.material.name)
    credit = "Plan geometry © OpenStreetMap contributors (ODbL). Asphalt 01 and Concrete Floor 02 by Poly Haven (CC0)."
    digest, bounds = write_tree_asset(scene, copyright=credit)
    return {
        "entityId": "bay.bayfront-bridge",
        "layer": "ext",
        "kind": "structure",
        "label": "海湾舫桥与双螺旋桥联络步道",
        "regionId": "marina-bay-exterior",
        "assetHash": digest,
        "bounds": bounds,
        "material": {"shading": "albedo"},
        "props": {
            "background": True,
            "平面来源": survey["source"],
            "影像参考": survey["orthophoto"],
            "材质版权": credit,
            "重建范围": "OSM 桥面轮廓、车道数、两侧步道和联络通道与 OneMap 航片配准。桥面坡度、桥墩位置、灯杆和栏杆尺寸参照现场照片估读。",
        },
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("texture", type=Path)
    parser.add_argument("concrete_scan", type=Path, help="Poly Haven Concrete Floor 02 diffuse scan")
    args = parser.parse_args()
    row = bake(args.texture, args.concrete_scan)
    path = ROOT / "build/streetscape.json"
    rows = {e["entityId"]: e for e in json.loads(path.read_text())}
    rows[row["entityId"]] = row
    path.write_text(json.dumps(list(rows.values()), ensure_ascii=False, indent=2) + "\n")
    print(row["assetHash"])
