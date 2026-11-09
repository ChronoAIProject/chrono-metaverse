"""Round-3 floor: continuous outline + smooth fitted height surface (no 10 cm grid, no constant height).

usage
  python -I r3/floor_r3.py --surface     height surface only (out/r3/floor_surface_r3.json; needed by structure_r3.py)
  python -I r3/floor_r3.py               outline + mesh (needs out/r3/structure_r3.json and out/r3/arch_solids.json)

Height surface: floor support samples of the scan (sample_surface 600/m2, n_y > 0.9, y < 0.3, outside furniture
boxes) -> robust (Huber IRLS, delta 1 cm, hard reject > 5 cm) least-squares bicubic B-spline with interior knots
every 1.5 m (scipy LSQBivariateSpline). Cells without floor samples (under the desk / sofas) are tied to a diffused
0.5 m median field with a low weight so the spline stays well posed. Coefficients + knots in the json.

Outline: floor support samples within 2 cm of the surface -> 2D alpha shape (alpha 0.25 m, union of Delaunay
triangles with circumradius < alpha, at continuous coordinates) + the footprints of the furniture standing on the
floor (holes under them are filled) -> wall-adjacent edges replaced by the fitted wall lines of structure_r3.json
(the band between the alpha shape and a wall face is filled, the 12 cm strip behind every wall face is cut away,
so corners are the walls' intersections) -> Douglas-Peucker 1 cm. Open edges (corridors) keep the alpha-shape edges.

Mesh: Delaunay of the outline vertices (edges densified to <= 0.25 m) + interior Steiner points every 0.5 m, kept
where inside the outline (area check against the polygon); vertex y = surface(x, z). UV: the round-2 floor texture
mapping (x, z) -> (u, v) of structure.json's floor rect (texture not re-baked).
"""
import os, sys, json, time
import numpy as np
import shapely
from shapely.geometry import Polygon, MultiPolygon, box as sbox
from shapely.ops import unary_union
from scipy.interpolate import LSQBivariateSpline, BivariateSpline
from scipy.spatial import Delaunay
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__)); PAR = os.path.dirname(HERE)
for p in (PAR, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)

OUT = os.path.join(PAR, 'out'); OUT3 = os.path.join(OUT, 'r3')
SURF = os.path.join(OUT3, 'floor_surface_r3.json')
FLOOR_JSON = os.path.join(OUT3, 'floor_r3.json')
FLOOR_NPZ = os.path.join(OUT3, 'floor_r3_mesh.npz')
KNOT = 1.5
FURN_SKIP = {'logo-wall-01', 'screen-01', 'window-frame-01', 'pillar-01', 'plant-01'}


# ===================================================================== height surface
class Surf:
    def __init__(self, d):
        self.d = d
        self.sp = BivariateSpline._from_tck((np.array(d['tx']), np.array(d['tz']), np.array(d['c']), d['kx'], d['kz']))
        self.lo = np.array(d['bbox'][:2]); self.hi = np.array(d['bbox'][2:])

    def __call__(self, x, z):
        x = np.clip(np.atleast_1d(np.asarray(x, float)), self.lo[0], self.hi[0])
        z = np.clip(np.atleast_1d(np.asarray(z, float)), self.lo[1], self.hi[1])
        return self.sp.ev(x, z)


_cache = {}


def load():
    if 'surf' not in _cache:
        _cache['surf'] = Surf(json.load(open(SURF)))
    return _cache['surf']


def height(fl, x, z):
    return fl(x, z)


def furniture_boxes():
    objs = json.load(open(os.path.join(OUT3, 'objects_r3.json')))
    return [(o['id'], np.array(o['bbox']['min']), np.array(o['bbox']['max'])) for o in objs if o['id'] not in FURN_SKIP]


