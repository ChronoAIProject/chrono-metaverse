"""Round-3 contour utilities: scan sub-mesh -> cross-section outlines -> "loft" primitive -> texture transfer.

Principle: geometry follows the real object contours of the 3D scan at continuous coordinates (no grid snapping);
images are never used for geometry. All sizes are metres, y up, aligned scan frame of common.load_aligned().

  object_mesh(bbox, pad)           scan triangles of one object (padded box, minus local floor + 2 cm, minus walls
                                   within 6 cm of the drift-aware wall planes of structure.json, minus components that
                                   mostly lie outside the unpadded box). Returns a dict (see the function).
  to_local / to_world / local_mesh object frame of objects.json: world = Ry(yaw) * local + position (prims.py convention)
  auto_params(extent)              resolution parameters scaled with the real object size
  slice_contours(src, axis, step)  closed outlines per level. Mesh input: inside/outside of every level is decided by
                                   the oriented scan surface (sign of (q - s).n over the nearest scan samples, bounded by
                                   the object's footprint hull) -> this closes scan holes / unscanned backs; the outline is
                                   then pulled onto the exact trimesh section of the scan wherever one exists within a few
                                   cm (normal-compatible), Douglas-Peucker simplified (~1 cm), every simplified edge is
                                   re-fitted to its scan points (orthogonal regression) and near-axis edges are made
                                   exactly axis-parallel; corners = intersections of the fitted lines (continuous coords).
                                   Points-only input without normals falls back to an alpha shape of a thin slab.
                                   Optional mirror symmetry about a fitted axis.
  lofts_from_levels(levels)        chain per-level polygons into tracks -> [{'type': 'loft', 'sections': [...]}, ...]
  loft(sections)                   loft primitive -> trimesh: compatible consecutive outlines are joined by a band
                                   (arc-length correspondence with best cyclic alignment, every outline vertex kept
                                   exactly); abrupt changes (90th pct of the corresponding-point displacement steeper
                                   than max_slope_deg, e.g. seat -> arms) become a step:
                                   vertical walls to the mid height + horizontal caps of the polygon differences.
                                   Bottom / top caps by constrained Delaunay. Outward-facing, geometrically closed.
  transfer_texture(mesh, scan)     box-projection charts (object frame, overlap-checked), shelf-packed atlas, every
                                   texel baked from the ORIGINAL scan texture at the closest normal-compatible point of
                                   the original scan surface (KD-tree candidates -> exact closest point on the triangle
                                   -> barycentric UV -> bilinear). Unobserved texels: colour of the nearest observed
                                   texel in 3D. Gutters dilated.
  part_mesh(p)                     prims.part_mesh plus the new 'loft' type
  export_glb(path, items)          textured / vertex-coloured meshes -> GLB

Loft primitive JSON (object-local coordinates, y = height above the object's floor):
  {"type": "loft", "name": ..., "axis": "y", "max_slope_deg": 75,
   "sections": [{"y": 0.0, "outline": [[x, z], ...]}, ...],   # outlines CCW in (x, z), ascending y;
                                                               # optional "step": true = force a step below it
   "color_rgb": [r, g, b], "texture": {"file": ..., "uv": "baked"}}
"""
import os, sys, io, json, time
import numpy as np
import trimesh
import shapely
import shapely.affinity
from shapely.geometry import Polygon, MultiPolygon, LineString
from shapely.ops import unary_union
from scipy.spatial import cKDTree, Delaunay
from scipy import ndimage
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PAR = os.path.dirname(HERE)
if PAR not in sys.path:
    sys.path.insert(0, PAR)
from common import load_aligned   # noqa: E402
import prep                       # noqa: E402

OUT = os.path.join(PAR, 'out')
Image.MAX_IMAGE_PIXELS = None

# ===================================================================== scene access
_S = {}


def scene():
    """Cached aligned scan: V, F, UV, tex, face normals FN, areas FA, centroids FC."""
    if 'V' not in _S:
        V, F, UV, tex, _ = load_aligned()
        a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
        cr = np.cross(b - a, c - a); ar = 0.5 * np.linalg.norm(cr, axis=1)
        _S.update(V=V, F=F, UV=UV, tex=tex, FN=cr / np.maximum(2 * ar[:, None], 1e-12), FA=ar, FC=(a + b + c) / 3)
    return _S


def floor_height(x, z):
    """Local floor height (prep.floor_map, 0.5 m cells, bilinear) at world x, z."""
    if 'floor' not in _S:
        P, C, N = prep.load()
        _S['floor'] = prep.floor_map(P, N)
    g, cell = _S['floor']
    return prep.floor_at(g, cell, np.atleast_1d(np.asarray(x, float)), np.atleast_1d(np.asarray(z, float)))


def wall_planes(path=None):
    """Wall / glazing planes of structure.json: 2D normal n (into the room), tangent t, offset n.p, u / y range and the
    per-0.5 m offset drift profile (solid walls), so that 'distance to the wall' follows the warped scan wall."""
    key = 'walls:' + str(path)
    if key not in _S:
        d = json.load(open(path or os.path.join(OUT, 'structure.json')))
        out = []
        for e in d['elements']:
            if e['kind'] != 'wall':
                continue
            n = np.array(e['plane']['normal'], float)[[0, 2]]; n /= np.linalg.norm(n)
            t = np.array(e['u_axis'], float)[[0, 2]]; t /= np.linalg.norm(t)
            off = float(np.array(e['corners'][0], float)[[0, 2]] @ n)
            dr = np.array(e.get('offset_drift', [[0.0, 0.0]]), float)
            out.append(dict(id=e['id'], n=n, t=t, off=off, u=tuple(e['u_range']), y=tuple(e['rect']['y']), drift=dr,
                            glazing=bool(e.get('glazing', False))))
        _S[key] = out
    return _S[key]


def wall_signed_distance(P, w):
    """Signed distance of world points P to wall w along its normal (+ = room side), drift-aware; and u = t.p."""
    s = P[:, [0, 2]] @ w['n']; u = P[:, [0, 2]] @ w['t']
    loc = w['off'] + (np.interp(u, w['drift'][:, 0], w['drift'][:, 1]) if len(w['drift']) > 1 else 0.0)
    return s - loc, u


# ===================================================================== object frame
def Ry(deg):
    a = np.radians(deg); c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def to_local(P, T):
    return (np.asarray(P, float) - np.asarray(T['position'], float)) @ Ry(T.get('yaw_deg', 0.0))


def to_world(L, T):
    return np.asarray(L, float) @ Ry(T.get('yaw_deg', 0.0)).T + np.asarray(T['position'], float)


def local_mesh(m, T):
    return trimesh.Trimesh(to_local(m.vertices, T), m.faces.copy(), process=False)


def world_mesh(m, T):
    return trimesh.Trimesh(to_world(m.vertices, T), m.faces.copy(), process=False)


def fit_yaw(mesh):
    """Dominant horizontal direction (deg, mod 90) of a mesh from its area-weighted horizontal face normals."""
    n = mesh.face_normals; a = mesh.area_faces
    h = np.abs(n[:, 1]) < 0.4
    ang = np.mod(np.degrees(np.arctan2(n[h, 2], n[h, 0])), 90.0)
    hist, e = np.histogram(ang, bins=180, range=(0, 90), weights=a[h])
    hist = ndimage.uniform_filter1d(hist, 5, mode='wrap')
    k = int(np.argmax(hist)); return float(0.5 * (e[k] + e[k + 1]))


