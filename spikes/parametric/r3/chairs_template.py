"""Chairs, step 3: reconstruct the meeting-chair TEMPLATE from the pooled canonical cloud (chairs_pool.py).

Every dimension comes from the pooled scan samples of the 8 aligned chairs (continuous coordinates):
  * shell frame recline: robust line fit of the outer back centre-line z(h) -> pitch_deg of the shell frame
  * backrest / arms: per level (shell frame, ~1.2 cm apart) the OUTER surface r_out(phi) in polar coordinates about the
    seat axis (median radius of outward-facing samples per 3 deg sector, smoothed across sectors and levels), the
    INNER surface = r_out - t(h) with the measured wall thickness t (paired outward / inward samples), the angular
    extent phi_end(h) = how far the observed side wall reaches forward (arm end). Each level gives a closed horseshoe
    band; the band is cut at the back/arm junction phi_split -> loft 'backrest' + lofts 'arm_left' / 'arm_right'.
  * seat: up-facing samples -> seat-top height line h(z), front edge z_front(x) (percentile of the seat-top extent per
    x strip), shell bottom height (lowest outer samples) -> loft along x (side profiles), so the seat-top slope is kept.
  * base (column + 4-star legs): the legs are ~2 cm thin, below the 2.8 cm scan-mesh resolution -> not in the scan
    geometry; their feet are visible as dark contact marks in the scanned floor texture (metric positions on the
    floor surface) -> foot radius / base orientation (chairs_base.py); the column links hub and shell bottom.
Writes out/r3/chairs_dbg/template_parts.json + debug images.
"""
import os, sys, json, time
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
import shapely
from shapely.geometry import Polygon
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import chairlib as L
import contour as C

D = os.path.join(L.OUTD, 'chairs_dbg')
SECT = np.radians(3.0)


def robust_line(x, y, it=4, k=2.5):
    w = np.ones(len(x))
    for _ in range(it):
        A = np.c_[np.ones(len(x)), x]
        coef = np.linalg.lstsq(A * w[:, None], y * w, rcond=None)[0]
        r = y - A @ coef; s = 1.4826 * np.median(np.abs(r[w > 0])) + 1e-4
        w = (np.abs(r) < k * s).astype(float)
    return coef, s


def to_frame(P, pitch, pivot):
    """Canonical -> shell frame (back made upright): inverse of Tilt with this pitch about pivot."""
    c = np.asarray(pivot, float)
    return (P - c) @ L.Rx(-pitch) + c


def from_frame(P, pitch, pivot):
    c = np.asarray(pivot, float)
    return (P - c) @ L.Rx(-pitch).T + c


def polar(P, zc):
    """phi = 0 at the back centre (-z), +pi/2 at +x; r = distance from the seat axis (0, zc)."""
    dx, dz = P[:, 0], P[:, 2] - zc
    return np.arctan2(dx, -dz), np.hypot(dx, dz)


def sector_profile(phi, r, w=None, nsec=None, min_n=3):
    """Median radius per SECT sector over phi in [0, pi]; NaN where < min_n samples."""
    nsec = nsec or int(np.ceil(np.pi / SECT))
    k = np.clip((phi / SECT).astype(int), 0, nsec - 1)
    out = np.full(nsec, np.nan); cnt = np.bincount(k, minlength=nsec)
    order = np.argsort(k); ks, rs = k[order], r[order]
    st = np.r_[0, np.cumsum(cnt)]
    for s in range(nsec):
        if cnt[s] >= min_n:
            out[s] = np.median(rs[st[s]:st[s + 1]])
    return out, cnt


def fill_smooth(prof, valid_end, sig=1.0):
    """Interpolate NaN gaps up to valid_end (sector index, exclusive) and Gaussian-smooth along phi."""
    x = np.arange(len(prof)); v = np.isfinite(prof)
    if v.sum() < 2:
        return prof
    f = np.interp(x, x[v], prof[v])
    # reflect about phi = 0 (mirror symmetric) before smoothing
    ext = np.r_[f[1:6][::-1], f[:valid_end]]
    sm = ndimage.gaussian_filter1d(ext, sig, mode='nearest')[5:]
    out = np.full(len(prof), np.nan); out[:valid_end] = sm
    return out


