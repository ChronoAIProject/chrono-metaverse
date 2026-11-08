"""Fit parametric furniture models to the lobby scan -> out/objects.json (+ objects_meta.json).

Frame: aligned scan frame of common.load_aligned() (metres, +y up, walls axis-aligned).
Every object has transform {position:[x, floor_y, z], yaw_deg}; its parts are in object-local
coordinates (y = height above the object's local floor). yaw_deg is a right-handed rotation about +Y
(three.js Object3D.rotation.y): world = R(yaw) * local + position, R(yaw)(x,z) = (x cos + z sin, -x sin + z cos).
Furniture with a "front" faces local -Z.
Primitives:
  box      {size:[sx,sy,sz], position:[cx,cy,cz] (centre), yaw_deg}
  cylinder {radius, height, position (centre), segments}
  extrude  {polygon:[[x,z],...] (local, CCW seen from +Y), height, position:[ox, y_base, oz], yaw_deg}
Colours are sRGB 0-255 medians of the scan samples that belong to the part (color_n = sample count;
color_n = 0 means a default colour because the part was not observed).
"""
import os, sys, json, numpy as np
from scipy import ndimage
from scipy.signal import find_peaks
from scipy.spatial import ConvexHull
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prep import load, floor_map, floor_at, object_points, cluster_xz, SP, WALLS
from common import load_aligned

P, C, N = load()
G, GC = floor_map(P, N)
FL = floor_at(G, GC, P[:, 0], P[:, 2])
H = P[:, 1] - FL
X, Z = P[:, 0], P[:, 2]
UP = N[:, 1] > 0.85
BRIGHT = C.astype(int).max(1)
log = []

def say(*a):
    s = ' '.join(str(v) for v in a); print(s); log.append(s)

def box(x0, x1, z0, z1, h0=0.03, h1=3.0):
    return (X >= x0) & (X < x1) & (Z >= z0) & (Z < z1) & (H >= h0) & (H < h1)

def pct(v, q):
    return float(np.percentile(v, q))

def med_col(mask, default=(128, 128, 128), min_n=15):
    n = int(mask.sum())
    if n < min_n: return [int(c) for c in default], 0
    return [int(round(c)) for c in np.median(C[mask], 0)], n

def r3(v): return [round(float(x), 3) for x in v]

class Obj:
    def __init__(self, oid, label, label_en, anchor, category, x, z, yaw=0.0, group=None):
        self.d = {'id': oid, 'label': label, 'label_en': label_en, 'anchor_suggestion': anchor, 'category': category}
        if group: self.d['group'] = group
        self.x, self.z, self.yaw = float(x), float(z), float(yaw)
        self.fy = float(floor_at(G, GC, np.array([x]), np.array([z]))[0])
        self.parts, self.fit = [], {}
        self.c, self.s = np.cos(np.radians(yaw)), np.sin(np.radians(yaw))

    def to_local(self, wx, wz):
        dx, dz = wx - self.x, wz - self.z
        return dx * self.c - dz * self.s, dx * self.s + dz * self.c

    def _col(self, p, mask, default):
        col, n = med_col(mask, default) if mask is not None else ([int(c) for c in default], 0)
        p['color_rgb'] = col; p['color_n'] = n
        return p

    def box(self, name, xr, hr, zr, mask=None, default=(128, 128, 128), wyaw=0.0, centre=None, size=None):
        """World axis-aligned box xr=(x0,x1) zr=(z0,z1) hr=(h0,h1) heights above floor; or (centre,size,wyaw) for a rotated box."""
        if centre is None:
            cx, cz = (xr[0] + xr[1]) / 2, (zr[0] + zr[1]) / 2
            sx, sz = xr[1] - xr[0], zr[1] - zr[0]
        else:
            (cx, cz), (sx, sz) = centre, size
        lx, lz = self.to_local(cx, cz)
        ly = wyaw - self.yaw
        k = int(round(ly / 90.0))
        if abs(ly - 90 * k) < 1e-6:          # multiple of 90 deg: keep the box axis-aligned in local frame
            if k % 2: sx, sz = sz, sx
            ly = 0.0
        p = {'type': 'box', 'name': name, 'size': r3([sx, hr[1] - hr[0], sz]),
             'position': r3([lx, (hr[0] + hr[1]) / 2, lz]), 'yaw_deg': round(((ly + 180) % 360) - 180, 2)}
        self.parts.append(self._col(p, mask, default)); return p

    def cyl(self, name, cx, cz, r, hr, mask=None, default=(128, 128, 128), seg=24):
        lx, lz = self.to_local(cx, cz)
        p = {'type': 'cylinder', 'name': name, 'radius': round(float(r), 3), 'height': round(hr[1] - hr[0], 3),
             'position': r3([lx, (hr[0] + hr[1]) / 2, lz]), 'segments': seg}
        self.parts.append(self._col(p, mask, default)); return p

    def extrude(self, name, poly_world, hr, mask=None, default=(128, 128, 128)):
        poly = np.asarray(poly_world, float)
        loc = np.array([self.to_local(px, pz) for px, pz in poly])
        a = 0.5 * np.sum(loc[:, 0] * np.roll(loc[:, 1], -1) - np.roll(loc[:, 0], -1) * loc[:, 1])
        # CCW seen from +Y in an (x,z) plane means negative signed area in (x,z) coordinates
        if a > 0: loc = loc[::-1]
        p = {'type': 'extrude', 'name': name, 'polygon': [r3(v) for v in loc], 'height': round(hr[1] - hr[0], 3),
             'position': [0.0, round(hr[0], 3), 0.0], 'yaw_deg': 0.0}
        self.parts.append(self._col(p, mask, default)); return p

    def finish(self, **fit):
        pts = []
        for p in self.parts:
            if p['type'] == 'box':
                sx, sy, sz = p['size']; cx, cy, cz = p['position']; a = np.radians(p['yaw_deg'])
                for ux in (-.5, .5):
                    for uz in (-.5, .5):
                        x = ux * sx * np.cos(a) + uz * sz * np.sin(a); z = -ux * sx * np.sin(a) + uz * sz * np.cos(a)
                        pts += [(cx + x, cy - sy / 2, cz + z), (cx + x, cy + sy / 2, cz + z)]
            elif p['type'] == 'cylinder':
                cx, cy, cz = p['position']; r = p['radius']
                for t in np.linspace(0, 2 * np.pi, 16, endpoint=False):
                    pts += [(cx + r * np.cos(t), cy - p['height'] / 2, cz + r * np.sin(t)), (cx + r * np.cos(t), cy + p['height'] / 2, cz + r * np.sin(t))]
            else:
                ox, oy, oz = p['position']
                for x, z in p['polygon']: pts += [(ox + x, oy, oz + z), (ox + x, oy + p['height'], oz + z)]
        L = np.array(pts)
        W = np.c_[self.x + L[:, 0] * self.c + L[:, 2] * self.s, self.fy + L[:, 1], self.z - L[:, 0] * self.s + L[:, 2] * self.c]
        self.d['transform'] = {'position': r3([self.x, self.fy, self.z]), 'yaw_deg': round(self.yaw, 2)}
        self.d['parts'] = self.parts
        self.d['bbox'] = {'min': r3(W.min(0)), 'max': r3(W.max(0))}
        self.d['fit'] = fit
        OBJS.append(self.d)
        sz = W.max(0) - W.min(0)
        say(f"{self.d['id']:14s} {self.d['label']:10s} parts={len(self.parts):2d} size(x,y,z)={sz.round(2).tolist()} at ({self.x:.2f},{self.z:.2f}) yaw={self.yaw:g}")

