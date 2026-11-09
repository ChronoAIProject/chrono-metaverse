"""Chair helpers (round 3): scan extraction around the meeting table, canonical chair frame, sampling with colour.

Canonical chair frame: origin on the local floor below the swivel axis, y up, the chair FACES +z (seat front at +z,
backrest at -z). world = Ry(yaw) * local + position (prims.py / contour.py convention).
"""
import os, sys, json
import numpy as np
import trimesh
import shapely
from shapely.geometry import Polygon
from scipy.spatial import cKDTree
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import contour as C   # noqa: E402

OUTD = os.path.join(C.OUT, 'r3')
Ry = C.Ry


def objects():
    return json.load(open(os.path.join(C.OUT, 'objects.json')))


def table_geometry(objs=None):
    """Table top outline / pedestal outline (world x, z) from objects.json and the measured heights (above floor)."""
    objs = objs or objects()
    t = next(o for o in objs if o['id'] == 'table-01')
    tp = np.array(t['transform']['position'])
    top = next(p for p in t['parts'] if p['name'] == 'top_slab'); ped = next(p for p in t['parts'] if p['name'] == 'pedestal')
    return dict(top=Polygon(np.array(top['polygon']) + tp[[0, 2]]), ped=Polygon(np.array(ped['polygon']) + tp[[0, 2]]),
                pos=tp)


def local_floor(x, z, r0=0.35, r1=1.0):
    """Floor height at (x, z): median height of up-facing scan faces near the floor in a ring r0..r1 around it
    (more local than the 0.5 m floor_map; scan floor drifts by several cm across the room)."""
    S = C.scene(); FC, FN = S['FC'], S['FN']
    d = np.hypot(FC[:, 0] - x, FC[:, 2] - z)
    g = float(C.floor_height(x, z)[0])
    m = (d > r0) & (d < r1) & (FN[:, 1] > 0.95) & (np.abs(FC[:, 1] - g) < 0.06)
    if m.sum() < 20:
        return g, int(m.sum())
    # plane fit y = a x + b z + c (robust: 2 passes)
    A = np.c_[FC[m, 0] - x, FC[m, 2] - z, np.ones(m.sum())]; y = FC[m, 1]
    w = np.ones(len(y))
    for _ in range(3):
        coef = np.linalg.lstsq(A * w[:, None], y * w, rcond=None)[0]
        r = y - A @ coef; s = 1.4826 * np.median(np.abs(r)) + 1e-4
        w = (np.abs(r) < 2.5 * s).astype(float)
    return float(coef[2]), int(m.sum())


def region_faces(centres, radius=0.55, hmax=1.3, floor_clear=0.015, floors=None, table=None, top_h=0.71,
                 top_buf=0.08, ped_buf=0.07, floor_band=0.045, curtain=True, under_h=0.68):
    """Scan face ids per chair: within `radius` (x-z) of the chair centre, nearest chair centre (Voronoi split),
    above the chair's floor + floor_clear, below hmax, minus the table top slab (inside the top outline + top_buf and
    higher than top_h above the floor) and the pedestal (inside its outline + ped_buf)."""
    S = C.scene(); FC = S['FC']
    cen = np.asarray(centres, float)
    lo, hi = cen.min(0) - radius, cen.max(0) + radius
    sel = np.nonzero((FC[:, 0] > lo[0]) & (FC[:, 0] < hi[0]) & (FC[:, 2] > lo[1]) & (FC[:, 2] < hi[1]) & (FC[:, 1] < 2.0))[0]
    c = FC[sel]
    d2 = ((c[:, None, [0, 2]] - cen[None]) ** 2).sum(-1)
    nn = np.argmin(d2, 1); dn = np.sqrt(d2[np.arange(len(c)), nn])
    fl = np.asarray(floors, float)[nn] if floors is not None else C.floor_height(c[:, 0], c[:, 2])
    h = c[:, 1] - fl
    keep = (dn < radius) & (h > floor_clear) & (h < hmax)
    keep &= ~((h < floor_band) & (S['FN'][sel, 1] > 0.7))        # up-facing floor patches (scan floor drifts)
    if table is not None:
        intop = shapely.contains_xy(table['top'].buffer(top_buf), c[:, 0], c[:, 2])
        inped = shapely.contains_xy(table['ped'].buffer(ped_buf), c[:, 0], c[:, 2])
        keep &= ~(intop & (h > top_h)) & ~inped
        if curtain:
            # scan 'curtains' hanging from the table edge onto the tucked chairs: near-vertical faces within 6 cm of
            # the top outline, above seat height, facing away from the table; and anything right under the slab
            nb = shapely.distance(table['top'].boundary, shapely.points(c[:, [0, 2]]))
            inside = shapely.contains_xy(table['top'], c[:, 0], c[:, 2])
            # outward direction of the outline at the face: from the nearest boundary point
            q = shapely.get_coordinates(shapely.shortest_line(table['top'].boundary, shapely.points(c[:, [0, 2]])))
            q = q.reshape(-1, 2, 2); ov = q[:, 1] - q[:, 0]; ov /= np.maximum(np.linalg.norm(ov, axis=1, keepdims=True), 1e-9)
            ov = np.where(inside[:, None], -ov, ov)                   # unit outward normal of the table edge
            n = S['FN'][sel]
            out_f = (n[:, 0] * ov[:, 0] + n[:, 2] * ov[:, 1]) > 0.3
            cur = (nb < 0.06) & (h > 0.45) & (np.abs(n[:, 1]) < 0.7) & out_f
            keep &= ~cur & ~(inside & (h > under_h))
    return [sel[keep & (nn == i)] for i in range(len(cen))]


