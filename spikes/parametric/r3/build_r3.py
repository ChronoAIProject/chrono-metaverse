"""Round 3 scene assembly -> spike/out/parametric_r3.glb (+ out/r3/metrics_r3.json).

Scene contents (all coordinates continuous, metres, aligned scan frame, y up)
  structure        (critic fixes) floor_r3: continuous outline (alpha shape + fitted wall lines, 2 pieces) meshed on the
                   fitted scan-floor B-spline surface (no 10 cm grid, no constant height); structure_r3: walls from
                   sequential RANSAC + piecewise TLS planes (lean kept, corners = line intersections), re-baked textures;
                   south glazing = round-2 plane with a per-pane re-bake; arch_solids.json: window piers, the curved
                   partition and the plant as sliced solids (they replace window-frame-01 / plant-01)
  furniture (r3)   the 9 objects rebuilt from scan contours (objects_r3.json, r3_status 'rebuilt ...'):
                   counter-01, table-01, sofa-01, sofa-02, side-table-01, armchair-01, chair-10, display-01, pillar-01.
                   Geometry + UVs from out/r3/glb/<id>.glb (one node per loft part, world coordinates); every part's
                   texture is the atlas JPEG out/r3/tex/<id>__<part>.jpg embedded byte-for-byte (no re-encode).
                   chair-10: the furniture-step model is used (same scan->model fit as the chairs-step one, 0.61 vs
                   0.54 cm, but model->scan 4.1 vs 5.8 cm, i.e. less invented volume); chair-10_loft_* is not used.
  meeting chairs   chairs.json template (seat / backrest / arms lofts + column + 4 tube legs) instanced at chair-01..08:
                   the template parts are stored once in template coordinates and every instance is a glTF node with
                   its own matrix, upper parts = T(position) Ry(yaw) Tilt(pitch about tilt_pivot), base = T(position)
                   Ry(yaw) S_y (vertical scale about the column top so the feet land on the model floor). Per-instance
                   vertex colours (measured part colours of chairs.json, same flat shading as chairs_build.py).
                   Identical vertex / index buffers are written once (trimesh's exporter already shares byte-identical
                   buffers; glb_dedupe re-checks that and verifies every embedded image is JPEG).
  chair-09         separate model (chairs_single.json): out/r3/chair-09_loft_tex.glb + chair-09_tex.jpg.
  round-2 objects  not rebuilt in round 3: screen-01 (base strip, speakers, floor box; the led_panel stays dropped as in
                   r2), window-frame-01, plant-01, suitcase-01, built by build.build_objects (same colours / snapping).
                   logo-wall-01 stays dropped (the textured wall wall_a210_1 carries the real logo).
  Ground snap      bottom ring of floor-touching parts placed on the fitted floor surface under each vertex (moves within
                   -3..+8 cm), so objects keep their scanned height; chair bases scaled to the floor under the chair.
  Chairs 01..08    shared template UV + per-chair textures baked from each chair's own scan (chairs_tex.py), legs from
                   the scan geometry (chairs_feet.py).
Textures: JPEG only. Structure PNGs are encoded once at JPEG_Q; r3 atlases are embedded as their original JPEG bytes.

Metrics (same scan sampling as round 2, exact distance): scan surface sample_surface(300 pts/m2, seed=7), y <= 2.4 ->
exact Euclidean distance to the nearest model triangle (KD-tree upper bound from dense model samples, then every
triangle whose bounding box lies within that bound is tested with trimesh.triangles.closest_point; no approximation).
The round-2 GLB is measured with the same function, so the numbers are directly comparable; the round-2 values as
reported by build.py (k=8 sample-candidate approximation) are kept alongside.

Usage: python -I r3/build_r3.py [--no-metrics]
"""
import os, sys, io, json, time, struct, hashlib
import numpy as np
import trimesh
from PIL import Image
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
PAR = os.path.dirname(HERE)
for p in (PAR, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)
import build as B                                    # noqa: E402  round-2 assembly helpers (structure, primitives)
from chairs_mesh import template_meshes, instance_mesh, tube_mesh   # noqa: E402
import chairlib as CL                                # noqa: E402
import floor_r3 as FLR                               # noqa: E402
import shapely                                       # noqa: E402
from shapely.geometry import Polygon                 # noqa: E402

OUT = os.path.join(PAR, 'out')
OUT3 = os.path.join(OUT, 'r3')
SPIKE_OUT = os.path.join(os.path.dirname(PAR), 'spike', 'out')
GLB = os.path.join(SPIKE_OUT, 'parametric_r3.glb')
GLB_R2 = os.path.join(SPIKE_OUT, 'parametric.glb')
GLB_PREV = os.path.join(SPIKE_OUT, 'parametric_r3_prev.glb')     # round-3 step before the critic fixes
METRICS = os.path.join(OUT3, 'metrics_r3.json')

