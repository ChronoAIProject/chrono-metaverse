"""Regions of the scan modelled as sliced solids (shared by structure_r3.py, arch_solids.py, floor_r3.py)."""
import os, sys, json
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); PAR = os.path.dirname(HERE)
for p in (PAR, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)
CACHE = os.path.join(PAR, 'out', 'r3', 'struct_dbg', 'south_piers.json')
Z0, Z1 = 15.17, 15.62          # band in front of the south glass (sofas / display end at z <= 15.21)


def south_pier_spans(force=False):
    """x ranges of the window piers / mullions in front of the south glazing: scan samples in the band
    (y 0.9..2.4, so the sofas below are not involved) clustered along x (gaps > 0.2 m), clusters that cover >= 1 m of
    height. Continuous coordinates (sample extremes, p1 / p99)."""
    if os.path.exists(CACHE) and not force:
        return [tuple(s) for s in json.load(open(CACHE))]
    from common import sample_surface
    P, C, N, _ = sample_surface(1500.0, seed=31)
    m = (P[:, 2] > Z0) & (P[:, 2] < Z1) & (P[:, 1] > 0.9) & (P[:, 1] < 2.4) & (P[:, 0] > 1.55) & (P[:, 0] < 10.5)
    Q = P[m]
    o = np.argsort(Q[:, 0]); Q = Q[o]
    cut = np.nonzero(np.diff(Q[:, 0]) > 0.2)[0]
    spans = []
    for a, b in zip(np.r_[0, cut + 1], np.r_[cut + 1, len(Q)]):
        q = Q[a:b]
        if len(q) < 80:
            continue
        if np.percentile(q[:, 1], 98) - np.percentile(q[:, 1], 2) < 1.0:
            continue
        spans.append((round(float(np.percentile(q[:, 0], 0.5)), 4), round(float(np.percentile(q[:, 0], 99.5)), 4)))
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    json.dump(spans, open(CACHE, 'w'))
    return spans


if __name__ == '__main__':
    print(south_pier_spans(force=True))
