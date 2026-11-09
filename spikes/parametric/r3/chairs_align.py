"""Chairs, step 1: extract every meeting chair from the scan and align them all into one canonical chair frame.

Canonical frame (chairlib.canon): y up from the chair's own local floor, the chair FACES +z, x = left/right.
Instance model (template -> world): world = Ry(yaw) * Tilt(L) + position, Tilt = Rx(-pitch) about the pivot on the
swivel axis (pitch > 0: reclined further than the template).

Which chairs: chair-01..08 are the same shell chair on a 4-star spider base. chair-09 (grey box-tub armchair on 4 short
legs) and chair-10 (tall lounge chair) are different models (checked on the scan, chairs_dbg/shots/c4.jpg) and are
handled separately (chairs_single.py).

Alignment uses only scan evidence that is the chair's own outer shell: samples outside the table-top outline (under the
table the scan fuses chair, table underside and 'curtains' hanging from the edge), seat height .. rim.
  1. all-pairs coarse search (yaw +-45 deg, x / z +-0.24 m) on a 1 cm distance field -> medoid chair = reference
  2. coarse + point-to-plane ICP of every chair to the reference (yaw, x, y, z, pitch; soft-L1, normal-compatible)
  0. per-chair mirror symmetry of the outer back band -> yaw + lateral position (used when residual < 9 mm)
  3. 3 groupwise rounds: every chair against the consensus of all OTHER chairs (samples confirmed by >= 2 others);
     yaw stays on the chair's own mirror plane when that was reliable
  4. gauge: mirror plane of the pooled shell -> x = 0; pitch offsets have zero mean (template = mean chair); the height
     is the measured local floor (fixed-height 4-star base; north-row seat tops agree to +-1.3 cm)
Output: out/r3/chairs_dbg/aligned.npz / aligned.json.
"""
import os, sys, json, time
import numpy as np
from scipy.spatial import cKDTree
from scipy import ndimage
from scipy.optimize import least_squares
import shapely
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import chairlib as L
from chairlib import canon, canon_n, vox_sub

D = os.path.join(L.OUTD, 'chairs_dbg'); os.makedirs(D, exist_ok=True)
MEETING = [f'chair-0{i}' for i in range(1, 9)]
SHELL_H = (0.40, 0.78)


# the other chairs at the table compete in the Voronoi split (their faces are discarded): chair-09's tub centre
# (re-centred on its footprint in an earlier probe) and chair-10 (objects.json)
OTHER_CENTRES = np.array([[5.786, 12.013], [6.709, 11.434]])


def extract(centres, floors, tab):
    n = len(centres)
    fl = np.r_[floors, [float(L.local_floor(*c)[0]) for c in OTHER_CENTRES]]
    fids = L.region_faces(np.r_[np.asarray(centres, float), OTHER_CENTRES], radius=0.6, floors=fl, table=tab)[:n]
    out = []
    for i, f in enumerate(fids):
        P, N, col, fi = L.sample_faces(f, 0.005, seed=i)
        out.append(dict(P=P, N=N, col=col, fid=fi, faces=f))
    return out


def outside_table(P, tab, buf=0.02):
    return ~shapely.contains_xy(tab['top'].buffer(buf), P[:, 0], P[:, 2])


def align_set(d, p, tab):
    """Alignment samples of one chair: own shell (seat height .. rim) outside the table outline."""
    Lc = canon(d['P'], p)
    return (Lc[:, 1] > SHELL_H[0]) & (Lc[:, 1] < SHELL_H[1]) & outside_table(d['P'], tab) & \
        (np.abs(Lc[:, 0]) < 0.45) & (np.abs(Lc[:, 2]) < 0.45)


def dist_field(Pts, cell=0.01, lo=(-0.7, 0.0, -0.7), shape=(140, 100, 140)):
    lo = np.array(lo); ii = np.floor((Pts - lo) / cell).astype(int)
    ok = np.all((ii >= 0) & (ii < np.array(shape)), 1)
    occ = np.zeros(shape, bool); occ[tuple(ii[ok].T)] = True
    return ndimage.distance_transform_edt(~occ) * cell, lo, cell


