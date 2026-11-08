"""Spike: Scaniverse Draco mesh + texture -> aligned, colored, palette-quantized voxels -> GLB files.

Usage: python voxelize.py <mesh.drc> <tex.jpg> <outdir> <voxel sizes in m...>
"""
import sys, os, json, time, numpy as np, DracoPy, trimesh
from PIL import Image
from scipy import ndimage
from scipy.cluster.vq import kmeans2

Image.MAX_IMAGE_PIXELS = None
t0 = time.time()
drc, texp, out = sys.argv[1], sys.argv[2], sys.argv[3]
sizes = [float(s) for s in sys.argv[4:]] or [0.1]
os.makedirs(out, exist_ok=True)

m = DracoPy.decode(open(drc, 'rb').read())
V = np.asarray(m.points, np.float64).reshape(-1, 3)
F = np.asarray(m.faces, np.int64).reshape(-1, 3)
UV = np.asarray(m.tex_coord, np.float64).reshape(-1, 2)
tex = np.asarray(Image.open(texp).convert('RGB'))
H, W = tex.shape[:2]

# ---- alignment: rotate about Y so dominant wall directions are grid-aligned ----
a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
n = np.cross(b - a, c - a)
area2 = np.linalg.norm(n, axis=1)
nn = n / np.maximum(area2[:, None], 1e-12)
horiz = np.abs(nn[:, 1]) < 0.3                     # wall-ish faces
ang = np.arctan2(nn[horiz, 2], nn[horiz, 0])
wts = area2[horiz]
# angles mod 90deg, histogram, pick peak
ang4 = np.mod(ang, np.pi / 2)
hist, edges = np.histogram(ang4, bins=360, range=(0, np.pi / 2), weights=wts)
hist = ndimage.uniform_filter1d(hist, 5, mode='wrap')
peak = (edges[np.argmax(hist)] + edges[np.argmax(hist) + 1]) / 2
theta = -peak
cs, sn = np.cos(theta), np.sin(theta)
R = np.array([[cs, 0, -sn], [0, 1, 0], [sn, 0, cs]])
Va = V @ R.T
floor_y = np.percentile(Va[:, 1], 1)
Va[:, 1] -= floor_y
mn = Va.min(0)
Va -= np.array([mn[0], 0, mn[2]])
print(f'align: rotate {np.degrees(theta):.2f} deg about Y; floor at {floor_y:.3f}; bbox {Va.max(0).round(2)}')

# ---- area-weighted surface sampling with texture color ----
a, b, c = Va[F[:, 0]], Va[F[:, 1]], Va[F[:, 2]]
area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
total_area = area.sum()
print(f'surface area {total_area:.1f} m2, faces {len(F)}')

def sample(density):
    cnt = np.random.default_rng(0).poisson(area * density)
    idx = np.repeat(np.arange(len(F)), cnt)
    r1 = np.random.default_rng(1).random(len(idx)); r2 = np.random.default_rng(2).random(len(idx))
    s = np.sqrt(r1); w0, w1, w2 = 1 - s, s * (1 - r2), s * r2
    f = F[idx]
    P = Va[f[:, 0]] * w0[:, None] + Va[f[:, 1]] * w1[:, None] + Va[f[:, 2]] * w2[:, None]
    T = UV[f[:, 0]] * w0[:, None] + UV[f[:, 1]] * w1[:, None] + UV[f[:, 2]] * w2[:, None]
    px = np.clip((T[:, 0] * W).astype(np.int64), 0, W - 1)
    py = np.clip((T[:, 1] * H).astype(np.int64), 0, H - 1)   # Scaniverse UVs: top-left origin
    C = tex[py, px]
    return P, C

def srgb_to_lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055) * 255

def lin_to_lab(c):
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], 1)

FACE_DIRS = [((1,0,0),[(1,0,0),(1,1,0),(1,1,1),(1,0,1)]), ((-1,0,0),[(0,0,0),(0,0,1),(0,1,1),(0,1,0)]),
             ((0,1,0),[(0,1,0),(0,1,1),(1,1,1),(1,1,0)]), ((0,-1,0),[(0,0,0),(1,0,0),(1,0,1),(0,0,1)]),
             ((0,0,1),[(0,0,1),(1,0,1),(1,1,1),(0,1,1)]), ((0,0,-1),[(0,0,0),(0,1,0),(1,1,0),(1,0,0)])]

