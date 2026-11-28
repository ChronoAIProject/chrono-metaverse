"""Bake Marina South's ten-metre linear turf gains from the four recorded Earth Search L2A COGs."""
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path, help="Local cache for the cropped spectral bands")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    bake(args.cache, args.output)