def fit_surface():
    t0 = time.time()
    from common import sample_surface
    P, C, N, _ = sample_surface(600.0, seed=13)
    m = (N[:, 1] > 0.9) & (P[:, 1] < 0.3) & (P[:, 1] > -0.1)
    for oid, lo, hi in furniture_boxes():
        inside = np.all((P[:, [0, 2]] >= lo[[0, 2]]) & (P[:, [0, 2]] <= hi[[0, 2]]), axis=1)
        m &= ~(inside & (P[:, 1] > lo[1] + 0.02))                     # object surfaces, not the floor under them
    Q = P[m]
    x, z, y = Q[:, 0], Q[:, 2], Q[:, 1]
    # 0.5 m median field (diffused into empty cells): low-weight ties for knot cells without floor samples
    g = 0.5
    nx, nz = int(np.ceil(x.max() / g)) + 1, int(np.ceil(z.max() / g)) + 1
    ix, iz = (x / g).astype(int), (z / g).astype(int)
    med = np.full((nx, nz), np.nan)
    key = ix * nz + iz; o = np.argsort(key); ks, ys = key[o], y[o]
    u, st, cn = np.unique(ks, return_index=True, return_counts=True)
    for k, s, c in zip(u, st, cn):
        if c >= 20:
            med.flat[k] = np.median(ys[s:s + c])
    empty = np.isnan(med)
    _, (ii, jj) = ndimage.distance_transform_edt(empty, return_indices=True)
    fill = med[ii, jj]
    ex, ez = np.nonzero(empty)
    tie_x, tie_z, tie_y = (ex + 0.5) * g, (ez + 0.5) * g, fill[ex, ez]
    X = np.r_[x, tie_x]; Z = np.r_[z, tie_z]; Y = np.r_[y, tie_y]
    w0 = np.r_[np.ones(len(x)), np.full(len(tie_x), 5.0)]                 # a tie ~ 5 samples (cells hold ~150)
    bbox = [0.0, float(X.max()) + 0.01, 0.0, float(Z.max()) + 0.01]
    tx = np.arange(KNOT, bbox[1] - 0.5, KNOT); tz = np.arange(KNOT, bbox[3] - 0.5, KNOT)
    w = w0.copy(); delta = 0.01
    for it in range(6):
        sp = LSQBivariateSpline(X, Z, Y, tx, tz, w=w, bbox=bbox, kx=3, ky=3)
        r = Y - sp.ev(X, Z)
        hub = np.where(np.abs(r) <= delta, 1.0, delta / np.maximum(np.abs(r), 1e-9))
        hub[np.abs(r) > 0.05] = 1e-6
        w = w0 * hub
    r = y - sp.ev(x, z)
    inl = np.abs(r) < 0.02
    tck = sp.tck
    d = dict(kind='bicubic LSQ B-spline y = f(x, z)', knot_spacing_m=KNOT, tx=tck[0].tolist(), tz=tck[1].tolist(),
             c=tck[2].tolist(), kx=3, kz=3, bbox=[bbox[0], bbox[2], bbox[1], bbox[3]],
             fit=dict(samples=int(len(x)), ties=int(len(tie_x)), irls='Huber delta 1 cm, |r| > 5 cm rejected',
                      resid_inliers_cm=dict(p50=round(float(np.median(np.abs(r[inl]))) * 100, 2),
                                            p90=round(float(np.percentile(np.abs(r[inl]), 90)) * 100, 2)),
                      inlier_frac_2cm=round(float(inl.mean()), 3)),
             range_y=[round(float(np.percentile(sp.ev(x, z), 1)), 4), round(float(np.percentile(sp.ev(x, z), 99)), 4)])
    json.dump(d, open(SURF, 'w'))
    print(f'floor surface: {len(x)} samples + {len(tie_x)} ties, knots {len(tx)}x{len(tz)}, |r| p50 '
          f'{d["fit"]["resid_inliers_cm"]["p50"]} cm p90 {d["fit"]["resid_inliers_cm"]["p90"]} cm, inliers(2cm) '
          f'{inl.mean():.3f}, height p1..p99 {d["range_y"]}  ({time.time() - t0:.1f}s)')
    return Surf(d)


# ===================================================================== outline
def alpha_polygon(pts, alpha):
    pts = np.unique(np.round(pts, 5), axis=0)
    tri = Delaunay(pts); T = pts[tri.simplices]
    a = np.linalg.norm(T[:, 1] - T[:, 2], axis=1); b = np.linalg.norm(T[:, 0] - T[:, 2], axis=1)
    c = np.linalg.norm(T[:, 0] - T[:, 1], axis=1)
    ar = 0.5 * np.abs((T[:, 1, 0] - T[:, 0, 0]) * (T[:, 2, 1] - T[:, 0, 1]) - (T[:, 2, 0] - T[:, 0, 0]) * (T[:, 1, 1] - T[:, 0, 1]))
    R = a * b * c / np.maximum(4 * ar, 1e-15)
    keep = (R < alpha) & (ar > 1e-12)
    polys = shapely.polygons(T[keep])
    return shapely.coverage_union_all(polys)


