"""Round-3 furniture rebuild from the scan's real contours (contour.py + shape.py).

usage: python -I r3/rebuild.py <object id> [...]       (writes out/r3/obj/<id>.json; merge with r3/merge_objects.py)

Every object: scan sub-mesh (contour.object_mesh) -> object frame (round-2 transform) -> sections of the REAL scan
surface at continuous coordinates (contour.slice_contours: oriented-surface inside/outside + snap onto the exact
trimesh section) -> loft tracks -> vertical simplification (shape.simplify_sections) -> loft meshes -> texture of
every part baked from the original scan texture (shape.ScanTex, texture source = scan faces within 4 cm of the new
surface) -> fit metrics against the same scan sub-mesh for round 3 and round 2.

Strategies (geometry decisions all come from the scan; photos only say what an object is):
  generic 'y'   horizontal sections (desk shell, armchairs, pillar, side table, display pieces)
  sofa          sections across the sofa (x axis, outlines in (z, y)): arms, seat cushions and back cushions are
                separate parts; arm inner faces from the +-x facing scan surfaces, cushion seams from dips of the
                scanned back-top profile; seat / back split at the back cushion's front face; cushions are clamped to
                the majority profile along x (+-2 cm) so a person sitting on the sofa is not modelled
  table         racetrack top fitted (continuous parameters) to the boundary of the scanned top surface, slab
                thickness from the scanned edge faces; pedestal from horizontal sections inside its footprint
  display       mirror panel, glass cabinet and book shelf sliced separately (regions = round-2 part boxes + margin)
"""
import os, sys, json, time
import numpy as np
import trimesh
import shapely
from shapely.geometry import Polygon, box as sbox
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import contour as C          # noqa: E402
import shape as SH           # noqa: E402
from prims import object_part_meshes   # noqa: E402
from dbg_axis import draw_levels        # noqa: E402

_finalize = C.finalize_ring


def _safe_finalize(D, tol, *a, **k):
    """GEOS topology error on a self-touching ring -> plain Douglas-Peucker ring for that outline (as chairs_single)."""
    try:
        return _finalize(D, tol, *a, **k)
    except Exception:
        D = C.dedupe(C.ccw(np.asarray(D, float)))
        idx = C.dp_closed(D, tol)
        return D[idx] if len(idx) >= 3 else None


C.finalize_ring = _safe_finalize
OUTD = os.path.join(C.OUT, 'r3'); TEXD = os.path.join(OUTD, 'tex'); GLBD = os.path.join(OUTD, 'glb')
OBJD = os.path.join(OUTD, 'obj'); DBG = os.path.join(OUTD, 'dbg')
for d in (TEXD, GLBD, OBJD, DBG):
    os.makedirs(d, exist_ok=True)
OBJS = json.load(open(os.path.join(C.OUT, 'objects.json')))
BYID = {o['id']: o for o in OBJS}
LOG = []


def log(*a):
    s = ' '.join(str(x) for x in a); print(s, flush=True); LOG.append(s)


def r5(P):
    return np.round(np.asarray(P, float), 5).tolist()


def in_other_boxes(oid, Pw, prefix=None):
    """Boolean per world point: inside the (unpadded) box of another object (optionally only ids with `prefix`)."""
    m = np.zeros(len(Pw), bool)
    for q in OBJS:
        if q['id'] == oid or (prefix and not q['id'].startswith(prefix)):
            continue
        ql, qh = np.array(q['bbox']['min']), np.array(q['bbox']['max'])
        m |= np.all((Pw >= ql) & (Pw <= qh), axis=1)
    return m


def object_scan(oid, pad=0.06):
    """contour.object_mesh + neighbour exclusion: faces in the pad zone (outside this object's own box) that lie
    inside another object's box belong to that neighbour (e.g. the side table next to the sofa arm) and are dropped.
    CFG[oid] may set 'wall_tol' / 'structure' (wall planes used for the wall removal)."""
    o = BYID[oid]
    cfg = CFG.get(oid, {})
    om = C.object_mesh(o['bbox'], pad=pad, wall_tol=cfg.get('wall_tol', 0.06), structure=cfg.get('structure'))
    assert len(om['mesh'].faces) == len(om['face_ids'])
    c = om['mesh'].triangles_center
    lo, hi = np.array(o['bbox']['min']), np.array(o['bbox']['max'])
    own = np.all((c >= lo) & (c <= hi), axis=1)
    other = np.zeros(len(c), bool)
    for q in OBJS:
        if q['id'] == oid:
            continue
        ql, qh = np.array(q['bbox']['min']), np.array(q['bbox']['max'])
        other |= np.all((c >= ql) & (c <= qh), axis=1)
    keep = own | ~other
    # floor remnants: up-facing faces within 5 cm of the object's floor (the 0.5 m floor map misses local bumps)
    keep &= ~((om['mesh'].face_normals[:, 1] > 0.8) & (c[:, 1] - o['transform']['position'][1] < 0.05))
    if (~keep).any():
        fid = om['face_ids'][keep]
        S = C.scene()
        m = trimesh.Trimesh(S['V'], S['F'][fid], process=False); m.remove_unreferenced_vertices(); m.merge_vertices()
        om = dict(om, mesh=m, face_ids=fid, stats=dict(om['stats'], removed_neighbour_box=int((~keep).sum()), faces=int(len(fid))))
    log(f'  scan sub-mesh: {om["stats"]}')
    return om


# ===================================================================== generic horizontal-section lofts
def loft_parts_y(lm, name, vtol=0.006, params=None, regularize=True, hull=None, levels=None, step=None,
                 vmedian=2, min_rel_area=0.05, dbg=None, planes=False):
    t = time.time()
    res = C.slice_contours(lm, axis='y', params=params, regularize=regularize, hull=hull, levels=levels, step=step,
                           vmedian=vmedian)
    if planes:
        pl = SH.detect_planes(lm, **(planes if isinstance(planes, dict) else {}))
        k, tot = SH.snap_levels_to_planes(res, pl)
        log(f'  {name}: {len(pl)} scan planes (areas {[round(p["area"], 2) for p in pl[:12]]} m2 ...), '
            f'{k} of {tot} outline edges snapped onto them')
        res['planes'] = [dict(n=r5(p['n']), d=round(p['d'], 5), area_m2=round(p['area'], 3)) for p in pl]
    if dbg:
        draw_levels(lm, res, dbg)
    parts = C.lofts_from_levels(res, name=name, min_rel_area=min_rel_area)
    nraw = sum(len(p['sections']) for p in parts)
    for p in parts:
        p['sections'] = SH.simplify_sections(SH.smooth_sections(p['sections'], 'y'), vtol, axis='y')
    log(f'  {name}: {len(res["levels"])} levels -> {len(parts)} tracks, sections {nraw} -> '
        f'{sum(len(p["sections"]) for p in parts)} (vtol {vtol * 100:.1f} cm) features {res["params"].get("features")} '
        f'({time.time() - t:.1f}s)')
    return parts, res