# ===================================================================== 1. object sub-mesh
def object_mesh(bbox, pad=0.05, floor_clear=0.02, wall_tol=0.06, min_inside=0.5, facing=0.2, structure=None):
    """Scan triangles of one object.

    bbox: {'min': [x,y,z], 'max': [x,y,z]} (objects.json) or (lo, hi), world coordinates.
    Faces are kept when their centroid lies in the box padded by `pad`, is more than `floor_clear` above the local
    floor, is not within `wall_tol` of a wall / glazing plane (drift-aware, inside the wall's extent +- 0.3 m) and not
    behind one; faces in the pad zone that face back towards the box (normal component > `facing` inwards) are a
    neighbour's surface and are dropped. Faces inside the UNPADDED box are always kept; faces in the pad zone only
    when their connected component (vertices merged by position: Draco splits them at UV seams) has at least
    `min_inside` of its area inside the unpadded box (the scan fuses touching objects, so a component is never
    dropped as a whole just for lying mostly outside).
    Returns dict(mesh=trimesh (world, merged vertices), face_ids=indices into the scan F, floor_y=median local floor,
                 lo, hi, stats).
    """
    S = scene()
    if isinstance(bbox, dict):
        lo, hi = np.array(bbox['min'], float), np.array(bbox['max'], float)
    else:
        lo, hi = np.array(bbox[0], float), np.array(bbox[1], float)
    lo_p, hi_p = lo - pad, hi + pad
    FC = S['FC']
    sel = np.nonzero(np.all((FC >= lo_p) & (FC <= hi_p), axis=1))[0]
    c = FC[sel]
    fl = floor_height(c[:, 0], c[:, 2])
    keep = c[:, 1] > fl + floor_clear
    n_floor = int((~keep).sum())
    n_wall = 0
    for w in wall_planes(structure):
        d, u = wall_signed_distance(c, w)
        inside = (u > w['u'][0] - 0.3) & (u < w['u'][1] + 0.3) & (c[:, 1] > w['y'][0] - 0.1) & (c[:, 1] < w['y'][1] + 0.1)
        rm = inside & (d < wall_tol)              # on the wall or behind it
        n_wall += int((keep & rm).sum()); keep &= ~rm
    # pad zone: a face outside the unpadded box must not face back towards the object (that is a neighbour's
    # surface facing us, e.g. a cabinet side panel next to a sofa arm, or a table top above a chair)
    FNs = S['FN'][sel]
    n_nb = 0
    for ax in range(3):
        above, below = c[:, ax] > hi[ax], c[:, ax] < lo[ax]
        nb = (above & (FNs[:, ax] < -facing)) | (below & (FNs[:, ax] > facing))
        n_nb += int((keep & nb).sum()); keep &= ~nb
    sel = sel[keep]
    m = trimesh.Trimesh(S['V'], S['F'][sel], process=False)
    m.remove_unreferenced_vertices(); m.merge_vertices()
    comps = trimesh.graph.connected_components(m.face_adjacency, nodes=np.arange(len(m.faces)), min_len=1)
    fa = m.area_faces; fcn = m.triangles_center
    ins = np.all((fcn >= lo) & (fcn <= hi), axis=1)
    keepf = ins.copy(); n_drop = 0                       # faces inside the unpadded box are always kept
    for cc in comps:                                     # pad-zone faces only with a mostly-inside component
        a = fa[cc].sum()
        if a > 0 and fa[cc][ins[cc]].sum() / a >= min_inside:
            keepf[cc] = True
        else:
            n_drop += 1
    face_ids = sel[keepf]
    mesh = trimesh.Trimesh(S['V'], S['F'][face_ids], process=False)
    mesh.remove_unreferenced_vertices(); mesh.merge_vertices()
    floor_y = float(np.median(floor_height(mesh.triangles_center[:, 0], mesh.triangles_center[:, 2])))
    stats = dict(faces_in_box=int(len(keep)), removed_floor=n_floor, removed_wall=n_wall, removed_neighbour=n_nb,
                 components=len(comps), dropped_components=n_drop, faces=int(len(face_ids)),
                 area_m2=round(float(mesh.area), 3))
    return dict(mesh=mesh, face_ids=face_ids, floor_y=floor_y, lo=lo, hi=hi, stats=stats)


def sample_mesh(mesh, spacing, seed=0, face_ids=None):
    """Area-uniform surface samples (~1 per spacing^2): points, face normals, source face index (local to mesh)."""
    rng = np.random.default_rng(seed)
    a = mesh.area_faces
    cnt = rng.poisson(a / spacing ** 2)
    idx = np.repeat(np.arange(len(a)), cnt)
    r1, r2 = rng.random(len(idx)), rng.random(len(idx)); s = np.sqrt(r1)
    w = np.c_[1 - s, s * (1 - r2), s * r2]
    tri = mesh.triangles[idx]
    P = np.einsum('ni,nij->nj', w, tri)
    return P, mesh.face_normals[idx], idx, w


# ===================================================================== resolution scaled with object size
def auto_params(extent):
    """Resolution from the real object size (max of the 3 extents, m) instead of one global grid.
    step: slice spacing, res: inside/outside evaluation spacing, tol: Douglas-Peucker tolerance,
    morph: opening radius (drops slivers), close: closing radius (fills crevices) of the per-level region,
    min_area: smallest kept outline,
    texel: texture metres per texel (4 mm for <= 1 m objects -> 1 cm for >= 3 m)."""
    ext = np.asarray(extent, float); size = float(ext.max()); height = float(ext[1])
    return dict(size=size,
                step=float(np.clip(height / 35.0, 0.008, 0.03)),
                res=float(np.clip(size / 200.0, 0.004, 0.012)),
                tol=float(np.clip(size / 200.0, 0.003, 0.01)),
                snap=float(np.clip(size / 80.0, 0.012, 0.03)),
                morph=float(np.clip(size / 200.0, 0.004, 0.012)),
                close=float(np.clip(size / 80.0, 0.012, 0.03)),
                snap_in=float(np.clip(size / 200.0, 0.003, 0.01)),
                min_area=float(max(2.5e-4, (size / 60.0) ** 2)),
                texel=float(np.interp(size, [1.0, 3.0], [0.004, 0.01])))


# ===================================================================== 2D polygon helpers
def signed_area(P):
    P = np.asarray(P, float); Q = np.roll(P, -1, 0)
    return 0.5 * float(np.sum(P[:, 0] * Q[:, 1] - Q[:, 0] * P[:, 1]))


def ccw(P):
    P = np.asarray(P, float)
    if len(P) > 1 and np.allclose(P[0], P[-1]):
        P = P[:-1]
    return P if signed_area(P) > 0 else P[::-1].copy()


def dedupe(P, eps=1e-6):
    P = np.asarray(P, float)
    d = np.linalg.norm(P - np.roll(P, 1, 0), axis=1)
    return P[d > eps] if (d > eps).sum() >= 3 else P


def _dp_open(P, tol):
    """Douglas-Peucker on an open polyline; tol may be a scalar or a per-point array."""
    n = len(P); keep = np.zeros(n, bool); keep[0] = keep[-1] = True
    tv = np.broadcast_to(np.asarray(tol, float), (n,))
    st = [(0, n - 1)]
    while st:
        i, j = st.pop()
        if j <= i + 1:
            continue
        a, b = P[i], P[j]; ab = b - a; L = np.hypot(ab[0], ab[1]); seg = P[i + 1:j]
        d = np.hypot(seg[:, 0] - a[0], seg[:, 1] - a[1]) if L < 1e-12 else \
            np.abs(ab[0] * (seg[:, 1] - a[1]) - ab[1] * (seg[:, 0] - a[0])) / L
        e = d - tv[i + 1:j]
        k = int(np.argmax(e))
        if e[k] > 0:
            m = i + 1 + k; keep[m] = True; st += [(i, m), (m, j)]
    return keep


def dp_closed(P, tol):
    """Douglas-Peucker on a closed ring (tol scalar or per point); returns sorted kept indices into P."""
    n = len(P)
    tv = np.broadcast_to(np.asarray(tol, float), (n,))
    i0 = int(np.argmin(P[:, 0] + 1e-3 * P[:, 1]))
    R = np.roll(P, -i0, 0); Tv = np.roll(tv, -i0)
    i1 = int(np.argmax(np.linalg.norm(R - R[0], axis=1)))
    k1 = _dp_open(R[:i1 + 1], Tv[:i1 + 1])
    k2 = _dp_open(np.r_[R[i1:], R[:1]], np.r_[Tv[i1:], Tv[:1]])
    keep = np.zeros(n, bool); keep[:i1 + 1] |= k1; keep[i1:] |= k2[:-1]
    return np.sort((np.nonzero(keep)[0] + i0) % n)


def resample_ring(P, spacing):
    """Closed ring resampled at ~spacing (keeps the original vertices)."""
    P = np.asarray(P, float); Q = np.roll(P, -1, 0)
    out = []
    for a, b in zip(P, Q):
        k = max(1, int(np.ceil(np.linalg.norm(b - a) / spacing)))
        t = np.arange(k)[:, None] / k
        out.append(a + t * (b - a))
    return np.concatenate(out)