FLOOR_Y = B.FLOOR_Y
GROUND_SNAP = B.GROUND_SNAP          # 8 cm, as round 2
JPEG_Q = 88                          # structure textures (PNG sources), encoded once
CHAIR_LIGHT = np.array([-0.45, 0.75, -0.5]); CHAIR_LIGHT /= np.linalg.norm(CHAIR_LIGHT)   # = contour.shaded

OBJS_R3 = json.load(open(os.path.join(OUT3, 'objects_r3.json')))
CHAIRS = json.load(open(os.path.join(OUT3, 'chairs.json')))
CHAIRS_SINGLE = json.load(open(os.path.join(OUT3, 'chairs_single.json')))
TEMPLATE_IDS = [i['id'] for i in CHAIRS['instances']]                     # chair-01..08
CHAIR_TEX = json.load(open(os.path.join(OUT3, 'chairs_tex.json')))          # per-chair textures + legs (chairs_tex.py)
CHAIR_LAYOUT = dict(np.load(os.path.join(OUT3, 'chairs_tex', 'layout.npz')))
SEPARATE = {'chair-09': dict(glb='chair-09_loft_tex.glb', tex='chair-09_tex.jpg')}
R2_DROPPED = dict(B.DROP_OBJECTS)                                         # logo-wall-01
STRUCT3 = json.load(open(os.path.join(OUT3, 'structure_r3.json')))
FLOOR3 = json.load(open(os.path.join(OUT3, 'floor_r3.json')))
SOLIDS = json.load(open(os.path.join(OUT3, 'arch_solids.json')))
from shapely.ops import unary_union as _uu       # noqa: E402
FLOOR_POLY = _uu([Polygon(g['outline_xz'], g.get('holes_xz', [])) for g in FLOOR3['polygons']])
FLOOR_SURF = FLR.load()
FLOOR_H = lambda x, z: FLOOR_SURF(x, z)                                     # noqa: E731  smooth fitted scan floor
REPLACED_BY_SOLIDS = {s_['replaces']: s_['id'] for s_ in SOLIDS if s_.get('replaces')}
for _k, _v in list(REPLACED_BY_SOLIDS.items()):
    R2_DROPPED[_k] = f'replaced by the sliced solid(s) of arch_solids.json ({_v} ...)'
GLAZING3 = next(e for e in STRUCT3['elements'] if e.get('glazing'))
REFL = STRUCT3['reflection_rule']


# ===================================================================== JPEG embedding
_orig_append_image = trimesh.exchange.gltf._append_image


def _append_image(img, tree, buffer_items, extension_webp):
    """trimesh re-encodes every JPEG at PIL's default quality 75; images that carry their JPEG bytes are embedded as is."""
    raw = getattr(img, '_raw_jpeg', None)
    if raw is None:
        return _orig_append_image(img, tree, buffer_items, extension_webp)
    index = trimesh.exchange.gltf._buffer_append(buffer_items, raw)
    tree['images'].append({'bufferView': index, 'mimeType': 'image/jpeg'})
    return len(tree['images']) - 1


trimesh.exchange.gltf._append_image = _append_image


def jpeg_from_bytes(raw):
    im = Image.open(io.BytesIO(raw)); im.load()
    assert im.format == 'JPEG'
    im._raw_jpeg = raw
    return im


def jpeg_encode(img, q=JPEG_Q):
    b = io.BytesIO(); img.convert('RGB').save(b, format='JPEG', quality=q, optimize=True)
    return jpeg_from_bytes(b.getvalue())


def jpeg_file(path):
    return jpeg_from_bytes(open(path, 'rb').read())


B.jpeg = jpeg_encode      # structure / round-2 object textures: one JPEG encode instead of q90 + q75


def textured(V, F, UV, img, name):
    mat = trimesh.visual.material.PBRMaterial(name=name, baseColorTexture=img, baseColorFactor=[255, 255, 255, 255],
                                              metallicFactor=0.0, roughnessFactor=1.0, doubleSided=False)
    return trimesh.Trimesh(np.asarray(V, float), np.asarray(F, np.int64),
                           visual=trimesh.visual.TextureVisuals(uv=np.asarray(UV, float), material=mat), process=False)


