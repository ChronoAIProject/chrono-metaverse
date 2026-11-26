"""Build paired roof slopes and plaster gables over the surveyed low-rise blocks."""
import hashlib
import json
import sys
from collections import defaultdict

import numpy as np
import trimesh
from PIL import Image
from shapely import constrained_delaunay_triangles
from shapely.geometry import Polygon, box
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from context_geometry import geographic_point
from scanned_canopy import ROOT, write_tree_asset

sys.path.insert(0, str(ROOT.parents[1] / 'recon/src'))
from metaverse_recon.context.convert import frame

SCANS = ROOT / 'references/coastal-finishes'
CREDIT = ('Footprints © OpenStreetMap contributors (ODbL 1.0), via OpenFreeMap. '
          'Roof survey © Singapore Land Authority / OneMap. Clay and plaster scans by Amal Kumar, Poly Haven (CC0).')


def add_section(building, section, project, phase, spans, batches):
    # Work in metres along the ridge and down each slope. The original roof stays under the eaves.
    ridge = np.array([project(p) for p in section['ridge']])
    ring = np.array([project(p) for p in section['ring']])
    origin = ridge[0, [0, 2]]
    along = ridge[1, [0, 2]] - origin
    along /= np.linalg.norm(along)
    axes = np.stack([along, [-along[1], along[0]]])
    plan = Polygon((ring[:, [0, 2]] - origin) @ axes.T)
    u0, v0, u1, v1 = plan.bounds
    rise = np.clip((v1 - v0) * .235, .9, 3.8)
    # Follow the map datum at each end. A shallow fascia closes the join with the streamed cap.
    eave = ring[:, 1].mean() + building['eaveMetres']
    family = building['tile']
    clay = np.array(building['colour'], float)
    plaster = .28 * clay + .72 * np.array([192, 183, 166])
    for sign, reach in [(-1, -v0), (1, v1)]:
        clip = box(u0 - 1, v0 - 1, u1 + 1, 0) if sign < 0 else box(u0 - 1, 0, u1 + 1, v1 + 1)
        slope = plan.intersection(clip)

        def xyz(uv, height):
            x, z = origin + uv @ axes
            return [x, eave + height, z]

        def top(v):
            return .12 + rise * max(0., 1 - abs(v) / reach)

        def add_face(points, uv, material, tint, outward):
            points = np.asarray(points)
            normal = np.cross(points[1] - points[0], points[2] - points[0])
            if np.linalg.norm(normal) < 1e-7:
                return
            tri = [0, 1, 2] if normal @ outward >= 0 else [0, 2, 1]
            batches[material].append((points[tri], (np.asarray(uv)[tri] + phase) / spans[material],
                                      np.tile(tint, (3, 1))))

        for face in constrained_delaunay_triangles(slope).geoms:
            coords = np.array(face.exterior.coords[:3])
            uv = coords * [1, -sign * np.hypot(1, rise / reach)]
            add_face([xyz(p, top(p[1])) for p in coords], uv, family, clay, [0, 1, 0])
        boundary = np.array(slope.exterior.coords)
        winding = 1 if slope.exterior.is_ccw else -1
        for a, b in zip(boundary, boundary[1:]):
            if max(abs(a[1]), abs(b[1])) < 1e-5:
                continue
            du, dv = b - a
            nx, nz = winding * np.array([dv, -du]) @ axes
            length = np.linalg.norm(b - a)
            points = np.array([xyz(a, -.05), xyz(b, -.05), xyz(b, top(b[1])), xyz(a, top(a[1]))])
            uv = np.column_stack(([0, length, length, 0], points[:, 1] - eave))
            for tri in ([0, 1, 2], [0, 2, 3]):
                add_face(points[tri], uv[tri], 'render', plaster, [nx, 0, nz])


def bake():
    survey = json.loads((ROOT / 'references/beach-road-terraces.json').read_text())
    config = json.loads((ROOT / 'context.json').read_text())['oneMap']
    origin, rotation = frame(config)
    shift = np.array(json.loads((ROOT / 'build/alignment.json').read_text())['shift'])
    datum = json.loads((ROOT / 'build/environment.json').read_text())['props']['environment']['map']['origin'][1]

    def project(point):
        pos = geographic_point(*point, origin, rotation, shift)
        pos[1] += datum + config['officeHeightMeters'] - shift[1]
        return pos

    spans = {k: v['span'] for k, v in json.loads((SCANS / 'scans.json').read_text()).items()}
    batches = defaultdict(list)
    for building in survey['buildings']:
        seed = hashlib.sha256(building['originKey'].encode()).digest()
        phase = np.array([seed[0], seed[1]]) / 23.
        for section in building['sections']:
            add_section(building, section, project, phase, spans, batches)

    scene = trimesh.Scene()
    for family, triangles in sorted(batches.items()):
        colour = Image.open(SCANS / f'{family}-colour.jpg')
        material = PBRMaterial(name=family, baseColorTexture=colour,
                               normalTexture=Image.open(SCANS / f'{family}-normal.jpg'),
                               metallicRoughnessTexture=Image.open(SCANS / f'{family}-surface.png'),
                               metallicFactor=0., roughnessFactor=1.)
        points, uv, tint = [np.concatenate(items) for items in zip(*triangles)]
        # GLTF vertex colours are linear multipliers of the sRGB colour map.
        median = np.median(np.asarray(colour), axis=(0, 1))
        linear_gain = ((tint + 14.025) / (median + 14.025)) ** 2.4
        visual = TextureVisuals(uv=uv, material=material)
        visual.vertex_attributes['color'] = np.rint(255 * np.column_stack(
            [linear_gain.clip(0, 1), np.ones(len(points))])).astype(np.uint8)
        mesh = trimesh.Trimesh(vertices=points, faces=np.arange(len(points)).reshape(-1, 3),
                               visual=visual, process=False)
        scene.add_geometry(mesh, geom_name=family)
    digest, bounds = write_tree_asset(scene, copyright=CREDIT)
    return dict(entityId='bay.beach-road-terrace-roofs', label='美芝路 · 店屋陶瓦坡顶',
                kind='structure', layer='ext', regionId='marina-bay-exterior', assetHash=digest,
                bounds=bounds, material={'shading': 'albedo'}, props={'background': True, '版权': CREDIT,
                '依据': '按普通地图建筑轮廓与 OneMap 航片可辨认的陶瓦区间重建，坡高、瓦型和遮挡处的屋脊为估计。'})


if __name__ == '__main__':
    entity = bake()
    path = ROOT / 'build/streetscape.json'
    rows = {r['entityId']: r for r in json.loads(path.read_text())}
    rows[entity['entityId']] = entity
    path.write_text(json.dumps(list(rows.values()), ensure_ascii=False, indent=2) + '\n')
    print(entity['assetHash'])