def field_score(F, Pts, sig=0.012):
    df, lo, cell = F
    ii = np.floor((Pts - lo) / cell).astype(int)
    ok = np.all((ii >= 0) & (ii < np.array(df.shape)), 1)
    d = np.full(len(Pts), 0.2); d[ok] = df[tuple(ii[ok].T)]
    return np.exp(-0.5 * (d / sig) ** 2).mean()


def coarse(Pw, p0, F, yaw_rng=45, yaw_step=3.0, t_rng=0.24, t_step=0.02):
    """Exhaustive (yaw, dx, dz) search; returns the moved parameters and the score."""
    best = (-1, None)
    sh = np.arange(-t_rng, t_rng + 1e-9, t_step)
    DX, DZ = np.meshgrid(sh, sh, indexing='ij'); DX, DZ = DX.ravel(), DZ.ravel()
    for dyaw in np.arange(-yaw_rng, yaw_rng + 1e-9, yaw_step):
        p = p0.copy(); p[0] += dyaw
        Lc = canon(Pw, p)
        for dx, dz in zip(DX, DZ):
            s = field_score(F, Lc - np.array([dx, 0, dz]))
            if s > best[0]:
                best = (s, (dyaw, dx, dz))
    dyaw, dx, dz = best[1]
    p = p0.copy(); p[0] += dyaw
    o = L.Ry(p[0]) @ np.array([dx, 0, dz]); p[1] += o[0]; p[3] += o[2]
    return p, best[0]


def icp(Pw, Nw, p0, tgtP, tgtN, iters=20, max_d=0.04, pitch_max=10.0, dy_max=0.04, fix=()):
    tree = cKDTree(tgtP); p = np.array(p0, float)
    lb = np.array([-np.inf, -np.inf, p0[2] - dy_max, -np.inf, -pitch_max])
    ub = np.array([np.inf, np.inf, p0[2] + dy_max, np.inf, pitch_max])
    for k in fix:
        lb[k], ub[k] = p0[k] - 1e-7, p0[k] + 1e-7
    it = 0
    for it in range(iters):
        Lc = canon(Pw, p)
        d, j = tree.query(Lc, distance_upper_bound=max_d)
        ok = np.isfinite(d)
        Nc = canon_n(Nw, p)
        ok &= np.einsum('ij,ij->i', Nc, tgtN[np.where(ok, j, 0)]) > 0.5      # same-side correspondences only
        if ok.sum() < 50:
            break
        q, nq, Ps = tgtP[j[ok]], tgtN[j[ok]], Pw[ok]

        def res(x):
            return np.einsum('ij,ij->i', canon(Ps, x) - q, nq)
        x0 = np.clip(p, lb + 1e-9, ub - 1e-9)
        sol = least_squares(res, x0, loss='soft_l1', f_scale=0.006, x_scale=[1.0, 0.01, 0.01, 0.01, 1.0], bounds=(lb, ub))
        step = np.abs(sol.x - p); p = sol.x
        if step[0] < 0.02 and step[4] < 0.02 and np.all(step[1:4] < 2e-4):
            break
    d, _ = tree.query(canon(Pw, p), distance_upper_bound=0.2)
    return p, dict(in1cm=round(float((d < 0.01).mean()), 3), in2cm=round(float((d < 0.02).mean()), 3), n=int(len(Pw)), iters=it + 1)


