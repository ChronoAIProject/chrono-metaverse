"""Fit the two photographed Victoria porticos to the measured theatre frontage."""
import json

import numpy as np
from PIL import Image
import shapely
from shapely.geometry import Polygon, box
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from scanned_canopy import ROOT, write_tree_asset

HOST = 'bay.f21025bc-7836-44eb-82b6-f78da166312a'
SURVEY = '2feaa0aed475f9251049756212bbb4710ac182b58453e2efd4c398a28e943f4e'
PHOTO = 'https://commons.wikimedia.org/wiki/File:Victoria_Theatre_and_Victoria_Concert_Hall,_with_54m_high_Clock_Tower.jpg'
CREDIT = ('Survey geometry: Map Data © Singapore Land Authority / OneMap. '
          'Portico textures cropped, rectified and retouched from Victoria Theatre and Victoria '
          'Concert Hall, with 54m high Clock Tower by TTangMonuments (CC BY-SA 4.0), '+PHOTO+
          '. Adapted texture atlas and model: https://creativecommons.org/licenses/by-sa/4.0/.')
# Coordinates below use the 320 x 424 working elevations, left to right as viewed from the lawn.
WINGS = [
    dict(faces=[1191,1192],pediment=489,upper=[(48,111),(134,196),(219,276)],
         arches=[(74,20),(159,22),(242,22)],columns=[(122,10),(206,10)]),
    dict(faces=[1171,1172],pediment=176,upper=[(43,108),(130,185),(216,278)],
         arches=[(75,24),(161,22),(249,23)],columns=[(118,10),(200,10)]),
]


