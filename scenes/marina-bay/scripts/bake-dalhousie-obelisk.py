"""Rebuild the measured Dalhousie Obelisk with stepped granite and four heritage lamps."""
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from scanned_canopy import ROOT, write_tree_asset

ID = 'bay.7e5ef1c9-f724-4350-b289-142d7b03b701'
ORIGINAL = '22805157c69c280625c8cb2ee4ace6bc8f5ce3c76920f1afa9a40d4099852d26'
CREDIT = ('Geometry reconstructed from OneMap, Map Data © Singapore Land Authority. Photographic '
          'textures cropped and rectified from At Singapore 2023 112 by Mike Peel (CC BY-SA 4.0, '
          'https://commons.wikimedia.org/wiki/File:At_Singapore_2023_112.jpg) and Daihousie Obelisk 2 '
          'by Terence Ong (CC BY 2.5, https://commons.wikimedia.org/wiki/File:Daihousie_Obelisk_2.JPG). '
          'Adapted texture atlas and model distributed under CC BY-SA 4.0, '
          'https://creativecommons.org/licenses/by-sa/4.0/.')
# Pixel rectangles in the rectified photograph atlas, inset to protect the UV seams.
TILES = {'plaster':(518,310,579,372),'front':(2,2,253,477),'side':(258,2,508,477),
         'frieze':(515,2,765,77),'shaft':(770,3,892,476),'riser':(514,98,765,157),
         'tread':(514,178,765,237),'iron':(2,514,237,749),'rosette':(266,514,357,605),
         'glass':(386,514,477,637)}
PALETTE = {'plaster':[235,232,225], 'cornice':[107,110,109], 'post':[215,212,198], 'edge':[66,70,68]}
SQUARE = np.array([[-1,-1],[1,-1],[1,1],[-1,1]],float)


