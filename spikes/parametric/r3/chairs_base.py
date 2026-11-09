"""Chairs, step 4: 4-star base from the scanned FLOOR texture.

The base legs (~2 cm) are thinner than the scan mesh resolution (2.8 cm median edge), so they are not in the scan
geometry. Where a foot touches the floor its dark contact mark is baked into the floor texture at its true position
(the floor surface is metric there; above the floor the legs are smeared along the capture rays and are not used).
Per chair: floor texture darkness on a polar grid around the chair's seat axis (canonical frame), then a 4-fold
symmetric search for the foot radius R and the base orientation theta: score(R, theta) = mean darkness at the 4 points
(R, theta + k 90 deg) of a 1.5 cm blurred darkness map. The template foot radius = median of the confident chairs.
Output: out/r3/chairs_dbg/base.json (+ base_dark.png debug maps).
"""
import os, sys, json
import numpy as np
from scipy import ndimage
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import chairlib as L
from chairlib import canon
from PIL import Image, ImageDraw
D = os.path.join(L.OUTD, 'chairs_dbg')


def floor_darkness(prm, floor_y, axis_xz=(0.0, 0.0), rmax=0.5, cell=0.005):
    """Darkness map (1 - L / local floor L) of the scanned floor texture around a chair, canonical (x, z) grid."""
    S = L.C.scene()
    c = L.uncanon(np.array([[axis_xz[0], 0.0, axis_xz[1]]]), prm, tilt=False)[0]
    FC = S['FC']
    m = (np.hypot(FC[:, 0] - c[0], FC[:, 2] - c[2]) < rmax + 0.35) & (np.abs(FC[:, 1] - floor_y) < 0.04) & (S['FN'][:, 1] > 0.8)
    fids = np.nonzero(m)[0]
    P, Nn, col, _ = L.sample_faces(fids, 0.003, seed=3)
    Lc = canon(P, prm, tilt=False)
    lum = L.luminance(col)
    n = int(2 * (rmax + 0.3) / cell)
    ix = ((Lc[:, 0] - axis_xz[0] + rmax + 0.3) / cell).astype(int); iz = ((Lc[:, 2] - axis_xz[1] + rmax + 0.3) / cell).astype(int)
    ok = (ix >= 0) & (ix < n) & (iz >= 0) & (iz < n)
    s = np.zeros((n, n)); k = np.zeros((n, n))
    np.add.at(s, (ix[ok], iz[ok]), lum[ok]); np.add.at(k, (ix[ok], iz[ok]), 1)
    g = np.where(k > 0, s / np.maximum(k, 1), np.nan)
    # local floor brightness: 85th percentile in a 0.3 m window
    gf = np.where(np.isfinite(g), g, np.nanmedian(g))
    ref = ndimage.percentile_filter(gf, 85, size=int(0.3 / cell))
    dark = np.clip(1 - gf / np.maximum(ref, 1), 0, 1)
    dark[~np.isfinite(g)] = 0
    return dark, cell, rmax + 0.3


def star_fit(dark, cell, half, axis_xz=(0.0, 0.0), R_rng=(0.18, 0.42), blur=0.012):
    db = ndimage.gaussian_filter(dark, blur / cell)

    def sample(x, z):
        ix = (x + half) / cell; iz = (z + half) / cell
        return ndimage.map_coordinates(db, [ix, iz], order=1, mode='constant')
    best = (-1, None)
    grid = []
    for R in np.arange(R_rng[0], R_rng[1] + 1e-9, 0.005):
        th = np.radians(np.arange(0, 90, 1.0))
        a = th[:, None] + np.arange(4)[None] * np.pi / 2
        v = sample(R * np.sin(a), R * np.cos(a))         # (90, 4)
        # robust: mean of the 3 darkest feet (one foot may sit under the table / pedestal shadow)
        sc = np.sort(v, axis=1)[:, 1:].mean(1)
        # contrast against the ring average at this radius
        ring = sample(R * np.sin(np.linspace(0, 2 * np.pi, 180)), R * np.cos(np.linspace(0, 2 * np.pi, 180))).mean()
        sc = sc - ring
        grid.append(sc)
        j = int(np.argmax(sc))
        if sc[j] > best[0]:
            best = (float(sc[j]), (float(R), float(np.degrees(th[j]))))
    return best, np.array(grid)


def main():
    meta = json.load(open(os.path.join(D, 'aligned.json')))
    ids = meta['ids']; prm = np.array(meta['prm']); floors = meta['floors']
    res = {}; ims = []
    for i, cid in enumerate(ids):
        dark, cell, half = floor_darkness(prm[i], floors[i])
        (sc, (R, th)), grid = star_fit(dark, cell, half)
        res[cid] = dict(foot_radius=round(R, 4), base_theta_deg=round(th, 2), score=round(sc, 4))
        print(f'{cid}: foot radius {R:.3f} m, base orientation {th:.1f} deg (rel. to the shell, mod 90), contrast {sc:.3f}')
        im = Image.fromarray((255 * (1 - np.clip(dark.T[::-1] * 2.5, 0, 1))).astype(np.uint8)).convert('RGB')
        d = ImageDraw.Draw(im)
        for k in range(4):
            a = np.radians(th) + k * np.pi / 2
            x, z = R * np.sin(a), R * np.cos(a)
            u = (x + half) / cell; v = im.height - 1 - (z + half) / cell
            d.ellipse([u - 6, v - 6, u + 6, v + 6], outline=(255, 0, 0), width=2)
            d.line([(half / cell, im.height - 1 - half / cell), (u, v)], fill=(255, 120, 0))
        d.text((4, 4), f'{cid} R={R:.3f} th={th:.0f}', fill=(0, 0, 255))
        ims.append(im.resize((300, 300)))
    g = Image.new('RGB', (1200, 600))
    for k, im in enumerate(ims): g.paste(im, ((k % 4) * 300, (k // 4) * 300))
    g.save(os.path.join(D, 'base_dark.png'))
    json.dump(res, open(os.path.join(D, 'base.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
