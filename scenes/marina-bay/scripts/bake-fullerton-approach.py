"""Fit the One Fullerton entrance paving and its dark stone inlays to the orthophoto."""

import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
# The two margins of the clear paving, read in the same shoreline frame as the
# registered inlays. The last row meets the surveyed curve of the entrance jambs.
SECTIONS = [(3.477, 89.25, 104.55), (5.75, 90.00, 104.94), (7.85, 91.16, 106.16),
            (9.85, 92.45, 108.43), (11.85, 93.70, 110.55), (13.70, 95.03, 111.85)]
THRESHOLD = [(96, 16.268), (100.25, 15.704), (105.38, 15.255), (110.40, 15.065), (112.9, 15.14)]


def paving_material(basis):
    rows, cols = 640, 768
    y, x = np.indices((rows, cols))
    # Two staggered accent stones per repeat. Two repeats in each direction
    # keep the underlying cut-stone grain varied without a second draw.
    u, v = (x+.5)*2/cols, (rows-y-.5)*2/rows
    wx, wz = np.linalg.norm(basis, axis=1)
    a, b = 5*u, 4*v
    ia, ib = np.floor(a).astype(int), np.floor(b).astype(int)
    rng = np.random.default_rng(125)
    tones = rng.uniform(-7,7,(10,8))[ia,ib]
    scan = np.asarray(Image.open(ROOT.parents[1]/'web/src/assets/geography/pavers-color.webp').convert('RGB'),
                      float)
    grain = scan[45:160,60:175] @ [.2126,.7152,.0722]
    grain -= grain.mean()
    grain = grain[((b-ib)*114).astype(int), ((a-ia)*114).astype(int)]
    # Quarter-metre inserts and narrow joints estimated from the daylight photo.
    square = np.full(u.shape, np.inf)
    for phase in [0,.5]:
        du = wx*np.abs(u-phase-np.rint(u-phase))
        dv = wz*np.abs(v-phase-np.rint(v-phase))
        square = np.minimum(square, np.maximum(du,dv)-.135)
    inset = np.clip(.5-square/.007,0,1)
    grout = np.minimum(abs(a-np.rint(a))*wx/5, abs(b-np.rint(b))*wz/4)
    joint = np.maximum((1-inset)*np.clip(1-grout/.007,0,1),np.clip(1-abs(square)/.006,0,1))
    color = ((1-inset[:,:,None])*[170,166,157] + inset[:,:,None]*[81,80,78]
             + (tones + .5*grain-27*joint)[:,:,None])
    albedo = Image.fromarray(np.uint8(np.clip(color,0,255)))
    albedo.format = 'JPEG'
    relief = -.0034*joint+.000014*grain
    dy,dx = np.gradient(relief,2*wz/rows,2*wx/cols)
    normal = np.dstack((-dx,dy,np.ones_like(dx)))
    normal /= np.linalg.norm(normal,axis=2,keepdims=True)
    normals = Image.fromarray(np.uint8((normal+1)*127.5)).resize((384,320),Image.Resampling.LANCZOS)
    normals.format = 'PNG'
    rough = np.uint8(np.clip(205-23*inset+22*joint+.24*grain,120,250))
    packed = Image.fromarray(np.dstack((np.full_like(rough,255),rough,np.zeros_like(rough))))
    return PBRMaterial(name="Fullerton plaza stone and inlays",baseColorTexture=albedo,
                       normalTexture=normals,metallicRoughnessTexture=packed.resize((384,320),Image.Resampling.BOX),
                       metallicFactor=0,roughnessFactor=1)


