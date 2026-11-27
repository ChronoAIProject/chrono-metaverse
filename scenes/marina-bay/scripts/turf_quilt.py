"""Periodic patch sampling for registered turf colour, tangent normals and roughness."""
import numpy as np
from scipy.ndimage import map_coordinates


def quilt(covers, size, surface, kinds, turns, phases, repeats):
    cells = turns.shape[0]
    cos = np.array([1, 0, -1, 0])
    sin = np.array([0, 1, 0, -1])
    out = np.empty((size, size, 3), np.float32)
    for top in range(0, size, 96):
        height = min(96, size - top)
        y, x = np.mgrid[top:top + height, :size]
        u, v = (x + .5) / size, (y + .5) / size
        # Periodic warping bends only the distribution of plants. Leaves retain their shape.
        gx = cells * u + .24 * np.sin(2 * np.pi * (u + v)) + .13 * np.cos(4 * np.pi * v)
        gy = cells * v + .22 * np.cos(2 * np.pi * (u - v)) - .16 * np.sin(4 * np.pi * u)
        ix, iy = np.floor(gx).astype(int), np.floor(gy).astype(int)
        fx, fy = gx - ix, gy - iy
        weights = np.zeros_like(u)
        pixels = np.zeros((*u.shape, 3), np.float32)
        for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1)):
            cx, cy = (ix + dx) % cells, (iy + dy) % cells
            weight = ((fx if dx else 1 - fx) * (fy if dy else 1 - fy)) ** 4
            weights += weight
            turns_here = turns[cy, cx]
            c, s = cos[turns_here], sin[turns_here]
            sx = (c * u - s * v) * repeats + phases[cy, cx, 0]
            sy = (s * u + c * v) * repeats + phases[cy, cx, 1]
            for index, pair in enumerate(covers):
                selected = kinds[cy, cx] == index
                if not selected.any():
                    continue
                src = pair[int(surface)]
                coords = [sy[selected] * src.shape[0] - .5, sx[selected] * src.shape[1] - .5]
                sample = np.stack([map_coordinates(ch, coords, order=1, mode="grid-wrap")
                                   for ch in src.transpose(2, 0, 1)], axis=1)
                if surface:
                    # Row coordinates increase down the image, while the green tangent points up.
                    nx, ny = sample[:, 0] * 2 - 1, sample[:, 1] * 2 - 1
                    sample[:, 0] = (c[selected] * nx - s[selected] * ny + 1) * .5
                    sample[:, 1] = (s[selected] * nx + c[selected] * ny + 1) * .5
                pixels[selected] += sample * weight[selected, None]
        out[top:top + height] = pixels / weights[..., None]
    return out
