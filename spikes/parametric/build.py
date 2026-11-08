"""structure.json + objects.json -> one parametric scene GLB (round 2).

Output: spike/out/parametric.glb (the viewer's models/ dir) and out/metrics_r2.json.
Run refine_r2.py first (it writes the round-2 objects.json / structure.json / textures).

Scene contents
  floor            textured single-sided quads covering floor_footprint_10cm.npy (runs merged), y = plane offset
  wall_* / glazing textured single-sided quad per element on its room-facing plane (corners from the json,
                   column 0 = corners[0], row 0 = top). Single-sided on purpose: like the scan, a wall seen from
                   outside is culled, so the fixed "dollhouse" camera looks into the room. Includes the round-2
                   glazing_east_1 / glazing_east_2 and the re-baked south glazing.
  <object id>      per object: one vertex-coloured mesh with all primitives (box / cylinder / cone / bicone /
                   extrude / profile_extrude) in world space, flat-shaded per-vertex sRGB bytes
                   (colour x 1.0 top / 0.92-1.0 sides by direction / 0.85 bottom; the viewer is unlit and the
                   measured colours already contain the scan's baked lighting), plus one textured mesh per object
                   texture (faces of the listed parts whose normal matches the texture's view direction, planar UVs).

Reconciliation with the structure step:
  * logo-wall-01 (flat-colour boxes) is dropped: wall_a210_1 is the same wall with the real baked logo texture.
  * screen-01/led_panel is dropped: it lies inside the slab behind wall_z1.39_1, whose texture is the screen image.
  * parts that stand on the (warped) scan floor up to 8 cm above the flat model floor are stretched down to it.
Metrics: scan surface sampled at 300 pts/m2 (y <= 2.4) -> exact distance to the nearest model triangle.
"""
import os, sys, io, json, time
import numpy as np
import trimesh
from PIL import Image
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from prims import object_part_meshes

OUT = os.path.join(HERE, 'out')
SPIKE_OUT = os.path.join(os.path.dirname(HERE), 'spike', 'out')
GLB = os.path.join(SPIKE_OUT, 'parametric.glb')
METRICS = os.path.join(OUT, 'metrics_r2.json')

STRUCT = json.load(open(os.path.join(OUT, 'structure.json')))
OBJS = json.load(open(os.path.join(OUT, 'objects.json')))
FLOOR = next(e for e in STRUCT['elements'] if e['kind'] == 'floor')
FLOOR_Y = float(FLOOR['plane']['offset'])

DROP_OBJECTS = {'logo-wall-01': 'superseded by textured structure wall wall_a210_1 (real logo artwork)'}
DROP_PARTS = {('screen-01', 'led_panel'): 'inside the slab behind wall_z1.39_1, whose baked texture is the screen'}
GROUND_SNAP = 0.08   # parts whose bottom is <= this far above the model floor are stretched down to it
JPEG_Q = 90


# ------------------------------------------------------------------ helpers
def jpeg(img):
    """Re-encode as JPEG in memory so trimesh embeds it without converting to PNG."""
    b = io.BytesIO(); img.convert('RGB').save(b, format='JPEG', quality=JPEG_Q); b.seek(0)
    im = Image.open(b); im.load(); return im


def textured(V, F, UV, img, name):
    mat = trimesh.visual.material.PBRMaterial(name=name, baseColorTexture=img, baseColorFactor=[255, 255, 255, 255],
                                              metallicFactor=0.0, roughnessFactor=1.0, doubleSided=False)
    vis = trimesh.visual.TextureVisuals(uv=UV, material=mat)
    return trimesh.Trimesh(np.asarray(V, float), np.asarray(F, np.int64), visual=vis, process=False)


# ------------------------------------------------------------------ floor
def build_floor():
    occ = np.load(os.path.join(OUT, FLOOR['footprint_grid']))     # [z, x] 10 cm cells
    g = 0.1
    (x0, x1), (z0, z1) = FLOOR['rect']['x'], FLOOR['rect']['z']
    rects, open_runs = [], {}
    for iz in range(occ.shape[0] + 1):
        runs = set()
        if iz < occ.shape[0]:
            row = np.r_[False, occ[iz], False].astype(np.int8)
            d = np.diff(row); s = np.nonzero(d == 1)[0]; e = np.nonzero(d == -1)[0]
            runs = set(zip(s.tolist(), e.tolist()))
        nxt = {}
        for r in runs:
            nxt[r] = open_runs.pop(r) if r in open_runs else iz
        for (a, b), zs in open_runs.items():
            rects.append((a, b, zs, iz))
        open_runs = nxt
    V, F, UV = [], [], []
    for a, b, zs, ze in rects:
        xa, xb, za, zb = a * g, b * g, zs * g, ze * g
        k = len(V)
        for x, z in ((xa, za), (xb, za), (xb, zb), (xa, zb)):
            V.append((x, FLOOR_Y, z))
            UV.append(((x - x0) / (x1 - x0), 1.0 - (z - z0) / (z1 - z0)))   # col 0 = x0, row 0 = z0; v from the bottom
        F += [(k, k + 3, k + 2), (k, k + 2, k + 1)]           # normal +y
    img = jpeg(Image.open(os.path.join(OUT, FLOOR['texture'])))
    m = textured(V, F, UV, img, 'floor')
    assert (m.face_normals[:, 1] > 0.99).all()
    return m, len(rects), float(occ.sum() * g * g)


