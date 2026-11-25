"""Bake groups of occupied rooms into the glazing of the daylight facade sheets."""
from hashlib import sha256

import numpy as np
from PIL import Image


# Architectural bays and storeys in one original cladding repeat.
WINDOW_LAYOUT = {
    "RecessedBalconies": (4, 8), "ClayFins": (8, 7), "LimestonePiers": (6, 9),
    "BlueSpandrels": (6, 8), "PairedWindows": (4, 6), "HorizontalLouvers": (5, 8),
    "StaggeredGalleries": (6, 6), "SandstoneRibbons": (8, 8), "EnamelFins": (8, 8),
    "DoubleHeightFrames": (6, 8), "SilverRibbonGlazing": (8, 8), "BalconyBays": (8, 8),
    "GalleryScreens": (8, 8), "TerracottaOfficeGrid": (32, 32), "SilverPrecastOffice": (12, 12),
}


def repeats(name):
    # The scanned office grid already spans 32 floors. Retain its native sampling density.
    return (2, 2, 512) if name == "TerracottaOfficeGrid" else (3, 5, 256)


def occupied_windows(folder, group):
    bays, floors = WINDOW_LAYOUT[folder.name]
    horizontal, vertical, side = repeats(folder.name)
    columns, rows = bays * horizontal, floors * vertical
    with Image.open(folder / "Color.jpg") as image:
        tile = np.asarray(image.convert("RGB").resize((side, side), Image.Resampling.LANCZOS), dtype=np.float32)
    with Image.open(folder / "Metalness.jpg") as image:
        metal = np.asarray(image.convert("L").resize((side, side), Image.Resampling.LANCZOS), dtype=np.float32)
    # Narrow frames, parapets and fixed screens retain their original colour and surface response.
    glazing = np.clip((metal - 90) / 100, 0, 1)
    field = np.tile(tile, (vertical, horizontal, 1))
    mask = np.tile(glazing, (vertical, horizontal))[:, :, None]
    seed = sha256(f"{group}/{folder.name}".encode()).digest()[:8]
    rng = np.random.default_rng(int.from_bytes(seed, "little"))
    shades = np.empty((rows, columns), dtype=np.float32)
    depths = np.empty_like(shades)
    cloth = np.empty((rows, columns, 3), dtype=np.float32)
    fabrics = np.array([[169, 167, 150], [146, 154, 151], [174, 165, 144], [133, 147, 152]])
    for row in range(rows):
        col = 0
        while col < columns:
            end = min(columns, col + int(rng.choice([1, 2, 2, 3, 3, 4, 5])))
            daylight = rng.uniform(.69, 1.17)
            shades[row, col:end] = daylight + rng.uniform(-.04, .04, end-col)
            closed = rng.random() < .44
            depth = rng.choice([.24, .44, .61, .82, .98]) if closed else 0
            depths[row, col:end] = depth
            cloth[row, col:end] = fabrics[rng.integers(len(fabrics))]
            col = end
    x = (np.arange(side * horizontal) + .5) * bays / side
    y = (np.arange(side * vertical) + .5) * floors / side
    row = y.astype(int)[:, None]
    col = x.astype(int)[None, :]
    depth = depths[row, col]
    # A one-texel transition keeps a half-lowered blind stable in the generated mip chain.
    feather = floors / side
    blind = np.clip((depth - (y % 1)[:, None]) / feather + .5, 0, 1) * (depth > 0)
    pane = field * shades[row, col, None]
    reflected_fabric = .43 * field + .57 * cloth[row, col]
    interior = pane + blind[:, :, None] * (reflected_fabric - pane)
    result = np.clip(field + mask * (interior - field), 0, 255).astype(np.uint8)
    image = Image.fromarray(result)
    image.format = "JPEG"
    return image
