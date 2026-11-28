"""Open the outer crowns of the OneMap Supertree Grove and retain its platforms and skyway."""

import argparse
import hashlib
import json
import re
from pathlib import Path
from textwrap import indent

import numpy as np
import trimesh
from grove_daylight import calibrate
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
SIDES = 32
ANGLES = np.arange(SIDES) * 2 * np.pi / SIDES
CLIP_NORMALS = np.column_stack([np.cos(ANGLES), np.sin(ANGLES)])


def clip(poly, distance):
    """Clip interpolated positions, normals and texture coordinates to a half-plane."""
    if np.all(distance >= 0):
        return poly
    if np.all(distance < 0):
        return poly[:0]
    result = []
    for i in range(len(poly)):
        j = (i + 1) % len(poly)
        if distance[i] >= 0:
            result.append(poly[i])
        if (distance[i] < 0) != (distance[j] < 0):
            t = distance[i] / (distance[i] - distance[j])
            result.append(poly[i] + t * (poly[j] - poly[i]))
    return np.asarray(result)


def platform_radius(tree):
    return tree["radius"] * (.46 if tree["height"] > 48 else .32)


def surveyed_surface(mesh, trees):
    if mesh.visual.kind != "texture":
        return mesh
    rows = np.column_stack([mesh.vertices, mesh.vertex_normals, mesh.visual.uv])
    centers = np.asarray([t["centerXZ"] for t in trees])
    vertices, faces = [], []

    def append(poly):
        start = len(vertices)
        vertices.extend(poly)
        faces.extend((start, start + i, start + i + 1) for i in range(1, len(poly) - 1))

    for face in mesh.faces:
        original = rows[face]
        location = original[:, [0, 2]].mean(axis=0)
        nearest = np.linalg.norm(centers - location, axis=1).argmin()
        tree, center = trees[nearest], centers[nearest]
        height = original[:, 1] - (tree["groundY"] + .68 * tree["height"])
        if np.max(height) <= 0 or np.linalg.norm(location - center) > 1.25 * tree["radius"]:
            append(original)
            continue
        append(clip(original, -height))
        top = clip(original, height)
        for normal in CLIP_NORMALS:
            if len(top) < 3:
                break
            top = clip(top, platform_radius(tree) - (top[:, [0, 2]] - center) @ normal)
        if len(top) >= 3:
            append(top)
    v = np.asarray(vertices)
    normals = v[:, 3:6]
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-10)
    out = trimesh.Trimesh(vertices=v[:, :3], vertex_normals=normals, faces=faces,
                          visual=TextureVisuals(uv=v[:, 6:8], material=mesh.visual.material), process=False)
    out.update_faces(out.nondegenerate_faces())
    out.remove_unreferenced_vertices()
    out.merge_vertices()
    return out


