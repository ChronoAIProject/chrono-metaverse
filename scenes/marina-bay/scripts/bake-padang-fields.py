"""Reconstruct both Padang playing surfaces between the club courts and centre path."""
import json
import sys

import numpy as np
import trimesh
from scipy.spatial.distance import cdist
from trimesh.visual.texture import TextureVisuals

from context_geometry import geographic_point
from ground_materials import scanned_pavers, scanned_turf, turf_wear
from scanned_canopy import ROOT, write_tree_asset

sys.path.insert(0, str(ROOT.parents[1] / 'recon/src'))
from metaverse_recon.context.convert import frame


def field_geometry(field, project, datum):
    corners = np.array([project(p) for p in field['corners']])
    across, along = corners[1] - corners[0], corners[3] - corners[0]
    # Resolve the narrow wicket strips while keeping both fields in one draw.
    spacing = 2.1 if field.get('wickets') else 3.4
    cols = 1 + int(np.ceil(np.linalg.norm(across) / spacing))
    rows = 1 + int(np.ceil(np.linalg.norm(along) / spacing))
    u, v = np.meshgrid(np.linspace(0, 1, cols), np.linspace(0, 1, rows))
    u, v = u.reshape(-1, 1), v.reshape(-1, 1)
    xyz = (1-v)*((1-u)*corners[0]+u*corners[1]) + v*((1-u)*corners[3]+u*corners[2])
    # Each corner is projected onto WGS84. The bilinear chord sags less than 1 mm.
    xyz[:, 1] += datum
    xz = xyz[:, [0, 2]]
    wide, long = across[[0, 2]], along[[0, 2]]
    axis = np.stack((wide/np.linalg.norm(wide), long/np.linalg.norm(long)))
    metres = (xz - corners[0, [0, 2]]) @ axis.T
    samples = np.array(field['grassSamples'])
    sites = np.array([project(p)[[0, 2]] for p in samples[:, :2]])
    weights = 1 / (cdist(xz, sites)**2 + 36)
    survey = weights @ samples[:, 2:] / weights.sum(axis=1, keepdims=True)
    across_m, along_m = metres.T
    bands = 1 + .024*np.sin(along_m*2*np.pi/9.8) + .012*np.cos(across_m*.14 + along_m*.08)
    # Smooth, irregular turf wear operates at player scale and remains visible from the gallery.
    rng = np.random.default_rng(21587770)
    variation = np.zeros(len(xz))
    for scale, amplitude in [(18, .052), (7, .038), (3, .022)]:
        grid = (metres - metres.min(axis=0)) / scale
        cell = np.floor(grid).astype(int)
        fade = grid - cell
        fade *= fade * (3 - 2*fade)
        noise = rng.uniform(-1, 1, tuple(cell.max(axis=0) + 2))
        left, top = cell.T
        fx, fy = fade.T
        variation += amplitude * ((1-fy)*((1-fx)*noise[left,top]+fx*noise[left+1,top])
                                  + fy*((1-fx)*noise[left,top+1]+fx*noise[left+1,top+1]))
    grass = survey * [.58, .66, .46] * bands[:, None]
    grass *= 1 + variation[:, None]*[1.8, 1., .5]
    for start, end in field.get('wickets', []):
        a, b = (project(p)[[0, 2]] for p in (start, end))
        direction = (b-a) / np.linalg.norm(b-a)
        # The square has two worn lanes. Feather their edges back into the outfield.
        relative = xz - (a+b)/2
        long_edge = np.abs(relative @ direction) - np.linalg.norm(b-a)/2
        side_edge = np.abs(relative @ [-direction[1], direction[0]]) - 1.7
        wear = np.clip(1 - np.maximum(long_edge, side_edge) / 2.5, 0, 1)[:, None]
        grass += wear * ([119, 104, 67] - grass) * .83
    # The shared scan carries the blades. glTF vertex colors multiply it in linear light.
    linear = lambda rgb: ((np.asarray(rgb)/255 + .055)/1.055)**2.4
    tint = np.clip(linear(grass) / linear(SCAN_RGB) * turf_wear(xz), 0, 1)
    idx = np.arange(rows*cols).reshape(rows, cols)
    a, b, c, d = (q.ravel() for q in (idx[:-1, :-1], idx[:-1, 1:], idx[1:, 1:], idx[1:, :-1]))
    faces = np.vstack((np.column_stack((a,b,c)), np.column_stack((a,c,d))))
    return xyz, faces, metres / 1.4, tint


def marking_geometry(pixels, project, datum, width):
    centre = np.array([project(p) for p in pixels])
    # Each short ribbon follows the ground and shares the turf material and draw call.
    segments = np.diff(centre, axis=0)
    side = segments[:, [2, 1, 0]].copy()
    side[:, 1] = 0
    side[:, 2] *= -1
    side *= (width / 2 / np.linalg.norm(side, axis=1))[:, None]
    points = np.stack((centre[:-1]+side, centre[1:]+side, centre[1:]-side, centre[:-1]-side), axis=1).reshape(-1, 3)
    points[:, 1] += datum + .011
    faces = (4*np.arange(len(side))[:,None,None] + np.array([[[0,1,2],[0,2,3]]])).reshape(-1,3)
    return points, faces, points[:, [0, 2]]/1.4, np.tile([.82,.79,.77], (len(points),1))


