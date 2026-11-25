"""Bake directional fill on the ArtScience Museum shell. Requires embreex 4.4.0.post1."""

import argparse
import hashlib
import json
import struct
from pathlib import Path

import numpy as np
from embreex.mesh_construction import TriangleMesh
from embreex.rtcore_scene import EmbreeScene
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "6cc5dca48719e2d4a9dd7b3f5b4dd69c7567abd1bb1f8d7e5088ad748d3820f1"
MATERIAL = "ArtScience Museum fibre-reinforced cladding"


def incident_light(scene, positions, normals, directions):
    """Integrate the visible sky and a weak bounce from the water, paving and adjacent petals."""
    energy = np.zeros(len(positions))
    openness = np.zeros(len(positions))
    for start in range(0, len(positions), 128):
        batch = slice(start, start + 128)
        pos, normal = positions[batch], normals[batch]
        cosines = np.maximum(0, normal @ directions.T)
        samples, angles = np.where(cosines > .001)
        origins = (pos + .09 * normal)[samples]
        rays = directions[angles]
        clear = scene.run(np.ascontiguousarray(origins, 'f4'), rays) < 0
        weight = cosines[samples, angles]
        sky = .55 + .45 * np.maximum(0, rays[:, 1])
        incoming = np.where(clear, np.where(rays[:, 1] > 0, sky, .18), .23)
        total = np.bincount(samples, weights=weight, minlength=len(pos))
        energy[batch] = np.bincount(samples, weights=weight * incoming, minlength=len(pos)) / total
        openness[batch] = np.bincount(samples, weights=weight * clear, minlength=len(pos)) / total
    return energy, openness


def shell_exposure(scene, positions, normals, old_uv, strength):
    # Sample both sides of coincident survey sheets. Use the side with more
    # unblocked directions, irrespective of the winding at a texture seam.
    _, first, inverse = np.unique(np.round(np.column_stack((positions, normals)), 4), axis=0,
                                  return_index=True, return_inverse=True)
    pos, normal = positions[first], normals[first]
    normal = normal / np.maximum(1e-7, np.linalg.norm(normal, axis=1)[:, None])
    index = np.arange(384) + .5
    y = 1 - 2 * index / len(index)
    radius = np.sqrt(1 - y*y)
    azimuth = index * np.pi * (3 - np.sqrt(5))
    directions = np.column_stack((radius*np.cos(azimuth), y, radius*np.sin(azimuth))).astype('f4')
    front, front_open = incident_light(scene, pos, normal, directions)
    back, back_open = incident_light(scene, pos, -normal, directions)
    outside = front_open >= back_open - .00001
    incident = np.where(outside, front, back)
    outward = normal * np.where(outside, 1., -1.)[:, None]
    # Pool estimates along the curved sheet, preserving the normals of the adjoining folds.
    features = np.column_stack((pos, outward * 9))
    distances, neighbors = cKDTree(features).query(features, k=14)
    weights = np.exp(-(distances / 2.)**2)
    incident = (weights * incident[neighbors]).sum(1) / weights.sum(1)
    original = 1 - strength * (1 - old_uv[first, 0])
    # Two registered day views constrain the underside. Full directional attenuation
    # makes it more than a stop darker than either photographed lower surface.
    value = .80 * original + .20 * np.clip(incident / .69, .27, 1)
    return np.column_stack(((value[inverse.reshape(-1)] * 255 + .5) / 256,
                            np.full(len(positions), .5))).astype('<f4')


def bake(raw):
    if hashlib.sha256(raw).hexdigest() != SOURCE:
        raise ValueError("Expected the curved museum shell with registered lower glazing")
    length = struct.unpack_from('<I', raw, 12)[0]
    doc = json.loads(raw[20:20 + length])
    binary = bytearray(raw[28 + length:])

    def array(index):
        accessor = doc['accessors'][index]
        view = doc['bufferViews'][accessor['bufferView']]
        dtype = np.dtype({5126: '<f4', 5123: '<u2', 5125: '<u4'}[accessor['componentType']])
        width = {'VEC3': 3, 'VEC2': 2, 'SCALAR': 1}[accessor['type']]
        offset = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
        stride = view.get('byteStride', width * dtype.itemsize)
        return np.ndarray((accessor['count'], width), dtype, buffer=binary, offset=offset,
                          strides=(stride, dtype.itemsize))

    triangles = []
    parts = [part for mesh in doc['meshes'] for part in mesh['primitives']]
    for part in parts:
        vertices = array(part['attributes']['POSITION'])
        triangles.append(vertices[array(part['indices']).reshape(-1, 3)])
    scene = EmbreeScene()
    geometry = TriangleMesh(scene, np.ascontiguousarray(np.concatenate(triangles), 'f4'))
    material_index = next(i for i, m in enumerate(doc['materials']) if m.get('name') == MATERIAL)
    material = doc['materials'][material_index]
    attributes = next(p['attributes'] for p in parts if p.get('material') == material_index)
    uv = array(attributes['TEXCOORD_1'])
    uv[:] = shell_exposure(scene, array(attributes['POSITION']), array(attributes['NORMAL']),
                           uv, material['occlusionTexture']['strength'])
    del geometry
    accessor = doc['accessors'][attributes['TEXCOORD_1']]
    for key, reduce in [('min', np.min), ('max', np.max)]:
        if key in accessor:
            accessor[key] = reduce(uv, axis=0).tolist()
    material['pbrMetallicRoughness']['baseColorFactor'] = [.74, .77, .64, 1]
    material['occlusionTexture']['strength'] = 1
    header = json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode()
    header += b' ' * (-len(header) % 4)
    return (struct.pack('<4sIII4s', b'glTF', 2, 28 + len(header) + len(binary), len(header), b'JSON')
            + header + struct.pack('<I4s', len(binary), b'BIN\0') + binary)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', type=Path, default=ROOT / 'assets')
    assets = parser.parse_args().assets
    result = bake((assets / (SOURCE + '.glb')).read_bytes())
    digest = hashlib.sha256(result).hexdigest()
    (assets / (digest + '.glb')).write_bytes(result)
    print(digest)
