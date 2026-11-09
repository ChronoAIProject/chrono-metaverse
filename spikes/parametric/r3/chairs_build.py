"""Chairs, step 5: assemble the meeting-chair template + instances -> out/r3/chairs.json, GLBs, fit metrics.

Inputs: chairs_dbg/aligned.json|npz (chairs_align.py), chairs_dbg/pooled.npz (chairs_pool.py), chairs_template.build(),
chairs_dbg/base.json (chairs_base.py, floor-texture foot marks; low confidence).
Template frame: origin on the floor below the seat centre (= swivel axis), y up, chair faces +z.
Instance: world = Ry(yaw) * Tilt(L) + position; Tilt = Rx(-pitch) about template.tilt_pivot, applied to the parts with
group 'upper' (shell); pitch > 0 = leaning further back than the template, < 0 = leaning forward.
"""
import os, sys, json, time
import numpy as np
import trimesh
import shapely
from scipy.spatial import cKDTree
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import chairlib as L
import contour as C
import chairs_template as TPL
from chairs_mesh import part_mesh, template_meshes, instance_mesh
from chairs_align import outside_table

D = os.path.join(L.OUTD, 'chairs_dbg')
OUTD = L.OUTD


def shift_part(p, dz):
    """Move a template part by dz along z (canonical)."""
    q = json.loads(json.dumps(p))
    if q['type'] == 'loft':
        ax = q.get('axis', 'y')
        for s in q['sections']:
            if ax == 'y':
                s['outline'] = [[u, round(v - dz, 5)] for u, v in s['outline']]
            elif ax == 'x':
                s['outline'] = [[round(u - dz, 5), v] for u, v in s['outline']]
        if q.get('frame'):
            q['frame']['pivot'][2] = round(q['frame']['pivot'][2] - dz, 5)
    elif q['type'] == 'tube':
        q['a'][2] = round(q['a'][2] - dz, 5); q['b'][2] = round(q['b'][2] - dz, 5)
    elif q['type'] == 'cylinder':
        q['position'][2] = round(q['position'][2] - dz, 5)
    return q


def seat_axis(parts):
    """Swivel axis z = centre of the seat outline's z extent on the centre line."""
    seat = next(p for p in parts if p['name'] == 'seat')
    ring = np.array(seat['sections'][-1]['outline'])
    g = shapely.geometry.Polygon(ring)
    ln = g.intersection(shapely.geometry.LineString([(0, -2), (0, 2)]))
    zs = np.asarray(ln.coords)[:, 1] if not ln.is_empty else ring[:, 1]
    return 0.5 * (zs.min() + zs.max())


def bright(col):
    return L.bright_color(col, 80, 90)


def leg_colour(prm, floor_y, R):
    """Colour of the dark leg contact marks in the floor texture (median of the darkest 10 % within the foot circle)."""
    S = C.scene(); FC = S['FC']
    c = L.uncanon(np.zeros((1, 3)), prm, tilt=False)[0]
    m = (np.hypot(FC[:, 0] - c[0], FC[:, 2] - c[2]) < R + 0.03) & (np.abs(FC[:, 1] - floor_y) < 0.03) & (S['FN'][:, 1] > 0.8)
    P, _, col, _ = L.sample_faces(np.nonzero(m)[0], 0.004, seed=5)
    lum = L.luminance(col)
    k = lum <= np.percentile(lum, 10)
    return [int(v) for v in np.median(col[k], 0)]


def dist_to(mesh, P):
    _, d, _ = trimesh.proximity.closest_point(mesh, P)
    return d


def stats(d):
    return dict(mean_cm=round(float(d.mean() * 100), 2), p50_cm=round(float(np.median(d) * 100), 2),
                p90_cm=round(float(np.percentile(d, 90) * 100), 2), within_1cm_pct=round(float((d <= 0.01).mean() * 100), 1),
                within_3cm_pct=round(float((d <= 0.03).mean() * 100), 1), n=int(len(d)))


