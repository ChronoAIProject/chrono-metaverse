"""Round-3 test of contour.py on one object: scan sub-mesh -> sections -> loft -> texture transfer -> GLBs + fit.

usage: python -I r3/test_object.py [object id] [--sym]
Outputs (out/r3/): <id>_loft.json (loft parts, object-local), <id>_loft_tex.glb, <id>_loft_geom.glb (shaded, no
texture), <id>_scan.glb (original scan sub-mesh re-baked through transfer_texture = self-test), <id>_r2.glb (round-2
primitives), <id>_fit.json (fit metrics), <id>_tex.jpg (baked atlas).
"""
import os, sys, json, time
import numpy as np
import trimesh
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import contour as C                      # noqa: E402
from prims import object_part_meshes     # noqa: E402

oid = next((a for a in sys.argv[1:] if not a.startswith('--')), 'sofa-01')
SYM = '--sym' in sys.argv
OUTD = os.path.join(C.OUT, 'r3'); os.makedirs(OUTD, exist_ok=True)
tag = oid + ('_sym' if SYM else '')
t00 = time.time()
o = next(x for x in json.load(open(os.path.join(C.OUT, 'objects.json'))) if x['id'] == oid)
T = o['transform']

# 1. scan sub-mesh
t = time.time(); om = C.object_mesh(o['bbox'], pad=0.06)
print('object_mesh', om['stats'], f'floor {om["floor_y"]:.3f}  ({time.time() - t:.1f}s)')
lm = C.local_mesh(om['mesh'], T)

# 2. sections
t = time.time()
res = C.slice_contours(lm, axis='y', symmetry='u' if SYM else None)
prm = res['params']
print(f'slice_contours: {len(res["levels"])} levels ({time.time() - t:.1f}s)', 'features', prm.get('features'),
      'mirror', res['mirror'])

# 3. loft parts
parts = C.lofts_from_levels(res, name='body')
for p in parts:
    p['color_rgb'] = o['parts'][0].get('color_rgb', [200, 200, 200])
meshes, infos = [], []
for p in parts:
    m, inf = C.loft(p['sections'], return_info=True); meshes.append(m); infos.append(inf)
    print(f'  loft {p["name"]}: {len(p["sections"])} sections, {inf}')
loft_local = trimesh.util.concatenate(meshes)
loft_world = C.world_mesh(loft_local, T)
print('loft: faces', len(loft_world.faces), 'watertight', loft_world.is_watertight, 'volume', round(loft_world.volume, 4))

# 4. texture transfer (loft) + self-test on the original scan sub-mesh
t = time.time()
tex_mesh, img, tinfo = C.transfer_texture(loft_world, scan=om, frame_R=C.Ry(T['yaw_deg']))
print('transfer_texture loft', tinfo, f'({time.time() - t:.1f}s)')
img.save(os.path.join(OUTD, f'{tag}_tex.jpg'), quality=92)
t = time.time()
scan_tex, simg, sinfo = C.transfer_texture(om['mesh'], scan=om, frame_R=C.Ry(T['yaw_deg']), max_dist=0.02, normal_min=0.5)
print('transfer_texture scan (self-test)', sinfo, f'({time.time() - t:.1f}s)')

# 5. fit metrics: loft vs round-2 primitives
t = time.time()
r2 = trimesh.util.concatenate([trimesh.Trimesh(m.vertices, m.faces, process=False) for _, m, _ in object_part_meshes(o)])
fit = dict(object=oid, symmetry=SYM, scan_area_m2=round(float(om['mesh'].area), 3),
           loft=C.fit_report(om['mesh'], loft_world), r2_boxes=C.fit_report(om['mesh'], r2),
           loft_faces=int(len(loft_world.faces)), loft_parts=len(parts),
           loft_sections=int(sum(len(p['sections']) for p in parts)),
           outline_vertices=int(sum(len(s['outline']) for p in parts for s in p['sections'])),
           observed_outline_fraction=round(float(np.mean([L['observed'] for L in res['levels'] if L['method'] != 'ground-extension'])), 3),
           params={k: (round(v, 4) if isinstance(v, float) else v) for k, v in prm.items()},
           mirror=res['mirror'], texture=tinfo, scan_selftest_texture=sinfo, object_mesh=om['stats'])
print(f'fit ({time.time() - t:.1f}s)')
print(json.dumps({k: fit[k] for k in ('loft', 'r2_boxes')}, indent=1))
json.dump(fit, open(os.path.join(OUTD, f'{tag}_fit.json'), 'w'), indent=1, ensure_ascii=False)

# 6. loft primitive JSON (object-local)
json.dump(dict(id=oid, transform=T, parts=parts, source='r3/contour.py slice_contours + lofts_from_levels',
               texture=f'{tag}_tex.jpg'), open(os.path.join(OUTD, f'{tag}_loft.json'), 'w'))

# 7. GLBs for the viewer (world coordinates)
C.export_glb(os.path.join(OUTD, f'{tag}_loft_tex.glb'), [(f'{oid}_loft', tex_mesh)])
C.export_glb(os.path.join(OUTD, f'{tag}_loft_geom.glb'), [(f'{oid}_geom', C.shaded(loft_world))])
C.export_glb(os.path.join(OUTD, f'{oid}_scan.glb'), [(f'{oid}_scan', scan_tex)])
C.export_glb(os.path.join(OUTD, f'{oid}_scan_geom.glb'), [(f'{oid}_scan_geom', C.shaded(om['mesh']))])
C.export_glb(os.path.join(OUTD, f'{oid}_r2.glb'), [(f'{oid}_r2', C.shaded(r2, o['parts'][0].get('color_rgb', [200, 200, 200])))])
print(f'done ({time.time() - t00:.1f}s)')