# ------------------------------------------------------------------ walls / glazing
def build_wall(e):
    C = np.array(e['corners'], float)                        # LB, RB, RT, LT as seen from the room
    UV = np.array([(0, 0), (1, 0), (1, 1), (0, 1)], float)   # col 0 = corners[0], row 0 (image top) = y max
    F = np.array([(0, 1, 2), (0, 2, 3)])
    img = jpeg(Image.open(os.path.join(OUT, e['texture'])))
    m = textured(C, F, UV, img, e['id'])
    n = np.array(e['plane']['normal'], float)
    assert (m.face_normals @ n > 0.99).all(), e['id']
    return m


# ------------------------------------------------------------------ objects
L_SIDE = np.array([-0.6, 0.0, -0.8]); L_SIDE /= np.linalg.norm(L_SIDE)   # roughly towards the default camera


def face_factor(fn):
    """Small direction-dependent shading so shapes read in the unlit viewer (colours already hold scan lighting)."""
    side = 0.92 + 0.08 * (0.5 + 0.5 * (fn @ L_SIDE) / np.maximum(np.hypot(fn[:, 0], fn[:, 2]), 1e-9))
    side = side * (1.0 + 0.15 * fn[:, 1])            # slanted faces: tilted up a bit brighter, tilted down darker
    return np.where(fn[:, 1] > 0.7, 1.0, np.where(fn[:, 1] < -0.7, 0.85, side))


def texture_specs(o):
    specs = list(o.get('textures', []))
    for p in o['parts']:
        if isinstance(p.get('texture'), dict):
            specs.append(dict(p['texture'], parts=[p['name']]))
    return specs


def build_objects(log):
    meshes = []
    for o in OBJS:
        if o['id'] in DROP_OBJECTS:
            log.append(f"drop object {o['id']}: {DROP_OBJECTS[o['id']]}")
            continue
        pm = []
        for p, m, fc in object_part_meshes(o):
            if (o['id'], p['name']) in DROP_PARTS:
                log.append(f"drop part {o['id']}/{p['name']}: {DROP_PARTS[(o['id'], p['name'])]}")
                continue
            pm.append((p, m, fc))
        obot = min(m.vertices[:, 1].min() for _, m, _ in pm)
        snap = FLOOR_Y + 0.003 < obot <= FLOOR_Y + GROUND_SNAP
        if snap:
            log.append(f"ground {o['id']}: bottom {obot:.3f} -> {FLOOR_Y:.3f} (parts touching the floor stretched down)")
        specs = texture_specs(o)
        tex_faces = [([], []) for _ in specs]                 # per spec: world triangles, uv triangles
        Vs, Cs = [], []
        for p, m, fc in pm:
            V = m.vertices.copy()
            bot = V[:, 1].min()
            if snap and bot < obot + 0.01:
                V[V[:, 1] < bot + 1e-4, 1] = FLOOR_Y
            m = trimesh.Trimesh(V, m.faces, process=False)
            fn = m.face_normals
            tri = V[m.faces]                                   # (F,3,3) unmerged: flat colour per face
            plain = np.ones(len(m.faces), bool)
            for si, s in enumerate(specs):
                if p['name'] not in s['parts']:
                    continue
                sel = plain & (fn @ np.array(s['normal'], float) > 0.9)
                if not sel.any():
                    continue
                d = tri[sel] - np.array(s['origin'], float)
                col = d @ np.array(s['u_vec'], float) / s['px']; row = d @ np.array(s['v_vec'], float) / s['px']
                uv = np.clip(np.stack([col / s['size'][0], 1.0 - row / s['size'][1]], -1), 0.0, 1.0)   # snapped bottoms: clamp
                tex_faces[si][0].append(tri[sel]); tex_faces[si][1].append(uv)
                plain &= ~sel
            col = np.clip(fc * face_factor(fn)[:, None], 0, 255)
            Vs.append(tri[plain].reshape(-1, 3)); Cs.append(np.repeat(col[plain], 3, axis=0))
        V = np.concatenate(Vs); F = np.arange(len(V)).reshape(-1, 3)
        Cc = np.c_[np.round(np.concatenate(Cs)).astype(np.uint8), np.full(len(V), 255, np.uint8)]
        meshes.append((o['id'], trimesh.Trimesh(V, F, vertex_colors=Cc, process=False)))
        for si, s in enumerate(specs):
            if not tex_faces[si][0]:
                log.append(f"texture {s['file']} of {o['id']}: no matching faces")
                continue
            T = np.concatenate(tex_faces[si][0]); U = np.concatenate(tex_faces[si][1])
            Vt = T.reshape(-1, 3); Ft = np.arange(len(Vt)).reshape(-1, 3)
            img = jpeg(Image.open(os.path.join(OUT, s['file'])))
            tm = textured(Vt, Ft, U.reshape(-1, 2), img, f"{o['id']}_{os.path.basename(s['file'])[:-4]}")
            assert (tm.face_normals @ np.array(s['normal'], float) > 0.9).all()
            meshes.append((f"{o['id']}__{os.path.basename(s['file'])[:-4]}", tm))
            log.append(f"texture {os.path.basename(s['file'])} on {o['id']}: {len(Ft)} faces, uv range "
                       f"[{U[..., 0].min():.2f},{U[..., 0].max():.2f}]x[{U[..., 1].min():.2f},{U[..., 1].max():.2f}]")
    return meshes


