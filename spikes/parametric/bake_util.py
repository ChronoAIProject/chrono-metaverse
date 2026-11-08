"""Orthographic texture baking from the scan (same method as structure.py's bake(), made reusable).

ortho_bake(face_ids, origin, u_vec, v_vec, size_px, ...) projects a dense re-sample of the given scan
faces onto an image plane: texel (col,row) = ((p-origin).u_vec, (p-origin).v_vec) / px.
  depth_vec + visible_tol: keep, per texel, only samples within visible_tol of the sample closest to the
                           viewer (depth = p.depth_vec, larger = closer) -> a "visible surface" photo
  keep(p, col, n):         optional per-sample filter
Returns (rgb uint8 HxWx3 with holes push-pull filled, observed mask bool HxW).
"""
import numpy as np
from scipy import ndimage
from common import load_aligned

V, F, UV, TEX, _ = load_aligned()
TH, TW = TEX.shape[:2]
FA, FB, FC = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
FCR = np.cross(FB - FA, FC - FA); FAREA = 0.5 * np.linalg.norm(FCR, axis=1)
FN = FCR / np.maximum(2 * FAREA[:, None], 1e-12)
FCEN = (FA + FB + FC) / 3


def push_pull(img, w):
    """Fill pixels with w==0 from a coarse-to-fine weighted pyramid (smooth hole filling)."""
    if w.min() > 0 or min(img.shape[:2]) <= 1:
        return img
    H, W = w.shape
    Hp, Wp = H + (H & 1), W + (W & 1)
    ip = np.zeros((Hp, Wp, img.shape[2])); ip[:H, :W] = img * w[..., None]
    wp = np.zeros((Hp, Wp)); wp[:H, :W] = w
    sw = wp.reshape(Hp // 2, 2, Wp // 2, 2).sum((1, 3))
    si = ip.reshape(Hp // 2, 2, Wp // 2, 2, -1).sum((1, 3))
    coarse = si / np.maximum(sw, 1e-9)[..., None]
    coarse = push_pull(coarse, np.minimum(sw, 1.0))
    up = ndimage.zoom(coarse, (Hp / coarse.shape[0], Wp / coarse.shape[1], 1), order=1)[:H, :W]
    a = np.minimum(w, 1.0)[..., None]
    return img * a + up * (1 - a)


def faces_in_box(lo, hi, normal=None, cos_min=None):
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    m = np.all((FCEN >= lo) & (FCEN <= hi), axis=1)
    if normal is not None:
        m &= FN @ np.asarray(normal, float) > cos_min
    return np.nonzero(m)[0]


def dense(face_ids, density=40000.0, seed=1):
    rng = np.random.default_rng(seed)
    face_ids = np.asarray(face_ids)
    k = rng.poisson(FAREA[face_ids] * density) + 1
    idx = np.repeat(face_ids, k)
    r1, r2 = rng.random(len(idx)), rng.random(len(idx)); s = np.sqrt(r1)
    w0, w1, w2 = 1 - s, s * (1 - r2), s * r2
    f = F[idx]
    p = V[f[:, 0]] * w0[:, None] + V[f[:, 1]] * w1[:, None] + V[f[:, 2]] * w2[:, None]
    t = UV[f[:, 0]] * w0[:, None] + UV[f[:, 1]] * w1[:, None] + UV[f[:, 2]] * w2[:, None]
    col = TEX[np.clip((t[:, 1] * TH).astype(np.int64), 0, TH - 1), np.clip((t[:, 0] * TW).astype(np.int64), 0, TW - 1)]
    return p, col, FN[idx]


def ortho_bake(face_ids, origin, u_vec, v_vec, size_px, px=0.01, depth_vec=None, visible_tol=None,
               keep=None, fill=True, density=40000.0, seed=1):
    Wpx, Hpx = size_px
    p, col, n = dense(face_ids, density, seed)
    if keep is not None:
        k = keep(p, col, n); p, col, n = p[k], col[k], n[k]
    d = p - np.asarray(origin, float)
    ci = np.floor(d @ np.asarray(u_vec, float) / px).astype(np.int64)
    ri = np.floor(d @ np.asarray(v_vec, float) / px).astype(np.int64)
    ok = (ci >= 0) & (ci < Wpx) & (ri >= 0) & (ri < Hpx)
    lin = ri[ok] * Wpx + ci[ok]; col = col[ok].astype(np.float64)
    if depth_vec is not None and visible_tol is not None:
        dep = p[ok] @ np.asarray(depth_vec, float)
        dmax = np.full(Hpx * Wpx, -np.inf); np.maximum.at(dmax, lin, dep)
        vis = dep >= dmax[lin] - visible_tol
        lin, col = lin[vis], col[vis]
    cnt = np.bincount(lin, minlength=Hpx * Wpx).astype(np.float64)
    acc = np.stack([np.bincount(lin, weights=col[:, c], minlength=Hpx * Wpx) for c in range(3)], -1)
    cnt = cnt.reshape(Hpx, Wpx); acc = acc.reshape(Hpx, Wpx, 3)
    obs = cnt > 0
    img = acc / np.maximum(cnt, 1)[..., None]
    if fill:
        img = push_pull(img, obs.astype(np.float64))
    return np.clip(np.round(img), 0, 255).astype(np.uint8), obs
