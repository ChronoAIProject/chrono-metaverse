"""Build paired roof slopes and plaster gables over the surveyed low-rise blocks."""
import hashlib
import json
import sys
from collections import defaultdict

import numpy as np
import trimesh
from PIL import Image, ImageEnhance
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
          'Roof survey and 3D measurements © Singapore Land Authority / OneMap. Clay and plaster scans by Amal Kumar, Poly Haven (CC0). '
          'Adapted photo textures: Shophouses on Boat Quay, Singapore (2023)-L1003691 by Frank Schulenburg and '
          'Boat Quay in Singapore (Cropped) by Chensiyuan (CC BY-SA 4.0), SG-riverside-boat-quay by Balou46 '
          '(CC BY-SA 3.0). Adapted textures and model: https://creativecommons.org/licenses/by-sa/4.0/.')


def window_atlas():
    # Rectified upper-floor photographs. Crop above the next shopfront and its signs.
    source = Image.open(ROOT / 'references/boat-quay-surfaces.jpg').convert('RGB')
    sheet = Image.new('RGB', (1024, 128))
    for index, (left, top, right, bottom) in enumerate([
        (10, 1027, 243, 1205), (259, 1028, 505, 1200),
        (517, 1029, 762, 1199), (775, 1030, 1011, 1146),
    ]):
        panel = source.crop((left, top, right, bottom)).resize((256, 128), Image.Resampling.LANCZOS)
        sheet.paste(ImageEnhance.Color(panel).enhance(.56), (256 * index, 0))
    return sheet


def upper_walls(plan, axes, origin, floor, eave, plaster, phase, panel, spans, batches):
    height = eave - floor
    levels = np.linspace(floor - .05, eave, max(1, round(height / 3.5)) + 1)
    boundary = np.asarray(plan.exterior.coords)
    winding = 1 if plan.exterior.is_ccw else -1
    for a, b in zip(boundary, boundary[1:]):
        du, dv = b - a
        length = np.linalg.norm(b - a)
        if length < .02:
            continue
        edge = np.array([a, b, b, a]) @ axes + origin
        outward = winding * np.array([dv, -du]) @ axes
        # End walls parallel to the ridge face the street or the rear court.
        windows = abs(du) > .85 * length and length > 2.8 and height >= 1.95
        for lo, hi in zip(levels, levels[1:]):
            points = np.column_stack((edge[:, 0], [lo, lo, hi, hi], edge[:, 1]))
            if windows:
                material = 'windows'
                uv = np.array([[(panel + u) / 4, v] for u, v in
                               [(.012, .018), (.988, .018), (.988, .982), (.012, .982)]])
                tint = .62 * plaster + .38 * 245
            else:
                material = 'render'
                uv = (np.array([[0, lo], [length, lo], [length, hi], [0, hi]]) + phase) / spans[material]
                tint = plaster
            normal = np.cross(points[1] - points[0], points[2] - points[0])
            for tri in [[0, 1, 2], [0, 2, 3]]:
                if normal[[0, 2]] @ outward < 0:
                    tri = tri[::-1]
                batches[material].append((points[tri], uv[tri], np.tile(tint, (3, 1))))


def add_section(building, section, project, phase, panel, spans, batches):
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
    floor = ring[:, 1].mean() + building['eaveMetres']
    eave = floor
    family = building['tile']
    clay = np.array(building['colour'], float)
    plaster = .28 * clay + .72 * np.array([192, 183, 166])
    if profile := section.get('heightProfile'):
        eave = ring[:, 1].mean() + profile['eaveMetres']
        rise = profile['ridgeMetres'] - profile['eaveMetres']
        upper_walls(plan, axes, origin, floor, eave, plaster, phase, panel, spans, batches)
    for sign, reach in [(-1, -v0), (1, v1)]:
        clip = box(u0 - 1, v0 - 1, u1 + 1, 0) if sign < 0 else box(u0 - 1, 0, u1 + 1, v1 + 1)
        slope = plan.intersection(clip)

        def xyz(uv, height):
            x, z = origin + uv @ axes
            return [x, eave + height, z]

        def top(v):
            fascia = .12
            peak = rise - fascia if profile else rise
            return fascia + peak * max(0., 1 - abs(v) / reach)

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
            add_section(building, section, project, phase, seed[2] % 4, spans, batches)

    scene = trimesh.Scene()
    for family, triangles in sorted(batches.items()):
        if family == 'windows':
            colour = window_atlas()
            material = PBRMaterial(name='Upper-storey windows and plaster surrounds',
                                   baseColorTexture=colour, metallicFactor=0., roughnessFactor=.86)
            reference_colour = np.full(3, 255.)
        else:
            colour = Image.open(SCANS / f'{family}-colour.jpg')
            material = PBRMaterial(name=family, baseColorTexture=colour,
                                   normalTexture=Image.open(SCANS / f'{family}-normal.jpg'),
                                   metallicRoughnessTexture=Image.open(SCANS / f'{family}-surface.png'),
                                   metallicFactor=0., roughnessFactor=1.)
            reference_colour = np.median(np.asarray(colour), axis=(0, 1))
        points, uv, tint = [np.concatenate(items) for items in zip(*triangles)]
        # GLTF vertex colours are linear multipliers of the sRGB colour map.
        linear_gain = ((tint + 14.025) / (reference_colour + 14.025)) ** 2.4
        visual = TextureVisuals(uv=uv, material=material)
        visual.vertex_attributes['color'] = np.rint(255 * np.column_stack(
            [linear_gain.clip(0, 1), np.ones(len(points))])).astype(np.uint8)
        mesh = trimesh.Trimesh(vertices=points, faces=np.arange(len(points)).reshape(-1, 3),
                               visual=visual, process=False)
        scene.add_geometry(mesh, geom_name=family)
    digest, bounds = write_tree_asset(scene, copyright=CREDIT)
    return dict(entityId='bay.beach-road-terrace-roofs', label='美芝路 · 店屋上层与陶瓦坡顶',
                kind='structure', layer='ext', regionId='marina-bay-exterior', assetHash=digest,
                bounds=bounds, material={'shading': 'albedo'}, props={'background': True, '版权': CREDIT,
                '依据': '按建筑轮廓和 OneMap 航片重建陶瓦屋面。27 栋采用 OneMap 测绘模型估算檐高和脊高，其余采用估计坡高。窗面借用驳船码头同类店屋实拍，分户配色和楼层划分为近似。'})


if __name__ == '__main__':
    entity = bake()
    path = ROOT / 'build/streetscape.json'
    rows = {r['entityId']: r for r in json.loads(path.read_text())}
    rows[entity['entityId']] = entity
    path.write_text(json.dumps(list(rows.values()), ensure_ascii=False, indent=2) + '\n')
    print(entity['assetHash'])