def obelisk_mesh(texture):
    xyz,uv,colours,faces = [],[],[],[]

    def quad(points,tile,tint):
        a,b,c,d = TILES[tile]
        offset = len(xyz)
        xyz.extend(points)
        uv.extend([(a/1024,1-d/1024),(a/1024,1-b/1024),(c/1024,1-b/1024),(c/1024,1-d/1024)])
        colours.extend([tint]*4)
        faces.extend([[offset,offset+1,offset+2],[offset,offset+2,offset+3]])

    def course(bottom,top,tile='plaster',tint=(255,255,255)):
        for i in range(len(bottom)):
            j=(i+1)%len(bottom)
            name=tile[i] if isinstance(tile,list) else tile
            quad([bottom[i],top[i],top[j],bottom[j]],name,tint)

    def ring(center,polygon,radius,height):
        xz=np.asarray(center)+polygon*radius
        return np.column_stack((xz[:,0],np.full(len(xz),height),xz[:,1]))

    def profile(center,polygon,heights):
        for (y,r,_,_),(yy,rr,tile,tint) in zip(heights,heights[1:]):
            course(ring(center,polygon,r,y),ring(center,polygon,rr,yy),tile,tint)

    white=PALETTE['plaster']
    stone=[218,218,216]
    # Nine successive risers surround the landing. The four white piers cross
    # the diagonal corners of the steps as they do in ground-level photographs.
    outside,landing=4.02,1.80
    for i in range(9):
        r=outside+(landing-outside)*i/9
        inner=outside+(landing-outside)*(i+1)/9
        h=1.76*(i+1)/9
        course(ring([0,0],SQUARE,r,h-1.76/9),ring([0,0],SQUARE,r,h),'riser',stone)
        course(ring([0,0],SQUARE,r,h),ring([0,0],SQUARE,inner,h),'tread',stone)
    top=ring([0,0],SQUARE,landing,1.76)
    quad(top[[0,3,2,1]],'tread',stone)

    profile([0,0],SQUARE,[(1.76,1.52,None,None),(1.86,1.52,'plaster',white),
            (1.93,1.46,'plaster',white),(2.52,1.46,'plaster',white),(2.57,1.40,'plaster',white),
            (5.26,1.40,['front','side','front','side'],[253,251,244]),(5.33,1.45,'plaster',white),
            (5.60,1.45,'frieze',white),(5.64,1.52,'plaster',PALETTE['cornice']),
            (5.72,1.55,'plaster',PALETTE['cornice']),(5.77,1.60,'plaster',stone),
            (5.85,1.63,'plaster',PALETTE['cornice']),(5.88,1.05,'plaster',white),
            (6.22,1.05,'plaster',white),(6.35,.88,'plaster',white),
            (16.946,.69,'shaft',[251,251,242]),(18.055,.003,'plaster',white)])
    octagon=np.column_stack((np.cos(np.arange(8)*np.pi/4),np.sin(np.arange(8)*np.pi/4)))
    for direction in SQUARE:
        radial=direction/np.sqrt(2)
        tangent=np.array([-radial[1],radial[0]])
        pier_center=direction*3.28
        # Each pier has a narrow drip edge and a level cap supporting the lamp.
        pier=SQUARE[:,0,None]*radial*1.45+SQUARE[:,1,None]*tangent*.64
        profile(pier_center,pier,[(0,1,None,None),(1.58,1,'plaster',white),
                (1.64,1.045,'plaster',white),(1.72,1.055,'plaster',white),
                (1.76,1.035,'plaster',white)])
        cap=ring(pier_center,pier,1.035,1.76)
        quad(cap[[0,3,2,1]],'plaster',white)
        lamp=direction*3.74
        post=PALETTE['post']
        profile(lamp,SQUARE,[(1.76,.31,None,None),(1.81,.32,'plaster',white),
                (1.87,.29,'plaster',white),(2.43,.19,'iron',white),
                (2.48,.21,'plaster',white),(2.53,.15,'plaster',white)])
        profile(lamp,octagon,[(2.52,.14,None,None),(2.62,.155,'rosette',post),
                (2.73,.13,'rosette',post),(2.78,.074,'plaster',post),
                (2.91,.057,'plaster',post),(2.94,.075,'plaster',post),
                (3.27,.05,'plaster',post),(3.30,.071,'plaster',post),
                (3.50,.041,'plaster',post),(3.55,.069,'plaster',post)])
        profile(lamp,SQUARE,[(3.54,.066,None,None),(3.62,.125,'plaster',PALETTE['edge']),
                (3.68,.131,'plaster',PALETTE['edge']),(3.96,.176,'glass',white),
                (3.98,.19,'plaster',PALETTE['edge']),(4.02,.18,'plaster',PALETTE['edge']),
                (4.115,.078,'plaster',PALETTE['cornice']),(4.14,.025,'plaster',PALETTE['edge'])])
        for corner in SQUARE:
            # Separate metal glazing bars sit proud of the four panes.
            low=ring(lamp+corner*.127,SQUARE,.009,3.67)
            high=ring(lamp+corner*.174,SQUARE,.009,3.96)
            course(low,high,'plaster',PALETTE['edge'])

    points=np.array(xyz)
    # Lower and upper shaft corners in the survey fix the obelisk compass.
    axis=np.array([1.706,.323])
    axis/=np.linalg.norm(axis)
    points[:,[0,2]]=points[:,[0,2]]@np.array([axis,[-axis[1],axis[0]]])
    paint=PBRMaterial(name='Dalhousie granite, plaster and heritage lamps',baseColorTexture=texture,
                      metallicFactor=0,roughnessFactor=.82)
    mesh=trimesh.Trimesh(vertices=points,faces=faces,visual=TextureVisuals(uv=uv,material=paint),process=False)
    mesh.visual.vertex_attributes['color']=np.column_stack((colours,np.full(len(colours),255))).astype(np.uint8)
    return mesh


def bake():
    path=ROOT/'build/onemap-entities.json'
    rows=json.loads(path.read_text())
    row=next(e for e in rows if e['entityId']==ID)
    # The upper shaft axis measured in the original mesh is offset 15 cm from
    # the bounding-box centre. Use the fixed survey datum on every re-bake.
    mesh=obelisk_mesh(Image.open(ROOT/'references/dalhousie-obelisk-surfaces.jpg'))
    mesh.apply_translation([546.7594085,-60.055826,622.370655])
    scene=trimesh.Scene()
    scene.add_geometry(mesh,geom_name='Dalhousie Obelisk')
    digest,bounds=write_tree_asset(scene,copyright=CREDIT)
    row.update(assetHash=digest,bounds=bounds,label='达尔豪西纪念碑 · Dalhousie Obelisk',
               material={'shading':'albedo'})
    row['props'].update({'三角形数':len(mesh.faces),'原模型哈希':ORIGINAL,'影像署名':CREDIT,
                        '造型依据':'碑顶与轴向按 OneMap 测量模型。九级石阶、四角石墩、灯柱和灰塑檐口按现场照片估读。两处拍到的墙面纹饰用于四面近似。'})
    path.write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
    print(digest)


if __name__=='__main__':
    bake()
