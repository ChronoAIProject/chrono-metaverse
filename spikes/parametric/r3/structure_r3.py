"""Round-3 structure: walls / partitions / glazing re-fitted to the scan at continuous coordinates.

Output: out/r3/structure_r3.json (+ textures out/r3/tex_r3/<id>.jpg, observed masks <id>_mask.png).
Round 2's out/structure.json is not modified.

Method (no axis snapping, no grid)
  1. scan surface re-sampled at 1500 pts/m2; near-vertical samples (|n_y| < 0.25, 0.3 < y < 2.6) outside the furniture
     boxes of objects_r3.json, outside the regions modelled as sliced solids (arch_solids.py: wood fin, curved
     partition, plant, window piers in front of the south glazing) and in front of the south glazing plane.
  2. sequential RANSAC of planes (wallfit.ransac_planes): hypothesis = sample + its horizontalised normal, inliers
     within 1.5 cm and normal-compatible, TLS refinement (tilt kept when |n_y| <= 0.08, i.e. the scan's lean of the
     wall), runs along the wall (gaps > 25 cm split). Architectural runs only: >= 0.25 m long, >= 1.0 m of height
     coverage, reaching above 1.9 m.
  3. collinear runs (angle < 5 deg, offset < 5 cm, gap < 1 m) are grouped into one wall; the group's offset profile
     along the wall (10 cm bins, median after removing the lean) is split top-down wherever a single line leaves
     more than 1.2 cm of median residual (best split = least summed residual of two lines, pieces >= 0.5 m); every
     piece gets its own TLS plane (continuous angle and offset, lean kept).
  4. ends: consecutive pieces of a group meet at the intersection of their lines (a short jog face when the lines
     are near-parallel); pieces of different groups whose ends are within 0.45 m meet at the line intersection
     (corners), an end within 0.3 m of another wall's face is extended / trimmed onto it (T-junctions).
  5. quads from the floor surface (floor_r3: smooth fitted scan floor, 2 cm below it) to the top of the wall's scan
     samples; texture baked orthographically (bake_util.ortho_bake, 1 cm/px) from scan faces within 4 cm of the
     plane, only texels in front of the visible surface.
  6. glazing: the south curtain wall keeps the round-2 plane (glass is scanned only as scattered reflections); its
     texture is re-baked per pane (panes = gaps between the window-pier solids), unobserved texels = the pane's
     median colour (no row-median stretching).
"""
import os, sys, json, time
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); PAR = os.path.dirname(HERE)
for p in (PAR, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)
from common import sample_surface   # noqa: E402
import wallfit as WF                  # noqa: E402

OUT = os.path.join(PAR, 'out'); OUT3 = os.path.join(OUT, 'r3')
TEXD = os.path.join(OUT3, 'tex_r3'); DBG = os.path.join(OUT3, 'struct_dbg')
for d in (TEXD, DBG):
    os.makedirs(d, exist_ok=True)
S2 = json.load(open(os.path.join(OUT, 'structure.json')))
OBJS = json.load(open(os.path.join(OUT3, 'objects_r3.json')))
PX = 0.01

# scan regions modelled as sliced solids (arch_solids.py) instead of planes; boxes = (min, max) world
SOLID_REGIONS = {
    'partition-02': ([9.12, 0.0, 12.18], [9.62, 2.95, 13.58]),  # curved partition piece on the east side
    'plant-01': ([10.45, 0.0, 7.25], [11.40, 2.95, 8.50]),      # potted plant in the east corridor
}
SOUTH_PIER_Z = 15.17          # window piers / mullions in front of the south glazing: z >= this (arch_solids.py)
GLAZING_S = next(e for e in S2['elements'] if e['id'] == 'glazing_z15.64_1')
GLAZING_Z = float(GLAZING_S['plane']['offset'])
NOT_FURNITURE = {'logo-wall-01', 'screen-01', 'window-frame-01', 'plant-01'}


def in_box(P, lo, hi, pad=0.0):
    return np.all((P >= np.asarray(lo) - pad) & (P <= np.asarray(hi) + pad), axis=1)


