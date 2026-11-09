"""Round-3 shape helpers on top of contour.py (furniture rebuild step).

  ring_dev(A, B)                 robust deviation (p95 of both one-sided distances, m) between two closed rings
  simplify_sections(secs, tol)   "vertical Douglas-Peucker": keep only the sections a loft needs so that linear
                                 bands between kept sections reproduce every dropped section within tol (planar
                                 facets of a faceted shell collapse to one band; noise ridges disappear; steps,
                                 plateaus and every real change of slope stay). Continuous coordinates throughout.
  ground_profiles(...)           x/z-axis profiles (outline in (u, y)): bottom vertices close to the floor -> y = 0
  fit_metrics(scan, model)       scan -> model distance (mean / p50 / p90 cm, within 1/2/3 cm %) and model -> scan
"""
import numpy as np
import shapely
from shapely.geometry import Polygon
import contour as C


def ring_dev(A, B, spacing=0.004, q=95):
    A = np.asarray(A, float); B = np.asarray(B, float)
    a = C.resample_ring(A, spacing); b = C.resample_ring(B, spacing)
    ra, rb = shapely.LinearRing(np.r_[A, A[:1]]), shapely.LinearRing(np.r_[B, B[:1]])
    d1 = shapely.distance(rb, shapely.points(a)); d2 = shapely.distance(ra, shapely.points(b))
    return float(max(np.percentile(d1, q), np.percentile(d2, q)))


def _interp(PA, PB, t):
    return PA * (1 - t) + PB * t


def simplify_sections(sections, tol, axis='y', max_gap=None, fold_check=True):
    """sections: [{axis: level, 'outline': [[u, v], ...], optional 'step': True}] ascending.
    Returns the kept subset (dicts unchanged). A section is dropped only if the linear band between its kept
    neighbours reproduces it within tol (p95 of the ring deviation) and that band does not fold. Sections flagged
    'step' and their predecessors are always kept. max_gap: optional maximum level distance between kept sections."""
    n = len(sections)
    if n <= 2:
        return list(sections)
    lv = np.array([float(s[axis]) for s in sections])
    R = [C.dedupe(C.ccw(np.asarray(s['outline'], float))) for s in sections]
    keep = np.zeros(n, bool); keep[0] = keep[-1] = True
    for i, s in enumerate(sections):
        if s.get('step'):
            keep[i] = True; keep[max(0, i - 1)] = True
    anchors = list(np.nonzero(keep)[0])
    stack = [(a, b) for a, b in zip(anchors[:-1], anchors[1:])]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        PA, PB = C.band_correspondence(R[i], R[j])
        worst, kw = -1.0, None
        for k in range(i + 1, j):
            t = (lv[k] - lv[i]) / max(lv[j] - lv[i], 1e-12)
            I = _interp(PA, PB, t)
            try:
                d = ring_dev(I, R[k])
            except Exception:
                d = np.inf
            if d > worst:
                worst, kw = d, k
        split = worst > tol
        if not split and max_gap is not None and lv[j] - lv[i] > max_gap:
            split = True; kw = (i + j) // 2
        if not split and fold_check:
            # a band that folds would be turned into a step at the mid level by loft(): only acceptable between
            # neighbouring levels
            if C.band_folds(PA, PB, R[i], R[j]):
                disp = np.linalg.norm(PA - PB, axis=1)
                if np.percentile(disp, 90) > (lv[j] - lv[i]) * np.tan(np.radians(75)):
                    split = True; kw = (i + j) // 2 if kw is None else kw
        if split:
            keep[kw] = True; stack += [(i, kw), (kw, j)]
    return [s for s, k in zip(sections, keep) if k]


def ground_profiles(sections, near=0.035, floor=0.0):
    """Profiles (outline (u, y)) of x- or z-axis lofts: vertices within `near` of the section's lowest point are put
    on the floor when that lowest point is itself within 2*near of the floor (the scan never sees the underside)."""
    out = []
    for s in sections:
        P = np.asarray(s['outline'], float).copy()
        ymin = P[:, 1].min()
        if ymin - floor < 2 * near:
            P[P[:, 1] < ymin + near, 1] = floor
            P = C.dedupe(P)
            if len(P) >= 3 and Polygon(P).is_valid:
                s = dict(s, outline=np.round(P, 5).tolist())
        out.append(s)
    return out


