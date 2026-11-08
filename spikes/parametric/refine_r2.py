"""Round-2 refinement of the parametric lobby model (critic fixes 1-5).

Reads the round-1 results from out/r1_backup/{objects,structure}.json (never modified) and writes
out/objects.json, out/structure.json, out/structure_points.npy and new textures under out/tex/
(obj_*.png, glazing_east_*.png, glazing_z15.64_1_r2.png).  Re-runnable; ~1 min.

 1 counter-01   folded white shell: 3 'profile_extrude' parts (front / end return / wing) sharing one
                measured inset profile (dark recessed plinth, bulge at ~0.6 m, lean-back above), mitred joint
                between front and wing; work surface inset 0.15 m; monitors / dark items / blue box from
                clusters of dark / blue samples above the desk.
 2 window       window-frame-01: mullions (white vertical sample peaks + 1.47 m pitch for the hidden one),
                sill (up-facing peak), head beam; glazing_z15.64_1 re-baked without white (frame) samples,
                holes filled per pane with the row median of the observed glass texels.
 3 display-01   mirror panel gets a baked front texture; shelf = open shelf (2 ends, top, 5 boards, books);
                glass cabinet lowered to 0.45 m, dark glass colour.
 4 east side    glazing_east_1 (diagonal glass partition) and glazing_east_2 (glass door) fitted by PCA on
                vertical samples and baked; pillar-01 -> white wall pier box fitted on white samples;
                plant-01 (pot + 3 bicone foliage masses) from green samples.
 5 colours      every measured part re-coloured from samples within 5 cm of its surface whose normal agrees
                with the surface normal (outward), median colour of the p80-p86 luminance band.
                table-01 top, sofa tops/fronts get orthographic visible-surface textures; conference chairs
                get arc-shell backs and 4 thin legs instead of the unsupported r=0.26 disc bases.
"""
import os, sys, json, copy, time
import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from prims import object_part_meshes, clip_convex, Ry
import bake_util as BU

t0 = time.time()
OUT = os.path.join(HERE, 'out'); TEXD = os.path.join(OUT, 'tex'); BK = os.path.join(OUT, 'r1_backup')
S = json.load(open(os.path.join(BK, 'structure.json')))
O = json.load(open(os.path.join(BK, 'objects.json')))
PLANES = np.load(os.path.join(BK, 'structure_points.npy')) if os.path.exists(os.path.join(BK, 'structure_points.npy')) \
    else np.load(os.path.join(OUT, 'structure_points.npy'))
FLOOR_Y = float(next(e for e in S['elements'] if e['kind'] == 'floor')['plane']['offset'])
OB = {o['id']: o for o in O}
d = np.load(os.path.join(HERE, 'samples.npz'))
P, C, N = d['P'].astype(float), d['C'].astype(float), d['N'].astype(float)
X, Y, Z = P.T
LUM = C.mean(1); SAT = C.max(1) - C.min(1)
WHITE = (LUM > 165) & (SAT < 45)
log = []


def say(*a):
    s = ' '.join(str(v) for v in a); print(s); log.append(s)


def r3(v):
    return [round(float(x), 3) for x in v]


def band_colour(mask, lo=80, hi=86, min_n=12):
    """Median colour of the samples in the [lo, hi] luminance-percentile band (None if too few)."""
    n = int(mask.sum())
    if n < min_n:
        return None, n
    l = LUM[mask]; c = C[mask]
    a, b = np.percentile(l, [lo, hi])
    s = (l >= a) & (l <= b)
    if s.sum() < 5:
        a, b = np.percentile(l, [72, 92]); s = (l >= a) & (l <= b)
    return [int(round(v)) for v in np.median(c[s], 0)], n


def floor_at(x, z, r=0.6):
    m = (np.abs(X - x) < r) & (np.abs(Z - z) < r) & (N[:, 1] > 0.9) & (Y < 0.25)
    return float(np.median(Y[m])) if m.sum() > 20 else FLOOR_Y


def save_tex(name, rgb, obs=None):
    Image.fromarray(rgb).save(os.path.join(TEXD, name + '.png'))
    if obs is not None:
        Image.fromarray((obs * 255).astype(np.uint8)).save(os.path.join(TEXD, name + '_mask.png'))
    return f'tex/{name}.png'


def pca_line(mask):
    A = np.c_[X[mask], Z[mask]]; c = np.median(A, 0)
    w, v = np.linalg.eigh(np.cov((A - c).T)); t = v[:, -1]
    if t[1] < 0: t = -t                                  # +z-ish direction
    return c, t, A


FIXED = 'fixed'   # colour_source tag for parts whose colour is set explicitly (not re-measured)

# =========================================================================== 1. reception desk
o = OB['counter-01']; ox, oy, oz = o['transform']['position']
parts = {p['name']: p for p in o['parts']}
front, wing, ws = parts['front_block'], parts['wing'], parts['work_surface']
WHITE_SHELL = [228, 229, 226]; PLINTH = [50, 50, 52]
# measured profile (inset from the outline vs height above the desk floor; probe of the outermost x per 10 cm
# band on the front face: recessed dark plinth to ~0.2 m, soffit, bulge at ~0.58 m, lean-back to the top)
PROFILE = [[0.0, 0.32], [0.20, 0.31], [0.24, 0.22], [0.34, 0.06], [0.58, 0.0]]
H_FRONT = round(max(front['height'], parts['end_return']['height']), 3); H_WING = wing['height']


def prof_to(h_top, lean_top=0.17, h_ref=1.12):
    pr = [q[:] for q in PROFILE]
    pr.append([round(h_top, 3), round(lean_top * (h_top - 0.58) / (h_ref - 0.58), 3)])
    return pr


