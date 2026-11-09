"""Planar-facet reconstruction of faceted objects (reception desk, table pedestal) from the scan sub-mesh.

planar_facets(M, ...) -> list of facets {n, d, origin, e1, e2, outline (plane coords), area, region_faces}
  1. planes: sequential RANSAC on oriented scan samples (shape.detect_planes, all orientations, 1 cm band)
  2. regions: scan faces within 1 cm of a plane and normal-compatible, split into connected components of the scan
     surface; components < min_area dropped; every region re-fitted (area-weighted PCA of its faces) -> continuous
     plane, no angle snapping
  3. outline: union of the region's faces projected on its plane, closed / opened by 4 mm, Douglas-Peucker 5 mm
  4. edges: for every pair of adjacent regions (scan faces within 4 cm, normals > 15 deg apart) the facet is grown
     by up to 10 cm towards the neighbour and trimmed at the line where the two planes intersect (on the side of
     its own region) -> neighbouring facets meet on their real intersection edge instead of the scan's rounded edge
facet_mesh(f) -> triangles (constrained Delaunay of the outline) on the plane, facing the scan normal.
"""
import numpy as np
import trimesh
import shapely
from shapely.geometry import Polygon, MultiPoint
from shapely.ops import unary_union
from scipy.spatial import cKDTree
import contour as C
import shape as SH


