"""Primitive -> triangle mesh helpers shared by refine_r2.py and build.py.

All part geometry is in object-local coordinates (y = height above the object's floor); an object's
transform is world = Ry(yaw) * local + position (three.js rotation.y convention).

Part types
  box              size [sx,sy,sz], position (centre), yaw_deg
  cylinder         radius, height, position (centre), segments
  cone             radius, height, position (centre of the height span; base at the bottom), segments
  bicone           radius, height, position (centre), widest at waist (0..1 from the bottom), segments
  extrude          polygon [[x,z],...], height, position [ox, y_base, oz], yaw_deg
  profile_extrude  polygon [[x,z],...], inset_profile [[h, inset],...] (h from 0 up to the top),
                   edge_inset [w per edge] (edge i = polygon[i] -> polygon[i+1]; the edge's face is moved
                   inwards by w * inset at height h), position, yaw_deg, optional low_color_rgb + low_until
                   (side faces whose top is at or below low_until get low_color_rgb: e.g. a dark recessed plinth)
part_mesh(p) returns (trimesh, per-face sRGB colours (F,3) float).
"""
import numpy as np
import trimesh


def Ry(deg):
    a = np.radians(deg); c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def affine(R, t):
    T = np.eye(4); T[:3, :3] = R; T[:3, 3] = t; return T


def triangulate(poly):
    """Ear clipping of a simple polygon in the (x, z) plane; returns index triples."""
    pts = [tuple(p) for p in poly]; idx = list(range(len(pts))); tris = []

    def area(i, j, k):
        (xa, za), (xb, zb), (xc, zc) = pts[i], pts[j], pts[k]
        return (xb - xa) * (zc - za) - (xc - xa) * (zb - za)
    sgn = np.sign(sum(area(idx[0], idx[i], idx[i + 1]) for i in range(1, len(idx) - 1)))
    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        for t in range(len(idx)):
            i, j, k = idx[t - 1], idx[t], idx[(t + 1) % len(idx)]
            if area(i, j, k) * sgn <= 1e-12:
                continue
            if any(area(i, j, m) * sgn >= 0 and area(j, k, m) * sgn >= 0 and area(k, i, m) * sgn >= 0
                   for m in idx if m not in (i, j, k)):
                continue
            tris.append((i, j, k)); idx.pop(t); break
        else:
            break
    if len(idx) == 3:
        tris.append(tuple(idx))
    return tris


def signed_area(poly):
    p = np.asarray(poly, float); q = np.roll(p, -1, 0)
    return 0.5 * float(np.sum(p[:, 0] * q[:, 1] - q[:, 0] * p[:, 1]))


def offset_polygon(poly, d_edge):
    """Move every edge i inwards by d_edge[i] (line offset) and re-intersect neighbours (mitred)."""
    p = np.asarray(poly, float); n = len(p)
    s = 1.0 if signed_area(p) > 0 else -1.0
    e = np.roll(p, -1, 0) - p
    e /= np.linalg.norm(e, axis=1, keepdims=True)
    nin = s * np.c_[-e[:, 1], e[:, 0]]                 # inward unit normal of every edge
    c = np.einsum('ij,ij->i', nin, p) + np.asarray(d_edge, float)
    out = np.zeros_like(p)
    for i in range(n):
        a, b = (i - 1) % n, i
        A = np.array([nin[a], nin[b]])
        if abs(np.linalg.det(A)) < 1e-6:
            out[i] = p[i] + nin[b] * d_edge[b]
        else:
            out[i] = np.linalg.solve(A, [c[a], c[b]])
    return out


def clip_convex(poly, inset):
    """Inset a convex polygon by a constant distance (half-plane clipping, robust to short edges)."""
    p = np.asarray(poly, float)
    s = 1.0 if signed_area(p) > 0 else -1.0
    res = [tuple(v) for v in p]
    for i in range(len(p)):
        a, b = p[i], p[(i + 1) % len(p)]
        e = (b - a) / np.linalg.norm(b - a); nin = s * np.array([-e[1], e[0]])
        cval = nin @ a + inset
        out = []
        for j in range(len(res)):
            P_, Q_ = np.array(res[j]), np.array(res[(j + 1) % len(res)])
            fp, fq = nin @ P_ - cval, nin @ Q_ - cval
            if fp >= 0:
                out.append(tuple(P_))
            if (fp >= 0) != (fq >= 0):
                t = fp / (fp - fq); out.append(tuple(P_ + t * (Q_ - P_)))
        res = out
        if len(res) < 3:
            return None
    return np.array(res)


