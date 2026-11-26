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
CLOUD_FRACTION = .30
CLOUD_CONTRAST = .50


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


def angular_blur(field, sigma_cells, axis):
    radius = int(np.ceil(3 * sigma_cells))
    offsets = np.arange(-radius, radius + 1)
    weights = np.exp(-.5 * (offsets / sigma_cells)**2)
    weights /= weights.sum()
    if axis == 1:
        return sum(w * np.roll(field, shift, axis=1) for shift, w in zip(offsets, weights))
    padded = np.pad(field, ((radius, radius), (0, 0), (0, 0)), mode="edge")
    return sum(w * padded[start:start + len(field)] for start, w in enumerate(weights))


def resize_panorama(field, width, height):
    # Pad the longitude seam so both ends interpolate between the same cells.
    border = width // field.shape[1]
    wrapped = np.concatenate((field[:, -1:], field, field[:, :1]), axis=1)
    channels = []
    for channel in wrapped.transpose(2, 0, 1):
        image = Image.fromarray(channel.astype(np.float32))
        enlarged = image.resize((width + 2 * border, height), Image.Resampling.BILINEAR)
        channels.append(np.asarray(enlarged)[:, border:border + width])
    return np.stack(channels, axis=2)


def add_cloud_structure(mixed, cloud, latitude):
    height, width = mixed.shape[:2]
    # Exclude the source landscape from the horizon filter.
    upper = latitude > np.radians(1)
    cloud[~upper] = cloud[np.flatnonzero(upper)[-1]]
    log_cloud = np.log(np.maximum(.0002, cloud))
    small = log_cloud.reshape(128, height // 128, 256, width // 256, 3).mean((1, 3))
    latitude_blur = angular_blur(small, 8 * 128 / 180, axis=0)
    broad = angular_blur(latitude_blur, 8 * 256 / 360, axis=1)
    local_contrast = log_cloud - resize_panorama(broad, width, height)
    fade = np.clip((np.degrees(latitude) - .7) / 3, 0, 1)
    fade = (fade**2 * (3 - 2 * fade))[:, None, None]
    layered = mixed * np.exp(CLOUD_CONTRAST * fade * np.clip(local_contrast, -1.9, 1.9))

    # Match the original low-frequency diffuse illumination in each colour
    # channel while permitting clouds to change reflected radiance locally.
    rows, columns = 64, 128
    def upper_average(image):
        return image.reshape(rows, height // rows, columns, width // columns, 3).mean((1, 3))[:rows // 2]

    original = upper_average(mixed)
    candidate = upper_average(layered)
    el = (.5 - (np.arange(rows // 2) + .5) / rows) * np.pi
    az = ((np.arange(columns) + .5) / columns - .5) * 2 * np.pi
    y, x, z = np.broadcast_arrays(np.sin(el)[:, None], np.cos(el)[:, None] * np.cos(az),
                                  np.cos(el)[:, None] * np.sin(az))
    harmonics = np.stack([np.ones_like(x), x, y, z, x*y, x*z, y*z, x*x-y*y, 3*z*z-1], axis=-1)
    basis = harmonics.reshape(-1, 9)
    area = np.broadcast_to(np.cos(el)[:, None], x.shape).ravel()
    gain = np.empty_like(candidate)
    for channel in range(3):
        target = basis.T @ (original[:, :, channel].ravel() * area)
        values = candidate[:, :, channel].ravel() * area
        coeff = np.zeros(9)
        for _ in range(5):
            weighted = values * np.exp(basis @ coeff)
            coeff += np.linalg.solve(basis.T @ (weighted[:, None] * basis), target - basis.T @ weighted)
        gain[:, :, channel] = np.exp(harmonics @ coeff)
    gain = np.concatenate((gain, np.repeat(gain[-1:], rows // 2, axis=0)))
    return layered * resize_panorama(gain, width, height)


def bake(morning_path, cloud_path, output, detail_path=None):
    sky = json.loads(PREVIOUS.read_text())
    day = sky["daylight"]
    morning_digest = hashlib.md5(morning_path.read_bytes()).hexdigest()
    if morning_digest == "e403ba6805b2e6b7da51a13a4aaab898":
        # Solar centroid and direct-light chromaticity from the 4K mid-morning HDR.
        day.update(azimuth=36.051, elevation=40.1473, directFraction=0.62, sunColor=[1.06352, 0.99158, 0.8964])
        sky["yaw"] = round(day["azimuth"] - 71.5454 - 88, 4)  # 88 degrees from geographic north
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

    if detail_path is not None:
        # The 4K Kloofendal 38d capture supplies cloud structure at about the
        # same solar elevation. Register its measured solar centroid in yaw.
        detail_azimuth = 35.9417
        detail, _, _ = read_sky(detail_path, detail_azimuth, 37.9541, lat, lon)
        shift = round((day["azimuth"] - detail_azimuth) * w / 360)
        mixed = add_cloud_structure(mixed, np.roll(detail, shift, axis=1), lat)
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
    parser.add_argument("--cloud-detail", type=Path, help="Kloofendal 38d Partly Cloudy (Pure Sky), 4K HDR")
    args = parser.parse_args()
    bake(args.morning, args.clouds, args.output, args.cloud_detail)
