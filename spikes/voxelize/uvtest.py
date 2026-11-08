import sys, numpy as np, DracoPy
from PIL import Image
Image.MAX_IMAGE_PIXELS=None
m = DracoPy.decode(open(sys.argv[1],'rb').read())
V=np.asarray(m.points,float).reshape(-1,3); F=np.asarray(m.faces).reshape(-1,3); UV=np.asarray(m.tex_coord,float).reshape(-1,2)
tex=np.asarray(Image.open(sys.argv[2]).convert('RGB')).astype(float); H,W=tex.shape[:2]
print('uv range', UV.min(0).round(3), UV.max(0).round(3))
a,b,c=V[F[:,0]],V[F[:,1]],V[F[:,2]]; n=np.cross(b-a,c-a); n/=np.linalg.norm(n,axis=1,keepdims=True)+1e-12
cent=(a+b+c)/3
floor=(np.abs(n[:,1])>0.9)&(cent[:,1]<0.15)
# within-triangle consistency: sample 3 points per triangle, measure color diff between them (correct mapping -> neighbouring texels similar)
f=F[floor][:20000]
def look(T,mode):
    u,v=T[:,0],T[:,1]
    if mode=='flipv': v=1-v
    if mode=='swap': u,v=v,u
    if mode=='swap_flipv': u,v=v,1-u
    px=np.clip((u*W).astype(int),0,W-1); py=np.clip((v*H).astype(int),0,H-1); return tex[py,px]
cuv=(UV[f[:,0]]+UV[f[:,1]]+UV[f[:,2]])/3
p1=(UV[f[:,0]]*0.6+UV[f[:,1]]*0.2+UV[f[:,2]]*0.2); p2=(UV[f[:,0]]*0.2+UV[f[:,1]]*0.6+UV[f[:,2]]*0.2)
for mode in ['none','flipv','swap','swap_flipv']:
    c0=look(cuv,mode); c1=look(p1,mode); c2=look(p2,mode)
    d=np.abs(c0-c1).mean()+np.abs(c0-c2).mean()
    print(f'{mode:11s} intra-tri diff {d:6.2f}  floor mean rgb {c0.mean(0).round(1)}  std {c0.std(0).round(1)}')
