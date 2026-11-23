"""Open the Victoria Theatre bell chamber along the four photographed colonnades."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from shapely import constrained_delaunay_triangles
from shapely.geometry import Polygon
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
ENTITY = "bay.f21025bc-7836-44eb-82b6-f78da166312a"
SOURCE = "be6cc4591ece5f1419779b7ec72c2200cc024a57f1062e9e6a3c328eab46f564"
PHOTO = "https://commons.wikimedia.org/wiki/File:Victoria_Theatre_and_Victoria_Concert_Hall,_with_54m_high_Clock_Tower.jpg"
# Each rectified 520 × 260 elevation is viewed from outside. Pixel positions
# register the slits between the two piers and three banded columns on each face.
# Tuple order is x at sill, x at head, half-width, top and bottom.
SLOTS = {
    -100: [(157,154,6,43,191), (215,212,10,63,202), (272,278,10,62,201), (327,326,5,59,181)],
    170: [(161,157,8,42,198), (219,220,11,61,205), (282,288,10,58,206), (339,336,6,56,192)],
    80: [(181,177,7,61,216), (242,232,11,71,218), (296,305,12,68,215), (354,358,7,61,214)],
    -10: [(193,201,5,63,187), (251,260,9,48,189), (312,317,10,47,187), (375,375,7,34,185)],
}


def opening(spec, low, span):
    bottom_x, top_x, half_width, top, bottom = spec
    # Collars project slightly into the slits. Their spacing is estimated from
    # the front elevation photo; the outer edges follow the SLA atlas per face.
    levels = [(0, .78), (.11, 1), (.16, .78), (.20, .78), (.23, 1),
              (.42, 1), (.45, .78), (.49, .78), (.52, 1),
              (.70, 1), (.73, .78), (.77, .78), (.80, 1), (.94, 1), (1, .70)]
    side = np.array([[(bottom_x * (1-t) + top_x*t + sign*half_width*width)/520,
                      1 - (bottom*(1-t) + top*t)/260]
                     for sign in (-1, 1) for t, width in (levels if sign < 0 else reversed(levels))])
    return Polygon(low + side * span)


def unique_faces(mesh):
    attributes = [mesh.vertices, mesh.vertex_normals]
    if isinstance(mesh.visual, TextureVisuals):
        attributes.append(mesh.visual.uv)
    else:
        attributes.append(mesh.visual.vertex_colors)
    _, vertex = np.unique(np.column_stack(attributes), axis=0, return_inverse=True)
    faces = vertex[mesh.faces]
    ordered = np.take_along_axis(faces, (faces.argmin(axis=1)[:, None] + np.arange(3)) % 3, axis=1)
    _, keep = np.unique(ordered, axis=0, return_index=True)
    return mesh.faces[np.sort(keep)]


def carve(mesh):
    faces = unique_faces(mesh)
    triangles = mesh.vertices[faces]
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    normals /= np.maximum(np.linalg.norm(normals, axis=1)[:, None], 1e-10)
    heights = triangles[:, :, 1].mean(axis=1)
    panel = (heights > 43) & (heights < 46.85) & (np.abs(normals[:, 1]) < .2)
    if panel.sum() != 8:
        raise ValueError("Expected two survey triangles on each side of the bell chamber")
    direction = np.rint(np.degrees(np.arctan2(normals[:, 0], normals[:, 2])) / 10) * 10
    keep = faces[~panel].ravel()
    blocks = [np.column_stack((mesh.vertices[keep], mesh.vertex_normals[keep], mesh.visual.uv[keep]))]
    lining = []
    for bearing, specs in SLOTS.items():
        ids = np.flatnonzero(panel & (direction == bearing))
        if len(ids) != 2:
            raise ValueError(f"Missing tower face at {bearing} degrees")
        outward = normals[ids[0]]
        right = np.cross([0, 1, 0], outward)
        right /= np.linalg.norm(right)
        flat = np.stack((triangles[ids] @ right, triangles[ids, :, 1]), axis=-1)
        low, high = flat.reshape(-1, 2).min(axis=0), flat.reshape(-1, 2).max(axis=0)
        holes = [opening(s, low, high - low) for s in specs]
        transforms = np.linalg.inv(flat[:, 1:] - flat[:, :1])
        source = faces[ids]
        attributes = np.concatenate((mesh.vertices[source], mesh.vertex_normals[source], mesh.visual.uv[source]), axis=2)

        def sample(xy):
            bc = np.einsum('nsi,sij->nsj', xy[:, None, :] - flat[:, 0], transforms)
            weights = np.concatenate((1 - bc.sum(axis=2, keepdims=True), bc), axis=2)
            side = weights.min(axis=2).argmax(axis=1)
            return np.einsum('ni,nij->nj', weights[np.arange(len(xy)), side], attributes[side])

        for tri in flat:
            wall = Polygon(tri)
            for hole in holes:
                wall = wall.difference(hole)
            for fragment in constrained_delaunay_triangles(wall).geoms:
                rows = sample(np.asarray(fragment.exterior.coords)[:3])
                if np.cross(rows[1, :3] - rows[0, :3], rows[2, :3] - rows[0, :3]) @ outward < 0:
                    rows = rows[::-1]
                blocks.append(rows)
                inner = rows[::-1, :3] - .38 * outward
                lining.append(np.column_stack((inner, np.tile(-outward, (3, 1)), np.tile([48, 46, 43, 255], (3, 1)))))
        for hole in holes:
            ring = np.asarray(hole.exterior.coords)[:-1]
            front = sample(ring)
            # Light reaches the outer lip of the masonry. Its inward return
            # and the rear stone faces are in the shade of the chamber roof.
            for i in range(len(ring)):
                j = (i + 1) % len(ring)
                first, second = front[[i, j], :3]
                back = -.38 * outward
                normal = np.cross(second - first, back)
                normal /= np.linalg.norm(normal)
                xyz = np.array([first, second, second+back, first, second+back, first+back])
                daylight, shade = [148, 143, 132, 255], [48, 46, 43, 255]
                color = np.array([daylight, daylight, shade, daylight, shade, shade])
                lining.append(np.column_stack((xyz, np.tile(normal, (6, 1)), color)))
    values, ids = np.unique(np.vstack(blocks).astype('float32'), axis=0, return_inverse=True)
    exterior = trimesh.Trimesh(vertices=values[:, :3], vertex_normals=values[:, 3:6], faces=ids.reshape(-1, 3),
                           visual=TextureVisuals(material=mesh.visual.material, uv=values[:, 6:]), process=False)
    inside, faces = np.unique(np.vstack(lining).astype('float32'), axis=0, return_inverse=True)
    interior = trimesh.Trimesh(vertices=inside[:, :3], vertex_normals=inside[:, 3:6], faces=faces.reshape(-1, 3),
                               vertex_colors=inside[:, 6:].astype('uint8'), process=False)
    return exterior, interior


def bake(path):
    if hashlib.sha256(path.read_bytes()).hexdigest() != SOURCE:
        raise ValueError("Expected the original OneMap Victoria Theatre asset")
    scene = trimesh.load_scene(path, process=False)
    facade, = [name for name, mesh in scene.geometry.items() if isinstance(mesh.visual, TextureVisuals)]
    trim, = [name for name in scene.geometry if name != facade]
    scene.geometry[facade], lining = carve(scene.geometry[facade])
    stone = scene.geometry[trim]
    stone.faces = unique_faces(stone)
    stone.remove_unreferenced_vertices()
    # Preserve the untextured survey batch's default glTF white when adding
    # vertex colours to it for the first time.
    if stone.visual.kind is None:
        stone.visual.vertex_colors = np.full((len(stone.vertices), 4), 255, np.uint8)
    scene.geometry[trim] = trimesh.util.concatenate([stone, lining])
    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    file = ROOT / "build/onemap-entities.json"
    entities = json.loads(file.read_text())
    entity = next(e for e in entities if e["entityId"] == ENTITY)
    entity["assetHash"] = digest
    entity["props"].update({"三角形数": sum(len(m.faces) for m in scene.geometry.values()),
                            "钟楼参考": PHOTO, "钟楼开口": "四侧共十六处柱间开口按 OneMap 原始立面图定位。柱带厚度与洞口进深依照片估值。"})
    file.write_text(json.dumps(entities, indent=2, ensure_ascii=False) + "\n")
    return digest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    print(bake(parser.parse_args().source))