def fit_metrics(scan_mesh, model, spacing=0.01, seed=11):
    P, _, _, _ = C.sample_mesh(scan_mesh, spacing, seed=seed)
    d1 = C.surface_distance(P, model) * 100
    Q, _, _, _ = C.sample_mesh(model, spacing, seed=seed + 1)
    d2 = C.surface_distance(Q, scan_mesh) * 100

    def f(d):
        return dict(mean_cm=round(float(d.mean()), 2), p50_cm=round(float(np.median(d)), 2),
                    p90_cm=round(float(np.percentile(d, 90)), 2), within_1cm_pct=round(float((d <= 1).mean() * 100), 1),
                    within_2cm_pct=round(float((d <= 2).mean() * 100), 1),
                    within_3cm_pct=round(float((d <= 3).mean() * 100), 1), n=int(len(d)))
    return dict(scan_to_model=f(d1), model_to_scan=f(d2))


# ===================================================================== consensus along an extrusion axis
def consensus_clamp(polys, band=0.03, frac=0.5, res=0.005, simplify=0.002, keep_all=False):
    """polys: one shapely (Multi)Polygon per level of a part that is extrusion-like along the slicing axis (sofa
    seat / back cushions along x). M = region inside the outline on >= frac of the levels (raster majority at
    `res`, contoured at continuous coordinates). Every level is clamped to M +- band:
        final_i = (P_i n buffer(M, band)) u buffer(M, -band)
    -> keeps per-level variation up to `band` (cushion domes, seams) and removes outliers that exist on a minority of
    levels only (a person sitting on the sofa, a bag) or fills holes deeper than band. Returns list of Polygons."""
    from skimage import measure
    from shapely.ops import unary_union
    polys = [p.buffer(0) for p in polys]
    ok = [p for p in polys if not p.is_empty]
    if len(ok) < 3:
        return polys, None
    x0, y0, x1, y1 = unary_union(ok).bounds
    gx = np.arange(x0 - 2 * res, x1 + 2 * res, res); gy = np.arange(y0 - 2 * res, y1 + 2 * res, res)
    GX, GY = np.meshgrid(gx, gy, indexing='ij')
    cnt = np.zeros(GX.shape)
    for p in ok:
        cnt += shapely.contains_xy(p, GX, GY)
    f = cnt / len(ok)
    rings = measure.find_contours(f, frac)
    cand = []
    for r in rings:
        if len(r) < 4:
            continue
        q = Polygon(np.c_[gx[0] + r[:, 0] * res, gy[0] + r[:, 1] * res]).buffer(0)
        cand += C._geoms(q)
    if not cand:
        return polys, None
    M = unary_union(cand)
    if keep_all:                      # every majority component (exteriors); no clamping
        return polys, unary_union([Polygon(g.exterior) for g in C._geoms(M)])
    M = max(C._geoms(M), key=lambda g: g.area)
    M = Polygon(M.exterior)
    Mo, Mi = M.buffer(band, quad_segs=6), M.buffer(-band, quad_segs=6)
    out = []
    for p in polys:
        g = p.intersection(Mo).union(Mi).buffer(0)
        gs = C._geoms(g)
        if not gs:
            out.append(Polygon()); continue
        g = max(gs, key=lambda q: q.area)
        out.append(Polygon(g.exterior).simplify(simplify, preserve_topology=True))
    return out, M


def clip_largest(poly, box):
    """Largest piece of poly n box (shapely), exterior only; None if empty."""
    g = poly.intersection(box).buffer(0)
    gs = [q for q in C._geoms(g) if q.area > 1e-5]
    if not gs:
        return None
    return Polygon(max(gs, key=lambda q: q.area).exterior)


def ring_of(poly, ndigits=5):
    P = C.dedupe(C.ccw(np.asarray(poly.exterior.coords)[:-1]))
    return np.round(P, ndigits)


