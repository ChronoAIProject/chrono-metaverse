"""Bake the surveyed podium deck finishes into one registered roof material."""
import json

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter, map_coordinates
from scipy.spatial import cKDTree
from shapely import constrained_delaunay_triangles, union_all
from shapely.geometry import Point, Polygon
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from context_geometry import geographic_point
from ground_materials import scanned_pavers
from pool_tiles import tile_finish
from scanned_canopy import ROOT


def deck_material(survey):
    width, height = survey['size']
    y, x = np.indices((height, width))
    scan_dir = ROOT / 'references/skyline-finishes/ConcreteRoof'
    with Image.open(scan_dir / 'Color.jpg') as image:
        stone = np.asarray(image.convert('L'), dtype=float)
    grain = map_coordinates(stone, [y * 3.7 + x * .9, x * 3.7 - y * .9],
                            order=1, mode='grid-wrap')
    grain = (grain - np.mean(grain)) / np.std(grain)
    rng = np.random.default_rng(394872632)
    wear = gaussian_filter(rng.normal(size=x.shape), 4)
    wear /= wear.std()
    colour = [137, 140, 133] + (3.4 * grain + 3.6 * wear)[:, :, None]
    roughness = 209 + 3.8 * grain
    relief = .035 * grain
    for area in survey['surfaces']:
        outline = np.array(area['ring'])
        mask = Image.new('1', (width, height))
        ImageDraw.Draw(mask).polygon(list(map(tuple, outline)), fill=1)
        inside = np.asarray(mask)
        ix, iy = x[inside], y[inside]
        points = np.column_stack((ix, iy))
        samples = np.array(area['samples'])
        if len(samples):
            distances, near = cKDTree(samples[:, :2]).query(points, k=range(1, min(4, len(samples)) + 1))
            weights = 1 / (16 + distances ** 2)
            weights /= weights.sum(axis=1, keepdims=True)
            observed = (weights[:, :, None] * samples[near, 2:]).sum(axis=1)
            local = (observed - np.median(samples[:, 2:], axis=0)).clip(-20, 20)
        else:
            local = 0.
        kind = area['material']
        base = {'planting': [70, 90, 56], 'glass': [67, 89, 96],
                'redCourt': [133, 89, 77], 'greenCourt': [95, 117, 98]}[kind]
        shade = np.asarray(base) + .72 * local + (grain[inside] * 2.4 + wear[inside] * 2.9)[:, None]
        axis = outline[1] - outline[0]
        axis = axis / np.linalg.norm(axis)
        frame = np.array([axis, [-axis[1], axis[0]]])
        uv = (points - outline[0]) @ frame.T
        if kind == 'glass':
            # The glazed roofs show diagonal metal frames separating whole panes.
            diagonal = uv @ np.array([[.707, -.707], [.707, .707]]) / 11.5
            seams = np.minimum(*np.abs(diagonal - np.rint(diagonal)).T) < .052
            cell = np.floor(diagonal).astype(int)
            pane = np.sin(cell[:,0]*52.1 + cell[:,1]*19.7) * 5
            shade += (pane + 29 * seams)[:, None]
            roughness[inside] = np.where(seams, 156, 73 + pane)
            relief[inside] = np.where(seams, .27, 0)
        elif kind == 'planting':
            shade += (grain[inside] * 3.4 + wear[inside] * 3.3)[:, None]
            roughness[inside] = 229
            relief[inside] = .19 * grain[inside]
        else:
            # Retain the light edge strip around the surfaced court.
            limits = (outline - outline[0]) @ frame.T
            edge = np.minimum(uv - limits.min(axis=0), limits.max(axis=0) - uv).min(axis=1)
            shade += np.clip(2.5 - edge, 0, 2.5)[:, None] * 9
            roughness[inside] = 205 + grain[inside] * 2
        colour[inside] = shade
    dy, dx = np.gradient(gaussian_filter(relief, .7))
    normals = np.dstack((-dx, dy, np.ones_like(dx)))
    normals /= np.linalg.norm(normals, axis=2, keepdims=True)

    def image(pixels):
        result = Image.fromarray(np.rint(pixels).clip(0, 255).astype(np.uint8))
        result.format = 'JPEG'
        return result

    packed = np.stack([np.full_like(roughness, 255), roughness, np.zeros_like(roughness)], axis=2)
    return PBRMaterial(name='Raffles City rooftop deck', baseColorTexture=image(colour),
                       normalTexture=image(127.5 * (normals + 1)), metallicRoughnessTexture=image(packed),
                       metallicFactor=0, roughnessFactor=1)


