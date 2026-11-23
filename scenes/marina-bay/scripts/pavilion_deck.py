"""Register the southern pier walk surface to the OneMap zoom-20 orthophoto."""

import io
import json
import struct

import numpy as np
from PIL import Image


# The 96 × 654 pixel crop begins at (76, 55) in the registered pier orthophoto.
# Columns map local GLB X/Z metres to crop pixels, fitted at the four WGS84 tile
# corners after the same ECEF rotation and alignment as the original SLA model.
PIXEL_AXES = np.array([[-6.0722594933, -2.8506139874], [2.8315404101, -6.1131629167]])
SOURCE_CENTRE = np.array([241.1796515, 405.7368445])
PIXEL_ORIGIN = np.array([451.4301388106 - 76, 3554.5270929760 - 55])
SIZE = np.array([96, 654])


def deck_faces(positions, triangles):
    pixels = (positions[:, [0, 2]] + SOURCE_CENTRE) @ PIXEL_AXES + PIXEL_ORIGIN
    uv = pixels / SIZE
    points = positions[triangles]
    normals = np.cross(points[:, 1] - points[:, 0], points[:, 2] - points[:, 0])
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-8)
    on_crop = ((uv[triangles] >= 0) & (uv[triangles] <= 1)).all(axis=(1, 2))
    height = points[:, :, 1].mean(axis=1)
    selection = on_crop & (normals[:, 1] > .95) & (height > .84) & (height < 1.02)
    return selection, uv.astype('<f4')


def course_uv(x, y):
    across = x + 76 - (141.2 - .055 * (y + 55 - 70))
    along = y - .055 * x
    return across * .149 / 1.65, along * .149 / 1.24


def board_normals(reference):
    normals = np.array(Image.open(reference.with_name("teak-veneer-normal.png"))
                       .convert("RGB").resize((512, 512), Image.Resampling.LANCZOS))
    rng = np.random.default_rng(321)
    for row in range(0, 512, 64):
        normals[row:row+64] = np.roll(normals[row:row+64], int(rng.integers(512)), axis=1)
        rng.uniform(.95, 1.04)  # match the colour variation draw in deck_material
        normals[row] = [128, 166, 249]
        normals[row + 2] = [128, 94, 250]
    out = io.BytesIO()
    Image.fromarray(normals).save(out, 'JPEG', quality=93, subsampling=0)
    return out.getvalue()


def landing_boards(reference):
    digest = "bbb3cf29f56c82ee1d3c9ccaaeaaf5bc62f956129b0e040ef6ef96cdd304fc4b"
    raw = (reference.parents[1] / "assets" / (digest + ".glb")).read_bytes()
    length = struct.unpack_from("<I", raw, 12)[0]
    doc = json.loads(raw[20:20 + length])
    view = doc['bufferViews'][doc['images'][0]['bufferView']]
    offset = 28 + length + view.get('byteOffset', 0)
    return raw[offset:offset + view['byteLength']]


def split_polygon(polygon, boundary, side):
    """Clip in registered aerial pixel space; interpolate the original 3-D point."""
    clipped = []
    for a, b in zip(polygon, np.roll(polygon, -1, axis=0)):
        da, db = (a[-1] - boundary) * side, (b[-1] - boundary) * side
        if da >= 0:
            clipped.append(a)
        if (da < 0 < db) or (db < 0 < da):
            clipped.append(a + da / (da - db) * (b - a))
    return np.asarray(clipped)


def add_deck(document, views, mesh, primitive, faces, uv, image_path):
    def texture(data):
        document['images'].append({'bufferView': len(views), 'mimeType': 'image/jpeg'})
        document['bufferViews'].append({'buffer': 0})
        views.append(data)
        index = len(document['textures'])
        document['textures'].append({'source': len(document['images']) - 1})
        return index

    def accessor(values, kind, component, target, bounds=False):
        obj = {'bufferView': len(views), 'type': kind, 'count': len(values), 'componentType': component}
        if bounds:
            obj.update(min=values.min(axis=0).tolist(), max=values.max(axis=0).tolist())
        document['bufferViews'].append({'buffer': 0, 'target': target})
        views.append(values.tobytes())
        index = len(document['accessors'])
        document['accessors'].append(obj)
        return index

    position = document['accessors'][primitive['attributes']['POSITION']]
    xyz = np.frombuffer(views[position['bufferView']], '<f4').reshape(-1, 3).astype(float)
    pixels = uv * SIZE
    across = course_uv(*pixels.T)[0] * 1.65 / .149
    source = np.column_stack((xyz, pixels, across))
    decks = [[], []]
    # Keep the photographed edges/landing arms. Split the two edges of the
    # central walk at measured image coordinates to give it full texel density.
    for triangle in source[faces]:
        normal = np.cross(triangle[1, :3] - triangle[0, :3], triangle[2, :3] - triangle[0, :3])
        normal /= np.linalg.norm(normal)
        center = split_polygon(triangle, -7.8, 1)
        polys = [(False, split_polygon(triangle, -7.8, -1)),
                 (False, split_polygon(triangle, 7.8, 1))]
        if len(center) >= 3:
            polys.append((True, split_polygon(center, 7.8, -1)))
        for lane, polygon in polys:
            for j in range(1, len(polygon) - 1):
                coords = polygon[[0, j, j + 1]]
                if np.linalg.norm(np.cross(coords[1, :3]-coords[0, :3], coords[2, :3]-coords[0, :3])) < 1e-8:
                    continue
                tex = np.column_stack(course_uv(*coords[:, 3:5].T)) if lane else coords[:, 3:5] / SIZE
                decks[lane].extend(np.column_stack((coords[:, :3], [normal] * 3, tex)))

    area = 0.
    count = 0
    for lane, vertices in enumerate(decks):
        values = np.array(vertices, dtype='<f4')
        tri = values[:, :3].reshape(-1, 3, 3)
        area += np.linalg.norm(np.cross(tri[:, 1]-tri[:, 0], tri[:, 2]-tri[:, 0]), axis=1).sum()
        count += len(tri)
        unique, indices = np.unique(values, axis=0, return_inverse=True)
        mat = {'name': 'Fullerton pier walk boards' if lane else 'Surveyed Fullerton pier edges'}
        if lane:
            tex = texture(landing_boards(image_path))
            mat['normalTexture'] = {'index': texture(board_normals(image_path)), 'scale': .48}
        else:
            tex = texture(image_path.read_bytes())
        mat['pbrMetallicRoughness'] = {'metallicFactor': 0, 'roughnessFactor': .82,
            'baseColorTexture': {'index': tex},
            'baseColorFactor': [.60, .64, .73, 1] if lane else [1,1,1,1]}
        mat_index = len(document['materials'])
        document['materials'].append(mat)
        mesh['primitives'].append({'material': mat_index,
            'attributes': {'POSITION': accessor(unique[:, :3], 'VEC3', 5126, 34962, True),
                           'NORMAL': accessor(unique[:, 3:6], 'VEC3', 5126, 34962),
                           'TEXCOORD_0': accessor(unique[:, 6:], 'VEC2', 5126, 34962)},
            'indices': accessor(indices.astype('<u2'), 'SCALAR', 5123, 34963)})
    raw = xyz[faces]
    original_area = np.linalg.norm(np.cross(raw[:, 1]-raw[:, 0], raw[:, 2]-raw[:, 0]), axis=1).sum()
    if not np.isclose(area, original_area, rtol=5e-6):
        raise ValueError('Deck clipping changed the measured walk area')
    return count - len(faces)
