"""Quilt a periodic grass atlas from registered colour, tangent normals and roughness scans."""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image
from turf_quilt import quilt


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


def bake(original, scans, out):
    out.mkdir(parents=True, exist_ok=True)
    covers, target = registered_covers(original, scans)
    cells = 4
    rng = np.random.default_rng(4217)
    covers_by_cell = np.array([0] * 8 + [1] * 5 + [2] * 3)
    rng.shuffle(covers_by_cell)
    kinds = covers_by_cell.reshape(cells, cells)
    turns = rng.integers(4, size=(cells, cells))
    phases = rng.random((cells, cells, 2))
    for surface, name in ((False, "color"), (True, "surface")):
        size = covers[0][int(surface)].shape[0]
        result = quilt(covers, size, surface, kinds, turns, phases, 3)
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
