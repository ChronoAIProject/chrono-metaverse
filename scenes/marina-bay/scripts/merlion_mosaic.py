"""Register the glazed waves beneath the Merlion to the measured SLA shell."""

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates, gaussian_filter


# Inside the exposed mosaic at each column of the registered photo crop.
# Exclude the sculpture's feet, people on the promenade and the granite coping.
OUTLINE = np.array([
    [9,254,265], [26,238,264], [52,228,264], [76,213,264], [107,195,263],
    [131,171,263], [158,148,264], [190,119,263], [225,91,263],
    [255,72,263], [295,60,263], [336,55,264], [384,51,265],
    [426,54,265], [478,60,265], [531,70,267], [588,85,268],
    [633,100,268], [688,109,267], [720,104,267], [747,68,264],
    [777,63,264], [805,69,263], [834,78,263], [867,84,263],
    [898,111,261], [918,116,258], [943,140,256], [968,154,256],
    [991,164,255], [1020,188,256], [1045,205,253], [1062,224,253]
], dtype=float)


def photographed_tiles(reference):
    src = np.asarray(Image.open(reference).convert('RGB'), dtype=float)
    if src.shape != (305, 1080, 3):
        raise ValueError('Expected the registered CC0 2018 mosaic crop')
    v, u = np.indices((384,1024),dtype=float)
    col = np.interp(u/1023, [0,1], [OUTLINE[0,0],OUTLINE[-1,0]])
    top = np.interp(col,OUTLINE[:,0],OUTLINE[:,1])
    bottom = np.interp(col,OUTLINE[:,0],OUTLINE[:,2])
    row = top+(bottom-top)*v/383
    # A removable spotlight obscures three rows of tile next to the right foot.
    # Continue those rows from the neighbouring flank at their local inclination.
    lamp = ((col-875)/53)**2+((row-232+.62*(col-875))/30)**2
    mix = np.clip((1.35-lamp)/.35,0,1)
    def sample(x,y):
        return np.stack([map_coordinates(channel,[y,x],order=1,mode='nearest')
                         for channel in src.transpose(2,0,1)],axis=-1)
    rgb = sample(col,row)*(1-mix[...,None]) + sample(col-84,row+11)*mix[...,None]
    lum = rgb @ [.2126,.7152,.0722]
    # Retain the glaze, weathering and photographed joints. Cap the broad
    # lighting gradient so the daytime material can receive the scene's shadows.
    rgb *= (1 + .16*(154-gaussian_filter(lum,22))/200)[...,None]
    return rgb*.94