def name_by_size(parts, main, other='piece'):
    """Largest loft (by top-view area x height) gets `main`, the rest other_1.. in decreasing size."""
    def size(p):
        a = max(abs(C.signed_area(s['outline'])) for s in p['sections'])
        lv = [s[p.get('axis', 'y')] for s in p['sections']]
        return a * (max(lv) - min(lv) + 1e-3)
    parts = sorted(parts, key=size, reverse=True)
    for i, p in enumerate(parts):
        p['name'] = main if i == 0 else f'{other}_{i}'
    return parts


def generic_y(oid, cfg):
    o = BYID[oid]; T = o['transform']
    om = object_scan(oid, pad=cfg.get('pad', 0.06))
    lm = C.local_mesh(om['mesh'], T)
    parts, res = loft_parts_y(lm, cfg.get('name', 'body'), vtol=cfg.get('vtol', 0.006), params=cfg.get('params'),
                              regularize=cfg.get('regularize', True), dbg=os.path.join(DBG, f'levels_{oid}.png'),
                              planes=cfg.get('planes', False), vmedian=cfg.get('vmedian', 2), step=cfg.get('step'))
    parts = name_by_size(parts, cfg.get('name', 'body'), cfg.get('other', 'piece'))
    return dict(om=om, parts=parts, method='horizontal sections of the scan (y), vertical simplification',
                obs=float(np.mean([L['observed'] for L in res['levels'] if L['method'] != 'ground-extension'])))


# ===================================================================== sofa: sections across the sofa (x axis)
def _runs(mask):
    out, i = [], 0
    while i < len(mask):
        if mask[i]:
            j = i
            while j + 1 < len(mask) and mask[j + 1]:
                j += 1
            out.append((i, j)); i = j + 1
        else:
            i += 1
    return out


def sofa_analysis(lm):
    """Arms, seat height, back-cushion front, cushion seams - all from the scan surface samples (object frame:
    x along the sofa, front = -z, y up)."""
    P, N, _, _ = C.sample_mesh(lm, 0.005)
    lo, hi = np.percentile(P, 0.2, 0), np.percentile(P, 99.8, 0)
    zc = 0.5 * (lo[2] + hi[2])
    xb = np.arange(lo[0], hi[0] + 0.01, 0.01); xc = 0.5 * (xb[:-1] + xb[1:])
    ix = np.clip(np.digitize(P[:, 0], xb) - 1, 0, len(xc) - 1)
    up = (N[:, 1] > 0.75) & (P[:, 2] < zc)
    top_up = np.full(len(xc), np.nan); top_all = np.full(len(xc), np.nan)
    for k in range(len(xc)):
        s = up & (ix == k)
        if s.sum() > 5:
            top_up[k] = np.percentile(P[s, 1], 90)
        a = ix == k
        if a.sum() > 5:
            top_all[k] = np.percentile(P[a, 1], 99)
    L = hi[0] - lo[0]
    mid = (xc > lo[0] + 0.3 * L) & (xc < hi[0] - 0.3 * L)
    seat_top = float(np.nanmedian(top_up[mid]))
    arm = np.nan_to_num(top_up, nan=0) > seat_top + 0.08
    runs = _runs(arm)
    left = [r for r in runs if xc[r[0]] < lo[0] + 0.4 * L]
    right = [r for r in runs if xc[r[1]] > hi[0] - 0.4 * L]
    out = dict(lo=lo, hi=hi, seat_top=seat_top)
    if left:
        r = max(left, key=lambda r: r[1] - r[0]); x_al = 0.5 * (xc[r[1]] + xc[min(r[1] + 1, len(xc) - 1)])
        # refine with the arm's inner face (samples facing +x between seat and arm top)
        arm_top = float(np.nanmedian(top_up[r[0]:r[1] + 1]))
        s = (N[:, 0] > 0.7) & (P[:, 1] > seat_top + 0.03) & (P[:, 1] < arm_top - 0.03) & (np.abs(P[:, 0] - x_al) < 0.06)
        if s.sum() > 30:
            x_al = float(np.median(P[s, 0]))
        out['x_al'] = x_al; out['arm_top_left'] = arm_top
    if right:
        r = max(right, key=lambda r: r[1] - r[0]); x_ar = 0.5 * (xc[r[0]] + xc[max(r[0] - 1, 0)])
        arm_top = float(np.nanmedian(top_up[r[0]:r[1] + 1]))
        s = (N[:, 0] < -0.7) & (P[:, 1] > seat_top + 0.03) & (P[:, 1] < arm_top - 0.03) & (np.abs(P[:, 0] - x_ar) < 0.06)
        if s.sum() > 30:
            x_ar = float(np.median(P[s, 0]))
        out['x_ar'] = x_ar; out['arm_top_right'] = arm_top
    xa, xb_ = out.get('x_al', lo[0]), out.get('x_ar', hi[0])
    # back cushion front (z) just above the seat, middle range
    s = (N[:, 2] < -0.5) & (P[:, 1] > seat_top + 0.04) & (P[:, 1] < seat_top + 0.14) & (P[:, 0] > xa + 0.1) & (P[:, 0] < xb_ - 0.1)
    out['z_split'] = float(np.percentile(P[s, 2], 30)) if s.sum() > 50 else float(zc + 0.15 * (hi[2] - lo[2]))
    # seams: dips of the back-top profile in the central half of the middle range
    from scipy import ndimage
    tb = ndimage.median_filter(np.nan_to_num(top_all, nan=np.nanmedian(top_all)), 5)
    c0, c1 = xa + 0.25 * (xb_ - xa), xb_ - 0.25 * (xb_ - xa)
    cen = np.nonzero((xc > c0) & (xc < c1))[0]
    seams = []
    if len(cen) > 5:
        k = cen[np.argmin(tb[cen])]
        inm = np.nonzero((xc > xa + 0.05) & (xc < xb_ - 0.05))[0]
        lmax = tb[inm[inm < k]].max() if (inm < k).any() else tb[k]
        rmax = tb[inm[inm > k]].max() if (inm > k).any() else tb[k]
        prom = min(lmax, rmax) - tb[k]
        out['seam_prominence'] = round(float(prom), 4)
        if prom >= 0.01:
            # sub-bin position: parabola through the minimum
            if 0 < k < len(tb) - 1:
                a, b, c = tb[k - 1], tb[k], tb[k + 1]; den = a - 2 * b + c
                dx = 0.5 * (a - c) / den if abs(den) > 1e-9 else 0.0
                seams.append(float(xc[k] + np.clip(dx, -0.5, 0.5) * 0.01))
            else:
                seams.append(float(xc[k]))
    out['seams'] = seams
    return out


