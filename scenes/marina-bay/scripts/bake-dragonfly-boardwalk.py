"""Open the sides of the surveyed Dragonfly Lake boardwalk while retaining its deck."""
import argparse
import hashlib
import json
from pathlib import Path
from textwrap import indent

import numpy as np
import trimesh
from scipy.spatial import cKDTree
from shapely import STRtree, union_all
from shapely.geometry import Point, Polygon
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
ENTITY_ID = "bay.c5a1fa8f-2fcb-4009-847e-fa715c1c1b9e"
SOURCE_HASH = "ee2a284ad0691bdfb819826671a7e840ce1f77647d57285fc76074c27e7282f7"
FASCIA_DEPTH = .23
CREDIT = "OneMap / Singapore Land Authority. Open boardwalk sides and supporting piles reconstructed from public ground photographs."


def finish(name, srgb):
    rgb = np.asarray(srgb) / 255
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    material = PBRMaterial(name=name, baseColorFactor=np.uint8([*(255 * linear), 255]),
                           metallicFactor=0, roughnessFactor=.91)
    return TextureVisuals(material=material)


def build(source):
    if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_HASH:
        raise ValueError("Expected the original OneMap boardwalk GLB")
    original = trimesh.load_scene(source, process=False)
    shell = next(mesh for mesh in original.geometry.values() if mesh.visual.kind == "texture")
    top_faces = np.where(shell.face_normals[:, 1] > .9)[0]
    deck = shell.submesh([top_faces], append=True, repair=False)
    # The camera-matched photograph shows roughly 5–8 pixels from the water
    # to the deck, corresponding to about 0.8 m at this distance. Ease back
    # into the three original connections over the adjacent 35 m of deck.
    entrances = np.array([[-31.4, -170.9], [-39.7, 10.7], [-21.4, 171.0]])
    distance = cKDTree(entrances).query(deck.vertices[:, [0, 2]])[0]
    blend = np.clip((distance - 3) / 35, 0, 1)
    deck.vertices[:, 1] -= 1.57 * blend**2 * (3 - 2 * blend)
    scene = trimesh.Scene()
    scene.add_geometry(deck, geom_name="OneMap deck surface")

    # The source repeats top vertices at texture seams. Close sub-centimetre gaps
    # before following the pile rows along the surveyed perimeter.
    footprint = union_all([Polygon(triangle[:, [0, 2]]) for triangle in deck.triangles])
    footprint = footprint.buffer(.015, join_style=2).buffer(-.015, join_style=2)
    if footprint.geom_type != "Polygon" or footprint.interiors:
        raise ValueError("Could not recover a connected boardwalk footprint")
    top_vertices = cKDTree(deck.vertices[:, [0, 2]])

    def elevation(xz):
        return deck.vertices[top_vertices.query(xz)[1], 1]

    side_faces = np.where(abs(shell.face_normals[:, 1]) < .1)[0]
    fascia = shell.submesh([side_faces], append=True, repair=False)
    bottom = fascia.vertices[:, 1] < 1
    fascia.vertices[:, 1] = elevation(fascia.vertices[:, [0, 2]]) - np.where(bottom, FASCIA_DEPTH, 0)
    fascia.visual = finish("Weathered boardwalk edge", [110, 88, 70])
    scene.add_geometry(fascia, geom_name="Boardwalk fascia")

    underside = deck.copy()
    underside.apply_translation([0, -FASCIA_DEPTH, 0])
    underside.invert()
    underside.visual = finish("Deck underside", [83, 73, 59])
    scene.add_geometry(underside, geom_name="Deck underside")

    # Interpolate the height of the actual triangle above each support,
    # including where longer source triangles cross a sloping approach.
    triangles = deck.triangles
    tree = STRtree([Polygon(tri[:, [0, 2]]) for tri in triangles])

    def pile_height(x, z):
        tri = triangles[tree.nearest(Point(x, z))]
        sides = (tri[1:] - tri[0])[:, [0, 2]]
        weights = np.linalg.solve(sides.T, [x - tri[0, 0], z - tri[0, 2]])
        return tri[0, 1] + weights @ (tri[1:, 1] - tri[0, 1]) - .21

    piles = []
    inset = footprint.buffer(-.25, join_style=2)
    for strip in getattr(inset, "geoms", [inset]):
        perimeter = strip.exterior
        count = max(1, round(perimeter.length / 2.6))
        for i in range(count):
            distance = (i + .5) * perimeter.length / count
            start = perimeter.interpolate(distance)
            end = perimeter.interpolate((distance + .03) % perimeter.length)
            x, z = start.coords[0]
            dx, dz = np.array(end.coords[0]) - start.coords[0]
            height = pile_height(x, z)
            pile = trimesh.creation.box(extents=[.27, height, .30])
            rotation = trimesh.transformations.rotation_matrix(-np.arctan2(dz, dx), [0, 1, 0])
            pile.apply_transform(rotation)
            pile.apply_translation([x, height / 2, z])
            piles.append(pile)
    supports = trimesh.util.concatenate(piles)
    supports.visual = finish("Concrete support piles", [152, 145, 127])
    scene.add_geometry(supports, geom_name="Boardwalk supports")

    if not np.allclose(original.bounds[:, [0, 2]], scene.bounds[:, [0, 2]], atol=1e-4, rtol=0):
        raise ValueError("Boardwalk extent changed")
    return scene


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Original OneMap boardwalk GLB")
    scene = build(parser.parse_args().source)

    def credit(doc):
        doc["asset"]["copyright"] = CREDIT

    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True, tree_postprocessor=credit)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets").mkdir(exist_ok=True)
    (ROOT / "assets" / f"{digest}.glb").write_bytes(data)
    manifest = ROOT / "build/onemap-entities.json"
    content = manifest.read_text()
    record = next(row for row in json.loads(content) if row["entityId"] == ENTITY_ID)

    def formatted(row):
        return indent(json.dumps(row, ensure_ascii=False, indent=2), "  ")

    previous = formatted(record)
    record["assetHash"] = digest
    record["props"]["三角形数"] = sum(len(mesh.faces) for mesh in scene.geometry.values())
    record["props"]["栈道"] = "沿用 OneMap 桥面轮廓与三个入口的标高；临水段净高、边梁和桩距按蜻蜓湖实拍估算。"
    if content.count(previous) != 1:
        raise ValueError("Could not locate the original boardwalk record")
    manifest.write_text(content.replace(previous, formatted(record)))
    print(digest)


if __name__ == "__main__":
    main()