# ===================================================================== texture baking with a reusable scan context
class ScanTex:
    """Texture source = scan faces (indices into the aligned scan F) + dense oriented samples + KD-tree, built once
    per object and reused for every part (contour.transfer_texture rebuilds it per call)."""

    def __init__(self, face_ids, spacing=0.004):
        import trimesh
        from scipy.spatial import cKDTree
        S = C.scene()
        self.fids = np.asarray(face_ids)
        sm = trimesh.Trimesh(S['V'], S['F'][self.fids], process=False)
        self.SP, self.SN, self.sidx, _ = C.sample_mesh(sm, spacing, seed=5)
        self.tree = cKDTree(self.SP)

    def bake(self, new_mesh, frame_R=None, texel=None, max_dist=0.02, normal_min=0.5, gutter=2, min_chroma=None,
             support_dist=0.08, bottom_band=0.02):
        """Same algorithm as contour.transfer_texture (box-projection charts, shelf-packed atlas, every texel from
        the closest normal-compatible point of the original scan surface, bilinear in the original texture)."""
        import time, trimesh
        from scipy.spatial import cKDTree
        from scipy import ndimage
        from PIL import Image
        t0 = time.time(); S = C.scene()
        if texel is None:
            texel = C.auto_params(new_mesh.extents)['texel']
        chart, charts, t2 = C.make_charts(new_mesh, frame_R, texel)
        W, H = C.pack_charts(charts, t2, gutter)
        off = np.zeros((len(new_mesh.faces), 2))
        for c in charts:
            off[c['faces']] = c['offset']
        A2 = t2 + off[:, None, :]
        PIX, P3, FN = [], [], []
        tri3 = new_mesh.triangles; fn = new_mesh.face_normals
        for fi in range(len(new_mesh.faces)):
            ij, bc = C._raster_tri(A2[fi])
            if len(ij) == 0:
                continue
            PIX.append(ij); P3.append(bc @ tri3[fi]); FN.append(np.repeat(fn[fi][None], len(ij), 0))
        PIX = np.concatenate(PIX); P3 = np.concatenate(P3); FN = np.concatenate(FN)
        ok = (PIX[:, 0] >= 0) & (PIX[:, 0] < W) & (PIX[:, 1] >= 0) & (PIX[:, 1] < H)
        PIX, P3, FN = PIX[ok], P3[ok], FN[ok]
        # support (part kept at all): any normal-compatible scan sample within support_dist (8 cm, round-3 rule)
        d8, i8 = self.tree.query(P3, k=12, distance_upper_bound=support_dist, workers=-1)
        f8 = np.isfinite(d8); i8 = np.where(f8, i8, 0)
        support = (f8 & (np.einsum('nkj,nj->nk', self.SN[i8], FN) > 0.2)).any(1)
        # colour source: closest normal-compatible scan point within max_dist (2 cm, dot > 0.5)
        d, ii = self.tree.query(P3, k=12, distance_upper_bound=max_dist, workers=-1)
        fin = np.isfinite(d); ii = np.where(fin, ii, 0)
        agree = fin & (np.einsum('nkj,nj->nk', self.SN[ii], FN) > normal_min)
        first = np.argmax(agree, axis=1); has = agree.any(1)
        gface = self.fids[self.sidx[ii[np.arange(len(P3)), first]]]
        col = np.zeros((len(P3), 3), np.float32)
        if has.any():
            tri = S['V'][S['F'][gface[has]]]
            cp = trimesh.triangles.closest_point(tri, P3[has])
            bc = trimesh.triangles.points_to_barycentric(tri, cp)
            bc = np.clip(bc, 0, 1); bc /= bc.sum(1, keepdims=True)
            uvs = np.einsum('ni,nij->nj', bc, S['UV'][S['F'][gface[has]]])
            col[has] = C._bilinear(S['tex'], uvs)
            if min_chroma:      # colour identifies texels that show another object (grey person on a tan sofa):
                # neutral / bluish texels (blue >= 80 % of red, or chroma < min_chroma of the value) are not leather
                cc = col[has]
                bad = ((cc.max(1) - cc.min(1)) < min_chroma * np.maximum(cc.max(1), 1)) | (cc[:, 2] >= 0.8 * cc[:, 0])
                hi = np.nonzero(has)[0]; has[hi[bad]] = False
        # downward faces and the bottom band of the part (shadow / floor colour in the scan) -> part colour
        down = (FN[:, 1] < -0.5) | (P3[:, 1] < new_mesh.bounds[0][1] + bottom_band)
        src = has & ~down
        part_rgb = np.median(col[src], axis=0) if src.sum() >= 10 else (np.median(col[has], axis=0) if has.any() else np.full(3, 180.0))
        col[~src] = part_rgb            # unobserved / downward / bottom texels: the part's material colour
        observed = src
        img = np.zeros((H, W, 3), np.float32); msk = np.zeros((H, W), bool); omsk = np.zeros((H, W), bool)
        img[PIX[:, 1], PIX[:, 0]] = col; msk[PIX[:, 1], PIX[:, 0]] = True; omsk[PIX[:, 1], PIX[:, 0]] = observed
        if (~msk).any():
            _, (iy, ix) = ndimage.distance_transform_edt(~msk, return_indices=True)
            img = img[iy, ix]
        image = Image.fromarray(np.clip(np.round(img), 0, 255).astype(np.uint8))
        self.last_observed_mask = Image.fromarray((omsk * 255).astype(np.uint8))
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
                    observed_fraction=round(float(observed.mean()), 3), support_fraction_8cm=round(float(support.mean()), 3),
                    part_rgb=[int(round(v)) for v in part_rgb], rule=f'colour source <= {max_dist * 100:.0f} cm, normal dot > '
                    f'{normal_min}; else / downward / bottom {bottom_band * 100:.0f} cm -> part median colour',
                    seconds=round(time.time() - t0, 1))
        return out, image, info