# ===================================================================== ground snap (round-2 rule)
def ground_snap(parts, oid, log):
    """parts: [(name, V, F, extra)]. Round 3: the floor is the smooth fitted scan floor (floor_r3), so an object keeps
    its scanned height; only the bottom ring of its floor-touching parts is placed exactly on the floor surface under
    each vertex (moves within -3..+8 cm). Returns (parts, mean move m)."""
    obot = min(V[:, 1].min() for _, V, _, _ in parts)
    out, moves = [], []
    for name, V, F, extra in parts:
        V = V.copy(); bot = V[:, 1].min()
        if bot < obot + 0.01:
            sel = np.nonzero(V[:, 1] < bot + 1e-4)[0]
            fy = FLOOR_H(V[sel, 0], V[sel, 2])
            gap = V[sel, 1] - fy
            ok = (gap > -0.03) & (gap < GROUND_SNAP)
            V[sel[ok], 1] = fy[ok]; moves += list(gap[ok])
        out.append((name, V, F, extra))
    if not moves:
        return parts, 0.0
    mv = float(np.mean(moves))
    log.append(f'ground {oid}: {len(moves)} bottom-ring vertices onto the floor surface (mean move {-mv * 100:+.2f} cm, '
               f'range {-max(moves) * 100:+.2f}..{-min(moves) * 100:+.2f} cm)')
    return out, mv


# ===================================================================== round-3 furniture
def load_textured_glb(path, tex_for_node):
    """World-space textured meshes of a per-object GLB: [(part name, V, F, (UV, jpeg image))]."""
    s = trimesh.load(path)
    out = []
    for node in s.graph.nodes_geometry:
        T, g = s.graph[node]
        assert np.allclose(T, np.eye(4)), (path, node)
        m = s.geometry[g]
        name = node.split(':')[-1]
        img0 = m.visual.material.baseColorTexture
        img = jpeg_file(tex_for_node(name))
        assert img.size == img0.size, (path, name, img.size, img0.size)
        out.append((name, np.asarray(m.vertices, float), np.asarray(m.faces, np.int64), (np.asarray(m.visual.uv, float), img)))
    return out


def build_furniture(log):
    items, info = [], {}
    for o in OBJS_R3:
        if not o.get('r3_status', '').startswith('rebuilt'):
            continue
        parts = {p['name']: p for p in o['parts']}
        tex = lambda name: os.path.join(OUT, parts[name]['texture']['file'])
        loaded = load_textured_glb(os.path.join(OUT, o['glb']), tex)
        assert sorted(n for n, *_ in loaded) == sorted(parts), o['id']
        loaded, lift = ground_snap(loaded, o['id'], log)
        nf = 0
        for name, V, F, (UV, img) in loaded:
            nm = f"{o['id']}__{name}"
            items.append((nm, textured(V, F, UV, img, nm), np.eye(4))); nf += len(F)
        info[o['id']] = dict(source=o['glb'], parts=len(loaded), triangles=nf, ground_snap_mean_cm=round(-lift * 100, 2))
    return items, info


def build_separate(log):
    items, info = [], {}
    for cid, d in SEPARATE.items():
        loaded = load_textured_glb(os.path.join(OUT3, d['glb']), lambda name: os.path.join(OUT3, d['tex']))
        loaded, lift = ground_snap(loaded, cid, log)
        nf = 0
        for name, V, F, (UV, img) in loaded:
            nm = f'{cid}__{name.replace(cid + "_", "")}'
            items.append((nm, textured(V, F, UV, img, nm), np.eye(4))); nf += len(F)
        info[cid] = dict(source=d['glb'], parts=len(loaded), triangles=nf, ground_snap_mean_cm=round(-lift * 100, 2),
                         fit=CHAIRS_SINGLE[cid]['fit'])
    return items, info


# ===================================================================== meeting-chair template instances
def M_affine(R, t):
    M = np.eye(4); M[:3, :3] = R; M[:3, 3] = t
    return M


def apply(M, P):
    return P @ M[:3, :3].T + M[:3, 3]


def flat_colors(tri_world, rgb):
    """contour.shaded colouring: per-face 0.5..1.0 directional factor, as the chairs step rendered the template."""
    n = np.cross(tri_world[:, 1] - tri_world[:, 0], tri_world[:, 2] - tri_world[:, 0])
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    k = 0.5 + 0.5 * np.clip(n @ CHAIR_LIGHT, 0, 1)
    col = np.repeat(np.clip(np.asarray(rgb, float)[None] * k[:, None], 0, 255), 3, 0)
    return np.c_[np.round(col).astype(np.uint8), np.full(len(col), 255, np.uint8)]