def sofa(oid, cfg):
    o = BYID[oid]; T = o['transform']
    om = object_scan(oid)
    lm = C.local_mesh(om['mesh'], T)
    A = sofa_analysis(lm)
    log(f'  sofa analysis: seat_top {A["seat_top"]:.3f} arms x {A.get("x_al")} / {A.get("x_ar")} '
        f'z_split {A["z_split"]:.3f} seams {A["seams"]} (prominence {A.get("seam_prominence")})')
    step = cfg.get('step', 0.012)
    lo, hi = A['lo'], A['hi']
    feats = [f for f in (A.get('x_al'), A.get('x_ar')) if f is not None] + A['seams']
    levels = C.make_levels(float(lm.vertices[:, 0].min()), float(lm.vertices[:, 0].max()), step, feats)
    hull = sbox(lo[2] - 0.01, -0.002, hi[2] + 0.01, hi[1] + 0.01)
    t = time.time()
    res = C.slice_contours(lm, axis='x', levels=levels, hull=hull, vmedian=1,
                           params=dict(tol=cfg.get('tol', 0.005), features=feats, close=0.02))
    log(f'  x-sections: {len(res["levels"])} levels ({time.time() - t:.1f}s)')
    draw_levels(lm, res, os.path.join(DBG, f'levels_{oid}_x.png'), maxtiles=40)
    LV = res['levels']
    xs = np.array([L['level'] for L in LV])
    G = [unary_union([Polygon(p).buffer(0) for p in L['polygons']]) if L['polygons'] else Polygon() for L in LV]
    x_al = A.get('x_al', xs.min() - 1); x_ar = A.get('x_ar', xs.max() + 1)
    parts = []

    def make_part(name, items, x0=None, x1=None, ax='x'):
        """items: [(level, Polygon)] ascending; optional end sections at x0 / x1 (copies of the nearest outline)."""
        items = [(x, g) for x, g in items if g is not None and not g.is_empty and g.area > 4e-4]
        if len(items) < 2:
            return None
        secs = [{ax: round(float(x), 5), 'outline': SH.ring_of(g).tolist()} for x, g in items]
        if x0 is not None and x0 < secs[0][ax] - 1e-4:
            secs.insert(0, dict(secs[0], **{ax: round(float(x0), 5)}))
        if x1 is not None and x1 > secs[-1][ax] + 1e-4:
            secs.append(dict(secs[-1], **{ax: round(float(x1), 5)}))
        secs = SH.ground_profiles(secs)
        n0 = len(secs)
        secs = SH.simplify_sections(SH.smooth_sections(secs, ax, iters=cfg.get('smooth', 2)), cfg.get('vtol', 0.005), axis=ax)
        log(f'    {name}: {ax} {secs[0][ax]:+.3f}..{secs[-1][ax]:+.3f}  sections {n0} -> {len(secs)}')
        return dict(type='loft', name=name, axis=ax, max_slope_deg=75.0, sections=secs)

    def largest(g):
        gs = [q for q in C._geoms(g) if q.area > 1e-5]
        if not gs:
            return None
        q = Polygon(max(gs, key=lambda q: q.area).exterior)
        return SH.fill_under(q, recess=cfg.get('recess', 0.03)) if cfg.get('fill_under', True) else q

    # arms: sections along the depth (z axis, outlines in (x, y) = the arm's front-view silhouette); an arm is an
    # extrusion front-to-back, and x-sections through its rounded outer side are tangent to the surface (unreliable)
    def arm_z(name, keep_face, x_lo, x_hi):
        c = lm.triangles_center
        sm = trimesh.Trimesh(lm.vertices, lm.faces[keep_face(c[:, 0])], process=False); sm.remove_unreferenced_vertices()
        zl, zh = float(sm.vertices[:, 2].min()), float(sm.vertices[:, 2].max())
        r = C.slice_contours(sm, axis='z', levels=C.make_levels(zl, zh, step, []), hull=sbox(x_lo, -0.002, x_hi, hi[1] + 0.01),
                             vmedian=1, params=dict(tol=cfg.get('tol', 0.005), features=[], close=0.02))
        draw_levels(sm, r, os.path.join(DBG, f'levels_{oid}_{name}_z.png'), maxtiles=24)
        it = [(L['level'], largest(unary_union([Polygon(q).buffer(0) for q in L['polygons']]))) for L in r['levels'] if L['polygons']]
        it = [(z, g) for z, g in it if g is not None]
        cl = SH.consensus_window([g for _, g in it], half=cfg.get('arm_window', 10), band=cfg.get('band', 0.02))
        it = list(zip([z for z, _ in it], cl))
        return make_part(name, it, ax='z'), [L['observed'] for L in r['levels']]
    arm_obs = []
    if cfg.get('arm_axis', 'x') == 'z':
        if 'x_al' in A:
            p, ob = arm_z('arm_left', lambda x: x < x_al + 0.02, lo[0] - 0.01, x_al); arm_obs += ob
            if p: parts.append(p)
        if 'x_ar' in A:
            p, ob = arm_z('arm_right', lambda x: x > x_ar - 0.02, x_ar, hi[0] + 0.01); arm_obs += ob
            if p: parts.append(p)
    else:                       # x-sections (same slicing as the cushions): best fit to the scan
        def arm_sec(g):
            q = largest(g)
            if q is None:
                return None
            # an arm stands on the floor: a section that came out hollow or split (only the upholstered skin
            # classified as inside, < 60 % of the area under the top boundary of all its pieces) is closed under its
            # scanned top
            pieces = unary_union([p_ for p_ in C._geoms(g) if p_.area > 2e-4])
            hf = SH.heightfield_fill(pieces)
            return hf if q.area < 0.6 * hf.area else q
        if 'x_al' in A:
            p = make_part('arm_left', [(x, arm_sec(g)) for x, g in zip(xs, G) if x < x_al], x1=x_al)
            if p: parts.append(p)
        if 'x_ar' in A:
            p = make_part('arm_right', [(x, arm_sec(g)) for x, g in zip(xs, G) if x > x_ar], x0=x_ar)
            if p: parts.append(p)
        arm_obs = [L['observed'] for L in LV if not (A.get('x_al', -9) < L['level'] < A.get('x_ar', 9))]
    # cushions between the arms, split at the seams; seat / back split at the back cushion's front face
    cuts = [x_al] + sorted(A['seams']) + [x_ar]
    zs = A['z_split']
    big = 10.0
    for ci, (a, b) in enumerate(zip(cuts[:-1], cuts[1:])):
        sel = [(x, g) for x, g in zip(xs, G) if a < x < b]
        if len(sel) < 2:
            continue
        clamped, M = SH.consensus_clamp([g for _, g in sel], band=cfg.get('band', 0.02))
        if cfg.get('fill_under', True):
            clamped = [SH.fill_under(c, recess=cfg.get('recess', 0.03)) if not c.is_empty else c for c in clamped]
        n_cl = sum(1 for (x, g), c in zip(sel, clamped) if abs(g.area - c.area) > 0.002)
        log(f'    cushion bay {ci + 1}: x {a:+.3f}..{b:+.3f}, {len(sel)} sections, clamped {n_cl} (area change > 20 cm2)')
        seat = [(x, SH.clip_largest(c, sbox(-big, -big, zs, big))) for (x, _), c in zip(sel, clamped)]
        back = [(x, SH.clip_largest(c, sbox(zs, -big, big, big))) for (x, _), c in zip(sel, clamped)]
        suf = f'_{ci + 1}' if len(cuts) > 2 else ''
        for nm, it in (('seat_cushion' + suf, seat), ('back_cushion' + suf, back)):
            p = make_part(nm, it, x0=a, x1=b)
            if p: parts.append(p)
    obs = float(np.mean([L['observed'] for L in LV if A.get('x_al', -9) < L['level'] < A.get('x_ar', 9)] + arm_obs))
    meta = dict(seat_top=round(A['seat_top'], 4), arm_inner_x=[None if A.get(k) is None else round(A[k], 4) for k in ('x_al', 'x_ar')],
                seams_x=[round(s, 4) for s in A['seams']], seam_prominence_m=A.get('seam_prominence'),
                seat_back_split_z=round(zs, 4), section_step=step)
    return dict(om=om, parts=parts, obs=obs, meta=meta,
                method='sections across the sofa (x axis, outlines in (z, y)); '
                       'arms / seat cushions / back cushions as separate lofts; '
                       'cushions clamped to the majority profile along x (+-2 cm)')