fp = np.array(front['polygon'], float)   # [(-0.86,0.04),(-0.86,1.871),(-0.2,1.871),(-0.2,0.14)]
wp = np.array(wing['polygon'], float)    # [inner joint, inner tip, outer tip, corner]
corner = wp[3]; otip, itip = wp[2], wp[1]
# mitre line at the corner between the front face (x = const) and the wing's outer edge
e_out = (corner - otip) / np.linalg.norm(corner - otip)
n_front = np.array([1.0, 0.0])
n_wing = np.array([e_out[1], -e_out[0]])
if n_wing @ (itip - otip) < 0: n_wing = -n_wing       # inward = towards the inner edge
md = np.linalg.solve(np.array([n_front, n_wing]), [1.0, 1.0])
xb = fp[2, 0]                                          # back x of the front block
j_front = corner + md * (xb - corner[0]) / md[0]
# inner wing corner: intersection of the inner edge line (through itip, parallel to the outer edge) with the mitre
A_ = np.array([e_out, -md]).T; s_ = np.linalg.solve(A_, corner - itip)
j_wing = itip + e_out * s_[0]
new_front = [corner.tolist(), fp[1].tolist(), fp[2].tolist(), j_front.tolist()]
new_wing = [j_wing.tolist(), itip.tolist(), otip.tolist(), corner.tolist()]
ret = parts['end_return']
o['parts'] = [
    dict(type='profile_extrude', name='front_block', polygon=[r3(v) for v in new_front], edge_inset=[1, 1, 0, 0],
         inset_profile=prof_to(H_FRONT), position=[0.0, 0, 0.0], yaw_deg=0.0, color_rgb=WHITE_SHELL,
         low_color_rgb=PLINTH, low_until=0.24, color_source=FIXED),
    dict(type='profile_extrude', name='end_return', polygon=ret['polygon'], edge_inset=[0, 1, 0, 0],
         inset_profile=prof_to(H_FRONT), position=[0.0, 0, 0.0], yaw_deg=0.0, color_rgb=WHITE_SHELL,
         low_color_rgb=PLINTH, low_until=0.24, color_source=FIXED),
    dict(type='profile_extrude', name='wing', polygon=[r3(v) for v in new_wing], edge_inset=[0, 1, 1, 0],
         inset_profile=prof_to(H_WING), position=[0.0, 0, 0.0], yaw_deg=0.0, color_rgb=WHITE_SHELL,
         low_color_rgb=PLINTH, low_until=0.24, color_source=FIXED),
]
hull = clip_convex(ws['polygon'], 0.15)
ws2 = dict(ws); ws2.update(polygon=[r3(v) for v in hull], color_rgb=[95, 88, 85], color_source=FIXED)
o['parts'].append(ws2)
ws_top = ws['position'][1] + ws['height']             # local height of the work surface top
say(f'counter: mitre dir {md.round(3)} front joint {j_front.round(3)} wing joint {j_wing.round(3)}; '
    f'work surface inset 0.15 m -> {len(hull)} vertices, top {ws_top + oy:.3f}')

# dark items above the desk -> monitors / dark boxes; blue items -> storage boxes.
# Only samples >= 12 cm in front of the logo wall (its dark wood cladding is not desk clutter), y < 1.35.
logo = next(e for e in S['elements'] if e['id'] == 'wall_a210_1')
WALL_D = X * logo['plane']['normal'][0] + Z * logo['plane']['normal'][2] - logo['plane']['offset']
desk_reg = (X > 6.3) & (X < 7.95) & (Z > 4.2) & (Z < 7.7) & (Y > ws_top + oy + 0.03) & (Y < 1.35) & (WALL_D > 0.12)


def clusters(mask, cell=0.05, min_n=40):
    ix = ((X[mask] - 6.3) / cell).astype(int); iz = ((Z[mask] - 4.2) / cell).astype(int)
    occ = np.zeros((ix.max() + 2, iz.max() + 2), int); np.add.at(occ, (ix, iz), 1)
    lab, n = ndimage.label(ndimage.binary_closing(occ >= 2, iterations=1), structure=np.ones((3, 3)))
    L = lab[ix, iz]; idx = np.nonzero(mask)[0]; out = []
    for k in range(1, n + 1):
        sel = idx[L == k]
        if len(sel) >= min_n:
            out.append(sel)
    return sorted(out, key=len, reverse=True)


def item_box(sel, name, colour, src, min_xy=0.12, max_xy=0.6):
    x0, x1 = np.percentile(X[sel], [4, 96]); z0, z1 = np.percentile(Z[sel], [4, 96]); ytop = np.percentile(Y[sel], 97)
    lx, lz = float(np.clip(x1 - x0, min_xy, max_xy)), float(np.clip(z1 - z0, min_xy, max_xy))
    hh = ytop - oy - ws_top
    o['parts'].append(dict(type='box', name=name, size=r3([lx, hh, lz]),
                           position=r3([(x0 + x1) / 2 - ox, ws_top + hh / 2, (z0 + z1) / 2 - oz]), yaw_deg=0.0,
                           color_rgb=colour, color_source=src, color_n=int(len(sel))))
    return x0, x1, z0, z1, ytop