def voxel_mesh(occ_idx, colors, size, dims):
    grid = np.zeros(dims, bool); grid[tuple(occ_idx.T)] = True
    verts, faces, vcols = [], [], []
    base = 0
    shade = {0: 0.86, 1: 0.86, 2: 1.0, 3: 0.6, 4: 0.93, 5: 0.93}
    for k, (d, quad) in enumerate(FACE_DIRS):
        nb = occ_idx + np.array(d)
        inside = np.all((nb >= 0) & (nb < np.array(dims)), 1)
        exposed = np.ones(len(occ_idx), bool)
        exposed[inside] = ~grid[tuple(nb[inside].T)]
        ids = np.nonzero(exposed)[0]
        q = np.array(quad, np.float64)
        v = (occ_idx[ids][:, None, :] + q[None]) * size          # (n,4,3)
        verts.append(v.reshape(-1, 3))
        nq = len(ids)
        fi = base + np.arange(nq)[:, None] * 4 + np.array([[0, 1, 2], [0, 2, 3]]).reshape(1, 6)
        faces.append(fi.reshape(-1, 3))
        col = np.clip(colors[ids] * shade[k], 0, 255).astype(np.uint8)
        vcols.append(np.repeat(col, 4, 0))
        base += nq * 4
    V2 = np.concatenate(verts); F2 = np.concatenate(faces); C2 = np.concatenate(vcols)
    C2 = np.concatenate([C2, np.full((len(C2), 1), 255, np.uint8)], 1)
    return trimesh.Trimesh(V2, F2, vertex_colors=C2, process=False)

stats = {'rotation_deg': float(np.degrees(theta)), 'surface_area_m2': float(total_area),
         'bbox_m': Va.max(0).round(3).tolist(), 'sizes': {}}

# original (aligned) as textured GLB, with a reduced texture for the viewer
tex_small = Image.open(texp).convert('RGB').resize((4096, 4096))
orig = trimesh.Trimesh(Va, F, process=False,
                       visual=trimesh.visual.TextureVisuals(uv=np.stack([UV[:, 0], 1 - UV[:, 1]], 1), image=tex_small))  # trimesh flips v on glTF export
orig.export(os.path.join(out, 'original.glb'))

for size in sizes:
    t1 = time.time()
    density = 9.0 / (size * size)            # ~9 samples per voxel face area
    P, C = sample(density)
    idx = np.floor(P / size).astype(np.int64)
    idx = np.maximum(idx, 0)
    dims = tuple(idx.max(0) + 1)
    key = np.ravel_multi_index(idx.T, dims)
    uniq, inv, counts = np.unique(key, return_inverse=True, return_counts=True)
    lin = srgb_to_lin(C.astype(np.float64))
    acc = np.zeros((len(uniq), 3)); np.add.at(acc, inv, lin)
    mean_lin = acc / counts[:, None]
    occ = np.stack(np.unravel_index(uniq, dims), 1)
    # cleanup: drop voxels with very few samples, then tiny connected components
    keep = counts >= 2
    occ, mean_lin, counts = occ[keep], mean_lin[keep], counts[keep]
    grid = np.zeros(dims, bool); grid[tuple(occ.T)] = True
    lab, ncomp = ndimage.label(grid, structure=np.ones((3, 3, 3)))
    compsize = np.bincount(lab.ravel())
    min_comp = max(8, int(0.15 / size) ** 2)
    good = compsize[lab[tuple(occ.T)]] >= min_comp
    occ, mean_lin = occ[good], mean_lin[good]
    raw_rgb = lin_to_srgb(mean_lin)
    # palette quantization in Lab
    K = 64
    labc = lin_to_lab(mean_lin)
    cent, lbl = kmeans2(labc, K, seed=0, minit='++', iter=20)
    pal_lin = np.array([mean_lin[lbl == i].mean(0) if np.any(lbl == i) else np.zeros(3) for i in range(K)])
    q_rgb = lin_to_srgb(pal_lin[lbl])
    tag = f'{int(round(size * 100))}cm'
    voxel_mesh(occ, raw_rgb, size, dims).export(os.path.join(out, f'voxel_{tag}_raw.glb'))
    voxel_mesh(occ, q_rgb, size, dims).export(os.path.join(out, f'voxel_{tag}_pal{K}.glb'))
    chunks = len(np.unique(occ // 32, axis=0))
    stats['sizes'][tag] = {'voxels': int(len(occ)), 'grid_dims': list(map(int, dims)), 'chunks_32': int(chunks),
                           'samples': int(len(P)), 'palette': K, 'seconds': round(time.time() - t1, 1)}
    print(tag, stats['sizes'][tag])

json.dump(stats, open(os.path.join(out, 'stats.json'), 'w'), indent=2)
print(f'done in {time.time() - t0:.1f}s')
