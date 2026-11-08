"""Parametric building-structure reconstruction of the lobby scan.

Floor + major vertical wall planes are detected from area-weighted surface samples
(sample_surface, ~1500 pts/m2), each wall is split into segments along its plane, and an
orthographic 1 cm/px colour texture is baked for every element from a dense re-sample of the
mesh faces that lie on it.  Outputs (under out/):
  structure.json          element list (floor + wall segments) with planes, rects, textures
  structure_points.npy    (K,16) float32 plane table for excluding wall/floor points later
  tex/*.png               baked textures (RGB) + tex/*_mask.png (1 = observed, 0 = filled)
  structure.glb           preview mesh: textured visible face of every element
"""
import os, sys, json, time
import numpy as np
from scipy import ndimage
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import load_aligned, sample_surface

OUT = os.path.join(HERE, 'out'); TEXD = os.path.join(OUT, 'tex')
os.makedirs(TEXD, exist_ok=True)
for _f in os.listdir(TEXD):   # remove only this script's own previous outputs
    if _f.startswith(('floor', 'wall_', 'glazing_')) and _f.endswith('.png'):
        os.remove(os.path.join(TEXD, _f))
PX = 0.01            # bake resolution: metres per texel
BAKE_DENSITY = 40000.0  # dense re-sample of inlier faces (pts / m2) -> ~4 samples per texel
DEBUG = '--debug' in sys.argv

t0 = time.time()
V, F, UV, TEX, ROT = load_aligned()
TH, TW = TEX.shape[:2]
P, C, N, FI = sample_surface(1500.0)
print(f'samples {len(P)}  ({time.time() - t0:.1f}s)')

# per-face geometry (for the bake)
FA, FB, FC = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
FCR = np.cross(FB - FA, FC - FA); FAREA = 0.5 * np.linalg.norm(FCR, axis=1)
FN = FCR / np.maximum(2 * FAREA[:, None], 1e-12)
FCEN = (FA + FB + FC) / 3


