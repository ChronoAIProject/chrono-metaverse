"""Fit textured sprays of photographed leaves to the local direction of a scanned crown."""
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance
from scipy.ndimage import distance_transform_edt


def spray_atlas(folder, name):
    textures = folder / 'textures'
    colour = Image.open(textures / f'{name}_leaves_diff_1k.jpg').convert('RGBA')
    colour.putalpha(Image.open(textures / f'{name}_leaves_alpha_1k.png').convert('L'))
    # The first scan contains compound fronds. The second contains individual blades.
    compound = name == 'jacaranda_tree'
    boxes = ([(.155, .00, 1., .44), (.245, .58, 1., 1.)] if compound else
             [(.00, .015, .159, .51), (.158, .01, .331, .50), (.337, .015, .482, .45)])
    leaves = [colour.crop(tuple(round(x * colour.width) for x in box)) for box in boxes]
    size, columns = 192, 4
    atlas = Image.new('RGBA', (columns * size, columns * size))
    rng = np.random.default_rng(305)
    for index in range(columns ** 2):
        sprite = Image.new('RGBA', (size, size))
        ink = ImageDraw.Draw(sprite)
        root = np.array([.12, rng.uniform(.45, .59)]) * size
        tip = np.array([.90, rng.uniform(.41, .57)]) * size
        ink.line([tuple(root), tuple(tip)], fill=(97, 91, 61, 235), width=2)
        for k, station in enumerate(np.linspace(.18, .90, 13 if compound else 22)):
            side = 1 - 2 * (k % 2)
            angle = side * rng.uniform(31, 60)
            length = size * rng.uniform(.27, .42) * (1 - .40 * station)
            source_index = rng.integers(len(leaves))
            blade = leaves[source_index]
            if not compound:
                blade = blade.transpose(Image.Transpose.ROTATE_270)
            elif source_index == 1:
                blade = blade.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            height = max(5, round(length * blade.height / blade.width))
            leaf = blade.resize((round(length), height), Image.Resampling.LANCZOS)
            leaf = ImageEnhance.Brightness(leaf).enhance(rng.uniform(.75, 1.10))
            leaf = ImageEnhance.Color(leaf).enhance(.80)
            leaf = leaf.rotate(-angle, Image.Resampling.BICUBIC, expand=True)
            rad = np.deg2rad(angle)
            centre = root + station * (tip - root) + .43 * length * np.array([np.cos(rad), np.sin(rad)])
            sprite.alpha_composite(leaf, tuple(np.rint(centre - .5 * np.array(leaf.size)).astype(int)))
        rgba = np.array(sprite)
        valid = rgba[:, :, 3] > 80
        nearest = distance_transform_edt(~valid, return_indices=True, return_distances=False)
        # Pad the RGB outside the mask to avoid black fringes as the atlas shrinks.
        rgba[:, :, :3] = rgba[:, :, :3][tuple(nearest)]
        atlas.paste(Image.fromarray(rgba), (size * (index % columns), size * (index // columns)))
    atlas.format = 'PNG'
    return atlas


def photographed_sprays(points, canopy, folder, name):
    cloud = points[canopy]
    rng = np.random.default_rng(2089)
    basis, _ = np.linalg.qr(np.array([[.77, .39, -.42], [-.31, .91, .22], [.56, .11, .88]]))
    keys = np.floor(cloud @ basis / .113).astype(int)
    _, ids, counts = np.unique(keys, axis=0, return_inverse=True, return_counts=True)
    groups = np.split(np.argsort(ids), np.cumsum(counts)[:-1])
    verts, normals, uv, tris = [], [], [], []
    for sample in groups:
        if len(sample) < 70:
            continue
        pts = cloud[sample]
        centre = pts.mean(0)
        local = pts - centre
        _, axes = np.linalg.eigh(local.T @ local)
        spread = np.ptp(local @ axes, axis=0)
        # Different spray angles and depths keep adjacent branches in parallax during a walk.
        count = 4 if len(sample) > 400 else 2
        for j in range(count):
            stem = axes[:, 2] * (1 if j % 2 else -1)
            roll = np.pi * (j + rng.uniform(-.24, .24)) / count
            side = axes[:, 1] * np.cos(roll) + axes[:, 0] * np.sin(roll)
            pivot = centre + .42 * local[rng.integers(len(pts))]
            forward = stem * max(.034, spread[2]) * .65
            across = side * max(.026, spread[1]) * .69
            corners = np.array([pivot - forward - across, pivot + forward - across,
                                pivot + forward + across, pivot - forward + across])
            base = len(verts)
            verts.extend(corners)
            radial = corners - [.5, .38, .5]
            radial[:, 1] = np.maximum(.24, radial[:, 1]) + .07
            normals.extend(radial / np.linalg.norm(radial, axis=1)[:, None])
            patch = rng.integers(16)
            uv.extend([[(patch % 4 + u) / 4, 1 - (patch // 4 + v) / 4]
                       for u, v in [(.008, .992), (.992, .992), (.992, .008), (.008, .008)]])
            # Both sides share the outward canopy normal so leaf cards do not invert
            # from sunlit to black as their back faces rotate into view.
            for tri in [(base, base + 1, base + 2), (base, base + 2, base + 3)]:
                tris.extend([tri, tri[::-1]])
    return tuple(map(np.asarray, (verts, uv, normals, tris))), spray_atlas(folder, name)