def wall_samples(density=1500.0, seed=21):
    P, C, N, FI = sample_surface(density, seed=seed)
    m = (np.abs(N[:, 1]) < 0.25) & (P[:, 1] > 0.3) & (P[:, 1] < 2.6)
    for o in OBJS:
        if o['id'] in NOT_FURNITURE:
            continue
        m &= ~in_box(P, o['bbox']['min'], o['bbox']['max'], 0.03)
    for lo, hi in SOLID_REGIONS.values():
        m &= ~in_box(P, lo, hi)
    m &= ~((P[:, 2] >= SOUTH_PIER_Z) & (P[:, 0] > 1.5))          # south piers / glazing band (left wall kept)
    m &= P[:, 2] < GLAZING_Z + 0.05                                # reflections behind the south glass
    return P[m], N[m], C[m]


# ===================================================================== grouping and piecewise fit
def line2(n, d, y=1.2):
    """3D plane -> 2D line (unit normal a, offset c: a.q = c) at height y."""
    a = np.array([n[0], n[2]]); h = np.linalg.norm(a)
    return a / h, (d - n[1] * y) / h


def group_runs(runs):
    k = len(runs); parent = list(range(k))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for i in range(k):
        for j in range(i + 1, k):
            A, B = runs[i], runs[j]
            if A['a'] @ B['a'] < np.cos(np.radians(5)):
                continue
            off = max(abs(A['a'] @ B['mid'] - A['c']), abs(B['a'] @ A['mid'] - B['c']))
            if off > 0.05:
                continue
            ta = np.array([-A['a'][1], A['a'][0]])
            ua, ub = sorted([A['q0'] @ ta, A['q1'] @ ta]), sorted([B['q0'] @ ta, B['q1'] @ ta])
            gap = max(ub[0] - ua[1], ua[0] - ub[1])
            if gap < 0.6:
                parent[find(i)] = find(j)
    g = {}
    for i in range(k):
        g.setdefault(find(i), []).append(i)
    return list(g.values())


def fit_line_w(u, m, w):
    A = np.c_[u, np.ones_like(u)] * np.sqrt(w)[:, None]
    coef, *_ = np.linalg.lstsq(A, m * np.sqrt(w), rcond=None)
    return coef


def split_profile(u, m, w, thr=0.012, min_len=0.5):
    """Top-down split of a binned offset profile into linear pieces -> list of (u_start, u_end) bin-index ranges."""
    def rec(a, b):
        uu, mm, ww = u[a:b], m[a:b], w[a:b]
        coef = fit_line_w(uu, mm, ww)
        res = mm - (coef[0] * uu + coef[1])
        sm = np.array([np.median(res[max(0, i - 1):i + 2]) for i in range(len(res))])
        if len(uu) < 2 * int(min_len / 0.1) or np.abs(sm).max() <= thr:
            return [(a, b)]
        base = (ww * np.abs(res)).sum(); best = None
        for s in range(a + int(min_len / 0.1), b - int(min_len / 0.1) + 1):
            cost = 0.0
            for (x0, x1) in ((a, s), (s, b)):
                c2 = fit_line_w(u[x0:x1], m[x0:x1], w[x0:x1])
                cost += (w[x0:x1] * np.abs(m[x0:x1] - (c2[0] * u[x0:x1] + c2[1]))).sum()
            if best is None or cost < best[0]:
                best = (cost, s)
        if best is None or best[0] > 0.7 * base:
            return [(a, b)]
        return rec(a, best[1]) + rec(best[1], b)
    return rec(0, len(u))


