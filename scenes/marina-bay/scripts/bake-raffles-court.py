"""Reconstruct the bronze Raffles monument and twin fountain bowls at Empress Place."""
import importlib
import json
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt, gaussian_filter, map_coordinates
import trimesh
import shapely
from shapely.geometry import Polygon
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from context_geometry import geographic_point
from scanned_canopy import ROOT, write_tree_asset

sys.path.insert(0, str(ROOT.parents[1] / 'recon/src'))
from metaverse_recon.context.convert import frame

CREDIT = ('Fountain and statue registration: OneMap, Map Data © Singapore Land Authority and '
          '© OpenStreetMap contributors, ODbL. Photos adapted from Stamford Raffles Monument, '
          'Singapore, August 2023 by Ralff Nestor Nacor and At Singapore 2023 090 and 093 by '
          'Mike Peel. Photographs, adapted atlas and model: CC BY-SA 4.0. Paving: Poly Haven Granite Tile 04 (CC0). '
          'https://creativecommons.org/licenses/by-sa/4.0/.')
HEIGHT = 2.66
ATLAS = {'plinth':(600,0,384,500),'stone':(0,520,180,96),'bowl':(200,520,264,150),
         'rim':(490,528,224,112),'paving':(740,530,224,112),'bronze':(0,700,128,128)}


def atlas_uv(tile,uv):
    x,y,w,h=tile
    u,v=np.asarray(uv).T
    return np.column_stack(((x+2+(w-4)*u)/1024,1-(y+h-2-(h-4)*v)/1024))


def project(points,view):
    yaw=np.radians(view['yaw'])
    scale=(view['sole']-view['crown'])/HEIGHT
    return np.stack((view['centre']+scale*(points[...,0]*np.cos(yaw)+points[...,2]*np.sin(yaw)),
                     view['sole']-scale*points[...,1]),axis=-1)


def figure(views):
    # Intersect the signed silhouette fields of the frontal and two quarter
    # elevations. Negative space between the boots survives the isosurface.
    resolution=64
    grid=(np.arange(resolution)-resolution/2)*3/resolution
    z,y,x=np.meshgrid(grid,grid+HEIGHT/2,grid,indexing='ij')
    points=np.stack((x,y,z),axis=-1)
    fields=[]
    for v in views:
        mask=Image.new('L',(950,800))
        ImageDraw.Draw(mask).polygon(list(map(tuple,v['contour'])),fill=255)
        inside=np.asarray(mask)>0
        signed=distance_transform_edt(inside)-distance_transform_edt(~inside)
        coords=project(points,v)
        values=map_coordinates(signed,coords[...,::-1].transpose(3,0,1,2),order=1,cval=-100)
        fields.append(values/(v['sole']-v['crown'])*HEIGHT)
    field=gaussian_filter(np.min(fields,axis=0),.54).astype('<f4')
    # The viewer's pinned three.js dependency supplies the marching cubes tables.
    # Both processes use (z,y,x) float32 storage and the same cube resolution.
    script = """
      import fs from 'node:fs';
      import { MeshBasicMaterial } from 'three';
      import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
      const bytes = fs.readFileSync(0);
      const density = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      const mesh = new MarchingCubes(Math.round(Math.cbrt(density.length)), new MeshBasicMaterial(),
                                      false, false, 20000);
      mesh.field.set(density);
      mesh.isolation = 0;
      mesh.update();
      process.stdout.write(Buffer.from(mesh.positionArray.buffer, 0, mesh.count * 12));
    """
    raw=subprocess.run(['node','--input-type=module','-e',script],input=field.tobytes(),
                       cwd=ROOT.parents[1]/'web',capture_output=True,check=True).stdout
    points=np.frombuffer(raw,dtype='<f4').astype(float).reshape(-1,3)*1.5
    points[:,1]+=HEIGHT/2
    tris=points.reshape(-1,3,3)
    normals=np.cross(tris[:,1]-tris[:,0],tris[:,2]-tris[:,0])
    camera=np.radians([v['yaw'] for v in views])
    weights=normals[:,2,None]*np.cos(camera)-normals[:,0,None]*np.sin(camera)
    view=np.argmax(weights,axis=1)
    uvs=np.empty((len(points),2))
    for j,v in enumerate(views):
        use=np.repeat(view==j,3)
        x0,y0,x1,y1=v['crop']
        pixels=project(points[use],v)
        rect=np.clip((pixels-[x0,y0])/[x1-x0,y1-y0],0,1)
        rect[:,1]=1-rect[:,1]
        uvs[use]=atlas_uv(v['atlas'],rect)
    # Rear coat and hair are outside the photographed angles.
    back=np.repeat((normals[:,2]<0) & (weights.max(1)<=.22*np.linalg.norm(normals,axis=1)),3)
    uvs[back]=atlas_uv(ATLAS['bronze'],np.mod(points[back][:,:2]*1.4,1))
    return points,uvs