# ---------------------------------------------------------------- helpers
def push_pull(img, w):
    """Fill pixels with w==0 from a coarse-to-fine weighted pyramid (smooth hole filling)."""
    if w.min() > 0 or min(img.shape[:2]) <= 1:
        return img
    H, W = w.shape
    Hp, Wp = H + (H & 1), W + (W & 1)
    ip = np.zeros((Hp, Wp, img.shape[2])); ip[:H, :W] = img * w[..., None]
    wp = np.zeros((Hp, Wp)); wp[:H, :W] = w
    sw = wp.reshape(Hp // 2, 2, Wp // 2, 2).sum((1, 3))
    si = ip.reshape(Hp // 2, 2, Wp // 2, 2, -1).sum((1, 3))
    coarse = si / np.maximum(sw, 1e-9)[..., None]
    coarse = push_pull(coarse, np.minimum(sw, 1.0))
    up = ndimage.zoom(coarse, (Hp / coarse.shape[0], Wp / coarse.shape[1], 1), order=1)[:H, :W]
    a = np.minimum(w, 1.0)[..., None]
    return img * a + up * (1 - a)


def bake(face_ids, to_uv, size_px, extra_keep=None, seed=1):
    """Densely sample the given faces, map points to texel coords with to_uv(points)->(col,row),
    average colours per texel, fill holes. Returns (rgb uint8 HxWx3, observed mask bool)."""
    Wpx, Hpx = size_px
    rng = np.random.default_rng(seed)
    acc = np.zeros((Hpx * Wpx, 3)); cnt = np.zeros(Hpx * Wpx)
    face_ids = np.asarray(face_ids)
    for chunk in np.array_split(face_ids, max(1, len(face_ids) // 20000)):
        k = rng.poisson(FAREA[chunk] * BAKE_DENSITY) + 1
        idx = np.repeat(chunk, k)
        r1, r2 = rng.random(len(idx)), rng.random(len(idx)); s = np.sqrt(r1)
        w0, w1, w2 = 1 - s, s * (1 - r2), s * r2
        f = F[idx]
        p = V[f[:, 0]] * w0[:, None] + V[f[:, 1]] * w1[:, None] + V[f[:, 2]] * w2[:, None]
        t = UV[f[:, 0]] * w0[:, None] + UV[f[:, 1]] * w1[:, None] + UV[f[:, 2]] * w2[:, None]
        col = TEX[np.clip((t[:, 1] * TH).astype(np.int64), 0, TH - 1), np.clip((t[:, 0] * TW).astype(np.int64), 0, TW - 1)]
        if extra_keep is not None:
            keep = extra_keep(p, col); p, col = p[keep], col[keep]
        cu, rv = to_uv(p)
        ci, ri = np.floor(cu).astype(np.int64), np.floor(rv).astype(np.int64)
        ok = (ci >= 0) & (ci < Wpx) & (ri >= 0) & (ri < Hpx)
        lin = ri[ok] * Wpx + ci[ok]
        np.add.at(cnt, lin, 1)
        for c in range(3):
            acc[:, c] += np.bincount(lin, weights=col[ok, c].astype(np.float64), minlength=Hpx * Wpx)
    cnt = cnt.reshape(Hpx, Wpx); acc = acc.reshape(Hpx, Wpx, 3)
    obs = cnt > 0
    img = acc / np.maximum(cnt, 1)[..., None]
    img = push_pull(img, obs.astype(np.float64))
    return np.clip(np.round(img), 0, 255).astype(np.uint8), obs


def runs(b):
    """[start, end) index runs of True in a 1-D bool array."""
    d = np.diff(np.r_[0, b.astype(np.int8), 0])
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))


# ---------------------------------------------------------------- 1. floor
up = (N[:, 1] > 0.9) & (P[:, 1] < 0.4)
hy, ey = np.histogram(P[up, 1], bins=80, range=(-0.2, 0.4))
y_mode = 0.5 * (ey[np.argmax(hy)] + ey[np.argmax(hy) + 1])
fl = up & (np.abs(P[:, 1] - y_mode) < 0.15)
FLOOR_Y = float(np.median(P[fl, 1]))
# local floor height field (0.5 m cells) to follow the scan's gentle warping (+-5 cm)
G = 0.5
gx, gz = int(np.ceil(V[:, 0].max() / G)) + 1, int(np.ceil(V[:, 2].max() / G)) + 1
ci, cj = (P[fl, 2] / G).astype(int), (P[fl, 0] / G).astype(int)
hsum = np.zeros((gz, gx)); hcnt = np.zeros((gz, gx))
np.add.at(hcnt, (ci, cj), 1)
hmed = np.full((gz, gx), np.nan)
order = np.lexsort((P[fl, 1], ci * gx + cj))
lin = (ci * gx + cj)[order]; ys = P[fl, 1][order]
starts = np.r_[0, np.where(np.diff(lin))[0] + 1]; ends = np.r_[starts[1:], len(lin)]
for s_, e_ in zip(starts, ends):
    if e_ - s_ >= 25:
        hmed.flat[lin[s_]] = ys[(s_ + e_) // 2]
valid = ~np.isnan(hmed)
_, (ni, nj) = ndimage.distance_transform_edt(~valid, return_indices=True)
hfield = ndimage.uniform_filter(hmed[ni, nj], 3)


def floor_h(x, z):
    i = np.clip(z / G - 0.5, 0, gz - 1); j = np.clip(x / G - 0.5, 0, gx - 1)
    return ndimage.map_coordinates(hfield, [i, j], order=1, mode='nearest')


fin = up & (np.abs(P[:, 1] - floor_h(P[:, 0], P[:, 2])) < 0.05)
print(f'floor y={FLOOR_Y:.3f}  inliers {fin.sum()}  local height range {np.nanmin(hmed):.3f}..{np.nanmax(hmed):.3f}')
# footprint: 10 cm occupancy, closed, largest component, enclosed holes (under furniture) filled
FG = 0.1
occ = np.zeros((int(17.6 / FG) + 2, int(11.8 / FG) + 2), bool)
occ[(P[fin, 2] / FG).astype(int), (P[fin, 0] / FG).astype(int)] = True
cnt10 = np.zeros(occ.shape); np.add.at(cnt10, ((P[fin, 2] / FG).astype(int), (P[fin, 0] / FG).astype(int)), 1)
occ = cnt10 >= 3
occ = ndimage.binary_closing(occ, np.ones((3, 3)), iterations=2)
lab, nl = ndimage.label(occ)
occ = lab == (np.argmax(np.bincount(lab.ravel())[1:]) + 1)
occ = ndimage.binary_fill_holes(occ)
occ = ndimage.binary_opening(occ, np.ones((3, 3)))
zz, xx = np.where(occ)
floor_rect = dict(x=[round(xx.min() * FG, 2), round((xx.max() + 1) * FG, 2)],
                  z=[round(zz.min() * FG, 2), round((zz.max() + 1) * FG, 2)])
print('floor rect', floor_rect, 'footprint m2', occ.sum() * FG * FG)

# ---------------------------------------------------------------- 2. walls
hor = np.abs(N[:, 1]) < 0.3
nh = N[:, [0, 2]] / np.maximum(np.linalg.norm(N[:, [0, 2]], axis=1, keepdims=True), 1e-9)
ANG = np.degrees(np.arctan2(nh[:, 1], nh[:, 0]))
# dominant horizontal-normal directions: always the 4 axis directions, plus strong off-axis ones
ah, _ = np.histogram(ANG[hor], bins=360, range=(-180, 180))
ahs = np.convolve(np.r_[ah[-4:], ah, ah[:4]], np.ones(9), 'valid')  # +-4 deg window, wrapped
dirs = [0.0, 90.0, 180.0, -90.0]
for i in np.argsort(-ahs):
    if ahs[i] < 6000: break
    a = -179.5 + i
    if min(abs((a - d + 180) % 360 - 180) for d in dirs) > 10:
        dirs.append(float(a))
print('wall directions', dirs)


def angdiff(a, b):
    return np.abs((a - b + 180) % 360 - 180)


claimed = np.zeros(len(P), bool)
cands = []
for dg in dirs:
    a = np.radians(dg); n2 = np.array([np.cos(a), np.sin(a)]); t2 = np.array([n2[1], -n2[0]])
    dm = hor & (angdiff(ANG, dg) < 20)
    s_all = P[:, [0, 2]] @ n2; u_all = P[:, [0, 2]] @ t2
    s = s_all[dm]
    lo = np.floor(s.min() / 0.02) * 0.02; nb = int((s.max() - lo) / 0.02) + 2
    hh, ee = np.histogram(s, bins=nb, range=(lo, lo + 0.02 * nb))
    sup = np.convolve(hh, np.ones(5), 'same')
    peaks = [i for i in range(nb) if sup[i] == sup[max(0, i - 7):i + 8].max() and sup[i] >= 1200]
    for i in sorted(peaks, key=lambda i: -sup[i]):
        off0 = 0.5 * (ee[i] + ee[i + 1])
        band = dm & ~claimed & (np.abs(s_all - off0) < 0.25)
        if band.sum() < 1200: continue
        # drift-aware local offset: histogram mode of s per 0.5 m bin along the plane
        ub = np.floor(u_all[band] / 0.5).astype(int); sb = s_all[band]
        bins = np.unique(ub); loc = {}
        for b in bins:
            sv = sb[ub == b]
            if len(sv) < 40: continue
            hb, eb = np.histogram(sv, bins=50, range=(off0 - 0.25, off0 + 0.25))
            hb = np.convolve(hb, np.ones(3), 'same'); k = np.argmax(hb)
            if hb[k] < 20: continue
            loc[b] = 0.5 * (eb[k] + eb[k + 1])
        if len(loc) < 2: continue
        kb = np.array(sorted(loc)); kv = np.array([loc[b] for b in kb])
        # reject bins that jump away from their neighbours (furniture in front of the wall)
        med = ndimage.median_filter(kv, 5, mode='nearest')
        good = np.abs(kv - med) < 0.05
        kb, kv = kb[good], kv[good]
        if len(kb) < 2: continue
        prof_u = (kb + 0.5) * 0.5

        def local_off(u, prof_u=prof_u, kv=kv):
            return np.interp(u, prof_u, kv)

        inl = band & (np.abs(s_all - local_off(u_all)) < 0.04)
        if inl.sum() < 1200: continue
        # segment along the plane on a 10 cm (u, y) occupancy grid
        ui, yi = u_all[inl], P[inl, 1]
        u_lo = np.floor(ui.min() / 0.1) * 0.1
        nu = int((ui.max() - u_lo) / 0.1) + 1
        grid = np.zeros((nu, 30))
        np.add.at(grid, (((ui - u_lo) / 0.1).astype(int).clip(0, nu - 1), (yi / 0.1).astype(int).clip(0, 29)), 1)
        occg = grid >= 3
        # a wall column is well covered from 1.0 to 2.4 m (the lower part is often hidden behind
        # furniture: desk, sofas) and reaches >= 2.0 m
        frac = occg[:, 2:24].mean(1)            # y 0.2 .. 2.4 m
        upper = occg[:, 10:24].mean(1)          # y 1.0 .. 2.4 m
        low = occg[:, 1:6].sum(1) >= 2          # reaches down near the floor
        high = occg[:, 20:27].sum(1) >= 2
        wallcol = (upper >= 0.6) & high
        wallcol = ndimage.binary_closing(np.r_[False, False, False, wallcol, False, False, False], np.ones(4))[3:-3]
        if DEBUG:
            pa_ = n2 * off0 + t2 * ui.min(); pb_ = n2 * off0 + t2 * ui.max()
            print(f'   plane dir {dg:7.1f} off {off0:6.2f} inl {inl.sum():6d} ({pa_[0]:.1f},{pa_[1]:.1f})->({pb_[0]:.1f},{pb_[1]:.1f})  '
                  + ''.join('#' if w else ('u' if x_ >= 0.6 else ('+' if f_ > 0.2 else '.')) for w, x_, f_ in zip(wallcol, upper, frac)))
        for r0, r1 in runs(wallcol):
            if DEBUG: print(f'      run {(r1 - r0) * 0.1:.1f} m  low {low[r0:r1].mean():.2f}')
            if (r1 - r0) * 0.1 < 0.6: continue
            # the segment as a whole must touch the floor somewhere (rejects TV screens, wall cabinets)
            if low[r0:r1].mean() < 0.2: continue
            ua, ubb = u_lo + r0 * 0.1, u_lo + r1 * 0.1
            seg = inl & (u_all >= ua) & (u_all < ubb)
            sfrac = occg[r0:r1, 2:24].mean(); sup_ = occg[r0:r1, 10:24].mean()
            cands.append(dict(dir=dg, n2=n2, t2=t2, off=float(np.median(s_all[seg])), u=[float(ua), float(ubb)],
                              y=[float(np.percentile(P[seg, 1], 0.5)), float(np.percentile(P[seg, 1], 99.5))],
                              npts=int(seg.sum()), fill=float(sfrac), fill_upper=float(sup_), low=float(low[r0:r1].mean()), prof_u=prof_u, prof_v=kv, seg=seg))
        claimed |= inl

cands.sort(key=lambda c: -c['npts'])
print(f'{len(cands)} wall segment candidates')
for c in cands:
    L = c['u'][1] - c['u'][0]
    p0 = c['n2'] * c['off'] + c['t2'] * c['u'][0]; p1 = c['n2'] * c['off'] + c['t2'] * c['u'][1]
    print(f"  dir {c['dir']:7.1f} off {c['off']:6.2f}  len {L:5.2f}  y {c['y'][0]:.2f}-{c['y'][1]:.2f}  pts {c['npts']:6d}  "
          f"fill {c['fill']:.2f}/{c['fill_upper']:.2f} low {c['low']:.2f}  pts/m2 {c['npts'] / (L * (c['y'][1] - c['y'][0])):6.0f}  ({p0[0]:.2f},{p0[1]:.2f})->({p1[0]:.2f},{p1[1]:.2f})")

# keep the real major surfaces: >= 1 m long, well covered above furniture height, >= 2 m2 of support
walls = [c for c in cands if (c['u'][1] - c['u'][0]) >= 1.0 and c['fill_upper'] >= 0.7 and c['npts'] >= 3000]
for c in walls:
    useg = P[c['seg']][:, [0, 2]] @ c['t2']   # refine run ends with inlier percentiles
    c['u'] = [max(c['u'][0], float(np.percentile(useg, 0.2)) - 0.02), min(c['u'][1], float(np.percentile(useg, 99.8)) + 0.02)]
    c['glazing'] = False
    c['band'] = (0.05, 0.05)                  # bake band (in front of, behind) the local surface
print(f'kept {len(walls)} solid wall segments')

# ---------------------------------------------------------------- 2b. glazing (window walls)
# Glass is reconstructed sparsely and at scattered depths (the scanner sees the outside through it), so
# it never forms a tight offset peak.  Look for a broad (0.6 m) offset peak of horizontal-normal points
# per axis direction, ignoring points on accepted solid walls; accept runs >= 3 m that are covered above
# 1 m and lie on the outer edge of the floor footprint (floor in front, no floor behind).
near_solid = np.zeros(len(P), bool)
for c in walls:
    s_ = P[:, [0, 2]] @ c['n2']; u_ = P[:, [0, 2]] @ c['t2']
    near_solid |= (np.abs(s_ - c['off']) < 0.25) & (u_ > c['u'][0] - 0.2) & (u_ < c['u'][1] + 0.2)
hor5 = np.abs(N[:, 1]) < 0.5


def in_footprint(x, z):
    i = (z / FG).astype(int); j = (x / FG).astype(int)
    ok = (i >= 0) & (i < occ.shape[0]) & (j >= 0) & (j < occ.shape[1])
    r = np.zeros(len(x), bool); r[ok] = occ[i[ok], j[ok]]
    return r


for dg in [0.0, 90.0, 180.0, -90.0]:
    a = np.radians(dg); n2 = np.round(np.array([np.cos(a), np.sin(a)]), 6); t2 = np.array([n2[1], -n2[0]])
    dm = hor5 & (angdiff(ANG, dg) < 35) & ~near_solid
    s_all = P[:, [0, 2]] @ n2; u_all = P[:, [0, 2]] @ t2
    sel = dm & (P[:, 1] > 0.8)
    lo = np.floor(s_all[sel].min() / 0.05) * 0.05; nb = int((s_all[sel].max() - lo) / 0.05) + 2
    hh, ee = np.histogram(s_all[sel], bins=nb, range=(lo, lo + 0.05 * nb))
    sm = np.convolve(hh, np.ones(13), 'same')
    i = int(np.argmax(sm))
    if sm[i] < 6000: continue
    cen = 0.5 * (ee[i] + ee[i + 1])
    band = dm & (np.abs(s_all - cen) < 0.35)
    ui, yi = u_all[band], P[band, 1]
    u_lo = np.floor(ui.min() / 0.1) * 0.1; nu = int((ui.max() - u_lo) / 0.1) + 1
    g = np.zeros((nu, 30)); np.add.at(g, (((ui - u_lo) / 0.1).astype(int).clip(0, nu - 1), (yi / 0.1).astype(int).clip(0, 29)), 1)
    colf = (g[:, 10:24] >= 1).mean(1)
    col = colf >= 0.4
    if DEBUG: print(f'   glazing scan dir {dg} cen {cen:.2f} sup {sm[i]:.0f} u0 {u_lo:.1f} ' + ''.join('#' if x >= 0.6 else ('+' if x >= 0.4 else '.') for x in colf))
    col = ndimage.binary_closing(np.r_[np.zeros(16, bool), col, np.zeros(16, bool)], np.ones(16))[16:-16]  # bridge <= 1.5 m occlusions
    for r0, r1 in runs(col):
        if (r1 - r0) * 0.1 < 3.0: continue
        ua, ub_ = u_lo + r0 * 0.1, u_lo + r1 * 0.1
        seg = band & (u_all >= ua) & (u_all < ub_)
        off = float(np.percentile(s_all[seg], 75))         # room-side face of the glazing
        uu = np.linspace(ua, ub_, 60)
        f_in = np.mean([in_footprint(*(n2[None] * (off + dd) + t2[None] * uu[:, None]).T).mean() for dd in (0.6, 1.2, 1.8)])
        b_in = np.mean([in_footprint(*(n2[None] * (off - dd) + t2[None] * uu[:, None]).T).mean() for dd in (0.6, 1.2)])
        if DEBUG: print(f'   glazing? dir {dg} off {off:.2f} len {ub_ - ua:.1f} floor front {f_in:.2f} behind {b_in:.2f}')
        if f_in < 0.5 or b_in > 0.2: continue
        sv = s_all[seg]
        walls.append(dict(dir=dg, n2=n2, t2=t2, off=off, u=[float(ua), float(ub_)],
                          y=[0.0, float(np.percentile(P[seg, 1], 99.5))], npts=int(seg.sum()),
                          fill=float((g[r0:r1, 2:24] >= 1).mean()), fill_upper=float((g[r0:r1, 10:24] >= 1).mean()), low=0.0,
                          prof_u=np.array([ua, ub_]), prof_v=np.array([off, off]), seg=seg, glazing=True,
                          band=(float(np.percentile(sv, 98) - off) + 0.02, float(off - np.percentile(sv, 2)) + 0.02)))
        print(f'glazing dir {dg} off {off:.2f} u {ua:.1f}..{ub_:.1f} pts {seg.sum()} depth spread {walls[-1]["band"]}')

# ---------------------------------------------------------------- 2c. corner snapping
# extend/trim segment ends to the intersection with a neighbouring non-parallel segment when both ends are close
snaps = []
for i, A in enumerate(walls):
    for j, B in enumerate(walls):
        if j <= i or abs(A['n2'] @ B['n2']) > 0.95: continue
        M = np.array([A['n2'], B['n2']]); X = np.linalg.solve(M, [A['off'], B['off']])
        tol = 1.0 if (A['glazing'] or B['glazing']) else 0.3
        ea = [k for k in (0, 1) if abs(X @ A['t2'] - A['u'][k]) < tol]
        eb = [k for k in (0, 1) if abs(X @ B['t2'] - B['u'][k]) < tol]
        if ea and eb:
            snaps.append((i, ea[0], float(X @ A['t2']))); snaps.append((j, eb[0], float(X @ B['t2'])))
            print(f'snap corner ({X[0]:.2f},{X[1]:.2f})  between {A["dir"]}/{A["off"]:.2f} and {B["dir"]}/{B["off"]:.2f}')
for i, k, u in snaps:
    walls[i]['u'][k] = u

# ---------------------------------------------------------------- 2d. floor footprint completion
# the floor physically runs up to the walls: rasterise wall / glazing lines into the occupancy as barriers,
# close small gaps and fill every region enclosed by floor + walls (behind the desk, under the sofas)
bar = np.zeros_like(occ)
for c in walls:
    uu = np.arange(c['u'][0], c['u'][1], 0.02)
    xy = c['n2'][None] * c['off'] + c['t2'][None] * uu[:, None]
    i, j = (xy[:, 1] / FG).astype(int), (xy[:, 0] / FG).astype(int)
    ok = (i >= 0) & (i < occ.shape[0]) & (j >= 0) & (j < occ.shape[1]); bar[i[ok], j[ok]] = True
occ0 = occ.copy()
occ = ndimage.binary_fill_holes(ndimage.binary_closing(occ | bar, np.ones((3, 3)), iterations=2) | occ | bar)
occ &= ndimage.binary_dilation(occ0, np.ones((3, 3)), iterations=12)   # never grow > 1.2 m away from scanned floor
occ = ndimage.binary_opening(occ, np.ones((2, 2))) | occ0
zz, xx = np.where(occ)
floor_rect = dict(x=[round(xx.min() * FG, 2), round((xx.max() + 1) * FG, 2)],
                  z=[round(zz.min() * FG, 2), round((zz.max() + 1) * FG, 2)])
print('completed floor footprint', floor_rect, 'm2', round(occ.sum() * FG * FG, 2), '(scanned', round(occ0.sum() * FG * FG, 2), ')')


def lum(col):
    return col.astype(np.float64) @ np.array([0.299, 0.587, 0.114])


def chroma(col):
    c = col.astype(np.float64) + 1.0
    return c[:, [0, 2]] / c.sum(1, keepdims=True)


# robust reference floor colour (median per 0.5 m cell, then a 3.5 m median filter): the scan texture has the
# chairs / table imprinted onto the floor and chair bases sit within the floor band, so floor samples much
# darker than, or of a different hue from, the surrounding floor are dropped and the holes are filled smoothly
ci_, cj_ = (P[fin, 2] / G).astype(int), (P[fin, 0] / G).astype(int)


def cell_median(vals):
    ref = np.full((gz, gx), np.nan)
    order = np.lexsort((vals, ci_ * gx + cj_)); lin = (ci_ * gx + cj_)[order]; vs = vals[order]
    st = np.r_[0, np.where(np.diff(lin))[0] + 1]; en = np.r_[st[1:], len(lin)]
    for s_, e_ in zip(st, en):
        if e_ - s_ >= 25: ref.flat[lin[s_]] = vs[(s_ + e_) // 2]
    _, (ni, nj) = ndimage.distance_transform_edt(np.isnan(ref), return_indices=True)
    return ndimage.median_filter(ref[ni, nj], 7)


REF = [cell_median(lum(C[fin]))] + [cell_median(chroma(C[fin])[:, k]) for k in (0, 1)]


def floor_ok(p, col):
    i = np.clip(p[:, 2] / G - 0.5, 0, gz - 1); j = np.clip(p[:, 0] / G - 0.5, 0, gx - 1)
    r = [ndimage.map_coordinates(R, [i, j], order=1, mode='nearest') for R in REF]
    ch = chroma(col)
    return (lum(col) > FLOOR_DARK * r[0]) & (np.abs(ch[:, 0] - r[1]) < FLOOR_HUE) & (np.abs(ch[:, 1] - r[2]) < FLOOR_HUE)


# ---------------------------------------------------------------- 3. bake + describe
elements, plane_rows = [], []


def vec3(v2, y=0.0):
    return [round(float(v2[0]), 4), round(float(y), 4), round(float(v2[1]), 4)]


# floor
fx0, fx1 = floor_rect['x']; fz0, fz1 = floor_rect['z']
Wf, Hf = int(round((fx1 - fx0) / PX)), int(round((fz1 - fz0) / PX))
FB_ = 0.035   # floor bake band around the local height field (keeps chair bases / rugs out)
FLOOR_HUE = 0.05  # max deviation of r/(r+g+b), b/(r+g+b) from the local floor
FLOOR_DARK = 0.72   # drop floor samples much darker than the local floor (chair bases, furniture imprinted into the scan texture)
ffaces = np.where((FN[:, 1] > 0.85) & (np.abs(FCEN[:, 1] - floor_h(FCEN[:, 0], FCEN[:, 2])) < FB_ + 0.01)
                  & (FCEN[:, 0] > fx0 - 0.05) & (FCEN[:, 0] < fx1 + 0.05) & (FCEN[:, 2] > fz0 - 0.05) & (FCEN[:, 2] < fz1 + 0.05))[0]
rgb, obs = bake(ffaces, lambda p: ((p[:, 0] - fx0) / PX, (p[:, 2] - fz0) / PX), (Wf, Hf),
                extra_keep=lambda p, col: (np.abs(p[:, 1] - floor_h(p[:, 0], p[:, 2])) < FB_)
                & floor_ok(p, col))
Image.fromarray(rgb).save(os.path.join(TEXD, 'floor.png'))
rr, cc = np.mgrid[0:Hf, 0:Wf]
fp = occ[((fz0 + (rr + 0.5) * PX) / FG).astype(int).clip(0, occ.shape[0] - 1), ((fx0 + (cc + 0.5) * PX) / FG).astype(int).clip(0, occ.shape[1] - 1)]
Image.fromarray((obs * 255).astype(np.uint8)).save(os.path.join(TEXD, 'floor_mask.png'))
Image.fromarray((fp * 255).astype(np.uint8)).save(os.path.join(TEXD, 'floor_footprint.png'))
np.save(os.path.join(OUT, 'floor_footprint_10cm.npy'), occ)
elements.append(dict(
    id='floor', kind='floor',
    plane=dict(axis='y', offset=round(FLOOR_Y, 4), normal=[0, 1, 0]),
    rect=dict(x=floor_rect['x'], z=floor_rect['z']),
    thickness=0.05,
    texture='tex/floor.png', texture_size=[Wf, Hf], metres_per_px=PX,
    texture_layout='column 0 = x min, row 0 = z min (image up = -z, same as the top view); slab extends 0.05 m below the plane',
    observed_mask='tex/floor_mask.png',
    footprint_mask='tex/floor_footprint.png', footprint_grid='floor_footprint_10cm.npy',
    footprint_note='floor region (10 cm cells, [z, x] = cell (z/0.1, x/0.1)): scanned floor + regions enclosed by floor and walls '
                   '(under the desk / sofas / table), max 1.2 m from scanned floor; '
                   'the rect is its bounding box, texels outside it are hole-filled colour',
    footprint_m2=round(float(occ.sum() * FG * FG), 2), scanned_footprint_m2=round(float(occ0.sum() * FG * FG), 2), observed_fraction=round(float(obs.mean()), 3),
    support_pts=int(fin.sum()),
    height_range=[round(float(np.nanmin(hmed)), 3), round(float(np.nanmax(hmed)), 3)],
))
plane_rows.append([0, 1, 0, FLOOR_Y, 1, 0, 0, fx0, fx1, fz0, fz1, 0.06, 0.06, 0, 0, 0])
print(f'floor tex {Wf}x{Hf}  observed {obs.mean():.2f}  faces {len(ffaces)}')

WALL_TOP = float(np.median([c['y'][1] for c in walls if not c['glazing']]))
for c in walls:   # glazing: the view through the glass extends above the ceiling line
    if c['glazing']: c['y'][1] = min(c['y'][1], WALL_TOP)
counters = {}
for c in walls:
    n2, t2, off = c['n2'], c['t2'], c['off']
    axis = 'x' if abs(n2[0]) > 0.999 else ('z' if abs(n2[1]) > 0.999 else 'n')
    y0 = FLOOR_Y if c['y'][0] < 0.4 else c['y'][0]
    y1 = c['y'][1]
    u0, u1 = c['u']
    prof_u, prof_v = c['prof_u'], c['prof_v']
    lo_ = lambda u, pu_=prof_u, pv_=prof_v: np.interp(u, pu_, pv_)
    bf, bb = c['band']
    wo = off * (n2[0] if axis == 'x' else n2[1]) if axis in 'xz' else off   # world x= / z= for axis walls
    tag = {'x': f"x{wo:.2f}", 'z': f"z{wo:.2f}", 'n': f"a{int(round(c['dir'])) % 360}"}[axis]
    pre = 'glazing' if c['glazing'] else 'wall'
    counters[(pre, tag)] = counters.get((pre, tag), 0) + 1
    wid = f"{pre}_{tag}_{counters[(pre, tag)]}"
    Ww, Hw = int(round((u1 - u0) / PX)), int(round((y1 - y0) / PX))
    fs = FCEN[:, [0, 2]] @ n2; fu = FCEN[:, [0, 2]] @ t2
    fnorm2 = FN[:, [0, 2]] @ n2
    dsf = fs - lo_(fu)
    ffs = np.where((fnorm2 > np.cos(np.radians(35 if c['glazing'] else 30))) & (dsf < bf + 0.01) & (dsf > -bb - 0.01)
                   & (fu > u0 - 0.05) & (fu < u1 + 0.05) & (FCEN[:, 1] > y0 - 0.05) & (FCEN[:, 1] < y1 + 0.05))[0]

    def keep(p, col, n2=n2, t2=t2, lo_=lo_, bf=bf, bb=bb):
        d_ = p[:, [0, 2]] @ n2 - lo_(p[:, [0, 2]] @ t2)
        return (d_ < bf) & (d_ > -bb)

    rgb, obs = bake(ffs, lambda p, t2=t2, u0=u0, y1=y1: (((p[:, [0, 2]] @ t2) - u0) / PX, (y1 - p[:, 1]) / PX), (Ww, Hw), extra_keep=keep)
    Image.fromarray(rgb).save(os.path.join(TEXD, wid + '.png'))
    Image.fromarray((obs * 255).astype(np.uint8)).save(os.path.join(TEXD, wid + '_mask.png'))
    pa, pb = n2 * off + t2 * u0, n2 * off + t2 * u1
    rect = {}
    if axis == 'x':
        rect['z'] = sorted([round(float(pa[1]), 3), round(float(pb[1]), 3)])
    elif axis == 'z':
        rect['x'] = sorted([round(float(pa[0]), 3), round(float(pb[0]), 3)])
    else:
        rect['u'] = [round(u0, 3), round(u1, 3)]
    rect['y'] = [round(float(y0), 3), round(float(y1), 3)]
    pu = np.linspace(u0, u1, max(2, int((u1 - u0) / 0.5) + 1))
    drift = lo_(pu) - off
    el = dict(
        id=wid, kind='wall',
        plane=dict(axis=axis, offset=round(float(wo), 4), normal=vec3(n2)),
        rect=rect,
        thickness=0.1,
        texture=f'tex/{wid}.png', texture_size=[Ww, Hw], metres_per_px=PX,
        u_axis=vec3(t2), u_range=[round(u0, 3), round(u1, 3)],
        corners=[vec3(pa, y0), vec3(pb, y0), vec3(pb, y1), vec3(pa, y1)],
        texture_layout='column 0 = corners[0] end (left as seen from the room), row 0 = top (y max); '
                       'plane = visible face, normal points into the room, slab extends thickness behind it',
        observed_mask=f'tex/{wid}_mask.png', observed_fraction=round(float(obs.mean()), 3),
        support_pts=c['npts'], fill=round(c['fill'], 3), fill_above_1m=round(c['fill_upper'], 3),
        length_m=round(u1 - u0, 3),
    )
    if axis == 'n':
        el['plane']['note'] = 'off-axis wall: plane is normal.x*x + normal.z*z = offset (not axis-aligned in the scan)'
    if c['glazing']:
        el['glazing'] = True
        el['confidence'] = 'low'
        el['note'] = ('window / glass curtain wall: glass is scanned sparsely at scattered depths, the plane is the '
                      'room-side face (75th pct), texture is a blurred projection of everything seen through it')
        el['depth_band'] = [round(-bb, 3), round(bf, 3)]
    else:
        el['offset_drift'] = [[round(float(a), 2), round(float(b), 3)] for a, b in zip(pu, drift)]
    elements.append(el)
    bfr, bbk = (bf, bb) if c['glazing'] else (0.04 + float(np.abs(drift).max()),) * 2
    plane_rows.append([n2[0], 0, n2[1], off, t2[0], 0, t2[1], u0, u1, y0, y1, bfr, bbk, 1, float(c['glazing']), 0])
    print(f'{wid:20s} axis {axis} off {wo:7.3f}  {u1 - u0:5.2f} x {y1 - y0:4.2f} m  tex {Ww}x{Hw}  faces {len(ffs)}  observed {obs.mean():.2f}  max drift {np.abs(drift).max():.3f}')

doc = dict(
    source='scan-assets/mesh.drc + tex.jpg (aligned with common.load_aligned, rotation %.3f deg)' % ROT,
    units='metres, y up, floor ~0.06, x in [0,11.7], z in [0,17.4]',
    method='sample_surface(1500/m2) -> floor = up-facing mode with 0.5 m local height field; walls = peaks of '
           'plane-offset histograms of horizontal-normal points per dominant direction (4 axis + strong off-axis), '
           'drift-aware inliers (+-4 cm of a per-0.5 m local offset), split into segments on a 10 cm (u,y) occupancy grid; '
           'glazing = broad offset peak on the floor-footprint edge; corners snapped; textures baked orthographically at '
           '1 cm/px from a 40k/m2 re-sample of the inlier faces, holes push-pull filled',
    elements=elements,
    planes_npy='structure_points.npy',
    planes_npy_columns=['nx', 'ny', 'nz', 'offset (n.p)', 'tx', 'ty', 'tz', 'u0', 'u1', 'v0', 'v1',
                        'band_front_m', 'band_back_m', 'is_wall', 'is_glazing', 'pad'],
    planes_npy_note='row k = elements[k]. Point p is on element k if -band_back < n.p - offset < band_front and its in-plane '
                    'coords lie inside the rect (walls: u = t.p in [u0,u1], y in [v0,v1]; floor: x in [u0,u1], z in [v0,v1], '
                    'better: floor_footprint_10cm.npy). offset here is n.p (for -x / -z facing walls it is minus the world '
                    'coordinate). For solid walls offset_drift in the json gives the per-0.5 m deviation for a tighter test.',
)
json.dump(doc, open(os.path.join(OUT, 'structure.json'), 'w'), indent=1, ensure_ascii=False)
np.save(os.path.join(OUT, 'structure_points.npy'), np.array(plane_rows, np.float32))
print(f'wrote {len(elements)} elements  ({time.time() - t0:.1f}s)')