# ===================================================================== smoothing along the loft axis
def _partners(A, B):
    """For every vertex of ring A its corresponding point on ring B (contour.band_correspondence)."""
    from scipy.spatial import cKDTree
    PA, PB = C.band_correspondence(A, B)
    _, j = cKDTree(PA).query(A)
    return PB[j]


def smooth_sections(sections, axis='y', iters=2, w=0.5, max_dev=0.025):
    """Laplacian smoothing of corresponding outline vertices ALONG the loft axis (each vertex moves towards the
    linear interpolation of its partners on the neighbouring sections). Removes level-to-level scan noise (ridges)
    while keeping real changes: sections flagged 'step', the first / last section and any section whose neighbours'
    interpolation lies further than max_dev (p90) from it are left as they are. Vertex counts are unchanged."""
    secs = [dict(s) for s in sections]
    n = len(secs)
    if n < 3:
        return secs
    for _ in range(iters):
        R = [C.dedupe(C.ccw(np.asarray(s['outline'], float))) for s in secs]
        lv = [float(s[axis]) for s in secs]
        new = []
        for k in range(n):
            if k == 0 or k == n - 1 or secs[k].get('step') or secs[k + 1].get('step'):
                new.append(R[k]); continue
            t = (lv[k] - lv[k - 1]) / max(lv[k + 1] - lv[k - 1], 1e-12)
            try:
                mid = _partners(R[k], R[k - 1]) * (1 - t) + _partners(R[k], R[k + 1]) * t
            except Exception:
                new.append(R[k]); continue
            dev = np.linalg.norm(mid - R[k], axis=1)
            if np.percentile(dev, 90) > max_dev:
                new.append(R[k]); continue
            Q = (1 - w) * R[k] + w * mid
            if Polygon(Q).is_valid and abs(C.signed_area(Q)) > 1e-6:
                new.append(C.ccw(Q))
            else:
                new.append(R[k])
        for s, Q in zip(secs, new):
            s['outline'] = np.round(Q, 5).tolist()
    return secs


def fill_under(poly, y_lo=0.12, y_hi=0.2, recess=0.03, floor=0.0):
    """x/z-axis profile (u, y): close the unobserved underside below a cushion / frame: the profile's u-extent
    between y_lo and y_hi, recessed by `recess` at the front (min u), is extended down to the floor."""
    band = poly.intersection(sbox_(-1e3, y_lo, 1e3, y_hi))
    if band.is_empty:
        return poly
    u0, _, u1, _ = band.bounds
    if u1 - u0 < 2 * recess:
        return poly
    g = poly.union(sbox_(u0 + recess, floor, u1, y_lo + 1e-4)).buffer(0)
    gs = C._geoms(g)
    return Polygon(max(gs, key=lambda q: q.area).exterior) if gs else poly


def sbox_(a, b, c, d):
    from shapely.geometry import box
    return box(a, b, c, d)


