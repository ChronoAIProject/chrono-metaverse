"""Reconstruct the Dragonfly Bridge path from its surveyed centre line and photographs."""
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import LineString
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
GROUND = -60.23
WIDTH = 4.5
CLEARANCE = 2.87
LAST_CROSSING = 63.9
CREDIT = (
    "Route © OpenStreetMap contributors, ODbL. Width estimated from OneMap imagery, "
    "Map Data © Singapore Land Authority. Timber scans from Poly Haven, CC0. Wooden "
    "Planks by Charlotte Baglioni and Dario Barresi. Weathered Planks by Dimitrios "
    "Savva and Dario Barresi."
)


def material(name, srgb, roughness, metalness=0, texture=None):
    rgb = np.asarray(srgb, dtype=float) / 255
    linear = np.where(rgb < .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    return PBRMaterial(name=name, baseColorFactor=np.uint8([*np.rint(linear * 255), 255]),
                       baseColorTexture=texture, metallicFactor=metalness, roughnessFactor=roughness)


class Surface:
    def __init__(self, finish):
        self.finish = finish
        self.vertices = []
        self.faces = []
        self.uv = []

    def quad(self, points, uv=((0, 0), (1, 0), (1, 1), (0, 1))):
        start = len(self.vertices)
        self.vertices.extend(points)
        self.faces.extend([(start, start + 1, start + 2), (start, start + 2, start + 3)])
        self.uv.extend(uv)

    def tube(self, a, b, radius, sides=8):
        tangent = (b - a) / np.linalg.norm(b - a)
        axis = [0, 1, 0] if abs(tangent[1]) < .8 else [1, 0, 0]
        u = np.cross(tangent, axis)
        u /= np.linalg.norm(u)
        v = np.cross(tangent, u)
        angles = np.arange(sides) * (2 * np.pi / sides)
        ring = radius * (np.outer(np.cos(angles), u) + np.outer(np.sin(angles), v))
        for edge, other in zip(ring, np.roll(ring, -1, axis=0)):
            self.quad((a + edge, a + other, b + other, b + edge))

    def mesh(self):
        return trimesh.Trimesh(vertices=self.vertices, faces=self.faces, process=False,
                               visual=TextureVisuals(uv=self.uv, material=self.finish))


def build(survey):
    west, span, east = (survey[k] for k in ('west', 'span', 'east'))
    assert west[-1] == span[0] and span[-1] == east[0]
    route = LineString(west + span[1:] + east[1:])
    start = LineString(west).length
    end = start + LineString(span).length

    def position(distance, across, height=0):
        centre = np.array(route.interpolate(distance).coords[0])
        before = np.array(route.interpolate(max(0, distance - .15)).coords[0])
        after = np.array(route.interpolate(min(route.length, distance + .15)).coords[0])
        dx, dz = (after - before) / np.linalg.norm(after - before)
        # The approaches meet the flattened scene terrain. Keep clearance over
        # both crossing paths, then descend towards the eastern landing.
        if distance <= start:
            level = (.12 + 2.75 * min(1, distance / 37)) * min(1, distance / 2)
        elif distance <= start + LAST_CROSSING:
            level = CLEARANCE + .18 * np.sin(np.pi * (distance - start) / LAST_CROSSING)
        else:
            level = CLEARANCE * (route.length - distance) / (route.length - start - LAST_CROSSING)
        return np.array([centre[0] + dz * across, GROUND + level + height, centre[1] - dx * across])

    with Image.open(ROOT / 'references/timber-decks/pier-grain.jpg') as photo:
        timber = photo.convert('RGB')
    timber.format = 'JPEG'
    wood = Surface(material('Dragonfly Bridge transverse decking', (218, 208, 212), .82, texture=timber))
    approach = Surface(material('Garden approaches', (148, 142, 136), .96))
    fascia = Surface(material('Weathered bridge edge', (83, 79, 83), .9))
    steel = Surface(material('Muted purple painted steel', (105, 79, 110), .7, .23))
    concrete = Surface(material('Bridge support concrete', (138, 134, 122), .94))
    wire = Image.new('RGBA', (64, 64), (145, 141, 150, 0))
    draw = ImageDraw.Draw(wire)
    for offset in (-64, 0, 64):
        for top, bottom in ((0, 64), (64, 0)):
            draw.line([(offset, top), (offset + 64, bottom)], fill=(145, 141, 150, 255), width=2)
    wire.format = 'PNG'
    mesh = Surface(material('Open bridge railing mesh', (220, 217, 223), .82, texture=wire))
    mesh.finish.alphaMode = 'MASK'
    mesh.finish.alphaCutoff = .38
    mesh.finish.doubleSided = True

    for surface, lo, hi in ((approach, 0, start), (wood, start, end), (approach, end, route.length)):
        distances = np.linspace(lo, hi, int(np.ceil((hi - lo) / 1.3)) + 1)
        for d0, d1 in zip(distances, distances[1:]):
            left0, right0 = (position(d0, s * WIDTH / 2) for s in (-1, 1))
            left1, right1 = (position(d1, s * WIDTH / 2) for s in (-1, 1))
            surface.quad((left0, left1, right1, right0),
                         [(0, d0 / 2.15), (0, d1 / 2.15), (WIDTH / 4.4, d1 / 2.15), (WIDTH / 4.4, d0 / 2.15)])
            for a, b in ((left0, left1), (right1, right0)):
                low_a, low_b = a.copy(), b.copy()
                if surface is wood:
                    low_a[1] -= .30
                    low_b[1] -= .30
                else:
                    low_a[1] = min(GROUND, a[1] - .04)
                    low_b[1] = min(GROUND, b[1] - .04)
                fascia.quad((b, a, low_a, low_b))
            if surface is wood:
                fascia.quad([p - [0, .30, 0] for p in (left0, right0, right1, left1)])

    stations = np.linspace(start, end, round((end - start) / 2.25) + 1)
    for side in (-1, 1):
        across = side * (WIDTH / 2 - .06)
        for distance in stations:
            knee = position(distance, across, .91)
            steel.tube(position(distance, across, .03), knee, .032, 6)
            steel.tube(knee, position(distance, across - side * .14, 1.14), .032, 6)
        for d0, d1 in zip(stations, stations[1:]):
            for height, radius, inset in ((.08, .034, 0), (.88, .025, 0), (1.14, .045, .14)):
                x = across - side * inset
                steel.tube(position(d0, x, height), position(d1, x, height), radius)
            repeats = (d1 - d0) / .085
            mesh.quad([position(d, across, h) for d, h in ((d0, .10), (d1, .10), (d1, .87), (d0, .87))],
                      [(0, 0), (repeats, 0), (repeats, .77 / .085), (0, .77 / .085)])
    for distance in np.linspace(start + 6, end - 6, 7):
        for across in (-1.45, 1.45):
            base = position(distance, across)
            base[1] = GROUND - .20
            concrete.tube(base, position(distance, across, -.28), .19, 9)

    scene = trimesh.Scene()
    for part in (wood, approach, fascia, steel, mesh, concrete):
        scene.add_geometry(part.mesh(), geom_name=part.finish.name)
    return scene


def main():
    survey = json.loads((ROOT / 'references/dragonfly-bridge.json').read_text())
    scene = build(survey)
    low, high = scene.bounds
    origin = (low + high) / 2
    origin[1] = low[1]
    for part in scene.geometry.values():
        part.apply_translation(-origin)
    def credit(doc):
        doc['asset']['copyright'] = CREDIT
    data = trimesh.exchange.gltf.export_glb(scene, tree_postprocessor=credit)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / 'assets').mkdir(exist_ok=True)
    (ROOT / 'assets' / (digest + '.glb')).write_bytes(data)
    manifest = ROOT / 'build/dragonfly-bridge.json'
    entity = json.loads(manifest.read_text())
    entity.update(assetHash=digest, bounds={'min': low.tolist(), 'max': high.tolist()})
    manifest.write_text(json.dumps(entity, ensure_ascii=False, indent=2) + '\n')
    print(f"{digest}  {len(data):,} bytes")


if __name__ == '__main__':
    main()
