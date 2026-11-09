"""Architectural pieces that are not planes -> sliced solids (same contour pipeline as the furniture).

Output: out/r3/arch_solids.json (+ out/r3/glb/<id>.glb, out/r3/tex/<id>__<part>.jpg)

  fin-01         wood fin (10 cm thick partition) with the open door leaf at the west entrance
  partition-02   curved partition piece on the east side (x 9.1..9.6, z 12.2..13.6)
  plant-01       potted plant in the east corridor (round 2: cylinder + bicones) - its foliage reaches z 7.3
  pier-01..      window piers / mullions / sill pieces in front of the south glazing (x spans from the scan,
                 arch_solids_regions.south_pier_spans); they replace round 2's window-frame-01 boxes

Each region: scan sub-mesh (contour.object_mesh, own box, floor removed; wall removal only against the glass for the
piers so reflections behind it are dropped) -> horizontal sections of the real scan surface (contour.slice_contours)
-> loft tracks -> vertical simplification -> loft meshes -> texture baked from the scan (shape.ScanTex, round-3 rule:
colour source <= 2 cm, else part colour). Continuous coordinates throughout.
"""
import os, sys, json, time
import numpy as np
import trimesh

HERE = os.path.dirname(os.path.abspath(__file__)); PAR = os.path.dirname(HERE)
for p in (PAR, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)
import contour as C            # noqa: E402
import shape as SH             # noqa: E402
import rebuild as RB           # noqa: E402
import arch_solids_regions as AR   # noqa: E402

OUT3 = os.path.join(C.OUT, 'r3')
_finalize = C.finalize_ring


def _safe_finalize(D, tol, *a, **k):
    """GEOS topology error on a self-touching ring -> plain Douglas-Peucker ring for that outline (as chairs_single)."""
    try:
        return _finalize(D, tol, *a, **k)
    except Exception:
        D = C.dedupe(C.ccw(np.asarray(D, float)))
        idx = C.dp_closed(D, tol)
        return D[idx] if len(idx) >= 3 else None


C.finalize_ring = _safe_finalize
NO_WALLS = os.path.join(OUT3, 'struct_dbg', 'no_walls.json')
GLASS_ONLY = os.path.join(OUT3, 'struct_dbg', 'glass_only.json')


def regions():
    from structure_r3 import SOLID_REGIONS
    out = [dict(id='partition-02', label='弧形隔断', label_en='curved partition piece', box=SOLID_REGIONS['partition-02'],
                structure=NO_WALLS, wall_tol=0.0, params=dict(res=0.005, tol=0.004, morph=0.003)),
           dict(id='plant-01', label='绿植', label_en='potted plant', box=SOLID_REGIONS['plant-01'], structure=NO_WALLS,
                wall_tol=0.0, params=dict(res=0.008, tol=0.006, morph=0.004), replaces='plant-01')]
    for k, (a, b) in enumerate(AR.south_pier_spans()):
        out.append(dict(id=f'pier-{k + 1:02d}', label='窗间墙/窗框', label_en='window pier / mullion / sill',
                        box=([a - 0.05, 0.0, AR.Z0], [b + 0.05, 2.95, 15.70]), structure=GLASS_ONLY, wall_tol=0.01,
                        params=dict(res=0.005, tol=0.004, morph=0.003), replaces='window-frame-01'))
    return out