def consensus_window(polys, half=10, band=0.02, frac=0.5, res=0.005, simplify=0.002):
    """Sliding-window version of consensus_clamp: level i is clamped to the majority region M_i of the levels
    i-half .. i+half (raster majority, contoured at continuous coordinates):
        final_i = (P_i n buffer(M_i, band)) u buffer(M_i, -band)
    For parts whose profile changes slowly along the axis (a sofa arm: arm in front, frame behind)."""
    from skimage import measure
    from shapely.ops import unary_union
    polys = [p.buffer(0) for p in polys]
    ok = [p for p in polys if not p.is_empty]
    if len(ok) < 3:
        return polys
    x0, y0, x1, y1 = unary_union(ok).bounds
    gx = np.arange(x0 - 2 * res, x1 + 2 * res, res); gy = np.arange(y0 - 2 * res, y1 + 2 * res, res)
    GX, GY = np.meshgrid(gx, gy, indexing='ij')
    R = np.array([shapely.contains_xy(p, GX, GY) if not p.is_empty else np.zeros(GX.shape, bool) for p in polys])
    cs = np.concatenate([np.zeros((1,) + GX.shape), np.cumsum(R, 0)])
    out = []
    for i, p in enumerate(polys):
        a, b = max(0, i - half), min(len(polys), i + half + 1)
        f = (cs[b] - cs[a]) / (b - a)
        cand = []
        for r in measure.find_contours(f, frac):
            if len(r) >= 4:
                cand += C._geoms(Polygon(np.c_[gx[0] + r[:, 0] * res, gy[0] + r[:, 1] * res]).buffer(0))
        if not cand or p.is_empty:
            out.append(p); continue
        M = Polygon(max(C._geoms(unary_union(cand)), key=lambda g: g.area).exterior)
        g = p.intersection(M.buffer(band, quad_segs=6)).union(M.buffer(-band, quad_segs=6)).buffer(0)
        gs = C._geoms(g)
        out.append(Polygon(max(gs, key=lambda q: q.area).exterior).simplify(simplify, preserve_topology=True) if gs else p)
    return out


# ===================================================================== planar facets (faceted shells, panels)
def detect_planes(mesh, min_area=0.04, dist=0.008, cos_min=0.95, max_planes=40, trials=400, spacing=0.01, seed=0,
                  vertical_only=True):
    """Sequential RANSAC on oriented surface samples of `mesh` (object frame): planes (unit normal n, offset d with
    n.p = d) supported by >= min_area of scan surface within `dist` and normal-compatible (cos >= cos_min).
    vertical_only: only planes whose normal is at most ~72 deg from horizontal (|n_y| < 0.95) - these are the faces
    a horizontal section cuts. Returns [{'n', 'd', 'area', 'pts'}] (inlier points kept for proximity checks)."""
    P, N, _, _ = C.sample_mesh(mesh, spacing, seed=seed)
    w = spacing ** 2
    rng = np.random.default_rng(seed)
    rem = np.ones(len(P), bool)
    if vertical_only:
        rem &= np.abs(N[:, 1]) < 0.95
    planes = []
    for _ in range(max_planes):
        idx = np.nonzero(rem)[0]
        if len(idx) * w < min_area:
            break
        seeds = rng.choice(idx, size=min(trials, len(idx)), replace=False)
        best, bn, bd = 0, None, None
        Pi, Ni = P[idx], N[idx]
        for s in seeds:
            n = N[s]; d = n @ P[s]
            c = int(((np.abs(Pi @ n - d) < dist) & (Ni @ n > cos_min)).sum())
            if c > best:
                best, bn, bd = c, n, d
        if best * w < min_area:
            break
        inl = idx[(np.abs(Pi @ bn - bd) < dist) & (Ni @ bn > cos_min)]
        # refine (total least squares) and re-collect
        c0 = P[inl].mean(0); _, _, vt = np.linalg.svd(P[inl] - c0, full_matrices=False)
        n = vt[2] * np.sign(vt[2] @ bn); d = n @ c0
        inl = idx[(np.abs(Pi @ n - d) < dist) & (Ni @ n > cos_min)]
        if len(inl) * w < min_area:
            rem[inl] = False; continue
        planes.append(dict(n=n, d=float(d), area=float(len(inl) * w), pts=P[inl]))
        rem[inl] = False
    from scipy.spatial import cKDTree
    for p in planes:
        p['tree'] = cKDTree(p['pts'])
    return planes


