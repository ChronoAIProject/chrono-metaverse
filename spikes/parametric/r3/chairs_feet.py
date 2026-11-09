"""Meeting-chair base from the scan GEOMETRY: foot pads = small bumps 1..3.5 cm above the floor near each chair.

Per chair: scan samples within 0.5 m of the swivel axis; floor = robust plane fitted to the up-facing samples of the
ring 0.12..0.5 m (IRLS, 1 cm); bump samples = 1.0..3.5 cm above that plane and not up-facing floor (|n_y| < 0.9 or a
local height step). In the canonical chair frame (yaw removed) the bump density on a polar grid (r 0.15..0.40 m,
theta mod 90 deg) is searched for the 4-fold star (R, theta) with the highest density contrast against the ring.
Accepted when the contrast is >= 2.5 and >= 3 of the 4 foot positions hold bump samples; otherwise the pooled value
of the accepted chairs is used. Output: out/r3/chairs_dbg/feet_geometry.json
"""
import os, sys, json, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import chairlib as L
import contour as C
CH = json.load(open(os.path.join(L.OUTD, 'chairs.json')))
S = C.scene(); FC = S['FC']


def chair_bumps(inst):
    pos = np.array(inst['position']); yaw = inst['yaw_deg']
    m = (np.hypot(FC[:, 0] - pos[0], FC[:, 2] - pos[2]) < 0.55) & (FC[:, 1] < pos[1] + 0.2)
    P, N, col, _ = L.sample_faces(np.nonzero(m)[0], 0.003, seed=1)
    Lc = (P - pos) @ C.Ry(yaw)
    r = np.hypot(Lc[:, 0], Lc[:, 2])
    ring = (r > 0.12) & (r < 0.5) & (N[:, 1] > 0.9)
    A = np.c_[Lc[ring, 0], Lc[ring, 2], np.ones(ring.sum())]; y = Lc[ring, 1]; w = np.ones(len(y))
    for _ in range(5):
        coef = np.linalg.lstsq(A * w[:, None], y * w, rcond=None)[0]
        res = y - A @ coef; w = (np.abs(res) < 0.01).astype(float) + 1e-3
    h = Lc[:, 1] - (coef[0] * Lc[:, 0] + coef[1] * Lc[:, 2] + coef[2])
    bump = (h > 0.010) & (h < 0.035)
    return Lc, h, bump, r


def star(Lc, bump, r):
    th = np.degrees(np.arctan2(Lc[:, 0], Lc[:, 2])) % 90.0
    best = None
    for R in np.arange(0.15, 0.401, 0.005):
        band = np.abs(r - R) < 0.025
        nb = band.sum()
        if nb < 50:
            continue
        for t0 in np.arange(0, 90, 2.0):
            dth = np.abs(((th - t0 + 45) % 90) - 45)
            near = band & (dth < np.degrees(0.03 / R))
            if near.sum() < 10:
                continue
            dens = bump[near].mean(); base = bump[band].mean() + 1e-3
            c = dens / base
            # how many of the 4 feet hold bumps
            a = np.degrees(np.arctan2(Lc[:, 0], Lc[:, 2])) % 360
            k = 0
            for q in range(4):
                aq = (t0 + 90 * q) % 360
                dq = np.abs(((a - aq + 180) % 360) - 180)
                k += int((bump & band & (dq < np.degrees(0.03 / R))).sum() >= 3)
            sc = (c, k)
            if best is None or (k >= 3 and c > best[0]) or (best[3] < 3 <= k):
                best = (c, R, t0, k)
    return best


res = {}
for inst in CH['instances']:
    Lc, h, bump, r = chair_bumps(inst)
    b = star(Lc, bump, r)
    ok = b is not None and b[0] >= 2.5 and b[3] >= 3
    res[inst['id']] = dict(contrast=round(float(b[0]), 2) if b else None, foot_radius=round(float(b[1]), 3) if b else None,
                           theta_deg=round(float(b[2]), 1) if b else None, feet_with_bumps=int(b[3]) if b else 0,
                           bump_samples=int(bump.sum()), accepted=bool(ok))
    print(inst['id'], res[inst['id']])
acc = [v for v in res.values() if v['accepted']]
pooled = dict(foot_radius=round(float(np.median([v['foot_radius'] for v in acc])), 3) if acc else None,
              n_accepted=len(acc))
print('pooled', pooled)
json.dump(dict(per_chair=res, pooled=pooled, method=__doc__), open(os.path.join(L.OUTD, 'chairs_dbg', 'feet_geometry.json'), 'w'), indent=1)