def podium_roof(parts, origin, rotation, shift, datum):
    survey = json.loads((ROOT/'references/raffles-city/roof-deck.json').read_text())
    podium = next(part for part in parts if part['name'] == 'Podium')
    tile_span = 256 * 2 ** survey['zoom']
    pixel_origin = np.asarray(survey['pixelOrigin'])

    def pixels(part):
        lon, lat = np.array(part['outline']).T
        xy = np.column_stack(((lon + 180) / 360, (1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2))
        return Polygon(xy * tile_span - pixel_origin)

    def world(point, level):
        u, v = (np.asarray(point) + pixel_origin) / tile_span
        lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2*v))))
        xyz = geographic_point(u*360 - 180, lat, origin, rotation, shift)
        xyz[1] += datum + podium['top'] + level
        return xyz

    origin_xz = world(survey['pools'][0]['centre'], 0)[[0,2]]

    def surface(footprint, level, material, repeat=None):
        vertices, uv = [], []
        for face in constrained_delaunay_triangles(footprint).geoms:
            for point in face.exterior.coords[:-1]:
                xyz = world(point, level)
                vertices.append(xyz)
                u, v = np.array(point) / survey['size']
                uv.append((u, 1-v) if repeat is None else (xyz[[0,2]] - origin_xz) / repeat)
        mesh = trimesh.Trimesh(vertices=vertices, faces=np.arange(len(vertices)).reshape(-1,3),
                               process=False, visual=TextureVisuals(uv=uv, material=material))
        down = mesh.face_normals[:,1] < 0
        mesh.faces[down] = mesh.faces[down, ::-1]
        mesh.vertex_normals = np.tile([0., 1., 0.], (len(vertices), 1))
        return mesh

    footprint = pixels(podium).difference(union_all([pixels(p) for p in parts if p['bottom'] == podium['top']]))
    garden = union_all([Polygon(area['ring']) for area in survey['surfaces'] if area['material'] == 'planting'])
    terrace = Polygon(survey['poolTerrace']).intersection(footprint).difference(garden)
    water = union_all([Point(p['centre']).buffer(p['radius'], quad_segs=16) for p in survey['pools']])
    # Make a stepped coping around each basin. Paving and water reuse metric, mipmapped scans.
    coping = water.buffer(1.7)
    paving = scanned_pavers('Pool deck limestone', [150,146,134], [.60,.40])
    edge = scanned_pavers('Honed coping stone', [177,171,153], [.48,.32])
    result = {
        'Podium deck': surface(footprint.difference(terrace), .36, deck_material(survey)),
        'Pool terrace': surface(terrace.difference(coping), .36, paving, [2.4,2.4]),
        'Pool coping': surface(coping.difference(water), .47, edge, [1.92,1.92]),
        'Pool water': surface(water, .16, tile_finish('Raffles pool water'), [2.,2.]),
    }
    sides, uv = [], []
    for basin in water.geoms:
        ring = np.array(basin.exterior.coords)
        distance = 0.
        for a, b in zip(ring, ring[1:]):
            length = np.linalg.norm(world(b, 0)-world(a, 0))
            for point, level, across in [(a,.16,0), (a,.47,0), (b,.47,length), (b,.16,length)]:
                sides.append(world(point,level))
                uv.append(((distance+across)/1.92,level/1.92))
            distance += length
    q = np.arange(len(sides)).reshape(-1,4)
    inner = trimesh.Trimesh(vertices=sides, faces=q[:,[0,1,2,0,2,3]].reshape(-1,3), process=False,
                            visual=TextureVisuals(uv=uv,material=edge))
    # Both the inside of the basin and the lip are visible as players walk around it.
    edge.doubleSided = True
    result['Inner pool walls'] = inner
    return result