def crown_frame(tree, rng):
    height, radius = tree["height"], tree["radius"]
    cx, cz = tree["centerXZ"]
    count = max(18, round(1.32 * radius))
    spin = rng.uniform(0, 2 * np.pi)
    vertices, faces, colors = [], [], []
    phi = np.arange(5) * 2 * np.pi / 5

    def point(angle, distance, level):
        return np.array([cx + radius * distance * np.cos(angle), tree["groundY"] + height * level,
                         cz + radius * distance * np.sin(angle)])

    def tube(start, end, lower, upper, color):
        axis = end - start
        axis /= np.linalg.norm(axis)
        side = np.cross(axis, [1, 0, 0] if abs(axis[1]) > .9 else [0, 1, 0])
        side /= np.linalg.norm(side)
        ring = np.cos(phi)[:, None] * side + np.sin(phi)[:, None] * np.cross(axis, side)
        first = len(vertices)
        vertices.extend(start + lower * ring)
        vertices.extend(end + upper * ring)
        for i in range(5):
            j = (i + 1) % 5
            faces.extend([(first+i, first+j, first+i+5), (first+j, first+j+5, first+i+5)])
        colors.extend([color] * 10)

    for i in range(count):
        angle = spin + 2*np.pi*i/count + .02*rng.normal()
        bend = rng.uniform(-.08, .08)
        foot, stem, knee = point(angle-.12, .18, .25), point(angle-.10, .19, .57), point(angle+.04, .31, .79)
        color = np.clip(rng.normal([104, 57, 80], [7, 5, 6]), 0, 255)
        tube(foot, stem, .13, .12, color)
        tube(stem, knee, .12, .108, color)
        for fork in (-1, 1):
            bearing = angle + bend + fork*.90*np.pi/count
            mid = point(bearing, .52+rng.uniform(-.03, .03), .91+rng.uniform(-.008, .004))
            tube(knee, mid, .108, .08, color)
            for side in (-1, 1):
                tip_angle = bearing + side*.65*np.pi/count
                joint = point(tip_angle+side*.05, .76, .968+rng.uniform(-.008, .008))
                tip = point(tip_angle-side*.018, rng.uniform(.96, 1.01), rng.uniform(.992, 1.008))
                tube(mid, joint, .08, .055, color)
                tube(joint, tip, .055, .045, color)
                tube(joint, point(tip_angle+.62*np.pi/count, .925, .988), .044, .035, color)

    # Support the retained deck and panel rim from the upper trunk.
    deck = platform_radius(tree) / radius
    for i in range(count):
        a = spin + 2*np.pi*i/count
        b = a + 2*np.pi/count
        for r, level in [(.26, .72), (.42, .86), (deck*.98, .982)]:
            tube(point(a, r, level), point(b, r, level), .08, .08, [81, 65, 69])
        tube(point(a, deck*.62, .88), point(b, deck*.98, .982), .095, .075, [79, 72, 76])

    srgb = np.asarray(colors) / 255
    linear = np.where(srgb < .04045, srgb/12.92, ((srgb+.055)/1.055)**2.4)
    paint = PBRMaterial(name="Radial steelwork", metallicFactor=.18, roughnessFactor=.7)
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, visual=TextureVisuals(material=paint), process=False)
    mesh.visual.vertex_attributes["color"] = np.uint8(np.column_stack([linear, np.ones(len(linear))]) * 255)
    return mesh


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_dir", type=Path, help="Content-addressed OneMap source GLBs")
    args = parser.parse_args()
    survey = json.loads((ROOT / "references/supertree-grove.json").read_text())
    manifest = ROOT / "build/onemap-entities.json"
    original_manifest = manifest.read_text()
    entities = json.loads(original_manifest)
    by_id = {entity["entityId"]: entity for entity in entities}
    rng = np.random.default_rng(96099)
    for record in survey["models"]:
        source = args.source_dir / (record["source"] + ".glb")
        if hashlib.sha256(source.read_bytes()).hexdigest() != record["source"]:
            raise ValueError(f"Unexpected source GLB for {record['entityId']}")
        original = trimesh.load_scene(source, process=False)
        model = trimesh.Scene()
        for name, surface in original.geometry.items():
            model.add_geometry(surveyed_surface(surface, record["crowns"]), geom_name=name)
        for index, tree in enumerate(record["crowns"]):
            model.add_geometry(crown_frame(tree, rng), geom_name=f"Radial steelwork {index+1}")
        low, high = model.bounds
        center = (low + high)/2
        center[1] = low[1]
        for surface in model.geometry.values():
            surface.apply_translation(-center)
        def credit(doc):
            doc["asset"]["copyright"] = "Map Data © Singapore Land Authority / OneMap. Open crown reconstruction."
        data = trimesh.exchange.gltf.export_glb(model, include_normals=True, tree_postprocessor=credit)
        if hashlib.sha256(data).hexdigest() != record["daylight"]["source"]:
            raise ValueError(f"Open crown reconstruction differs for {record['entityId']}")
        data = calibrate(data)
        digest = hashlib.sha256(data).hexdigest()
        if digest != record["daylight"]["output"]:
            raise ValueError(f"Daylight calibration differs for {record['entityId']}")
        (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
        entity = by_id[record["entityId"]]
        origin = np.asarray(record["sourceOrigin"])
        entity.update(assetHash=digest, bounds={"min": (low+origin).tolist(), "max": (high+origin).tolist()})
        entity["props"]["三角形数"] = sum(len(m.faces) for m in model.geometry.values())
        entity["props"]["冠架"] = "沿原测绘冠幅重建透空钢架，分枝、杆径和平台支撑按湖边实拍估算。"
    changed = {row["entityId"] for row in survey["models"]}
    def replace_record(match):
        entity_id = json.loads(match[0])["entityId"]
        if entity_id in changed:
            return indent(json.dumps(by_id[entity_id], ensure_ascii=False, indent=2), "  ")
        return match[0]

    manifest.write_text(re.sub(r"^  \{\n.*?^  \}(?=,?\n)", replace_record, original_manifest,
                               flags=re.MULTILINE | re.DOTALL))


if __name__ == "__main__":
    main()