# ===================================================================== table: fitted racetrack top + pedestal
def racetrack_fit(B, init_pts=None):
    """Least-squares racetrack (straight sides + semi-elliptic ends) to boundary points B (n,2) in (x, z), robust
    (soft-L1, two rounds of outlier rejection), bounded around the initial estimate from init_pts (default B).
    params: cx, cz, th, L (half straight length), b (half width), a (end depth). Returns params, residuals, inliers."""
    from scipy.optimize import least_squares
    I = B if init_pts is None else init_pts
    c0 = I.mean(0); _, _, Vt = np.linalg.svd(I - c0, full_matrices=False); d = Vt[0]
    th0 = np.arctan2(d[1], d[0])
    u = (I - c0) @ d; w = (I - c0) @ np.array([-d[1], d[0]])
    u0, u1 = np.percentile(u, [0.5, 99.5]); w0, w1 = np.percentile(w, [0.5, 99.5])
    c0 = c0 + d * 0.5 * (u0 + u1) + np.array([-d[1], d[0]]) * 0.5 * (w0 + w1)
    hl, hw = (u1 - u0) / 2, (w1 - w0) / 2
    x0 = np.array([c0[0], c0[1], th0, max(hl - hw, 0.01), hw, hw])
    lb = [c0[0] - 0.15, c0[1] - 0.15, th0 - 0.1, 0.0, 0.7 * hw, 0.05]
    ub = [c0[0] + 0.15, c0[1] + 0.15, th0 + 0.1, hl, 1.3 * hw, 1.5 * hw]

    def resid(p):
        cx, cz, th, L, b, a = p
        cs, sn = np.cos(th), np.sin(th)
        uu = (B[:, 0] - cx) * cs + (B[:, 1] - cz) * sn; ww = -(B[:, 0] - cx) * sn + (B[:, 1] - cz) * cs
        du = np.maximum(np.abs(uu) - L, 0)
        r_side = np.abs(ww) - b
        rho = np.sqrt((du / a) ** 2 + (ww / b) ** 2)
        r_end = np.sqrt(du ** 2 + ww ** 2) * (rho - 1) / np.maximum(rho, 1e-6)     # radial distance to the ellipse
        return np.where(np.abs(uu) <= L, r_side, r_end)
    keep = np.ones(len(B), bool)
    for it in range(3):
        sol = least_squares(lambda p: resid(p)[keep], np.clip(x0, lb, ub), bounds=(lb, ub), loss='soft_l1', f_scale=0.01)
        x0 = sol.x; r = resid(x0)
        keep = np.abs(r) < max(0.02, 3 * np.median(np.abs(r)))
    return x0, resid(x0), keep


def racetrack_ring(p, chord=0.0005):
    cx, cz, th, L, b, a = p
    n = int(np.clip(np.ceil(np.pi / np.arccos(max(1 - chord / max(a, b), -1)) ), 24, 256))
    t = np.linspace(-np.pi / 2, np.pi / 2, n)
    right = np.c_[L + a * np.cos(t), b * np.sin(t)]
    left = np.c_[-L - a * np.cos(t), -b * np.sin(t)]
    R = np.r_[right, left]
    cs, sn = np.cos(th), np.sin(th)
    return np.c_[cx + R[:, 0] * cs - R[:, 1] * sn, cz + R[:, 0] * sn + R[:, 1] * cs]