OBJS = []

def stadium(x0, x1, z0, z1, n=12):
    r = (z1 - z0) / 2; zc = (z0 + z1) / 2; xa, xb = x0 + r, x1 - r
    pts = [(xb + r * np.cos(t), zc + r * np.sin(t)) for t in np.linspace(-np.pi / 2, np.pi / 2, n + 1)]
    pts += [(xa + r * np.cos(t), zc + r * np.sin(t)) for t in np.linspace(np.pi / 2, 3 * np.pi / 2, n + 1)]
    return pts

def in_poly(px, pz, poly):
    poly = np.asarray(poly); inside = np.zeros(len(px), bool); j = len(poly) - 1
    for i in range(len(poly)):
        xi, zi = poly[i]; xj, zj = poly[j]
        cond = ((zi > pz) != (zj > pz)) & (px < (xj - xi) * (pz - zi) / (zj - zi + 1e-12) + xi)
        inside ^= cond; j = i
    return inside

# =====================================================================================
# 1. Reception desk + diagonal logo wall
# =====================================================================================
reg = box(5.8, WALLS['x'][1] - 0.12, 3.6, 8.3, 0.03, 3.0)   # stay clear of the axis-aligned room walls
w = reg & (H > 1.6) & (X > 7.6) & (H < 2.6)
A = P[w][:, [0, 2]]; c0 = A.mean(0); d = np.linalg.svd(A - c0)[2][0]
if d[0] < 0: d = -d
nrm = np.array([-d[1], d[0]])
DIST = (P[:, [0, 2]] - c0) @ nrm; T = (P[:, [0, 2]] - c0) @ d
desk_side = np.sign(np.median(DIST[reg & (X < 7.0)]))
say('logo wall line centre', c0.round(3), 'dir', d.round(4), 'desk side', desk_side)

desk = reg & (np.abs(DIST) > 0.15) & (DIST * desk_side > 0) & (H < 1.45)
xf = pct(X[desk & (Z > 6.1) & (Z < 7.6) & (H > 0.2) & (H < 1.2)], 1.5)
zend = pct(Z[desk & (X > 6.2) & (X < 7.6) & (H > 0.2) & (H < 1.2)], 98.5)
# wing outer edge: per-slice minimum x, then a straight-line fit x = a z + b
zs, xs = [], []
for z0 in np.arange(4.1, 5.7, 0.1):
    s = desk & (Z >= z0) & (Z < z0 + 0.1) & (H > 0.3) & (H < 1.0)
    if s.sum() > 20: zs.append(z0 + 0.05); xs.append(pct(X[s], 3))
