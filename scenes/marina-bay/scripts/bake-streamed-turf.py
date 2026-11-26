"""Quilt a periodic grass atlas from registered colour, tangent normals and roughness scans."""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates


def load_rgb(path):
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"), dtype=np.float32) / 255


def linear(srgb):
    return np.where(srgb <= .04045, srgb / 12.92, ((srgb + .055) / 1.055) ** 2.4)


def display(rgb):
    return np.where(rgb <= .0031308, rgb * 12.92, 1.055 * np.maximum(rgb, 0) ** (1 / 2.4) - .055)


def registered_covers(original, scans):
    colour = linear(load_rgb(original / "turf-color.webp"))
    surface = load_rgb(original / "turf-surface.webp")
    target = colour.mean(axis=(0, 1), dtype=np.float64)
    covers = [(colour, surface)]
    for name in ("grass_ground", "leafy_grass"):
        folder = scans / name
        colour = linear(load_rgb(folder / "Color.jpg"))
        colour *= target / colour.mean(axis=(0, 1), dtype=np.float64)
        packed = load_rgb(folder / "NormalGL.jpg")
        with Image.open(folder / "Roughness.jpg") as image:
            if image.size != (packed.shape[1], packed.shape[0]):
                raise ValueError(f"Mismatched normal and roughness maps for {name}")
            packed[..., 2] = np.asarray(image.convert("L"), dtype=np.float32) / 255
        covers.append((colour, packed))
    return covers, target


def quilt(covers, size, surface):
    # Four connected patches per side, with three original scan widths across the sheet.
    # Each wrapped lattice point owns its crop and quarter turn on both texture channels.
    cells = 4
    rng = np.random.default_rng(4217)
    covers_by_cell = np.array([0] * 8 + [1] * 5 + [2] * 3)
    rng.shuffle(covers_by_cell)
    kinds = covers_by_cell.reshape(cells, cells)
    turns = rng.integers(4, size=(cells, cells))
    phases = rng.random((cells, cells, 2))
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
            sx = (c * u - s * v) * 3 + phases[cy, cx, 0]
            sy = (s * u + c * v) * 3 + phases[cy, cx, 1]
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


def bake(original, scans, out):
    out.mkdir(parents=True, exist_ok=True)
    covers, target = registered_covers(original, scans)
    for surface, name in ((False, "color"), (True, "surface")):
        size = covers[0][int(surface)].shape[0]
        result = quilt(covers, size, surface)
        if not surface:
            result *= target / result.mean(axis=(0, 1), dtype=np.float64)
            result = display(result)
        pixels = np.rint(255 * result).clip(0, 255).astype(np.uint8)
        Image.fromarray(pixels).save(out / f"turf-quilt-{name}.webp", lossless=surface,
                                    quality=92, method=6, exact=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original", type=Path, help="Directory with the original Grass004 colour and surface WebPs")
    parser.add_argument("covers", type=Path, help="Directory with the registered grass_ground and leafy_grass scans")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    bake(args.original, args.covers, args.output)