def table(oid, cfg):
    o = BYID[oid]; T = o['transform']
    om = object_scan(oid)
    lm = C.local_mesh(om['mesh'], T)
    P, N, _, _ = C.sample_mesh(lm, 0.004)
    # top surface: RANSAC plane through the up-facing samples (the scan's top is warped by up to ~5 cm across the
    # 3.7 m table, so a fixed height band only catches part of it)
    up = (N[:, 1] > 0.9) & (P[:, 1] > 0.6) & (P[:, 1] < 0.9)
    Pu = P[up]; rng = np.random.default_rng(0); best = (0, None)
    for _ in range(300):
        i = rng.choice(len(Pu), 3, replace=False); q = Pu[i]
        n = np.cross(q[1] - q[0], q[2] - q[0]); nn = np.linalg.norm(n)
        if nn < 1e-9:
            continue
        n /= nn; n *= np.sign(n[1])
        if n[1] < 0.98:
            continue
        c = int((np.abs((Pu - q[0]) @ n) < 0.012).sum())
        if c > best[0]:
            best = (c, (n, q[0]))
    n, q0 = best[1]
    inl = np.abs((Pu - q0) @ n) < 0.012
    A_ = np.c_[Pu[inl, 0], Pu[inl, 2], np.ones(inl.sum())]
    coef, *_ = np.linalg.lstsq(A_, Pu[inl, 1], rcond=None)                 # y = a x + b z + c
    inl = np.abs(Pu[:, 1] - (A_full := np.c_[Pu[:, 0], Pu[:, 2], np.ones(len(Pu))]) @ coef) < 0.012
    top_xz = Pu[inl][:, [0, 2]]
    plane_y = lambda x, z: coef[0] * x + coef[1] * z + coef[2]
    y_top = float(np.median(Pu[inl, 1]))
    tilt = float(np.degrees(np.arctan(np.hypot(coef[0], coef[1]))))
    log(f'  table top plane: y = {coef[0]:+.4f} x {coef[1]:+.4f} z {coef[2]:+.4f} (tilt {tilt:.2f} deg = scan warp), '
        f'{inl.sum()} samples; level top at the median height {y_top:.4f}')
    al = C.alpha_shape(top_xz[::2], alpha=0.05)
    g = max(C._geoms(al), key=lambda q: q.area)
    B = C.resample_ring(np.asarray(g.exterior.coords)[:-1], 0.005)
    # keep only boundary points backed by the slab's edge face (near-vertical samples just below the top within 3 cm)
    hy = plane_y(P[:, 0], P[:, 2])
    E = (np.abs(N[:, 1]) < 0.5) & (P[:, 1] < hy + 0.005) & (P[:, 1] > hy - 0.06)
    from scipy.spatial import cKDTree
    dE, _ = cKDTree(P[E][:, [0, 2]]).query(B, distance_upper_bound=0.03)
    Bk = B[np.isfinite(dE)]
    prm, r, keep = racetrack_fit(Bk, init_pts=B)
    cx, cz, th, L, b, a = prm
    log(f'  table top outline: {len(B)} boundary points, {len(Bk)} on a scanned edge face; racetrack centre ({cx:.4f}, {cz:.4f}) '
        f'yaw {np.degrees(th):.2f} deg, straight 2x{L:.4f}, half width {b:.4f}, end depth {a:.4f}; residual p50 '
        f'{np.median(np.abs(r[keep])) * 100:.2f} cm p90 {np.percentile(np.abs(r[keep]), 90) * 100:.2f} cm, inliers {keep.mean():.2f}')
    ring = C.ccw(racetrack_ring(prm))
    rp = Polygon(ring)
    # slab edge: near-vertical samples within 2 cm of the fitted outline, measured down from the local top plane
    d_out = shapely.distance(rp.exterior, shapely.points(P[:, [0, 2]]))
    edge = (np.abs(N[:, 1]) < 0.5) & (d_out < 0.02) & (P[:, 1] < hy + 0.005) & (P[:, 1] > hy - 0.2)
    he, ee = np.histogram(hy[edge] - P[edge, 1], bins=np.arange(0, 0.2, 0.004))
    med = np.median(he[:5]) if he[:5].sum() else 1
    kk = 0
    while kk < len(he) and he[kk] >= 0.25 * med:
        kk += 1
    thick = float(ee[kk]) if kk > 0 else 0.03
    y_bot = y_top - thick
    log(f'  table slab: edge samples {edge.sum()}, thickness {thick * 100:.1f} cm -> underside y {y_bot:.4f}')
    top = dict(type='loft', name='top_slab', axis='y', max_slope_deg=75.0,
               sections=[dict(y=round(y_bot, 5), outline=r5(ring)), dict(y=round(y_top, 5), outline=r5(ring))],
               fit=dict(kind='racetrack', centre=[round(cx, 5), round(cz, 5)], yaw_deg=round(float(np.degrees(th)), 3),
                        half_straight=round(L, 5), half_width=round(b, 5), end_depth=round(a, 5),
                        boundary_resid_p50_cm=round(float(np.median(np.abs(r[keep]))) * 100, 2),
                        boundary_resid_p90_cm=round(float(np.percentile(np.abs(r[keep]), 90)) * 100, 2)))
    if cfg.get('top_follow_scan_plane'):
        # round 3 (fix): the slab follows the scanned top plane (1 deg scan warp) instead of being levelled at the
        # median height, so the top surface stays within the 2 cm texture-source distance of the scan everywhere
        tm_ = C.loft(top['sections'], axis='y')
        V_ = tm_.vertices.copy(); V_[:, 1] += plane_y(V_[:, 0], V_[:, 2]) - y_top
        top['_mesh_local'] = trimesh.Trimesh(V_, tm_.faces.copy(), process=False)
        top['tilt'] = dict(y_offset='y += a x + b z + c - top_y (object frame)', a=round(float(coef[0]), 6),
                           b=round(float(coef[1]), 6), c=round(float(coef[2]), 6), top_y=round(y_top, 5))
    # pedestal: horizontal sections below the slab inside the region under the slab's centre band
    ped_r2 = next((p for p in o['parts'] if p['name'] == 'pedestal'), None)
    region = Polygon(ped_r2['polygon']).buffer(cfg.get('ped_margin', 0.07)) if ped_r2 else rp.buffer(-0.25)
    chair = in_other_boxes(oid, om['mesh'].triangles_center, prefix='chair')
    sub_faces = shapely.contains_xy(region, lm.triangles_center[:, 0], lm.triangles_center[:, 2]) & (lm.triangles_center[:, 1] < y_bot - 0.005) & ~chair
    pm = trimesh.Trimesh(lm.vertices, lm.faces[sub_faces], process=False); pm.remove_unreferenced_vertices()
    log(f'  pedestal sub-mesh: {sub_faces.sum()} faces (chair faces excluded: {int((chair & (lm.triangles_center[:, 1] < y_bot)).sum())})')
    parts_p, res = loft_parts_y(pm, 'pedestal', vtol=cfg.get('vtol', 0.008), hull=region, vmedian=3,
                                params=dict(tol=0.006), dbg=os.path.join(DBG, f'levels_{oid}_pedestal.png'), planes=True)
    # metric subset: the table's own surfaces (chair faces below the slab underside excluded, for r2 and r3 alike)
    R_metric = ~(chair & (lm.triangles_center[:, 1] < y_bot - 0.01))
    parts_p = name_by_size(parts_p, 'pedestal', 'pedestal_piece')
    # the pedestal carries the slab: extend its top section up to the underside
    for p in parts_p:
        if p['name'] == 'pedestal' and p['sections'][-1]['y'] < y_bot - 1e-4:
            p['sections'].append(dict(p['sections'][-1], y=round(y_bot, 5)))
    parts_p = [p for p in parts_p if p['name'] == 'pedestal']
    if cfg.get('pedestal_planar'):
        # round 3 (critic fix): pedestal from planar facets of its scan surface (no majority-outline prism)
        pw = trimesh.Trimesh(om['mesh'].vertices, om['mesh'].faces[sub_faces], process=False); pw.remove_unreferenced_vertices()
        ped, _, _ = facet_parts(pw, T, 'pedestal', cfg.get('ped_min_area', 0.01), kw=cfg.get('facet_kw'))
        parts_p = [ped]
    elif cfg.get('pedestal_prism', True):
        # the pedestal is hidden behind the chairs (observed outline fraction ~0.4): majority outline (all pieces) of
        # its sections between 8 cm and 8 cm below the slab -> vertical prism(s) floor -> slab underside
        lv = [L for L in res['levels'] if 0.08 <= L['level'] <= y_bot - 0.08 and L['polygons']]
        _, M = SH.consensus_clamp([unary_union([Polygon(q).buffer(0) for q in L['polygons']]) for L in lv], band=0.0,
                                  frac=0.5, keep_all=True)
        comps = [g for g in C._geoms(M) if g.area > 0.01] if M is not None else []
        comps.sort(key=lambda g: g.bounds[0])
        parts_p = []
        for i, g in enumerate(comps):
            Mr = SH.ring_of(Polygon(g.exterior).simplify(0.006, preserve_topology=True))
            parts_p.append(dict(type='loft', name='pedestal' if len(comps) == 1 else f'pedestal_{i + 1}', axis='y',
                                max_slope_deg=75.0, sections=[dict(y=0.0, outline=Mr.tolist()),
                                                              dict(y=round(y_bot, 5), outline=Mr.tolist())]))
        log(f'  pedestal prism(s): majority outline of {len(lv)} levels -> {len(comps)} piece(s), areas '
            f'{[round(g.area, 3) for g in comps]} m2, x ranges {[(round(g.bounds[0], 3), round(g.bounds[2], 3)) for g in comps]}')
    obs = float(np.mean([L['observed'] for L in res['levels'] if L['method'] != 'ground-extension']))
    items = []
    if cfg.get('top_items'):
        # objects on the table top (laptops, bags, cups): scan faces more than 1 cm above the fitted top plane inside
        # the slab outline, single-linkage clusters (3 cm), each lofted from its observed levels
        tc = lm.triangles_center
        above = np.nonzero((tc[:, 1] > plane_y(tc[:, 0], tc[:, 2]) + 0.01) & (tc[:, 1] < y_top + 0.45) &
                           shapely.contains_xy(rp.buffer(0.02), tc[:, 0], tc[:, 2]) & ~in_other_boxes(oid, om['mesh'].triangles_center, prefix='chair'))[0]
        cl = cluster_faces(lm, above, r=0.03, min_area=0.004)
        for k, cf in enumerate(cl):
            items += items_from_faces(lm, cf, f'item_c{k}', min_obs=cfg.get('items_min_obs', 0.35))
        items = [p for p in items if max(abs(C.signed_area(s_['outline'])) for s_ in p['sections']) > 0.002]
        items = supported_items(items, T, om['mesh'], p90_max=cfg.get('items_p90', 0.06), mean_max=cfg.get('items_mean', 0.03))
        for k, p in enumerate(items):
            p['name'] = f'top_item_{k + 1}'
        log(f'  table-top items: {len(above)} faces above the top, {len(cl)} clusters -> {len(items)} item loft(s)')
    return dict(om=om, parts=[top] + parts_p + items, obs=obs, metric_faces=R_metric,
                meta=dict(top_y=round(y_top, 4), slab_thickness=round(thick, 4), scan_top_tilt_deg=round(tilt, 3),
                          metric_note='scan faces of the tucked-in chairs (inside chair boxes, below the slab) excluded '
                                      'from the fit metrics of r2 and r3'),
                method='racetrack top fitted to the scanned top-surface boundary + slab edge height; pedestal from '
                       'horizontal sections inside its footprint')


