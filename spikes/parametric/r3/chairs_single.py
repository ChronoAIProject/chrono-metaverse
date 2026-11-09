"""Chairs, step 6: the two chairs at the table that are NOT the meeting-chair model, reconstructed one by one with the
contour tools (contour.py: oriented-field sections on the chair's own scan sub-mesh -> loft parts -> texture transfer).

  chair-09  grey box-tub armchair on 4 short legs (north side, east end)
  chair-10  tall lounge chair at the east end of the table
Scan faces: same Voronoi split as the meeting chairs (all 10 chairs compete), table top / pedestal / curtains removed.
Frame: object-local with the dominant horizontal direction of the sub-mesh (contour.fit_yaw) closest to the r2 yaw.
Output: out/r3/chairs_single.json (+ <id>_loft_tex.glb, <id>_loft_geom.glb, <id>_scan.glb).
"""
import os, sys, json, time
import numpy as np
import trimesh
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import chairlib as L
import contour as C
from chairs_align import OTHER_CENTRES

OUTD = L.OUTD

# robustness: contour.finalize_ring can hit a GEOS topology error on a self-touching ring; fall back to the plain
# Douglas-Peucker ring for that one outline (local wrapper, contour.py itself is unchanged)
_finalize = C.finalize_ring


def _safe_finalize(D, tol, *a, **k):
    try:
        return _finalize(D, tol, *a, **k)
    except Exception:
        D = C.dedupe(C.ccw(np.asarray(D, float)))
        idx = C.dp_closed(D, tol)
        return D[idx] if len(idx) >= 3 else None


C.finalize_ring = _safe_finalize