def build_chairs(log):
    tpl = CHAIRS['template']
    tm = template_meshes(tpl['parts'])
    pivot = np.asarray(tpl['tilt_pivot'], float)
    base = [(p, m) for p, m in tm if p.get('group') != 'upper']
    y_top = max(m.vertices[:, 1].max() for p, m in base if p['name'] == 'column')    # column top = shell bottom
    b0 = min(m.vertices[:, 1].min() for _, m in base)                                  # lowest foot point
    items, info = [], {}
    for inst in CHAIRS['instances']:
        pos = np.asarray(inst['position'], float)
        R = CL.Ry(inst['yaw_deg']); Rt = CL.Rx(-inst['pitch_deg'])
        M_place = M_affine(R, pos)
        M_upper = M_place @ M_affine(Rt, pivot - Rt @ pivot)
        fy = float(FLOOR_H(pos[0], pos[2])[0])                  # floor surface under the chair (floor_r3)
        s = (pos[1] + y_top - fy) / (y_top - b0)               # feet exactly on the floor surface, column top unchanged
        S = np.eye(4); S[1, 1] = s; S[1, 3] = y_top * (1 - s)
        M_base = M_place @ S
        # the node matrices reproduce chairs_mesh.instance_mesh (without the base stretch) exactly
        ref = instance_mesh(tm, inst, pivot, per_part=True)
        nf = 0
        leg = CHAIR_TEX['legs'][inst['id']]
        for (p, m), (_, mref) in zip(tm, ref):
            upper = p.get('group') == 'upper'
            M_chk = M_upper if upper else M_place
            assert np.abs(apply(M_chk, m.vertices) - mref.vertices).max() < 1e-9
            M = M_upper if upper else M_base
            if upper:
                # shared template UV layout (chairs_tex.py) + this chair's own baked texture
                k = p['name']
                img = jpeg_file(os.path.join(OUT3, 'chairs_tex', f"{inst['id']}__{k}.jpg"))
                g = textured(CHAIR_LAYOUT[f'{k}_NV'], CHAIR_LAYOUT[f'{k}_NF'], CHAIR_LAYOUT[f'{k}_UV'], img,
                             f"{inst['id']}__{k}")
                items.append((f"{inst['id']}__{k}", g, M)); nf += len(g.faces)
                continue
            if p['name'].startswith('leg_'):
                # foot position from the scan geometry (chairs_feet.py / chairs_tex.json), per chair
                kk = int(p['name'].split('_')[1]) - 1
                a_ = np.radians(leg['theta_deg'] + 90 * kk)
                b_ = [leg['foot_radius'] * np.sin(a_), p['b'][1], leg['foot_radius'] * np.cos(a_)]
                m = tube_mesh(p['a'], b_, p['r_a'], p.get('r_b', p['r_a']), p.get('segments', 12))
            tri = m.triangles.reshape(-1, 3)                     # unindexed template vertices (flat shading)
            rgb = inst['colors']['base']
            C = flat_colors(apply(M, tri).reshape(-1, 3, 3), rgb)
            g = trimesh.Trimesh(tri, np.arange(len(tri)).reshape(-1, 3), vertex_colors=C, process=False)
            items.append((f"{inst['id']}__{p['name']}", g, M)); nf += len(m.faces)
        info[inst['id']] = dict(template='meeting-chair', yaw_deg=inst['yaw_deg'], pitch_deg=inst['pitch_deg'],
                                texture=CHAIR_TEX['textures'][inst['id']], legs=leg,
                                position=inst['position'], base_vertical_scale=round(float(s), 4),
                                feet_shift_cm=round(float((pos[1] + b0 - fy) * -100), 2), triangles=nf)
        log.append(f"chair {inst['id']}: yaw {inst['yaw_deg']:.1f} pitch {inst['pitch_deg']:+.1f} base scale {s:.3f} "
                   f"(feet {pos[1] + b0:.3f} -> floor {fy:.4f})")
    return items, info, sum(len(m.faces) for _, m in tm)


# ===================================================================== round-3 structure (floor_r3, structure_r3)
def build_floor_r3():
    z = np.load(os.path.join(OUT3, 'floor_r3_mesh.npz'))
    img = jpeg_encode(Image.open(os.path.join(OUT, FLOOR3['texture'])))
    m = textured(z['V'], z['F'], z['UV'], img, 'floor')
    assert (m.face_normals[:, 1] > 0).all()
    return m