a_, b_ = np.polyfit(zs, xs, 1)
zc = (xf - b_) / a_
ztip = pct(Z[desk & (H > 0.3) & (H < 1.0)], 0.7)
corner, tip = np.array([xf, zc]), np.array([a_ * ztip + b_, ztip])
u = (tip - corner) / np.linalg.norm(tip - corner); wn = np.array([-u[1], u[0]])
if wn[0] < 0: wn = -wn                                   # inward = towards +x (staff side)
R_in = (P[:, [0, 2]] - corner) @ wn; S_al = (P[:, [0, 2]] - corner) @ u
wing = desk & (Z < zc - 0.1) & (S_al > 0) & (R_in > -0.05)
w_rim = pct(R_in[wing & UP & (H > 0.86) & (H < 1.02)], 95)
h_wing = float(np.median(H[wing & UP & (H > 0.86) & (H < 1.02)]))
topf = desk & UP & (H > 1.0) & (H < 1.3) & (Z > 6.1) & (Z < 7.3) & (X < 7.2)
x_fb = pct(X[topf], 97); h_front = float(np.median(H[topf]))
topr = desk & UP & (H > 1.0) & (H < 1.2) & (X > 6.9) & (X < 7.7) & (Z > 7.0)
z_ret = pct(Z[topr], 3); x_ret = pct(X[desk & UP & (H > 0.95) & (H < 1.2) & (Z > z_ret)], 98.5); h_ret = float(np.median(H[topr]))
say(f'desk: front x={xf:.3f} end z={zend:.3f} corner z={zc:.3f} tip=({tip[0]:.2f},{tip[1]:.2f}) rim w={w_rim:.2f} h_wing={h_wing:.2f} '
    f'front block x..{x_fb:.2f} h={h_front:.2f} return z {z_ret:.2f}.. x..{x_ret:.2f} h={h_ret:.2f}')
shell = desk & (np.abs(N[:, 1]) < 0.5) & (H > 0.15) & (H < 1.0) & (BRIGHT > 120)
o = Obj('counter-01', '前台接待台', 'reception desk', 'counter-01', 'desk', (xf + x_ret) / 2, (ztip + zend) / 2)
o.extrude('front_block', [(xf, zc), (xf, zend), (x_fb, zend), (x_fb, zc + 0.1)], (0, h_front), shell & (X < x_fb) & (Z > zc))
o.extrude('end_return', [(x_fb, z_ret), (x_fb, zend), (x_ret, zend), (x_ret, z_ret)], (0, h_ret), shell & (Z > z_ret))
o.extrude('wing', [tuple(corner), tuple(tip), tuple(tip + w_rim * wn), tuple(corner + w_rim * wn)], (0, h_wing), shell & wing)
# dark work surface: convex hull of the up-facing samples at work height (largest connected blob)
ws = desk & UP & (H > 0.68) & (H < 0.86) & (DIST * desk_side > 0.35)   # keep clear of the wall base
cs = 0.05; ix = ((X[ws] - 5.8) / cs).astype(int); iz = ((Z[ws] - 3.6) / cs).astype(int)
occ = np.zeros((ix.max() + 2, iz.max() + 2), int); np.add.at(occ, (ix, iz), 1)
lab, n = ndimage.label(ndimage.binary_closing(occ >= 1, iterations=1), structure=np.ones((3, 3)))
sz = np.bincount(lab.ravel()); sz[0] = 0; keep = lab[ix, iz] == sz.argmax()
wsp = P[ws][keep][:, [0, 2]]
hull = wsp[ConvexHull(wsp).vertices]
h_ws = float(np.median(H[ws][keep]))
o.extrude('work_surface', hull.tolist(), (h_ws - 0.04, h_ws), np.isin(np.arange(len(P)), np.where(ws)[0][keep]))
o.finish(points=int(desk.sum()), source='cluster 1 (desk side of the diagonal wall)',
         method='3 extruded white wings traced from outline lines (front x, end z, fitted wing edge) + convex-hull work surface',
         heights={'front': round(h_front, 3), 'return': round(h_ret, 3), 'wing': round(h_wing, 3), 'work_surface': round(h_ws, 3)})

# --- diagonal logo wall (white marble with logo + wood-clad end) ---
wall = reg & (np.abs(DIST) < 0.15) & (H > 0.3) & (H < 2.6)
t0, t1 = pct(T[wall], 0.5), pct(T[wall], 99.5)
bins = np.arange(t0, t1 + 0.05, 0.05); wood = []
cc = C.astype(int)
for b0 in bins:
    s = wall & (T >= b0) & (T < b0 + 0.05)
    wood.append(np.median(cc[s, 0] - cc[s, 2]) > 40 if s.sum() > 10 else False)
wood = np.array(wood)
# wood segment = the end of the line at the desk-front side (larger t means smaller z? check both ends)
wood_t = bins[wood]
t_split = float(wood_t.min()) if np.median(wood_t) > (t0 + t1) / 2 else float(wood_t.max() + 0.05)
wood_hi = np.median(wood_t) > (t0 + t1) / 2
h_wall = pct(H[reg & (np.abs(DIST) < 0.15)], 99)
say(f'logo wall t [{t0:.2f},{t1:.2f}] wood split {t_split:.2f} (wood at {"high" if wood_hi else "low"} t) top {h_wall:.2f}')
yaw_wall = float(np.degrees(np.arctan2(-d[1], d[0])))
o = Obj('logo-wall-01', '前台Logo背景墙', 'reception logo wall', 'wall-logo-01', 'wall_panel', *(c0 + d * (t0 + t1) / 2), yaw=yaw_wall)
white_m = wall & ((T < t_split) if wood_hi else (T >= t_split))
wood_m = wall & ~white_m
white_rng = (t0, t_split) if wood_hi else (t_split, t1)
wood_rng = (t_split, t1) if wood_hi else (t0, t_split)
TH = {}
for name, (ta, tb), m in [('white_panel', white_rng, white_m), ('wood_panel', wood_rng, wood_m)]:
    th = float(np.clip(pct(DIST[m], 95) - pct(DIST[m], 5), 0.08, 0.3))
    if name == 'wood_panel': th = max(th, 0.12)
    face = pct(DIST[m], 10 if desk_side < 0 else 90)          # the scanned, desk-facing surface
    TH[name] = (th, face)
    o.box(name, None, (0, h_wall), None, m, centre=c0 + d * (ta + tb) / 2 + nrm * (face - desk_side * th / 2), size=(tb - ta, th), wyaw=yaw_wall)