def piece_planes(P, N, idx, a_hint):
    """Group points -> list of pieces dict(n, d, u0, u1, t, idx, rms, lean_cm_per_m)."""
    Q = P[idx]; q = Q[:, [0, 2]]
    c = q.mean(0); _, _, vt = np.linalg.svd(q - c, full_matrices=False)
    a = vt[1] * np.sign(vt[1] @ a_hint); t2 = np.array([a[1], -a[0]])     # t = up x n (right as seen from the room)
    u = q @ t2; r = q @ a
    order = np.argsort(u); u, r, Qs, ids = u[order], r[order], Q[order], idx[order]
    # opening split (no samples over > 0.6 m: doorways)
    cut = np.nonzero(np.diff(u) > 0.6)[0]
    out = []
    for s0, s1 in zip(np.r_[0, cut + 1], np.r_[cut + 1, len(u)]):
        uu, rr, QQ, ii = u[s0:s1], r[s0:s1], Qs[s0:s1], ids[s0:s1]
        if uu[-1] - uu[0] < 0.25:
            continue
        edges = np.arange(uu[0], uu[-1] + 0.1, 0.1)
        b = np.clip(np.digitize(uu, edges) - 1, 0, len(edges) - 2)
        # lean: residual vs height inside the bins
        med_b = np.zeros(len(edges) - 1); cnt = np.bincount(b, minlength=len(edges) - 1)
        for k in np.unique(b):
            med_b[k] = np.median(rr[b == k])
        rel = rr - med_b[b]; yy = QQ[:, 1] - 1.2
        lean = float((rel * yy).sum() / max((yy * yy).sum(), 1e-9))
        rc = rr - lean * yy
        prof = np.array([np.median(rc[b == k]) if cnt[k] >= 5 else np.nan for k in range(len(edges) - 1)])
        ok = np.isfinite(prof)
        ub = 0.5 * (edges[:-1] + edges[1:])[ok]; mb = prof[ok]; wb = cnt[ok].astype(float)
        if len(ub) < 3:
            continue
        for (ba, bb) in split_profile(ub, mb, wb):
            ua = uu[0] if ba == 0 else 0.5 * (ub[ba - 1] + ub[ba])
            ue = uu[-1] if bb == len(ub) else 0.5 * (ub[bb - 1] + ub[bb])
            sel = (uu >= ua - 1e-9) & (uu <= ue + 1e-9)
            if sel.sum() < 40:
                continue
            nh = np.array([a[0], 0.0, a[1]])
            n, d = WF.tls_plane(QQ[sel], nh)
            if abs(n[1]) > 0.08:
                n, d = WF.tls_vertical(QQ[sel], nh)
            res = QQ[sel] @ n - d
            u_lo = float(np.percentile(uu[sel], 0.5)) if ba == 0 else float(ua)
            u_hi = float(np.percentile(uu[sel], 99.5)) if bb == len(ub) else float(ue)
            rm = float(np.median(rr[sel]))
            out.append(dict(n=n, d=float(d), idx=ii[sel], rms=float(np.sqrt((res ** 2).mean())),
                            u_lo=u_lo, u_hi=u_hi, q_lo=u_lo * t2 + rm * a, q_hi=u_hi * t2 + rm * a,
                            first=ba == 0, last=bb == len(ub), lean_cm_per_m=round(lean * 100, 2)))
    return out


def tangent(n):
    a = np.array([n[0], n[2]]); a /= np.linalg.norm(a)
    return np.array([a[1], -a[0]])                               # 2D, right as seen from the room


def point_on(n, d, s, y):
    """3D point on plane (n, d) at height y whose horizontal coordinate along tangent(n) is s (s = t.(x, z))."""
    t = tangent(n)
    A = np.array([[n[0], n[2]], [t[0], t[1]]]); b = np.array([d - n[1] * y, s])
    x, z = np.linalg.solve(A, b)
    return np.array([x, y, z])


def intersect2(a1, c1, a2, c2):
    A = np.array([a1, a2])
    if abs(np.linalg.det(A)) < 1e-6:
        return None
    return np.linalg.solve(A, [c1, c2])