def main():
    t00 = time.time()
    meta = json.load(open(os.path.join(D, 'aligned.json')))
    z = np.load(os.path.join(D, 'aligned.npz'))
    ids = meta['ids']; prm = np.array(meta['prm']); floors = np.array(meta['floors'])
    objs = {o['id']: o for o in L.objects()}
    tab = L.table_geometry()
    parts, rep, dbg = TPL.build(verbose=True)
    gamma = dbg['gamma']
    h_bot = rep['shell_bottom_h']
    # ------------------------------------------------ base: column + 4 legs (spider 4-star base)
    bj = json.load(open(os.path.join(D, 'base.json')))
    Rs = np.array([v['foot_radius'] for v in bj.values()])
    # the floor-texture foot estimates disagree (spread ~0.2 m) -> foot circle = outer shell half-width at seat height
    # (measured), the texture median is only reported
    ph = (np.arange(dbg['ROs'].shape[1]) + 0.5) * TPL.SECT
    R_foot = float(np.nanmax(dbg['ROs'] * np.sin(ph)[None]))          # widest outer half-width of the shell
    rep['foot_radius_texture_median_m'] = round(float(np.median(Rs)), 4)
    col_top = h_bot
    h_hub = round(h_bot - 0.06, 4)            # identification: the legs start right under the seat (short swivel column)
    r_col, r_leg = 0.022, 0.008
    base_theta = 45.0                          # X orientation (per-chair base orientation not resolvable)
    za = float(seat_axis(parts))
    rep.update(swivel_axis_z_before_shift=round(za, 4), foot_radius_m=round(R_foot, 4),
               foot_radius_texture_estimates=[round(float(r), 3) for r in Rs])
    parts = [shift_part(p, za) for p in parts]
    base = [dict(type='cylinder', name='column', radius=r_col, height=round(col_top - h_hub, 4),
                 position=[0.0, round(0.5 * (col_top + h_hub), 4), 0.0], segments=16, group='base', observed=False,
                 source='not in the scan geometry (below mesh resolution); spans hub -> measured shell bottom')]
    for k in range(4):
        a = np.radians(base_theta + 90 * k)
        foot = [round(R_foot * np.sin(a), 4), 0.012, round(R_foot * np.cos(a), 4)]
        base.append(dict(type='tube', name=f'leg_{k + 1}', a=[0.0, h_hub, 0.0], b=foot, r_a=r_leg * 1.2, r_b=r_leg * 0.8,
                         segments=10, group='base', observed=False,
                         source='legs below scan-mesh resolution: foot radius = measured widest outer shell half-width '
                                ' (floor-texture foot marks 0.19-0.42 m, inconsistent); orientation X (45 deg) assumed'))
    parts_all = parts + base
    # ------------------------------------------------ meshes (canonical, after the axis shift)
    tmeshes = template_meshes(parts_all)
    tilt_pivot = [0.0, L.PIVOT_H, round(-za, 5)]
    # ------------------------------------------------ instances
    instances, metrics = [], {}
    tpl_samples = []
    for p, m in tmeshes:
        Pm, _, _, _ = C.sample_mesh(m, 0.006, seed=1)
        tpl_samples.append(Pm)
    for i, cid in enumerate(ids):
        p = prm[i].copy()
        # canonical origin moves to the swivel axis: L_new = L_old - (0, 0, za)  ->  position += Ry(yaw) (0, 0, za)
        pos = L.uncanon(np.array([[0.0, 0.0, za]]), np.r_[p[0], p[1:4], 0.0], tilt=False)[0]
        pitch = float(p[4] - gamma)
        inst = dict(id=cid, anchor=objs[cid].get('anchor_suggestion', cid), label=objs[cid]['label'],
                    position=[round(float(v), 4) for v in pos], yaw_deg=round(float(p[0] % 360), 3),
                    pitch_deg=round(pitch, 3))
        # the tilt pivot moved with the origin shift: (0, PIVOT_H, -za) in the new frame == the alignment pivot
        world = instance_mesh(tmeshes, inst, tilt_pivot, per_part=True)
        wm = trimesh.util.concatenate([m for _, m in world])
        # ---- colours: bright-side band of the chair's own samples next to each part
        P = z[f'P_{i}']; col = z[f'col_{i}']; N = z[f'N_{i}']
        tree_parts = []
        allS, lab = [], []
        for k, (pp, m) in enumerate(world):
            Sm, _, _, _ = C.sample_mesh(m, 0.006, seed=2)
            allS.append(Sm); lab.append(np.full(len(Sm), k))
        allS = np.concatenate(allS); lab = np.concatenate(lab)
        dd, jj = cKDTree(allS).query(P, distance_upper_bound=0.025)
        okc = np.isfinite(dd)
        colors = {}
        for k, (pp, m) in enumerate(world):
            sel = okc.copy(); sel[okc] = lab[jj[okc]] == k
            if pp.get('group') == 'upper' and sel.sum() >= 30:
                colors[pp['name']] = bright(col[sel])
        upper_all = okc.copy(); upper_all[okc] = np.isin(lab[jj[okc]], [k for k, (pp, _) in enumerate(world) if pp.get('group') == 'upper'])
        shell_col = bright(col[upper_all]) if upper_all.sum() >= 30 else [90, 90, 90]
        for pp, _ in world:
            if pp.get('group') == 'upper' and pp['name'] not in colors:
                colors[pp['name']] = shell_col
        colors['base'] = leg_colour(np.r_[inst['yaw_deg'], pos, 0.0], floors[i], R_foot)
        inst['colors'] = colors
        inst['color_source'] = ('p80-90 luminance band of the chair\'s own scan samples within 2.5 cm of each upper part; '
                                'base: darkest 10 % of the floor texture inside the foot circle (leg marks)')
        instances.append(inst)
        # ---- fit metrics
        Lc = L.canon(P, np.r_[prm[i][:4], prm[i][4]])
        shell = (Lc[:, 1] > 0.40) & (Lc[:, 1] < 0.78) & outside_table(P, tab)
        rng = np.random.default_rng(i)
        sub = lambda m_, n_: np.nonzero(m_)[0][rng.choice(m_.sum(), min(n_, m_.sum()), replace=False)]
        iA = sub(shell, 6000); iB = sub(np.ones(len(P), bool), 8000)
        dA, dB = dist_to(wm, P[iA]), dist_to(wm, P[iB])
        r2 = trimesh.util.concatenate([trimesh.Trimesh(m.vertices, m.faces, process=False)
                                       for _, m, _ in __import__('prims').object_part_meshes(objs[cid])])
        r2A, r2B = dist_to(r2, P[iA]), dist_to(r2, P[iB])
        metrics[cid] = dict(own_shell_samples=dict(template=stats(dA), r2_boxes=stats(r2A),
                                                   definition='own scan samples h 0.40..0.78 outside the table-top outline'),
                            all_extracted_samples=dict(template=stats(dB), r2_boxes=stats(r2B),
                                                       definition='every extracted scan sample of this chair (incl. under-table debris)'))
        inst['_world'] = world
        print(f'{cid}: pos {inst["position"]} yaw {inst["yaw_deg"]:.1f} pitch {pitch:+.1f} | own shell mean {dA.mean() * 100:.2f} '
              f'p90 {np.percentile(dA, 90) * 100:.2f} cm cov3 {(dA <= 0.03).mean() * 100:.0f} % (r2 {r2A.mean() * 100:.2f}/{np.percentile(r2A, 90) * 100:.2f}/{(r2A <= 0.03).mean() * 100:.0f} %) '
              f'| all mean {dB.mean() * 100:.2f} p90 {np.percentile(dB, 90) * 100:.2f} cov3 {(dB <= 0.03).mean() * 100:.0f} %')
    # ------------------------------------------------ chairs.json
    tpl = dict(id='meeting-chair', label='会议椅（壳体椅 + 四星脚）', label_en='meeting shell chair on a 4-star swivel base',
               frame='origin on the floor below the seat centre (swivel axis), y up, the chair faces +z, metres',
               tilt_pivot=tilt_pivot, parts=parts_all, measurements=rep,
               default_colors=dict(upper=[int(np.median([inst['colors']['backrest'][c] for inst in instances])) for c in range(3)],
                                   base=[int(np.median([inst['colors']['base'][c] for inst in instances])) for c in range(3)]))
    out = dict(template=tpl,
               instance_transform='world = Ry(yaw_deg) * Tilt(L) + position; Tilt(L) = Rx(-pitch_deg) (L - tilt_pivot) + tilt_pivot '
                                  'for parts with group "upper" (identity for the base); Ry/Rx as in prims.py (three.js rotation)',
               instances=[{k: v for k, v in inst.items() if not k.startswith('_')} for inst in instances],
               fit_metrics=metrics,
               pooled_from=ids,
               separate=dict(note='chair-09 (grey box-tub armchair on 4 short legs) and chair-10 (tall lounge chair) are different '
                                  'models; see chairs_single.json'),
               source='r3/chairs_align.py -> chairs_pool.py -> chairs_template.py -> chairs_base.py -> chairs_build.py')
    json.dump(out, open(os.path.join(OUTD, 'chairs.json'), 'w'), indent=1, ensure_ascii=False)
    # ------------------------------------------------ GLBs
    items = []
    for inst in instances:
        for pp, m in inst['_world']:
            rgb = inst['colors'][pp['name']] if pp.get('group') == 'upper' else inst['colors']['base']
            items.append((f'{inst["id"]}_{pp["name"]}', C.shaded(m, rgb)))
    C.export_glb(os.path.join(OUTD, 'chairs_template_inst.glb'), items)
    C.export_glb(os.path.join(OUTD, 'chairs_template_white.glb'),
                 [(f'{inst["id"]}_{pp["name"]}', C.shaded(m, (215, 212, 205))) for inst in instances for pp, m in inst['_world']])
    C.export_glb(os.path.join(OUTD, 'chair_template_canonical.glb'),
                 [(p['name'], C.shaded(m, (200, 196, 188) if p.get('group') == 'upper' else (70, 70, 74))) for p, m in tmeshes])
    # scan without the 8 meeting chairs (textured, for the side-by-side) and the scan chairs alone
    S = C.scene()
    faces = np.unique(np.concatenate([z[f'faces_{i}'] for i in range(len(ids))]))
    g = list(trimesh.load(os.path.join(L.C.PAR, '..', 'spike', 'out', 'original.glb')).geometry.values())[0]
    keep = np.ones(len(g.faces), bool); keep[faces] = False
    rest = g.copy(); rest.update_faces(keep); rest.remove_unreferenced_vertices()
    C.export_glb(os.path.join(OUTD, 'scan_minus_chairs.glb'), [('scan_minus_chairs', rest)])
    ch = g.copy(); ch.update_faces(~keep); ch.remove_unreferenced_vertices()
    C.export_glb(os.path.join(OUTD, 'scan_chairs_only.glb'), [('scan_chairs', ch)])
    r2items = []
    for cid in ids:
        for pp, m, fc in __import__('prims').object_part_meshes(objs[cid]):
            r2items.append((f'{cid}_{pp["name"]}', C.shaded(trimesh.Trimesh(m.vertices, m.faces, process=False), pp.get('color_rgb', [150, 150, 150]))))
    C.export_glb(os.path.join(OUTD, 'chairs_r2.glb'), r2items)
    print(f'removed {len(faces)} chair faces from the scan for the comparison; done ({time.time() - t00:.0f}s)')


if __name__ == '__main__':
    main()
