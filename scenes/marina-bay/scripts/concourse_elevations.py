"""Bake contiguous photographed floors into the three Concourse tower materials."""
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates
from scipy.special import expit

REFERENCES = Path(__file__).resolve().parents[1] / "references/concourse-elevations"


def read_elevations():
    return json.loads((REFERENCES / "sheets.json").read_text())


def photographed_maps(layout):
    columns, rows = layout["columns"], layout["rows"]
    width, height = layout["cellSize"]
    y, x = np.indices((rows * height, columns * width))
    row, column = y // height, x // width
    u, v = (x % width + .5) / width, (y % height + .5) / height
    rng = np.random.default_rng(layout["seed"])
    donors = layout["donors"]
    sources = np.arange(columns) % len(donors)
    rng.shuffle(sources)
    floors = np.zeros((rows, columns), dtype=int)
    tiers = layout["floorsPerRow"] > 1
    for j, source in enumerate(sources):
        levels = donors[source]["levels"]
        if tiers:
            floors[:, j] = (np.arange(rows) + j) % levels
            continue
        first = 0
        while first < rows:
            count = min(rows - first, rng.integers(4, min(10, levels) + 1))
            floors[first:first + count, j] = rng.integers(levels - count + 1) + np.arange(count)
            first += count

    # Keep each source column in place vertically. Select whole runs of photographed floors.
    sample = np.empty((*row.shape, 3), dtype=np.float32)
    for i, donor in enumerate(donors):
        selected = sources[column] == i
        px = donor["left"] + u[selected] * (donor["right"] - donor["left"])
        py = donor["firstFloor"] + (floors[row[selected], column[selected]] + v[selected]) * donor["floorPitch"]
        with Image.open(REFERENCES / donor["image"]) as image:
            rgb = np.asarray(image.convert("RGB"), dtype=np.float32)
        sample[selected] = np.stack([map_coordinates(channel, [py, px], order=1, mode="nearest")
                                     for channel in rgb.transpose(2, 0, 1)], axis=-1)

    # Remove the broad daylight cast, retaining variation in rooms and balcony recesses.
    luminance = sample @ [.2126, .7152, .0722]
    cladding = expit((luminance - (167 if tiers else 164)) / 8)
    tone = np.clip((luminance - 95) / 119, 0, 1)
    low, high = np.percentile(luminance, [5, 95])
    shade = np.clip((luminance - low) / (high - low), 0, 1)
    glazing = [43, 58, 71] + tone[:, :, None] * [54, 60, 63]
    wall = [112, 117, 120] + shade[:, :, None] * [64, 62, 58]
    colour = glazing + cladding[:, :, None] * (wall - glazing)
    chroma = sample - luminance[:, :, None]
    colour += .47 * (chroma - np.median(chroma, axis=(0, 1)))

    # Recurring sill and jamb positions also control roughness and the shallow relief.
    typical_floor = np.median(cladding.reshape(rows, height, -1), axis=0)
    frame = .73 * np.tile(typical_floor, (rows, 1)) + .27 * cladding
    surface = np.stack([np.full_like(frame, 255), 101 + 116 * frame, 158 * (1 - frame)], axis=2)
    dy, dx = np.gradient(gaussian_filter(frame, 1.05, mode="wrap"))
    normals = np.dstack([-.63 * dx, .63 * dy, np.ones_like(dx)])
    normals /= np.linalg.norm(normals, axis=2, keepdims=True)
    maps = []
    for pixels in (colour, surface, (normals * .5 + .5) * 255):
        image = Image.fromarray(np.rint(pixels).clip(0, 255).astype(np.uint8))
        image.format = "JPEG"
        maps.append(image)
    return maps
