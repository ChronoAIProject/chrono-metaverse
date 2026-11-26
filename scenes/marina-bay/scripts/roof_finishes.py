"""Expand a roof scan's physical repeat while retaining the original texture dimensions."""
import hashlib

import numpy as np
from PIL import Image
from slate_faces import photographed_slates


def concrete_samples(side, rng):
    y, x = np.indices((2 * side, 2 * side))
    lattice = np.stack((x, y), axis=-1) * [2 / side, 1.5 / side]
    cell = np.floor(lattice).astype(int)
    local = lattice - cell
    upper = local.sum(axis=2) > 1
    local = np.where(upper[:, :, None], 1 - local, local)
    weights = np.dstack((1 - local.sum(axis=2), local)) ** 3
    weights /= weights.sum(axis=2, keepdims=True)
    # Repeat the lattice on the atlas boundary. All PBR channels use these same translations.
    offsets = rng.integers(side, size=(3, 4, 2))
    samples = []
    for step in ([0, 0], [1, 0], [0, 1]):
        step = np.array(step)
        corner = cell + np.where(upper[:, :, None], 1 - step, step)
        shift = offsets[corner[:, :, 1] % 3, corner[:, :, 0] % 4]
        samples.append(((y + shift[:, :, 1]) % side, (x + shift[:, :, 0]) % side))
    return weights, samples


def metal_weathering(side, rng):
    y, x = np.indices((2 * side, 2 * side))
    u, v = (x + .5) / side, (y + .5) / side
    # The zinc scan spans 61 ribs. Group whole ribs into sheets, stagger their end joints.
    edges = np.rint(np.linspace(0, 122, 17))
    col = np.searchsorted(edges, (u * 61) % 122, side='right') - 1
    row = np.floor(v + rng.random(16)[col]).astype(int) % 2
    return rng.uniform(-.5, .5, (2, 16))[row, col]


def weather_roof(material, group, references):
    finish = material.name.removesuffix(' surveyed')
    if finish == 'SlateRoof':
        with Image.open(references / 'SlateRoof/Units.png') as atlas:
            units = np.asarray(atlas)
        # The plain and aerial-coloured versions share identical surface relief.
        shared_seed = int.from_bytes(hashlib.sha256((group + finish).encode()).digest()[:8], 'little')
        for key in ('baseColorTexture', 'metallicRoughnessTexture', 'normalTexture'):
            image = photographed_slates(getattr(material, key), units, shared_seed, key == 'normalTexture')
            setattr(material, key, image)
        return
    seed = int.from_bytes(hashlib.sha256((group + material.name).encode()).digest()[:8], 'little')
    layers = ['baseColorTexture', 'metallicRoughnessTexture']
    if finish == 'ConcreteRoof':
        layers.append('normalTexture')
    for key in layers:
        original = getattr(material, key)
        pixels = np.asarray(original.convert('RGB'))
        side = pixels.shape[0]
        rng = np.random.default_rng(seed)
        if finish == 'ConcreteRoof':
            weights, samples = concrete_samples(side, rng)
            result = sum(weights[:, :, i, None] * pixels[at] for i, at in enumerate(samples))
        else:
            amount = metal_weathering(side, rng)
            result = np.tile(pixels, (2, 2, 1)).astype(float)
            if key == 'baseColorTexture':
                result *= np.exp(amount[:, :, None] * [.22, .18, .14])
            else:
                result[:, :, 1] += 26 * amount

        expanded = Image.fromarray(np.rint(result).clip(0, 255).astype(np.uint8))
        image = expanded.resize(original.size, Image.Resampling.LANCZOS)
        if key == 'normalTexture':
            normals = np.asarray(image, float) / 127.5 - 1
            normals /= np.maximum(np.linalg.norm(normals, axis=2, keepdims=True), 1e-5)
            image = Image.fromarray(np.rint(127.5 * (1 + normals)).clip(0, 255).astype(np.uint8))
        image.format = 'JPEG'
        setattr(material, key, image)


def roof_texture_scales(material):
    pbr = material['pbrMetallicRoughness']
    maps = [pbr['baseColorTexture'], pbr['metallicRoughnessTexture']]
    finish = material['name'].removesuffix(' surveyed')
    if material['name'] == 'ConcreteRoof' or finish == 'SlateRoof':
        maps.append(material['normalTexture'])
    # Restore the pitch of each original photographed course in metres.
    scale = .25 if finish == 'SlateRoof' else .5
    for texture in maps:
        texture['extensions'] = {'KHR_texture_transform': {'scale': [scale, scale]}}
