"""Fill each measured slate with a photographed donor. Retain shading around the edges of overlapping tiles."""
import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates


def slate_rectangles(units):
    side = len(units)
    row = (units[..., 1].astype(int) - 1) % 11
    col = (units[..., 0].astype(int) - 1) % 9

    def run(mask):
        start = np.flatnonzero(mask & ~np.roll(mask, 1))
        if len(start) != 1:
            raise ValueError("Expected one cyclic interval in the photographed course.")
        return start[0], np.count_nonzero(mask)

    rectangles = np.empty((11, 9, 4), dtype=int)
    for r in range(11):
        top, height = run(row[:, 0] == r)
        for c in range(9):
            left, width = run(col[(top + height // 2) % side] == c)
            rectangles[r, c] = [left, top, width, height]
    return rectangles


def photographed_slates(image, units, seed, normal):
    source = np.asarray(image.convert('RGB'), dtype=np.float32)
    side = len(units)
    if source.shape[:2] != (side, side):
        raise ValueError("Slate textures and the photographed course chart must have the same dimensions.")
    rects = slate_rectangles(units)
    rng = np.random.default_rng(seed)
    # Bake the four-by-four repeat at source resolution before filtering for the GPU.
    n = side * 4
    out = np.empty((n, n, 3), dtype=np.float32)
    selections = rng.integers(0, 99, (44, 36))
    for top in range(0, n, 64):
        y, x = np.mgrid[top:min(n, top + 64), :n]
        local = units[y % side, x % side].astype(int)
        col = (x // side) * 9 + local[..., 0] - 1
        row = (y // side) * 11 + local[..., 1] - 1
        left, upper, width, height = rects[row % 11, col % 9].transpose(2, 0, 1)
        fx, fy = ((x - left) % side) / width, ((y - upper) % side) / height
        donor = selections[row % 44, col % 36]
        source_left, source_top, source_width, source_height = rects[donor // 9, donor % 9].transpose(2, 0, 1)
        # Retain the uneven lip at each actual overlap. Copy the donor's whole face inside.
        blend = local[..., 2].astype(float) / 255
        for ch in range(3):
            old = map_coordinates(source[..., ch].astype(float), [y, x], order=1, mode='grid-wrap')
            selected = map_coordinates(source[..., ch].astype(float), [source_top + fy * source_height, source_left + fx * source_width],
                                       order=1, mode='grid-wrap')
            out[top:top + len(x), :, ch] = old + blend * (selected - old)
    # Mip-filter stable features before packaging the larger sheet at walking-distance density.
    full = Image.fromarray(np.rint(out).clip(0, 255).astype(np.uint8))
    atlas = full.resize((768, 768), Image.Resampling.LANCZOS)
    if normal:
        vectors = np.asarray(atlas, dtype=float) / 127.5 - 1
        vectors /= np.maximum(np.linalg.norm(vectors, axis=2, keepdims=True), 1e-5)
        atlas = Image.fromarray(np.rint(127.5 * (vectors + 1)).clip(0, 255).astype(np.uint8))
    atlas.format = 'JPEG'
    return atlas