# ===================================================================== display: three pieces sliced separately
def display(oid, cfg):
    o = BYID[oid]; T = o['transform']
    om_all = object_scan(oid)
    lm_all = C.local_mesh(om_all['mesh'], T)
    cen = lm_all.triangles_center
    parts = []; obs = []
    for nm, (lo, hi), vtol, prm in cfg['regions']:
        lo, hi = np.array(lo, float), np.array(hi, float)
        sel = np.all((cen >= lo) & (cen <= hi), axis=1)
        sm = trimesh.Trimesh(lm_all.vertices, lm_all.faces[sel], process=False); sm.remove_unreferenced_vertices()
        hull = sbox(lo[0], lo[2], hi[0], hi[2])
        ps, res = loft_parts_y(sm, nm, vtol=vtol, hull=hull, params=prm, dbg=os.path.join(DBG, f'levels_{oid}_{nm}.png'))
        ps = name_by_size(ps, nm, nm + '_piece')
        parts += ps
        obs += [L['observed'] for L in res['levels'] if L['method'] != 'ground-extension']
    return dict(om=om_all, parts=parts, obs=float(np.mean(obs)),
                method='mirror panel / glass cabinet / book shelf: horizontal sections of the scan inside each piece\'s '
                       'region, vertical simplification')


# ===================================================================== planar facets (faceted desk, pedestal)
def facet_parts(M_world, T, name, min_area=0.02, kw=None):
    """Planar facets of a world scan sub-mesh -> one part (prebuilt mesh in the object frame + facet table)."""
    import planar as PL
    facets = PL.planar_facets(M_world, min_area=min_area, log=log, **(kw or {}))
    meshes, desc = [], []
    for f in facets:
        m = PL.facet_mesh(f)
        if m is None:
            continue
        meshes.append(m)
        o = C.to_local(f['origin'][None], T)[0]; R = C.Ry(T.get('yaw_deg', 0.0))
        desc.append(dict(normal=r5(f['n'] @ R), offset=round(float((f['n'] @ R) @ o), 5), origin=r5(o),
                         e1=r5(f['e1'] @ R), e2=r5(f['e2'] @ R), area_m2=round(float(f['poly_final'].area), 4),
                         scan_area_m2=round(f['area'], 4), rms_cm=f['rms_cm'],
                         outline=[r5(np.asarray(g.exterior.coords)[:-1]) for g in C._geoms(f['poly_final'])]))
    Mw = trimesh.util.concatenate(meshes)
    covered = np.unique(np.concatenate([f['faces'] for f in facets])) if facets else np.zeros(0, int)
    part = dict(type='planar_facets', name=name, facets=desc,
                note='facet = plane n.p = offset (object frame) + outline polygon(s) in (e1, e2) plane coordinates '
                     'from origin; edges trimmed at plane-plane intersections', _mesh_local=C.local_mesh(Mw, T))
    return part, Mw, covered


def cluster_faces(mesh, faces, r=0.03, min_area=0.01):
    """DBSCAN-like clusters (single linkage, radius r) of the given faces' centroids -> list of face index arrays."""
    from scipy.spatial import cKDTree
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    if len(faces) == 0:
        return []
    c = mesh.triangles_center[faces]
    pr = cKDTree(c).query_pairs(r, output_type='ndarray')
    g = coo_matrix((np.ones(len(pr)), (pr[:, 0], pr[:, 1])), shape=(len(c), len(c)))
    n, lab = connected_components(g, directed=False)
    out = []
    for k in range(n):
        f = faces[lab == k]
        if mesh.area_faces[f].sum() >= min_area:
            out.append(f)
    return sorted(out, key=lambda f: -mesh.area_faces[f].sum())


def supported_items(parts, T, scan_mesh, p90_max=0.04, mean_max=0.02):
    """Keep only item lofts whose surface lies on the scan (model -> scan p90 / mean)."""
    keep = []
    for p in parts:
        m = C.world_mesh(C.loft(p['sections'], axis='y'), T)
        Q, _, _, _ = C.sample_mesh(m, 0.01, seed=3)
        if len(Q) < 5:
            continue
        d = C.surface_distance(Q, scan_mesh)
        ok = np.percentile(d, 90) <= p90_max and d.mean() <= mean_max
        log(f'    item candidate area {m.area:.3f} m2 model->scan mean {d.mean() * 100:.2f} p90 {np.percentile(d, 90) * 100:.2f} cm '
            f'-> {"kept" if ok else "dropped"}')
        if ok:
            keep.append(p)
    return keep


def items_from_faces(lm, faces, name, min_obs=0.5, params=None):
    """Loose items (monitors, bags, laptops): horizontal sections of the given faces, only levels whose outline is
    at least min_obs on a real scan section (no ground extension / invented levels)."""
    if len(faces) < 30:
        return []
    sm = trimesh.Trimesh(lm.vertices, lm.faces[faces], process=False); sm.remove_unreferenced_vertices()
    hull = shapely.MultiPoint(sm.vertices[:, [0, 2]]).convex_hull.buffer(0.01)
    res = C.slice_contours(sm, axis='y', params=params or dict(tol=0.004, res=0.005, morph=0.003), ground=False,
                           hull=hull)
    nlev = len(res['levels'])
    res['levels'] = [L for L in res['levels'] if L['observed'] >= min_obs and L['method'] != 'ground-extension']
    parts = C.lofts_from_levels(res, name=name)
    for p in parts:
        p['sections'] = SH.simplify_sections(p['sections'], 0.004, axis='y')
    log(f'  {name}: {nlev} levels, {len(res["levels"])} with observed >= {min_obs} -> {len(parts)} loft(s)')
    return parts


