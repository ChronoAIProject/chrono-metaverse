"""Apply the bridge daylight captures to the packed glass panels."""

import copy
import hashlib
import json
import struct

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components


def panel_normals(vertices, faces, smooth, uv):
    """Average the normals of the two triangles in each laminated pane."""
    first = np.tile(faces[:, 0], 3)
    graph = coo_matrix((np.ones(faces.size), (first, faces.T.ravel())),
                       shape=(len(vertices), len(vertices)))
    _, canopies = connected_components(graph, directed=False)
    centres = uv[faces].mean(axis=1)
    cells = np.minimum((centres * [5, 6]).astype(int), [4, 5])
    groups = canopies[faces[:, 0]] * 30 + cells[:, 1] * 5 + cells[:, 0]
    triangles = vertices[faces].astype(float)
    areas = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    result = np.empty_like(triangles)
    for group in np.unique(groups):
        selected = groups == group
        direction = areas[selected].sum(axis=0)
        direction /= np.linalg.norm(direction)
        normals = smooth[faces[selected]]
        if np.sum(direction * normals) < 0:
            direction *= -1
        blended = .75 * direction + .25 * normals
        result[selected] = blended / np.linalg.norm(blended, axis=2, keepdims=True)
    return result.reshape(-1, 3)


def apply_glazing(asset, references):
    raw = asset.read_bytes()
    length = struct.unpack_from('<I', raw, 12)[0]
    doc = json.loads(raw[20:20 + length])
    binary = bytearray(raw[28 + length:])

    def read(index):
        accessor = doc['accessors'][index]
        view = doc['bufferViews'][accessor['bufferView']]
        dtype = np.dtype({5126: '<f4', 5122: '<i2', 5123: '<u2', 5125: '<u4'}[accessor['componentType']])
        width = {'VEC2': 2, 'VEC3': 3, 'SCALAR': 1}[accessor['type']]
        data = np.ndarray((accessor['count'], width), dtype, buffer=binary,
                          offset=view.get('byteOffset', 0) + accessor.get('byteOffset', 0),
                          strides=(view.get('byteStride', width * dtype.itemsize), dtype.itemsize)).copy()
        if accessor.get('normalized'):
            data = np.maximum(-1, data.astype(float) / np.iinfo(dtype).max)
        return data

    def add_view(data, **options):
        binary.extend(bytes(-len(binary) % 4))
        view = {'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(data), **options}
        doc['bufferViews'].append(view)
        binary.extend(data)
        return len(doc['bufferViews']) - 1

    def attribute(data, kind):
        indices = kind == 'SCALAR'
        array = np.ascontiguousarray(data, dtype='<u2' if indices else '<f4')
        view = add_view(array.tobytes(), target=34963 if indices else 34962)
        accessor = {'bufferView': view, 'componentType': 5123 if indices else 5126,
                    'count': len(array), 'type': kind}
        if kind == 'VEC3':
            accessor.update(min=array.min(axis=0).tolist(), max=array.max(axis=0).tolist())
        doc['accessors'].append(accessor)
        return len(doc['accessors']) - 1

    def texture(filename):
        view = add_view((references / filename).read_bytes())
        doc['images'].append({'bufferView': view, 'mimeType': 'image/png', 'name': filename})
        doc['textures'].append({'source': len(doc['images']) - 1})
        return {'index': len(doc['textures']) - 1}

    slot = next(i for i, mat in enumerate(doc['materials']) if mat['name'] == 'Fritted canopy')
    mesh_index, mesh, source = next((i, mesh, part) for i, mesh in enumerate(doc['meshes'])
                                    for part in mesh['primitives'] if part['material'] == slot)
    node = next(node for node in doc['nodes'] if node.get('mesh') == mesh_index)
    vertices = read(source['attributes']['POSITION'])
    normals = read(source['attributes']['NORMAL'])
    faces = read(source['indices']).reshape(-1, 3)
    uv = read(source['attributes']['TEXCOORD_0'])
    uv = (uv - uv.min(axis=0)) / np.ptp(uv, axis=0)
    attrs = {'POSITION': attribute(vertices[faces].reshape(-1, 3), 'VEC3'),
             'NORMAL': attribute(panel_normals(vertices, faces, normals, uv), 'VEC3'),
             'TEXCOORD_0': attribute(uv[faces].reshape(-1, 2), 'VEC2')}
    base = texture('glass.png')
    surface = texture('roughness-metalness.png')
    meta = json.loads((references / 'capture.json').read_text())
    scale = np.array(node.get('scale', [1, 1, 1]))
    origin = np.array(node.get('translation', [0, 0, 0]))
    z = vertices[faces, 2].mean(axis=1) * scale[2] + origin[2]
    spans = np.digitize(z, meta['boundaries'])
    mesh['primitives'].remove(source)
    indices = np.arange(faces.size).reshape(faces.shape)
    for band, (name, capture) in enumerate(meta['bands'].items()):
        material = copy.deepcopy(doc['materials'][slot])
        material.update(name='Helix laminated canopy ' + name, emissiveFactor=[0, 0, 0],
                        emissiveTexture=texture(name + '.png'),
                        pbrMetallicRoughness={'baseColorTexture': base, 'metallicRoughnessTexture': surface,
                                              'metallicFactor': 1, 'roughnessFactor': 1},
                        extras={'reflectionLevels': {'first': (capture['first'] - origin[1]) / scale[1],
                                                    'last': (capture['last'] - origin[1]) / scale[1],
                                                    'count': 2, 'scale': capture['scale']}})
        target = slot if band == 0 else len(doc['materials'])
        if band == 0:
            doc['materials'][slot] = material
        else:
            doc['materials'].append(material)
        mesh['primitives'].append({'attributes': attrs, 'material': target,
                                   'indices': attribute(indices[spans == band].ravel(), 'SCALAR')})

    binary.extend(bytes(-len(binary) % 4))
    doc['buffers'][0]['byteLength'] = len(binary)
    header = json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode()
    header += b' ' * (-len(header) % 4)
    result = (struct.pack('<4sIII4s', b'glTF', 2, 28 + len(binary) + len(header), len(header), b'JSON')
              + header + struct.pack('<I4s', len(binary), b'BIN\0') + binary)
    digest = hashlib.sha256(result).hexdigest()
    asset.with_name(digest + '.glb').write_bytes(result)
    return digest
