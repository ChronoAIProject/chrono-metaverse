"""Wall planes from the scan: sequential RANSAC on near-vertical oriented scan samples (continuous angles, no axis
snapping), total-least-squares refinement, split into runs along the wall, piecewise re-fit where the offset drifts."""
import numpy as np
from scipy.spatial import cKDTree


def tls_plane(Q, n_hint):
    c = Q.mean(0); _, _, vt = np.linalg.svd(Q - c, full_matrices=False)
    n = vt[2] * np.sign(vt[2] @ n_hint)
    return n, float(n @ c)


def tls_vertical(Q, n_hint):
    """Plane constrained to be exactly vertical (n_y = 0): 2D TLS line of the xz projection."""
    q = Q[:, [0, 2]]; c = q.mean(0); _, _, vt = np.linalg.svd(q - c, full_matrices=False)
    n2 = vt[1] * np.sign(vt[1] @ n_hint[[0, 2]])
    n = np.array([n2[0], 0.0, n2[1]])
    return n, float(n2 @ c)


def ransac_planes(P, N, band=0.015, cos_min=0.9, max_tilt=0.08, min_pts=150, hyps=600, max_planes=60, seed=0,
                  w_pt=1.0):
    """Sequential RANSAC. Hypothesis = sample point + its normal (horizontalised); score = inliers within `band`
    whose normal agrees (cos > cos_min); refinement = TLS plane (tilt kept if |n_y| <= max_tilt, else vertical).
    Returns list of dict(n, d, idx)."""
    rng = np.random.default_rng(seed)
    rem = np.ones(len(P), bool)
    out = []
    for _ in range(max_planes):
        idx = np.nonzero(rem)[0]
        if len(idx) < min_pts:
            break
        Pi, Ni = P[idx], N[idx]
        best = (0, None, None)
        for s in rng.choice(len(idx), size=min(hyps, len(idx)), replace=False):
            n = Ni[s].copy(); n[1] = 0; nn = np.linalg.norm(n)
            if nn < 0.5:
                continue
            n /= nn; d = n @ Pi[s]
            c = int(((np.abs(Pi @ n - d) < band * 1.5) & (Ni @ n > cos_min)).sum())
            if c > best[0]:
                best = (c, n, d)
        if best[0] < min_pts:
            break
        n, d = best[1], best[2]
        for it in range(4):
            inl = (np.abs(Pi @ n - d) < (band * 2 if it < 2 else band)) & (Ni @ n > cos_min)
            if inl.sum() < 10:
                break
            n2, d2 = tls_plane(Pi[inl], n)
            if abs(n2[1]) > max_tilt:
                n2, d2 = tls_vertical(Pi[inl], n)
            n, d = n2, d2
        inl = (np.abs(Pi @ n - d) < band) & (Ni @ n > cos_min)
        if inl.sum() < min_pts:
            rem[idx[inl]] = False
            if inl.sum() == 0:
                break
            continue
        out.append(dict(n=n, d=float(d), idx=idx[inl]))
        rem[idx[inl]] = False
    return out


def runs_along(P, n, idx, gap=0.25, min_len=0.25, min_pts=60):
    """Split plane inliers into runs along the horizontal tangent (gap > `gap` m)."""
    t = np.array([-n[2], 0.0, n[0]]); t /= np.linalg.norm(t)
    u = P[idx] @ t
    o = np.argsort(u); u, ii = u[o], idx[o]
    cuts = np.nonzero(np.diff(u) > gap)[0]
    out = []
    for a, b in zip(np.r_[0, cuts + 1], np.r_[cuts + 1, len(u)]):
        if b - a >= min_pts and u[b - 1] - u[a] >= min_len:
            out.append(ii[a:b])
    return out, t


def drift_split(P, n, d, idx, t, bin_=0.3, thr=0.015, min_len=0.6):
    """Binned median of the signed residual along the wall; if it changes by more than `thr` the run is split at
    the largest change point (recursively), each piece re-fitted. Returns list of (n, d, idx)."""
    u = P[idx] @ t; r = P[idx] @ n - d
    if u.max() - u.min() < 2 * min_len:
        return [(n, d, idx)]
    edges = np.arange(u.min(), u.max() + bin_, bin_)
    b = np.clip(np.digitize(u, edges) - 1, 0, len(edges) - 2)
    med = np.array([np.median(r[b == k]) if (b == k).sum() >= 5 else np.nan for k in range(len(edges) - 1)])
    ok = np.isfinite(med)
    if ok.sum() < 4 or np.nanmax(med) - np.nanmin(med) < thr:
        return [(n, d, idx)]
    # best single split: minimise the summed residual of two independent line fits
    best = None
    for k in range(2, len(edges) - 3):
        us = edges[k]
        if us - u.min() < min_len or u.max() - us < min_len:
            continue
        A, B = idx[u < us], idx[u >= us]
        if len(A) < 30 or len(B) < 30:
            continue
        cost = 0.0
        for S in (A, B):
            nn, dd = tls_vertical(P[S], n) if abs(n[1]) < 1e-9 else tls_plane(P[S], n)
            cost += np.abs(P[S] @ nn - dd).sum()
        if best is None or cost < best[0]:
            best = (cost, us, A, B)
    if best is None:
        return [(n, d, idx)]
    base_cost = np.abs(r).sum()
    if best[0] > 0.8 * base_cost:
        return [(n, d, idx)]
    out = []
    for S in (best[2], best[3]):
        nn, dd = tls_plane(P[S], n)
        if abs(nn[1]) > 0.08:
            nn, dd = tls_vertical(P[S], n)
        out += drift_split(P, nn, dd, S, t, bin_, thr, min_len)
    return out