dark = desk_reg & (LUM < 70) & (Y > 0.93)
nm_i = 0
for sel in clusters(dark, min_n=30)[:4]:
    x0, x1 = np.percentile(X[sel], [4, 96]); z0, z1 = np.percentile(Z[sel], [4, 96]); ytop = np.percentile(Y[sel], 97)
    lx, lz = x1 - x0, z1 - z0
    nm_i += 1
    if lx < 0.3 and lz >= 0.3:       # thin in x, long in z: a monitor facing +-x (the receptionist sits at +x)
        xc, zc = float(np.median(X[sel])), 0.5 * (z0 + z1)
        ytop = max(ytop, 1.25)
        o['parts'].append(dict(type='box', name=f'monitor_{nm_i}', size=[0.04, 0.35, 0.55],
                               position=r3([xc - ox, ytop - oy - 0.175, zc - oz]), yaw_deg=0.0,
                               color_rgb=[25, 25, 28], color_source=FIXED, color_n=int(len(sel))))
        o['parts'].append(dict(type='box', name=f'monitor_{nm_i}_stand', size=r3([0.12, ytop - 0.35 - ws_top - oy, 0.10]),
                               position=r3([xc - ox + 0.04, (ws_top + ytop - oy - 0.35) / 2, zc - oz]), yaw_deg=0.0,
                               color_rgb=[40, 40, 44], color_source=FIXED, color_n=0))
        say(f'  dark cluster n={len(sel)} x {x0:.2f}-{x1:.2f} z {z0:.2f}-{z1:.2f} top {ytop:.2f} -> monitor')
    else:
        item_box(sel, f'dark_item_{nm_i}', [38, 38, 42], FIXED)
        say(f'  dark cluster n={len(sel)} x {x0:.2f}-{x1:.2f} z {z0:.2f}-{z1:.2f} top {ytop:.2f} -> dark box')
blue = desk_reg & (C[:, 2] > C[:, 0] + 35) & (C[:, 2] > C[:, 1] + 12) & (Y > 0.93)
bls = clusters(blue, min_n=40)
if bls:   # largest blue cluster = the observed face of a storage box; the box body lies on the viewer side of it
    sel = bls[0]
    nh = N[sel][:, [0, 2]].mean(0); nh /= np.linalg.norm(nh)
    bc, bn = band_colour(np.isin(np.arange(len(P)), sel), 60, 80)
    if abs(nh[1]) >= abs(nh[0]):     # face looks along +-z
        zf = float(np.median(Z[sel])); z0, z1 = sorted([zf, zf + 0.22 * np.sign(nh[1])])
        x0, x1 = np.percentile(X[sel], [4, 96])
    else:
        xf = float(np.median(X[sel])); x0, x1 = sorted([xf, xf + 0.22 * np.sign(nh[0])])
        z0, z1 = np.percentile(Z[sel], [4, 96])
    ytop = float(np.percentile(Y[sel], 97)); hh = ytop - oy - ws_top
    o['parts'].append(dict(type='box', name='blue_box', size=r3([x1 - x0, hh, z1 - z0]),
                           position=r3([(x0 + x1) / 2 - ox, ws_top + hh / 2, (z0 + z1) / 2 - oz]), yaw_deg=0.0,
                           color_rgb=bc, color_source=FIXED, color_n=bn))
    say(f'  blue cluster n={len(sel)} face normal {nh.round(2)} -> box x {x0:.2f}-{x1:.2f} z {z0:.2f}-{z1:.2f} top {ytop:.2f} colour {bc}'
        f' ({len(bls) - 1} smaller blue clusters ignored)')
o['fit']['method'] = ('folded white shell: 3 profile extrusions (front block, end return, wing) sharing one measured inset '
                      'profile with a dark recessed plinth, mitred front/wing joint; work surface = convex hull inset 0.15 m; '
                      'monitors / dark items / blue box from clusters of dark / blue samples above the desk')
o['fit']['inset_profile_source'] = 'outermost x (p2) per 10 cm height band of the front face samples, z 6.3-7.4'

# =========================================================================== 2. window frame + glazing re-bake
gl = next(e for e in S['elements'] if e['id'] == 'glazing_z15.64_1')
GZ = gl['plane']['offset']; gx0, gx1 = gl['rect']['x']; gy0, gy1 = gl['rect']['y']
MUL_GUESS = [2.50, 3.97, 5.48, 6.95, 8.45, 9.90]
mul = []
vert = np.abs(N[:, 1]) < 0.3
for xm in MUL_GUESS:
    m = (np.abs(X - xm) < 0.15) & (Z > 15.0) & (Z < 15.7) & (Y > 0.6) & (Y < 2.6) & WHITE & vert
    if m.sum() >= 20:
        mul.append((float(np.mean(np.percentile(X[m], [5, 95]))), float(np.percentile(Z[m], 10)), int(m.sum())))
    else:
        mul.append((None, None, int(m.sum())))
seen = [i for i, (x_, _, _) in enumerate(mul) if x_ is not None]
pitch = np.polyfit(seen, [mul[i][0] for i in seen], 1)        # regular pitch (~1.47 m) through the seen ones
zf_med = float(np.median([mul[i][1] for i in seen]))
for i, (x_, z_, n_) in enumerate(mul):
    if x_ is None:   # hidden mullion (behind the display): on the fitted pitch
        mul[i] = (float(np.polyval(pitch, i)), zf_med, 0)
say(f'mullion pitch {pitch[0]:.3f} m;', 'mullions (x, front z, n):', [(round(a, 2), round(b, 2), c) for a, b, c in mul])
sill_up = (X > 1.5) & (X < 10) & (Z > 15.0) & (Z < 15.8) & (N[:, 1] > 0.8) & (Y > 0.35) & (Y < 0.55)
sill_top = float(np.percentile(Y[sill_up], 75))
sill_fr = (X > 1.5) & (X < 10) & (Z > 15.1) & (Z < 15.6) & (N[:, 2] < -0.7) & (Y > 0.12) & (Y < sill_top - 0.03)
sill_front = float(np.median(Z[sill_fr]))
say(f'sill top {sill_top:.3f} front z {sill_front:.3f} (n {int(sill_fr.sum())})')
WF_Y = FLOOR_Y; wcx = 0.5 * (gx0 + gx1); wcz = GZ
wf = dict(id='window-frame-01', label='窗框（竖梃+窗台+顶梁）', label_en='window frame (mullions, sill, head)',
          anchor_suggestion='window-frame-01', category='structure',
          transform=dict(position=r3([wcx, WF_Y, wcz]), yaw_deg=0.0), parts=[],
          fit=dict(source='white vertical samples z 15.0-15.7 (mullions), up-facing / -z-facing samples y<0.55 (sill)',
                   method='mullion x = median of white samples near the 1.47 m pitch positions (the one hidden by the '
                          'display is interpolated), depth from the front-face p10 to the glazing plane; sill top = '
                          'p75 of up-facing samples; head beam at the glazing top', unsupported_parts=['mullion_4', 'head']))
