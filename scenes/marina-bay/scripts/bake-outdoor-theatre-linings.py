"""Recover the daylight appearance of the two membrane linings from the surveyed top surfaces."""

import argparse
from copy import deepcopy
import hashlib
from io import BytesIO
import json
from pathlib import Path
import struct

import numpy as np
from PIL import Image
from scipy.optimize import linear_sum_assignment
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
PHOTO = 'https://commons.wikimedia.org/?curid=152986183'
SURVEYS = {
    'bay.873280ad-f3d6-4f36-811a-2c1d9d7a4a90': '911805989436ff90fe401e79669dae236a4c0b450dac235cbfd081990e6a3d83',
    'bay.ceed8dd0-f73e-4e2b-89c3-f9ee3e3286fe': '6fb06dbd71e5ef7193dc38730129f1386c44fcace8217a6dd2da8e8eb249fe7a',
}


def match_surfaces(positions, uv, indices, atlas):
    triangles = positions[indices]
    centres = triangles.mean(axis=1)
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    normals /= np.maximum(1e-10, np.linalg.norm(normals, axis=1, keepdims=True))
    st = uv[indices].mean(axis=1) % 1
    height, width = atlas.shape[:2]
    samples = atlas[(st[:, 1] * (height - 1)).astype(int), (st[:, 0] * (width - 1)).astype(int)]
    # The unsurveyed underside uses a solid (64,64,64) fill in both original atlases.
    membrane = centres[:, 1] > 2
    top = np.flatnonzero(membrane & (normals[:, 1] > .15) & (samples.mean(axis=1) > 100))
    bottom = np.flatnonzero(membrane & (normals[:, 1] < -.15) &
                            (abs(samples.astype(float) - 64).max(axis=1) < 4))
    distances, nearest = cKDTree(centres[top]).query(centres[bottom])
    selected, mapped_uv = [], []
    for lower, upper, distance in zip(bottom, top[nearest], distances):
        if distance > 1.35 or normals[lower] @ normals[upper] > -.90:
            continue
        corner_distances = np.linalg.norm(triangles[lower, :, None] - triangles[upper, None, :], axis=2)
        rows, corners = linear_sum_assignment(corner_distances)
        if corner_distances[rows, corners].max() > 1.8:
            continue
        selected.append(lower)
        mapped_uv.extend(uv[indices[upper, corners]])
    return selected, np.asarray(mapped_uv, dtype='<f4')


def bake(source):
    length = struct.unpack_from('<I', source, 12)[0]
    doc = json.loads(source[20:20 + length])
    binary = bytearray(source[28 + length:])

    def array(index):
        accessor = doc['accessors'][index]
        view = doc['bufferViews'][accessor['bufferView']]
        dtype = {5126: '<f4', 5125: '<u4', 5123: '<u2'}[accessor['componentType']]
        size = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3}[accessor['type']]
        start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
        return np.frombuffer(source, dtype, size * accessor['count'], 28 + length + start).reshape(-1, size)

    def append(values, kind):
        is_index = kind == 'SCALAR'
        values = np.ascontiguousarray(values, dtype='<u4' if is_index else '<f4')
        binary.extend(bytes(-len(binary) % 4))
        doc['bufferViews'].append(dict(buffer=0, byteOffset=len(binary), byteLength=values.nbytes,
                                       target=34963 if is_index else 34962))
        binary.extend(values.tobytes())
        accessor = dict(bufferView=len(doc['bufferViews']) - 1, componentType=5125 if is_index else 5126,
                        count=len(values), type=kind)
        if kind == 'VEC3':
            accessor.update(min=values.min(axis=0).tolist(), max=values.max(axis=0).tolist())
        doc['accessors'].append(accessor)
        return len(doc['accessors']) - 1

    mesh, = [m for m in doc['meshes'] if any('material' in p for p in m['primitives'])]
    original, = mesh['primitives']
    attrs = original['attributes']
    positions, normals, uv = (array(attrs[key]) for key in ('POSITION', 'NORMAL', 'TEXCOORD_0'))
    indices = array(original['indices']).reshape(-1, 3)
    paint = deepcopy(doc['materials'][original['material']])
    colour = paint['pbrMetallicRoughness']
    texture = colour['baseColorTexture']['index']
    img = doc['images'][doc['textures'][texture]['source']]
    view = doc['bufferViews'][img['bufferView']]
    start = view.get('byteOffset', 0)
    atlas = np.asarray(Image.open(BytesIO(binary[start:start + view['byteLength']])).convert('RGB'))
    selected, mapped_uv = match_surfaces(positions, uv, indices, atlas)
    if not selected:
        raise ValueError('No corresponding membrane faces in survey')
    vertices = indices[selected].ravel()
    original['indices'] = append(np.delete(indices, selected, axis=0).ravel(), 'SCALAR')

    # The registered photograph shows skylight through the fabric. The small
    # diffuse emission baked from the upper cloth approximates that transmitted light.
    paint.update(name='Outdoor theatre membrane lining', doubleSided=False,
                 emissiveFactor=[.14, .15, .20], emissiveTexture={'index': texture})
    colour.update(baseColorFactor=[.63, .66, .76, 1], roughnessFactor=.93, metallicFactor=0)
    doc['materials'].append(paint)
    mesh['primitives'].append(dict(material=len(doc['materials']) - 1,
                                   attributes={'POSITION': append(positions[vertices], 'VEC3'),
                                               'NORMAL': append(normals[vertices], 'VEC3'),
                                               'TEXCOORD_0': append(mapped_uv, 'VEC2')},
                                   indices=append(np.arange(len(vertices)), 'SCALAR')))
    binary.extend(bytes(-len(binary) % 4))
    doc['buffers'][0]['byteLength'] = len(binary)
    header = json.dumps(doc, separators=(',', ':')).encode()
    header += b' ' * (-len(header) % 4)
    return (struct.pack('<4sIII4s', b'glTF', 2, 28 + len(header) + len(binary), len(header), b'JSON')
            + header + struct.pack('<I4s', len(binary), b'BIN\0') + binary), len(selected)


def build(folder):
    manifest = ROOT / 'build/onemap-entities.json'
    records = json.loads(manifest.read_text())
    for entity_id, original in SURVEYS.items():
        source = (folder / (original + '.glb')).read_bytes()
        if hashlib.sha256(source).hexdigest() != original:
            raise ValueError(f'Unexpected survey for {entity_id}')
        model, count = bake(source)
        digest = hashlib.sha256(model).hexdigest()
        (ROOT / 'assets' / (digest + '.glb')).write_bytes(model)
        entity = next(e for e in records if e['entityId'] == entity_id)
        entity['assetHash'] = digest
        entity['props']['篷布内衬'] = {'原模型': original, '面数': count, '实拍': PHOTO,
                                      '依据': '将对应外表面的原摄影纹理配准到内衬。日间透光强度按跨湾实拍估算。'}
        print(entity_id, digest, count)
    manifest.write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sources', type=Path, help='Directory of the original two OneMap GLBs, named by SHA-256')
    build(parser.parse_args().sources)
