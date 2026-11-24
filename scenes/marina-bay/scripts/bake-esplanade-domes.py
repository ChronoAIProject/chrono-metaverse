"""Refine only the continuous roof shells of the surveyed Esplanade Theatres."""

import argparse
import copy
import io
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import struct

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from esplanade_shades import DESIGN, PHOTOGRAPHS, triangular_plates

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "a854e29e024d0d70c6da691c40ab066183b990566291d0d2e8f44f3d279b50de"
ENTITY = "bay.e9850f77-b4a1-4b67-9b2c-61c38941e442"


def refine(values, indices):
    positions, normals, uv = (values[k] for k in ('POSITION', 'NORMAL', 'TEXCOORD_0'))
    points = positions[indices].astype(float)
    geometric = np.cross(points[:, 1] - points[:, 0], points[:, 2] - points[:, 0])
    geometric /= np.maximum(np.linalg.norm(geometric, axis=1, keepdims=True), 1e-10)
    vertices, ids = np.unique(np.round(positions, 3), axis=0, return_inverse=True)
    topology = ids[indices]
    edges = defaultdict(list)
    for i in np.flatnonzero((points[:, :, 1].mean(axis=1) > 12) & (geometric[:, 1] > .17)):
        for a, b in zip(topology[i], np.roll(topology[i], -1)):
            edges[tuple(sorted((a, b)))].append(i)
    links = [(a,b) for group in edges.values() for a in group for b in group
             if a < b and geometric[a] @ geometric[b] > .81]
    rows, cols = np.array(links).T
    graph = coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(len(points), len(points)))
    _, group = connected_components(graph, directed=False)
    domes = np.argsort(np.bincount(group))[-2:]
    roof = np.isin(group, domes)
    if roof.sum() != 818:
        raise ValueError(f'Unexpected survey shell selection: {roof.sum()}')
    averages = np.zeros_like(vertices, dtype=float)
    for corner in range(3):
        a = points[roof, (corner + 1) % 3] - points[roof, corner]
        b = points[roof, (corner + 2) % 3] - points[roof, corner]
        angle = np.arctan2(np.linalg.norm(np.cross(a,b), axis=1), (a*b).sum(axis=1))
        np.add.at(averages, topology[roof, corner], geometric[roof] * angle[:, None])
    averages /= np.maximum(np.linalg.norm(averages, axis=1, keepdims=True), 1e-10)
    output = [np.column_stack((positions[indices[~roof]].reshape(-1,3),
                               normals[indices[~roof]].reshape(-1,3), uv[indices[~roof]].reshape(-1,2)))]
    for i in np.flatnonzero(roof):
        p = points[i]
        n = averages[topology[i]]
        t = uv[indices[i]]
        centers = []
        for a,b in [(0,1),(1,2),(2,0)]:
            middle = (p[a] + p[b]) / 2
            adjacent = edges[tuple(sorted((topology[i,a], topology[i,b])))]
            # Keep the outer boundary fixed where the measured wall/atrium meets the dome.
            if len(adjacent) == 2 and group[adjacent[0]] == group[adjacent[1]]:
                lift = -.5 * (n[a] * ((middle-p[a]) @ n[a]) + n[b] * ((middle-p[b]) @ n[b]))
                middle += lift * min(.7, .15 / max(1e-9, np.linalg.norm(lift)))
            direction = n[a] + n[b]
            centers.append(np.r_[middle, direction / np.linalg.norm(direction), (t[a]+t[b]) / 2])
        vertices6 = np.vstack((np.column_stack((p,n,t)), centers))
        output.append(vertices6[[0,3,5, 3,1,4, 5,4,2, 3,4,5]])
    packed, inverse = np.unique(np.vstack(output).astype('<f4'), axis=0, return_inverse=True)
    return ({'POSITION': packed[:,:3], 'NORMAL': packed[:,3:6], 'TEXCOORD_0': packed[:,6:]},
            inverse, int(3 * (~roof).sum()), uv[indices[roof]])