def bake():
    reference = json.loads((ROOT/'references/fullerton-entrance-paving.json').read_text())
    centres = np.array(reference['centres'])
    origin, first, second = np.linalg.lstsq(np.c_[np.ones(len(centres)),centres[:,2:]],
                                            centres[:,:2],rcond=None)[0]
    basis = np.array([first+second,first-second])
    inverse = np.linalg.inv(basis)
    quay = json.loads((ROOT/'context.json').read_text())['quay']
    start,end = np.array(quay['start']),np.array(quay['end'])
    along = end-start
    along[1] = 0
    length = np.linalg.norm(along)
    along /= length
    inland = along[[2,1,0]]*[1,0,-1]
    coords = []
    for x,low,high in SECTIONS:
        coords.append(np.array([(x,s) for s in np.linspace(low,high,9)]))
    survey = np.array(THRESHOLD)
    ss = np.sort(np.r_[survey[:,0],(survey[:-1,0]+survey[1:,0])/2])
    coords.append(np.column_stack((np.interp(ss,survey[:,0],survey[:,1]),ss)))
    coords = np.asarray(coords)
    x,s = coords.reshape(-1,2).T
    walk = .285+(end[1]-start[1])*s/length
    face = np.interp(s,survey[:,0],survey[:,1])
    t = np.clip((x-SECTIONS[0][0])/(face-SECTIONS[0][0]),0,1)
    height = walk*(1-t) - .245*t
    world = start + x[:,None]*inland + s[:,None]*along
    world[:,1] += height
    # Keep the sides joined to the underlying plaza at the exposed cut edges.
    uv = (np.column_stack((x,s))-origin) @ inverse / 2
    vertices, texture = list(world),list(uv)
    faces = []
    width = coords.shape[1]
    for row in range(len(coords)-1):
        for col in range(width-1):
            a = row*width+col
            faces.extend([(a,a+1,a+width+1),(a,a+width+1,a+width)])
        for col in (0,width-1):
            a,b = row*width+col,(row+1)*width+col
            ids = []
            for idx in [a,b]:
                bottom = world[idx].copy()
                bottom[1] = start[1]-.28
                ids.append(len(vertices))
                vertices.append(bottom)
                texture.append(uv[idx]+[0,(bottom[1]-world[idx,1])/(2*np.linalg.norm(basis[1]))])
            triangles = [(a,b,ids[1]),(a,ids[1],ids[0])]
            faces.extend([f[::-1] for f in triangles] if col else triangles)
    mesh = trimesh.Trimesh(vertices=vertices,faces=faces,
                           visual=TextureVisuals(uv=texture,material=paving_material(basis)),process=False)
    if mesh.face_normals[0,1]<.98:
        raise ValueError('Expected a gently graded, upward-facing approach')
    low,high = mesh.bounds.copy()
    anchor = (low+high)/2
    anchor[1]=low[1]
    mesh.apply_translation(-anchor)
    data = trimesh.exchange.gltf.export_glb(trimesh.Scene(mesh),include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT/'assets'/(digest+'.glb')).write_bytes(data)
    return dict(entityId='bay.fullerton-entrance-approach',kind='structure',layer='ext',regionId='marina-bay-exterior',
                label='One Fullerton · 临水入口广场',assetHash=digest,bounds={'min':low.tolist(),'max':high.tolist()},
                material={'shading':'albedo'},props={'background':True,'影像来源':reference['attribution'],
                    '现场照片':'https://commons.wikimedia.org/wiki/File:Singapore_-_panoramio_(109).jpg',
                    '材质来源':'Poly Haven · Granite Tile 04 · CC0',
                    '入口广场':'由 OneMap 正射影像中的 35 个嵌石中心拟合铺装排列，可见边线依影像估读。石缝、色泽和遮挡范围内的铺排为估值。坡面衔接场景既有步道与门槛标高。'})


if __name__ == '__main__':
    record=bake()
    path=ROOT/'build/streetscape.json'
    records={e['entityId']:e for e in json.loads(path.read_text())}
    records[record['entityId']]=record
    path.write_text(json.dumps(list(records.values()),indent=2,ensure_ascii=False)+'\n')
    print(record['assetHash'])
