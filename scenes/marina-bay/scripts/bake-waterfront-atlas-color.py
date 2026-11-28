"""Reduce the baked blue cast across the Sands waterfront in linear light."""
import argparse
import hashlib
from pathlib import Path

import numpy as np
from PIL import Image

from facade_atlas import replace_atlas

# Limit this calibration to the surveyed colour atlases used for the six cross-bay views.
SOURCE_MODELS = {
    "a58c31f771221a1f0e72b56bc358b76521dfe18e2c561852d94490c3f9e5e883": "MARINA BAY SANDS (MICE)",
    "034831095e90f6c45c0154f2f05e944bd442e500c657f96a130a823064fc7b76": "MARINA BAY SANDS (THEATRE)",
    "3c26a6fd4f04a5f1e5d66d40061396ea9bb0c7087690f7f3be8e6b63fb4b07b8": "THE SHOPPES AT MARINA BAY SANDS",
    "2120f0f7b40b26370bad7698cdfc37a3a986a3c19aeb3d33c7aca4d3163d3609": "MARINA BAY SANDS (CASINO)"
}


def smooth_step(values):
    t = np.clip(values, 0, 1)
    return t * t * (3 - 2 * t)


def balance_atlas(image):
    encoded = np.asarray(image.convert("RGB"), dtype=np.float32) / 255
    rgb = np.where(encoded < .04045, encoded / 12.92, ((encoded + .055) / 1.055)**2.4)
    red, _, blue = rgb.transpose(2, 0, 1)
    chroma = smooth_step((blue - red - .015) / .135)
    blue_ratio = smooth_step((blue / np.maximum(.005, red) - 1.03) / .52)
    weight = .85 * (chroma * blue_ratio)
    luminance = rgb @ np.array([.2126, .7152, .0722], dtype=np.float32)
    adjusted = rgb + weight[:, :, None] * (luminance[:, :, None] - rgb)
    encoded = np.where(adjusted <= .0031308, 12.92 * adjusted, 1.055 * adjusted**(1 / 2.4) - .055)
    return Image.fromarray(np.rint(255 * encoded).astype(np.uint8))


def bake(source, output):
    raw = source.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest not in SOURCE_MODELS:
        raise ValueError(f"Unknown source atlas: {source.name}")
    model = replace_atlas(raw, balance_atlas, keep_encoding=True)
    result = hashlib.sha256(model).hexdigest()
    output.mkdir(parents=True, exist_ok=True)
    (output / (result + ".glb")).write_bytes(model)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Source GLB from the existing waterfront scene")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(bake(args.source, args.output))
