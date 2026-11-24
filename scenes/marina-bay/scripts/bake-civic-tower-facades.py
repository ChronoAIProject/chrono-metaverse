"""Fit photographed cladding and perimeter piers to four mapped city towers."""
import json
import sys

import numpy as np
from PIL import Image
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from context_geometry import geographic_point
from scanned_canopy import ROOT, write_tree_asset

sys.path.insert(0, str(ROOT.parents[1] / 'recon/src'))
from metaverse_recon.context.convert import frame


def tile_vertices(ring):
    """Register the cladding to the OpenMapTiles z14 wall inside the detailed city area."""
    lon, lat = np.asarray(ring).T
    extent = 4096 * 2**14
    u = np.round((lon + 180) / 360 * extent) / extent
    v = np.round((1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) * .5 * extent) / extent
    return np.column_stack((360*u - 180, np.degrees(np.arctan(np.sinh(np.pi*(1-2*v))))))


def window_piers(slug, width):
    if slug == 'high-street-centre':
        return [(s, 1.45, .94) for s in (.047, .953)]
    if width < 10:
        return []
    if slug == 'peninsula-plaza':
        return [(.025, .56, .34), (.337, .42, .40), (.674, .42, .40), (.975, .56, .34)]
    count = 5 if slug == 'state-courts-court' else 4
    return [(s, .65, .5) for s in np.linspace(.025, .975, count)]


def bake(row, config, origin, rotation, shift):
    slug = row['slug']
    ring = [geographic_point(lon, lat, origin, rotation, shift)
            for lon, lat in tile_vertices(row['footprint'])]
    centre = np.mean(ring, axis=0)
    facade, uv, piers = [], [], []
    side_atlas = slug in ('high-street-centre', 'peninsula-plaza')
    for a, b in zip(ring, [*ring[1:], ring[0]]):
        axis = b-a
        axis[1] = 0
        width = np.linalg.norm(axis)
        if width < .05:
            continue
        axis /= width
        normal = np.array([axis[2], 0, -axis[0]])
        if normal @ (a - centre) < 0:
            a, b = b, a
            axis, normal = -axis, -normal
        base = config['datum'] + .5*(a[1]+b[1]) + config['officeHeightMeters'] - shift[1]
        low, high = base + row['bottom'], base + row['top']
        def point(distance, depth, y):
            v = a + axis*distance + normal*depth
            v[1] = y
            return v
        facade.extend([point(0,.20,low),point(0,.20,high),
                       point(width,.20,high),point(width,.20,low)])
        short = width < (28 if slug == 'high-street-centre' else 20)
        start = .5 if side_atlas and short else 0
        stop = start + (.5 if side_atlas else 1)
        # The exterior winding traverses the wall from screen right to left.
        uv.extend([(stop-.006, .002), (stop-.006, .998),
                   (start+.006, .998), (start+.006, .002)])
        # The photographs resolve projecting piers. Their sections are estimated in metres.
        profile = [(-.5,0),(-.5,.50),(-.37,.86),(-.18,1),(.18,1),(.37,.86),(.5,.50),(.5,0)] \
            if slug == 'high-street-centre' else [(-.5,0),(-.5,1),(.5,1),(.5,0)]
        for station, breadth, depth in window_piers(slug, width):
            for (x0,z0),(x1,z1) in zip(profile,profile[1:]):
                u0,u1 = station*width + x0*breadth, station*width + x1*breadth
                piers.extend([point(u0,.20+z0*depth,low),point(u0,.20+z0*depth,high),
                              point(u1,.20+z1*depth,high),point(u1,.20+z1*depth,low)])

    def quads(points, material, coordinates=None):
        faces = [[i,i+1,i+2] for i in range(0,len(points),4)]
        faces += [[i,i+2,i+3] for i in range(0,len(points),4)]
        return trimesh.Trimesh(vertices=points,faces=faces,process=False,
                               visual=TextureVisuals(uv=coordinates,material=material))

    with Image.open(ROOT/'references'/f'{slug}-daylight.jpg') as image:
        surface = PBRMaterial(name='Photographed facade',baseColorTexture=image,
                              metallicFactor=0,roughnessFactor=.70)
        trim = PBRMaterial(name='Perimeter piers',baseColorFactor=[220,219,211,255],
                           metallicFactor=.07,roughnessFactor=.52)
        scene = trimesh.Scene()
        scene.add_geometry(quads(facade,surface,uv),geom_name='Surveyed facade')
        scene.add_geometry(quads(piers,trim),geom_name='Projecting piers')
        def metadata(doc):
            if slug == 'high-street-centre':
                next(m for m in doc['materials'] if m['name']==surface.name)['extras']={'reflectSky':True}
        copyright = 'Footprint © OpenStreetMap contributors (ODbL 1.0). ' + ' '.join(
            f"Photograph by {p['author']} ({p['license']}), {p['page']}. Cropped, rectified and exposure-adjusted."
            for p in row['photos'])
        if any(p['license']=='CC BY-SA 4.0' for p in row['photos']):
            copyright += ' Adapted atlas and model: CC BY-SA 4.0, https://creativecommons.org/licenses/by-sa/4.0/.'
        digest,bounds = write_tree_asset(scene, metadata, packing_options=('-ke',), copyright=copyright)
    return dict(entityId='bay.'+slug+'-facade',kind='structure',layer='ext',regionId='marina-bay-exterior',
                assetHash=digest,label=row['label']+' · 塔楼立面',bounds=bounds,material={'shading':'albedo'},
                props={'background':True, '来源':f"https://www.openstreetmap.org/way/{row['way']}/history",
                       '重建':'按测绘轮廓与高度配准。窗带从实拍校正，背面与遮挡部分复用同楼可见立面，柱宽与出挑深度为估值。',
                       '材质版权':copyright, 'backgroundView':{
                           'focus':np.mean([bounds['min'],bounds['max']],axis=0).tolist(),'maxDistance':4100}})


if __name__ == '__main__':
    catalog = json.loads((ROOT/'references/civic-tower-facades.json').read_text())
    config = json.loads((ROOT/'context.json').read_text())['oneMap']
    config['datum'] = json.loads((ROOT/'build/environment.json').read_text())['props']['environment']['map']['origin'][1]
    origin, rotation = frame(config)
    shift = np.array(json.loads((ROOT/'build/alignment.json').read_text())['shift'])
    path = ROOT/'build/streetscape.json'
    records = {e['entityId']:e for e in json.loads(path.read_text())}
    for r in catalog:
        entity = bake(r, config, origin, rotation, shift)
        records[entity['entityId']] = entity
        print(entity['entityId'],entity['assetHash'])
    path.write_text(json.dumps(list(records.values()),ensure_ascii=False,indent=2)+'\n')