def build_wall_r3(e):
    C4 = np.array(e['corners'], float); UV = np.array(e['corner_uv'], float)
    F = np.array([(0, 1, 2), (0, 2, 3)])
    n = np.array(e['plane']['normal'], float)
    tri_n = np.cross(C4[F[:, 1]] - C4[F[:, 0]], C4[F[:, 2]] - C4[F[:, 0]])
    F = np.where((tri_n @ n < 0)[:, None], F[:, ::-1], F)                 # every triangle faces the room
    F = F[np.linalg.norm(tri_n, axis=1) > 1e-6]                           # jogs: drop degenerate slivers
    img = jpeg_file(os.path.join(OUT, e['texture']))
    m = textured(C4, F, UV, img, e['id'])
    assert (m.face_normals @ n > (0.98 if 'jog' not in e['id'] else 0.5)).all(), e['id']
    return m


def build_solids(log):
    items, info = [], {}
    for so in SOLIDS:
        parts = {p['name']: p for p in so['parts']}
        loaded = load_textured_glb(os.path.join(OUT, so['glb']), lambda name: os.path.join(OUT, parts[name]['texture']['file']))
        if so.get('stands_on_floor'):
            loaded, lift = ground_snap(loaded, so['id'], log)
        else:
            lift = 0.0
        nf = 0
        for name, V, F, (UV, img) in loaded:
            nm = f"{so['id']}__{name}"
            items.append((nm, textured(V, F, UV, img, nm), np.eye(4))); nf += len(F)
        info[so['id']] = dict(source=so['glb'], parts=len(loaded), triangles=nf, ground_snap_mean_cm=round(-lift * 100, 2),
                              replaces=so.get('replaces'), fit=so['fit']['metrics'])
    return items, info


# ===================================================================== round-2 objects that round 3 did not replace
def build_r2_rest(log):
    replaced = {o['id'] for o in OBJS_R3 if o.get('r3_status', '').startswith('rebuilt')}
    replaced |= set(TEMPLATE_IDS) | set(SEPARATE)
    keep = [o for o in B.OBJS if o['id'] not in replaced and o['id'] not in R2_DROPPED]
    for o in B.OBJS:
        if o['id'] in R2_DROPPED:
            log.append(f"drop object {o['id']}: {R2_DROPPED[o['id']]}")
    all_objs, fy0 = B.OBJS, B.FLOOR_Y
    meshes = []
    try:
        for o in keep:                 # round-2 snap rule, but onto the fitted floor surface under each object
            c = 0.5 * (np.array(o['bbox']['min']) + np.array(o['bbox']['max']))
            B.FLOOR_Y = float(FLOOR_H(c[0], c[2])[0])
            B.OBJS = [o]
            meshes += B.build_objects(log)
    finally:
        B.OBJS, B.FLOOR_Y = all_objs, fy0
    return [(n, m, np.eye(4)) for n, m in meshes], [o['id'] for o in keep]


# ===================================================================== GLB post-processing
def glb_dedupe(data):
    """Share identical bufferViews (chair template vertex / index buffers repeated per instance) and verify that
    every image is JPEG. Returns (bytes, stats)."""
    magic, ver, _ = struct.unpack('<III', data[:12]); assert magic == 0x46546C67
    jl, jt = struct.unpack('<II', data[12:20]); js = json.loads(data[20:20 + jl])
    o = 20 + jl; bl, bt = struct.unpack('<II', data[o:o + 8]); binb = data[o + 8:o + 8 + bl]
    views = js['bufferViews']; seen, remap, new_views, blobs, pos = {}, {}, [], [], 0
    for i, v in enumerate(views):
        b = binb[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]
        key = (hashlib.sha1(b).hexdigest(), v.get('byteStride'), v.get('target'))
        if key in seen:
            remap[i] = seen[key]; continue
        nv = dict(v); nv['buffer'] = 0; nv['byteOffset'] = pos
        pad = (-len(b)) % 4
        blobs.append(b + b'\0' * pad); pos += len(b) + pad
        new_views.append(nv); seen[key] = remap[i] = len(new_views) - 1
    for a in js.get('accessors', []):
        a['bufferView'] = remap[a['bufferView']]
    for im in js.get('images', []):
        im['bufferView'] = remap[im['bufferView']]
        assert im['mimeType'] == 'image/jpeg', im
    js['bufferViews'] = new_views; js['buffers'] = [{'byteLength': pos}]
    jb = json.dumps(js, separators=(',', ':')).encode(); jb += b' ' * ((-len(jb)) % 4)
    bb = b''.join(blobs)
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(jb) + 8 + len(bb)) + struct.pack('<II', len(jb), 0x4E4F534A) + jb \
        + struct.pack('<II', len(bb), 0x004E4942) + bb
    return out, dict(bufferviews_before=len(views), bufferviews_after=len(new_views), bin_bytes_before=bl,
                     bin_bytes_after=len(bb), images=len(js.get('images', [])),
                     image_bytes=int(sum(new_views[im['bufferView']]['byteLength'] for im in js.get('images', []))))