def ring_normals(P):
    """Outward unit normals at the vertices of a CCW ring."""
    e = np.roll(P, -1, 0) - P
    en = np.c_[e[:, 1], -e[:, 0]]; en /= np.maximum(np.linalg.norm(en, axis=1, keepdims=True), 1e-12)
    n = en + np.roll(en, 1, 0)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def finalize_ring(D, tol, regularize=True, snap_deg=8.0, min_len=0.03, max_move=None, obs=None, tol_unobs=None):
    """Dense CCW ring (points on the scan) -> simplified polygon at continuous coordinates.
    DP(tol) picks the corners; each simplified edge is re-fitted (orthogonal regression) to the dense points it
    replaces; fitted edges within snap_deg of an object axis (and >= min_len long) become exactly axis-parallel;
    corners = intersections of consecutive fitted lines (projection average if near-parallel / too far).
    obs (bool per point): points not on a real scan section are simplified with tol_unobs instead (inferred parts,
    e.g. a hidden back or a face pressed against a neighbour, get fewer, longer edges)."""
    D = np.asarray(D, float)
    if obs is not None and len(obs) == len(D):
        if signed_area(D) < 0:
            D, obs = D[::-1], np.asarray(obs)[::-1]
        dd = np.linalg.norm(D - np.roll(D, 1, 0), axis=1) > 1e-6
        D, obs = D[dd], np.asarray(obs)[dd]
        tolv = np.where(obs, tol, tol_unobs or 3 * tol)
    else:
        D = dedupe(ccw(D)); tolv = tol
    if len(D) < 3:
        return None
    idx = dp_closed(D, tolv)
    if len(idx) < 3:
        return None
    if not regularize:
        return D[idx]
    max_move = max_move or max(2.5 * tol, 0.015)
    m = len(idx); lines = []
    sn = np.sin(np.radians(snap_deg))
    for a, b in zip(idx, np.roll(idx, -1)):
        span = D[a:b + 1] if b > a else np.r_[D[a:], D[:b + 1]]
        c = span.mean(0); ch = span[-1] - span[0]; L = np.linalg.norm(ch)
        if len(span) > 2:
            _, _, vt = np.linalg.svd(span - c, full_matrices=False); d = vt[0]
        else:
            d = ch / max(L, 1e-12)
        if d @ ch < 0:
            d = -d
        if L >= min_len:
            if abs(d[1]) < sn:
                d = np.array([np.sign(d[0]) or 1.0, 0.0])
            elif abs(d[0]) < sn:
                d = np.array([0.0, np.sign(d[1]) or 1.0])
        lines.append((c, d))
    out = []
    smin = np.sin(np.radians(12))
    for k in range(m):
        (c1, d1), (c2, d2) = lines[k - 1], lines[k]
        v0 = D[idx[k]]
        cr = d1[0] * d2[1] - d1[1] * d2[0]
        if abs(cr) > smin:
            w = c2 - c1; t = (w[0] * d2[1] - w[1] * d2[0]) / cr; p = c1 + t * d1
            if np.linalg.norm(p - v0) <= max_move:
                out.append(p); continue
        p1 = c1 + ((v0 - c1) @ d1) * d1; p2 = c2 + ((v0 - c2) @ d2) * d2
        out.append(0.5 * (p1 + p2))
    out = dedupe(np.array(out))
    poly = Polygon(out)
    ref = Polygon(D[idx])
    if (not poly.is_valid or len(out) < 3 or abs(poly.area - ref.area) > 0.1 * ref.area
            or poly.symmetric_difference(ref).area > 0.15 * ref.area):
        return D[idx]
    return ccw(out)


def _match_shift(A, B):
    """Best cyclic shift k of B (same length) to A: argmin sum |A - roll(B, -k)|^2 (via FFT cross-correlation)."""
    n = len(A)
    fa = np.fft.rfft(A, axis=0); fb = np.fft.rfft(B, axis=0)
    corr = np.fft.irfft((np.conj(fa) * fb).sum(1), n)       # corr[k] = sum_i A_i . B_{i+k}
    return int(np.argmax(corr))


def uniform_ring(P, n):
    P = np.asarray(P, float); Q = np.r_[P, P[:1]]
    seg = np.linalg.norm(np.diff(Q, axis=0), axis=1); cum = np.r_[0, np.cumsum(seg)]
    t = np.linspace(0, cum[-1], n, endpoint=False)
    return np.c_[np.interp(t, cum, Q[:, 0]), np.interp(t, cum, Q[:, 1])]


def mirror_average(D, c, n=512):
    """Symmetrise a CCW ring about the line u = c: average with its mirror under the best correspondence."""
    A = uniform_ring(D, n)
    M = A.copy(); M[:, 0] = 2 * c - M[:, 0]; M = M[::-1]
    k = _match_shift(A, M)
    return ccw(0.5 * (A + np.roll(M, -k, 0)))


def fit_mirror(rings, c0, span=0.15):
    """Mirror axis u = c minimising the symmetric-difference area of all rings with their mirrors."""
    from scipy.optimize import minimize_scalar
    polys = [Polygon(r) for r in rings if len(r) >= 3]
    polys = [p if p.is_valid else p.buffer(0) for p in polys]

    def cost(c):
        tot = 0.0
        for p in polys:
            q = shapely.affinity.scale(p, xfact=-1, yfact=1, origin=(c, 0))
            tot += p.symmetric_difference(q).area
        return tot
    r = minimize_scalar(cost, bounds=(c0 - span, c0 + span), method='bounded', options=dict(xatol=1e-4))
    area = sum(p.area for p in polys)
    return float(r.x), float(r.fun / max(area, 1e-12))


def alpha_shape(pts, alpha):
    """2D alpha shape (union of Delaunay triangles with circumradius < alpha) of points (fallback for points-only)."""
    pts = np.unique(np.round(np.asarray(pts, float), 6), axis=0)
    if len(pts) < 4:
        return Polygon()
    tri = Delaunay(pts); T = pts[tri.simplices]
    a = np.linalg.norm(T[:, 1] - T[:, 2], axis=1); b = np.linalg.norm(T[:, 0] - T[:, 2], axis=1)
    c = np.linalg.norm(T[:, 0] - T[:, 1], axis=1)
    ar = 0.5 * np.abs((T[:, 1, 0] - T[:, 0, 0]) * (T[:, 2, 1] - T[:, 0, 1]) - (T[:, 2, 0] - T[:, 0, 0]) * (T[:, 1, 1] - T[:, 0, 1]))
    R = a * b * c / np.maximum(4 * ar, 1e-15)
    keep = R < alpha
    return unary_union([Polygon(t) for t in T[keep]])


def _geoms(g):
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    return [x for x in getattr(g, 'geoms', []) if isinstance(x, Polygon)]


# ===================================================================== 2. slicing
AXES = {'y': (0, 2, 1), 'x': (2, 1, 0), 'z': (0, 1, 2)}    # (u index, v index, level index) of the 2D section frame


def lift(uv, level, axis='y'):
    iu, iv, il = AXES[axis]
    P = np.zeros((len(uv), 3)); P[:, iu] = uv[:, 0]; P[:, iv] = uv[:, 1]; P[:, il] = level
    return P


def detect_plateaus(P, N, W, axis='y', lo=None, hi=None, bin_=0.005, min_area=0.01, rel=0.04, sep=0.02):
    """Heights of horizontal surfaces (|n_level| > 0.85) by an area histogram: seat tops, table tops, shelf
    bottoms. P, N: sample points / normals, W: area per sample. Returns sorted level values."""
    il = AXES[axis][2]
    c = P[:, il]; flat = np.abs(N[:, il]) > 0.85
    lo = c.min() if lo is None else lo; hi = c.max() if hi is None else hi
    nb = max(1, int(np.ceil((hi - lo) / bin_)))
    h, e = np.histogram(c[flat], bins=nb, range=(lo, lo + nb * bin_), weights=W[flat])
    hs = ndimage.uniform_filter1d(h, 3)
    w = max(1, int(round(sep / bin_)))
    thr = max(min_area, rel * h.sum())
    pk = [i for i in range(nb) if hs[i] >= thr and hs[i] == hs[max(0, i - w):i + w + 1].max()]
    out = []
    for i in pk:
        sl = slice(max(0, i - 2), min(nb, i + 3))
        cen = 0.5 * (e[:-1] + e[1:])[sl]
        y = float((cen * h[sl]).sum() / max(h[sl].sum(), 1e-12))
        if not out or y - out[-1] > sep:
            out.append(y)
    return out


def make_levels(lo, hi, step, features=(), eps=0.004):
    """Regular levels every `step` plus feature levels just below / above every plateau (steps land on them)."""
    reg = list(np.arange(lo + step / 2, hi - step / 4, step))
    feat = []
    for f in features:
        feat += [f - eps, f + eps]
    feat = [f for f in feat if lo < f < hi]
    reg = [r for r in reg if all(abs(r - f) > 0.6 * step for f in features)]
    lv = sorted(set(np.round(reg + feat + [lo + 0.003, hi - 0.003], 5)))
    return [float(v) for v in lv]