def plane_frame(n):
    n = np.asarray(n, float)
    up = np.array([0.0, 1.0, 0.0]) if abs(n[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
    e1 = np.cross(up, n); e1 /= np.linalg.norm(e1)
    e2 = np.cross(n, e1)
    return e1, e2


def _clean(poly, r=0.004, simp=0.005, min_hole=0.004):
    poly = poly.buffer(r, join_style=2).buffer(-r, join_style=2)
    out = []
    for g in C._geoms(poly):
        holes = [h for h in g.interiors if Polygon(h).area >= min_hole]
        out.append(Polygon(g.exterior, holes))
    return unary_union(out).simplify(simp, preserve_topology=True) if out else Polygon()


def _fit_region(M, cc):
    FCn, FN, FA = M.triangles_center, M.face_normals, M.area_faces
    a = FA[cc].sum()
    c0 = (FCn[cc] * FA[cc, None]).sum(0) / a
    X = (FCn[cc] - c0) * np.sqrt(FA[cc])[:, None]
    _, _, vt = np.linalg.svd(X, full_matrices=False)
    n = vt[2] * np.sign(vt[2] @ (FN[cc] * FA[cc, None]).sum(0))
    return n, float(n @ c0), c0, float(a)


def planar_facets(M, min_area=0.02, dist=0.012, cos_face=0.95, grow=0.10, adj_dist=0.04, fill_holes=0.08,
                  merge_deg=6.0, merge_off=0.015, seam=0.015, log=print):
    planes = SH.detect_planes(M, min_area=min_area, dist=dist, cos_min=0.95, max_planes=70, spacing=0.012,
                              trials=250, vertical_only=False)
    FCn, FN, FA = M.triangles_center, M.face_normals, M.area_faces
    lab = np.full(len(FCn), -1); bd = np.full(len(FCn), np.inf)
    for k, p in enumerate(planes):
        d = np.abs(FCn @ p['n'] - p['d'])
        ok = (d < dist) & (FN @ p['n'] > cos_face) & (d < bd)
        lab[ok] = k; bd[ok] = d[ok]
    adj = M.face_adjacency
    same = (lab[adj[:, 0]] == lab[adj[:, 1]]) & (lab[adj[:, 0]] >= 0)
    comps = trimesh.graph.connected_components(adj[same], nodes=np.nonzero(lab >= 0)[0], min_len=1)
    regs = [cc for cc in comps if len(cc) >= 3 and FA[cc].sum() >= min_area * 0.5]
    # merge adjacent near-coplanar regions (one panel split by RANSAC / by a scan crease): angle < merge_deg and
    # each centroid within merge_off of the other's plane
    fits = [_fit_region(M, cc) for cc in regs]
    trees0 = [cKDTree(FCn[cc]) for cc in regs]
    parent = list(range(len(regs)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for i in range(len(regs)):
        for j in range(i + 1, len(regs)):
            (ni, di, ci, _), (nj, dj, cj, _) = fits[i], fits[j]
            if ni @ nj < np.cos(np.radians(merge_deg)):
                continue
            if abs(ni @ cj - di) > merge_off or abs(nj @ ci - dj) > merge_off:
                continue
            dd, _ = trees0[i].query(FCn[regs[j]], distance_upper_bound=adj_dist)
            if np.isfinite(dd).any():
                parent[find(i)] = find(j)
    groups = {}
    for i in range(len(regs)):
        groups.setdefault(find(i), []).append(i)
    merged = [np.concatenate([regs[i] for i in g]) for g in groups.values()]
    nmerge = len(regs) - len(merged)
    facets = []
    for cc in merged:
        n, d, c0, a = _fit_region(M, cc)
        if a < min_area:
            continue
        e1, e2 = plane_frame(n)
        tri = M.triangles[cc] - c0
        T2 = np.stack([tri @ e1, tri @ e2], -1)
        poly = shapely.union_all(shapely.polygons(T2))
        poly = _clean(poly, min_hole=fill_holes)          # holes < fill_holes m2 inside a panel are scan holes
        if poly.area < min_area * 0.5:
            continue
        res = np.abs(FCn[cc] @ n - d)
        facets.append(dict(n=n, d=d, origin=c0, e1=e1, e2=e2, poly=poly, faces=cc, area=float(a),
                           rms_cm=round(float(np.sqrt((res ** 2 * FA[cc]).sum() / a)) * 100, 3)))
    facets.sort(key=lambda f: -f['area'])
    # ---- adjacency + growth towards neighbours, trimmed at the plane-plane intersection line
    trees = [cKDTree(FCn[f['faces']]) for f in facets]
    nedge = 0
    for i, fi in enumerate(facets):
        grown = [fi['poly']]
        cuts = []
        for j, fj in enumerate(facets):
            if i == j or abs(fi['n'] @ fj['n']) > np.cos(np.radians(15)):
                continue
            dd, _ = trees[i].query(FCn[fj['faces']], distance_upper_bound=adj_dist + grow)
            near = np.isfinite(dd)
            if near.sum() < 3 or dd[near].min() > adj_dist:
                continue
            # neighbour faces near facet i, projected on plane i -> window
            Q = FCn[fj['faces'][near]] - fi['origin']
            W = MultiPoint(np.c_[Q @ fi['e1'], Q @ fi['e2']]).convex_hull.buffer(grow, join_style=2)
            # intersection line of the planes in plane-i coords: points q = origin + s e1 + t e2 with nj.q = dj
            a1, a2 = fj['n'] @ fi['e1'], fj['n'] @ fi['e2']; c = fj['d'] - fj['n'] @ fi['origin']
            if np.hypot(a1, a2) < 1e-6:
                continue
            # side of facet i's own region centroid (sample the region polygon's representative point)
            rp = fi['poly'].representative_point()
            own = np.sign(a1 * rp.x + a2 * rp.y - c)
            if own == 0:
                continue
            # half-plane beyond the line (own * (a1 s + a2 t - c) < 0), restricted to the window
            b = 50.0
            L = np.array([a1, a2]) / np.hypot(a1, a2); c_ = c / np.hypot(a1, a2)
            p0 = L * c_; t_ = np.array([-L[1], L[0]])
            far = p0 - own * L * b
            beyond = Polygon([p0 + t_ * b, p0 - t_ * b, far - t_ * b, far + t_ * b])
            grown.append(fi['poly'].buffer(grow, join_style=2).intersection(W))
            cuts.append(beyond.intersection(W))
            nedge += 1
        grown.append(fi['poly'].buffer(seam, join_style=2))      # closes hairline seams to coplanar neighbours
        g = unary_union(grown)
        if cuts:
            g = g.difference(unary_union(cuts))
        g = unary_union([x for x in C._geoms(g) if x.area > 1e-4])
        fi['poly_final'] = g.simplify(0.003, preserve_topology=True)
    log(f'  planar facets: {len(planes)} RANSAC planes -> {len(regs)} regions, {nmerge} coplanar merges -> {len(facets)} facets >= {min_area} m2 '
        f'(areas {[round(f["area"], 2) for f in facets[:10]]} ...), {nedge} trimmed edges')
    return facets


def facet_mesh(f):
    tris = C._cdt(f['poly_final'])
    if len(tris) == 0:
        return None
    P = f['origin'] + tris[..., 0:1] * f['e1'] + tris[..., 1:2] * f['e2']          # (n,3,3)
    nrm = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    flip = nrm @ f['n'] < 0
    P[flip] = P[flip][:, ::-1]
    m = trimesh.Trimesh(P.reshape(-1, 3), np.arange(len(P) * 3).reshape(-1, 3), process=False)
    m.merge_vertices(digits_vertex=7)
    return m