# logo graphic: dark samples on the white panel's room-facing side
lg = reg & (np.abs(DIST) < 0.12) & (H > 1.3) & (H < 2.6) & (BRIGHT < 110) & ((T < t_split - 0.15) if wood_hi else (T > t_split + 0.15)) & (T > t0 + 0.1) & (T < t1 - 0.1)
if lg.sum() > 30:
    # split the dark samples into text lines at the largest empty gap of the height histogram
    hb_ = np.arange(pct(H[lg], 1), pct(H[lg], 99) + 0.02, 0.02); hc = np.histogram(H[lg], bins=hb_)[0]
    runs, cur = [], None
    for i, v in enumerate(hc):
        if v == 0: cur = (cur[0], i) if cur else (i, i)
        elif cur: runs.append(cur); cur = None
    cuts = [hb_[a] + (hb_[b + 1] - hb_[a]) / 2 for a, b in runs if (b - a + 1) * 0.02 >= 0.04]
    edges = [-1] + sorted(cuts) + [9]
    face = TH['white_panel'][1] + desk_side * 0.008
    lines = []
    for i in range(len(edges) - 1):
        lm = lg & (H > edges[i]) & (H <= edges[i + 1])
        if lm.sum() > 15: lines.append(lm)
    for i, lm in enumerate(sorted(lines, key=lambda m: -np.median(H[m]))):
        la, lb = pct(T[lm], 4), pct(T[lm], 96); ha, hb = pct(H[lm], 3), pct(H[lm], 97)
        nm = 'logo_wordmark' if i == 0 else f'logo_tagline' if i == 1 else f'logo_line_{i+1}'
        o.box(nm, None, (ha, hb), None, lm, centre=c0 + d * (la + lb) / 2 + nrm * face, size=(lb - la, 0.012), wyaw=yaw_wall)
        say(f'{nm} {lb-la:.2f} x {hb-ha:.2f} m at h {ha:.2f}-{hb:.2f}, n={lm.sum()}')
o.finish(points=int(wall.sum()), source='tall non-axis-aligned plane inside cluster 1',
         method='PCA line fit of tall samples; white/wood split by median (R-B) colour along the line; logo = bbox of dark samples on the white face',
         notes='logo text is only a flat dark plate; use a texture decal for the actual ChronoAI artwork')

# =====================================================================================
# 2. LED video wall on the north wall (+ speakers, floor box)
# =====================================================================================
zw = WALLS['z'][0]
m = box(3.0, 9.5, zw - 0.15, zw + 0.2, 0.03, 2.9) & (N[:, 2] > 0.7)
blue = m & (cc[:, 2] > cc[:, 0] + 20)
sx0, sx1, sh0, sh1 = pct(X[blue], 1), pct(X[blue], 99), pct(H[blue], 1), pct(H[blue], 99)
zface = float(np.median(Z[blue]))
o = Obj('screen-01', 'LED大屏', 'LED video wall', 'screen-01', 'screen', (sx0 + sx1) / 2, zface, yaw=180.0)
o.box('led_panel', (sx0, sx1), (sh0, sh1), (zface - 0.08, zface), blue)
base = m & (H < sh0) & (BRIGHT < 80)
o.box('base_strip', (sx0, sx1), (0, sh0), (zface - 0.08, zface + 0.06), base, default=(30, 30, 32))
for nm, (a0, a1) in [('speaker_left', (3.55, 4.25)), ('speaker_right', (8.35, 9.05))]:
    s = box(a0, a1, zw - 0.05, zw + 0.5, 0.04, 1.4) & (BRIGHT < 60)
    xa, xb = pct(X[s], 8), pct(X[s], 92); za, zb = zface, pct(Z[s], 97); ht = pct(H[s], 98)
    o.box(nm, (xa, xb), (0, ht), (za, max(zb, za + 0.2)), s, default=(25, 25, 28))
    say(f'{nm}: x {xa:.2f}-{xb:.2f} z {za:.2f}-{zb:.2f} h {ht:.2f} n {s.sum()}')
s = box(5.9, 6.8, zw + 0.03, zw + 0.6, 0.03, 0.4) & (BRIGHT < 80)
o.box('floor_box', (pct(X[s], 3), pct(X[s], 97)), (0, pct(H[s], 97)), (pct(Z[s], 3), pct(Z[s], 97)), s, default=(30, 40, 55))
o.finish(points=int(blue.sum()), source='z=%.2f wall plane (removed as boundary in clustering) + clusters 13/14' % zw,
         method='bbox of +z-facing blue-dominant samples on the wall plane; speakers = dark samples next to it',
         notes='screen content (desktop image) is texture, not geometry; panel colour is the median of the displayed image')