def sample_faces(fids, spacing=0.004, seed=0):
    """Area-uniform samples on scan faces: points, unit face normals, sRGB colours (texture, bilinear-free nearest),
    source face id."""
    S = C.scene(); V, F, UV, tex = S['V'], S['F'], S['UV'], S['tex']
    H, W = tex.shape[:2]
    rng = np.random.default_rng(seed)
    a = S['FA'][fids]
    cnt = rng.poisson(a / spacing ** 2); k = np.repeat(np.arange(len(fids)), cnt)
    r1, r2 = rng.random(len(k)), rng.random(len(k)); s = np.sqrt(r1)
    w = np.c_[1 - s, s * (1 - r2), s * r2]
    f = F[fids[k]]
    P = np.einsum('ni,nij->nj', w, V[f])
    T = np.einsum('ni,nij->nj', w, UV[f])
    col = tex[np.clip((T[:, 1] * H).astype(int), 0, H - 1), np.clip((T[:, 0] * W).astype(int), 0, W - 1)]
    return P, S['FN'][fids[k]], col, fids[k]


def to_canon(P, pos, yaw):
    return (np.asarray(P, float) - np.asarray(pos, float)) @ Ry(yaw)


def to_world(L, pos, yaw):
    return np.asarray(L, float) @ Ry(yaw).T + np.asarray(pos, float)


def Rx(deg):
    a = np.radians(deg); c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def luminance(col):
    c = np.asarray(col, float)
    return 0.2126 * c[..., 0] + 0.7152 * c[..., 1] + 0.0722 * c[..., 2]


def bright_color(col, lo=80, hi=90):
    """Measured part colour: mean of the samples in the lo..hi luminance percentile band (bright side, not median:
    the scan bakes shading / occlusion darkening into the texture)."""
    col = np.asarray(col, float)
    if len(col) < 5:
        return None
    L = luminance(col); a, b = np.percentile(L, [lo, hi])
    m = (L >= a) & (L <= b)
    return [int(round(v)) for v in col[m].mean(0)]


# ---------------------------------------------------------------- instance transform (template <-> world)
PIVOT_H = 0.40          # default tilt pivot height above the floor (on the swivel axis)


def canon(P, prm, tilt=True, pivot_h=PIVOT_H):
    """World points -> canonical template frame for instance parameters prm = (yaw_deg, x, y, z, pitch_deg).
    Forward model: world = Ry(yaw) * Tilt(L) + (x, y, z); Tilt(L) = Rx(-pitch) (L - pivot) + pivot."""
    yaw, x, y, z, pitch = prm
    Lc = (np.asarray(P, float) - np.array([x, y, z])) @ Ry(yaw)
    if tilt:
        c = np.array([0.0, pivot_h, 0.0])
        Lc = (Lc - c) @ Rx(-pitch) + c
    return Lc


def canon_n(N, prm, tilt=True):
    Nc = np.asarray(N, float) @ Ry(prm[0])
    return Nc @ Rx(-prm[4]) if tilt else Nc


def uncanon(Lc, prm, tilt=True, pivot_h=PIVOT_H):
    """Canonical template points -> world (inverse of canon)."""
    yaw, x, y, z, pitch = prm
    Lc = np.asarray(Lc, float)
    if tilt:
        c = np.array([0.0, pivot_h, 0.0])
        Lc = (Lc - c) @ Rx(-pitch).T + c
    return Lc @ Ry(yaw).T + np.array([x, y, z])


def vox_sub(P, cell, *arrs):
    k = np.floor(np.asarray(P) / cell).astype(np.int64)
    _, first = np.unique(k, axis=0, return_index=True)
    return (P[first],) + tuple(a[first] for a in arrs)
