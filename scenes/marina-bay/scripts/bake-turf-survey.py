"""Bake Marina South turf colour or park vegetation coverage from Sentinel-2 L2A imagery."""
import argparse
import json
import warnings
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import reproject, Resampling
from rasterio.windows import from_bounds
from scipy.ndimage import distance_transform_edt
from shapely import transform
from shapely.geometry import shape

SOURCE = Path(__file__).resolve().parents[1] / "references/marina-south-turf"
BOUNDS = (372240, 140200, 375980, 142740)  # EPSG:32648
SIZE = (254, 374)
TRAINING = ("S2C_48NUG_20260613_0_L2A", "S2B_48NUG_20260817_0_L2A",
            "S2C_48NUG_20260822_0_L2A", "S2C_48NUG_20261001_0_L2A")


def read_bands(item, cache):
    cached = cache / (item + ".npz")
    if cached.exists():
        with np.load(cached) as data:
            return dict(data)
    date = item.split("_")[2]
    base = ("https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/"
            f"48/N/UG/{date[:4]}/{int(date[4:6])}/{item}/")
    bands = {}
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        for name, band in zip(("red", "green", "blue", "nir", "scl"), ("B04", "B03", "B02", "B08", "SCL")):
            with rasterio.open(base + band + ".tif") as image:
                if image.crs.to_epsg() != 32648:
                    raise ValueError(f"Unexpected CRS in {item}/{band}")
                raw = image.read(1, window=from_bounds(*BOUNDS, image.transform), out_shape=SIZE)
            # These Earth Search COGs already have the BOA offset applied.
            bands[name] = raw if name == "scl" else np.where(raw > 0, raw.astype(np.float32) * 0.0001, np.nan)
    cache.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cached, **bands)
    return bands


def bake(cache, output):
    features = json.loads((SOURCE / "parcels.geojson").read_text())["features"]
    project = Transformer.from_crs(4326, 32648, always_xy=True).transform
    parcels = [transform(shape(feature["geometry"]), project, interleaved=False) for feature in features]

    def mask(inset):
        polygons = [parcel.buffer(-inset) for parcel in parcels] if inset else parcels
        shapes = [(poly, i) for i, poly in enumerate(polygons, start=1) if not poly.is_empty]
        return rasterize(shapes, out_shape=SIZE, transform=from_origin(BOUNDS[0], BOUNDS[3], 10, 10))

    target, interior = mask(0), mask(10)
    observations = []
    for item in TRAINING:
        bands = read_bands(item, cache)
        rgb = np.stack([bands[channel] for channel in ("red", "green", "blue")], axis=-1)
        clear = np.isin(bands["scl"], [4, 5]) & np.isfinite(rgb).all(axis=-1) & (interior > 0)
        ndvi = (bands["nir"] - bands["red"]) / np.maximum(0.0002, bands["nir"] + bands["red"])
        healthy = clear & (ndvi > 0.6)
        if healthy.sum() < 100:
            raise ValueError(f"Insufficient reference grass in {item}")
        observations.append(np.where(clear[:, :, None], rgb / np.median(rgb[healthy], axis=0), np.nan))

    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", "All-NaN slice encountered", RuntimeWarning)
        median = np.nanmedian(observations, axis=0)
    repeat = np.isfinite(np.asarray(observations)[:, :, :, 1]).sum(axis=0) >= 2
    image = np.full((*SIZE, 3), 128, dtype=np.uint8)
    accepted = 0
    for number in range(1, len(parcels) + 1):
        core = interior == number
        reliable = core & repeat
        if reliable.sum() < max(8, 0.6 * core.sum()):
            continue
        nearest = distance_transform_edt(~reliable, return_distances=False, return_indices=True)
        covered = target == number
        ratio = median[nearest[0][covered], nearest[1][covered]].clip(0.4, 2.5)
        image[covered] = np.rint(128 * ratio ** 0.6).astype(np.uint8)
        accepted += 1
    Image.fromarray(image).save(output)
    print(f"{accepted} surveyed parcels, {output.stat().st_size} bytes")


def bake_vegetation(cache, output):
    feature = json.loads((SOURCE / "park-boundary.geojson").read_text())
    project = Transformer.from_crs(4326, 3857, always_xy=True).transform
    boundary = transform(shape(feature["geometry"]), project, interleaved=False)
    pixel_size = 4
    lower = (np.floor(np.array(boundary.bounds[:2]) / pixel_size) - 2) * pixel_size
    upper = (np.ceil(np.array(boundary.bounds[2:]) / pixel_size) + 2) * pixel_size
    width, height = ((upper - lower) / pixel_size).astype(int)
    target = from_origin(lower[0], upper[1], pixel_size, pixel_size)
    interior = rasterize([(boundary, 1)], out_shape=(height, width), transform=target)

    observations = []
    for item in (*TRAINING, "S2C_48NUG_20261031_0_L2A", "S2A_48NUG_20261122_0_L2A"):
        bands = read_bands(item, cache)
        red, nir = bands["red"], bands["nir"]
        ndvi = (nir - red) / np.maximum(nir + red, 0.0002)
        observations.append(np.where(np.isin(bands["scl"], [4, 5]), ndvi, np.nan))
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", "All-NaN slice encountered", RuntimeWarning)
        median = np.nanmedian(observations, axis=0)
    support = np.isfinite(observations).sum(axis=0) >= 3
    weight = support * np.clip((np.nan_to_num(median) - 0.42) / 0.24, 0, 1)
    mask = np.zeros(interior.shape, dtype=np.float32)
    reproject(weight.astype(np.float32), mask,
              src_crs="EPSG:32648", src_transform=from_origin(BOUNDS[0], BOUNDS[3], 10, 10),
              dst_crs="EPSG:3857", dst_transform=target, resampling=Resampling.bilinear)
    mask *= np.minimum(1, distance_transform_edt(interior) / 2)
    Image.fromarray(np.rint(mask.clip(0, 1) * 255).astype(np.uint8)).save(output)
    world = 2 * np.pi * 6378137
    rect = [0.5 + lower[0] / world, 0.5 - upper[1] / world,
            0.5 + upper[0] / world, 0.5 - lower[1] / world]
    print("North-up normalized Web Mercator bounds", json.dumps(rect))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path, help="Local cache for the cropped spectral bands")
    parser.add_argument("output", type=Path)
    parser.add_argument("--park-vegetation", action="store_true",
                        help="Bake the park vegetation exposure mask instead of turf colour gains")
    args = parser.parse_args()
    if args.park_vegetation:
        bake_vegetation(args.cache, args.output)
    else:
        bake(args.cache, args.output)