# =====================================================================================
# 3. Long meeting table
# =====================================================================================
m = box(2.2, 7.2, 10.3, 12.6, 0.6, 1.1) & (N[:, 1] > 0.9)
hh = np.histogram(H[m], bins=np.arange(0.6, 1.1, 0.01))
h_top = float(hh[1][np.argmax(hh[0])] + 0.005)
m = box(2.2, 7.2, 10.3, 12.6, h_top - 0.04, h_top + 0.04) & (N[:, 1] > 0.9)
ix = ((X[m] - 2.2) / 0.05).astype(int); iz = ((Z[m] - 10.3) / 0.05).astype(int)
occ = np.zeros((ix.max() + 1, iz.max() + 1), int); np.add.at(occ, (ix, iz), 1)
lab, n = ndimage.label(ndimage.binary_closing(occ >= 1, iterations=2)); sz = np.bincount(lab.ravel()); sz[0] = 0
top = np.zeros(len(P), bool); top[np.where(m)[0][lab[ix, iz] == sz.argmax()]] = True
TX0, TX1 = pct(X[top], 0.7), pct(X[top], 99.3)
mid = top & (X > TX0 + 0.8) & (X < TX1 - 0.8)
TZ0 = float(np.median([pct(Z[mid & (X >= a) & (X < a + 0.25)], 1) for a in np.arange(TX0 + 0.8, TX1 - 0.8, 0.25)]))
TZ1 = float(np.median([pct(Z[mid & (X >= a) & (X < a + 0.25)], 99) for a in np.arange(TX0 + 0.8, TX1 - 0.8, 0.25)]))
tzc, tr = (TZ0 + TZ1) / 2, (TZ1 - TZ0) / 2; txc = (TX0 + TX1) / 2
cc_ = C.astype(int)
ped = box(TX0, TX1, TZ0, TZ1, 0.08, h_top - 0.1) & (cc_[:, 0] > cc_[:, 2] + 12) & (BRIGHT < 150)
px0 = pct(X[ped], 2); px1 = 2 * txc - px0                            # +x end is hidden by the lounge chair: mirror
fz = box(TX0 + 0.6, TX1 - 0.6, TZ0, tzc, 0.15, 0.6) & (np.abs(N[:, 2]) > 0.8)
hz = np.histogram(Z[fz], bins=np.arange(TZ0, tzc, 0.02)); pz0 = float(hz[1][np.argmax(hz[0])]); pz1 = 2 * tzc - pz0
say(f'table top h={h_top:.3f} x[{TX0:.2f},{TX1:.2f}] z[{TZ0:.2f},{TZ1:.2f}]  pedestal x[{px0:.2f},{px1:.2f}] z[{pz0:.2f},{pz1:.2f}]')
o = Obj('table-01', '长会议桌', 'long meeting table', 'table-01', 'table', txc, tzc)
o.extrude('top_slab', stadium(TX0, TX1, TZ0, TZ1), (h_top - 0.05, h_top), top)
o.extrude('pedestal', stadium(px0, px1, pz0, pz1, 8), (0, h_top - 0.05), ped)
o.finish(points=int(top.sum() + ped.sum()), source='cluster 2',
         method='height-histogram peak of up-facing samples = top; largest blob -> stadium (racetrack) outline; brown samples + face histogram -> pedestal',
         notes='pedestal +x end and depth are mirrored about the table centre (hidden by chairs)')