def build_one(r):
    t0 = time.time(); RB.LOG.clear()
    lo, hi = np.array(r['box'][0], float), np.array(r['box'][1], float)
    om = C.object_mesh((lo, hi), pad=0.0, wall_tol=r['wall_tol'], structure=r['structure'])
    if len(om['face_ids']) < 50:
        print(f"{r['id']}: only {len(om['face_ids'])} scan faces, skipped"); return None
    cx, cz = 0.5 * (lo[0] + hi[0]), 0.5 * (lo[2] + hi[2])
    T = dict(position=[round(cx, 4), round(om['floor_y'], 4), round(cz, 4)], yaw_deg=0.0)
    lm = C.local_mesh(om['mesh'], T)
    parts, res = RB.loft_parts_y(lm, 'body', vtol=0.005, params=r['params'],
                                 dbg=os.path.join(RB.DBG, f"levels_{r['id']}.png"))
    parts = RB.name_by_size(parts, 'body', 'piece')
    world = []
    for p in parts:
        m, inf = C.loft(p['sections'], axis='y', max_slope_deg=p.get('max_slope_deg', 75.0), return_info=True)
        world.append((p, C.world_mesh(m, T), inf))
    if not world:
        print(f"{r['id']}: no loft"); return None
    model = trimesh.util.concatenate([w for _, w, _ in world])
    _, dsrc, _ = trimesh.proximity.closest_point(model, om['mesh'].triangles_center)
    st = SH.ScanTex(om['face_ids'][dsrc <= 0.04])
    texel = float(np.clip(model.extents.max() / 400.0, 0.003, 0.006))
    tex_items, kept = [], []
    for p, mw, inf in world:
        tm, img, ti = st.bake(mw, frame_R=np.eye(3), texel=texel)
        if ti['support_fraction_8cm'] < 0.05:
            continue
        fn = f"{r['id']}__{p['name']}.jpg"
        img.save(os.path.join(RB.TEXD, fn), quality=90)
        st.last_observed_mask.save(os.path.join(RB.TEXD, fn[:-4] + '_observed.png'))
        p['color_rgb'] = ti['part_rgb']
        p['texture'] = dict(file=f'r3/tex/{fn}', texel_m=ti['texel_m'], atlas=ti['atlas'],
                            observed_fraction=ti['observed_fraction'], observed_mask=f'r3/tex/{fn[:-4]}_observed.png',
                            rule=ti['rule'])
        p['mesh_stats'] = dict(faces=inf['faces'], bands=inf['bands'], steps=inf['steps'])
        tex_items.append((f"{r['id']}:{p['name']}", tm)); kept.append((p, mw))
    if not kept:
        return None
    model = trimesh.util.concatenate([mw for _, mw in kept])
    C.export_glb(os.path.join(RB.GLBD, f"{r['id']}.glb"), tex_items)
    C.export_glb(os.path.join(RB.GLBD, f"{r['id']}_geom.glb"), [(f"{r['id']}:{p['name']}", C.shaded(mw)) for p, mw in kept])
    fm = SH.fit_metrics(om['mesh'], model)
    b0, b1 = model.bounds
    out = dict(id=r['id'], label=r['label'], label_en=r['label_en'], category='architecture', transform=T,
               region_box=dict(min=np.round(lo, 4).tolist(), max=np.round(hi, 4).tolist()),
               bbox=dict(min=np.round(b0, 5).tolist(), max=np.round(b1, 5).tolist()),
               parts=[p for p, _ in kept], glb=f"r3/glb/{r['id']}.glb", replaces=r.get('replaces'),
               stands_on_floor=bool(b0[1] < om['floor_y'] + 0.1),
               fit=dict(method='horizontal sections of the scan inside the region box (contour.slice_contours) -> lofts',
                        scan_faces=int(len(om['face_ids'])), observed_outline_fraction=round(float(np.mean(
                            [L['observed'] for L in res['levels'] if L['method'] != 'ground-extension'] or [0])), 3),
                        metrics=fm, faces=int(len(model.faces)), seconds=round(time.time() - t0, 1)))
    print(f"{r['id']:<14} parts {len(kept)} faces {len(model.faces)} scan->model mean {fm['scan_to_model']['mean_cm']} "
          f"p90 {fm['scan_to_model']['p90_cm']}  model->scan mean {fm['model_to_scan']['mean_cm']}  ({time.time() - t0:.0f}s)",
          flush=True)
    return out


def main():
    os.makedirs(os.path.dirname(NO_WALLS), exist_ok=True)
    json.dump(dict(elements=[]), open(NO_WALLS, 'w'))
    S3 = json.load(open(os.path.join(OUT3, 'structure_r3.json')))
    json.dump(dict(elements=[e for e in S3['elements'] if e.get('glazing')]), open(GLASS_ONLY, 'w'))
    only = set(sys.argv[1:])
    path = os.path.join(OUT3, 'arch_solids.json')
    prev = {s['id']: s for s in json.load(open(path))} if (only and os.path.exists(path)) else {}
    res = []
    for r in regions():
        if only and r['id'] not in only:
            if r['id'] in prev:
                res.append(prev[r['id']])
            continue
        o = build_one(r)
        if o:
            res.append(o)
    json.dump(res, open(path, 'w'), ensure_ascii=False)
    print('wrote', path, len(res), 'solids')


if __name__ == '__main__':
    main()