def wave_surface(reference, positions, faces, normals):
    photo=photographed_tiles(reference)
    tris=positions[faces]
    seen=set()
    unique=[]
    for i,tri in enumerate(tris):
        key=tuple(sorted(map(tuple,tri)))
        if key not in seen:
            unique.append(i)
            seen.add(key)
    forward=np.array([-np.cos(np.deg2rad(34.5)),0,np.sin(np.deg2rad(34.5))])
    lateral=np.cross([0,1,0],forward)
    def project(xyz,mirror):
        along=xyz@forward
        side=xyz@lateral-.12
        if mirror:
            side=np.abs(side)
        yaw=np.deg2rad(47)
        depth=along*np.cos(yaw)+side*np.sin(yaw)
        return np.stack([-along*np.sin(yaw)+side*np.cos(yaw),-xyz[...,1]+depth*.12],axis=-1)

    # For each horizontal ray, record the photographed sculpture's lower and
    # upper extents. Match both silhouettes before sampling the photographed tiles.
    projected=project(tris[unique],False)
    lo,hi=projected[:,:,0].min(),projected[:,:,0].max()
    xs=np.linspace(lo,hi,1024)
    top=np.full_like(xs,np.inf)
    bottom=np.full_like(xs,-np.inf)
    for tri in projected:
        for a,b in zip(tri,np.roll(tri,-1,axis=0)):
            if abs(b[0]-a[0])<1e-8:
                continue
            part=(xs>=min(a[0],b[0]))&(xs<=max(a[0],b[0]))
            height=a[1]+(xs[part]-a[0])/(b[0]-a[0])*(b[1]-a[1])
            top[part]=np.minimum(top[part],height)
            bottom[part]=np.maximum(bottom[part],height)
    good=(bottom-top)>.001
    top=np.interp(xs,xs[good],top[good])
    bottom=np.interp(xs,xs[good],bottom[good])
    # Unwrap each measured face in metres. The projected photo remains sharp
    # on the visible flank; on the hidden back continue the tile courses around
    # the original cross section instead of projecting through its front faces.
    samples=104
    gutter=5
    sheets=[]
    for index in unique:
        tri=tris[index]
        edge=tri[1]-tri[0]
        normal=np.cross(edge,tri[2]-tri[0])
        if np.linalg.norm(normal)<1e-7:
            continue
        edge=edge/np.linalg.norm(edge)
        vertical=np.cross(normal/np.linalg.norm(normal),edge)
        st=np.stack([(tri-tri[0])@edge,(tri-tri[0])@vertical],axis=1)
        minimum=st.min(0)
        width,height=np.ceil((st.max(0)-minimum)*samples).astype(int)+2*gutter+1
        sheets.append((height,width,index,st,minimum,edge,vertical))
    sheets.sort(key=lambda sheet:(-sheet[0],sheet[2]))
    atlas_width=1536
    start_x=start_y=shelf=0
    packed=[]
    for height,width,index,st,minimum,edge,vertical in sheets:
        if start_x+width>atlas_width:
            start_y+=shelf
            start_x=shelf=0
        packed.append((start_x,start_y,width,height,index,st,minimum,edge,vertical))
        start_x+=width
        shelf=max(shelf,height)
    atlas_height=start_y+shelf
    color=np.zeros((atlas_height,atlas_width,3),dtype=np.uint8)
    normal_map=np.zeros_like(color)
    surface=np.zeros_like(color)
    pos=[]; norms=[]; uv=[]
    for x,y,width,height,index,st,minimum,edge,vertical in packed:
        iy,ix=np.indices((height,width),dtype=float)
        ds=(ix-gutter)/samples+minimum[0]
        dt=(iy-gutter)/samples+minimum[1]
        xyz=tris[index,0]+ds[...,None]*edge+dt[...,None]*vertical
        projected=project(xyz,True)
        u=np.clip((projected[...,0]-lo)/(hi-lo),0,1)
        a,b=np.interp(projected[...,0],xs,top),np.interp(projected[...,0],xs,bottom)
        v=np.clip((projected[...,1]-a)/np.maximum(.008,b-a),0,1)
        coords=[v*(photo.shape[0]-1),u*(photo.shape[1]-1)]
        sampled=np.stack([map_coordinates(channel,coords,order=1,mode='nearest')
                          for channel in photo.transpose(2,0,1)],axis=-1)
        along=xyz@forward
        side=xyz@lateral-.12
        theta=np.arctan2(side/1.93,(along-.15)/3.76)
        radius=np.hypot((along-.15)/3.76,side/1.93)
        up=(xyz[...,1]-2.7136)*.85+np.clip(1-radius,0,1)*1.15
        phase=(up/.79+.48*np.cos(theta*2+.35)+.22*np.cos(theta*4-.3))%1
        # Alternating cobalt, turquoise and pale ceramic courses are estimated
        # from the exposed right flank. Their joints follow the circumference.
        stops=[0,.20,.23,.42,.45,.71,.74,.96,1]
        shades=np.array([[72,100,164],[81,113,175],[157,170,186],[179,183,184],
                         [107,147,177],[93,135,174],[194,189,174],[184,184,176],[72,100,164]])
        glaze=np.stack([np.interp(phase,stops,c) for c in shades.T],axis=-1)
        course=up/.111
        tile=theta/(2*np.pi)*160 + .28*(np.floor(course)%2)
        dist=np.minimum(np.abs((tile+.5)%1-.5)*.12,np.abs((course+.5)%1-.5)*.111)
        joint=np.clip((.005-dist)/.004,0,1)
        tone=np.sin(np.floor(tile)*35.17+np.floor(course)*20.61)*4
        glaze+=tone[...,None]
        glaze=glaze*(1-.30*joint[...,None])
        # Hide the tangent strip on the rear and correct the inaccessible area
        # behind the portable spotlight with measured-scale tiles.
        rear=np.clip((-along-.95)/1.03,0,1)
        rear=rear**2*(3-2*rear)
        rgb=sampled*(1-rear[...,None])+glaze*rear[...,None]
        lum=rgb@[.2126,.7152,.0722]
        trough=np.clip((gaussian_filter(lum,1.4)-lum)/35,0,1)*(1-rear)+joint*rear
        dy,dx=np.gradient(-.0025*trough,1/samples)
        ns=np.stack([-dx,dy,np.ones_like(dx)],axis=-1)
        ns/=np.linalg.norm(ns,axis=-1)[...,None]
        rect=np.s_[y:y+height,x:x+width]
        color[rect]=np.uint8(np.clip(rgb,0,255))
        normal_map[rect]=np.uint8(np.clip((ns*.5+.5)*255,0,255))
        orm=np.stack([1-.10*trough,.43+.31*trough,np.zeros_like(lum)],axis=-1)
        surface[rect]=np.uint8(np.clip(orm*255,0,255))
        pos.extend(tris[index])
        norms.extend(normals[faces[index]])
        uv.extend(((st-minimum)*samples+[x+gutter+.5,y+gutter+.5])/[atlas_width,atlas_height])
    return (np.array(pos),np.array(norms),np.array(uv),
            [Image.fromarray(im) for im in [color,normal_map,surface]])