# ===================================================================== main
def fit_walls(log):
    t0 = time.time()
    P, N, Cc = wall_samples()
    log.append(f'wall samples: {len(P)} near-vertical scan samples (1500/m2) outside furniture / solid regions')
    planes = WF.ransac_planes(P, N, band=0.015, min_pts=300)
    runs = []
    for k, pl in enumerate(planes):
        rr, t3 = WF.runs_along(P, pl['n'], pl['idx'])
        for r in rr:
            y = P[r, 1]
            y_lo, y_hi = np.percentile(y, [1, 99])
            if y_hi - y_lo < 1.0 or y_hi < 1.9:
                continue
            a, c = line2(pl['n'], pl['d'])
            q = P[r][:, [0, 2]]; ta = np.array([-a[1], a[0]]); uu = q @ ta
            q0 = q[np.argmin(uu)]; q1 = q[np.argmax(uu)]
            runs.append(dict(plane=k, idx=r, a=a, c=c, q0=q0, q1=q1, mid=0.5 * (q0 + q1)))
    groups = group_runs(runs)
    log.append(f'RANSAC: {len(planes)} planes -> {len(runs)} architectural runs -> {len(groups)} walls '
               f'({time.time() - t0:.1f}s)')
    pieces = []
    for gi, g in enumerate(groups):
        idx = np.unique(np.concatenate([runs[i]['idx'] for i in g]))
        a_hint = np.mean([runs[i]['a'] for i in g], axis=0)
        ps = piece_planes(P, N, idx, a_hint)
        for j, p in enumerate(ps):
            p['group'] = gi; p['k'] = j
        pieces += ps
    # ----- ends: within a group (consecutive pieces), then corners / T-junctions between groups
    for p in pieces:
        p['line'] = line2(p['n'], p['d'])
        tp = tangent(p['n'])                               # own tangent coordinates of the two ends (y = 1.2 line)
        p['s0'], p['s1'] = float(p['q_lo'] @ tp), float(p['q_hi'] @ tp)
        p['joined'] = [False, False]
    jogs = []
    by_g = {}
    for p in pieces:
        by_g.setdefault(p['group'], []).append(p)
    for g, ps in by_g.items():
        ps.sort(key=lambda p: p['u_lo'])
        for A, B in zip(ps[:-1], ps[1:]):
            if B['u_lo'] - A['u_hi'] > 0.3:
                continue
            X = intersect2(*A['line'], *B['line'])
            qb = 0.5 * (A['q_hi'] + B['q_lo'])                 # break point (group frame)
            ta, tb = tangent(A['n']), tangent(B['n'])
            if X is not None and np.linalg.norm(X - qb) < 0.3:
                A['s1'] = float(X @ ta); B['s0'] = float(X @ tb)
            else:
                # near-parallel: both end at the break, a short jog face joins them
                A['s1'] = float(qb @ ta); B['s0'] = float(qb @ tb)
                jogs.append((A, B))
            A['joined'][1] = B['joined'][0] = True
    ends = [(p, e) for p in pieces for e in (0, 1)]

    def end_q(p, e):
        return point_on(p['n'], p['d'], p['s1'] if e else p['s0'], 1.2)[[0, 2]]
    ncorner = nt = 0
    for i, (A, ea) in enumerate(ends):
        if A['joined'][ea]:
            continue
        qa = end_q(A, ea); best = None
        for B, eb in ends:
            if B is A or B['group'] == A['group'] or B['joined'][eb]:
                continue
            if abs(A['line'][0] @ B['line'][0]) > np.cos(np.radians(20)):
                continue
            qb = end_q(B, eb)
            if np.linalg.norm(qa - qb) > 0.45:
                continue
            X = intersect2(*A['line'], *B['line'])
            if X is None or np.linalg.norm(X - qa) > 0.45 or np.linalg.norm(X - qb) > 0.45:
                continue
            dd = np.linalg.norm(qa - qb)
            if best is None or dd < best[0]:
                best = (dd, B, eb, X)
        if best is not None:
            _, B, eb, X = best
            sa, sb = float(X @ tangent(A['n'])), float(X @ tangent(B['n']))
            if ea:
                A['s1'] = sa
            else:
                A['s0'] = sa
            if eb:
                B['s1'] = sb
            else:
                B['s0'] = sb
            A['joined'][ea] = B['joined'][eb] = True; ncorner += 1
    for A, ea in ends:                                     # T-junctions: free end close to another wall's face
        if A['joined'][ea]:
            continue
        qa = end_q(A, ea)
        for B in pieces:
            if B['group'] == A['group'] or abs(A['line'][0] @ B['line'][0]) > np.cos(np.radians(20)):
                continue
            dist = abs(B['line'][0] @ qa - B['line'][1])
            tb = tangent(B['n']); sq = qa @ tb
            if dist < 0.3 and B['s0'] - 0.1 <= sq <= B['s1'] + 0.1:
                X = intersect2(*A['line'], *B['line'])
                if X is not None and np.linalg.norm(X - qa) < 0.35:
                    s = float(X @ tangent(A['n']))
                    if ea:
                        A['s1'] = s
                    else:
                        A['s0'] = s
                    A['joined'][ea] = True; nt += 1
                    break
    log.append(f'pieces {len(pieces)}, in-wall joints {sum(1 for g in by_g.values() for _ in g[1:])}, '
               f'jogs {len(jogs)}, corners {ncorner}, T-junctions {nt}')
    return P, N, pieces, jogs


