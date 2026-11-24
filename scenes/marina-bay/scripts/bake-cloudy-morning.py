"""Bake the bay's scattered morning clouds, diffuse probe and water reflection."""
import argparse
import hashlib
from importlib import import_module
import json
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image

exposure = import_module("bake-clear-sky")
LUMA = np.array([.2126, .7152, .0722])
PREVIOUS = Path(__file__).resolve().parents[1] / "references/qwantani-balanced-sky.json"
CLOUD_FRACTION = .35


def read_sky(path, azimuth, elevation, latitude, longitude):
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-frames:v", "1",
                                   "-f", "rawvideo", "-pix_fmt", "gbrpf32le", "pipe:1"])
    sky = np.frombuffer(raw, "<f4").reshape(3, 2048, 4096)[[2, 0, 1]].transpose(1, 2, 0).copy()
    azimuth, elevation = np.radians([azimuth, elevation])
    cosine = (np.sin(latitude)[:, None] * np.sin(elevation)
              + np.cos(latitude)[:, None] * np.cos(elevation) * np.cos(longitude - azimuth))
    disk = cosine > np.cos(np.radians(.75))
    ring = (cosine > np.cos(np.radians(2))) & ~disk
    fill = np.median(sky[ring], axis=0)
    sunlight = sky[disk] - fill
    sky[disk] = fill
    return sky, disk, sunlight


def diffuse_probe(radiance):
    height, width = radiance.shape[:2]
    lat = (.5 - (np.arange(height) + .5) / height) * np.pi
    lon = ((np.arange(width) + .5) / width - .5) * 2 * np.pi
    y, x, z = np.broadcast_arrays(np.sin(lat)[:, None], np.cos(lat)[:, None] * np.cos(lon),
                                  np.cos(lat)[:, None] * np.sin(lon))
    area = np.broadcast_to(np.cos(lat)[:, None] * np.pi / height * (2 * np.pi / width), x.shape)
    # Match the measured ground bounce used in the existing diffuse sky probe.
    radiance[y < 0] = ((np.array([179, 173, 162]) / 255 + .055) / 1.055)**2.4 / np.pi
    basis = np.stack([np.full_like(x, .282095), .488603*y, .488603*z, .488603*x,
                      1.092548*x*y, 1.092548*y*z, .315392*(3*z*z-1),
                      1.092548*x*z, .546274*(x*x-y*y)], axis=-1)
    return np.einsum("hwn,hwc,hw->nc", basis, radiance, area).round(7).flatten().tolist()


def bake(morning_path, cloud_path, output):
    sky = json.loads(PREVIOUS.read_text())
    day = sky["daylight"]
    morning_digest = hashlib.md5(morning_path.read_bytes()).hexdigest()
    if morning_digest == "e403ba6805b2e6b7da51a13a4aaab898":
        # Solar centroid and direct-light chromaticity from the 4K mid-morning HDR.
        day.update(azimuth=36.051, elevation=40.1473, sunColor=[1.06352, 0.99158, 0.8964])
        sky["yaw"] = round(day["azimuth"] - 71.5454 - 65, 4)  # 65 degrees from geographic north
    elif morning_digest != "b065d32bfc96c2a87f0547bd06ba30f5":
        raise ValueError(f"Unexpected Qwantani 4K HDR source: {morning_path.name}")
    if hashlib.md5(cloud_path.read_bytes()).hexdigest() != "816340c969d2e60d659051d13ac3c4dc":
        raise ValueError(f"Unexpected Kloofendal 4K HDR source: {cloud_path.name}")
    h, w = 2048, 4096
    lat = (.5 - (np.arange(h) + .5) / h) * np.pi
    lon = ((np.arange(w) + .5) / w - .5) * 2 * np.pi
    weights = np.cos(lat) * np.maximum(np.sin(lat), 0) * (2 * np.pi**2 / h)

    def irradiance(image):
        return weights @ image.mean(axis=1, dtype=float)

    base, disk, direct = read_sky(morning_path, day["azimuth"], day["elevation"], lat, lon)
    cloud_azimuth = 34.2568
    cloud, _, _ = read_sky(cloud_path, cloud_azimuth, 47.8848, lat, lon)
    shift = (day["azimuth"] - cloud_azimuth) * w / 360
    offset = int(np.floor(shift))
    cloud = (np.roll(cloud, offset, axis=1) * (1 - shift + offset)
             + np.roll(cloud, offset + 1, axis=1) * (shift - offset))
    base /= irradiance(base) @ LUMA
    cloud /= irradiance(cloud) @ LUMA
    mixed = (1 - CLOUD_FRACTION) * base + CLOUD_FRACTION * cloud
    # Keep the original horizon and blend the extra diffuse light above it.
    fade = np.clip(np.degrees(lat) / 3, 0, 1)
    fade = (fade**2 * (3 - 2*fade))[:, None, None]
    mixed = base * (1 - fade) + mixed * fade
    mixed /= irradiance(mixed) @ LUMA

    total = exposure.HORIZONTAL_IRRADIANCE
    diffuse = mixed * (total * (1 - day["directFraction"]))
    display = diffuse.copy()
    direct_energy = (direct * weights[np.where(disk)[0], None] / w).sum(0) @ LUMA
    display[disk] += direct * (total * day["directFraction"] / direct_energy)
    pixels = np.empty((h, w, 3), np.uint8)
    for y in range(0, h, 64):
        pixels[y:y+64] = exposure.display_rgb(display[y:y+64])

    output.mkdir(parents=True, exist_ok=True)
    panorama, reflection = output / "sky.jpeg", output / "radiance.png"
    Image.fromarray(pixels).save(panorama, quality=90, subsampling=0)
    average = diffuse.reshape(256, 8, 512, 8, 3).mean((1, 3), dtype=float)
    linear = average / sky["radiance"]["scale"]
    srgb = np.where(linear <= .0031308, 12.92*linear, 1.055*linear.clip(0)**(1/2.4)-.055)
    Image.fromarray(np.uint8(np.rint(255 * srgb.clip(0, 1)))).save(reflection)

    color = irradiance(mixed)
    day["skyColor"] = (color / (color @ LUMA)).round(5).tolist()
    day["diffuseProbe"] = diffuse_probe(average / (total * (1-day["directFraction"])))
    sky["texture"] = hashlib.sha256(panorama.read_bytes()).hexdigest()
    sky["radiance"]["texture"] = hashlib.sha256(reflection.read_bytes()).hexdigest()
    (output / "sky.json").write_text(json.dumps(sky, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("morning", type=Path, help="Qwantani Mid Morning or Morning (Pure Sky), 4K HDR")
    parser.add_argument("clouds", type=Path, help="Kloofendal 48d Partly Cloudy (Pure Sky), 4K HDR")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    bake(args.morning, args.clouds, args.output)