def wall_frame(e):
    n = np.array(e['plane']['normal'], float); a = np.array([n[0], n[2]]); a /= np.linalg.norm(a)
    C4 = np.array(e['corners'], float)
    q0, q1 = C4[0][[0, 2]], C4[1][[0, 2]]
    # face line at floor level (corners 0 / 1 are the bottom ones)
    return a, q0, q1


def outline(fl, walls, solids, log):
    from common import sample_surface
    P, C, N, _ = sample_surface(600.0, seed=17)
    m = (N[:, 1] > 0.9) & (np.abs(P[:, 1] - fl(P[:, 0], P[:, 2])) < 0.02)
    pts = P[m][:, [0, 2]]
    A = alpha_polygon(pts, 0.25)
    geoms = [g for g in getattr(A, 'geoms', [A]) if g.area > 0.5]
    base = unary_union(geoms)
    log.append(f'alpha shape (0.25 m) of {len(pts)} floor support samples: {len(geoms)} piece(s), {base.area:.2f} m2')
    feet = []
    for oid, lo, hi in furniture_boxes():
        feet.append(sbox(lo[0], lo[2], hi[0], hi[2]))
    for s in solids:                     # sliced solids: their own lowest outlines (world), not a box
        if not s.get('stands_on_floor', True):
            continue
        px, pz = s['transform']['position'][0], s['transform']['position'][2]
        for p in s['parts']:
            for sec in p.get('sections', []):
                if sec['y'] < 0.1 and len(sec['outline']) >= 3:
                    q = np.asarray(sec['outline'], float) + [px, pz]
                    feet.append(Polygon(q).buffer(0.01))
    region = unary_union([base] + [f for f in feet if f.intersects(base.buffer(0.3))])
    # fill holes (under furniture / scan holes): exterior rings only
    region = unary_union([Polygon(g.exterior) for g in getattr(region, 'geoms', [region]) if g.area > 0.5])
    near = region.buffer(0.4)
    fronts, behinds = [], []
    for e in walls:
        a, q0, q1 = wall_frame(e)
        t = q1 - q0; L = np.linalg.norm(t)
        if L < 0.05:
            continue
        front = Polygon([q0, q1, q1 + 0.4 * a, q0 + 0.4 * a])
        tu = t / L
        behind = Polygon([q0 - 0.02 * tu, q1 + 0.02 * tu, q1 + 0.02 * tu - 0.12 * a, q0 - 0.02 * tu - 0.12 * a])
        fronts.append(front.intersection(near)); behinds.append(behind)
    region = unary_union([region] + fronts)
    region = region.difference(unary_union(behinds))
    parts = [g for g in getattr(region, 'geoms', [region]) if g.area > 0.5]
    region = unary_union([Polygon(g.exterior) for g in parts])
    region = region.simplify(0.01, preserve_topology=True)
    pieces = sorted([g for g in getattr(region, 'geoms', [region]) if g.area > 0.5], key=lambda g: -g.area)
    log.append(f'floor outline: {len(pieces)} piece(s) {[round(g.area, 2) for g in pieces]} m2, '
               f'{sum(len(g.exterior.coords) - 1 for g in pieces)} vertices '
               f'(after wall-line replacement, 12 cm strips behind {len(behinds)} wall faces cut, DP 1 cm)')
    return pieces