def main():
    t0 = time.time(); log = []
    import floor_r3 as FL
    fl = FL.load()
    P, N, pieces, jogs = fit_walls(log)
    import bake_util as BU
    elements = []
    names = {}

    def wid_of(n):
        ang = int(round(np.degrees(np.arctan2(n[2], n[0])))) % 360
        names[ang] = names.get(ang, 0) + 1
        return f'wall_r3_a{ang:03d}_{names[ang]}'

    def quad(n, d, s0, s1, ybot0, ybot1, ytop):
        LB = point_on(n, d, s0, ybot0); RB = point_on(n, d, s1, ybot1)
        RT = point_on(n, d, s1, ytop); LT = point_on(n, d, s0, ytop)
        return np.array([LB, RB, RT, LT])

    def bake_quad(eid, C4, n, d, kind_tol=0.04, cos_min=np.cos(np.radians(35)), back=None):
        u_vec = C4[1] - C4[0]; u_vec /= np.linalg.norm(u_vec)
        v_vec = -(np.array([0, 1.0, 0]) - (np.array([0, 1.0, 0]) @ n) * n); v_vec /= np.linalg.norm(v_vec)   # down along the plane
        v_vec -= (v_vec @ u_vec) * u_vec; v_vec /= np.linalg.norm(v_vec)
        cu = (C4 - C4[3]) @ u_vec; cv = (C4 - C4[3]) @ v_vec
        o = C4[3] + cu.min() * u_vec + cv.min() * v_vec
        Wm, Hm = cu.max() - cu.min(), cv.max() - cv.min()
        Wp, Hp = max(2, int(np.ceil(Wm / PX))), max(2, int(np.ceil(Hm / PX)))
        lo = C4.min(0) - 0.06; hi = C4.max(0) + 0.06
        fids = BU.faces_in_box(lo, hi, normal=n, cos_min=cos_min)
        lo_b = -(back if back is not None else kind_tol)              # band: kind_tol in front, `back` behind
        if back is not None:
            lo = np.minimum(lo, (C4 - back * n).min(0) - 0.06); hi = np.maximum(hi, (C4 - back * n).max(0) + 0.06)
            fids = BU.faces_in_box(lo, hi, normal=n, cos_min=cos_min)
        sd = BU.FCEN[fids] @ n - d
        fids = fids[(sd < kind_tol + 0.01) & (sd > lo_b - 0.01)]
        keep = lambda p, col, nn: ((p @ n - d) < kind_tol) & ((p @ n - d) > lo_b)
        if len(fids):
            rgb, obs = BU.ortho_bake(fids, o, u_vec, v_vec, (Wp, Hp), px=PX, depth_vec=n, visible_tol=0.03, keep=keep)
        else:
            rgb, obs = np.full((Hp, Wp, 3), 200, np.uint8), np.zeros((Hp, Wp), bool)
        Image.fromarray(rgb).save(os.path.join(TEXD, eid + '.jpg'), quality=90)
        Image.fromarray((obs * 255).astype(np.uint8)).save(os.path.join(TEXD, eid + '_mask.png'))
        uv = np.c_[((C4 - o) @ u_vec) / (Wp * PX), 1.0 - ((C4 - o) @ v_vec) / (Hp * PX)]
        return dict(texture=f'r3/tex_r3/{eid}.jpg', texture_size=[Wp, Hp], metres_per_px=PX,
                    corner_uv=np.round(uv, 6).tolist(), observed_mask=f'r3/tex_r3/{eid}_mask.png',
                    observed_fraction=round(float(obs.mean()), 3))

    for p in sorted(pieces, key=lambda p: (p['group'], p['s0'])):
        n, d = p['n'], p['d']
        if p['s1'] - p['s0'] < 0.05:
            continue
        ytop = float(min(2.9, np.percentile(P[p['idx'], 1], 99.5) + 0.02))
        qa = point_on(n, d, p['s0'], 0.0); qb = point_on(n, d, p['s1'], 0.0)
        yb0 = float(FL.height(fl, qa[0], qa[2])[0]) - 0.02; yb1 = float(FL.height(fl, qb[0], qb[2])[0]) - 0.02
        C4 = quad(n, d, p['s0'], p['s1'], yb0, yb1, ytop)
        eid = wid_of(n)
        e = dict(id=eid, kind='wall', source='r3 RANSAC + piecewise TLS (structure_r3.py)',
                 plane=dict(axis='n', normal=np.round(n, 6).tolist(), offset=round(d, 5),
                            note='plane n.p = offset (3D, continuous angle; n_y != 0 keeps the scan lean of the wall)'),
                 rect=dict(u=[round(p['s0'], 4), round(p['s1'], 4)], y=[round(min(yb0, yb1), 4), round(ytop, 4)]),
                 u_axis=[round(float(tangent(n)[0]), 6), 0.0, round(float(tangent(n)[1]), 6)],
                 u_range=[round(p['s0'], 4), round(p['s1'], 4)], corners=np.round(C4, 5).tolist(),
                 length_m=round(p['s1'] - p['s0'], 3), support_pts=int(len(p['idx'])),
                 rms_cm=round(p['rms'] * 100, 2), lean_cm_per_m=p['lean_cm_per_m'], group=int(p['group']),
                 thickness=0.1)
        e.update(bake_quad(eid, C4, n, d))
        elements.append(e)
        p['eid'] = eid
    for A, B in jogs:
        if 'eid' not in A or 'eid' not in B:
            continue
        ea = next(e for e in elements if e['id'] == A['eid']); eb = next(e for e in elements if e['id'] == B['eid'])
        CA, CB = np.array(ea['corners']), np.array(eb['corners'])
        C4 = np.array([CA[1], CB[0], CB[3], CA[2]])
        yb, yt = min(C4[0][1], C4[1][1]), min(C4[2][1], C4[3][1])     # planar jog: common bottom / top height
        C4[[0, 1], 1] = yb; C4[[2, 3], 1] = yt
        nn = np.cross(C4[1] - C4[0], C4[3] - C4[0])
        if np.linalg.norm(nn) < 1e-4:
            continue
        nn /= np.linalg.norm(nn)
        probe = C4.mean(0) + 0.05 * nn                     # the jog must face the room: in front of both pieces
        if (A['n'] @ probe - A['d']) < 0 or (B['n'] @ probe - B['d']) < 0:
            C4 = C4[[1, 0, 3, 2]]
            nn = -nn
        eid = f"{A['eid']}_jog"
        tj = tangent(nn); uj = sorted([float(C4[0][[0, 2]] @ tj), float(C4[1][[0, 2]] @ tj)])
        e = dict(id=eid, kind='wall', source='jog between consecutive near-parallel wall pieces',
                 plane=dict(axis='n', normal=np.round(nn, 6).tolist(), offset=round(float(nn @ C4[0]), 5)),
                 u_axis=[round(float(tj[0]), 6), 0.0, round(float(tj[1]), 6)], u_range=[round(uj[0], 4), round(uj[1], 4)],
                 rect=dict(u=[round(uj[0], 4), round(uj[1], 4)], y=[round(float(C4[:, 1].min()), 4), round(float(C4[:, 1].max()), 4)]),
                 corners=np.round(C4, 5).tolist(), length_m=round(float(np.linalg.norm(C4[1] - C4[0])), 3), thickness=0.0)
        e.update(bake_quad(eid, C4, nn, float(nn @ C4[0])))
        elements.append(e)
    # ----- south glazing: round-2 plane, texture re-baked per pane
    import arch_solids_regions as AR
    piers = AR.south_pier_spans()
    g = dict(GLAZING_S)
    C4 = np.array(g['corners'], float)
    # glazing ends meet the wall pieces whose free end is within 0.45 m (line intersection at continuous coords)
    gn = np.array(g['plane']['normal'], float)
    ga, gc = line2(gn, float(gn @ C4[0]))
    for k_end, (kb, kt) in ((0, (0, 3)), (1, (1, 2))):
        q = C4[kb][[0, 2]]; best = None
        for e in elements:
            if 'jog' in e['id']:
                continue
            ne = np.array(e['plane']['normal'], float); de = float(e['plane']['offset'])
            if abs(np.array([ne[0], ne[2]]) @ ga) > np.cos(np.radians(20)):
                continue
            CE = np.array(e['corners'], float)
            for qe in (CE[0][[0, 2]], CE[1][[0, 2]]):
                if np.linalg.norm(qe - q) < 0.45:
                    X = intersect2(ga, gc, *line2(ne, de))
                    if X is not None and np.linalg.norm(X - q) < 0.45 and (best is None or np.linalg.norm(qe - q) < best[0]):
                        best = (np.linalg.norm(qe - q), X)
        if best is not None:
            for kk in (kb, kt):
                C4[kk][0], C4[kk][2] = best[1][0], best[1][1]
            log.append(f'glazing end {k_end} -> ({best[1][0]:.4f}, {best[1][1]:.4f})')
    for k in (0, 1):
        q = C4[k]; C4[k][1] = float(FL.height(fl, q[0], q[2])[0]) - 0.02
    n = np.array(g['plane']['normal'], float); d = float(n @ C4[2])
    # what is seen through the glass (round-2 depth band: 0.144 m in front .. 0.507 m behind), nearest surface per texel
    tex = bake_quad('glazing_r3_south', C4, n, d, kind_tol=0.144, cos_min=0.2, back=0.507)
    img = np.asarray(Image.open(os.path.join(OUT, tex['texture'])).convert('RGB')).astype(np.float64)
    obs = np.asarray(Image.open(os.path.join(OUT, tex['observed_mask']))) > 0
    # panes: columns between piers (x decreasing along u for the -z facing glazing: column 0 = x max)
    H_, W_ = obs.shape
    xs = C4[0][0] + (np.arange(W_) + 0.5) * PX * np.sign(C4[1][0] - C4[0][0])
    pane = np.full(W_, -1)
    edges = sorted([a for a, b in piers] + [b for a, b in piers])
    bounds = [C4[:, 0].min()] + edges + [C4[:, 0].max()]
    for k in range(len(bounds) - 1):
        pane[(xs >= bounds[k]) & (xs < bounds[k + 1])] = k
    out = img.copy()
    for k in np.unique(pane):
        cols = pane == k
        sub = img[:, cols]; ob = obs[:, cols]
        if ob.sum() < 20:
            continue
        med = np.median(sub[ob], axis=0)
        s2 = sub.copy(); s2[~ob] = med
        out[:, cols] = s2
    Image.fromarray(np.clip(np.round(out), 0, 255).astype(np.uint8)).save(os.path.join(OUT, tex['texture']), quality=90)
    g.update(id='glazing_r3_south', corners=np.round(C4, 5).tolist(), plane=dict(axis='n', normal=n.tolist(), offset=round(d, 5)),
             length_m=round(float(np.linalg.norm(C4[1] - C4[0])), 3),
             glazing=True, source='round-2 glazing plane; texture re-baked, unobserved texels = median colour of their pane '
                                  '(panes between the window-pier solids)', panes=len(bounds) - 1)
    g.update(tex)
    elements.append(g)
    doc = dict(source='r3/structure_r3.py', units='metres, y up (aligned scan frame)', method=__doc__,
               floor='out/r3/floor_r3.json', solids='out/r3/arch_solids.json', elements=elements, log=log,
               reflection_rule=dict(glazing='glazing_r3_south', plane_z=GLAZING_Z, beyond_m=0.10, blue_minus_red=25,
                                    note='scan samples more than 10 cm beyond the south glass with B-R > 25 are '
                                         'reflections of the city (not solid) -> reported separately in the metrics'))
    json.dump(doc, open(os.path.join(OUT3, 'structure_r3.json'), 'w'), indent=1, ensure_ascii=False)
    for l in log:
        print(l)
    for e in elements:
        print(f"{e['id']:<26} len {e.get('length_m', 0):6.2f} rms {e.get('rms_cm', 0):5.2f} lean {e.get('lean_cm_per_m', 0):5.2f} "
              f"pts {e.get('support_pts', 0):6d} obs {e.get('observed_fraction')}")
    print(f'wrote {len(elements)} elements ({time.time() - t0:.1f}s)')


if __name__ == '__main__':
    main()