def band_polygon(r_out, t, phi_end, zc, tol=0.0, dphi=np.radians(2.5)):
    """Closed horseshoe band in (x, z): outer surface r_out(phi) (sector profile, linearly interpolated, phi in
    [-phi_end, +phi_end], phi_end continuous), inner surface r_out - t, flat end faces."""
    sc = (np.arange(len(r_out)) + 0.5) * SECT
    v = np.isfinite(r_out)
    n = max(4, int(np.ceil(phi_end / dphi)))
    ph = np.linspace(0.0, phi_end, n + 1)
    ro = np.interp(ph, sc[v], r_out[v])
    ri = ro - t
    outer = np.c_[ro * np.sin(ph), zc - ro * np.cos(ph)]
    inner = np.c_[ri * np.sin(ph), zc - ri * np.cos(ph)]
    outer_full = np.r_[(outer * [-1, 1])[::-1], outer[1:]]
    inner_full = np.r_[(inner * [-1, 1])[::-1], inner[1:]]
    ring = C.dedupe(C.ccw(np.r_[outer_full, inner_full[::-1]]))
    if tol <= 0:                    # uniform phi sampling: the same parameterisation on every level -> clean bands
        return ring
    return ring[C.dp_closed(ring, tol)]


def split_band(poly, phi_split, zc):
    """Cut a band polygon into back (|phi| <= phi_split) and the two arm pieces."""
    P = Polygon(poly).buffer(0)
    R = 2.0
    wedge = Polygon([(0, zc), (R * np.sin(-phi_split), zc - R * np.cos(-phi_split)), (0, zc - R),
                     (R * np.sin(phi_split), zc - R * np.cos(phi_split))])
    back = P.intersection(wedge)
    rest = P.difference(wedge)
    arms_r = [g for g in C._geoms(rest) if g.centroid.x > 0]
    arms_l = [g for g in C._geoms(rest) if g.centroid.x < 0]
    pick = lambda gs: max(gs, key=lambda g: g.area) if gs else None
    b = pick(C._geoms(back))
    return b, pick(arms_l), pick(arms_r)


def ring_of(g, tol=0.0005):
    if g is None or g.is_empty or g.area < 2e-5:
        return None
    P = C.ccw(np.asarray(g.exterior.coords)[:-1])
    P = C.dedupe(P)
    k = C.dp_closed(P, tol)
    return np.round(P[k], 5) if len(k) >= 3 else None