# ------------------------------------------------------------------ metrics
def metrics(model, density=300.0, ymax=2.4, model_density=4000.0):
    from common import sample_surface
    P, _, _, _ = sample_surface(density, seed=7)
    P = P[P[:, 1] <= ymax]
    S, fi = trimesh.sample.sample_surface(model, int(model.area * model_density), seed=3)
    tree = cKDTree(S)
    k = 8
    _, nn = tree.query(P, k=k)
    tri = model.triangles
    best = np.full(len(P), np.inf)
    for j in range(k):
        cp = trimesh.triangles.closest_point(tri[fi[nn[:, j]]], P)
        best = np.minimum(best, np.linalg.norm(cp - P, axis=1))
    return P, best * 100


def summary(d, msk=None):
    if msk is not None:
        d = d[msk]
    return dict(frac_pts=None, mean_cm=round(float(d.mean()), 2), p90_cm=round(float(np.percentile(d, 90)), 2),
                within_10cm_pct=round(float((d <= 10).mean() * 100), 1))


def main():
    t0 = time.time(); log = []
    sc = trimesh.Scene()
    allm = []
    floor, nrect, farea = build_floor()
    sc.add_geometry(floor, geom_name='floor', node_name='floor'); allm.append(floor)
    log.append(f'floor: {nrect} merged rectangles, {farea:.1f} m2, y={FLOOR_Y}')
    nstruct = 1
    for e in STRUCT['elements']:
        if e['kind'] != 'wall':
            continue
        w = build_wall(e)
        sc.add_geometry(w, geom_name=e['id'], node_name=e['id']); allm.append(w); nstruct += 1
    objs = build_objects(log)
    for name, m in objs:
        sc.add_geometry(m, geom_name=name, node_name=name); allm.append(m)
    os.makedirs(SPIKE_OUT, exist_ok=True)
    if os.path.islink(GLB):
        os.remove(GLB)
    sc.export(GLB)
    ntri = int(sum(len(g.faces) for g in sc.geometry.values()))
    size = os.path.getsize(GLB)
    print(f'wrote {GLB}  {size / 1e6:.2f} MB  triangles {ntri}  meshes {len(sc.geometry)}  ({time.time() - t0:.1f}s)')
    for l in log:
        print('  ' + l)
    res = dict(glb=GLB, glb_bytes=size, triangles=ntri, n_meshes=len(sc.geometry),
               n_objects=sum(1 for o in OBJS if o['id'] not in DROP_OBJECTS), n_structure=nstruct,
               n_parts=int(sum(len(o['parts']) for o in OBJS if o['id'] not in DROP_OBJECTS)),
               floor_y=FLOOR_Y, log=log)
    if '--no-metrics' not in sys.argv:
        model = trimesh.util.concatenate([trimesh.Trimesh(m.vertices, m.faces, process=False) for m in allm])
        P, d = metrics(model)
        res.update(scan_points=int(len(P)), mean_cm=round(float(d.mean()), 2), median_cm=round(float(np.median(d)), 2),
                   p90_cm=round(float(np.percentile(d, 90)), 2), within_5cm_pct=round(float((d <= 5).mean() * 100), 1),
                   within_10cm_pct=round(float((d <= 10).mean() * 100), 1),
                   within_20cm_pct=round(float((d <= 20).mean() * 100), 1))
        occ = np.load(os.path.join(OUT, FLOOR['footprint_grid']))
        iz = np.clip((P[:, 2] / 0.1).astype(int), 0, occ.shape[0] - 1); ix = np.clip((P[:, 0] / 0.1).astype(int), 0, occ.shape[1] - 1)
        inside = occ[iz, ix]
        regions = {'inside_footprint': inside, 'outside_footprint': ~inside,
                   'south_window_z>15.3': P[:, 2] > 15.3, 'east_x>9.6': P[:, 0] > 9.6}
        big = d > 10
        for nm, msk in regions.items():
            r = summary(d, msk); r['frac_pts'] = round(float(msk.mean()), 3)
            r['share_of_>10cm_errors'] = round(float((big & msk).sum() / max(big.sum(), 1)), 3)
            res[nm] = r
        print(json.dumps({k: v for k, v in res.items() if k != 'log'}, ensure_ascii=False, indent=1))
    json.dump(res, open(METRICS, 'w'), ensure_ascii=False, indent=1)
    print(f'done ({time.time() - t0:.1f}s)')


if __name__ == '__main__':
    main()