def bake():
    source=json.loads((ROOT/'references/raffles-court.json').read_text())
    config=json.loads((ROOT/'context.json').read_text())['oneMap']
    origin,rotation=frame(config)
    shift=np.asarray(json.loads((ROOT/'build/alignment.json').read_text())['shift'])
    def local(ll):
        return geographic_point(*ll,origin,rotation,shift)[[0,2]]
    pedestal=local(source['pedestal'])
    centres=np.asarray([local(ll) for ll in source['bowlCentres']])
    centre=centres.mean(axis=0)
    axis=centres[1]-centres[0]
    half_length=np.linalg.norm(axis)/2
    axis/=2*half_length
    forward=np.array([-axis[1],axis[0]])
    if np.dot(centre-pedestal,forward)<0:
        forward*=-1
    right=np.array([forward[1],-forward[0]])
    radius=np.linalg.norm(local(source['innerRadiusPoint'])-centres[1])
    datum=json.loads((ROOT/'build/environment.json').read_text())['props']['environment']['map']['origin'][1]
    ground=datum+.41
    vertices,uvs,faces=[],[],[]
    def xyz(ring,h):
        ring=np.asarray(ring)
        return np.column_stack((ring[:,0],np.broadcast_to(ground+h,len(ring)),ring[:,1]))
    def patch(points,uv):
        start=len(vertices)
        vertices.extend(points)
        uvs.extend(uv)
        faces.extend((start,start+j,start+j+1) for j in range(1,len(points)-1))
    square=np.array([[-1,-1],[1,-1],[1,1],[-1,1]])
    angles=np.linspace(0,2*np.pi,48,endpoint=False)
    circle=np.column_stack((np.cos(angles),np.sin(angles)))
    def profile(point,outline,rows):
        for (lo,lower,_),(hi,upper,tile) in zip(rows,rows[1:]):
            low=xyz(point+outline*lower,lo)
            high=xyz(point+outline*upper,hi)
            for i in range(len(outline)):
                j=(i+1)%len(outline)
                wall='plinth' if tile=='pedestal' and np.dot((outline[i]+outline[j])/2,forward)>.9 else tile
                if wall=='pedestal':wall='stone'
                subdivisions=8 if len(outline)>8 else 1
                a,b=(i%subdivisions)/subdivisions,(i%subdivisions+1)/subdivisions
                patch([low[i],low[j],high[j],high[i]],
                      atlas_uv(ATLAS[wall],[(a,0),(b,0),(b,1),(a,1)]))
    footprint=square[:,0,None]*right+square[:,1,None]*forward
    profile(pedestal,footprint,[(0,1.03,None),(.13,1.03,'paving'),(.15,.98,'rim'),
            (.28,.96,'stone'),(.33,.84,'rim'),(.42,.80,'stone'),(2.14,.76,'pedestal'),
            (2.26,.86,'stone'),(2.36,.95,'rim'),(2.41,1.01,'stone'),(2.49,1.01,'rim'),
            (2.50,.78,'stone'),(2.61,.65,'stone'),(2.62,.57,'stone'),(2.78,.55,'bronze'),
            (2.79,.005,'bronze')])
    for point in centres:
        profile(point,circle,[(.22,.40,None),(.39,.44,'bowl'),(.52,.58,'bowl'),(.68,.83,'bowl'),
                (.80,1.03,'bowl'),(.84,1.07,'rim'),(.88,1.03,'bowl'),(.87,.93,'bowl'),
                (.80,.76,'bowl'),(.72,.42,'bowl'),(.70,.005,'bowl')])
    # The two surveyed semicircular ends share straight tangent walls.
    a=np.linspace(-np.pi/2,np.pi/2,33)
    radial=np.vstack((np.cos(a)[:,None]*axis+np.sin(a)[:,None]*forward,
                      -np.cos(a)[:,None]*axis-np.sin(a)[:,None]*forward))
    caps=np.repeat(centres[[1,0]],len(a),axis=0)
    rows=[(.00,radius+.53),(.10,radius+.53),(.13,radius+.29),(.21,radius+.27),
          (.40,radius+.24),(.48,radius+.30),(.53,radius+.30),(.56,radius+.18),(.53,radius+.04),(.16,radius)]
    for (ya,ra),(yb,rb) in zip(rows,rows[1:]):
        low,high=xyz(caps+ra*radial,ya),xyz(caps+rb*radial,yb)
        for i in range(len(low)):
            j=(i+1)%len(low)
            patch([low[i],low[j],high[j],high[i]],atlas_uv(ATLAS['rim'],[(0,0),(1,0),(1,1),(0,1)]))
    sculpture,tex=figure(source['views'])
    horizontal=pedestal+sculpture[:,0,None]*right+sculpture[:,2,None]*forward
    points=xyz(horizontal,sculpture[:,1]+2.78)
    first=len(vertices)
    vertices.extend(points)
    uvs.extend(tex)
    faces.extend(np.arange(first,first+len(points)).reshape(-1,3))
    atlas=Image.open(ROOT/'references/raffles-court.jpg')
    stone=PBRMaterial(name='Raffles bronze, plinth and Jubilee fountain stonework',baseColorTexture=atlas,
                      metallicFactor=0,roughnessFactor=.72,doubleSided=True)
    mesh=trimesh.Trimesh(vertices=vertices,faces=faces,process=False,
                         visual=TextureVisuals(uv=uvs,material=stone))
    scene=trimesh.Scene()
    scene.add_geometry(mesh,geom_name='Empress Place monument and fountain')
    # The streamed water polygon is several metres east of the photographed
    # pool. The surveyed court covers the obsolete water and its aerial image.
    court=Polygon([local(ll) for ll in source['court']])
    floor=np.concatenate([np.asarray(tri.exterior.coords)[:3] for tri in
                          shapely.get_parts(shapely.constrained_delaunay_triangles(court))])
    stone_reference={'stonePitchMetres':[.70,.43],'colourSurvey':{'stone':[176,166,147]}}
    paving=importlib.import_module('bake-empress-lawn').ground_material(False,stone_reference)
    paving.name='Empress Place fountain court sandstone'
    surface=trimesh.Trimesh(vertices=xyz(floor,-.011),faces=np.arange(len(floor)).reshape(-1,3),
                            process=False,visual=TextureVisuals(material=paving,
                            uv=np.column_stack((floor@axis/2.8,floor@forward/2.58))))
    if surface.face_normals[:,1].mean()<0:surface.invert()
    scene.add_geometry(surface,geom_name='Surveyed fountain court')
    ring=xyz(caps+(radius+.02)*radial,.35)
    # Low-relief ripples are strongest at the two outlets.
    water_vertices=[xyz(centre[None,:],.35)[0]]
    counts=len(ring)
    water_faces=[]
    for i in range(1,10):
        t=i/9
        pts=centre+(ring[:,[0,2]]-centre)*t
        nearest=np.min(np.linalg.norm(pts[:,None,:]-centres[None,:,:],axis=2),axis=1)
        water_vertices.extend(xyz(pts,.35+.013*np.sin(nearest*12)*np.exp(-nearest*.53)))
        offset=1+(i-1)*counts
        for j in range(counts):
            k=(j+1)%counts
            if i==1:water_faces.append((0,offset+j,offset+k))
            else:water_faces.extend([(offset-counts+j,offset+j,offset+k),(offset-counts+j,offset+k,offset-counts+k)])
    water=PBRMaterial(name='Empress Place fountain water',baseColorFactor=[79,111,104,255],
                      roughnessFactor=.22,metallicFactor=.10,doubleSided=True)
    pool=trimesh.Trimesh(vertices=water_vertices,faces=water_faces,process=False,
                         visual=TextureVisuals(material=water))
    if pool.face_normals[:,1].mean()<0:pool.invert()
    scene.add_geometry(pool,geom_name='Fountain water')
    digest,bounds=write_tree_asset(scene,copyright=CREDIT)
    return dict(entityId='bay.raffles-statue-fountain',kind='structure',layer='ext',
                label='皇后坊 · 莱佛士铜像与双碗喷泉',regionId='marina-bay-exterior',assetHash=digest,
                bounds=bounds,material={'shading':'albedo'},props={'background':True,'测量':source['ortho'],
                '地图依据':[source['fountain'],source['monument']],'材质版权':CREDIT,
                '重建说明':'两只喷泉与雕像基座按影像配准。铜像由三个实拍角度重建，背部、基座高度和水位为估值。'})


if __name__=='__main__':
    row=bake()
    path=ROOT/'build/streetscape.json'
    rows={e['entityId']:e for e in json.loads(path.read_text())}
    rows[row['entityId']]=row
    path.write_text(json.dumps(list(rows.values()),ensure_ascii=False,indent=2)+'\n')
    print(row['assetHash'])