def planar_solid(oid, cfg):
    o = BYID[oid]; T = o['transform']
    om = object_scan(oid)
    M = om['mesh']
    shell, Mw, covered = facet_parts(M, T, 'shell', cfg.get('min_area', 0.02), kw=cfg.get('facet_kw'))
    lm = C.local_mesh(M, T)
    cen = lm.triangles_center
    # plinth: horizontal sections 5..15 cm above the floor, one prism floor -> 15 cm
    low = np.nonzero(cen[:, 1] < 0.3)[0]
    parts = [shell]
    if len(low) > 50:
        sm = trimesh.Trimesh(lm.vertices, lm.faces[low], process=False); sm.remove_unreferenced_vertices()
        rp = C.slice_contours(sm, axis='y', levels=[0.05, 0.08, 0.11, 0.14], params=dict(tol=0.006), ground=False, vmedian=1)
        obs_p = [L['observed'] for L in rp['levels'] if L['polygons']]
        polys = [unary_union([Polygon(q).buffer(0) for q in L['polygons']]) for L in rp['levels'] if L['polygons'] and L['observed'] >= 0.4]
        log(f'  plinth sections observed {[round(v, 2) for v in obs_p]} (>= 0.4 used)')
        if len(polys) >= 2:
            _, Mj = SH.consensus_clamp(polys, band=0.0, frac=0.5, keep_all=True)
            comps = [g for g in C._geoms(Mj) if g.area > 0.01] if Mj is not None else []
            for i, g in enumerate(comps):
                Rg = SH.ring_of(Polygon(g.exterior).simplify(0.006, preserve_topology=True))
                parts.append(dict(type='loft', name='plinth' if len(comps) == 1 else f'plinth_{i + 1}', axis='y',
                                  max_slope_deg=75.0, sections=[dict(y=0.0, outline=Rg.tolist()), dict(y=0.15, outline=Rg.tolist())]))
            log(f'  plinth: majority outline of sections 5..14 cm -> {len(comps)} prism(s) 0..15 cm, areas '
                f'{[round(g.area, 3) for g in comps]} m2')
    # items on the desk: scan faces not explained by a facet (> 2 cm from the facet shell), above 0.5 m
    _, dfac, _ = trimesh.proximity.closest_point(Mw, M.triangles_center)
    item_f = np.nonzero((dfac > 0.02) & (cen[:, 1] > cfg.get('items_above', 0.5)))[0]
    items = []
    for k, cf in enumerate(cluster_faces(lm, item_f, r=0.03, min_area=0.01)):
        items += items_from_faces(lm, cf, f'item_c{k}', min_obs=cfg.get('items_min_obs', 0.35))
    items = [p for p in items if max(abs(C.signed_area(s_['outline'])) for s_ in p['sections']) > 0.003]
    items = supported_items(items, T, M, p90_max=cfg.get('items_p90', 0.04), mean_max=cfg.get('items_mean', 0.02))
    items = name_by_size(items, 'item_1', 'item') if items else []
    for k, p in enumerate(items):
        p['name'] = f'item_{k + 1}'
    parts += items
    return dict(om=om, parts=parts, obs=float(len(covered) / max(len(M.faces), 1)),
                method='planar facets of the scan (RANSAC planes -> connected regions -> PCA planes, outlines '
                       'trimmed at plane-plane intersections) + plinth prism from the 5..14 cm sections + desk items '
                       'lofted from the observed levels of the remaining scan surface',
                meta=dict(facets=len(shell['facets']), shell_scan_coverage=round(float(len(covered) / max(len(M.faces), 1)), 3)))


# ===================================================================== per-object configuration
CFG = {
    # round 3 (critic fix): the desk is a faceted solid -> planar facets instead of stacked horizontal sections
    'counter-01': dict(kind='planar', min_area=0.03, items_above=0.5, items_min_obs=0.35, items_p90=0.09, items_mean=0.035,
                       facet_kw=dict(adj_dist=0.07, grow=0.12, fill_holes=0.15)),
    'counter-01-sections': dict(kind='y', name='shell', other='item', vtol=0.012, params=dict(tol=0.008), planes=True,
                                vmedian=3, step=0.035),
    'table-01': dict(kind='table', pedestal_planar=True, top_items=True, ped_min_area=0.01, top_follow_scan_plane=True,
                     items_p90=0.09, items_mean=0.035,
                     facet_kw=dict(adj_dist=0.06, grow=0.10, fill_holes=0.05)),
    'sofa-01': dict(kind='sofa', fill_under=False, smooth=1),
    # a person sat on the right-hand cushions during the scan: geometry is clamped to the cushion majority profile;
    # texture: scan surface within 1.5 cm of the new cushions only, and texels whose source colour is grey / silver /
    # bluish (chroma < 18 % of the value or blue >= 0.8 red: the person, not the tan leather) are re-filled from
    # neighbouring leather texels
    'sofa-02': dict(kind='sofa', fill_under=False, smooth=1, band=0.012, tex_src_dist=0.015, tex_max_dist=0.02,
                    tex_min_chroma=0.18),
    'side-table-01': dict(kind='y', name='body', regularize=False, vtol=0.004),
    'armchair-01': dict(kind='y', name='shell', other='piece', vtol=0.006, params=dict(morph=0.004)),
    'chair-10': dict(kind='y', name='shell', other='piece', vtol=0.006, params=dict(morph=0.004)),
    # round 3 (fix): the pier stands 11 cm from the east glazing; the default 6 cm wall removal against the round-2
    # planes cut its east face (x 9.67..9.785) -> wall removal against the round-3 planes with 1.5 cm tolerance
    'pillar-01': dict(kind='y', name='pier', vtol=0.005, planes=dict(min_area=0.02), wall_tol=0.015,
                      structure=os.path.join(C.OUT, 'r3', 'structure_r3.json')),
    'display-01': dict(kind='display', regions=[
        ('mirror_panel', ([-0.86, 0.0, -0.56], [0.86, 2.6, -0.40]), 0.006, dict(morph=0.004, res=0.006)),
        ('glass_cabinet', ([-0.86, 0.0, -0.95], [0.86, 0.55, -0.56]), 0.006, dict(morph=0.004, res=0.006)),
        ('book_shelf', ([-0.86, 0.0, -0.40], [-0.33, 2.6, 0.96]), 0.006, dict(morph=0.004, res=0.006)),
    ]),
}
HANDLERS = dict(y=generic_y, sofa=sofa, table=table, display=display, planar=planar_solid)


