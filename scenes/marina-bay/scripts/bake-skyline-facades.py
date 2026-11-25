"""Texture the mapped building parts visible across the reservoir."""
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from shapely import constrained_delaunay_triangles
from shapely.geometry import Polygon
from shapely.geometry.polygon import orient
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
REFERENCES = ROOT / "references/skyline-finishes"
# Width and height in metres of each repeating window-wall texture.
REPEAT = {"Facade006": (22.4, 27.2), "Facade018A": (18.0, 21.6), "Facade019A": (17.4, 21.0),
          "ServiceWall": (12.0, 3.55)}


def facade_material(name):
    folder = REFERENCES / name
    color = Image.open(folder / "Color.jpg")
    normal = Image.open(folder / "NormalGL.jpg")
    rough = Image.open(folder / "Roughness.jpg").convert("L")
    metal = Image.open(folder / "Metalness.jpg").convert("L")
    packed = Image.merge("RGB", (Image.new("L", rough.size, 255), rough, metal))
    packed.format = "JPEG"
    return PBRMaterial(name=name, baseColorTexture=color, normalTexture=normal,
                       metallicRoughnessTexture=packed, metallicFactor=.20, roughnessFactor=.94)


def exterior(part):
    outline = np.asarray(part["outline"])
    polygon = orient(Polygon(outline[:, [0, 2]]), sign=1)
    if not polygon.is_valid:
        raise ValueError(f"Invalid footprint {part['featureId']}")
    ring = np.asarray(polygon.exterior.coords)
    ground = {tuple(v[[0, 2]]): v[1] for v in outline}
    u_repeat, v_repeat = REPEAT[part["finish"]]
    # End every wall above the same floor line, including raised building sections.
    floors = max(1, round(part["height"] / 3.55))
    floor_height = part["height"] / floors
    stories_per_tile = round(v_repeat / 3.55)
    low_rise = bool(part.get("roofFinish"))
    floor_repeat = part["height"] if low_rise else floor_height * stories_per_tile
    # A 24 cm cladding cavity separates the finish from the streamed map wall.
    # Use shared corner positions and cap the cavity where it meets the original roof.
    path = ring[:-1]
    edges = np.roll(path, -1, axis=0) - path
    normals = np.column_stack((edges[:, 1], -edges[:, 0])) / np.linalg.norm(edges, axis=1)[:, None]
    bisectors = normals + np.roll(normals, 1, axis=0)
    miter = .24 / np.maximum(np.sum(bisectors * normals, axis=1), .3)
    skin = path + bisectors * miter[:, None]
    vertices, faces, uv, trim = [], [], [], []
    for i, a in enumerate(path):
        j = (i + 1) % len(path)
        b = path[j]
        start = len(vertices)
        length = np.linalg.norm(b - a)
        repeats = length / u_repeat
        if low_rise:
            # Single-storey facade modules start and end on solid piers at the corners.
            repeats = max(1, round(repeats))
        for k, elevation, u in [(i, part["minHeight"], 0), (j, part["minHeight"], repeats),
                                (j, part["height"], repeats), (i, part["height"], 0)]:
            vertices.append([skin[k, 0], ground[tuple(path[k])] + elevation, skin[k, 1]])
            uv.append([u, elevation / floor_repeat])
        faces.extend([[start, start + 2, start + 1], [start, start + 3, start + 2]])
        top_a = [a[0], ground[tuple(a)] + part["height"], a[1]]
        top_b = [b[0], ground[tuple(b)] + part["height"], b[1]]
        trim.extend([vertices[start + 3], top_a, top_b, vertices[start + 3], top_b, vertices[start + 2]])
    walls = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    walls.visual = TextureVisuals(uv=np.asarray(uv))
    coping = trimesh.Trimesh(vertices=trim, faces=np.arange(len(trim)).reshape(-1, 3), process=False)
    return walls, coping


def roof_surface(part):
    outline = np.asarray(part["outline"])
    plan = outline[:, [0, 2]]
    ground = {tuple(pt): y for pt, y in zip(plan, outline[:, 1])}
    edges = np.roll(plan, -1, axis=0) - plan
    spans = np.linalg.norm(edges, axis=1)
    axis = edges[spans.argmax()] / spans.max()
    across = np.array([-axis[1], axis[0]])
    vertices = []
    for triangle in constrained_delaunay_triangles(Polygon(plan)).geoms:
        points = [[x, ground[x, z] + part["height"] + .045, z] for x, z in triangle.exterior.coords[:-1]]
        if np.cross(np.subtract(points[1], points[0]), np.subtract(points[2], points[0]))[1] < 0:
            points.reverse()
        vertices.extend(points)
    mesh = trimesh.Trimesh(vertices=vertices, faces=np.arange(len(vertices)).reshape(-1, 3), process=False)
    offset = mesh.vertices[:, [0, 2]] - plan[0]
    mesh.visual = TextureVisuals(uv=np.column_stack([offset @ axis / 6.4, offset @ across / 5.0]))
    return mesh


def bake_group(group, parts, credit_line):
    finishes = {}
    trim = []
    for part in parts:
        wall, coping = exterior(part)
        finishes.setdefault(part["finish"], []).append(wall)
        trim.append(coping)
        if part.get("roofFinish"):
            finishes.setdefault(part["roofFinish"], []).append(roof_surface(part))
    scene = trimesh.Scene()
    for name, pieces in finishes.items():
        uv = np.concatenate([piece.visual.uv for piece in pieces])
        mesh = trimesh.util.concatenate(pieces)
        mesh.visual = TextureVisuals(uv=uv, material=facade_material(name))
        scene.add_geometry(mesh, geom_name=name)
    coping = trimesh.util.concatenate(trim)
    coping.visual = TextureVisuals(material=PBRMaterial(name="Coping", baseColorFactor=[142,147,147,255],
                                                       metallicFactor=0, roughnessFactor=.87))
    scene.add_geometry(coping, geom_name="Coping")
    low, high = scene.bounds
    origin = (low + high) / 2
    origin[1] = low[1]
    for mesh in scene.geometry.values():
        mesh.apply_translation(-origin)

    def credit(doc):
        doc["asset"]["copyright"] = credit_line

    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True, tree_postprocessor=credit)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    low_rise = bool(parts[0].get("roofFinish"))
    return {
        "entityId": f"bay.waterfront-skyline-facades.{group}",
        "layer": "ext",
        "kind": "structure",
        "label": "滨海湾 · 低层建筑屋面与墙身" if low_rise else "滨海湾 · 远景楼群与临湾外墙",
        "regionId": "marina-bay-exterior",
        "assetHash": digest,
        "material": {"shading": "albedo"},
        "bounds": {"min": low.tolist(), "max": high.tolist()},
        "props": {
            "background": True,
            "版权": credit_line,
            "表面": ("基于地图楼高与轮廓，金属屋面、灰泥、窗带和门板按米制尺度估算。" if low_rise
                   else "基于地图楼高与轮廓，采用三组日间外墙贴图估算窗格与层间饰面。"),
        },
    }


def bake():
    survey = json.loads((REFERENCES / "footprints.json").read_text())
    groups = {}
    for part in survey["parts"]:
        groups.setdefault(part["group"], []).append(part)
    entities = [
        bake_group(group, parts, survey["lowRiseCopyright"] if parts[0].get("roofFinish") else survey["copyright"])
        for group, parts in groups.items()
    ]
    (ROOT / "build/skyline-facades.json").write_text(json.dumps(entities, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    bake()