def canopy_relief(photo, dome_uv):
    image = Image.open(io.BytesIO(photo)).convert('L')
    mask = Image.new('L', image.size)
    draw = ImageDraw.Draw(mask)
    for triangle in dome_uv * image.size:
        draw.polygon(list(map(tuple, triangle)), fill=255)
    weight = np.asarray(mask, dtype=float) / 255
    gray = np.asarray(image, dtype=float) / 255
    # Within each photographed roof chart use the local shade pattern as a
    # shallow relief cue. Normalized filtering avoids sampling unused atlas space.
    def local(sigma):
        return gaussian_filter(gray * weight, sigma) / np.maximum(.001, gaussian_filter(weight, sigma))
    detail = (local(.7) - local(3.4)) * weight
    dy, dx = np.gradient(detail)
    normals = np.stack((-3.2 * dx, 3.2 * dy, np.ones_like(dx)), axis=-1)
    normals /= np.linalg.norm(normals, axis=-1, keepdims=True)
    output = io.BytesIO()
    Image.fromarray(np.uint8(np.rint((normals * .5 + .5) * 255))).save(
        output, 'JPEG', quality=91, subsampling=0)
    return output.getvalue()


def bake(raw):
    length = struct.unpack_from('<I', raw, 12)[0]
    doc = json.loads(raw[20:20+length])
    binary = raw[28+length:]
    views = [binary[v.get('byteOffset',0):][:v['byteLength']] for v in doc['bufferViews']]

    def read(index):
        a = doc['accessors'][index]
        width = {'SCALAR':1,'VEC3':3,'VEC2':2}[a['type']]
        dt = {5126:'<f4',5125:'<u4',5123:'<u2'}[a['componentType']]
        return np.frombuffer(views[a['bufferView']], dt, count=width*a['count']).reshape(-1,width)

    def write(index, values):
        a = doc['accessors'][index]
        data = np.asarray(values).reshape(len(values), -1)
        a.update(count=len(data), min=data.min(axis=0).tolist(), max=data.max(axis=0).tolist())
        views[a['bufferView']] = data.tobytes()

    def add_accessor(values, kind, component, target):
        data = np.ascontiguousarray(values)
        index = len(doc['accessors'])
        accessor = {'bufferView': len(views), 'componentType': component, 'count': len(data), 'type': kind}
        if kind == 'VEC3':
            accessor.update(min=data.min(axis=0).tolist(), max=data.max(axis=0).tolist())
        doc['accessors'].append(accessor)
        doc['bufferViews'].append({'buffer': 0, 'target': target})
        views.append(data.tobytes())
        return index

    count = 0
    for mesh in doc['meshes']:
        primitive, = mesh['primitives']
        attributes = {k:read(i) for k,i in primitive['attributes'].items()}
        faces = read(primitive['indices']).reshape(-1,3)
        _, ids = np.unique(np.column_stack(list(attributes.values())), axis=0, return_inverse=True)
        _, keep = np.unique(ids[faces], axis=0, return_index=True)
        faces = faces[np.sort(keep)]
        if 'TEXCOORD_0' in attributes:
            attributes, indices, first_roof, dome_uv = refine(attributes, faces)
            pane = copy.deepcopy(primitive)
            index = copy.deepcopy(doc['accessors'][primitive['indices']])
            index['bufferView'] = len(views)
            doc['bufferViews'].append({'buffer':0,'target':34963})
            views.append(b'')
            pane['indices'] = len(doc['accessors'])
            doc['accessors'].append(index)
            write(pane['indices'], indices[first_roof:].astype(faces.dtype))
            count += (indices.size - first_roof) // 3
            plates, panel_counts = triangular_plates(attributes['POSITION'], indices[first_roof:].reshape(-1, 3))
            indices = indices[:first_roof]
            roof = copy.deepcopy(doc['materials'][primitive['material']])
            roof['name'] = 'Esplanade double-glazed roof'
            roof['pbrMetallicRoughness'].update(baseColorFactor=[.098, .142, .128, 1], metallicFactor=.19, roughnessFactor=.29)
            pose = views[doc['images'][0]['bufferView']]
            normal_map = canopy_relief(pose, dome_uv)
            doc['images'].append({'mimeType':'image/jpeg','bufferView':len(views)})
            doc['bufferViews'].append({'buffer':0})
            views.append(normal_map)
            roof['normalTexture'] = {'index':len(doc['textures']), 'scale':.12}
            doc['textures'].append({'source':len(doc['images']) - 1})
            pane['material'] = len(doc['materials'])
            doc['materials'].append(roof)
            mesh['primitives'].append(pane)
            vertices = plates.reshape(-1, 3).astype('<f4')
            normals = np.cross(plates[:, 1] - plates[:, 0], plates[:, 2] - plates[:, 0])
            normals /= np.linalg.norm(normals, axis=1, keepdims=True)
            normal = np.repeat(normals, 3, axis=0).astype('<f4')
            material = len(doc['materials'])
            doc['materials'].append({
                'name': 'Esplanade triangular sunshades', 'doubleSided': True,
                'pbrMetallicRoughness': {'baseColorFactor': [.48, .433, .351, 1],
                                         'metallicFactor': .60, 'roughnessFactor': .47},
            })
            mesh['primitives'].append({
                'attributes': {'POSITION': add_accessor(vertices, 'VEC3', 5126, 34962),
                               'NORMAL': add_accessor(normal, 'VEC3', 5126, 34962)},
                'indices': add_accessor(np.arange(len(vertices), dtype='<u2'), 'SCALAR', 5123, 34963),
                'material': material, 'mode': 4,
            })
            doc['asset'].setdefault('extras', {})['sunshades'] = {
                'design': DESIGN, 'photoReferences': PHOTOGRAPHS, 'panelsPerDome': panel_counts,
                'fit': 'Panel spacing, lift and coating estimated over the surveyed glass shells.',
            }
            count += len(plates)
        else:
            compact, indices = np.unique(faces, return_inverse=True)
            attributes = {k:v[compact] for k,v in attributes.items()}
        for key, values in attributes.items():
            write(primitive['attributes'][key], values)
        write(primitive['indices'], indices.ravel().astype(faces.dtype))
        count += indices.size // 3
    buf = bytearray()
    for view, data in zip(doc['bufferViews'],views):
        view.update(byteOffset=len(buf),byteLength=len(data))
        buf.extend(data)
        buf.extend(b'\0' * (-len(buf)%4))
    doc['buffers'][0]['byteLength'] = len(buf)
    header = json.dumps(doc,separators=(',',':')).encode()
    header += b' ' * (-len(header)%4)
    return (struct.pack('<4sIII4s',b'glTF',2,28+len(header)+len(buf),len(header),b'JSON') +
            header + struct.pack('<I4s',len(buf),b'BIN\0') + buf), count, panel_counts


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    raw = parser.parse_args().source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE:
        raise ValueError('Expected the original Esplanade Theatres survey')
    result, count, panel_counts = bake(raw)
    digest = hashlib.sha256(result).hexdigest()
    (ROOT/'assets'/(digest+'.glb')).write_bytes(result)
    path = ROOT/'build/onemap-entities.json'
    records = json.loads(path.read_text())
    e = next(e for e in records if e['entityId'] == ENTITY)
    e['assetHash'] = digest
    e['props']['穹顶遮阳片'] = {
        '每顶片数': panel_counts, '设计资料': DESIGN, '实拍参考': PHOTOGRAPHS,
        '说明': '沿两座测绘穹顶的截面布置三角铝板。板件间距、抬高量及涂层依据照片估读。',
    }
    e['props'].update({'原建筑资源':SOURCE,'三角形数':count,
        '穹顶曲面':'按相邻测绘面的边与夹角分出两组穹顶。保留原顶点、轮廓连接边及遮阳片影像。内部边中点的切平面插值位移上限 0.15 米。玻璃壳保留原图的浅表法线，外层铝板单独受光。'})
    path.write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
    print(digest,len(result),count)
