"""Bake repeatable surface variation into registered colour and material scans."""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import zoom


def field(side, seed, rows, columns):
    """Periodic smooth field sampled at texel centres, independent of resolution."""
    grid = np.random.default_rng(seed).uniform(-1, 1, (rows, columns)).astype(np.float32)
    grid -= grid.mean()
    return zoom(grid, (side / rows, side / columns), order=3, mode="grid-wrap", grid_mode=True)


def encode(path, pixels, *, lossless=False):
    image = Image.fromarray(np.rint(pixels).clip(0, 255).astype(np.uint8))
    image.save(path, lossless=lossless, quality=92, method=6, exact=True)


def ground(source, output, name):
    for channel in ("color", "surface"):
        filename = f"{name}-{channel}.webp"
        scan = np.asarray(Image.open(source / filename), dtype=np.float32)
        side = len(scan)
        if name == "turf":
            # Both resolutions select the same intact clumps from the original scan.
            weight = np.clip(field(side, 1217, 6, 8) * 3 + .5, 0, 1)[..., None]
            other = np.roll(scan, (side * 5 // 16, side * 7 // 16), axis=(0, 1))
            scan += (other - scan) * weight
            wear = .72 * field(side, 1811, 4, 3) + .28 * field(side, 1812, 13, 9)
            tint = [.21, .095, -.06]
        else:
            # Mineral and polish variation within the granite, independent of slab order.
            wear = .58 * field(side, 2451, 9, 7) + .42 * field(side, 2452, 18, 24)
            tint = [.16, .115, .07]
        if channel == "color":
            scan *= 1 + wear[..., None] * tint
        else:
            # Lower, smoother worn patches retain the original normal direction.
            worn = np.maximum(wear, 0)
            scan[..., :2] = 127.5 + (scan[..., :2] - 127.5) * (1 - .20 * worn[..., None])
            scan[..., 2] -= 18 * wear
        encode(output / filename, scan, lossless=channel == "surface")


def buildings(source, output):
    atlas = np.array(Image.open(source / "facades.webp"))
    side = atlas.shape[1] // 4
    for layer in range(4 * atlas.shape[0] // side):
        y, x = layer // 4 * side, layer % 4 * side
        tile = atlas[y:y + side, x:x + side]
        seed = 3779 + 3 * layer
        # Metal roofing and wall panels stain along their ribs. Concrete weathers in patches.
        rows, columns = (3, 13) if layer == 7 else (6, 5) if layer in (8, 9) else (3, 8)
        wear = .70 * field(side, seed, rows, columns) + .30 * field(side, seed + 1, 19, 17)
        glass = (tile[..., 3].astype(np.float32) - 128).clip(0, 127) / 127
        amount = wear * (1 - .84 * glass)
        rgb = tile[..., :3] * (1 + amount[..., None] * [.20, .15, .105])
        tile[..., :3] = np.rint(rgb).clip(0, 255)
    encode(output / "facades.webp", atlas)


def ground_grain(source, output):
    packed = np.array(Image.open(source / "surface-detail.webp"), dtype=np.float32)
    side = len(packed)
    for channel in range(3):
        grain = packed[..., channel]
        # Grass, paving and road grain each has its own patch boundaries.
        mix = np.clip(field(side, 371 + channel, 6, 7) * 4 + .5, 0, 1)
        shifted = np.roll(grain, (side * 3 // 8, side // 4), axis=(0, 1))
        mean = grain.mean()
        grain += mix * (shifted - grain)
        grain += mean - grain.mean()
    # RGB packs independent scalar measurements. Preserve all three channels.
    encode(output / "surface-detail.webp", packed, lossless=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Original geography texture directory")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve():
        parser.error("Use separate input and output directories to keep the original scans")
    args.output.mkdir(parents=True, exist_ok=True)
    for material in ("turf", "pavers"):
        ground(args.source, args.output, material)
    buildings(args.source, args.output)
    ground_grain(args.source, args.output)