def bake():
    host = next(e for e in json.loads((ROOT/'build/onemap-entities.json').read_text()) if e['entityId']==HOST)
    source = trimesh.load_scene(ROOT/'assets'/(SURVEY+'.glb'),process=False)
    survey = next(m for m in source.geometry.values() if m.visual.kind=='texture' and m.bounds[0,1]<1)
    anchor = (np.asarray(host['bounds']['min'])+host['bounds']['max'])/2
    anchor[1] = host['bounds']['min'][1]
    vertices,faces,uv = [],[],[]

    for side,wing in enumerate(WINGS):
        measured=survey.triangles[wing['faces']].reshape(-1,3)
        normal=survey.face_normals[wing['faces'][0]].copy()
        normal[1]=0
        normal/=np.linalg.norm(normal)
        right=np.cross([0,1,0],normal)
        near,far=np.min(measured@right),np.max(measured@right)
        bottom,top=measured[:,1].min(),measured[:,1].max()
        plane=(measured@normal).max()
        def append(world,tex):
            start=len(vertices)
            vertices.extend(world+anchor)
            uv.extend(tex)
            for j in range(1,len(world)-1):
                faces.append([start,start+j,start+j+1])
        def panel(points,depth):
            xy=np.array(points)
            x,y=xy.T
            z=np.broadcast_to(depth,len(x))
            spatial=(near+(far-near)*x/320)[:,None]*right+(plane+z)[:,None]*normal
            spatial[:,1]=top-(top-bottom)*y/424
            tex=np.column_stack(((side*656+2*x)/2048,1-2*y/1024))
            append(spatial,tex)
        def fill(polygon,depth):
            for t in shapely.get_parts(shapely.constrained_delaunay_triangles(polygon)):
                panel(np.asarray(t.exterior.coords)[:3],depth)
        def reveal(polygon,back,front):
            edge=np.asarray(polygon.exterior.coords)
            for a,b in zip(edge,edge[1:]):
                panel([a,b,b,a],[back,back,front,front])
        apertures=[box(a,49,b,228) for a,b in wing['upper']]
        for cx,rx in wing['arches']:
            theta=np.linspace(np.pi,0,17)
            arch=np.column_stack((cx+rx*np.cos(theta),342-33*np.sin(theta)))
            apertures.append(Polygon([*arch,(cx+rx,396),(cx-rx,396)]))
        wall=box(0,0,320,424)
        fill(wall.difference(shapely.union_all(apertures)),.54)
        reveal(wall,.04,.54)
        for hole in apertures:
            fill(hole,.055)
            reveal(hole,.055,.54)
        # Project the photographed shafts onto elliptic profiles so the inner
        # colonnades show parallax while walking across the lawn.
        for centre,radius in wing['columns']:
            angles=np.linspace(-np.pi/2,np.pi/2,15)
            for y0,y1,w0,w1 in [(51,61,1.05,.82),(61,219,.82,1),(219,231,1,1.08)]:
                for a,b in zip(angles,angles[1:]):
                    xs=centre+radius*np.sin([a,b,b,a])*[w0,w0,w1,w1]
                    panel(np.column_stack((xs,[y0,y0,y1,y1])),.56+.31*np.cos([a,b,b,a]))
        # Keep the surveying model's actual triangle and use only the three
        # control points inside the photographed tympanum.
        tri=survey.triangles[wing['pediment']].copy()
        idx=np.argsort(tri@right)
        uv_pixels=np.array([(10,987),(185,897),(358,987)])+[390*side,0]
        append(tri[idx]+normal*.07,np.column_stack((uv_pixels[:,0]/2048,1-uv_pixels[:,1]/1024)))

    # Register the central entrance in the same photograph. Both porticos supply
    # measured corners on the forward plane. Moving inward changes image scale
    # according to the camera distance estimated from the reference elevation.
    normal=survey.face_normals[1171].copy()
    normal[1]=0
    normal/=np.linalg.norm(normal)
    right=np.cross([0,1,0],normal)
    for i,tri in enumerate(survey.triangles):
        along=tri@right
        depth=tri@normal
        if (survey.face_normals[i]@normal < .64 or depth.mean()<21 or
                along.min() < -12.35 or along.max()>11.1 or tri[:,1].max()>39):
            continue
        # Screen coordinates use the surveyed wings at y=0 and y=20.85.
        # The reference camera pitches up slightly, giving a mild convergence.
        h=tri[:,1]
        scale=82/(82+30.5-depth+.009*h)
        x=544+(along+.32)*(12.95-.028*h)*scale
        y=576+(221-13.04*h)*scale
        if x.min()<350 or x.max()>730 or y.min()<230 or y.max()>803:
            continue
        x=np.clip(x,350.2,729.8)
        y=np.clip(y,230.2,799.8)
        tex=np.column_stack(((1330+(x-350)*684/380)/2048,
                             1-(y-230)*1020/570/1024))
        append(tri+survey.face_normals[i]*.08,tex)

    image=Image.open(ROOT/'references/victoria-porticos.jpg')
    material=PBRMaterial(name='Victoria porticos, ironwork and theatre banners',baseColorTexture=image,
                         metallicFactor=0,roughnessFactor=.86,doubleSided=True)
    mesh=trimesh.Trimesh(vertices=vertices,faces=faces,process=False,
                         visual=TextureVisuals(uv=uv,material=material))
    scene=trimesh.Scene()
    scene.add_geometry(mesh,geom_name='Victoria Theatre and Memorial Hall porticos')
    digest,bounds=write_tree_asset(scene,copyright=CREDIT)
    return dict(entityId='bay.victoria-porticos',kind='structure',layer='ext',label='维多利亚剧院与纪念堂 · 草坪侧双门廊',
                regionId=host['regionId'],assetHash=digest,bounds=bounds,material={'shading':'baked'},
                props={'background':True,'建筑数据':'OneMap · Map Data © Singapore Land Authority',
                       '现场照片':PHOTO,'材质版权':CREDIT,'细节说明':'两翼位置与山花取自测绘表面。六扇拱窗、楼上六个柱间及柱身参照照片；进深为估值。'})


if __name__=='__main__':
    row=bake()
    path=ROOT/'build/streetscape.json'
    rows={e['entityId']:e for e in json.loads(path.read_text())}
    rows[row['entityId']]=row
    path.write_text(json.dumps(list(rows.values()),ensure_ascii=False,indent=2)+'\n')
    print(row['assetHash'])