def extrude(poly, h):
    poly = np.asarray(poly, float); n = len(poly)
    V = np.r_[np.c_[poly[:, 0], np.zeros(n), poly[:, 1]], np.c_[poly[:, 0], np.full(n, h), poly[:, 1]]]
    F = []
    for i, j, k in triangulate(poly):
        F += [(i, k, j), (n + i, n + j, n + k)]
    for i in range(n):
        j = (i + 1) % n
        F += [(i, j, n + j), (i, n + j, n + i)]
    m = trimesh.Trimesh(V, np.array(F), process=False)
    m.fix_normals()
    return m


def profile_extrude(poly, profile, edge_w):
    """Layered extrusion: layer k = polygon with edge i moved in by edge_w[i] * inset_k at height h_k."""
    poly = np.asarray(poly, float); n = len(poly)
    prof = np.asarray(profile, float)
    layers = [offset_polygon(poly, np.asarray(edge_w, float) * ins) for _, ins in prof]
    V = np.concatenate([np.c_[L[:, 0], np.full(n, h), L[:, 1]] for L, (h, _) in zip(layers, prof)])
    F, ftop = [], []
    for k in range(len(prof) - 1):
        for i in range(n):
            j = (i + 1) % n
            a, b, c_, d = k * n + i, k * n + j, (k + 1) * n + j, (k + 1) * n + i
            F += [(a, b, c_), (a, c_, d)]; ftop += [prof[k + 1, 0]] * 2
    top = (len(prof) - 1) * n
    for i, j, k in triangulate(poly):
        F += [(i, k, j), (top + i, top + j, top + k)]; ftop += [0.0, prof[-1, 0] + 1]
    m = trimesh.Trimesh(V, np.array(F), process=False)
    m.fix_normals()
    return m, np.array(ftop)


def part_mesh(p):
    col = np.array(p['color_rgb'], float)
    fc = None
    t = p['type']
    if t == 'box':
        m = trimesh.creation.box(extents=p['size'])
        m.apply_transform(affine(Ry(p.get('yaw_deg', 0.0)), p['position']))
    elif t in ('cylinder', 'cone', 'bicone'):
        seg = p.get('segments', 24)
        if t == 'cylinder':
            m = trimesh.creation.cylinder(radius=p['radius'], height=p['height'], sections=seg)
        elif t == 'cone':
            m = trimesh.creation.cone(radius=p['radius'], height=p['height'], sections=seg)
            m.apply_translation([0, 0, -p['height'] / 2])
        else:
            hw = p['height'] * p.get('waist', 0.4)
            lo = trimesh.creation.cone(radius=p['radius'], height=hw, sections=seg)
            lo.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [1, 0, 0]))   # apex down
            lo.apply_translation([0, 0, hw])
            hi = trimesh.creation.cone(radius=p['radius'], height=p['height'] - hw, sections=seg)
            hi.apply_translation([0, 0, hw])
            m = trimesh.util.concatenate([lo, hi]); m.apply_translation([0, 0, -p['height'] / 2])
        m.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))  # axis z -> y
        m.apply_translation(p['position'])
    elif t == 'extrude':
        m = extrude(p['polygon'], p['height'])
        m.apply_transform(affine(Ry(p.get('yaw_deg', 0.0)), p['position']))
    elif t == 'profile_extrude':
        m, ftop = profile_extrude(p['polygon'], p['inset_profile'], p['edge_inset'])
        m.apply_transform(affine(Ry(p.get('yaw_deg', 0.0)), p['position']))
        if 'low_color_rgb' in p:
            fc = np.repeat(col[None], len(m.faces), 0)
            low = (ftop <= p['low_until'] + 1e-6) & (np.abs(m.face_normals[:, 1]) < 0.95) | (ftop == 0.0)
            fc[low] = p['low_color_rgb']
    else:
        raise ValueError(t)
    if fc is None:
        fc = np.repeat(col[None], len(m.faces), 0)
    return m, fc


def object_part_meshes(o):
    """[(part, world mesh, face colours)] for one object."""
    T = affine(Ry(o['transform']['yaw_deg']), o['transform']['position'])
    out = []
    for p in o['parts']:
        m, fc = part_mesh(p); m.apply_transform(T); out.append((p, m, fc))
    return out