def build(verbose=True):
    t0 = time.time()
    z = np.load(os.path.join(D, 'pooled.npz'))
    P, N, Ccol = z['P'], z['N'], z['C']
    rep = {}
    # ------------------------------------------------ template pose: seat top level (a chair standing on its base);
    # the alignment gauge (mean pitch 0 over all chairs) is arbitrary because the two table sides of the scan disagree
    # by ~12 deg in lean. gamma is subtracted from every instance pitch (rotations about the same pivot add).
    st0 = (N[:, 1] > 0.8) & (P[:, 1] > 0.40) & (P[:, 1] < 0.58) & (np.abs(P[:, 0]) < 0.15) & (P[:, 2] > -0.05) & (P[:, 2] < 0.30)
    (_, sl0), _ = robust_line(P[st0, 2], P[st0, 1])
    gamma = float(np.degrees(np.arctan(sl0))) * -1.0
    pv = np.array([0.0, L.PIVOT_H, 0.0])
    P = (P - pv) @ L.Rx(-gamma).T + pv; N = N @ L.Rx(-gamma).T
    rep.update(template_regauge_deg=round(gamma, 3), seat_slope_before_deg=round(-gamma, 2))
    if verbose:
        print(f'regauge: pooled seat slope {-gamma:+.2f} deg -> template tilted by {gamma:+.2f} deg (seat level)')
    # ------------------------------------------------ shell frame: back recline from the outer back centre-line
    m = (N[:, 2] < -0.7) & (np.abs(P[:, 0]) < 0.12) & (P[:, 1] > 0.45) & (P[:, 1] < 0.72) & (P[:, 2] < -0.1)
    (z0, b), s = robust_line(P[m, 1], P[m, 2])
    alpha = float(np.degrees(np.arctan(-b)))           # > 0: back top further back (reclined)
    out_back = m
    h_bot = float(np.percentile(P[(N[:, 2] < -0.3) & (P[:, 2] < -0.1) & (np.abs(P[:, 0]) < 0.2), 1], 1.0))
    z_bot = float(z0 + b * h_bot)
    pivot = [0.0, round(h_bot, 4), round(z_bot, 4)]
    rep.update(back_recline_deg=round(alpha, 2), back_line_resid_mm=round(s * 1000, 1), shell_bottom_h=round(h_bot, 4))
    if verbose:
        print(f'back recline {alpha:+.2f} deg (outer centre-line, resid {s * 1000:.1f} mm), shell bottom h {h_bot:.3f}')
    Q = to_frame(P, alpha, pivot); NQ = N @ L.Rx(-alpha)
    # rim (top of the back): up-facing samples above 0.65 behind the seat
    rim = (NQ[:, 1] > 0.7) & (Q[:, 1] > 0.62) & (Q[:, 2] < -0.05)
    h_rim = float(np.percentile(Q[rim, 1], 75)) if rim.sum() > 20 else float(np.percentile(Q[out_back, 1], 99))
    # ------------------------------------------------ seat axis zc: centre of the outer back U (circle fit at mid height)
    mid = (np.abs(Q[:, 1] - 0.58) < 0.03) & (np.abs(NQ[:, 1]) < 0.5)
    phi0, r0 = polar(Q[mid], 0.0)
    rad = np.c_[Q[mid, 0], Q[mid, 2]] / np.maximum(r0[:, None], 1e-9)
    outw = np.einsum('ij,ij->i', NQ[mid][:, [0, 2]], rad) > 0.4
    A = np.c_[2 * Q[mid][outw, 0], 2 * Q[mid][outw, 2], np.ones(outw.sum())]
    bb = (Q[mid][outw, 0] ** 2 + Q[mid][outw, 2] ** 2)
    cx, cz, cc = np.linalg.lstsq(A, bb, rcond=None)[0]
    zc = float(cz)
    rep.update(rim_h=round(h_rim, 4), back_circle_zc=round(zc, 4), back_circle_r=round(float(np.sqrt(cc + cx ** 2 + cz ** 2)), 4))
    if verbose:
        print(f'rim h {h_rim:.3f}, back U circle centre z {zc:+.3f} r {rep["back_circle_r"]:.3f}')
    # ------------------------------------------------ per-level outer / inner profiles
    step = float(np.clip((h_rim - h_bot) / 30.0, 0.008, 0.02))
    levels = np.r_[np.arange(h_bot + 0.004, h_rim - 0.004, step), h_rim - 0.004]
    phiQ, rQ = polar(Q, zc)
    aphi = np.abs(phiQ)
    radv = np.c_[Q[:, 0], Q[:, 2] - zc] / np.maximum(rQ[:, None], 1e-9)
    ndr = np.einsum('ij,ij->i', NQ[:, [0, 2]], radv)
    horiz = np.abs(NQ[:, 1]) < 0.6
    nsec = int(np.ceil(np.pi / SECT))
    RO, RI, CNT = [], [], []
    for lv in levels:
        sl = np.abs(Q[:, 1] - lv) < 0.75 * step
        o = sl & horiz & (ndr > 0.35); i_ = sl & horiz & (ndr < -0.35)
        ro, co = sector_profile(aphi[o], rQ[o]); ri, ci = sector_profile(aphi[i_], rQ[i_])
        RO.append(ro); RI.append(ri); CNT.append(co)
    RO, RI, CNT = np.array(RO), np.array(RI), np.array(CNT)
    # wall thickness: paired sectors, robust per level then smoothed along h
    T = RO - RI
    Tv = np.where((T > 0.008) & (T < 0.08), T, np.nan)
    t_glob = float(np.nanmedian(Tv))
    t_lv = np.array([np.nanmedian(r) if np.isfinite(r).sum() >= 4 else np.nan for r in Tv])
    ok = np.isfinite(t_lv)
    t_lv = np.interp(levels, levels[ok], t_lv[ok]) if ok.sum() >= 2 else np.full(len(levels), t_glob)
    t_lv = ndimage.gaussian_filter1d(ndimage.median_filter(t_lv, 5, mode='nearest'), 1.5, mode='nearest')
    rep.update(wall_thickness_median_m=round(t_glob, 4), wall_thickness_range_m=[round(float(t_lv.min()), 4), round(float(t_lv.max()), 4)])
    # angular extent per level: last sector of the contiguous observed run from phi = 0 (gaps <= 2 sectors bridged)
    n_end = []
    for ro in RO:
        v = np.isfinite(ro); e = 0; gap = 0
        for s_ in range(nsec):
            if v[s_]:
                e = s_ + 1; gap = 0
            else:
                gap += 1
                if gap > 2:
                    break
        n_end.append(e)
    n_end = np.array(n_end)
    n_end = ndimage.median_filter(n_end, 3, mode='nearest')
    # smooth r_out across levels (median of 3) after filling gaps along phi
    # continuous angular extent: Gaussian-smoothed over the levels (no 3-deg sector quantisation in the outlines)
    phi_end = ndimage.gaussian_filter1d((n_end * SECT).astype(float), 2.5, mode='nearest')
    # r_out: gaps filled along phi (up to the sector extent, extrapolated to the full half circle with the last value
    # so that neighbouring levels can be smoothed), then Gaussian-smoothed across levels (sigma 1.5 levels)
    ROf = np.array([fill_smooth(RO[k], max(n_end[k], 2), sig=1.2) for k in range(len(levels))])
    for k in range(len(levels)):
        v = np.isfinite(ROf[k])
        if v.any():
            ROf[k, ~v] = ROf[k, np.nonzero(v)[0][-1]]
    ROs = ndimage.gaussian_filter1d(ROf, 1.5, axis=0, mode='nearest')
    for k in range(len(levels)):
        ROs[k, int(np.ceil(phi_end[k] / SECT)) + 1:] = np.nan
    rep.update(levels=len(levels), level_step_m=round(step, 4),
               arm_end_deg=[round(float(np.degrees(e * SECT)), 1) for e in n_end])
    # ------------------------------------------------ bands -> backrest / arms polygons
    phi_split = np.radians(62.0)
    back_secs, arml, armr, bands = [], [], [], []
    for k, lv in enumerate(levels):
        if phi_end[k] < 4 * SECT:
            continue
        poly = band_polygon(ROs[k], t_lv[k], phi_end[k], zc)
        bands.append((lv, poly))
        b_, l_, r_ = split_band(poly, phi_split, zc)
        rb, rl, rr = ring_of(b_), ring_of(l_), ring_of(r_)
        if rb is not None:
            back_secs.append(dict(y=round(float(lv), 5), outline=rb.tolist()))
        if rl is not None and rr is not None:
            arml.append(dict(y=round(float(lv), 5), outline=rl.tolist())); armr.append(dict(y=round(float(lv), 5), outline=rr.tolist()))
    # rim cap: the top section is the last band at the rim height
    if back_secs:
        back_secs.append(dict(y=round(h_rim, 5), outline=back_secs[-1]['outline']))
    # ------------------------------------------------ seat (horizontal-section loft): top height = median of the
    # up-facing samples on the seat, outline = region inside the shell wall at that height, closed at the front by the
    # observed seat-top extent (per x strip), bottom = shell bottom
    st = (N[:, 1] > 0.8) & (P[:, 1] > h_bot) & (P[:, 1] < h_bot + 0.16) & (P[:, 2] > -0.12) & (np.abs(P[:, 0]) < 0.32)
    Pst = P[st]
    (a0, a1), sres = robust_line(Pst[:, 2], Pst[:, 1])
    h_seat = float(np.median(Pst[np.abs(Pst[:, 1] - np.median(Pst[:, 1])) < 0.03, 1]))
    flat = np.abs(Pst[:, 1] - h_seat) < 0.025
    Pf = Pst[flat]
    xs = np.abs(Pf[:, 0])
    half_w = float(np.percentile(xs, 98))
    strips = np.linspace(0, half_w, 8)
    zf = []
    for xa, xb_ in zip(strips[:-1], strips[1:]):
        mm = (xs >= xa) & (xs < xb_)
        zf.append(np.percentile(Pf[mm, 2], 98) if mm.sum() > 20 else np.nan)
    zf = np.array(zf); okf = np.isfinite(zf)
    zf = np.interp(np.arange(len(zf)), np.arange(len(zf))[okf], zf[okf])
    zf = np.minimum.accumulate(zf)                       # the front edge recedes towards the corners
    xm = 0.5 * (strips[:-1] + strips[1:])
    rep.update(seat_top_h=round(h_seat, 4), seat_top_slope_after_regauge_deg=round(float(np.degrees(np.arctan(a1))), 2),
               seat_front_z_centre=round(float(zf[0]), 4), seat_half_width=round(half_w, 4), seat_top_samples=int(flat.sum()))
    if verbose:
        print(f'seat top h {h_seat:.3f} (slope after regauge {np.degrees(np.arctan(a1)):+.1f} deg), front z {zf[0]:.3f}, half width {half_w:.3f}')
    kk = int(np.argmin(np.abs(levels - h_seat))); ne_s = int(n_end[kk])
    ph = (np.arange(ne_s) + 0.5) * SECT; ri = ROs[kk, :ne_s] - t_lv[kk]
    inner = np.c_[ri * np.sin(ph), zc - ri * np.cos(ph)]
    inner = from_frame(np.c_[inner[:, 0], np.full(len(inner), h_seat), inner[:, 1]], alpha, pivot)[:, [0, 2]]
    inner = inner[np.isfinite(inner).all(1)]
    # right half: inner wall from the back centre to its forward end, then the front edge strips back to x = 0
    fx = np.r_[half_w, xm[::-1], 0.0]; fz = np.r_[zf[-1] - 0.02, zf[::-1], zf[0]]
    zwall_end = inner[-1, 1]
    side = np.c_[np.full(2, max(inner[-1, 0], half_w)), [zwall_end, zf[-1] - 0.02]]
    right = np.r_[inner, side, np.c_[fx, fz]]
    right = right[right[:, 0] >= -1e-9]
    ring = np.r_[right, (right * [-1, 1])[::-1]]
    sp = Polygon(ring).buffer(0)
    sp = sp.buffer(0.01, quad_segs=4).buffer(-0.01, quad_segs=4)
    seat_ring = ring_of(max(C._geoms(sp), key=lambda g: g.area), tol=0.002)
    bot_ring = ring_of(Polygon(seat_ring).buffer(-0.015, quad_segs=4), tol=0.002)
    seat_secs = [dict(y=round(h_bot, 5), outline=bot_ring.tolist()), dict(y=round(h_bot + 0.02, 5), outline=seat_ring.tolist()),
                 dict(y=round(h_seat, 5), outline=seat_ring.tolist())]
    rep['seat_outline_vertices'] = int(len(seat_ring))
    parts = []
    frame = dict(pitch_deg=round(alpha, 3), pivot=pivot)
    parts.append(dict(type='loft', name='seat', axis='y', sections=seat_secs, group='upper',
                      source='pooled up-facing seat samples: top height, front edge per x strip; back/sides = inner shell wall'))
    parts.append(dict(type='loft', name='backrest', axis='y', frame=frame, sections=back_secs, group='upper',
                      source='pooled outer/inner back samples, polar profile per level (shell frame pitched by the measured recline)'))
    if len(arml) >= 2:
        parts.append(dict(type='loft', name='arm_left', axis='y', frame=frame, sections=arml, group='upper',
                          source='pooled side-wall samples beyond the back/arm junction (phi > 62 deg)'))
        parts.append(dict(type='loft', name='arm_right', axis='y', frame=frame, sections=armr, group='upper',
                          source='pooled side-wall samples beyond the back/arm junction (phi > 62 deg)'))
    if verbose:
        print(f'parts: seat {len(seat_secs)} sections, backrest {len(back_secs)}, arms {len(arml)} ({time.time() - t0:.1f}s)')
    rep['template_regauge_deg'] = round(gamma, 3)
    dbg = dict(gamma=gamma, phi_end=phi_end, levels=levels, RO=RO, RI=RI, ROs=ROs, n_end=n_end, t_lv=t_lv, zc=zc, bands=bands, alpha=alpha, pivot=pivot)
    return parts, rep, dbg


if __name__ == '__main__':
    parts, rep, dbg = build()
    json.dump(dict(parts=parts, report=rep), open(os.path.join(D, 'template_parts.json'), 'w'), indent=1)
    print(json.dumps(rep, indent=1)[:2000])