def main():
    t00 = time.time()
    objs = {o['id']: o for o in L.objects()}
    J = json.load(open(os.path.join(OUTD, 'chairs.json')))
    meet = np.array([[i['position'][0], i['position'][2]] for i in J['instances']])
    cen = np.r_[meet, OTHER_CENTRES]
    floors = [i['position'][1] for i in J['instances']] + [float(L.local_floor(*c)[0]) for c in OTHER_CENTRES]
    tab = L.table_geometry()
    fids = L.region_faces(cen, radius=0.75, floors=floors, table=tab)
    out = {}
    for k, cid in enumerate(['chair-09', 'chair-10']):
        o = objs[cid]
        f = fids[len(meet) + k]
        S = C.scene()
        m = trimesh.Trimesh(S['V'], S['F'][f], process=False); m.remove_unreferenced_vertices(); m.merge_vertices()
        # keep the largest connected pieces (drop small debris)
        comps = trimesh.graph.connected_components(m.face_adjacency, nodes=np.arange(len(m.faces)), min_len=1)
        area = np.array([m.area_faces[c].sum() for c in comps])
        keepc = [c for c, a in zip(comps, area) if a >= 0.02 * area.max()]
        kf = np.concatenate(keepc)
        f = f[kf]
        mesh = trimesh.Trimesh(S['V'], S['F'][f], process=False); mesh.remove_unreferenced_vertices(); mesh.merge_vertices()
        floor = floors[len(meet) + k]
        # frame: centre of the footprint, dominant direction nearest the r2 yaw
        c = mesh.bounds.mean(0)
        dom = C.fit_yaw(mesh)
        cands = [dom + 90 * j for j in range(-4, 5)]
        yaw = float(min(cands, key=lambda a: abs(((a - o['transform']['yaw_deg']) + 180) % 360 - 180)))
        T = dict(position=[round(float(c[0]), 4), round(float(floor), 4), round(float(c[2]), 4)], yaw_deg=round(yaw, 3))
        lm = C.local_mesh(mesh, T)
        res = C.slice_contours(lm, axis='y')
        parts = C.lofts_from_levels(res, name='body')
        meshes = [C.loft(p['sections']) for p in parts]
        loft_world = C.world_mesh(trimesh.util.concatenate(meshes), T)
        scan = dict(mesh=mesh, face_ids=f)
        tex_mesh, img, tinfo = C.transfer_texture(loft_world, scan=scan, frame_R=C.Ry(T['yaw_deg']))
        img.save(os.path.join(OUTD, f'{cid}_tex.jpg'), quality=92)
        for p in parts:
            p['texture'] = dict(file=f'{cid}_tex.jpg', uv='baked (contour.transfer_texture)')
        fit = C.fit_report(mesh, loft_world)
        # coverage within 3 cm (scan -> model), same definition as the template instances
        P, _, _, _ = C.sample_mesh(mesh, 0.01, seed=11)
        d = C.surface_distance(P, loft_world)
        fit['scan_to_model']['within_3cm_pct'] = round(float((d <= 0.03).mean() * 100), 1)
        out[cid] = dict(id=cid, anchor=o.get('anchor_suggestion', cid), label=o['label'], label_en=o.get('label_en'),
                        transform=T, parts=parts, fit=fit, texture=tinfo,
                        observed_outline_fraction=round(float(np.mean([Lv['observed'] for Lv in res['levels']
                                                                        if Lv['method'] != 'ground-extension'])), 3),
                        levels=len(res['levels']), scan_faces=int(len(f)))
        C.export_glb(os.path.join(OUTD, f'{cid}_loft_tex.glb'), [(f'{cid}_loft', tex_mesh)])
        C.export_glb(os.path.join(OUTD, f'{cid}_loft_geom.glb'), [(f'{cid}_geom', C.shaded(loft_world))])
        print(f'{cid}: {len(parts)} loft parts, {len(res["levels"])} levels, yaw {yaw:.1f}, scan->model mean '
              f'{fit["scan_to_model"]["mean_cm"]} p90 {fit["scan_to_model"]["p90_cm"]} cm, within 3 cm '
              f'{fit["scan_to_model"]["within_3cm_pct"]} % ({time.time() - t00:.0f}s)')
    json.dump(out, open(os.path.join(OUTD, 'chairs_single.json'), 'w'), ensure_ascii=False)
    # summary of the separately modelled chairs inside chairs.json
    J = json.load(open(os.path.join(OUTD, 'chairs.json')))
    J['separate'] = dict(note='different models from the meeting chair (checked on the scan): reconstructed one by one with '
                              'contour.py (own scan sub-mesh -> sections -> loft parts + baked texture); full parts in '
                              'chairs_single.json',
                         chairs=[dict(id=v['id'], anchor=v['anchor'], label=v['label'], label_en=v['label_en'],
                                      position=v['transform']['position'], yaw_deg=v['transform']['yaw_deg'],
                                      parts=len(v['parts']), fit_scan_to_model=v['fit']['scan_to_model'],
                                      glb=f'{v["id"]}_loft_tex.glb') for v in out.values()])
    json.dump(J, open(os.path.join(OUTD, 'chairs.json'), 'w'), indent=1, ensure_ascii=False)
    # combined GLBs for the scene renders
    items = [(cid, trimesh.load(os.path.join(OUTD, f'{cid}_loft_tex.glb')).dump(concatenate=True)) for cid in out]
    C.export_glb(os.path.join(OUTD, 'chairs_single_tex.glb'), items)
    # scan minus all 10 chairs (for the full comparison)
    g = list(trimesh.load(os.path.join(C.PAR, '..', 'spike', 'out', 'original.glb')).geometry.values())[0]
    z = np.load(os.path.join(OUTD, 'chairs_dbg', 'aligned.npz'))
    rm = np.unique(np.concatenate([z[f'faces_{i}'] for i in range(8)] + [fids[len(meet) + k] for k in range(2)]))
    keep = np.ones(len(g.faces), bool); keep[rm] = False
    rest = g.copy(); rest.update_faces(keep); rest.remove_unreferenced_vertices()
    C.export_glb(os.path.join(OUTD, 'scan_minus_all_chairs.glb'), [('scan_minus_all_chairs', rest)])
    print(f'done ({time.time() - t00:.0f}s)')


if __name__ == '__main__':
    main()