# ===================================================================== metrics
def world_triangles(path):
    s = trimesh.load(path)
    tris = []
    for node in s.graph.nodes_geometry:
        T, g = s.graph[node]
        tri = s.geometry[g].triangles
        tris.append(trimesh.transform_points(tri.reshape(-1, 3), T).reshape(-1, 3, 3))
    return np.concatenate(tris)


def exact_distance(P, tri, k=8, density=4000.0, seed=3, chunk=1_500_000):
    """Exact point -> nearest triangle distance (m)."""
    from rtree import index
    n = len(tri)
    m = trimesh.Trimesh(tri.reshape(-1, 3), np.arange(3 * n).reshape(-1, 3), process=False)
    S, fi = trimesh.sample.sample_surface(m, int(m.area * density), seed=seed)
    S = np.r_[S, tri.mean(1)]; fi = np.r_[fi, np.arange(n)]            # every triangle has >= 1 sample
    _, nn = cKDTree(S).query(P, k=k)
    ub = np.full(len(P), np.inf)
    for j in range(k):
        cp = trimesh.triangles.closest_point(tri[fi[nn[:, j]]], P)
        ub = np.minimum(ub, np.linalg.norm(cp - P, axis=1))
    lo, hi = tri.min(1), tri.max(1)
    prop = index.Property(); prop.dimension = 3
    idx = index.Index(((i, (*lo[i], *hi[i]), None) for i in range(n)), properties=prop)
    d = ub.copy(); npairs = 0
    for a in range(0, len(P), 20000):
        Pa, ua = P[a:a + 20000], ub[a:a + 20000] + 1e-7
        ids, cnt = idx.intersection_v(Pa - ua[:, None], Pa + ua[:, None])
        ids, cnt = ids.astype(np.int64), cnt.astype(np.int64)
        rep = np.repeat(np.arange(len(Pa)), cnt)
        gap = np.maximum(0.0, np.maximum(lo[ids] - Pa[rep], Pa[rep] - hi[ids]))
        keep = np.einsum('ij,ij->i', gap, gap) <= ua[rep] ** 2
        ids, rep = ids[keep], rep[keep]; npairs += len(ids)
        da = d[a:a + 20000]
        for c in range(0, len(ids), chunk):
            ii, rr = ids[c:c + chunk], rep[c:c + chunk]
            dd = np.linalg.norm(trimesh.triangles.closest_point(tri[ii], Pa[rr]) - Pa[rr], axis=1)
            np.minimum.at(da, rr, dd)
    return d, dict(candidate_pairs=int(npairs), points_tightened=int((d < ub - 1e-9).sum()),
                   max_tightening_cm=round(float((ub - d).max() * 100), 3))


def stats(d):
    d = np.asarray(d) * 100
    return dict(n=int(len(d)), mean_cm=round(float(d.mean()), 2), median_cm=round(float(np.median(d)), 2),
                p90_cm=round(float(np.percentile(d, 90)), 2), within_2cm_pct=round(float((d <= 2).mean() * 100), 1),
                within_5cm_pct=round(float((d <= 5).mean() * 100), 1), within_10cm_pct=round(float((d <= 10).mean() * 100), 1))


def zone_masks(P):
    """Scan points inside each furniture object's box (+5 cm): where round 3 changed the model."""
    out = {}
    o2 = {o['id']: o for o in B.OBJS}
    for oid in [o['id'] for o in OBJS_R3 if o.get('r3_status', '').startswith('rebuilt')] + TEMPLATE_IDS + list(SEPARATE):
        bb = o2[oid]['bbox']
        lo = np.array(bb['min']) - 0.05; hi = np.array(bb['max']) + 0.05
        lo[1] = max(lo[1], FLOOR_Y + 0.02)                     # exclude the floor under the object
        out[oid] = np.all((P >= lo) & (P <= hi), axis=1)
    return out


def categories(P, N, C, zones, inside):
    """Per-point category (same split as r3/gap_analysis.py) + the reflection mask of structure_r3.json."""
    gz = REFL['plane_z']
    refl = (P[:, 2] > gz + REFL['beyond_m']) & ((C[:, 2].astype(int) - C[:, 0].astype(int)) > REFL['blue_minus_red'])
    fur = np.zeros(len(P), bool)
    for m in zones.values():
        fur |= m
    fl = FLOOR_H(P[:, 0], P[:, 2])
    floorish = (N[:, 1] > 0.85) & (P[:, 1] < fl + 0.15) & ~fur
    vert = np.abs(N[:, 1]) < 0.3
    cat = np.where(refl, 'reflection', np.where(fur, 'furniture', np.where(~inside, 'outside_footprint',
                   np.where(floorish, 'floor', np.where(vert & (P[:, 1] > 0.3), 'wall_or_vertical_inside', 'other_inside')))))
    return cat, refl