H_FR = gy1 - WF_Y
for i, (x_, zf, n_) in enumerate(mul):
    dz = GZ - zf
    wf['parts'].append(dict(type='box', name=f'mullion_{i + 1}', size=r3([0.15, H_FR, dz]),
                            position=r3([x_ - wcx, H_FR / 2, zf + dz / 2 - wcz]), yaw_deg=0.0,
                            color_rgb=[225, 225, 222], color_n=n_, color_source=FIXED))
sd = GZ - sill_front
wf['parts'].append(dict(type='box', name='sill', size=r3([gx1 - gx0, sill_top - WF_Y, sd]),
                        position=r3([0.0, (sill_top - WF_Y) / 2, sill_front + sd / 2 - wcz]), yaw_deg=0.0,
                        color_rgb=[225, 225, 222], color_n=int(sill_fr.sum()), color_source=FIXED))
wf['parts'].append(dict(type='box', name='head', size=r3([gx1 - gx0, 0.12, 0.34]),
                        position=r3([0.0, H_FR - 0.06, -0.17]), yaw_deg=0.0, color_rgb=[215, 215, 212], color_n=0,
                        color_source=FIXED))
wf['bbox'] = dict(min=r3([gx0, WF_Y, min(z for _, z, _ in mul)]), max=r3([gx1, gy1, GZ]))
O.append(wf)

# glazing re-bake: room-facing glass faces, no white frame samples, no mullion strips; per-pane row-median fill
fids = BU.faces_in_box([gx0, gy0, GZ - 0.144], [gx1, gy1, GZ + 0.507], normal=[0, 0, -1], cos_min=np.cos(np.radians(35)))
mx = np.array([m[0] for m in mul])


def keep_glass(p, col, n):
    c = col.astype(float); l = c.mean(1); s = c.max(1) - c.min(1)
    return ~((l > 165) & (s < 45)) & (np.min(np.abs(p[:, 0:1] - mx[None]), 1) > 0.09) & (p[:, 2] > GZ - 0.144)


Wg, Hg = gl['texture_size']
rgb, obs = BU.ortho_bake(fids, [gx1, gy1, GZ], [-1, 0, 0], [0, -1, 0], (Wg, Hg), keep=keep_glass, fill=False)
img = rgb.astype(float)
colx = gx1 - (np.arange(Wg) + 0.5) * 0.01
edges = np.r_[gx0, mx, gx1]
filled = img.copy()
for a, b in zip(edges[:-1], edges[1:]):
    cols = np.nonzero((colx > a + 0.08) & (colx < b - 0.08))[0]
    if len(cols) == 0:
        continue
    sub, so = img[:, cols], obs[:, cols]
    rowmed = np.full((Hg, 3), np.nan)
    for r in range(Hg):
        if so[r].sum() >= 3:
            rowmed[r] = np.median(sub[r][so[r]], 0)
    ok = ~np.isnan(rowmed[:, 0])
    if ok.sum() < 2:
        continue
    for c in range(3):
        rowmed[:, c] = np.interp(np.arange(Hg), np.nonzero(ok)[0], rowmed[ok, c])
    rowmed = ndimage.gaussian_filter1d(rowmed, 4, axis=0)
    fill = np.repeat(rowmed[:, None], len(cols), 1)
    filled[:, cols] = np.where(so[..., None], sub, fill)
# mullion strips / pane edges (hidden behind the mullion boxes) and anything still unset: smooth fill
setmask = np.zeros((Hg, Wg), bool)
for a, b in zip(edges[:-1], edges[1:]):
    setmask[:, (colx > a + 0.08) & (colx < b - 0.08)] = True
filled = BU.push_pull(filled, setmask.astype(float))
gl['texture'] = save_tex('glazing_z15.64_1_r2', np.clip(np.round(filled), 0, 255).astype(np.uint8), obs)
gl['observed_mask'] = 'tex/glazing_z15.64_1_r2_mask.png'
gl['observed_fraction'] = round(float(obs.mean()), 3)
gl['texture_fill'] = ('r2: white frame samples and mullion strips excluded; holes in each pane (between mullions) filled '
                      'with the vertically smoothed per-row median of that pane\'s observed glass texels (sky above, city '
                      'below); the r1 push-pull texture is kept as tex/glazing_z15.64_1.png')
gl['frame_object'] = 'window-frame-01'
say(f'glazing re-bake: faces {len(fids)} observed {obs.mean():.3f}')

