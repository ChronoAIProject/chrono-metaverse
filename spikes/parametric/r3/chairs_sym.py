"""Experiment: per-chair mirror symmetry of the back band (outer back surface) -> yaw / lateral position."""
import os, sys, json
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import chairlib as L
from chairlib import canon, canon_n
from chairs_align import outside_table, mirror_gauge
from scipy.spatial import cKDTree
from PIL import Image, ImageDraw
from chairs_viz import panel
D = os.path.join(L.OUTD, 'chairs_dbg')
z = np.load(os.path.join(D, 'aligned.npz')); ids = list(z['ids'])
objs = L.objects(); tab = L.table_geometry(objs)
r2 = {o['id']: o for o in objs}
rows = []
for i, cid in enumerate(ids):
    o = r2[cid]; P, N = z[f'P_{i}'], z[f'N_{i}']
    f = z['floors'][i]
    p0 = np.array([o['transform']['yaw_deg'] + 180, o['transform']['position'][0], f, o['transform']['position'][2], 0.0])
    Lc = canon(P, p0); Nc = canon_n(N, p0)
    # centre estimate: centroid of the shell samples outside the table (x-z)
    out = outside_table(P, tab)
    m0 = out & (Lc[:, 1] > 0.45) & (Lc[:, 1] < 0.76) & (np.abs(Nc[:, 1]) < 0.5)
    c0 = np.median(Lc[m0][:, [0, 2]], 0) if m0.sum() > 50 else np.zeros(2)
    best = None
    for it in range(3):
        rad = Lc[:, [0, 2]] - c0; rad /= np.maximum(np.linalg.norm(rad, axis=1, keepdims=True), 1e-9)
        outward = np.einsum('ij,ij->i', Nc[:, [0, 2]], rad) > 0.3
        m = m0 & outward & (np.hypot(*(Lc[:, [0, 2]] - c0).T) < 0.45)
        Q = Lc[m]; NQ = Nc[m]
        Q2, NQ2 = L.vox_sub(Q, 0.008, NQ)
        v, th, c = mirror_gauge(Q2, NQ2, th_rng=60.0)
        best = (v, th, c, len(Q2))
        # centre along the new axis: lateral = c; keep c0 z
        R = L.Ry(th); cc = np.array([c, 0, 0]) @ R.T
        c0 = np.array([cc[0] + 0 * c0[0], c0[1]])
    print(f'{cid}: back-band n={best[3]} mirror th {best[1]:+.1f} deg (yaw {(p0[0] + best[1]) % 360:.1f}), c {best[2]:+.3f}, residual {best[0] * 1000:.1f} mm')
    R = L.Ry(best[1]); Qr = Q @ R
    cc = np.clip(z[f'col_{i}'][m].astype(float) * 1.8 + 30, 0, 255).astype(np.uint8)
    Qr = Qr - np.array([best[2], 0, 0])
    rows.append(panel([(Qr, cc)], 0, 2, (-0.5, 0.5), (-0.5, 0.5), f'{cid} th{best[1]:+.0f} res{best[0]*1000:.0f}mm', sc=220))
g = Image.new('RGB', (rows[0].width * 4, rows[0].height * 2))
for k, r in enumerate(rows): g.paste(r, ((k % 4) * r.width, (k // 4) * r.height))
g.save(os.path.join(D, 'sym.png'))