def consensus_cloud(data, prm, sel_fn, excl=None, cell=0.006, r=0.02, min_support=2):
    """Union of the chairs' canonical samples (sel_fn), keeping only samples confirmed by >= min_support OTHER chairs
    within r with a compatible normal (rejects per-chair debris)."""
    clouds = []
    for j in range(len(data)):
        if j == excl:
            continue
        s = sel_fn(j)
        Pc = canon(data[j]['P'][s], prm[j]); Nc = canon_n(data[j]['N'][s], prm[j])
        clouds.append(vox_sub(Pc, cell, Nc))
    trees = [cKDTree(c[0]) for c in clouds]
    outP, outN, outS = [], [], []
    for a, (Pc, Nc) in enumerate(clouds):
        sup = np.zeros(len(Pc), int)
        for b, t in enumerate(trees):
            if a != b:
                dd, jj = t.query(Pc, distance_upper_bound=r)
                ok = np.isfinite(dd)
                ok[ok] = np.einsum('ij,ij->i', Nc[ok], clouds[b][1][jj[ok]]) > 0.3
                sup += ok
        k = sup >= min_support
        outP.append(Pc[k]); outN.append(Nc[k]); outS.append(sup[k])
    P, N, S = np.concatenate(outP), np.concatenate(outN), np.concatenate(outS)
    return vox_sub(P, cell, N, S)


def mirror_gauge(P, N, th_rng=15.0, th0=0.0, c_rng=0.12, c0=0.0):
    """Mirror plane (x = c after rotating by th about y) of a canonical cloud: minimise the trimmed (80 %) mean distance
    of the mirrored cloud to itself (coarse-to-fine: 2 deg / 1 cm, then 0.25 deg / 2.5 mm)."""
    tree = cKDTree(P)

    def cost(th, c):
        R = L.Ry(th); Q = P @ R
        Q[:, 0] = 2 * c - Q[:, 0]
        d, _ = tree.query(Q @ R.T, distance_upper_bound=0.05)
        d = np.where(np.isfinite(d), d, 0.05)
        return float(np.mean(np.sort(d)[:int(0.8 * len(d))]))
    best = (np.inf, th0, c0)
    for th in np.arange(th0 - th_rng, th0 + th_rng + 1e-9, 2.0):
        for c in np.arange(c0 - c_rng, c0 + c_rng + 1e-9, 0.01):
            v = cost(th, c)
            if v < best[0]:
                best = (v, th, c)
    _, tb, cb = best
    for th in np.arange(tb - 2.0, tb + 2.0 + 1e-9, 0.25):
        for c in np.arange(cb - 0.01, cb + 0.01 + 1e-9, 0.0025):
            v = cost(th, c)
            if v < best[0]:
                best = (v, th, c)
    return best


def back_band(d, p, tab, c0=(0.0, 0.0), hr=(0.45, 0.76), rmax=0.45):
    """Outer back-shell samples: seat height .. rim, horizontal-ish normals pointing away from the chair axis,
    outside the table outline (the most reliable surface of every tucked chair)."""
    Lc = canon(d['P'], p); Nc = canon_n(d['N'], p)
    rad = Lc[:, [0, 2]] - np.asarray(c0); rl = np.linalg.norm(rad, axis=1)
    outward = np.einsum('ij,ij->i', Nc[:, [0, 2]], rad / np.maximum(rl[:, None], 1e-9)) > 0.3
    return (Lc[:, 1] > hr[0]) & (Lc[:, 1] < hr[1]) & (np.abs(Nc[:, 1]) < 0.5) & outward & (rl < rmax) & \
        outside_table(d['P'], tab)


def fit_set(d, p, tab):
    """ICP samples: outer back band + up-facing shell surfaces (rim top, seat top) outside the table; the up-facing
    ones pin height and pitch, which the near-vertical back band alone leaves free."""
    Lc = canon(d['P'], p); Nc = canon_n(d['N'], p)
    up = (Nc[:, 1] > 0.7) & (Lc[:, 1] > 0.40) & (Lc[:, 1] < 0.86) & (np.abs(Lc[:, 0]) < 0.4) & (np.abs(Lc[:, 2]) < 0.4) & \
        outside_table(d['P'], tab)
    return back_band(d, p, tab, c0=(0.0, 0.0)) | up


