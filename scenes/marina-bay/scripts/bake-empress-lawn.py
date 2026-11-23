"""Register the Empress Lawn and the Dalhousie Obelisk pedestrian junction."""
import json
import sys
from pathlib import Path

import numpy as np
import shapely
from scipy.spatial import cKDTree
import trimesh
from PIL import Image
from shapely.geometry import LineString, Polygon, box
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from context_geometry import geographic_point
from scanned_canopy import ROOT, write_tree_asset

sys.path.insert(0, str(ROOT.parents[1] / 'recon/src'))
from metaverse_recon.context.convert import frame

ASSETS = ROOT.parents[1] / 'web/src/assets/geography'


def ground_material(grass, reference):
    name = 'turf' if grass else 'pavers'
    size = 768
    with Image.open(ASSETS / f'{name}-color.webp') as image:
        scan = np.asarray(image.convert('RGB').resize((size, size), Image.Resampling.LANCZOS), float)
    with Image.open(ASSETS / f'{name}-surface.webp') as image:
        packed = np.asarray(image.resize((size, size), Image.Resampling.LANCZOS), float)
    y, x = np.indices((size, size))
    if grass:
        # Preserve the photographed blades, with the site survey setting the mean colour.
        mean = np.asarray(reference['colourSurvey']['grass']) * [.57,.66,.43]
        rgb = scan / np.mean(scan, axis=(0, 1)) * mean
        slope = (packed[:, :, :2] / 127.5 - 1) * .68
        rough = np.maximum(packed[:, :, 2], 200)
    else:
        # The source grain comes from the face of one clean granite unit. Set out
        # staggered rectangular stones at the pitch seen in the ground photograph.
        col, row = (x + .5) / size * 4, (y + .5) / size * 6
        col += .5 * (row.astype(int) % 2)
        u, v = col % 1, row % 1
        i, j = (48 + v * 49).astype(int), (48 + u * 49).astype(int)
        grain = scan[i, j] @ [.2126, .7152, .0722]
        pitch = np.asarray(reference['stonePitchMetres'])
        seam = np.minimum(np.minimum(u, 1-u)*pitch[0], np.minimum(v, 1-v)*pitch[1])
        joint = np.clip(1-seam/.0055, 0, 1)
        tone = np.random.default_rng(149).normal(0, 5, (6,4))[row.astype(int), col.astype(int)%4]
        mean = np.asarray(reference['colourSurvey']['stone']) * [.80,.76,.69]
        rgb = mean + (tone + (grain - grain.mean())*.56 - 28*joint)[:,:,None]
        relief = -.0032 * joint + .000015*(grain - grain.mean())
        dy = (np.roll(relief,-1,0)-np.roll(relief,1,0)) * size/(12*pitch[1])
        dx = (np.roll(relief,-1,1)-np.roll(relief,1,1)) * size/(8*pitch[0])
        slope = np.dstack((-dx,dy))
        rough = np.clip(packed[i,j,2]*.27 + 145 + 31*joint, 145, 245)
    rgb = Image.fromarray(np.uint8(np.clip(rgb,0,255)))
    rgb.format = 'JPEG'
    normals = np.dstack((slope, np.ones_like(rough)))
    normals /= np.linalg.norm(normals,axis=2,keepdims=True)
    normal = Image.fromarray(np.uint8((normals+1)*127.5)).resize((384,384),Image.Resampling.LANCZOS)
    normal.format = 'JPEG'
    mr = Image.fromarray(np.uint8(np.dstack((np.full_like(rough,255),rough,np.zeros_like(rough))))).resize(
        (384,384),Image.Resampling.BOX)
    mr.format = 'PNG'
    return PBRMaterial(name='Empress Lawn turf' if grass else 'Dalhousie court granite',
                       baseColorTexture=rgb, normalTexture=normal, metallicRoughnessTexture=mr,
                       metallicFactor=0, roughnessFactor=1)


