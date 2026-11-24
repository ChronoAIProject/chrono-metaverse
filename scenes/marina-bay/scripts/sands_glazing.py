"""Project the visible hotel glazing in Ank Kumar's Merlion Park photograph into the SLA atlas."""

from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates

PHOTO = Path(__file__).resolve().parents[1] / "references/marina-bay-sands-glazing.png"
CREDIT = ("Marina Bay Sands view from Merlion Park, Singapore (Ank Kumar) 01. "
          "Ank Kumar, CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). "
          "Cropped, masked and projected into the bay-facing glazing. "
          "https://commons.wikimedia.org/wiki/File:Marina_Bay_Sands_view_from_Merlion_Park,_Singapore_(Ank_Kumar)_01.jpg")

# Local metres to the cropped photograph, fitted to six upper glazing corners
# and the two outside edges of each tower. Perspective divide yields pixel coordinates.
PROJECTION = np.array([
    [-890.14176313, 23.97471652, -3354.13591022, 2133700.91644349],
    [-795.98623211, -3519.60645833, 328.29886756, -92937.78411218],
    [-.92536146, -.07571273, .37144818, 126.38622491],
])


def front_wall_indices(vertices, faces):
    """Follow the continuous curtain wall through its UV seams from its largest triangle."""
    triangles = vertices[faces]
    areas = np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0],
                                    triangles[:, 2] - triangles[:, 0]), axis=1)
    corners = np.round(triangles, 2)
    adjacent = defaultdict(set)
    for i, triangle in enumerate(corners):
        for point in triangle:
            adjacent[tuple(point)].add(i)
    selected = {int(np.argmax(areas))}
    pending = list(selected)
    while pending:
        triangle = corners[pending.pop()]
        neighbours = set.union(*(adjacent[tuple(point)] for point in triangle)) - selected
        selected.update(neighbours)
        pending.extend(neighbours)
    return sorted(selected)


def apply_glazing(image, triangles):
    with Image.open(PHOTO) as source:
        photo = np.array(source, dtype=np.float32)
    atlas = np.array(image)
    for positions, uv in triangles:
        texels = uv * image.size - .5
        low = np.maximum(0, np.floor(texels.min(axis=0)).astype(int))
        high = np.minimum(np.array(image.size) - 1, np.ceil(texels.max(axis=0)).astype(int))
        y, x = np.mgrid[low[1]:high[1]+1, low[0]:high[0]+1]
        axes = texels[1:] - texels[0]
        if abs(np.linalg.det(axes)) < 1e-6:
            continue
        s, t = ((np.stack((x, y), axis=-1) - texels[0]) @ np.linalg.inv(axes)).transpose(2, 0, 1)
        inside = (s >= 0) & (t >= 0) & (s + t <= 1)
        x, y, s, t = (a[inside] for a in (x, y, s, t))
        world = positions[0] + s[:, None]*(positions[1]-positions[0]) + t[:, None]*(positions[2]-positions[0])
        projected = world @ PROJECTION[:, :3].T + PROJECTION[:, 3]
        coords = (projected[:, 1::-1] / projected[:, 2:3]).T
        rgba = np.column_stack([map_coordinates(channel, coords, order=1, mode="constant")
                                for channel in photo.transpose(2, 0, 1)])
        # The promenade roofs obscure the lowest storeys. Extend the visible
        # window bays in the same column beneath the photographed roofline.
        hidden = (coords[0] > 590) & (rgba[:, 3] < 255)
        if np.any(hidden):
            patch = coords[:, hidden].copy()
            patch[0] = 565 + (patch[0] - 565) % 29
            donor = np.column_stack([map_coordinates(channel, patch, order=1, mode="constant")
                                     for channel in photo.transpose(2, 0, 1)])
            observed = rgba[hidden, 3:] / 255
            inferred = donor[:, 3:] / 255 * (1 - observed)
            combined = observed + inferred
            rgba[hidden, :3] = ((rgba[hidden, :3] * observed + donor[:, :3] * inferred)
                                / np.maximum(combined, 1e-6))
            rgba[hidden, 3] = combined[:, 0] * 255
        weight = rgba[:, 3:] / 255
        atlas[y, x] = np.rint(atlas[y, x] * (1 - weight) + rgba[:, :3] * weight).astype(np.uint8)
    return Image.fromarray(atlas)