def sym_init(d, p, tab, th_rng=50.0):
    """Per-chair yaw / lateral position from the mirror symmetry of its own back band (2 passes: the band selection
    depends on the axis estimate). Returns new params, residual (m), n samples."""
    p = p.copy()
    Lc = canon(d['P'], p); Nc = canon_n(d['N'], p)
    m0 = (Lc[:, 1] > 0.45) & (Lc[:, 1] < 0.76) & (np.abs(Nc[:, 1]) < 0.5) & outside_table(d['P'], tab)
    c0 = np.median(Lc[m0][:, [0, 2]], 0) if m0.sum() > 50 else np.zeros(2)
    # the back is behind the seat centre: start the axis 0.15 m in front of the band centroid
    c0 = c0 + np.array([0.0, 0.15])
    res = None
    for it in range(2):
        m = back_band(d, p, tab, c0=c0)
        Q, NQ = vox_sub(canon(d['P'][m], p), 0.01, canon_n(d['N'][m], p))
        v, th, c = mirror_gauge(Q, NQ, th_rng=th_rng if it == 0 else 6.0)
        p[0] += th
        o = L.Ry(p[0]) @ np.array([c, 0, 0]); p[1] += o[0]; p[3] += o[2]
        Lc = canon(d['P'][m], p)
        c0 = np.array([0.0, np.median(Lc[:, 2]) + 0.15])
        res = (v, len(Q))
    return p, res[0], res[1]