def snap_ring_to_planes(R, y, planes, tol=0.015, min_len=0.03, support=0.05, max_move=0.03, cos_min=0.9):
    """Horizontal outline R (CCW, (x, z)) at height y: every edge that lies on a detected plane (all edge samples
    within tol of it, outward normals agree, scan support of that plane within `support`) is replaced by the exact
    line plane n level y; corners = intersections of consecutive snapped lines (or projections). Continuous coords.
    Returns (new ring, number of snapped edges)."""
    R = np.asarray(R, float); n = len(R)
    lines = [None] * n
    for i in range(n):
        a, b = R[i], R[(i + 1) % n]; e = b - a; L = np.hypot(e[0], e[1])
        if L < min_len:
            continue
        out = np.array([e[1], -e[0]]) / L
        t = np.linspace(0.1, 0.9, 5)[:, None]
        S2 = a + t * e; S3 = np.c_[S2[:, 0], np.full(5, y), S2[:, 1]]
        best = None
        for k, p in enumerate(planes):
            nh = p['n'][[0, 2]]; hn = np.hypot(nh[0], nh[1])
            if hn < 0.3 or (nh / hn) @ out < cos_min:
                continue
            dd = np.abs(S3 @ p['n'] - p['d'])
            if dd.max() > tol:
                continue
            ds, _ = p['tree'].query(S3, distance_upper_bound=support)
            if np.isfinite(ds).sum() < 3:
                continue
            if best is None or dd.mean() < best[0]:
                best = (dd.mean(), k)
        if best is not None:
            p = planes[best[1]]
            nh = p['n'][[0, 2]]; hn = np.hypot(nh[0], nh[1])
            lines[i] = (nh / hn, (p['d'] - p['n'][1] * y) / hn)        # line: u . q = c
    if not any(l is not None for l in lines):
        return R, 0
    Q = R.copy()
    for i in range(n):
        l0, l1 = lines[i - 1], lines[i]
        v = R[i]
        if l0 is not None and l1 is not None:
            A = np.array([l0[0], l1[0]])
            if abs(np.linalg.det(A)) > 0.2:
                q = np.linalg.solve(A, [l0[1], l1[1]])
                if np.linalg.norm(q - v) <= max_move:
                    Q[i] = q; continue
            # near-parallel (or far): average of the projections
            q0 = v - (l0[0] @ v - l0[1]) * l0[0]; q1 = v - (l1[0] @ v - l1[1]) * l1[0]
            Q[i] = 0.5 * (q0 + q1)
        elif l0 is not None or l1 is not None:
            l = l0 if l0 is not None else l1
            q = v - (l[0] @ v - l[1]) * l[0]
            if np.linalg.norm(q - v) <= max_move:
                Q[i] = q
    Q = C.dedupe(Q)
    pq, pr = Polygon(Q), Polygon(R)
    if len(Q) < 3 or not pq.is_valid or abs(pq.area - pr.area) > 0.1 * pr.area:
        return R, 0
    return Q, int(sum(l is not None for l in lines))


def snap_levels_to_planes(res, planes, **kw):
    tot = snapped = 0
    for L in res['levels']:
        new = []
        for P in L['polygons']:
            Q, k = snap_ring_to_planes(P, L['level'], planes, **kw)
            new.append(Q); snapped += k; tot += len(P)
        L['polygons'] = new
    return snapped, tot


# ===================================================================== adaptive band correspondence resolution
_bc_orig = C.band_correspondence


def band_correspondence_adaptive(A, B, n_align=None):
    """contour.band_correspondence with the alignment resolution scaled to the ring length (~2.5 cm per sample,
    160..480): long outlines (a 12 m desk perimeter) were aligned at 7.5 cm, which twists the bands."""
    if n_align is None:
        per = max(C._ring_params(np.asarray(A, float))[1], C._ring_params(np.asarray(B, float))[1])
        n_align = int(np.clip(per / 0.025, 160, 480))
    return _bc_orig(A, B, n_align)


C.band_correspondence = band_correspondence_adaptive


def heightfield_fill(poly, floor=0.0, du=0.005, simplify=0.003):
    """Profile (u, y) -> region under its top boundary: {(u, y): floor <= y <= top(u)} over the profile's u-extent.
    For a block standing on the floor (a sofa arm) whose scan section came out hollow (only the upholstered skin
    was classified as inside)."""
    from shapely.geometry import LineString
    u0, _, u1, y1 = poly.bounds
    us = np.arange(u0 + 1e-4, u1, du)
    tops = []
    for u in us:
        g = poly.intersection(LineString([(u, floor - 1), (u, y1 + 1)]))
        tops.append(g.bounds[3] if not g.is_empty else np.nan)
    tops = np.array(tops); ok = np.isfinite(tops)
    if ok.sum() < 3:
        return poly
    us, tops = us[ok], tops[ok]
    ring = np.r_[[[us[0], floor]], np.c_[us, tops], [[us[-1], floor]]]
    q = Polygon(ring).buffer(0)
    gs = C._geoms(q)
    return Polygon(max(gs, key=lambda g: g.area).exterior).simplify(simplify, preserve_topology=True) if gs else poly