def measure(path, P, inside, zones, cat=None, refl=None, inside_grid=None):
    tri = world_triangles(path)
    d, dbg = exact_distance(P, tri)
    r = dict(glb=path, glb_bytes=os.path.getsize(path), glb_mb=round(os.path.getsize(path) / 1e6, 2), triangles=int(len(tri)),
             overall=stats(d), inside_floor_footprint=dict(stats(d[inside]), frac_pts=round(float(inside.mean()), 3)),
             outside_floor_footprint=dict(stats(d[~inside]), frac_pts=round(float((~inside).mean()), 3)),
             exact_pass=dbg)
    if inside_grid is not None:
        r['inside_r2_grid_footprint'] = dict(stats(d[inside_grid]), frac_pts=round(float(inside_grid.mean()), 3))
        r['outside_r2_grid_footprint'] = dict(stats(d[~inside_grid]), frac_pts=round(float((~inside_grid).mean()), 3))
    if refl is not None:
        r['overall_excl_reflections'] = dict(stats(d[~refl]), frac_pts=round(float((~refl).mean()), 3))
        r['reflections'] = dict(stats(d[refl]), frac_pts=round(float(refl.mean()), 3))
    if cat is not None:
        tot = d[~refl].sum() if refl is not None else d.sum()
        r['categories'] = {c: dict(stats(d[cat == c]), frac_pts=round(float((cat == c).mean()), 3),
                                   share_of_error_excl_reflections_pct=(round(float(d[cat == c].sum() / tot * 100), 1)
                                                                        if c != 'reflection' else None))
                           for c in np.unique(cat)}
    allz = np.zeros(len(P), bool)
    for m in zones.values():
        allz |= m
    r['furniture_zones_all'] = dict(stats(d[allz]), frac_pts=round(float(allz.mean()), 3))
    r['zones'] = {k: stats(d[m]) for k, m in zones.items() if m.sum() >= 50}
    return r, d