# =====================================================================================
# 4. Chairs around the table
# =====================================================================================
xa_, xb_ = TX0 + tr, TX1 - tr
SD = np.hypot(X - np.clip(X, xa_, xb_), Z - tzc) - tr
chp = box(2.0, 7.3, 10.1, 12.7, 0.3, 1.1) & (SD > 0.03) & (SD < 0.9)
SEAT_H, D = 0.46, 0.55
seat_obs = box(5.45, 6.2, 11.9, 12.5, 0.3, 0.6) & UP
if seat_obs.sum() > 30: SEAT_H = float(np.median(H[seat_obs]))
k = 0
for side, sgn in [('-z', -1), ('+z', 1)]:
    sm = chp & ((Z < tzc) if sgn < 0 else (Z > tzc)) & (X > xa_ - 0.3) & (X < xb_ + 0.3)
    hist = np.histogram(X[sm], bins=np.arange(2.0, 7.3, 0.05))[0]
    hs = ndimage.gaussian_filter1d(hist.astype(float), 2)
    pk, pr = find_peaks(hs, distance=9, prominence=3)
    say(f'chair peaks {side}:', (2.025 + pk * 0.05).round(2).tolist(), 'prominence', pr['prominences'].round(1).tolist())
    for xp in 2.025 + pk * 0.05:
        b = sm & (np.abs(X - xp) < 0.27)
        zo = pct(Z[b], 2) if sgn < 0 else pct(Z[b], 98)
        wdt = float(np.clip(pct(X[b], 95) - pct(X[b], 5), 0.45, 0.6)); xm = float(np.median(X[b]))
        ztop = pct(H[b], 98)
        k += 1
        zi = zo - sgn * D                                   # inner (front) edge towards the table
        zlo, zhi = min(zo, zi), max(zo, zi)
        o = Obj(f'chair-{k:02d}', '会议椅', 'meeting chair', f'chair-{k:02d}', 'chair', xm, (zlo + zhi) / 2,
                yaw=180.0 if sgn < 0 else 0.0, group='table-01')
        back = b & (H > SEAT_H + 0.05)
        bz = (zo, zo - sgn * 0.1)
        o.box('back', (xm - wdt / 2, xm + wdt / 2), (SEAT_H, ztop), (min(bz), max(bz)), back)
        o.box('seat', (xm - wdt / 2, xm + wdt / 2), (SEAT_H - 0.08, SEAT_H), (zlo, zhi), b & (H < SEAT_H + 0.05) & (H > SEAT_H - 0.12), default=tuple(o.parts[0]['color_rgb']))
        az_ = (zo, zo - sgn * 0.42)                         # tub-chair side shells (arms) running forward from the back
        for nm, xs_ in [('arm_left', (xm - wdt / 2, xm - wdt / 2 + 0.06)), ('arm_right', (xm + wdt / 2 - 0.06, xm + wdt / 2))]:
            am_ = b & (X > xs_[0] - 0.04) & (X < xs_[1] + 0.04) & (H > SEAT_H) & (H < SEAT_H + 0.25)
            o.box(nm, xs_, (SEAT_H, SEAT_H + 0.2), (min(az_), max(az_)), am_, default=tuple(o.parts[0]['color_rgb']))
        cx_, cz_ = xm, (zlo + zhi) / 2
        leg = box(cx_ - 0.3, cx_ + 0.3, cz_ - 0.3, cz_ + 0.3, 0.05, 0.3) & (SD > 0.0) & (BRIGHT < 90)
        o.cyl('column', cx_, cz_, 0.03, (0.05, SEAT_H - 0.08), leg, default=(60, 60, 62), seg=12)
        o.cyl('base', cx_, cz_, 0.26, (0.0, 0.05), leg, default=(60, 60, 62), seg=20)
        o.finish(points=int(b.sum()), source=f'cluster 2, {side} side, back-profile peak x={xp:.2f}',
                 method='x-histogram peaks of back samples outside the table outline; outer back edge = 2/98 percentile; standard depth 0.55 m',
                 tucked=bool(abs(zo - (TZ0 if sgn < 0 else TZ1)) < 0.4))
# lounge chair at the +x end of the table (faces -x towards the table)
lc = box(xb_ + tr + 0.02, 7.15, TZ0, TZ1 + 0.05, 0.05, 1.2)
lx0, lx1, lz0, lz1 = pct(X[lc], 2), pct(X[lc], 98), pct(Z[lc], 3), pct(Z[lc], 97)
lseat = lc & UP & (H > 0.3) & (H < 0.6); lsh = float(np.median(H[lseat])) if lseat.sum() > 20 else 0.43
ltop = pct(H[lc], 98)
k += 1
o = Obj(f'chair-{k:02d}', '桌端休闲椅', 'lounge chair (table end)', f'chair-{k:02d}', 'chair', (lx0 + lx1) / 2, (lz0 + lz1) / 2, yaw=90.0, group='table-01')
o.box('back', (lx1 - 0.14, lx1), (0.3, ltop), (lz0, lz1), lc & (X > lx1 - 0.16) & (H > 0.75))
o.box('seat', (lx0, lx1 - 0.1), (lsh - 0.13, lsh), (lz0, lz1), lseat)
o.box('shell_under', (lx0 + 0.05, lx1), (0.28, lsh - 0.13), (lz0 + 0.03, lz1 - 0.03), lc & (H > 0.28) & (H < 0.38), default=(110, 90, 70))
o.cyl('column', (lx0 + lx1) / 2, (lz0 + lz1) / 2, 0.03, (0.04, 0.28), None, default=(60, 60, 62), seg=12)
o.cyl('base', (lx0 + lx1) / 2, (lz0 + lz1) / 2, 0.3, (0.0, 0.04), None, default=(60, 60, 62), seg=20)
o.finish(points=int(lc.sum()), source='cluster 2, +x end', method='bbox + height bands (seat up-facing median, back = top 2%)')