# ===================================================================== outputs
def build(oid):
    t0 = time.time(); LOG.clear()
    cfg = CFG[oid]; o = BYID[oid]; T = o['transform']
    log(f'== {oid} ({o["label"]} / {o["label_en"]}) strategy {cfg["kind"]}')
    R = HANDLERS[cfg['kind']](oid, cfg)
    om, parts = R['om'], R['parts']
    yaw = T.get('yaw_deg', 0.0); Rf = C.Ry(yaw)
    loc_meshes, infos = [], []
    for p in parts:
        if '_mesh_local' in p:                 # planar facets: mesh built by planar.facet_mesh (object frame)
            m = p.pop('_mesh_local')
            inf = dict(faces=int(len(m.faces)), bands=0, steps=0, volume=0.0)
        else:
            m, inf = C.loft(p['sections'], axis=p.get('axis', 'y'), max_slope_deg=p.get('max_slope_deg', 75.0), return_info=True)
        loc_meshes.append(m); infos.append(inf)
    world = [C.world_mesh(m, T) for m in loc_meshes]
    model = trimesh.util.concatenate(world)
    # texture source: scan faces the new surface represents (within 4 cm of it)
    _, dsrc, _ = trimesh.proximity.closest_point(model, om['mesh'].triangles_center)
    tcl = C.to_local(om['mesh'].triangles_center, T)
    floorish = (om['mesh'].face_normals[:, 1] > 0.7) & (tcl[:, 1] < 0.05)
    srcm = (dsrc <= cfg.get('tex_src_dist', 0.04)) & ~floorish
    if cfg.get('tex_exclude_grey'):
        # a person sat on this sofa during the scan (grey / silver / black surfaces on a tan leather sofa): the
        # texture colour only identifies those faces; they are not used as texture source
        S = C.scene(); W3 = np.array([[1 / 3, 1 / 3, 1 / 3], [.6, .2, .2], [.2, .6, .2], [.2, .2, .6]])
        col = np.mean([C._bilinear(S['tex'], np.einsum('i,nij->nj', w, S['UV'][S['F'][om['face_ids']]])) for w in W3], 0)
        mx = col.max(1); grey = (col.max(1) - col.min(1)) < cfg['tex_exclude_grey'] * np.maximum(mx, 1)
        log(f'  texture source: {int((srcm & grey).sum())} low-chroma faces excluded (person)')
        srcm &= ~grey
    src = om['face_ids'][srcm]
    st = SH.ScanTex(src)
    ext = model.extents
    texel = float(np.clip(ext.max() / 400.0, 0.003, 0.006))
    tex_items, geom_items = [], []
    kept = []
    for p, mw, inf in zip(parts, world, infos):
        tm, img, ti = st.bake(mw, frame_R=Rf, texel=texel, max_dist=cfg.get('tex_max_dist', 0.02),
                              min_chroma=cfg.get('tex_min_chroma'))
        if ti['support_fraction_8cm'] < 0.05:      # no scan surface supports this loft: field noise, not an object part
            log(f'  part {p["name"]:<22} dropped: no supporting scan surface (support {ti["support_fraction_8cm"]})')
            continue
        kept.append((p, mw))
        fn = f'{oid}__{p["name"]}.jpg'
        img.save(os.path.join(TEXD, fn), quality=90)
        st.last_observed_mask.save(os.path.join(TEXD, fn[:-4] + '_observed.png'))
        p['color_rgb'] = ti['part_rgb']
        p['texture'] = dict(file=f'r3/tex/{fn}', uv='atlas: contour.make_charts + pack_charts of this loft mesh in world '
                            'coordinates, box projection in the object frame', texel_m=ti['texel_m'], atlas=ti['atlas'],
                            observed_fraction=ti['observed_fraction'], observed_mask=f'r3/tex/{fn[:-4]}_observed.png',
                            rule=ti['rule'])
        p['mesh_stats'] = dict(faces=inf['faces'], bands=inf['bands'], steps=inf['steps'], volume_m3=round(inf['volume'], 5))
        tex_items.append((f'{oid}:{p["name"]}', tm)); geom_items.append((f'{oid}:{p["name"]}', C.shaded(mw)))
        log(f'  part {p["name"]:<22} sections {len(p.get("sections", p.get("facets", []))):>3} faces {inf["faces"]:>5} bands {inf["bands"]:>3} '
            f'steps {inf["steps"]:>3} texture {ti["atlas"]} observed {ti["observed_fraction"]}')
    parts = [p for p, _ in kept]
    model = trimesh.util.concatenate([mw for _, mw in kept])
    C.export_glb(os.path.join(GLBD, f'{oid}.glb'), tex_items)
    C.export_glb(os.path.join(GLBD, f'{oid}_geom.glb'), geom_items)
    C.export_glb(os.path.join(GLBD, f'{oid}_scan.glb'), [(f'{oid}_scan', C.shaded(om['mesh']))])
    r2m = trimesh.util.concatenate([trimesh.Trimesh(m.vertices, m.faces, process=False) for _, m, _ in object_part_meshes(o)])
    C.export_glb(os.path.join(GLBD, f'{oid}_r2_geom.glb'), [(f'{oid}_r2', C.shaded(r2m, o['parts'][0].get('color_rgb', [200, 200, 200])))])
    ms = om['mesh']
    if R.get('metric_faces') is not None:
        ms = trimesh.Trimesh(om['mesh'].vertices, om['mesh'].faces[R['metric_faces']], process=False)
    fm3 = SH.fit_metrics(ms, model); fm2 = SH.fit_metrics(ms, r2m)
    log(f'  fit scan->r3 mean {fm3["scan_to_model"]["mean_cm"]} p90 {fm3["scan_to_model"]["p90_cm"]} '
        f'<=3cm {fm3["scan_to_model"]["within_3cm_pct"]}%   scan->r2 mean {fm2["scan_to_model"]["mean_cm"]} '
        f'p90 {fm2["scan_to_model"]["p90_cm"]} <=3cm {fm2["scan_to_model"]["within_3cm_pct"]}%')
    lo, hi = model.bounds
    out = {k: o[k] for k in ('id', 'label', 'label_en', 'anchor_suggestion', 'category') if k in o}
    if 'group' in o:
        out['group'] = o['group']
    out.update(transform=T, parts=parts, bbox=dict(min=r5(lo), max=r5(hi)), glb=f'r3/glb/{oid}.glb',
               fit=dict(source='round 3: r3/rebuild.py', method=R['method'], meta=R.get('meta', {}),
                        scan_faces=int(len(om['face_ids'])), scan_area_m2=round(float(om['mesh'].area), 3),
                        texture_source_faces=int(len(src)), observed_outline_fraction=round(R['obs'], 3),
                        metrics_r3=fm3, metrics_r2=fm2, faces=int(len(model.faces)),
                        seconds=round(time.time() - t0, 1)))
    json.dump(out, open(os.path.join(OBJD, f'{oid}.json'), 'w'), ensure_ascii=False)
    open(os.path.join(OBJD, f'{oid}.log'), 'w').write('\n'.join(LOG) + '\n')
    log(f'  done {time.time() - t0:.1f}s')
    return out


if __name__ == '__main__':
    for oid in sys.argv[1:]:
        build(oid)