# =========================================================================== 3. display
o = OB['display-01']; ox, oy, oz = o['transform']['position']
parts = {p['name']: p for p in o['parts']}
mp_, gc_, sh_ = parts['mirror_panel'], parts['glass_cabinet'], parts['shelf_unit']
mx0, mx1 = ox + mp_['position'][0] - mp_['size'][0] / 2, ox + mp_['position'][0] + mp_['size'][0] / 2
my0, my1 = oy + mp_['position'][1] - mp_['size'][1] / 2, oy + mp_['position'][1] + mp_['size'][1] / 2
mzf = oz + mp_['position'][2] - mp_['size'][2] / 2
fids = BU.faces_in_box([mx0 - 0.02, my0, mzf - 0.2], [mx1 + 0.02, my1 + 0.05, mzf + 0.35], normal=[0, 0, -1], cos_min=0.6)
Wm, Hm = int(round((mx1 - mx0) / 0.01)), int(round((my1 - my0) / 0.01))
rgb, obs = BU.ortho_bake(fids, [mx1, my1, mzf], [-1, 0, 0], [0, -1, 0], (Wm, Hm))
mp_['texture'] = dict(file=save_tex('obj_display-01_mirror', rgb, obs), normal=[0, 0, -1],
                      origin=r3([mx1, my1, mzf]), u_vec=[-1, 0, 0], v_vec=[0, -1, 0], px=0.01, size=[Wm, Hm],
                      observed_fraction=round(float(obs.mean()), 3), faces=int(len(fids)))
say(f'mirror texture {Wm}x{Hm} faces {len(fids)} observed {obs.mean():.2f}')
gc2 = dict(gc_); h_gc = 0.45
gc2.update(size=[gc_['size'][0], h_gc, gc_['size'][2]], position=r3([gc_['position'][0], h_gc / 2, gc_['position'][2]]),
           color_rgb=[70, 78, 84], color_source=FIXED)
sx, sy, sz = sh_['size']; scx, scy, scz = sh_['position']
SHELF_C = [26, 30, 34]
new = [mp_, gc2]
for k, zz in enumerate((scz - sz / 2 + 0.015, scz + sz / 2 - 0.015)):
    new.append(dict(type='box', name=f'shelf_end_{k + 1}', size=r3([sx, sy, 0.03]), position=r3([scx, sy / 2, zz]),
                    yaw_deg=0.0, color_rgb=SHELF_C, color_source=FIXED))
new.append(dict(type='box', name='shelf_top', size=r3([sx, 0.03, sz]), position=r3([scx, sy - 0.015, scz]),
                yaw_deg=0.0, color_rgb=SHELF_C, color_source=FIXED))
rng = np.random.default_rng(5)
BOOKS = [[150, 60, 50], [60, 80, 120], [190, 170, 120], [80, 110, 80], [200, 195, 185], [120, 90, 60], [70, 70, 75]]
boards = [0.10, 0.60, 1.10, 1.60, 2.10]
for k, yb in enumerate(boards):
    new.append(dict(type='box', name=f'shelf_board_{k + 1}', size=r3([sx, 0.03, sz - 0.06]), position=r3([scx, yb, scz]),
                    yaw_deg=0.0, color_rgb=SHELF_C, color_source=FIXED))
    if k == len(boards) - 1:
        continue
    zc = scz - sz / 2 + 0.06 + rng.uniform(0, 0.25)
    while True:      # a few runs of books on every board (decorative, not measured)
        run = rng.integers(3, 7)
        for _ in range(run):
            t = float(rng.uniform(0.03, 0.06)); h = float(rng.uniform(0.20, 0.32))
            if zc + t > scz + sz / 2 - 0.05: break
            new.append(dict(type='box', name=f'book_{k + 1}_{len(new)}', size=r3([sx * 0.7, h, t]),
                            position=r3([scx, yb + 0.015 + h / 2, zc + t / 2]), yaw_deg=0.0,
                            color_rgb=BOOKS[int(rng.integers(len(BOOKS)))], color_source=FIXED, color_n=0, decorative=True))
            zc += t + 0.004
        zc += float(rng.uniform(0.15, 0.4))
        if zc > scz + sz / 2 - 0.12: break
o['parts'] = new
o['fit']['method'] = ('mirror panel with baked front texture (reflections of the room, as in the scan); open shelf '
                      '(2 ends, top, 5 boards, decorative books); low dark-glass cabinet 0.45 m')
o['fit']['unsupported_parts'] = ['books (decorative)', 'shelf boards heights (typical)']

# =========================================================================== 4. east side: glazing, pier, plant
new_struct = []


def plane_element(eid, c, t, mask, y0, y1, band, note, confidence):
    n = np.array([-t[1], t[0]])
    if n[0] > 0: n = -n                                # room side = -x
    right = np.array([n[1], -n[0]])                    # viewer looks along -n: right = (n_z, -n_x)
    u = np.c_[X[mask], Z[mask]] @ right
    u0, u1 = np.percentile(u, [1, 99])
    # plane origin on the fitted line through c
    base = c - right * (c @ right)
    pa, pb = base + right * u0, base + right * u1
    off = float(n @ base)
    L = u1 - u0; Wp, Hp = int(round(L / 0.01)), int(round((y1 - y0) / 0.01))
    lo = np.minimum(pa, pb) - band - 0.05; hi = np.maximum(pa, pb) + band + 0.05
    fids = BU.faces_in_box([lo[0], y0, lo[1]], [hi[0], y1, hi[1]], normal=[n[0], 0, n[1]], cos_min=0.3)

    def keep(p, col, nn):
        s_ = p[:, [0, 2]] @ n - off; uu = p[:, [0, 2]] @ right
        return (np.abs(s_) < band) & (uu > u0 - 0.01) & (uu < u1 + 0.01)
    rgb, obs = BU.ortho_bake(fids, [pa[0], y1, pa[1]], [right[0], 0, right[1]], [0, -1, 0], (Wp, Hp), keep=keep)
    tex = save_tex(eid, rgb, obs)
    el = dict(id=eid, kind='wall', plane=dict(axis='n', offset=round(off, 4), normal=r3([n[0], 0, n[1]]),
                                              note='off-axis plane: normal.x*x + normal.z*z = offset'),
              rect=dict(u=[round(u0, 3), round(u1, 3)], y=[round(y0, 3), round(y1, 3)]), thickness=0.03,
              texture=tex, texture_size=[Wp, Hp], metres_per_px=0.01, u_axis=r3([right[0], 0, right[1]]),
              u_range=[round(u0, 3), round(u1, 3)],
              corners=[r3([pa[0], y0, pa[1]]), r3([pb[0], y0, pb[1]]), r3([pb[0], y1, pb[1]]), r3([pa[0], y1, pa[1]])],
              texture_layout='column 0 = corners[0] end (left as seen from the room), row 0 = top (y max)',
              observed_mask=f'tex/{eid}_mask.png', observed_fraction=round(float(obs.mean()), 3),
              support_pts=int(mask.sum()), length_m=round(L, 3), glazing=True, confidence=confidence, note=note,
              source='refine_r2.py (PCA line fit on vertical samples; added in round 2)')
    say(f'{eid}: {pa.round(2)} -> {pb.round(2)}  L {L:.2f}  n {np.round(n, 3)}  tex {Wp}x{Hp} faces {len(fids)} observed {obs.mean():.2f}')
    return el, n, right, off, u0, u1, band