SCAN_RGB = [130, 130, 88]


def bake():
    ref = json.loads((ROOT/'references/padang-playing-fields.json').read_text())
    config = json.loads((ROOT/'context.json').read_text())['oneMap']
    origin, rotation = frame(config)
    shift = np.array(json.loads((ROOT/'build/alignment.json').read_text())['shift'])
    pixels = np.array(ref['tilePixelOrigin'])
    def project(point):
        x, y = (pixels + point) / (256 * 2**ref['zoom'])
        return geographic_point(x*360-180, np.degrees(np.arctan(np.sinh(np.pi*(1-2*y)))),
                                origin, rotation, shift)
    environment = json.loads((ROOT/'build/environment.json').read_text())['props']['environment']
    # The field lies between the streamed ground and the tree-contact decals 18 cm above it.
    datum = environment['map']['origin'][1] + config['officeHeightMeters'] - shift[1] + .07
    vertices, faces, uv, colors = [], [], [], []
    offset = 0
    surfaces = []
    for field in ref['fields']:
        surfaces.append(field_geometry(field, project, datum))
        if 'pitchCorners' in field:
            pitch = np.array(field['pitchCorners'])
            ring = field['boundaryRing']
            angles = np.linspace(0, 2*np.pi, 121)
            circle = ring['centre'] + np.stack((np.cos(angles), np.sin(angles)), axis=1)*ring['radii']
            for line in [pitch[[0,1,2,3,0]], circle]:
                surfaces.append(marking_geometry(line, project, datum, .14))
    for points, indices, texcoords, tint in surfaces:
        vertices.append(points)
        faces.append(indices + offset)
        uv.append(texcoords)
        colors.append(tint)
        offset += len(points)
    mat = scanned_turf('Padang playing turf', SCAN_RGB, minimum_roughness=252)
    mesh = trimesh.Trimesh(vertices=np.vstack(vertices), faces=np.vstack(faces), process=False,
                           visual=TextureVisuals(uv=np.vstack(uv), material=mat))
    down = mesh.face_normals[:, 1] < 0
    mesh.faces[down] = mesh.faces[down, ::-1]
    mesh.vertex_normals = np.tile([0., 1., 0.], (offset, 1))
    mesh.visual.vertex_attributes['color'] = np.uint8(np.round(
        np.column_stack((np.vstack(colors), np.ones(offset))) * 255))
    scene = trimesh.Scene(mesh)
    north, south = [field['corners'] for field in ref['fields']]
    path = np.array([project(p) for p in [north[3], north[2], south[1], south[0]]])
    path[:, 1] += datum
    tangent = path[1]-path[0]
    tangent /= np.linalg.norm(tangent)
    side = np.array([tangent[2], 0, -tangent[0]])
    # A small crown meets both verges and descends at the two path entrances.
    u, v = np.meshgrid([0, .006, .994, 1], [0, .075, .925, 1])
    u, v = u.reshape(-1,1), v.reshape(-1,1)
    paving = (1-v)*((1-u)*path[0]+u*path[1]) + v*((1-u)*path[3]+u*path[2])
    paving[:, 1] += np.where((u*v*(1-u)*(1-v)).ravel()>0, .16, .002)
    cells = np.arange(16).reshape(4,4)[:-1, :-1].ravel()
    indices = (cells[:, None, None] + np.array([[[0,1,5],[0,5,4]]])).reshape(-1, 3)
    walkway = trimesh.Trimesh(vertices=paving, faces=indices, process=False,
                              visual=TextureVisuals(uv=(paving-path[0]) @ np.stack((tangent/1.8, side/1.8)).T,
                                                    material=scanned_pavers('Padang crossing', [118,113,101], [.45,.30])))
    down = walkway.face_normals[:, 1] < 0
    walkway.faces[down] = walkway.faces[down, ::-1]
    walkway.vertex_normals = np.tile([0., 1., 0.], (len(paving), 1))
    scene.add_geometry(walkway)
    digest, bounds = write_tree_asset(scene, copyright='ambientCG Grass 004 and Poly Haven Granite Tile 04 (CC0).')
    return dict(entityId='bay.padang-playing-fields', kind='structure', layer='ext',
                regionId='marina-bay-exterior', label='政府大厦前大草场 · 南北球场',
                assetHash=digest, bounds=bounds, material={'shading':'albedo'},
                props={'background': True, 'surfaceRole':'landscape', '边界依据':ref['ortho'],
                       '地图来源':'© OpenStreetMap contributors · ODbL', '参考场地':ref['mapWay'],
                       '材质素材':'ambientCG Grass 004、Poly Haven Granite Tile 04 · CC0', '现场照片':ref['photographs'],
                       '场地重建':'场界与板球磨损带按正射影像估计。草色参考日间实拍。'})


if __name__ == '__main__':
    entity = bake()
    path = ROOT/'build/streetscape.json'
    entities = {row['entityId']:row for row in json.loads(path.read_text())}
    entities[entity['entityId']] = entity
    path.write_text(json.dumps(list(entities.values()), ensure_ascii=False, indent=2)+'\n')
    print(entity['assetHash'])
