"""Fit small textured branch clusters to a scanned spreading crown."""
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, gaussian_filter


def branch_sprays(points, colours, canopy):
    cloud = points[canopy]
    rgb = colours[canopy]
    # Oblique cells cut across branches at different heights, avoiding
    # horizontal layers across the full crown. Include the scanned fine wood.
    basis, _ = np.linalg.qr(np.array([[.77,.39,-.42],[-.31,.91,.22],[.56,.11,.88]]))
    keys = np.floor(cloud @ basis / .175).astype(int)
    _, groups, count = np.unique(keys, axis=0, return_inverse=True, return_counts=True)
    ordered = np.argsort(groups)
    partitions = np.split(ordered, np.cumsum(count)[:-1])
    clusters = [idx for idx in partitions if len(idx) >= 90]
    tile = 64
    cols = int(np.ceil(np.sqrt(len(clusters)*2)))
    rows = (len(clusters)*2+cols-1)//cols
    atlas = Image.new('RGBA',(cols*tile,rows*tile))
    vertices, normals, uv, faces = [], [], [], []
    rng = np.random.default_rng(9109)
    for j,idx in enumerate(clusters):
        scan = cloud[idx]
        center = scan.mean(0)
        local = scan-center
        # Two crossed views share the scanned branch axis. Orient it by the
        # largest local extent rather than by the whole tree's coordinate axes.
        _, vectors = np.linalg.eigh(local.T @ local)
        stem = vectors[:,2]
        lateral = vectors[:,1]
        for view in range(2):
            across = lateral if view==0 else np.cross(stem,lateral)
            normal = np.cross(stem,across)
            xy = local @ np.stack([stem,across]).T
            lo,hi = xy.min(0),xy.max(0)
            span = np.maximum(hi-lo,.001)
            st = (xy-lo)/span
            pix = np.rint(3+st*(tile-7)).astype(int)
            flat = (tile-1-pix[:,1])*tile+pix[:,0]
            density = np.bincount(flat,minlength=tile*tile).reshape(tile,tile)
            colour = np.stack([np.bincount(flat,weights=rgb[idx,i],minlength=tile*tile)
                               for i in range(3)],axis=-1).reshape(tile,tile,3)
            density = gaussian_filter(density.astype(float),.48)
            colour = gaussian_filter(colour,(.48,.48,0))/np.maximum(density[:,:,None],.0001)
            filled = density > .24
            nearest = distance_transform_edt(~filled,return_indices=True,return_distances=False)
            colour = colour[tuple(nearest)]
            # Sparse pixels at branch tips remain partly transparent so holes
            # between small sprays survive alpha testing and mipmapping.
            alpha = np.clip(1-np.exp(-density*.76),0,1)
            rgba = np.dstack((np.uint8(np.clip(colour,0,255)),np.uint8(255*alpha)))
            col,row = (j*2+view)%cols,(j*2+view)//cols
            atlas.paste(Image.fromarray(rgba),(col*tile,row*tile))
            depth = local@normal
            offset = len(vertices)
            depths = []
            for a,b in [(0,0),(1,0),(1,1),(0,1),(.5,.5)]:
                weight = np.exp(-np.sum((st-[a,b])**2,axis=1)/.07)
                z = np.average(depth,weights=weight)
                depths.append(z)
                vertices.append(center+(lo[0]+a*span[0])*stem+(lo[1]+b*span[1])*across+z*normal)
                shade = center-[.5,.37,.5]
                shade[1] = max(.13,shade[1])+rng.uniform(-.018,.018)
                normals.append(shade/np.linalg.norm(shade))
                uv.append([(col+(3+a*(tile-7))/tile)/cols,1-(row+(tile-4-b*(tile-7))/tile)/rows])
            # Flat sprays need only the two corner triangles. Use the centre
            # sample where a linear patch would move the branch visibly.
            if abs(depths[4]-(depths[0]+depths[2])*.5) < .011:
                triangles = [(0,1,2),(0,2,3)]
            else:
                triangles = [(i,(i+1)%4,4) for i in range(4)]
            for local_face in triangles:
                tri = tuple(offset+i for i in local_face)
                faces.extend([tri,tri[::-1]])
    atlas.format = 'PNG'
    return tuple(map(np.asarray,(vertices,uv,normals,faces))),atlas
