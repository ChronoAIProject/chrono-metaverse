"""Per-object fit check: share of scan samples near the object that fall inside its parts (+5 cm),
and share of each part's volume footprint that is supported by samples. Writes fit.coverage into objects.json."""
import os, sys, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prep import SP, load, floor_map, floor_at
import build_glb as B
P, C, N = load(); G, GC = floor_map(P, N)
h = P[:, 1] - floor_at(G, GC, P[:, 0], P[:, 2])
objs = json.load(open(SP + '/out/objects.json'))
rows = []
for o in objs:
    mn, mx = np.array(o['bbox']['min']), np.array(o['bbox']['max'])
    near = np.all((P >= mn - [0.05, 0, 0.05]) & (P <= mx + [0.05, 0.05, 0.05]), axis=1) & (h > 0.03)
    others = [x for x in objs if x['id'] != o['id']]
    near[np.where(near)[0][B.inside_parts(P[near], margin=0.02, objs=others)]] = False   # samples explained by other objects
    inside = B.inside_parts(P[near], margin=0.05, objs=[o])
    # samples of the object region explained by the model, and model parts with almost no support
    unsup = []
    for p in o['parts']:
        q = B.inside_parts(P[near], margin=0.03, objs=[{**o, 'parts': [p]}])
        if q.sum() < 10: unsup.append(p['name'])
    cov = float(inside.mean()) if near.sum() else 0.0
    o['fit']['coverage_5cm'] = round(cov, 3); o['fit']['coverage_samples'] = int(near.sum()); o['fit']['unsupported_parts'] = unsup
    rows.append((o['id'], o['label'], int(near.sum()), round(cov, 3), unsup))
    print(f"{o['id']:14s} {o['label']:10s} samples_in_bbox={near.sum():6d} inside_model(5cm)={cov:5.1%} unsupported={unsup}")
json.dump(objs, open(SP + '/out/objects.json', 'w'), ensure_ascii=False, indent=1)
