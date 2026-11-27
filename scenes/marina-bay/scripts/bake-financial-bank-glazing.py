"""Bake height-dependent daylight reflections into the financial district tower shafts."""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path

import numpy as np

from coastal_finishes import Model

ROOT = Path(__file__).resolve().parents[1]
SURVEY = ROOT / 'references/financial-bank-glazing'


def split_shaft(model, primitive, glazing):
    attrs = primitive['attributes']
    if primitive.get('material', 0) != 0 or 'TEXCOORD_0' not in attrs:
        return [primitive]
    vertices = model.read(attrs['POSITION'], 3)
    index = primitive['indices']
    faces = model.read(index, 1).reshape(-1, 3)
    if len(faces) < 128:
        return [primitive]

    points = vertices[faces]
    normals = np.cross(points[:, 1] - points[:, 0], points[:, 2] - points[:, 0])
    area = np.linalg.norm(normals, axis=1)
    heights = points[:, :, 1]
    # The surveyed meshes use a local ground datum. Leave the podium and roof finishes in place.
    height = np.ptp(vertices[:, 1])
    shaft = (np.abs(normals[:, 1]) < .21 * area) & (heights.mean(1) > .22 * height) & (heights.max(1) > .35 * height)
    if not shaft.any():
        return [primitive]

    groups = []
    component = model.doc['accessors'][index]['componentType']
    for selected, material in [(~shaft, primitive.get('material', 0)), (shaft, glazing)]:
        if selected.any():
            indices = model.attribute(faces[selected].ravel(), 'SCALAR', component)
            groups.append({**primitive, 'indices': indices, 'material': material})
    return groups


def bake(row, source_dir):
    source = (source_dir / (row['source'] + '.glb')).read_bytes()
    if hashlib.sha256(source).hexdigest() != row['source']:
        raise ValueError(f"Unexpected source model for {row['label']}")
    model = Model(source)
    view = model.append_view((SURVEY / row['radiance']).read_bytes())
    images = model.doc['images']
    textures = model.doc['textures']
    textures.append({'source': len(images)})
    images.append({'bufferView': view, 'mimeType': 'image/png', 'name': 'Financial district daylight radiance'})

    materials = model.doc['materials']
    if materials[0]['name'] != row['material']:
        raise ValueError(f"Missing source facade material for {row['label']}")
    material = deepcopy(materials[0])
    material['name'] += ' upper glazing'
    material['extras'] = {'reflectionLevels': row['reflectionLevels']}
    material['emissiveTexture'] = {'index': len(textures) - 1}
    material['emissiveFactor'] = [0, 0, 0]
    material['pbrMetallicRoughness'].update(baseColorFactor=row['baseColorFactor'], roughnessFactor=.23, metallicFactor=0)
    glazing = len(materials)
    materials.append(material)
    for mesh in model.doc['meshes']:
        mesh['primitives'] = [part for primitive in mesh['primitives'] for part in split_shaft(model, primitive, glazing)]

    result = model.finish()
    digest = hashlib.sha256(result).hexdigest()
    if digest != row['output']:
        raise ValueError(f"Unexpected rebuilt asset for {row['label']}: {digest}")
    (ROOT / 'assets' / (digest + '.glb')).write_bytes(result)


if __name__ == '__main__':
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('source_dir', type=Path, help='Directory containing the three original, hash-named OneMap GLBs')
    source_dir = args.parse_args().source_dir
    for row in json.loads((SURVEY / 'survey.json').read_text())['models']:
        bake(row, source_dir)
