"""Rasterize leaf and twig scans into a small, depth-tested canopy atlas."""

import numpy as np
from PIL import Image


def render_tile(screen, depth, uv, materials, textures, size):
    # Rasterize at twice the output resolution. Each covered sample evaluates
    # the original leaf UV and opacity before taking part in the depth test.
    resolution = 2 * size
    coords = screen * (resolution - 1) / (size - 1)
    lo = np.clip(np.floor(coords.min(axis=1)).astype(int), 0, resolution - 1)
    hi = np.clip(np.ceil(coords.max(axis=1)).astype(int), 0, resolution - 1)
    width, height = (hi - lo + 1).T
    areas = width * height
    face = np.repeat(np.arange(len(areas)), areas)
    index = np.arange(len(face)) - np.repeat(np.cumsum(areas) - areas, areas)
    x = lo[face, 0] + index % width[face]
    y = lo[face, 1] + index // width[face]
    a, b, c = coords.transpose(1, 0, 2)
    ab, ac = b - a, c - a
    det = ab[:, 0] * ac[:, 1] - ab[:, 1] * ac[:, 0]
    dx, dy = x + .5 - a[face, 0], y + .5 - a[face, 1]
    with np.errstate(divide="ignore", invalid="ignore"):
        wb = (dx * ac[face, 1] - dy * ac[face, 0]) / det[face]
        wc = (dy * ab[face, 0] - dx * ab[face, 1]) / det[face]
    inside = (wb >= 0) & (wc >= 0) & (wb + wc <= 1) & (np.abs(det[face]) > 1e-8)
    face, x, y, wb, wc = (v[inside] for v in (face, x, y, wb, wc))
    weights = np.column_stack((1 - wb - wc, wb, wc))
    z = np.einsum("ij,ij->i", weights, depth[face])
    texcoords = np.einsum("ij,ijk->ik", weights, uv[face]) % 1
    paint = np.empty((len(face), 4), np.uint8)
    for i, texture in enumerate(textures):
        select = materials[face] == i
        tx, ty = (texcoords[select] * texture.shape[1::-1]).astype(int).T
        paint[select] = texture[ty, tx]
    visible = paint[:, 3] >= 128
    order = np.argsort(z[visible], kind="stable")
    rgba = np.zeros((resolution, resolution, 4), np.uint8)
    rgba[y[visible][order], x[visible][order]] = paint[visible][order]
    return Image.fromarray(rgba).resize((size, size), Image.Resampling.LANCZOS)