def surface(polygon, grass, basis, datum, reference):
    # Subdivide in metre space so the grass can change tone gradually across the lawn
    # and the pavement can meet the raised paths at the gallery side of the junction.
    vertices, faces = [], []
    xmin,zmin,xmax,zmax = polygon.bounds
    for x in np.arange(np.floor(xmin/4)*4, xmax, 4):
        for z in np.arange(np.floor(zmin/4)*4, zmax, 4):
            cell = polygon.intersection(box(x,z,x+4,z+4))
            for tri in shapely.get_parts(shapely.constrained_delaunay_triangles(cell)):
                coords = np.asarray(tri.exterior.coords)[:3]
                faces.append(np.arange(3)+len(vertices))
                vertices.extend(coords)
    xz = np.asarray(vertices)
    along, across = (xz @ basis.T).T
    height = datum + .39 - .5*np.sum((xz-reference['frameOrigin'])**2,axis=1)/6371000
    # The surveyed monument sits on a lower plinth than the streaming paving to
    # the west. Taper to its actual foot level over the surrounding stone square.
    distance = np.linalg.norm(xz-reference['monumentXZ'], axis=1)
    height -= .14 * np.clip((14-distance)/6,0,1)
    if grass:
        height += .014 + .012*np.sin(along*.20)*np.cos(across*.17)
        uv = np.column_stack((along/1.4, across/1.4))
    else:
        pitch = reference['stonePitchMetres']
        uv = np.column_stack((along/(4*pitch[0]), across/(6*pitch[1])))
    xyz = np.column_stack((xz[:,0],height,xz[:,1]))
    mesh = trimesh.Trimesh(vertices=xyz, faces=faces, visual=TextureVisuals(
        uv=uv, material=ground_material(grass, reference)),process=False)
    down = mesh.face_normals[:,1]<0
    mesh.faces[down] = mesh.faces[down][:,::-1]
    mesh.vertex_normals = np.tile([0,1,0],(len(xyz),1))
    if grass:
        # Use local median grass colour to bring back broad wear and shade patterns.
        # Linear RGB multipliers keep the photographed grain in the repeating albedo.
        tree, tones = reference['grassSurvey']
        ds, near = tree.query(xz, k=4)
        weight = 1 / np.maximum(ds, .5)**2
        field = np.sum(tones[near]*weight[:,:,None],axis=1) / weight.sum(axis=1)[:,None]
        tint = np.minimum(1, .82 * (field/np.median(tones,axis=0))**2.4)
        mesh.visual.vertex_attributes['color'] = np.uint8(
            np.column_stack((tint,np.ones(len(tint))))*255)
    return mesh


def bake():
    ref = json.loads((ROOT/'references/empress-lawn.json').read_text())
    config = json.loads((ROOT/'context.json').read_text())
    origin, rotation = frame(config['oneMap'])
    shift = np.asarray(json.loads((ROOT/'build/alignment.json').read_text())['shift'])
    pixels = np.asarray(ref['ortho']['tilePixelOrigin'])
    world = 256 * 2**ref['ortho']['zoom']
    def local(point):
        x,y = (pixels+point)/world
        lon,lat = x*360-180, np.degrees(np.arctan(np.sinh(np.pi*(1-2*y))))
        return geographic_point(lon,lat,origin,rotation,shift)[[0,2]]
    lawn = Polygon([local(p) for p in ref['lawnPixels']])
    plaza = Polygon([local(p) for p in ref['obeliskCourtPixels']])
    axis = LineString([local(p) for p in ref['museumDrive']])
    if not (lawn.is_valid and plaza.is_valid):
        raise ValueError('Invalid traced site boundary')
    junction = plaza.union(axis.buffer(ref['museumDriveWidthMetres']/2,cap_style='flat'))
    for path in ref['gardenPaths']:
        route = LineString([local(p) for p in path['pixels']])
        junction = junction.union(route.buffer(path['width']/2, cap_style='flat'))
    garden = Polygon([local(p) for p in ref['gardenPixels']])
    turf = lawn.union(garden).difference(junction)
    direction = np.diff(np.array(axis.coords)[[0,-1]],axis=0)[0]
    direction /= np.linalg.norm(direction)
    basis = np.array([direction,[-direction[1],direction[0]]])
    samples = np.asarray(ref['grassSamples'])
    ref['grassSurvey'] = (cKDTree([local(xy) for xy in samples[:,:2]]), samples[:,2:])
    ref['monumentXZ'] = local([697,699])
    ref['frameOrigin'] = shift[[0,2]]
    datum = json.loads((ROOT/'build/environment.json').read_text())['props']['environment']['map']['origin'][1]
    scene = trimesh.Scene()
    for shape, grass in [(junction,False),(turf,True)]:
        mesh = surface(shape,grass,basis,datum,ref)
        scene.add_geometry(mesh,geom_name=mesh.visual.material.name)
    digest,bounds = write_tree_asset(scene)
    return dict(entityId='bay.empress-lawn-obelisk-court',kind='structure',layer='ext',
                regionId='marina-bay-exterior',label='皇后坊 · 大草坪与达尔豪西纪念碑步道',
                assetHash=digest,bounds=bounds,material={'shading':'albedo'},
                props={'background':True,'surfaceRole':'landscape','影像依据':ref['ortho']['title'],
                       '地图来源':'© OpenStreetMap contributors · ODbL','参考道路':ref['mapWays'],
                       '现场照片':ref['photograph'],'材质素材':'ambientCG Grass 004；Poly Haven Granite Tile 04 · CC0',
                       '地面重建':'边界按正射影像与通道中心线定位。树冠下的边缘、铺装尺寸和高程为估值。'})


if __name__ == '__main__':
    row = bake()
    path = ROOT/'build/streetscape.json'
    rows = {e['entityId']:e for e in json.loads(path.read_text())}
    rows[row['entityId']] = row
    path.write_text(json.dumps(list(rows.values()),ensure_ascii=False,indent=2)+'\n')
    print(row['assetHash'])