def main():
    t00 = time.time()
    objs = L.objects()
    META = [o for o in objs if o['id'] in MEETING]
    ids = [o['id'] for o in META]
    tab = L.table_geometry(objs)
    cen = np.array([[o['transform']['position'][0], o['transform']['position'][2]] for o in META])
    floors = np.array([L.local_floor(*c)[0] for c in cen])
    prm = [np.array([o['transform']['yaw_deg'] + 180.0, c[0], f, c[1], 0.0]) for o, c, f in zip(META, cen, floors)]
    data = extract(cen, floors, tab)
    hist = {i: [] for i in ids}
    n = len(ids)
    # ------------------------------------------------ 1. per-chair mirror symmetry of the back band -> yaw, lateral x
    sym = {}
    for i in range(n):
        p, v, k = sym_init(data[i], prm[i], tab)
        reliable = v < 0.009 and k >= 300
        sym[ids[i]] = dict(yaw=round(float(p[0] % 360), 2), residual_mm=round(v * 1000, 1), n=k, reliable=bool(reliable))
        if reliable:
            prm[i] = p
        print(f'sym {ids[i]}: yaw {p[0] % 360:.1f} residual {v * 1000:.1f} mm n {k} -> {"used" if reliable else "NOT used"}')
    rel = [i for i in range(n) if sym[ids[i]]['reliable']]
    # the band apex (rearmost back point) puts every chair at the same depth before ICP
    for i in range(n):
        m = back_band(data[i], prm[i], tab, c0=(0.0, 0.0), rmax=0.6)
        Lc = canon(data[i]['P'][m], prm[i])
        cm = np.abs(Lc[:, 0]) < 0.08
        if cm.sum() > 20:
            zb = np.percentile(Lc[cm, 2], 5)
            o = L.Ry(prm[i][0]) @ np.array([0, 0, zb + 0.27]); prm[i][1] += o[0]; prm[i][3] += o[2]
    cen = np.array([[p[1], p[3]] for p in prm]); data = extract(cen, floors, tab)
    bb = lambda j: fit_set(data[j], prm[j], tab)
    # ------------------------------------------------ 2. reference = most samples among the symmetric chairs
    ref = max(rel, key=lambda i: bb(i).sum())
    print('reference', ids[ref], f'({time.time() - t00:.0f}s)')
    R = bb(ref)
    tP, tN = vox_sub(canon(data[ref]['P'][R], prm[ref]), 0.005, canon_n(data[ref]['N'][R], prm[ref]))
    F = dist_field(tP)
    for i in range(n):
        if i == ref:
            continue
        s = bb(i); Ps, Ns = vox_sub(data[i]['P'][s], 0.008, data[i]['N'][s])
        if i not in rel:
            prm[i], sc = coarse(Ps, prm[i], F, yaw_rng=45, yaw_step=2.0, t_rng=0.15, t_step=0.01)
        fix = (0, 2, 4) if i in rel else (2, 4)
        prm[i], info = icp(Ps, Ns, prm[i], tP, tN, max_d=0.05, fix=fix)
        prm[i], info = icp(Ps, Ns, prm[i], tP, tN, max_d=0.03, fix=(0, 2) if i in rel else (2,))
        hist[ids[i]].append(('to_ref', prm[i].round(4).tolist(), info))
        print(f'to-ref {ids[i]}: yaw {prm[i][0] % 360:.1f} pos ({prm[i][1]:.3f},{prm[i][2]:.3f},{prm[i][3]:.3f}) pitch {prm[i][4]:+.1f} {info}')
    # ------------------------------------------------ 3. groupwise rounds on the back band (yaw of symmetric chairs
    # stays tied to their own mirror plane until the last round)
    for rnd in range(3):
        cen = np.array([[p[1], p[3]] for p in prm]); data = extract(cen, floors, tab)
        bb = lambda j: fit_set(data[j], prm[j], tab)
        newp = []
        for i in range(n):
            tP, tN, _ = consensus_cloud(data, prm, bb, excl=i, min_support=1 if rnd == 0 else 2)
            s = bb(i); Ps, Ns = vox_sub(data[i]['P'][s], 0.008, data[i]['N'][s])
            fix = (0, 2) if i in rel else (2,)     # yaw of symmetric chairs = own mirror plane; height = local floor
            p, info = icp(Ps, Ns, prm[i], tP, tN, max_d=0.03, fix=fix)
            newp.append(p); hist[ids[i]].append((f'group{rnd}', p.round(4).tolist(), info))
            print(f'round {rnd} {ids[i]}: yaw {p[0] % 360:.2f} pos ({p[1]:.4f},{p[2]:.4f},{p[3]:.4f}) pitch {p[4]:+.2f} {info}')
        prm = newp
        mp = np.mean([p[4] for p in prm]); dh = 0.0
        for p in prm:
            p[4] -= mp
        tP, tN, _ = consensus_cloud(data, prm, bb, min_support=2)
        v, th, c = mirror_gauge(*vox_sub(tP, 0.01, tN), th_rng=4.0, c_rng=0.03)
        for k, p in enumerate(prm):
            if k in rel:                       # symmetric chairs are already on their own mirror plane
                continue
            p[0] += th
            o = L.Ry(p[0]) @ np.array([c, 0, 0]); p[1] += o[0]; p[3] += o[2]
        print(f'  gauge: pitch mean {mp:+.2f} deg, height mean {dh * 100:+.2f} cm removed; pooled mirror th {th:+.2f} deg, '
              f'c {c * 100:+.2f} cm, residual {v * 1000:.1f} mm  ({time.time() - t00:.0f}s)')
    cen = np.array([[p[1], p[3]] for p in prm])
    data = extract(cen, floors, tab)
    np.savez_compressed(os.path.join(D, 'aligned.npz'), prm=np.array(prm), floors=floors, ids=np.array(ids),
                        **{f'{k}_{i}': data[i][k] for i in range(n) for k in ('P', 'N', 'col', 'fid', 'faces')})
    json.dump(dict(ids=ids, prm=[p.tolist() for p in prm], floors=floors.tolist(), pivot_h=L.PIVOT_H, ref=ids[ref],
                   symmetry=sym, history=hist), open(os.path.join(D, 'aligned.json'), 'w'), indent=1)
    print(f'done ({time.time() - t00:.0f}s)')


if __name__ == '__main__':
    main()
