"""Merge round-3 rebuilt objects (out/r3/obj/<id>.json from r3/rebuild.py) with the untouched round-2 objects.

Outputs
  out/r3/objects_r3.json    same schema as out/objects.json (list of objects with transform / parts / bbox / fit);
                            rebuilt objects carry "loft" parts (object-local sections, continuous coordinates) with a
                            per-part "texture" (atlas jpg baked from the original scan texture) and "glb" (textured
                            per-object mesh, one node per part); untouched objects are copied from round 2 with
                            "r3_status": "round 2 (not rebuilt in this step)".
  out/r3/fit_r3.json        per-object fit: scan -> model distance (mean / p90 cm, coverage within 1/2/3 cm) for round 3
                            and round 2 on the same scan sub-mesh, plus model -> scan.
  out/r3/scene_r3.glb       round-2 scene (structure + untouched objects) with the rebuilt objects replaced.
"""
import os, sys, json, glob
import numpy as np
import trimesh

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import contour as C   # noqa: E402

OUTD = os.path.join(C.OUT, 'r3')
r2 = json.load(open(os.path.join(C.OUT, 'objects.json')))
r3 = {os.path.basename(f)[:-5]: json.load(open(f)) for f in sorted(glob.glob(os.path.join(OUTD, 'obj', '*.json')))}
out, fit = [], {}
for o in r2:
    if o['id'] in r3:
        n = r3[o['id']]; n['r3_status'] = 'rebuilt from scan contours (round 3)'
        out.append(n)
        f = n['fit']
        fit[o['id']] = dict(label=o['label'], label_en=o['label_en'], method=f['method'],
                            r3=dict(scan_to_model=f['metrics_r3']['scan_to_model'], model_to_scan=f['metrics_r3']['model_to_scan']),
                            r2=dict(scan_to_model=f['metrics_r2']['scan_to_model'], model_to_scan=f['metrics_r2']['model_to_scan']),
                            parts=[p['name'] for p in n['parts']], faces=f['faces'],
                            observed_outline_fraction=f['observed_outline_fraction'], meta=f.get('meta', {}))
    else:
        n = dict(o); n['r3_status'] = 'round 2 (not rebuilt in this step)'
        out.append(n)
json.dump(out, open(os.path.join(OUTD, 'objects_r3.json'), 'w'), ensure_ascii=False)
json.dump(fit, open(os.path.join(OUTD, 'fit_r3.json'), 'w'), ensure_ascii=False, indent=1)
print(f'objects_r3.json: {len(out)} objects, {len(r3)} rebuilt ({", ".join(r3)})')
print(f'{"object":<15}{"r3 mean":>9}{"r3 p90":>8}{"r3 <=3cm":>10}{"r2 mean":>9}{"r2 p90":>8}{"r2 <=3cm":>10}')
for k, v in fit.items():
    a, b = v['r3']['scan_to_model'], v['r2']['scan_to_model']
    print(f'{k:<15}{a["mean_cm"]:>9}{a["p90_cm"]:>8}{a["within_3cm_pct"]:>10}{b["mean_cm"]:>9}{b["p90_cm"]:>8}{b["within_3cm_pct"]:>10}')

# scene: round-2 GLB minus the rebuilt objects + round-3 object GLBs
sc = trimesh.load(os.path.join(os.path.dirname(C.OUT), '..', 'spike', 'out', 'parametric.glb'))
new = trimesh.Scene()
for node in sc.graph.nodes_geometry:
    T, g = sc.graph[node]
    if any(node == k or node.startswith(k + '_') for k in r3):
        continue
    new.add_geometry(sc.geometry[g], node_name=node, geom_name=node, transform=T)
for k in r3:
    s3 = trimesh.load(os.path.join(OUTD, 'glb', f'{k}.glb'))
    for node in s3.graph.nodes_geometry:
        T, g = s3.graph[node]
        new.add_geometry(s3.geometry[g], node_name=f'{k}__{g.split(":")[-1]}', geom_name=f'{k}__{g.split(":")[-1]}', transform=T)
new.export(os.path.join(OUTD, 'scene_r3.glb'))
print('scene_r3.glb', round(os.path.getsize(os.path.join(OUTD, 'scene_r3.glb')) / 1e6, 1), 'MB')
