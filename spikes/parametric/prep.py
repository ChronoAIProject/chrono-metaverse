"""Shared preprocessing: local floor height, wall removal, object point set, x-z clustering."""
import os
import numpy as np
from scipy import ndimage
SP = os.path.dirname(os.path.abspath(__file__))
WALLS = {'x': [1.42, 9.84], 'z': [1.40]}
WALL_TOL = 0.12

def load():
    d = np.load(SP + '/diag/samples.npz')
    return d['P'].astype(np.float64), d['C'], d['N'].astype(np.float64)

def floor_map(P, N, cell=0.5):
    m = (N[:, 1] > 0.85) & (P[:, 1] < 0.2) & (P[:, 1] > -0.1)
    nx, nz = int(12.5 / cell), int(18 / cell)
    ix = np.clip((P[m, 0] / cell).astype(int), 0, nx - 1); iz = np.clip((P[m, 2] / cell).astype(int), 0, nz - 1)
    g = np.full((nx, nz), np.nan)
    key = ix * nz + iz; ys = P[m, 1]
    o = np.argsort(key); key, ys = key[o], ys[o]
    u, st, cnt = np.unique(key, return_index=True, return_counts=True)
    for k, s, c in zip(u, st, cnt):
        if c >= 15: g.flat[k] = np.median(ys[s:s + c])
    # fill NaN with nearest valid
    inv = np.isnan(g)
    idx = ndimage.distance_transform_edt(inv, return_distances=False, return_indices=True)
    g = g[tuple(idx)]
    g = ndimage.median_filter(g, 3)
    return g, cell

def floor_at(g, cell, x, z):
    fx = np.clip(x / cell - 0.5, 0, g.shape[0] - 1.001); fz = np.clip(z / cell - 0.5, 0, g.shape[1] - 1.001)
    x0, z0 = fx.astype(int), fz.astype(int); tx, tz = fx - x0, fz - z0
    return (g[x0, z0] * (1 - tx) * (1 - tz) + g[x0 + 1, z0] * tx * (1 - tz) + g[x0, z0 + 1] * (1 - tx) * tz + g[x0 + 1, z0 + 1] * tx * tz)

def object_points(hmin=0.05, hmax=2.4):
    P, C, N = load()
    g, cell = floor_map(P, N)
    fl = floor_at(g, cell, P[:, 0], P[:, 2])
    h = P[:, 1] - fl
    keep = (h > hmin) & (P[:, 1] < hmax)
    for x in WALLS['x']: keep &= np.abs(P[:, 0] - x) > WALL_TOL
    for z in WALLS['z']: keep &= np.abs(P[:, 2] - z) > WALL_TOL
    keep &= (P[:, 0] > WALLS['x'][0]) & (P[:, 2] > WALLS['z'][0])   # outside the room shell
    return P[keep], C[keep], N[keep], h[keep], fl[keep]

def cluster_xz(P, cell=0.05, dilate=1, min_pts=150):
    ix = (P[:, 0] / cell).astype(int); iz = (P[:, 2] / cell).astype(int)
    occ = np.zeros((ix.max() + 2, iz.max() + 2), bool)
    cnt = np.zeros_like(occ, int); np.add.at(cnt, (ix, iz), 1)
    occ = cnt >= 2
    if dilate: occ = ndimage.binary_dilation(occ, iterations=dilate)
    lab, n = ndimage.label(occ, structure=np.ones((3, 3)))
    pl = lab[ix, iz]
    sizes = np.bincount(pl, minlength=n + 1); sizes[0] = 0
    order = np.argsort(-sizes)
    ids = [k for k in order if sizes[k] >= min_pts]
    remap = np.full(n + 1, -1); remap[ids] = np.arange(len(ids))
    return remap[pl], len(ids)