# ===================================================================== main
def main():
    t0 = time.time(); log = []
    items = []                                              # (node name, trimesh, 4x4)
    floor = build_floor_r3()
    items.append(('floor', floor, np.eye(4)))
    log.append(f"floor: floor_r3 outline(s) {FLOOR3['area_m2']} m2 ({len(FLOOR3['polygons'])} pieces), "
               f"{len(floor.faces)} triangles on the fitted scan-floor surface")
    nstruct = 1
    for e in STRUCT3['elements']:
        if e['kind'] == 'wall':
            items.append((e['id'], build_wall_r3(e), np.eye(4))); nstruct += 1
    sol_items, sol_info = build_solids(log)
    r2_items, r2_kept = build_r2_rest(log)
    fur_items, fur_info = build_furniture(log)
    sep_items, sep_info = build_separate(log)
    ch_items, ch_info, tpl_faces = build_chairs(log)
    items += sol_items + r2_items + fur_items + sep_items + ch_items
    sc = trimesh.Scene()
    names = set()
    for name, m, M in items:
        assert name not in names, name; names.add(name)
        sc.add_geometry(m, geom_name=name, node_name=name, transform=M)
    raw = sc.export(file_type='glb')
    data, dd = glb_dedupe(raw)
    os.makedirs(SPIKE_OUT, exist_ok=True)
    open(GLB, 'wb').write(data)
    ntri = int(sum(len(m.faces) for _, m, _ in items))
    print(f'wrote {GLB}  {len(data) / 1e6:.2f} MB (images {dd["image_bytes"] / 1e6:.2f} MB, all JPEG)  '
          f'triangles {ntri}  nodes {len(items)}  ({time.time() - t0:.1f}s)')
    for l in log:
        print('  ' + l)
    groups = dict(structure=nstruct, arch_solids=sorted(sol_info), r2_objects=r2_kept, r3_furniture=sorted(fur_info),
                  chair_template_instances=TEMPLATE_IDS, separate_chairs=sorted(sep_info))
    res = dict(glb=GLB, glb_bytes=len(data), glb_mb=round(len(data) / 1e6, 2), triangles=ntri, nodes=len(items),
               glb_buffers=dd, groups=groups, chair_template_triangles=tpl_faces, furniture=fur_info, separate=sep_info,
               chairs=ch_info, arch_solids=sol_info, floor='out/r3/floor_r3.json (fitted surface, continuous outline)',
               structure='out/r3/structure_r3.json', jpeg_quality_structure=JPEG_Q,
               chair10_choice='furniture-step model (glb/chair-10.glb): scan->model 0.61 cm vs 0.54 cm, model->scan 4.13 cm '
                              'vs 5.76 cm for the chairs-step chair-10_loft_tex.glb', log=log)
    if '--no-metrics' not in sys.argv:
        from common import sample_surface
        P, Cs, Ns, _ = sample_surface(300.0, seed=7)
        keep = P[:, 1] <= 2.4
        P, Cs, Ns = P[keep], Cs[keep], Ns[keep]
        occ = np.load(os.path.join(OUT, B.FLOOR['footprint_grid']))
        iz = np.clip((P[:, 2] / 0.1).astype(int), 0, occ.shape[0] - 1); ix = np.clip((P[:, 0] / 0.1).astype(int), 0, occ.shape[1] - 1)
        inside_grid = occ[iz, ix].astype(bool)
        inside = shapely.contains_xy(FLOOR_POLY, P[:, 0], P[:, 2])          # continuous floor outline (floor_r3)
        zones = zone_masks(P)
        cat, refl = categories(P, Ns, Cs, zones, inside)
        runs = {}
        for key, path in (('r3', GLB), ('r3_prev', GLB_PREV), ('r2', GLB_R2)):
            t1 = time.time()
            runs[key] = measure(path, P, inside, zones, cat, refl, inside_grid)
            print(f'{key} metrics {time.time() - t1:.0f}s')
        (m3, d3), (mp, dp), (m2, d2) = runs['r3'], runs['r3_prev'], runs['r2']
        np.savez_compressed(os.path.join(OUT3, 'metrics_r3_point_dist.npz'), P=P, d_r3=d3, d_prev=dp, d_r2=d2, cat=cat.astype('U24'))
        res['metrics'] = dict(method='scan sample_surface(300/m2, seed=7), y<=2.4 -> exact distance to nearest model triangle; '
                                     'inside/outside = continuous floor_r3 outline (the r2 10 cm grid split is kept as '
                                     'inside_r2_grid_footprint for comparison); reflections = samples > 10 cm beyond the '
                                     'south glass with B-R > 25 (city reflections, not solid)',
                              scan_points=int(len(P)), reflection_points=int(refl.sum()), r3=m3, r3_previous_step=mp,
                              r2_same_method=m2,
                              improved_vs_prev_pct=round(float((d3 < dp - 0.005).mean() * 100), 1),
                              worse_vs_prev_pct=round(float((d3 > dp + 0.005).mean() * 100), 1),
                              improved_vs_r2_pct=round(float((d3 < d2 - 0.005).mean() * 100), 1),
                              worse_vs_r2_pct=round(float((d3 > d2 + 0.005).mean() * 100), 1))
        show = lambda r: {k: r[k] for k in ('triangles', 'glb_mb', 'overall', 'overall_excl_reflections',
                                            'inside_floor_footprint', 'outside_floor_footprint', 'furniture_zones_all')}
        print(json.dumps(dict(r3=show(m3), r3_prev=show(mp), r2=show(m2)), ensure_ascii=False, indent=1))
        print(f'{"category":<26}' + ''.join(f'{k + " mean":>13}{k + " p90":>12}' for k in ('r3', 'prev', 'r2')))
        for c in m3['categories']:
            print(f'{c:<26}' + ''.join(f'{r["categories"][c]["mean_cm"]:>13}{r["categories"][c]["p90_cm"]:>12}' for r in (m3, mp, m2))
                  + f'  frac {m3["categories"][c]["frac_pts"]}')
        print(f'{"zone":<15}{"r3 mean":>9}{"r3 p90":>8}{"prev mean":>10}{"prev p90":>9}{"r2 mean":>9}{"r2 p90":>8}{"n":>7}')
        for k in m3['zones']:
            a, b, c = m3['zones'][k], mp['zones'][k], m2['zones'][k]
            print(f'{k:<15}{a["mean_cm"]:>9}{a["p90_cm"]:>8}{b["mean_cm"]:>10}{b["p90_cm"]:>9}{c["mean_cm"]:>9}{c["p90_cm"]:>8}{a["n"]:>7}')
    json.dump(res, open(METRICS, 'w'), ensure_ascii=False, indent=1)
    print(f'done ({time.time() - t0:.1f}s) -> {METRICS}')


if __name__ == '__main__':
    main()