m1 = vert & (Y > 0.5) & (Y < 2.2) & (X > 9.6) & (X < 10.3) & (Z > 9.7) & (Z < 10.92) & ~WHITE
c1, t1, _ = pca_line(m1)
new_struct.append(plane_element('glazing_east_1', c1, t1, m1, FLOOR_Y, gy1, 0.07,
                                'diagonal glass partition of the east meeting room (the scan shows the room behind it: '
                                'world-map wall and people)', 'medium'))
m2 = vert & (Y > 0.5) & (Y < 2.2) & (X > 9.2) & (X < 9.6) & (Z > 12.1) & (Z < 13.1)
c2, t2, _ = pca_line(m2)
new_struct.append(plane_element('glazing_east_2', c2, t2, m2, FLOOR_Y, gy1, 0.08,
                                'glass door at the south end of the east corridor', 'low'))
el_list = S['elements'] + [e for e, *_ in new_struct]
rows = [list(r) for r in PLANES]
for e, n, right, off, u0, u1, band in new_struct:
    rows.append([n[0], 0, n[1], off, right[0], 0, right[1], u0, u1, e['rect']['y'][0], e['rect']['y'][1], band, band, 1, 1, 0])
S['elements'] = el_list

# white wall pier (replaces the r=0.37 'pillar' cylinder, which was a circle fit to this flat pier + glass)
o = OB['pillar-01']
mp = vert & WHITE & (Y > 0.5) & (Y < 2.3) & (X > 9.45) & (X < 9.85) & (Z > 10.85) & (Z < 11.75)
cp, tp, Ap = pca_line(mp)
npier = np.array([-tp[1], tp[0]]);  npier = -npier if npier[0] > 0 else npier       # room-facing normal
s_face = np.percentile((Ap - cp) @ npier, 80)                                       # room-facing face
uu = (Ap - cp) @ tp; ua, ub = np.percentile(uu, [2, 98])
TH_P = 0.12
ctr = cp + npier * (s_face - TH_P / 2) + tp * (ua + ub) / 2
yaw = float(np.degrees(np.arctan2(tp[0], tp[1])))      # local +z -> (sin yaw, cos yaw) = tp
fy = floor_at(ctr[0], ctr[1])
o.update(label='白色墙垛', label_en='white wall pier', category='structure',
         transform=dict(position=r3([ctr[0], fy, ctr[1]]), yaw_deg=round(yaw, 2)))
o['parts'] = [dict(type='box', name='pier', size=r3([TH_P, gy1 - fy, ub - ua]), position=r3([0, (gy1 - fy) / 2, 0]),
                   yaw_deg=0.0, color_rgb=[225, 222, 215])]
o['fit'] = dict(points=int(mp.sum()), source='white vertical samples x 9.45-9.85, z 10.85-11.75',
                method='PCA line of the white face; box 0.12 m thick behind the room-facing face (p80 offset)',
                note='r1 fitted a circle (r=0.37) to this flat pier plus the glass beside it')
o['bbox'] = dict(min=r3([ctr[0] - 0.1, fy, ctr[1] - (ub - ua) / 2]), max=r3([ctr[0] + 0.1, gy1, ctr[1] + (ub - ua) / 2]))
say(f'pier: centre {ctr.round(3)} yaw {yaw:.1f} length {ub - ua:.2f} n {int(mp.sum())}')

# plant in the corridor: only its room-facing side is scanned (a ~9 cm thick sheet at x~10.77)
green = (C[:, 1] > C[:, 0] + 8) & (C[:, 1] > C[:, 2] + 5) & (Y > 0.3) & (Y < 2.8) & (X > 10.1) & (X < 11.2) & (Z > 7.4) & (Z < 8.9)
gx, gz = float(np.median(X[green])), float(np.median(Z[green]))
gtop = float(np.percentile(Y[green], 97))
gwid = float(np.percentile(Z[green], 95) - np.percentile(Z[green], 5))
R0 = min(0.36, gwid / 2 + 0.03)
pcx = gx + 0.7 * R0                                    # scanned face ~0.7 R in front of the stem
pot = (np.abs(X - gx) < 0.35) & (np.abs(Z - gz) < 0.4) & (Y > 0.08) & (Y < 0.42) & ~green
fy = floor_at(pcx, gz)
gcol, gn = band_colour(green & (C[:, 1] > C[:, 0] + 14), 40, 60)
pcol, pn = band_colour(pot, 60, 85)
crown = [(0.40, gtop - fy, R0 * 0.92, 0.0, 0.0, 0.42),               # main tall mass
         (0.55, 1.75, R0 * 0.75, 0.04, -0.13, 0.5), (1.10, 2.35, R0 * 0.7, -0.03, 0.12, 0.45)]   # side masses
