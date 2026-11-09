"""Meeting chairs 01..08: per-instance textures baked from the scan on one shared template UV layout.

  * shared UV: contour.make_charts + pack_charts once per upper template part (seat, backrest, arms; 4 mm texels),
    vertices split per chart (the template geometry stays one copy in the GLB)
  * per chair: every texel of the shared layout -> 3D point on that chair's placed shell (position, yaw, pitch of
    chairs.json) -> closest normal-compatible point of the chair's OWN scan faces (chairlib.region_faces, Voronoi split
    between the chairs, table top / pedestal removed) within 2 cm (normal dot > 0.5) -> bilinear in the scan texture
  * texels a chair does not show (the side under / towards the table): mean colour of the chairs that do observe that
    texel (pooled over the 8 instances, same UV); texels no chair observes: the part's median colour
  * base legs: foot radius from the scan geometry (r3/chairs_feet.py: foot-pad bumps 1..3.5 cm above the floor; the
    chairs with a confident 4-fold star keep their own radius / orientation, the others take the pooled radius)
Output: out/r3/chairs_tex/<chair>__<part>.jpg, out/r3/chairs_tex/layout.npz, out/r3/chairs_tex.json
"""
import os, sys, json, time
import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import contour as C
import shape as SH
import chairlib as L
from chairs_mesh import template_meshes

OUTD = os.path.join(L.OUTD, 'chairs_tex'); os.makedirs(OUTD, exist_ok=True)
CH = json.load(open(os.path.join(L.OUTD, 'chairs.json')))
FEET = json.load(open(os.path.join(L.OUTD, 'chairs_dbg', 'feet_geometry.json')))
TEXEL = 0.004


def layout(m):
    chart, charts, t2 = C.make_charts(m, None, TEXEL)
    W, H = C.pack_charts(charts, t2, 2)
    off = np.zeros((len(m.faces), 2))
    for c in charts:
        off[c['faces']] = c['offset']
    A2 = t2 + off[:, None, :]
    PIX, FI, BC = [], [], []
    for fi in range(len(m.faces)):
        ij, bc = C._raster_tri(A2[fi])
        if len(ij):
            PIX.append(ij); FI.append(np.full(len(ij), fi)); BC.append(bc)
    PIX, FI, BC = np.concatenate(PIX), np.concatenate(FI), np.concatenate(BC)
    ok = (PIX[:, 0] >= 0) & (PIX[:, 0] < W) & (PIX[:, 1] >= 0) & (PIX[:, 1] < H)
    PIX, FI, BC = PIX[ok], FI[ok], BC[ok]
    key = chart[:, None] * len(m.vertices) + m.faces
    uniq, inv = np.unique(key.ravel(), return_inverse=True)
    NV = m.vertices[uniq % len(m.vertices)]; NF = inv.reshape(-1, 3)
    UVp = np.zeros((len(uniq), 2)); UVp[NF.ravel()] = A2.reshape(-1, 2)
    UV = np.c_[UVp[:, 0] / W, 1.0 - UVp[:, 1] / H]
    return dict(W=W, H=H, PIX=PIX, FI=FI, BC=BC, NV=NV, NF=NF, UV=UV)


def M_upper(inst, pivot):
    R = L.Ry(inst['yaw_deg']); Rt = L.Rx(-inst['pitch_deg'])
    def f(P):
        return ((P - pivot) @ Rt.T + pivot) @ R.T + np.asarray(inst['position'], float)
    return f, R @ Rt


