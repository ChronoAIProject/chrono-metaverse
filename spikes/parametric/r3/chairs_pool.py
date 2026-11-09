"""Chairs, step 2: pooled canonical shell cloud of the 8 aligned meeting chairs.

Every chair's own scan samples -> canonical frame (chairs_align parameters, tilt applied) -> consensus filter (a sample
is kept when >= MIN_SUPPORT OTHER chairs have a scan sample within R_SUP with a compatible normal: per-chair debris such
as table-edge curtains, a bag on a backrest or a neighbour's surface is rejected, the occlusions of one chair are filled
by the others) -> mirrored copy about the fitted mirror plane x = 0 (fills the side hidden in every chair).
Output: out/r3/chairs_dbg/pooled.npz (P, N, C colours, chair index, mirrored flag, support).
"""
import os, sys, json, time
import numpy as np
from scipy.spatial import cKDTree
import shapely
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import chairlib as L
from chairlib import canon, canon_n, vox_sub

D = os.path.join(L.OUTD, 'chairs_dbg')
R_SUP, MIN_SUPPORT, CELL = 0.015, 2, 0.004


def load_aligned():
    z = np.load(os.path.join(D, 'aligned.npz')); meta = json.load(open(os.path.join(D, 'aligned.json')))
    ids = list(meta['ids']); prm = np.array(meta['prm'])
    data = [dict(P=z[f'P_{i}'], N=z[f'N_{i}'], col=z[f'col_{i}'], fid=z[f'fid_{i}'], faces=z[f'faces_{i}'])
            for i in range(len(ids))]
    return ids, prm, data, meta


def chair_canon(d, p, tab, hmin=0.30):
    """Canonical samples of one chair: shell zone (h > hmin, tilt applied), minus pedestal surroundings."""
    Lc = canon(d['P'], p); Nc = canon_n(d['N'], p)
    inped = shapely.contains_xy(tab['ped'].buffer(0.10), d['P'][:, 0], d['P'][:, 2])
    m = (Lc[:, 1] > hmin) & (Lc[:, 1] < 0.95) & (np.abs(Lc[:, 0]) < 0.45) & (np.abs(Lc[:, 2]) < 0.45) & ~inped
    return Lc[m], Nc[m], d['col'][m], np.nonzero(m)[0]


def main():
    t0 = time.time()
    ids, prm, data, meta = load_aligned()
    tab = L.table_geometry()
    clouds = []
    for i in range(len(ids)):
        Lc, Nc, col, idx = chair_canon(data[i], prm[i], tab)
        Lc, Nc, col, idx = vox_sub(Lc, CELL, Nc, col, idx)
        clouds.append((Lc, Nc, col, idx))
    # support counted on the mirrored-augmented clouds of the others (a left arm confirms a right arm)
    trees = []
    for (Lc, Nc, _, _) in clouds:
        M = Lc * np.array([-1, 1, 1]); MN = Nc * np.array([-1, 1, 1])
        trees.append((cKDTree(np.r_[Lc, M]), np.r_[Nc, MN]))
    out = dict(P=[], N=[], C=[], chair=[], mirrored=[], support=[], src=[])
    for a, (Lc, Nc, col, idx) in enumerate(clouds):
        sup = np.zeros(len(Lc), int)
        for b, (t, TN) in enumerate(trees):
            if a == b:
                continue
            dd, jj = t.query(Lc, distance_upper_bound=R_SUP)
            ok = np.isfinite(dd)
            ok[ok] = np.einsum('ij,ij->i', Nc[ok], TN[jj[ok]]) > 0.5
            sup += ok
        k = sup >= MIN_SUPPORT
        for mir in (False, True):
            s = np.array([-1, 1, 1]) if mir else np.ones(3)
            out['P'].append(Lc[k] * s); out['N'].append(Nc[k] * s); out['C'].append(col[k])
            out['chair'].append(np.full(k.sum(), a)); out['mirrored'].append(np.full(k.sum(), mir))
            out['support'].append(sup[k]); out['src'].append(idx[k])
        print(f'{ids[a]}: {len(Lc)} samples, {k.sum()} confirmed by >= {MIN_SUPPORT} other chairs ({k.mean() * 100:.0f} %)')
    out = {k: np.concatenate(v) for k, v in out.items()}
    np.savez_compressed(os.path.join(D, 'pooled.npz'), **out)
    print(f'pooled {len(out["P"])} samples (incl. mirrored) ({time.time() - t0:.0f}s)')


if __name__ == '__main__':
    main()