# ===================================================================== mesh
def mesh_polygon(poly, fl, seg=0.25, steiner=0.5):
    for attempt in range(4):
        rings = [np.asarray(poly.exterior.coords)[:-1]] + [np.asarray(h.coords)[:-1] for h in poly.interiors]
        B = []
        for R in rings:
            for i in range(len(R)):
                a, b = R[i], R[(i + 1) % len(R)]
                k = max(1, int(np.ceil(np.linalg.norm(b - a) / seg)))
                B.append(a + (b - a) * (np.arange(k)[:, None] / k))
        B = np.concatenate(B)
        inner = poly.buffer(-0.15)
        x0, z0, x1, z1 = poly.bounds
        gx, gz = np.meshgrid(np.arange(x0 + 0.25, x1, steiner), np.arange(z0 + 0.25, z1, steiner))
        G = np.c_[gx.ravel(), gz.ravel()]
        G = G[shapely.contains_xy(inner, G[:, 0], G[:, 1])]
        pts = np.r_[B, G]
        tri = Delaunay(pts)
        T = tri.simplices; cen = pts[T].mean(1)
        keep = shapely.contains_xy(poly, cen[:, 0], cen[:, 1])
        T = T[keep]
        e1_, e2_ = pts[T[:, 1]] - pts[T[:, 0]], pts[T[:, 2]] - pts[T[:, 0]]
        area = 0.5 * np.abs(e1_[:, 0] * e2_[:, 1] - e1_[:, 1] * e2_[:, 0]).sum()
        if abs(area - poly.area) < 1e-3 * poly.area:
            break
        seg /= 2
    V = np.c_[pts[:, 0], fl(pts[:, 0], pts[:, 1]), pts[:, 1]]
    # faces must point up (+y): (b - a) x (c - a) has y = (c-a).x (b-a).z - (b-a).x (c-a).z ... orient per face
    a, b, c = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    ny = np.cross(b - a, c - a)[:, 1]
    T = np.where((ny < 0)[:, None], T[:, [0, 2, 1]], T)
    return V, T, dict(boundary_pts=int(len(B)), steiner_pts=int(len(G)), triangles=int(len(T)),
                      mesh_area_m2=round(float(area), 3), polygon_area_m2=round(float(poly.area), 3), seg_m=seg)


def main():
    t0 = time.time(); log = []
    if '--surface' in sys.argv:
        fit_surface(); return
    fl = load()
    S3 = json.load(open(os.path.join(OUT3, 'structure_r3.json')))
    walls = [e for e in S3['elements'] if e['kind'] == 'wall' and e.get('thickness', 0.1) > 0]
    sp = os.path.join(OUT3, 'arch_solids.json')
    solids = json.load(open(sp)) if os.path.exists(sp) else []
    pieces = outline(fl, walls, solids, log)
    Vs, Ts, infos, nv = [], [], [], 0
    for g in pieces:
        V_, T_, inf_ = mesh_polygon(g, fl)
        Vs.append(V_); Ts.append(T_ + nv); nv += len(V_); infos.append(inf_)
    V, T = np.concatenate(Vs), np.concatenate(Ts)
    info = dict(pieces=infos, triangles=int(len(T)))
    poly = pieces[0]
    S2 = json.load(open(os.path.join(OUT, 'structure.json')))
    F2 = next(e for e in S2['elements'] if e['kind'] == 'floor')
    (rx0, rx1), (rz0, rz1) = F2['rect']['x'], F2['rect']['z']
    UV = np.c_[(V[:, 0] - rx0) / (rx1 - rx0), 1.0 - (V[:, 2] - rz0) / (rz1 - rz0)]
    np.savez_compressed(FLOOR_NPZ, V=V, F=T, UV=UV)
    ring = np.round(np.asarray(poly.exterior.coords)[:-1], 5).tolist()
    d = dict(id='floor_r3', kind='floor', source='r3/floor_r3.py', method=__doc__,
             outline_xz=ring, holes_xz=[np.round(np.asarray(h.coords)[:-1], 5).tolist() for h in poly.interiors],
             polygons=[dict(outline_xz=np.round(np.asarray(g.exterior.coords)[:-1], 5).tolist(),
                            holes_xz=[np.round(np.asarray(h.coords)[:-1], 5).tolist() for h in g.interiors],
                            area_m2=round(g.area, 3)) for g in pieces],
             area_m2=round(sum(g.area for g in pieces), 3), surface='out/r3/floor_surface_r3.json', mesh='out/r3/floor_r3_mesh.npz',
             mesh_info=info, texture='tex/floor.png', texture_rect=dict(x=[rx0, rx1], z=[rz0, rz1]),
             texture_layout='u = (x - x0) / (x1 - x0), v = 1 - (z - z0) / (z1 - z0) (round-2 floor bake, unchanged)',
             log=log)
    json.dump(d, open(FLOOR_JSON, 'w'), indent=1)
    for l in log:
        print(l)
    print(info, f'({time.time() - t0:.1f}s)')


if __name__ == '__main__':
    main()
