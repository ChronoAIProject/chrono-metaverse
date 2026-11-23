"""Expose the CC0 4K Kloofendal clear sky to the Marina Bay daylight camera."""
import argparse
import hashlib
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

# pi * diffuseResponse(UP) in web/src/viewer/lighting.ts.
HORIZONTAL_IRRADIANCE = 3.6328619397285666
EXPOSURE = 1.05
SOURCE_MD5 = "4e0af6bcab0e373639f3b48b6677a2c1"


def display_rgb(radiance):
    # Three.js ACESFilmicToneMapping with row vectors acting on linear RGB.
    aces_input = np.array([[.59719, .07600, .02840],
                           [.35458, .90834, .13383],
                           [.04823, .01566, .83777]])
    aces_output = np.array([[1.60475, -.10208, -.00327],
                            [-.53108, 1.10813, -.07276],
                            [-.07367, -.00605, 1.07602]])
    value = (radiance * (EXPOSURE / .6)) @ aces_input
    fit = (value * (value + .0245786) - .000090537) / (value * (.983729 * value + .432951) + .238081)
    linear = (fit @ aces_output).clip(0, 1)
    srgb = np.where(linear <= .0031308, 12.92 * linear, 1.055 * linear ** (1 / 2.4) - .055)
    return np.rint(255 * srgb).astype(np.uint8)


def reflected_sky(rgb, scale, output):
    # Average scene-linear radiance over each output texel. The water shader
    # supplies direct sunlight, so fill the solar disk from its adjacent sky.
    height, width = rgb.shape[:2]
    y, x = np.unravel_index(np.argmax(rgb[:height//2, :, 1]), (height//2, width))
    azimuth = ((np.arange(width) + .5) / width - .5) * 2 * np.pi
    elevation = (.5 - (np.arange(height) + .5) / height) * np.pi
    cosine = (np.sin(elevation)[:, None] * np.sin(elevation[y]) +
              np.cos(elevation)[:, None] * np.cos(elevation[y]) * np.cos(azimuth - azimuth[x]))
    disk = cosine > np.cos(np.deg2rad(.75))
    ring = (cosine > np.cos(np.deg2rad(2))) & ~disk
    rgb[disk] = np.median(rgb[ring], axis=0)
    average = rgb.reshape(256, height//256, 512, width//512, 3).mean(axis=(1, 3), dtype=float)
    linear = np.clip(average * scale / 32, 0, 1)
    srgb = np.where(linear <= .0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - .055)
    Image.fromarray(np.rint(255 * srgb).astype(np.uint8)).save(output, format="PNG")


def bake(source, output, reflection=None):
    if hashlib.md5(source.read_bytes()).hexdigest() != SOURCE_MD5:
        raise ValueError("Expected the 4K Kloofendal 43d Clear (Pure Sky) Radiance HDR")
    width, height = 4096, 2048
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(source), "-frames:v", "1",
                                   "-f", "rawvideo", "-pix_fmt", "gbrpf32le", "pipe:1"])
    rgb = np.frombuffer(raw, dtype="<f4").reshape(3, height, width)[[2, 0, 1]].transpose(1, 2, 0)
    elevation = (.5 - (np.arange(height // 2) + .5) / height) * np.pi
    row_luminance = rgb[:height // 2].mean(axis=1, dtype=float) @ [.2126, .7152, .0722]
    measured = (row_luminance @ (np.cos(elevation) * np.sin(elevation))) * 2 * np.pi**2 / height
    pixels = np.empty((height, width, 3), np.uint8)
    for y in range(0, height, 64):
        pixels[y:y+64] = display_rgb(rgb[y:y+64].astype(float) * (HORIZONTAL_IRRADIANCE / measured))
    Image.fromarray(pixels).save(output, format="JPEG", quality=90, subsampling=0)
    if reflection:
        reflected_sky(rgb, HORIZONTAL_IRRADIANCE / measured, reflection)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--reflection", type=Path, help="Optional 512px sun-free sky for reflections")
    args = parser.parse_args()
    bake(args.source, args.output, args.reflection)
