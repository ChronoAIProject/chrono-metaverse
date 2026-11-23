"""Woven dining pendants fitted between the measured rafters at One Fullerton."""

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals


def pendant_material():
    # The left half wraps the basket, the remaining strips hold bindings,
    # suspension hardware and the small warm diffuser. All share one draw.
    size = 256
    row, col = np.indices((size, size))
    u, v = (col + .5) / size, (row + .5) / size
    weave_u = u * 2 * 22
    weave_v = v * 6
    warp = np.abs((weave_u + weave_v) % 1 - .5)
    weft = np.abs((weave_u - weave_v) % 1 - .5)
    distance = np.minimum(warp, weft)
    rounded = np.sqrt(np.clip(1 - (distance/.115)**2, 0, 1))
    variance = np.sin(np.floor(weave_u+weave_v) * 16.81 + np.floor(weave_u-weave_v))
    shade = .76 + .19*rounded + .045*variance
    rgba = np.zeros((size,size,4),dtype='uint8')
    rgba[:,:,:3] = np.uint8(shade[..., None] * [174,128,73])
    rgba[:,:,3] = np.uint8(255*np.clip((.14-distance)*28,0,1))
    for lo,hi,color in [(.5,.64,[143,103,59]),(.64,.78,[53,47,40]),(.78,1,[248,226,193])]:
        region=(u>=lo)&(u<hi)
        rgba[region]=[*color,255]
    emission=np.zeros((size,size,3),dtype='uint8')
    emission[u>=.78]=[253,210,150]
    diffuse=Image.fromarray(rgba)
    glow=Image.fromarray(emission)
    diffuse.format=glow.format='PNG'
    return PBRMaterial(name='Woven pendant and diffuser',baseColorTexture=diffuse,
                       emissiveTexture=glow,emissiveFactor=[.65,.49,.32],
                       metallicFactor=0,roughnessFactor=.74,doubleSided=True,
                       alphaMode='MASK',alphaCutoff=.44)


def pendants(ends):
    vertices, uv, faces = [], [], []
    def revolve(center, profile, texture, sides):
        first = len(vertices)
        for i,(height,radius) in enumerate(profile):
            for j in range(sides+1):
                turn=j/sides
                angle=turn*2*np.pi
                vertices.append([center[0]+radius*np.cos(angle),height,center[1]+radius*np.sin(angle)])
                uv.append([.004+.488*turn if texture is None else texture,
                           .014+.972*i/(len(profile)-1)])
                if i and j:
                    k=first+i*(sides+1)+j
                    faces.extend([[k-sides-2,k-1,k],[k-sides-2,k,k-sides-1]])
    first,last=ends
    for line, fraction in enumerate([.21,.79]):
        # The photo resolves two rows. Use the recorded roof slopes to set
        # the cord length over each table, with a clear route below the basket.
        for index in range(8 if line==0 else 6):
            t=(index+.55)/(8 if line==0 else 6)
            eave,ridge,back=first+t*(last-first)
            x=eave[0]+fraction*(back[0]-eave[0])
            a,b=(eave,ridge) if x<ridge[0] else (ridge,back)
            socket=a+(b-a)*(x-a[0])/(b[0]-a[0])
            center=(x,socket[2])
            bottom=2.17+.05*np.cos((index+line)*1.4)
            scale=.93+.07*np.sin(index*2.8+line)
            profile=[(bottom+h*scale,r*scale) for h,r in
                     [(0,.166),(.022,.194),(.092,.244),(.19,.248),(.26,.216),
                      (.33,.151),(.38,.074),(.388,.045)]]
            revolve(center,profile,None,16)
            revolve(center,[(bottom-.003,.167*scale),(bottom+.013,.177*scale)],.57,16)
            top=profile[-1][0]
            revolve(center,[(top,.043),(top+.037,.04),(top+.044,.009)],.71,12)
            revolve(center,[(top+.04,.006),(socket[1]-.014,.006)],.71,5)
            bulb=[(bottom+h*scale,r*scale) for h,r in
                  [(.058,.003),(.077,.035),(.116,.055),(.164,.053),(.211,.033),(.254,.02)]]
            revolve(center,bulb,.89,8)
    mesh=trimesh.Trimesh(vertices=vertices,faces=faces,process=False)
    mesh.visual=TextureVisuals(uv=np.asarray(uv),material=pendant_material())
    return mesh
