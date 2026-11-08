"""Shared helpers for the parametric-reconstruction spike (lobby scan).

load_aligned(): Draco mesh + texture -> vertices aligned so walls are grid-axis-aligned,
                floor at y=0, min corner at x=z=0 (same algorithm as spikes/voxelize/voxelize.py).
sample_surface(density): area-weighted surface samples with texture colour and face normal.
Units are metres, y is up. Scaniverse UVs use a top-left image origin.
"""
import os, numpy as np, DracoPy
from PIL import Image
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None
S = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRC = os.path.join(S, 'scan-assets', 'mesh.drc')
TEX = os.path.join(S, 'scan-assets', 'tex.jpg')

_cache = {}

def load_aligned():
    if 'scene' in _cache:
        return _cache['scene']
    m = DracoPy.decode(open(DRC, 'rb').read())
    V = np.asarray(m.points, np.float64).reshape(-1, 3)
    F = np.asarray(m.faces, np.int64).reshape(-1, 3)
    UV = np.asarray(m.tex_coord, np.float64).reshape(-1, 2)
    tex = np.asarray(Image.open(TEX).convert('RGB'))
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    n = np.cross(b - a, c - a); area2 = np.linalg.norm(n, axis=1); nn = n / np.maximum(area2[:, None], 1e-12)
    horiz = np.abs(nn[:, 1]) < 0.3
    ang4 = np.mod(np.arctan2(nn[horiz, 2], nn[horiz, 0]), np.pi / 2)
    hist, edges = np.histogram(ang4, bins=360, range=(0, np.pi / 2), weights=area2[horiz])
    hist = ndimage.uniform_filter1d(hist, 5, mode='wrap')
    k = np.argmax(hist); theta = -(edges[k] + edges[k + 1]) / 2
    cs, sn = np.cos(theta), np.sin(theta)
    R = np.array([[cs, 0, -sn], [0, 1, 0], [sn, 0, cs]])
    Va = V @ R.T
    Va[:, 1] -= np.percentile(Va[:, 1], 1)
    mn = Va.min(0); Va -= np.array([mn[0], 0, mn[2]])
    _cache['scene'] = (Va, F, UV, tex, float(np.degrees(theta)))
    return _cache['scene']

def sample_surface(density=400.0, seed=0):
    """Return points (N,3), colours uint8 (N,3), unit normals (N,3), face index (N,)."""
    Va, F, UV, tex, _ = load_aligned()
    H, W = tex.shape[:2]
    a, b, c = Va[F[:, 0]], Va[F[:, 1]], Va[F[:, 2]]
    cr = np.cross(b - a, c - a); area = 0.5 * np.linalg.norm(cr, axis=1)
    nrm = cr / np.maximum(2 * area[:, None], 1e-12)
    rng = np.random.default_rng(seed)
    cnt = rng.poisson(area * density); idx = np.repeat(np.arange(len(F)), cnt)
    r1, r2 = rng.random(len(idx)), rng.random(len(idx)); s = np.sqrt(r1)
    w0, w1, w2 = 1 - s, s * (1 - r2), s * r2
    f = F[idx]
    P = Va[f[:, 0]] * w0[:, None] + Va[f[:, 1]] * w1[:, None] + Va[f[:, 2]] * w2[:, None]
    T = UV[f[:, 0]] * w0[:, None] + UV[f[:, 1]] * w1[:, None] + UV[f[:, 2]] * w2[:, None]
    px = np.clip((T[:, 0] * W).astype(np.int64), 0, W - 1); py = np.clip((T[:, 1] * H).astype(np.int64), 0, H - 1)
    return P, tex[py, px], nrm[idx], idx

if __name__ == '__main__':
    Va, F, UV, tex, rot = load_aligned()
    P, C, N, _ = sample_surface(100)
    print('rotation', round(rot, 2), 'bbox', Va.max(0).round(2), 'samples', len(P))