plant = dict(id='plant-01', label='落地绿植', label_en='potted plant', anchor_suggestion='plant-01', category='plant',
             transform=dict(position=r3([pcx, fy, gz]), yaw_deg=0.0),
             parts=[dict(type='cylinder', name='pot', radius=0.22, height=0.40, position=[0.0, 0.2, 0.0], segments=20,
                         color_rgb=pcol or [60, 58, 55], color_n=pn)],
             fit=dict(points=int(green.sum()), source='green samples x 10.1-11.2, z 7.4-8.9',
                      method='pot cylinder + 3 stacked bicone foliage masses; stem placed 0.7 R behind the scanned face'))
for k, (ya, yb, r, dx, dz, wst) in enumerate(crown):
    plant['parts'].append(dict(type='bicone', name=f'foliage_{k + 1}', radius=round(r, 3), height=round(yb - ya, 3),
                               waist=wst, position=r3([dx, (ya + yb) / 2, dz]), segments=10,
                               color_rgb=gcol or [62, 92, 64], color_n=gn, color_source=FIXED))
plant['bbox'] = dict(min=r3([pcx - R0, fy, gz - R0]), max=r3([pcx + R0, gtop, gz + R0]))
O.append(plant)
say(f'plant: face x {gx:.2f} -> stem ({pcx:.2f}, {gz:.2f}) R {R0:.2f} top {gtop:.2f} green {gcol} pot {pcol}')

# =========================================================================== 5a. chairs: arc shell backs, thin legs
R_ARC, T_ARC = 0.35, 0.035
for o in O:
    if not (o['id'].startswith('chair-') and o['id'] != 'chair-10'):
        continue
    parts = {p['name']: p for p in o['parts']}
    b = parts['back']; bx, by, bz = b['position']; bw, bh, bd = b['size']
    zback = bz + bd / 2
    zc = zback - R_ARC; ph0 = np.arcsin(min(0.99, (bw / 2 + 0.025) / R_ARC))
    phs = np.linspace(-ph0, ph0, 11)
    outer = [(R_ARC * np.sin(a), zc + R_ARC * np.cos(a)) for a in phs]
    inner = [((R_ARC - T_ARC) * np.sin(a), zc + (R_ARC - T_ARC) * np.cos(a)) for a in phs[::-1]]
    b2 = dict(type='extrude', name='back', polygon=[r3(v) for v in outer + inner], height=round(bh, 3),
              position=r3([bx, by - bh / 2, 0.0]), yaw_deg=0.0, color_rgb=b['color_rgb'], color_n=b['color_n'])
    newp = []
    for p in o['parts']:
        if p['name'] == 'back':
            newp.append(b2)
        elif p['name'] in ('column', 'base') and p.get('color_n', 0) == 0:
            continue
        else:
            newp.append(p)
    if parts['base'].get('color_n', 0) == 0:
        seat = parts['seat']; sy0 = seat['position'][1] - seat['size'][1] / 2
        for k, (lx, lz) in enumerate([(-1, -1), (1, -1), (1, 1), (-1, 1)]):
            newp.append(dict(type='cylinder', name=f'leg_{k + 1}', radius=0.012, height=round(sy0, 3),
                             position=r3([lx * 0.19, sy0 / 2, lz * 0.19]), segments=8, color_rgb=[150, 150, 150],
                             color_n=0, color_source=FIXED))
        o['fit']['unsupported_parts'] = ['legs (4 thin metal legs, typical shell chair; base not observed)']
    o['parts'] = newp
say('chairs: arc-shell backs (R 0.35 m, 3.5 cm shell); unsupported disc bases replaced by 4 thin legs')

# material groups: one upholstery colour per seat (shadowed sides otherwise come out much darker)
for o in O:
    if o['id'].startswith(('chair-', 'sofa-', 'armchair-')):
        for p in o['parts']:
            if p['name'] in ('back', 'seat', 'seat_base', 'arm_left', 'arm_right', 'shell_under'):
                p['material'] = 'upholstery'

# =========================================================================== 5b. colours (outward samples, p80-86 band)
for o in O:
    if o['id'] == 'logo-wall-01':
        continue
    pm = object_part_meshes(o)
    pts, own, nrm = [], [], []
    for k, (p, m, fc) in enumerate(pm):
        ns = int(min(60000, max(300, m.area * 15000)))
        sp, fi = trimesh.sample.sample_surface(m, ns, seed=k)
        pts.append(sp); own.append(np.full(len(sp), k)); nrm.append(m.face_normals[fi])
    pts, own, nrm = np.concatenate(pts), np.concatenate(own), np.concatenate(nrm)
    lo = pts.min(0) - 0.06; hi = pts.max(0) + 0.06
    sel = np.nonzero(np.all((P >= lo) & (P <= hi), 1))[0]
    if len(sel) == 0:
        continue
    dist, j = cKDTree(pts).query(P[sel])
    ok = (dist < 0.05) & (np.einsum('ij,ij->i', N[sel], nrm[j]) > 0.5)
    changed = []
    groups = {}
    for k, (p, m, fc) in enumerate(pm):
        if p.get('color_source') == FIXED:
            continue
        if p.get('color_n', 1) == 0 and not p.get('material'):
            p['color_source'] = 'r1 default (part not observed in r1; nearby samples belong to other surfaces)'
            continue
        groups.setdefault(p.get('material') or ('part', k), []).append(k)
    for g, ks in groups.items():
        mk = np.zeros(len(P), bool); mk[sel[ok & np.isin(own[j], ks)]] = True
        col, n = band_colour(mk)
        for k in ks:
            p = pm[k][0]
            if col is None:
                p['color_source'] = 'r1 (too few outward samples for the p80-86 band)'
                continue
            changed.append(f"{p['name']}:{p['color_rgb']}->{col}")
            p['color_rgb'] = col; p['color_n'] = n
            p['color_source'] = 'p80-86 luminance band of outward samples within 5 cm' + \
                (f" (material group '{g}')" if isinstance(g, str) else '')
    if changed:
        say(f"colour {o['id']}: " + ', '.join(changed[:6]) + (' ...' if len(changed) > 6 else ''))