# =====================================================================================
# 5. Sofas (backs against the window side, facing -z)
# =====================================================================================
win_blue = (cc[:, 2] > cc[:, 0] + 10)
for oid, label, label_en, (sx_a, sx_b) in [('sofa-01', '灰色布艺沙发', 'grey fabric sofa', (3.95, 6.08)), ('sofa-02', '米色皮沙发', 'beige leather sofa', (1.43, 3.42))]:
    sm = box(sx_a, sx_b, 13.9, 15.2, 0.05, 1.0) & ~win_blue
    x0, x1 = pct(X[sm & (H > 0.3)], 1), pct(X[sm & (H > 0.3)], 99)
    if oid == 'sofa-01': x1 = min(x1, 6.1)
    zf = pct(Z[sm & (H > 0.2) & (H < 0.5)], 2)
    bt = sm & UP & (H > 0.7) & (H < 0.95)
    zb = min(pct(Z[bt], 95), 15.15); bthk = max(0.18, zb - pct(Z[bt], 5) + 0.05); hb = float(np.median(H[bt]))
    arms = sm & UP & (H > 0.5) & (H < 0.72) & (Z < zb - bthk)
    al = arms & (X < x0 + 0.45); ar = arms & (X > x1 - 0.45)
    xl = pct(X[al], 95) if al.sum() > 10 else x0 + 0.2; xr = pct(X[ar], 5) if ar.sum() > 10 else x1 - 0.2
    xl, xr = max(xl, x0 + 0.15), min(xr, x1 - 0.15)            # arms are at least 15 cm wide
    ha = float(np.median(H[al | ar])) if (al | ar).sum() > 10 else 0.6
    st = sm & UP & (H > 0.3) & (H < 0.5) & (X > xl) & (X < xr); hs_ = float(np.median(H[st]))
    say(f'{oid}: x[{x0:.2f},{x1:.2f}] z[{zf:.2f},{zb:.2f}] back thk {bthk:.2f} h {hb:.2f}; arms {xl-x0:.2f}/{x1-xr:.2f} h {ha:.2f}; seat h {hs_:.2f}')
    o = Obj(oid, label, label_en, oid, 'sofa', (x0 + x1) / 2, (zf + zb) / 2, yaw=0.0)
    o.box('seat_base', (xl, xr), (0, hs_), (zf, zb - bthk), sm & (Z < zb - bthk) & (X > xl) & (X < xr) & (H > 0.1) & (H < hs_ + 0.05))
    o.box('back', (x0, x1), (0, hb), (zb - bthk, zb), sm & (Z > zb - bthk) & (H > hs_))
    o.box('arm_left', (x0, xl), (0, ha), (zf, zb - bthk), sm & (X < xl) & (X > x0 + 0.03) & (Z < zb - bthk) & (H > 0.15) & (BRIGHT > 60))
    o.box('arm_right', (xr, x1), (0, ha), (zf, zb - bthk), sm & (X > xr) & (X < x1 - 0.03) & (Z < zb - bthk) & (H > 0.15) & (BRIGHT > 60))
    o.finish(points=int(sm.sum()), source='cluster 0 (split by x-occupancy gap)',
             method='front = 2% z of low samples, back top band = up-facing samples 0.7-0.95 m, arms = up-facing 0.5-0.72 m near ends',
             heights={'seat': round(hs_, 3), 'arm': round(ha, 3), 'back': round(hb, 3)})

# =====================================================================================
# 6. Round side table between the sofas
# =====================================================================================
st = box(3.3, 3.95, 14.2, 15.0, 0.25, 0.6) & UP
ht = float(np.median(H[st & (H < 0.45)])); stt = st & (np.abs(H - ht) < 0.03)
cx, cz = float(np.median(X[stt])), float(np.median(Z[stt]))
DR = np.hypot(X - cx, Z - cz)
rt = pct(DR[stt], 92)
bs = box(cx - 0.45, cx + 0.45, cz - 0.45, cz + 0.45, 0.05, ht - 0.06) & (DR < rt)
rb = float(np.clip(pct(DR[bs], 50), 0.12, rt * 0.8))
o = Obj('side-table-01', '圆形边几', 'round side table', 'side-table-01', 'side_table', cx, cz)
o.cyl('top', cx, cz, rt, (ht - 0.04, ht), stt)
o.cyl('drum_base', cx, cz, rb, (0, ht - 0.04), bs & (DR < rb + 0.05))
o.finish(points=int(stt.sum() + bs.sum()), source='cluster 0 (between sofas)', method='up-facing samples at the top height -> centre/radius; base radius = median radial distance below')

# =====================================================================================
# 7. White wing-back armchair against the west wall (faces +x)
# =====================================================================================
am = box(WALLS['x'][0] + 0.03, 2.3, 12.3, 13.25, 0.05, 1.25)
ax0, ax1, az0, az1 = pct(X[am], 1), pct(X[am & (H > 0.3) & (H < 0.55)], 98), pct(Z[am], 2), pct(Z[am], 98)
asu = am & UP & (H > 0.3) & (H < 0.5); ash = float(np.median(H[asu]))
atop = pct(H[am], 98)
o = Obj('armchair-01', '白色单人休闲椅', 'white wing-back lounge chair', 'armchair-01', 'armchair', (ax0 + ax1) / 2, (az0 + az1) / 2, yaw=-90.0)
o.box('seat', (ax0 + 0.08, ax1), (ash - 0.12, ash), (az0 + 0.06, az1 - 0.06), asu)
o.box('back', (ax0, ax0 + 0.12), (ash - 0.12, atop), (az0, az1), am & (X < ax0 + 0.14) & (H > 0.6))
for nm, (za, zb) in [('arm_left', (az0, az0 + 0.07)), ('arm_right', (az1 - 0.07, az1))]:
    o.box(nm, (ax0 + 0.1, ax1 - 0.12), (ash - 0.12, ash + 0.2), (za, zb), am & (Z > za - 0.03) & (Z < zb + 0.03) & (H > ash) & (H < ash + 0.25))
for i, (lxp, lzp) in enumerate([(ax0 + 0.12, az0 + 0.1), (ax0 + 0.12, az1 - 0.1), (ax1 - 0.08, az0 + 0.1), (ax1 - 0.08, az1 - 0.1)]):
    o.cyl(f'leg_{i+1}', lxp, lzp, 0.012, (0, ash - 0.12), None, default=(150, 150, 150), seg=8)
o.finish(points=int(am.sum()), source='cluster 9 (+ samples inside the wall tolerance band)', method='bbox + height bands; back = samples within 0.14 m of the wall side')

