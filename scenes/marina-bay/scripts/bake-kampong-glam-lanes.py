"""Reconstruct mapped concrete lanes and stone footways at normal walking scale."""
from importlib import import_module
import json

import numpy as np
import trimesh
from PIL import Image
from scipy.spatial import cKDTree
from shapely import distance as edge_distance, get_parts, points
from shapely.geometry import GeometryCollection, Polygon, box
from trimesh.visual.material import PBRMaterial

from ground_materials import scanned_pavers
from scanned_canopy import ROOT, write_tree_asset

road = import_module('bake-fullerton-road')
REFERENCE = ROOT / 'references/kampong-glam-lanes'
CREDIT = ('Paths © OpenStreetMap contributors (ODbL). Aerial interpretation © Singapore Land Authority / OneMap. '
          'Concrete Floor 02 and Granite Tile 04 by Poly Haven (CC0).')


def bake():
    survey = json.loads((REFERENCE / 'survey.json').read_text())
    config = json.loads((ROOT / 'context.json').read_text())['oneMap']
    origin, rotation = road.frame(config)
    shift = np.array(json.loads((ROOT / 'build/alignment.json').read_text())['shift'])
    datum = json.loads((ROOT / 'build/environment.json').read_text())['props']['environment']['map']['origin'][1]

    def project(point):
        return road.geographic_point(*point, origin, rotation, shift)[[0, 2]]

    concrete = PBRMaterial(name='Cast concrete lanes', baseColorTexture=Image.open(REFERENCE / 'concrete-colour.jpg'),
                           normalTexture=Image.open(REFERENCE / 'concrete-normal.jpg'),
                           metallicRoughnessTexture=Image.open(REFERENCE / 'concrete-roughness.jpg'),
                           roughnessFactor=1., metallicFactor=0.)
    stone = scanned_pavers('Bussorah paving stones', [160, 146, 131], [.30, .16])
    scene = trimesh.Scene()
    for family, material, span in [('concrete', concrete, [2., 2.]), ('paving_stones', stone, [1.2, .96])]:
        material.alphaMode = 'BLEND'
        samples = np.array(survey['samples'][family])
        nearest = cKDTree([project(row[:2]) for row in samples])
        tones = samples[:, 2:]
        group = []
        for area in survey['areas']:
            if area['material'] != family:
                continue
            outline = Polygon([project(p) for p in area['ring']], [[project(p) for p in h] for h in area['holes']])
            # Four-metre cells carry the broad colour observed along the pavement.
            # Clip before triangulation so the same mesh follows both curving lane edges.
            x0, z0, x1, z1 = outline.bounds
            # Preserve the underlying aerial at the surveyed edge and where a lane meets another street.
            inner = outline.buffer(-.70)
            half = outline.buffer(-.30)
            bands = [outline.difference(half), half.difference(inner), inner]
            cells = []
            for x in np.arange(np.floor(x0/4)*4, x1, 4):
                for z in np.arange(np.floor(z0/4)*4, z1, 4):
                    cell = box(x, z, x+4, z+4)
                    cells.extend(p for band in bands for p in get_parts(band.intersection(cell))
                                 if p.geom_type == 'Polygon' and p.area > .0001)
            mesh = road.surface(GeometryCollection(cells), material, datum, shift[[0, 2]], height=.065)
            xz = mesh.vertices[:, [0, 2]]
            corners = np.array(outline.minimum_rotated_rectangle.exterior.coords)
            sides = np.diff(corners, axis=0)
            along = sides[np.linalg.norm(sides, axis=1).argmax()]
            along /= np.linalg.norm(along)
            mesh.visual.uv = (xz - corners[0]) @ np.stack([along, [-along[1], along[0]]]).T / span
            distance, indices = nearest.query(xz, k=4)
            weights = 1 / np.maximum(.8, distance)**2
            local = np.sum(tones[indices] * weights[:, :, None], axis=1) / weights.sum(1)[:, None]
            gains = np.clip((local / [178, 178, 175]) ** 1.8, .03, .85)
            margin = np.clip(edge_distance(points(xz), outline.boundary) / .70, 0., 1.)
            alpha = .77 * margin ** 2 * (3. - 2. * margin)
            mesh.visual.vertex_attributes['color'] = np.rint(255*np.column_stack([gains, alpha])).astype(np.uint8)
            group.append(mesh)
        # trimesh concatenation can discard supplemental per-vertex attributes.
        merged = trimesh.util.concatenate(group)
        merged.visual.vertex_attributes['color'] = np.concatenate([m.visual.vertex_attributes['color'] for m in group])
        scene.add_geometry(merged, geom_name=family)
    digest, bounds = write_tree_asset(scene, copyright=CREDIT)
    return dict(entityId='bay.kampong-glam-lanes', kind='structure', layer='ext', regionId='marina-bay-exterior',
                assetHash=digest, bounds=bounds, label='甘榜格南 · 店屋巷道与石铺步道', material={'shading':'albedo'},
                props={'background':True, 'surfaceRole':'landscape', '版权':CREDIT,
                       '依据':'路面类型来自 OSM，道路宽度和材质冷暖按 OneMap 航片估计。'})


if __name__ == '__main__':
    item = bake()
    path = ROOT / 'build/streetscape.json'
    rows = {r['entityId']: r for r in json.loads(path.read_text())}
    rows[item['entityId']] = item
    path.write_text(json.dumps(list(rows.values()), ensure_ascii=False, indent=2) + '\n')
    print(item['assetHash'])