# =========================================================================== 5c. view textures (table top, sofas)


def view_texture(o, view, part_names, lo, hi, y_rng, name, vis_tol=0.03):
    if view == 'top':
        fids = BU.faces_in_box([lo[0], y_rng[0], lo[2]], [hi[0], y_rng[1], hi[2]], normal=[0, 1, 0], cos_min=0.3)
        origin, u, v, dep, nrm = [lo[0], hi[1], lo[2]], [1, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 0]
        W_, H_ = int(round((hi[0] - lo[0]) / 0.01)), int(round((hi[2] - lo[2]) / 0.01))
    else:   # 'front' = faces looking at -z (towards the room)
        fids = BU.faces_in_box([lo[0], y_rng[0], lo[2] - 0.06], [hi[0], y_rng[1], hi[2]], normal=[0, 0, -1], cos_min=0.3)
        origin, u, v, dep, nrm = [hi[0], hi[1], lo[2]], [-1, 0, 0], [0, -1, 0], [0, 0, -1], [0, 0, -1]
        W_, H_ = int(round((hi[0] - lo[0]) / 0.01)), int(round((hi[1] - lo[1]) / 0.01))
    rgb, obs = BU.ortho_bake(fids, origin, u, v, (W_, H_), depth_vec=dep, visible_tol=vis_tol)
    f = save_tex(name, rgb, obs)
    o.setdefault('textures', []).append(dict(file=f, view=view, parts=part_names, normal=nrm, origin=r3(origin), u_vec=u,
                                             v_vec=v, px=0.01, size=[W_, H_], observed_fraction=round(float(obs.mean()), 3),
                                             faces=int(len(fids)),
                                             method='orthographic visible-surface bake of the scan (nearest surface within '
                                                    f'{vis_tol * 100:.0f} cm per texel), push-pull hole fill'))
    say(f"texture {name}: {W_}x{H_} faces {len(fids)} observed {obs.mean():.2f}")


o = OB['table-01']
pm = {p['name']: m for p, m, _ in object_part_meshes(o)}
lo, hi = pm['top_slab'].bounds
view_texture(o, 'top', ['top_slab'], lo, hi, (hi[1] - 0.08, hi[1] + 0.45), 'obj_table-01_top')
for sid in ('sofa-01', 'sofa-02'):
    o = OB[sid]
    ms = [m for _, m, _ in object_part_meshes(o)]
    lo = np.min([m.bounds[0] for m in ms], 0); hi = np.max([m.bounds[1] for m in ms], 0)
    names = [p['name'] for p in o['parts']]
    view_texture(o, 'top', names, lo, hi, (0.25, hi[1] + 0.15), f'obj_{sid}_top')
    view_texture(o, 'front', names, lo, hi, (lo[1] + 0.02, hi[1] + 0.05), f'obj_{sid}_front', vis_tol=0.05)

# =========================================================================== write
for o in O:
    ms = [m for _, m, _ in object_part_meshes(o)]
    lo = np.min([m.bounds[0] for m in ms], 0); hi = np.max([m.bounds[1] for m in ms], 0)
    o['bbox'] = dict(min=r3(lo), max=r3(hi))
json.dump(O, open(os.path.join(OUT, 'objects.json'), 'w'), ensure_ascii=False, indent=1)
S['round2'] = 'refine_r2.py: glazing_z15.64_1 re-baked (per-pane row-median fill); glazing_east_1/2 added (rows appended to structure_points.npy)'
json.dump(S, open(os.path.join(OUT, 'structure.json'), 'w'), ensure_ascii=False, indent=1)
np.save(os.path.join(OUT, 'structure_points.npy'), np.array(rows, np.float32))
meta_p = os.path.join(OUT, 'objects_meta.json')
meta = json.load(open(os.path.join(BK, 'objects_meta.json'))) if os.path.exists(os.path.join(BK, 'objects_meta.json')) else json.load(open(meta_p))
meta['n_objects'] = len(O); meta['n_parts'] = int(sum(len(o['parts']) for o in O))
meta['primitive_types'].update({
    'cone': 'radius, height, position = centre of the height span (base at the bottom), segments',
    'bicone': 'radius, height, waist (0-1, widest height fraction), position = centre, segments',
    'profile_extrude': 'polygon [[x,z]...], inset_profile [[h, inset]...], edge_inset [weight per edge]: each layer moves '
                       'edge i inwards by weight*inset (mitred); low_color_rgb for side faces up to low_until',
})
meta['colour'] = ('r2: sRGB of the p80-86 luminance band of samples within 5 cm of the part whose normal agrees with the '
                  'part surface (outward); color_source says how; FIXED = set explicitly (white desk shell, glass, legs, books)')
meta['textures'] = ('objects may carry "textures": [{file, parts, normal, origin, u_vec, v_vec, px, size}] (world frame): faces '
                    'of the listed parts whose world normal matches `normal` are textured with col=(p-origin).u/px, '
                    'row=(p-origin).v/px; a box part may carry "texture" (same fields) for its face along `normal`')
meta['log_r2'] = log
json.dump(meta, open(meta_p, 'w'), ensure_ascii=False, indent=1)
say(f'wrote {len(O)} objects / {meta["n_parts"]} parts, {len(S["elements"])} structure elements ({time.time() - t0:.1f}s)')
