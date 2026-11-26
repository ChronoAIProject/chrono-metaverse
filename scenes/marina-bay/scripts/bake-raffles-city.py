"""Register whole photographed facade bays to the four mapped Raffles City building parts."""
import json
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.polygon import orient
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from context_geometry import geographic_point
from scanned_canopy import ROOT, write_tree_asset

sys.path.insert(0, str(ROOT.parents[1] / 'recon/src'))
from metaverse_recon.context.convert import frame

REFERENCES = ROOT / 'references/raffles-city'


def facade_material(name):
    with Image.open(REFERENCES / (name + '.jpg')) as photograph:
        source = np.asarray(photograph.convert('RGB'), dtype=float)
    luminance = source @ [.2126, .7152, .0722]
    # The podium scan covers opaque stone panels. The other strips include recessed glazing.
    midpoint = 56 if name == 'Office' else 85
    glass = np.zeros_like(luminance) if name == 'Podium' else np.clip((midpoint + 14 - luminance) / 28, 0, 1)
    # An overcast photograph records the ambient light on the stone as well as its tint.
    lift = np.clip((luminance - 35) / 90, 0, 1)
    colour = source * [.90, .92, .93] + [17, 21, 23] + lift[:, :, None] * [39, 37, 33]
    finish = np.stack([np.full_like(glass, 255), 221 - 127 * glass, 103 * glass], axis=2)
    dy, dx = np.gradient(gaussian_filter(glass, 1.2))
    normals = np.dstack([.62 * dx, -.62 * dy, np.ones_like(dx)])
    normals /= np.linalg.norm(normals, axis=2, keepdims=True)

    def image(pixels):
        result = Image.fromarray(np.round(pixels).clip(0, 255).astype(np.uint8))
        result.format = 'JPEG'
        return result

    return PBRMaterial(name='Raffles City ' + name, baseColorTexture=image(colour),
                       normalTexture=image((normals * .5 + .5) * 255),
                       metallicRoughnessTexture=image(finish), metallicFactor=.40, roughnessFactor=.93)


def covered_walls(part, hotel, origin, rotation, shift, datum):
    # Use the resident vector tile's quantized outline, including its curved and chamfered edges.
    points = np.array([geographic_point(lon, lat, origin, rotation, shift)
                       for lon, lat in part['outline']])
    grade = np.linalg.lstsq(np.column_stack([points[:,0], points[:,2], np.ones(len(points))]),
                            points[:,1], rcond=None)[0]
    outline = orient(Polygon(points[:, [0,2]]).buffer(.32, join_style='mitre'), sign=1)
    ring = np.asarray(outline.exterior.coords)
    rng = np.random.default_rng(part['feature'])
    base_edges = [LineString(points[[j, (j+1) % len(points)]][:, [0,2]])
                  for j in part.get('hotelBaseEdges', [])]
    walls = {}
    for a, b in zip(ring, ring[1:]):
        length = np.linalg.norm(b - a)
        midpoint = Point((a + b) / 2)
        hotel_base = any(midpoint.distance(edge) < 1.0 for edge in base_edges)
        finish = hotel if hotel_base else part
        name = finish['name']
        columns = finish['columns']
        count = max(1, round(length / finish['bayWidth']))
        vertices, texcoords = walls.setdefault(name, ([], []))
        for j, donor in enumerate(rng.integers(columns, size=count)):
            start = a + (b-a) * (j / count)
            end = a + (b-a) * ((j+1) / count)
            for (x, z), high, u in [(start, False, 1), (start, True, 1),
                                      (end, True, 0), (end, False, 0)]:
                elevation = part['top'] if high else part['bottom']
                y = grade @ [x,z,1] + datum + elevation
                vertices.append((x, y, z))
                # Continue the observed hotel stacks onto the podium's curved south front.
                v = elevation / hotel['top'] if name == hotel['name'] else float(high)
                texcoords.append(((donor + u) / columns, .002 + .996 * v))
    return walls


def bake():
    data = json.loads((REFERENCES/'footprints.json').read_text())
    config = json.loads((ROOT/'context.json').read_text())['oneMap']
    origin, rotation = frame(config)
    shift = np.array(json.loads((ROOT/'build/alignment.json').read_text())['shift'])
    env = json.loads((ROOT/'build/environment.json').read_text())['props']['environment']
    datum = env['map']['origin'][1] + config['officeHeightMeters'] - shift[1]
    scene = trimesh.Scene()
    walls = {}
    hotel = next(part for part in data['parts'] if part['name'] == 'Stamford')
    for part in data['parts']:
        for name, (points, uv) in covered_walls(part, hotel, origin, rotation, shift, datum).items():
            vertices, texcoords = walls.setdefault(name, ([], []))
            vertices.extend(points)
            texcoords.extend(uv)
    for name, (vertices, texcoords) in walls.items():
        quads = np.arange(len(vertices)).reshape(-1, 4)
        faces = quads[:, [0,1,2,0,2,3]].reshape(-1, 3)
        mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False,
                               visual=TextureVisuals(uv=texcoords, material=facade_material(name)))
        scene.add_geometry(mesh, geom_name=name)
    credit = ('Footprints © OpenStreetMap contributors, ODbL. Photograph by Diego Delso, 2023. '
              + data['photograph'] + '. Rectified facade strips and model: CC BY-SA 4.0, '
              'https://creativecommons.org/licenses/by-sa/4.0/.')
    digest, bounds = write_tree_asset(scene, copyright=credit)
    return dict(entityId='bay.raffles-city-elevations', kind='structure', layer='ext',
                regionId='marina-bay-exterior', label='来福士城 · 酒店、办公楼与裙楼',
                assetHash=digest, bounds=bounds, material={'shading':'albedo'},
                props={'background':True, '参考照片':data['photograph'], '版权':credit,
                       '立面':'按地图轮廓和高度配准。背面和遮挡处依据同楼的可见开间估计。'})


if __name__ == '__main__':
    entity = bake()
    path = ROOT/'build/streetscape.json'
    entities = {row['entityId']: row for row in json.loads(path.read_text())}
    entities[entity['entityId']] = entity
    path.write_text(json.dumps(list(entities.values()), ensure_ascii=False, indent=2) + '\n')
    print(entity['assetHash'])
