"""Rebuild the surveyed open lawns next to Marina Boulevard in member coordinates."""
import json

import numpy as np
import shapely
import trimesh
from PIL import Image
from scipy.ndimage import map_coordinates
from scipy.spatial import cKDTree
from shapely.geometry import Polygon, box
from trimesh.visual.texture import TextureVisuals

from ground_materials import scanned_turf, turf_wear, vary_turf_direction
from scanned_canopy import ROOT, write_tree_asset


def bake(survey):
    # Constrain each cell to the original vector boundary; narrow footpaths stay open.
    faces = []
    for feature in survey['features']:
        polygon = Polygon(feature['boundaryXZ'])
        xmin, zmin, xmax, zmax = polygon.bounds
        # Resolve the metre-scale changes in turf cover along a normal walk.
        pitch = 1
        for x in np.arange(np.floor(xmin / pitch) * pitch, xmax, pitch):
            for z in np.arange(np.floor(zmin / pitch) * pitch, zmax, pitch):
                cell = polygon.intersection(box(x, z, x + pitch, z + pitch))
                for tri in shapely.get_parts(shapely.constrained_delaunay_triangles(cell)):
                    faces.append(np.asarray(tri.exterior.coords)[:3])
    xz, indices = np.unique(np.asarray(faces).reshape(-1, 2), axis=0, return_inverse=True)
    origin = np.asarray(survey['reference']['origin'])
    height = origin[1] + .062 - np.sum((xz - origin[[0, 2]]) ** 2, axis=1) / (2 * 6371000)
    samples = np.asarray(survey['samplesXZrgb'])
    distance, near = cKDTree(samples[:, :2]).query(xz, k=4)
    weights = 1 / np.maximum(distance, 1.5) ** 2
    rgb = (weights[:, :, None] * samples[near, 2:]).sum(axis=1) / weights.sum(axis=1)[:, None]
    base = np.array([141, 156, 119])
    # Temper aerial light and moisture variations before lighting the surface in 3D.
    tint = np.clip((rgb / base) ** 1.7 * turf_wear(xz) ** .23, .20, 1)
    material = scanned_turf('Promontory lawn', base, cover='grass_ground')
    vary_turf_direction(material)
    # Reintroduce the warm patches excluded by the green-only survey. Convert the
    # measured colour ratio to linear light before mixing into vertex colours.
    wear = survey['wear']
    with Image.open(ROOT / 'references' / wear['image']) as image:
        field = np.asarray(image.convert('L'), dtype=float) / 255
    pixel = (xz - wear['originXZ']) / wear['metresPerPixel']
    coverage = map_coordinates(field, pixel[:, ::-1].T, order=1, mode='constant')[:, None]
    green, worn = np.asarray([wear['greenRGB'], wear['wornRGB']]) / 255
    ratio = ((worn + .055) / (green + .055)) ** 2.4
    # Reserve enough headroom for the brighter worn turf in the UNORM vertex channel.
    headroom = np.maximum(1, ratio)
    tint *= (1 + coverage * (ratio - 1)) / headroom
    # Add local cover variation after the broad wear gradient. Neutral samples
    # outside reliable open turf preserve the surveyed colour at the path edge.
    with Image.open(ROOT / 'references' / wear['variationImage']) as image:
        variation = (np.asarray(image.convert('RGB'), dtype=float) - 128) / 256
    offsets = np.column_stack([
        map_coordinates(channel, pixel[:, ::-1].T, order=1, mode='constant')
        for channel in variation.transpose(2, 0, 1)
    ])
    tint *= np.exp2(offsets)
    factor = np.array([.55, .55, .50]) * headroom
    # Preserve bright samples when storing linear vertex colours as unsigned bytes.
    scale = np.minimum(np.maximum(1, tint.max(axis=0)), 1 / factor)
    tint = np.clip(tint / scale, 0, 1)
    material.baseColorFactor = [*(factor * scale), 1.]
    uv = xz @ np.array([[.8, -.6], [.6, .8]]) / 1.8
    mesh = trimesh.Trimesh(vertices=np.column_stack((xz[:, 0], height, xz[:, 1])),
                           faces=indices.reshape(-1, 3), process=False,
                           visual=TextureVisuals(uv=uv, material=material))
    down = mesh.face_normals[:, 1] < 0
    mesh.faces[down] = mesh.faces[down, ::-1]
    mesh.vertex_normals = np.tile([0, 1, 0], (len(xz), 1))
    mesh.visual.vertex_attributes['color'] = np.uint8(np.rint(255 * np.column_stack((tint, np.ones(len(xz))))))
    return write_tree_asset(trimesh.Scene(mesh))


if __name__ == '__main__':
    survey = json.loads((ROOT / 'references/promontory-turf.json').read_text())
    digest, bounds = bake(survey)
    entity = dict(entityId='bay.promontory-lawns', regionId='marina-bay-exterior',
                  kind='structure', layer='ext', label='滨海大道 · 临水草坪', assetHash=digest,
                  bounds=bounds, material={'shading': 'albedo'},
                  props={'background': True, 'surfaceRole': 'landscape',
                         'groundScanMaterials': ['Promontory lawn'],
                         'attribution': '© OpenStreetMap contributors · SLA OneMap · Meta/WRI canopy height · Poly Haven Grass Ground (CC0)'})
    (ROOT / 'build/promontory-turf.json').write_text(json.dumps(entity, ensure_ascii=False, indent=2) + '\n')
    print(digest)
