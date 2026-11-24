"""Bake the bay's early-morning display panorama and sun-free reflection map."""
import argparse
import hashlib
from importlib import import_module
import json
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image

clear_sky = import_module("bake-clear-sky")
REFERENCE = Path(__file__).resolve().parents[1] / "references/qwantani-clear-sky.json"
SOURCE_MD5 = "b065d32bfc96c2a87f0547bd06ba30f5"
# Fit to the relative brightness of surveyed facades and sky in two bay photographs.
DIRECT_FRACTION = 0.55


def bake(source, output):
    if hashlib.md5(source.read_bytes()).hexdigest() != SOURCE_MD5:
        raise ValueError("Expected the Poly Haven Qwantani Morning (Pure Sky) 4K HDR capture")
    width, height = 4096, 2048
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(source), "-frames:v", "1",
                                   "-f", "rawvideo", "-pix_fmt", "gbrpf32le", "pipe:1"])
    rgb = np.frombuffer(raw, "<f4").reshape(3, height, width)[[2, 0, 1]].transpose(1, 2, 0)
    sky = json.loads(REFERENCE.read_text())
    day = sky["daylight"]
    azimuth, elevation = np.radians([day["azimuth"], day["elevation"]])
    lat = (.5 - (np.arange(height) + .5) / height) * np.pi
    lon = ((np.arange(width) + .5) / width - .5) * 2 * np.pi
    cosine = (np.sin(elevation) * np.sin(lat)[:, None]
              + np.cos(elevation) * np.cos(lat)[:, None] * np.cos(lon - azimuth))
    disk = cosine > np.cos(np.radians(.75))
    surrounding = np.median(rgb[(cosine > np.cos(np.radians(2))) & ~disk], axis=0)
    half = height // 2
    rows = rgb[:half].mean(axis=1, dtype=float) @ [.2126, .7152, .0722]
    irradiance = (rows @ (np.cos(lat[:half]) * np.sin(lat[:half]))) * 2 * np.pi**2 / height
    scale = clear_sky.HORIZONTAL_IRRADIANCE / irradiance

    # Redistribute horizontal illuminance. The probe stores the angular shape
    # of the diffuse sky and receives its new intensity in the viewer.
    captured = day["directFraction"]
    diffuse_gain = (1 - DIRECT_FRACTION) / (1 - captured)
    adjusted = rgb * diffuse_gain
    adjusted[disk] = surrounding * diffuse_gain + (rgb[disk] - surrounding) * (DIRECT_FRACTION / captured)
    display = np.empty_like(rgb, dtype=np.uint8)
    for row in range(0, height, 64):
        display[row:row+64] = clear_sky.display_rgb(adjusted[row:row+64] * scale)
    output.mkdir(parents=True, exist_ok=True)
    display_path = output / "sky.jpeg"
    Image.fromarray(display).save(display_path, quality=90, subsampling=0)

    # Direct specular is rendered separately on the water. Exclude the solar disk here.
    adjusted[disk] = surrounding * diffuse_gain
    linear = adjusted.reshape(256, 8, 512, 8, 3).mean(axis=(1, 3), dtype=float)
    linear *= scale / sky["radiance"]["scale"]
    encoded = np.where(linear <= .0031308, 12.92 * linear, 1.055 * linear.clip(0) ** (1 / 2.4) - .055)
    reflection_path = output / "radiance.png"
    Image.fromarray(np.uint8(np.rint(255 * encoded.clip(0, 1)))).save(reflection_path)
    day["directFraction"] = DIRECT_FRACTION
    sky["texture"] = hashlib.sha256(display_path.read_bytes()).hexdigest()
    sky["radiance"]["texture"] = hashlib.sha256(reflection_path.read_bytes()).hexdigest()
    (output / "sky.json").write_text(json.dumps(sky, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    bake(args.source, args.output)