# =====================================================================================
# 8. Black mirror display unit next to the grey sofa
# =====================================================================================
pan = box(5.95, 7.75, 13.65, 13.85, 0.03, 2.9) & (np.abs(N[:, 2]) > 0.7)
pz = float(np.median(Z[pan])); px0, px1 = pct(X[pan], 1), pct(X[pan], 99); ph = pct(H[pan], 99)
gc = box(px0, px1, 13.25, pz - 0.03, 0.03, 0.75); gtop = gc & UP & (H > 0.45)
gh = float(np.median(H[gtop])) if gtop.sum() > 20 else pct(H[gc], 95); gz0 = pct(Z[gc], 2)
sh = box(6.05, 6.7, pz + 0.03, 15.15, 0.03, 2.6); shx0, shx1, shz1 = pct(X[sh], 2), pct(X[sh], 98), pct(Z[sh], 98); shh = pct(H[sh], 98)
o = Obj('display-01', '黑色镜面展示柜', 'black mirror display unit', 'display-01', 'cabinet', (px0 + px1) / 2, (gz0 + shz1) / 2)
o.box('mirror_panel', (px0, px1), (0, ph), (pz - 0.04, pz + 0.04), box(px0, px1, pz - 0.06, pz + 0.06, 0.03, 2.9))
o.box('glass_cabinet', (px0 + 0.02, px1 - 0.02), (0, gh), (gz0, pz - 0.04), gc)
o.box('shelf_unit', (shx0, shx1), (0, shh), (pz + 0.04, shz1), sh)
say(f'display: panel x[{px0:.2f},{px1:.2f}] z={pz:.2f} h={ph:.2f}; cabinet h={gh:.2f} z0={gz0:.2f}; shelf x[{shx0:.2f},{shx1:.2f}] z..{shz1:.2f} h={shh:.2f}')
o.finish(points=int(pan.sum() + gc.sum() + sh.sum()), source='cluster 0 (x 6.0-7.7)', method='face-normal histograms for the glossy panel plane, bbox for the cabinet/shelf',
         notes='glossy/mirror surface: the scan baked reflections into it, geometry is noisy behind it')

# =====================================================================================
# 9. Suitcase (transient) and white column
# =====================================================================================
sc = box(WALLS['x'][0] + 0.02, 1.85, 13.35, 14.05, 0.03, 1.0)
o = Obj('suitcase-01', '行李箱', 'suitcase', 'suitcase-01', 'prop', float(np.median(X[sc])), float(np.median(Z[sc])))
o.box('body', (pct(X[sc], 2), pct(X[sc], 98)), (0.03, pct(H[sc], 98)), (pct(Z[sc], 2), pct(Z[sc], 98)), sc)
o.finish(points=int(sc.sum()), source='cluster 10', method='bbox', notes='transient object')

pl = box(9.4, WALLS['x'][1], 11.0, 11.75, 0.5, 2.6) & (np.abs(N[:, 1]) < 0.3)
A_ = np.c_[2 * X[pl], 2 * Z[pl], np.ones(pl.sum())]; sol = np.linalg.lstsq(A_, X[pl] ** 2 + Z[pl] ** 2, rcond=None)[0]
pcx, pcz = sol[0], sol[1]; prr = float(np.sqrt(sol[2] + pcx ** 2 + pcz ** 2))
phh = pct(H[box(9.4, WALLS['x'][1], 11.0, 11.75, 0.03, 3.0)], 99)
o = Obj('pillar-01', '白色立柱', 'white column', 'pillar-01', 'architecture', pcx, pcz)
o.cyl('column', pcx, pcz, prr, (0, phh), pl, seg=32)
say(f'pillar circle centre ({pcx:.2f},{pcz:.2f}) r={prr:.2f} h={phh:.2f}')
o.finish(points=int(pl.sum()), source='cluster 6', method='algebraic circle fit of vertical-normal samples', notes='half embedded in the east wall; only the visible half was scanned')

json.dump(OBJS, open(SP + '/out/objects.json', 'w'), ensure_ascii=False, indent=1)
_, _, _, _, rot = load_aligned()
meta = {'frame': 'aligned scan frame of parametric/common.py load_aligned(): metres, +Y up, walls axis-aligned; floor y ~ 0.03-0.10 (per-object floor_y in transform.position[1])',
        'scan_rotation_deg_about_y': rot,
        'room_planes': {'x': WALLS['x'], 'z': WALLS['z'], 'note': 'south side (z ~ 15.1) is a glass curtain wall without a clean plane'},
        'yaw_convention': 'right-handed about +Y (three.js rotation.y); world = R(yaw)*local + position; furniture fronts face local -Z',
        'primitive_types': {'box': 'size [sx,sy,sz], position = centre', 'cylinder': 'radius, height, position = centre, segments',
                            'extrude': 'polygon [[x,z]...] local, CCW from +Y, extruded by height from position[1]'},
        'colour': 'sRGB 0-255 median of the part samples (baked scan lighting); color_n = number of samples, 0 = default colour',
        'n_objects': len(OBJS), 'n_parts': sum(len(o['parts']) for o in OBJS), 'log': log}
json.dump(meta, open(SP + '/out/objects_meta.json', 'w'), ensure_ascii=False, indent=1)
print('objects', len(OBJS), 'parts', meta['n_parts'])