def slice_contours(src, axis='y', step=None, levels=None, normals=None, params=None, regularize=True,
                   symmetry=None, hull=None, ground=None, k=24, vmedian=2, plane_merge=True, verbose=False):
    """Closed 2D outlines per level of an object given in object-local coordinates.

    src: trimesh (preferred; sections + oriented samples) or (N,3) points (normals= optional (N,3)).
    axis: 'y' horizontal sections, outlines in (x, z); 'x' -> (z, y); 'z' -> (x, y).
    step / levels: slice spacing or explicit level values (default: auto_params + plateau feature levels).
    vmedian: half window h of the vertical majority filter: each level's region = (h+1)-of-(2h+1) majority of the
             neighbouring levels' regions (polygon booleans, continuous coords; never across a plateau feature).
    plane_merge: axis-parallel outline edges that line up across adjacent levels (same side, offset within 2 tol,
             overlapping extent) get one common offset (length-weighted median) -> flat vertical faces.
    symmetry: None | 'u' (mirror about a fitted u = c line, applied only if the object is symmetric to 6 %)
              | ('u', c) fixed axis.
    hull: optional shapely polygon bounding every section (default: convex hull of all points in the 2D frame).
    Returns dict(levels=[{'level', 'polygons': [CCW (n,2)], 'observed': fraction of outline on a real section,
                 'method'}], params, mirror).
    """
    iu, iv, il = AXES[axis]
    is_mesh = isinstance(src, trimesh.Trimesh)
    if is_mesh:
        Pm = src.vertices
        ext = Pm.max(0) - Pm.min(0)
    else:
        Pm = np.asarray(src, float); ext = Pm.max(0) - Pm.min(0)
    prm = auto_params(ext)
    if params:
        prm.update(params)
    if step:
        prm['step'] = step
    res, tol, snap = prm['res'], prm['tol'], prm['snap']
    # oriented samples for the inside/outside decision
    if is_mesh:
        SP, SN, sidx, _ = sample_mesh(src, spacing=min(0.01, res), seed=0)
        SW = np.full(len(SP), min(0.01, res) ** 2)
    else:
        SP, SN = Pm, (None if normals is None else np.asarray(normals, float))
        SW = np.full(len(SP), 1.0 / max(len(SP), 1))
    cl = SP[:, il]
    lo_c, hi_c = float(np.percentile(cl, 0.05)), float(np.percentile(cl, 99.95))
    if levels is None:
        feats = detect_plateaus(SP, SN, SW, axis, lo_c, hi_c) if SN is not None else []
        levels = make_levels(lo_c, hi_c, prm['step'], feats)
        prm['features'] = [round(f, 4) for f in feats]
    tree = cKDTree(SP) if SN is not None else None
    uv_all = SP[:, [iu, iv]]
    if hull is None:
        hull = shapely.MultiPoint(uv_all[::max(1, len(uv_all) // 50000)]).convex_hull.buffer(0.5 * res)
    hx0, hz0, hx1, hz1 = hull.bounds
    gu = np.arange(hx0 - 2 * res, hx1 + 2.5 * res, res); gv = np.arange(hz0 - 2 * res, hz1 + 2.5 * res, res)
    GU, GV = np.meshgrid(gu, gv, indexing='ij')
    G2 = np.c_[GU.ravel(), GV.ravel()]
    in_hull = shapely.contains_xy(hull, G2[:, 0], G2[:, 1]).reshape(GU.shape)
    pn = np.zeros(3); pn[il] = 1.0
    out = []
    from skimage import measure
    for lv in levels:
        # ---- inside / outside from the oriented scan surface
        if tree is not None:
            feats = prm.get('features', [])
            near_feat = any(abs(lv - ft) < prm['step'] for ft in feats)
            subs = [lv] if near_feat else [lv - prm['step'] / 3, lv, lv + prm['step'] / 3]
            acc = 0.0
            for sl in subs:
                Q = lift(G2[in_hull.ravel()], sl, axis)
                d, ii = tree.query(Q, k=k, workers=-1)
                s = np.einsum('qkj,qkj->qk', Q[:, None, :] - SP[ii], SN[ii])
                w = 1.0 / (d + 0.01) ** 2
                acc = acc + (w * s).sum(1) / w.sum(1)
            f = np.full(GU.size, 1.0); f[in_hull.ravel()] = acc / len(subs)
            f = f.reshape(GU.shape); f[0, :] = f[-1, :] = f[:, 0] = f[:, -1] = 1.0
            rings = measure.find_contours(f, 0.0)
            polys = []
            for r in rings:
                if len(r) < 4:
                    continue
                xy = np.c_[gu[0] + r[:, 0] * res, gv[0] + r[:, 1] * res]
                p = Polygon(xy)
                if not p.is_valid:
                    p = p.buffer(0)
                polys += _geoms(p)
            region = Polygon()
            for p in sorted(polys, key=lambda p: -p.area):
                region = region.symmetric_difference(p)
            method = 'oriented-field'
        else:
            slab = np.abs(SP[:, il] - lv) < max(prm['step'] / 2, 0.01)
            region = alpha_shape(uv_all[slab], alpha=prm.get('alpha', 0.12))
            method = 'alpha-shape'
        min_area = prm['min_area']
        region = unary_union([Polygon(p.exterior) for p in _geoms(region)])
        r, rc = prm['morph'], prm['close']
        if r > 0 and not region.is_empty:              # opening: drop slivers thinner than 2r
            region = region.buffer(-r, quad_segs=4).buffer(r, quad_segs=4)
        if rc > 0 and not region.is_empty:             # closing: fill crevices narrower than 2rc
            region = region.buffer(rc, quad_segs=4).buffer(-rc, quad_segs=4)
        parts = unary_union([Polygon(p.exterior) for p in _geoms(region) if Polygon(p.exterior).area >= min_area])
        parts = [p for p in _geoms(parts) if p.area >= min_area]
        # ---- exact scan section at this level (snap targets)
        tgt = None
        if is_mesh:
            segs, fidx = trimesh.intersections.mesh_plane(src, pn, pn * lv, return_faces=True)
            if len(segs):
                a2, b2 = segs[:, 0][:, [iu, iv]], segs[:, 1][:, [iu, iv]]
                L = np.linalg.norm(b2 - a2, axis=1); kk = np.maximum(1, np.ceil(L / 0.002).astype(int))
                rep = np.repeat(np.arange(len(segs)), kk)
                t = (np.arange(len(rep)) - np.repeat(np.cumsum(kk) - kk, kk)) / np.repeat(kk, kk)
                tp = a2[rep] + t[:, None] * (b2 - a2)[rep]
                n2 = src.face_normals[fidx[rep]][:, [iu, iv]]
                nl = np.linalg.norm(n2, axis=1); ok = nl > 0.3
                tgt = (tp[ok], n2[ok] / nl[ok, None])
        elif SN is not None:
            slab = np.abs(SP[:, il] - lv) < max(prm['step'] / 2, 0.01)
            n2 = SN[slab][:, [iu, iv]]; nl = np.linalg.norm(n2, axis=1); ok = nl > 0.3
            tgt = (uv_all[slab][ok], n2[ok] / nl[ok, None])
        if tgt is not None and len(tgt[0]) and parts:
            # section points deep inside the cleaned region are crevices / inner surfaces: only allow snapping
            # outwards (up to snap) or inwards by at most snap_in
            reg = unary_union(parts)
            inside = shapely.contains_xy(reg, tgt[0][:, 0], tgt[0][:, 1])
            depth = shapely.distance(reg.boundary, shapely.points(tgt[0]))
            okt = ~inside | (depth <= prm['snap_in'])
            tgt = (tgt[0][okt], tgt[1][okt])
        ttree = cKDTree(tgt[0]) if tgt is not None and len(tgt[0]) else None
        dense, obs = [], []
        for p in parts:
            D = resample_ring(ccw(np.asarray(p.exterior.coords)), res / 2)
            hit = np.zeros(len(D), bool)
            if ttree is not None:
                nr = ring_normals(D)
                dd, jj = ttree.query(D, k=6, distance_upper_bound=snap, workers=-1)
                okc = np.isfinite(dd)
                jj = np.where(okc, jj, 0)
                agree = okc & (np.einsum('nkj,nj->nk', tgt[1][jj], nr) > 0.3)
                first = np.argmax(agree, axis=1); hit = agree.any(1)
                D = np.where(hit[:, None], tgt[0][jj[np.arange(len(D)), first]], D)
            dense.append(D); obs.append(hit)
        out.append(dict(level=float(lv), dense=dense, observed_pts=obs, method=method, _tgt=ttree))
        if verbose:
            print(f'  level {lv:.3f}: {len(dense)} part(s), observed {np.mean(np.concatenate(obs)) if obs else 0:.2f}')
    # ---- vertical 2-of-3 majority (median) of neighbouring levels: removes outline features that exist on a single
    # level only (scan noise, ribbing) and keeps everything that persists over >= 2 levels (incl. plateau steps)
    if vmedian and len(out) >= 3:
        from itertools import combinations
        regs = [unary_union([Polygon(D).buffer(0) for D in L['dense']]) if L['dense'] else Polygon() for L in out]
        h = int(vmedian) if not isinstance(vmedian, bool) else 2      # half window (2 -> 3-of-5 majority)
        feats = prm.get('features', [])
        for i in range(len(out)):
            # window shrinks near the ends and never crosses a plateau feature (steps stay sharp)
            j0, j1 = max(0, i - h), min(len(out) - 1, i + h)
            while j0 < i and any(min(out[j0]['level'], out[i]['level']) < f < max(out[j0]['level'], out[i]['level']) for f in feats):
                j0 += 1
            while j1 > i and any(min(out[j1]['level'], out[i]['level']) < f < max(out[j1]['level'], out[i]['level']) for f in feats):
                j1 -= 1
            w = min(i - j0, j1 - i)
            if w == 0:
                m = regs[i]
            else:
                win = regs[i - w:i + w + 1]; kk = w + 1
                m = unary_union([shapely.intersection_all(list(c)) for c in combinations(win, kk)])
            m = m.buffer(0)
            parts_m = [Polygon(g.exterior) for g in _geoms(m) if Polygon(g.exterior).area >= prm['min_area']]
            out[i]['dense'] = [resample_ring(ccw(np.asarray(g.exterior.coords)), res / 2) for g in parts_m]
    # ---- optional mirror symmetry (about u = c)
    mirror = None
    if symmetry:
        allr = [D for L in out for D in L['dense']]
        if isinstance(symmetry, (tuple, list)):
            c, resid = float(symmetry[1]), None
        else:
            c0 = 0.5 * (min(D[:, 0].min() for D in allr) + max(D[:, 0].max() for D in allr))
            c, resid = fit_mirror([D[::4] for D in allr], c0)
        mirror = dict(axis='u', c=round(c, 4), residual=None if resid is None else round(resid, 4),
                      applied=resid is None or resid < 0.06)
        if mirror['applied']:
            for L in out:
                L['dense'] = [mirror_average(D, c) for D in L['dense']]
    for L in out:
        polys = []
        tt = L.pop('_tgt', None)
        for D in L['dense']:
            ob = (tt.query(D, distance_upper_bound=0.004)[0] < 0.004) if tt is not None else None
            if ob is not None and len(ob) >= 5:                  # fill single-point gaps in the observed flags
                ob = ob | ndimage.binary_closing(ob, np.ones(3))
            q = finalize_ring(D, tol, regularize=regularize, obs=ob, tol_unobs=prm.get('tol_unobs', 3 * tol))
            if q is not None and abs(signed_area(q)) >= 4e-4:
                polys.append(q)
        L['polygons'] = polys
        ob = np.concatenate(L.pop('observed_pts')) if L['dense'] else np.zeros(0)
        L['observed'] = round(float(ob.mean()), 3) if len(ob) else 0.0
    if plane_merge:
        merge_axis_edges(out, tol=2 * tol, min_len=0.03)
    # ---- ground contact: extend the lowest outline down to the object floor (level 0)
    if ground is None:
        ground = axis == 'y' and out and out[0]['level'] < 0.08
    if ground and out and out[0]['polygons']:
        out.insert(0, dict(level=0.0, polygons=[p.copy() for p in out[0]['polygons']], dense=[],
                           observed=0.0, method='ground-extension'))
    return dict(levels=out, params=prm, mirror=mirror, axis=axis)


def merge_axis_edges(levels, tol=0.02, min_len=0.03, min_group=3):
    """Cross-level regularisation: exactly axis-parallel polygon edges (from finalize_ring) at adjacent levels that
    describe the same vertical face (same axis and outward side, offsets within tol, overlapping extents) are moved
    to one common offset (length-weighted median of the group). Edits levels[i]['polygons'] in place."""
    E = []                                                  # (level idx, poly idx, edge idx, axis, side, off, lo, hi, L)
    for li, L in enumerate(levels):
        for pi, P in enumerate(L['polygons']):
            Q = np.roll(P, -1, 0)
            for ei in range(len(P)):
                d = Q[ei] - P[ei]; ln = float(np.hypot(d[0], d[1]))
                if ln < min_len:
                    continue
                if abs(d[0]) < 1e-12:                       # u = const edge, outward normal (d_v, -d_u) -> sign(d_v)
                    E.append((li, pi, ei, 0, np.sign(d[1]), P[ei, 0], min(P[ei, 1], Q[ei, 1]), max(P[ei, 1], Q[ei, 1]), ln))
                elif abs(d[1]) < 1e-12:                     # v = const edge, outward normal sign = -sign(d_u)
                    E.append((li, pi, ei, 1, -np.sign(d[0]), P[ei, 1], min(P[ei, 0], Q[ei, 0]), max(P[ei, 0], Q[ei, 0]), ln))
    if not E:
        return 0
    parent = list(range(len(E)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    by_level = {}
    for k, e in enumerate(E):
        by_level.setdefault(e[0], []).append(k)
    for k, e in enumerate(E):
        for k2 in by_level.get(e[0] + 1, []):
            f = E[k2]
            if f[3] == e[3] and f[4] == e[4] and abs(f[5] - e[5]) < tol and min(e[7], f[7]) - max(e[6], f[6]) > 0.5 * min_len:
                parent[find(k)] = find(k2)
    groups = {}
    for k in range(len(E)):
        groups.setdefault(find(k), []).append(k)
    moved = 0
    for g in groups.values():
        if len({E[k][0] for k in g}) < min_group:
            continue
        offs = np.array([E[k][5] for k in g]); wts = np.array([E[k][8] for k in g])
        o = np.argsort(offs); cw = np.cumsum(wts[o]); med = offs[o][np.searchsorted(cw, 0.5 * cw[-1])]
        for k in g:
            li, pi, ei, ax = E[k][:4]
            P = levels[li]['polygons'][pi]
            P[ei, ax] = med; P[(ei + 1) % len(P), ax] = med
            moved += 1
    for L in levels:                                        # drop polygons that became invalid
        L['polygons'] = [P for P in L['polygons'] if Polygon(P).is_valid and abs(signed_area(P)) > 1e-6]
    return moved


# ===================================================================== 3. loft
def _ring_params(P):
    Q = np.r_[P, P[:1]]; seg = np.linalg.norm(np.diff(Q, axis=0), axis=1)
    cum = np.r_[0, np.cumsum(seg)]
    return cum[:-1] / cum[-1], cum[-1]


def _eval_ring(P, fr, t):
    """Point at arc fraction t of ring P (vertex fractions fr); exact vertices where t hits fr."""
    n = len(P); t = np.mod(t, 1.0)
    i = np.searchsorted(fr, t, side='right') - 1
    j = (i + 1) % n
    fj = np.where(j == 0, 1.0, fr[j])
    w = (t - fr[i]) / np.maximum(fj - fr[i], 1e-15)
    out = P[i] * (1 - w[:, None]) + P[j] * w[:, None]
    exact = np.abs(t - fr[i]) < 1e-12
    out[exact] = P[i[exact]]
    return out


def _dtw_path(D):
    """Monotone minimum-cost path through cost matrix D from (0, 0) to (n-1, m-1) (dynamic time warping)."""
    n, m = D.shape
    R = np.full((n + 1, m + 1), np.inf); R[0, 0] = 0.0
    Rl, Dl = R.tolist(), D.tolist()
    for i in range(1, n + 1):
        Ri, Rp, Di = Rl[i], Rl[i - 1], Dl[i - 1]
        for j in range(1, m + 1):
            a, b, c = Rp[j - 1], Rp[j], Ri[j - 1]
            Ri[j] = Di[j - 1] + (a if (a <= b and a <= c) else (b if b <= c else c))
    i, j = n, m; path = [(n - 1, m - 1)]
    while i > 1 or j > 1:
        _, i, j = min((Rl[i - 1][j - 1], i - 1, j - 1), (Rl[i - 1][j], i - 1, j), (Rl[i][j - 1], i, j - 1))
        path.append((i - 1, j - 1))
    return np.array(path[::-1])


def band_correspondence(A, B, n_align=160):
    """Corresponding point lists (PA, PB) for a band between CCW rings A (lower) and B (upper).
    Start offset: best cyclic alignment (FFT); then a monotone DTW map between the two arc-length parameterisations
    (robust when one ring gains / loses a notch); every vertex of A and of B is kept exactly."""
    fa, _ = _ring_params(A); fb, _ = _ring_params(B)
    n = n_align
    Au, Bu = uniform_ring(A, n), uniform_ring(B, n)
    k = _match_shift(Au, Bu)                              # A_i <-> B_{i+k}
    Bs = np.roll(Bu, -k, 0)
    Ac, Bc = np.r_[Au, Au[:1]], np.r_[Bs, Bs[:1]]         # closed: index n == index 0
    D = np.linalg.norm(Ac[:, None, :] - Bc[None, :, :], axis=2)
    path = _dtw_path(D)
    ta = path[:, 0] / n; tb = (path[:, 1] + k) / n         # monotone, tb unwrapped in [k/n, 1 + k/n]
    ua, ia = np.unique(ta, return_inverse=True)
    tb_a = np.bincount(ia, tb) / np.bincount(ia)           # mean B fraction per A sample
    ub, ib = np.unique(tb, return_inverse=True)
    ta_b = np.bincount(ib, ta) / np.bincount(ib)
    d0 = k / n
    fbu = np.where(fb < d0, fb + 1.0, fb)                  # B vertex fractions on the unwrapped axis
    TA = np.r_[fa, np.interp(fbu, ub, ta_b)]
    TB = np.r_[np.interp(fa, ua, tb_a), fbu]
    o = np.lexsort((TB, TA)); TA, TB = TA[o], TB[o]
    TB = np.maximum.accumulate(TB)
    keep = np.r_[True, (np.diff(TA) > 1e-12) | (np.diff(TB) > 1e-12)]
    TA, TB = TA[keep], TB[keep]
    PA = _eval_ring(A, fa, TA)                             # exact A vertices where TA hits fa
    PB = _eval_ring(B, fb, np.mod(TB, 1.0))                # exact B vertices where TB hits fb
    return PA, PB


def _cdt(poly):
    """Constrained Delaunay triangles of a shapely (Multi)Polygon with holes -> (n,3,2)."""
    out = []
    for g in _geoms(poly):
        if g.area < 1e-8:
            continue
        tris = shapely.constrained_delaunay_triangles(g)
        for t in getattr(tris, 'geoms', []):
            c = np.asarray(t.exterior.coords)[:3]
            out.append(c)
    return np.array(out).reshape(-1, 3, 2)


def _cap_tris(tri2, level, up):
    """2D triangles -> 3D triangles at `level`, facing +level (up=True) or -level."""
    a = tri2[:, 1] - tri2[:, 0]; b = tri2[:, 2] - tri2[:, 0]
    ar = a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]
    # in the canonical (u, level, v) frame a CCW (u, v) triangle faces -level
    flip = (ar > 0) == up
    tri2 = np.where(flip[:, None, None], tri2[:, ::-1], tri2)
    return tri2, level


def band_folds(PA, PB, A, B, eps=1e-3, min_len=0.02):
    """True if the ruled band between corresponding points folds over itself: a ruling (PA_k -> PB_k, projected on
    the section plane) longer than min_len crosses another ruling or the interior of ring A or B (shorter creases
    are harmless and ignored)."""
    L = np.linalg.norm(PB - PA, axis=1)
    idx = np.nonzero(L > eps)[0]
    if len(idx) == 0:
        return False
    longr = L[idx] > min_len
    if len(idx) == 0:
        return False
    dv = (PB - PA)[idx]; tr = np.minimum(0.05, 5e-4 / L[idx])[:, None]   # trim the ends: endpoints lie on the rings
    rul = shapely.linestrings(np.stack([PA[idx] + tr * dv, PB[idx] - tr * dv], 1))
    tree = shapely.STRtree(rul)
    pairs = tree.query(rul, predicate='crosses')
    if pairs.shape[1] > 0 and (longr[pairs[0]] | longr[pairs[1]]).any():
        return True
    for R in (A, B):
        ring = shapely.LinearRing(R)
        if (shapely.crosses(rul, ring) & longr).any():
            return True
    return False


def hausdorff(A, B):
    return Polygon(A).exterior.hausdorff_distance(Polygon(B).exterior)


def loft(sections, axis='y', max_slope_deg=75.0, caps=True, return_info=False):
    """Loft primitive -> trimesh (in the object-local frame). sections: [{level-key or 'level': v, 'outline': [[u, v]..]}]
    with ascending levels; the level key is the axis name ('y' for horizontal sections)."""
    key = axis
    secs = []
    for s in sections:
        lv = float(s[key] if key in s else s['level'])
        P = dedupe(ccw(np.asarray(s['outline'], float)))
        if len(P) >= 3:
            secs.append((lv, P, bool(s.get('step', False))))
    secs.sort(key=lambda t: t[0])
    tris = []                                             # canonical (u, level, v) triangles
    info = dict(bands=0, steps=0)

    def C(P2, lv):
        return np.c_[P2[:, 0], np.full(len(P2), lv), P2[:, 1]]

    def side(PA, la, PB, lb):
        A3, B3 = C(PA, la), C(PB, lb)
        A1, B1 = np.roll(A3, -1, 0), np.roll(B3, -1, 0)
        tris.append(np.stack([A3, B3, B1], 1)); tris.append(np.stack([A3, B1, A1], 1))

    def cap(poly, lv, up):
        t2 = _cdt(poly)
        if len(t2):
            t2, _ = _cap_tris(t2, lv, up)
            tris.append(np.stack([C(t2[:, 0], lv), C(t2[:, 1], lv), C(t2[:, 2], lv)], 1))

    tanm = np.tan(np.radians(max_slope_deg))
    for (la, A, _), (lb, B, force_step) in zip(secs[:-1], secs[1:]):
        dy = lb - la
        PA, PB = band_correspondence(A, B)
        disp = np.linalg.norm(PA - PB, axis=1)
        gentle = np.percentile(disp, 90) <= max(dy * tanm, 0.004)   # most of the ring moves less than the max slope
        if not force_step and (gentle or not band_folds(PA, PB, A, B)):
            side(PA, la, PB, lb); info['bands'] += 1
        else:
            lm = 0.5 * (la + lb)
            side(A, la, A, lm); side(B, lm, B, lb)
            pa, pb = Polygon(A).buffer(0), Polygon(B).buffer(0)
            cap(pa.difference(pb), lm, True); cap(pb.difference(pa), lm, False)
            info['steps'] += 1
    if caps and secs:
        cap(Polygon(secs[0][1]).buffer(0), secs[0][0], False)
        cap(Polygon(secs[-1][1]).buffer(0), secs[-1][0], True)
    T = np.concatenate(tris).reshape(-1, 3, 3)
    iu, iv, il = AXES[axis]
    W = np.zeros_like(T); W[..., iu] = T[..., 0]; W[..., il] = T[..., 1]; W[..., iv] = T[..., 2]
    if axis == 'z':                                       # odd permutation of the canonical frame
        W = W[:, ::-1]
    m = trimesh.Trimesh(W.reshape(-1, 3), np.arange(len(W) * 3).reshape(-1, 3), process=False)
    m.merge_vertices(digits_vertex=9)
    m.update_faces(m.nondegenerate_faces(height=1e-9)); m.remove_unreferenced_vertices()
    if m.volume < 0:
        m.invert()
    if return_info:
        info.update(faces=int(len(m.faces)), volume=float(m.volume))
        return m, info
    return m


def lofts_from_levels(res, min_overlap=0.25, name='body', max_slope_deg=75.0, ndigits=5, min_levels=3,
                      min_rel_area=0.05):
    """Chain per-level polygons into loft tracks (largest-overlap matching, splits / merges start / end tracks; a
    track that starts or ends between levels is extended to the mid height so pieces meet). -> list of loft parts."""
    axis = res['axis'] if isinstance(res, dict) else 'y'
    levels = res['levels'] if isinstance(res, dict) else res
    tracks, active = [], []                               # active: [(track index, Polygon)]
    for li, L in enumerate(levels):
        cur = [Polygon(p).buffer(0) for p in L['polygons']]
        pairs = []
        for ci, pc in enumerate(cur):
            for ai, (ti, pa) in enumerate(active):
                inter = pc.intersection(pa).area
                if inter > 0 and inter / max(min(pc.area, pa.area), 1e-12) >= min_overlap:
                    pairs.append((inter / max(pc.area, pa.area, 1e-12), ci, ai))   # rank by IoU-like score
        pairs.sort(reverse=True)
        used_c, used_a, nxt = set(), set(), []
        # significant partners only (>= min_rel_area of the polygon they split from / merge into)
        n_partner_c = np.zeros(len(cur), int); n_partner_a = np.zeros(len(active), int)
        for _, ci, ai in pairs:
            if active[ai][1].area >= min_rel_area * cur[ci].area:
                n_partner_c[ci] += 1
            if cur[ci].area >= min_rel_area * active[ai][1].area:
                n_partner_a[ai] += 1
        for _, ci, ai in pairs:
            if ci in used_c or ai in used_a:
                continue
            ti = active[ai][0]
            split = n_partner_c[ci] > 1 or n_partner_a[ai] > 1          # merge / split at this level -> step
            tracks[ti].append((L['level'], L['polygons'][ci], split)); used_c.add(ci); used_a.add(ai)
            nxt.append((ti, cur[ci]))
        prev_lv = levels[li - 1]['level'] if li else None
        for ai, (ti, pa) in enumerate(active):            # ended tracks: extend up to the mid height
            if ai not in used_a and prev_lv is not None:
                tracks[ti].append((0.5 * (prev_lv + L['level']), tracks[ti][-1][1], False))
        for ci, pc in enumerate(cur):
            if ci in used_c:
                continue
            tr = []
            if prev_lv is not None:
                tr.append((0.5 * (prev_lv + L['level']), L['polygons'][ci], False))
            tr.append((L['level'], L['polygons'][ci], False)); tracks.append(tr); nxt.append((len(tracks) - 1, pc))
        active = nxt
    # drop short tracks of small outlines (field noise next to the object); keep short but large ones (cushion domes)
    big = max((abs(signed_area(p)) for L in levels for p in L['polygons']), default=0.0)
    keep_tr = []
    for tr in tracks:
        n_real = len({round(t[0], 6) for t in tr} & {round(L['level'], 6) for L in levels})
        amax = max(abs(signed_area(t[1])) for t in tr)
        if len(tr) >= 2 and (n_real >= min_levels or amax >= min_rel_area * big):
            keep_tr.append(tr)
    tracks = keep_tr
    parts = []
    for i, tr in enumerate(tracks):
        if len(tr) < 2:
            continue
        parts.append(dict(type='loft', name=f'{name}' if len(tracks) == 1 else f'{name}_{i}', axis=axis,
                          max_slope_deg=max_slope_deg,
                          sections=[dict({axis: round(float(lv), ndigits),
                                          'outline': np.round(np.asarray(p, float), ndigits).tolist()},
                                         **({'step': True} if st else {})) for lv, p, st in tr]))
    return parts


# ===================================================================== 4. texture transfer
def _face_labels(n_local):
    ax = np.argmax(np.abs(n_local), axis=1)
    sg = np.take_along_axis(n_local, ax[:, None], 1)[:, 0] > 0
    return ax * 2 + (~sg)                                  # 0:+x 1:-x 2:+y 3:-y 4:+z 5:-z


PROJ = {0: (2, 1), 1: (2, 1), 2: (0, 2), 3: (0, 2), 4: (0, 1), 5: (0, 1)}


def _raster_tri(t2):
    """Pixel centres (ix, iy) inside a 2D triangle given in pixel units."""
    x0, y0 = np.floor(t2.min(0)).astype(int); x1, y1 = np.ceil(t2.max(0)).astype(int)
    xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1), indexing='ij')
    px = xs.ravel() + 0.5; py = ys.ravel() + 0.5
    (ax, ay), (bx, by), (cx, cy) = t2
    den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if abs(den) < 1e-12:
        return np.zeros((0, 2), int), np.zeros((0, 3))
    l0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den
    l1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den
    l2 = 1 - l0 - l1
    ins = (l0 >= -1e-9) & (l1 >= -1e-9) & (l2 >= -1e-9)
    return np.c_[xs.ravel()[ins], ys.ravel()[ins]], np.c_[l0, l1, l2][ins]


def make_charts(mesh, frame_R=None, texel=0.005, overlap_px=1):
    """Box-projection charts: faces grouped by dominant local axis, grown over shared vertices, a face joins a chart
    only if its texels do not overlap the chart's (no fold-overs). Returns per-face chart id, chart list, 2D coords."""
    R = np.eye(3) if frame_R is None else np.asarray(frame_R, float)
    nl = mesh.face_normals @ R
    lab = _face_labels(nl)
    VL = mesh.vertices @ R
    F = mesh.faces
    # vertex -> faces
    vf = [[] for _ in range(len(mesh.vertices))]
    for fi, f in enumerate(F):
        for v in f:
            vf[v].append(fi)
    t2 = np.zeros((len(F), 3, 2))
    pix = []
    for fi, f in enumerate(F):
        a, b = PROJ[int(lab[fi])]
        t2[fi] = VL[f][:, [a, b]] / texel
        ij, _ = _raster_tri(t2[fi])
        pix.append(set((ij[:, 0] * 1000003 + ij[:, 1]).tolist()))
    chart = np.full(len(F), -1); charts = []
    for seed in range(len(F)):
        if chart[seed] >= 0:
            continue
        cid = len(charts); chart[seed] = cid; occ = set(pix[seed]); q = [seed]; members = [seed]
        while q:
            f = q.pop()
            for v in F[f]:
                for g in vf[v]:
                    if chart[g] >= 0 or lab[g] != lab[seed]:
                        continue
                    if len(occ & pix[g]) > overlap_px:
                        continue
                    chart[g] = cid; occ |= pix[g]; q.append(g); members.append(g)
        charts.append(dict(label=int(lab[seed]), faces=np.array(members)))
    return chart, charts, t2


def pack_charts(charts, t2, gutter=2):
    """Shelf packing of chart bounding boxes (pixel units). Sets chart['offset'] (pixel shift) -> atlas (W, H)."""
    boxes = []
    for c in charts:
        p = t2[c['faces']].reshape(-1, 2)
        mn = np.floor(p.min(0)) - gutter; mx = np.ceil(p.max(0)) + gutter
        c['min'] = mn; c['size'] = (mx - mn).astype(int)
        boxes.append(c['size'])
    area = sum(int(s[0]) * int(s[1]) for s in boxes)
    W = int(max(max(int(s[0]) for s in boxes), np.ceil(np.sqrt(area * 1.15))))
    W = int(np.ceil(W / 4) * 4)
    order = sorted(range(len(charts)), key=lambda i: -charts[i]['size'][1])
    x = y = rowh = 0
    for i in order:
        w, h = charts[i]['size']
        if x + w > W:
            x = 0; y += rowh; rowh = 0
        charts[i]['offset'] = np.array([x, y], float) - charts[i]['min']
        x += w; rowh = max(rowh, h)
    H = int(np.ceil((y + rowh) / 4) * 4)
    return W, H


def _bilinear(tex, uv):
    H, W = tex.shape[:2]
    x = uv[:, 0] * W - 0.5; y = uv[:, 1] * H - 0.5
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int); fx = (x - x0)[:, None]; fy = (y - y0)[:, None]
    x0c, x1c = np.clip(x0, 0, W - 1), np.clip(x0 + 1, 0, W - 1); y0c, y1c = np.clip(y0, 0, H - 1), np.clip(y0 + 1, 0, H - 1)
    t = tex.astype(np.float32)
    return (t[y0c, x0c] * (1 - fx) * (1 - fy) + t[y0c, x1c] * fx * (1 - fy) + t[y1c, x0c] * (1 - fx) * fy + t[y1c, x1c] * fx * fy)


def transfer_texture(new_mesh, scan=None, frame_R=None, texel=None, max_dist=0.02, normal_min=0.5, gutter=2,
                     scan_spacing=0.004, verbose=False, bottom_band=0.02):
    """Give new_mesh (WORLD coordinates) an atlas UV layout and bake its texture from the original scan texture.

    scan: object_mesh() result (its face_ids index the original scan) or None (scan faces near new_mesh's bbox).
    frame_R: world->local rotation for the box projection (e.g. Ry(yaw)); texel: metres per texel (default from size).
    For every texel: 3D point on new_mesh -> up to 12 nearest dense scan samples within max_dist whose normal agrees
    (dot > normal_min) -> exact closest point on the first such scan triangle -> barycentric UV -> bilinear sample.
    Returns (textured trimesh (vertices split per chart), PIL image, info)."""
    t0 = time.time()
    S = scene()
    if texel is None:
        texel = auto_params(new_mesh.extents)['texel']
    if scan is None:
        lo, hi = new_mesh.bounds[0] - max_dist, new_mesh.bounds[1] + max_dist
        fids = np.nonzero(np.all((S['FC'] >= lo) & (S['FC'] <= hi), axis=1))[0]
    else:
        fids = np.asarray(scan['face_ids'])
    smesh = trimesh.Trimesh(S['V'], S['F'][fids], process=False)
    SP, SNn, sidx, _ = sample_mesh(smesh, scan_spacing, seed=5)
    tree = cKDTree(SP)
    chart, charts, t2 = make_charts(new_mesh, frame_R, texel)
    W, H = pack_charts(charts, t2, gutter)
    # per-face pixel coords in the atlas
    off = np.zeros((len(new_mesh.faces), 2))
    for ci, c in enumerate(charts):
        off[c['faces']] = c['offset']
    A2 = t2 + off[:, None, :]
    # rasterise all faces -> texel list with 3D position and face normal
    PIX, P3, FN = [], [], []
    tri3 = new_mesh.triangles; fn = new_mesh.face_normals
    for fi in range(len(new_mesh.faces)):
        ij, bc = _raster_tri(A2[fi])
        if len(ij) == 0:
            continue
        PIX.append(ij); P3.append(bc @ tri3[fi]); FN.append(np.repeat(fn[fi][None], len(ij), 0))
    PIX = np.concatenate(PIX); P3 = np.concatenate(P3); FN = np.concatenate(FN)
    ok_px = (PIX[:, 0] >= 0) & (PIX[:, 0] < W) & (PIX[:, 1] >= 0) & (PIX[:, 1] < H)
    PIX, P3, FN = PIX[ok_px], P3[ok_px], FN[ok_px]
    d, ii = tree.query(P3, k=12, distance_upper_bound=max_dist, workers=-1)
    fin = np.isfinite(d); ii = np.where(fin, ii, 0)
    agree = fin & (np.einsum('nkj,nj->nk', SNn[ii], FN) > normal_min)
    first = np.argmax(agree, axis=1); has = agree.any(1)
    cand = sidx[ii[np.arange(len(P3)), first]]           # face index local to smesh
    gface = fids[cand]
    tri = S['V'][S['F'][gface]]
    cp = trimesh.triangles.closest_point(tri[has], P3[has])
    bc = trimesh.triangles.points_to_barycentric(tri[has], cp)
    bc = np.clip(bc, 0, 1); bc /= bc.sum(1, keepdims=True)
    uvs = np.einsum('ni,nij->nj', bc, S['UV'][S['F'][gface[has]]])
    col = np.zeros((len(P3), 3), np.float32)
    col[has] = _bilinear(S['tex'], uvs)
    # round-3 rule: texels without a normal-compatible scan source within max_dist (2 cm), downward faces and the
    # bottom band take the part's material colour (median of its observed texels); no nearest-texel extrapolation
    down = (FN[:, 1] < -0.5) | (P3[:, 1] < new_mesh.bounds[0][1] + bottom_band)
    src = has & ~down
    part_rgb = np.median(col[src], axis=0) if src.sum() >= 10 else (np.median(col[has], axis=0) if has.any() else np.full(3, 180.0))
    col[~src] = part_rgb
    img = np.zeros((H, W, 3), np.float32); msk = np.zeros((H, W), bool)
    img[PIX[:, 1], PIX[:, 0]] = col; msk[PIX[:, 1], PIX[:, 0]] = True
    # gutter dilation: every empty texel takes the colour of the nearest covered texel
    if (~msk).any():
        _, (iy, ix) = ndimage.distance_transform_edt(~msk, return_indices=True)
        img = img[iy, ix]
    image = Image.fromarray(np.clip(np.round(img), 0, 255).astype(np.uint8))
    # split vertices per chart and write UVs (trimesh convention: v from the bottom)
    key = chart[:, None] * len(new_mesh.vertices) + new_mesh.faces
    uniq, inv = np.unique(key.ravel(), return_inverse=True)
    NV = new_mesh.vertices[uniq % len(new_mesh.vertices)]
    NF = inv.reshape(-1, 3)
    UVp = np.zeros((len(uniq), 2)); UVp[NF.ravel()] = A2.reshape(-1, 2)
    UVt = np.c_[UVp[:, 0] / W, 1.0 - UVp[:, 1] / H]
    mat = trimesh.visual.material.PBRMaterial(baseColorTexture=image, baseColorFactor=[255, 255, 255, 255],
                                              metallicFactor=0.0, roughnessFactor=1.0, doubleSided=False)
    out = trimesh.Trimesh(NV, NF, visual=trimesh.visual.TextureVisuals(uv=UVt, material=mat), process=False)
    info = dict(texel_m=round(float(texel), 4), atlas=[W, H], charts=len(charts), texels=int(len(P3)),
                observed_fraction=round(float(src.mean()), 3), scan_faces=int(len(fids)),
                part_rgb=[int(round(v)) for v in part_rgb],
                seconds=round(time.time() - t0, 1))
    if verbose:
        print('  transfer_texture', info)
    return out, image, info


# ===================================================================== primitives / export
def loft_part_mesh(p):
    m = loft(p['sections'], axis=p.get('axis', 'y'), max_slope_deg=p.get('max_slope_deg', 75.0))
    col = np.array(p.get('color_rgb', [200, 200, 200]), float)
    return m, np.repeat(col[None], len(m.faces), 0)


def part_mesh(p):
    if p['type'] == 'loft':
        return loft_part_mesh(p)
    from prims import part_mesh as pm
    return pm(p)


def shaded(mesh, rgb=(205, 200, 190)):
    """Unindexed copy with flat per-face vertex colours (simple directional shading) for the unlit viewer."""
    L = np.array([-0.45, 0.75, -0.5]); L /= np.linalg.norm(L)
    k = 0.5 + 0.5 * np.clip(mesh.face_normals @ L, 0, 1)
    tri = mesh.triangles.reshape(-1, 3)
    col = np.repeat(np.clip(np.array(rgb, float)[None] * k[:, None], 0, 255), 3, 0)
    C = np.c_[np.round(col).astype(np.uint8), np.full(len(col), 255, np.uint8)]
    return trimesh.Trimesh(tri, np.arange(len(tri)).reshape(-1, 3), vertex_colors=C, process=False)


def textured_copy(m, img, name, uv):
    b = io.BytesIO(); img.convert('RGB').save(b, format='JPEG', quality=92); b.seek(0)
    im = Image.open(b); im.load()
    mat = trimesh.visual.material.PBRMaterial(name=name, baseColorTexture=im, baseColorFactor=[255, 255, 255, 255],
                                              metallicFactor=0.0, roughnessFactor=1.0, doubleSided=False)
    return trimesh.Trimesh(m.vertices, m.faces, visual=trimesh.visual.TextureVisuals(uv=uv, material=mat), process=False)


def export_glb(path, items):
    """items: [(name, trimesh)]; textured meshes are re-encoded as JPEG."""
    sc = trimesh.Scene()
    for name, m in items:
        if isinstance(m.visual, trimesh.visual.TextureVisuals) and m.visual.material is not None:
            img = getattr(m.visual.material, 'baseColorTexture', None)
            if img is not None:
                m = textured_copy(m, img, name, m.visual.uv)
        sc.add_geometry(m, geom_name=name, node_name=name)
    sc.export(path)
    return os.path.getsize(path)


# ===================================================================== metrics
def surface_distance(P, mesh):
    """Exact distance (m) from points P to the closest point of mesh."""
    _, d, _ = trimesh.proximity.closest_point(mesh, P)
    return d


def fit_report(scan_mesh, model, spacing=0.01, seed=11):
    """mean / p50 / p90 (cm) of scan->model (does the model cover the scanned surface) and model->scan."""
    P, _, _, _ = sample_mesh(scan_mesh, spacing, seed=seed)
    d1 = surface_distance(P, model) * 100
    Q, _, _, _ = sample_mesh(model, spacing, seed=seed + 1)
    d2 = surface_distance(Q, scan_mesh) * 100
    f = lambda d: dict(mean_cm=round(float(d.mean()), 2), p50_cm=round(float(np.median(d)), 2),
                       p90_cm=round(float(np.percentile(d, 90)), 2), within_1cm_pct=round(float((d <= 1).mean() * 100), 1),
                       within_2cm_pct=round(float((d <= 2).mean() * 100), 1), n=int(len(d)))
    return dict(scan_to_model=f(d1), model_to_scan=f(d2))