def main():
    t0 = time.time()
    tpl = CH['template']; pivot = np.asarray(tpl['tilt_pivot'], float)
    tm = [(p, m) for p, m in template_meshes(tpl['parts']) if p.get('group') == 'upper']
    insts = CH['instances']
    centres = [inst['position'][0::2] for inst in insts] + [c['position'][0::2] for c in CH['separate']['chairs']]
    floors = [float(L.local_floor(c[0], c[1])[0]) for c in centres]
    regions = L.region_faces(centres, floors=floors, table=L.table_geometry())
    lays = {p['name']: layout(m) for p, m in tm}
    np.savez_compressed(os.path.join(OUTD, 'layout.npz'),
                        **{f'{k}_{a}': v[a] for k, v in lays.items() for a in ('NV', 'NF', 'UV')})
    cols = {k: [] for k in lays}; obs = {k: [] for k in lays}
    for i, inst in enumerate(insts):
        st = SH.ScanTex(regions[i])
        f, Rw = M_upper(inst, pivot)
        for p, m in tm:
            lo = lays[p['name']]
            tri = f(m.vertices)[m.faces]                     # world triangles of this chair
            P3 = np.einsum('nk,nkj->nj', lo['BC'], tri[lo['FI']])
            fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]); fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
            FN = fn[lo['FI']]
            d, ii = st.tree.query(P3, k=12, distance_upper_bound=0.02, workers=-1)
            fin = np.isfinite(d); ii = np.where(fin, ii, 0)
            agree = fin & (np.einsum('nkj,nj->nk', st.SN[ii], FN) > 0.5)
            has = agree.any(1); first = np.argmax(agree, 1)
            gface = st.fids[st.sidx[ii[np.arange(len(P3)), first]]]
            col = np.zeros((len(P3), 3), np.float32)
            if has.any():
                S = C.scene()
                t3 = S['V'][S['F'][gface[has]]]
                cp = trimesh.triangles.closest_point(t3, P3[has])
                bc = np.clip(trimesh.triangles.points_to_barycentric(t3, cp), 0, 1); bc /= bc.sum(1, keepdims=True)
                col[has] = C._bilinear(S['tex'], np.einsum('ni,nij->nj', bc, S['UV'][S['F'][gface[has]]]))
            has &= FN[:, 1] > -0.5                           # downward faces: not from the scan (shadow / floor)
            cols[p['name']].append(col); obs[p['name']].append(has)
        print(f"{inst['id']}: scan faces {len(regions[i])}, observed " +
              ', '.join(f"{k} {obs[k][-1].mean():.2f}" for k in lays), flush=True)
    info = {}
    for k, lo in lays.items():
        Cs = np.stack(cols[k]); Os = np.stack(obs[k])             # (8, n, 3), (8, n)
        cnt = Os.sum(0)
        pooled = (Cs * Os[..., None]).sum(0) / np.maximum(cnt, 1)[:, None]
        part_med = np.median(Cs[Os], axis=0) if Os.any() else np.full(3, 120.0)
        pooled[cnt == 0] = part_med
        for i, inst in enumerate(insts):
            c = np.where(Os[i][:, None], Cs[i], pooled)
            img = np.zeros((lo['H'], lo['W'], 3), np.float32); msk = np.zeros((lo['H'], lo['W']), bool)
            img[lo['PIX'][:, 1], lo['PIX'][:, 0]] = c; msk[lo['PIX'][:, 1], lo['PIX'][:, 0]] = True
            _, (iy, ix) = ndimage.distance_transform_edt(~msk, return_indices=True)
            img = img[iy, ix]
            Image.fromarray(np.clip(np.round(img), 0, 255).astype(np.uint8)).save(
                os.path.join(OUTD, f"{inst['id']}__{k}.jpg"), quality=88)
            info.setdefault(inst['id'], {})[k] = dict(own_observed=round(float(Os[i].mean()), 3),
                                                     pooled_fill=round(float((~Os[i] & (cnt > 0)).mean()), 3),
                                                     part_colour=round(float((cnt == 0).mean()), 3))
        info.setdefault('_layout', {})[k] = dict(atlas=[lo['W'], lo['H']], texel_m=TEXEL, texels=int(len(lo['PIX'])),
                                                 observed_by_any_chair=round(float((cnt > 0).mean()), 3))
    # legs from geometry
    acc = {k: v for k, v in FEET['per_chair'].items() if v['accepted']}
    R_pool = FEET['pooled']['foot_radius']
    legs = {}
    for inst in insts:
        a = acc.get(inst['id'])
        legs[inst['id']] = dict(foot_radius=a['foot_radius'] if a else R_pool, theta_deg=a['theta_deg'] if a else 45.0,
                                source='own foot-pad bumps in the scan geometry' if a else
                                f'pooled foot radius of the {len(acc)} chairs with detectable foot pads (orientation 45 deg assumed)')
    json.dump(dict(method=__doc__, textures=info, legs=legs, feet_detection=FEET['per_chair'],
                   pooled_foot_radius=R_pool), open(os.path.join(L.OUTD, 'chairs_tex.json'), 'w'), indent=1)
    print('legs', {k: (v['foot_radius'], v['theta_deg']) for k, v in legs.items()})
    print(f'done {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
