"""Rebalance the cool survey atlases on the two stepped roofs along Bayfront."""

import argparse
import hashlib
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt, gaussian_filter

from facade_atlas import replace_atlas

ROOT = Path(__file__).resolve().parents[1]
# Roof height, followed by (exposure EV, excess blue/red EV) for high walls and
# slopes. Six registered daytime bay views constrain the fit. The lower quarter
# of the estimates keeps the correction conservative across different weather.
ROOFS = {
    "1c06ade585328910e05a8b47febc9660b4b3a4adb9f4c5f333db984a513fd33e":
        (56.45, ((.840, 1.337), (.020, .440))),
    "1967cab9cd7b956ad16ac9f7eec1008277d894a5dc6479946e384692c1a7f61b":
        (41.31, ((.888, .615), (0., .873))),
}


def accessor(doc, binary, index):
    field = doc["accessors"][index]
    view = doc["bufferViews"][field["bufferView"]]
    dtype = np.dtype({5126: "<f4", 5123: "<u2", 5125: "<u4"}[field["componentType"]])
    width = {"VEC2": 2, "VEC3": 3, "SCALAR": 1}[field["type"]]
    offset = view.get("byteOffset", 0) + field.get("byteOffset", 0)
    stride = view.get("byteStride", width * dtype.itemsize)
    return np.ndarray((field["count"], width), dtype, binary, offset=offset,
                      strides=(stride, dtype.itemsize))


def surface_masks(doc, binary, size, roof_height):
    images = [Image.new("L", size) for _ in range(3)]
    pens = [ImageDraw.Draw(mask) for mask in images]
    for mesh in doc["meshes"]:
        for part in mesh["primitives"]:
            attrs = part["attributes"]
            if "TEXCOORD_0" not in attrs:
                continue
            indices = accessor(doc, binary, part["indices"]).reshape(-1, 3)
            xyz = accessor(doc, binary, attrs["POSITION"])[indices]
            uv = accessor(doc, binary, attrs["TEXCOORD_0"])[indices] * size
            normal = np.cross(xyz[:, 1] - xyz[:, 0], xyz[:, 2] - xyz[:, 0])
            up = abs(normal[:, 1]) / np.maximum(np.linalg.norm(normal, axis=1), 1e-9)
            high = xyz.mean(1)[:, 1] > .45 * roof_height
            groups = np.where(high & (up > .55), 2, np.where(high & (up < .45), 1, 0))
            for triangle, group in zip(uv, groups, strict=True):
                pens[group].polygon([tuple(p) for p in triangle], fill=255)
    return np.stack([np.asarray(mask) > 0 for mask in images])


def calibrate(image, masks, settings):
    pix = np.asarray(image.convert("RGB"), dtype="float32") / 255
    linear = np.where(pix < .04045, pix / 12.92, ((pix + .055) / 1.055) ** 2.4)
    luma_weights = [.2126, .7152, .0722]
    luminance = linear @ luma_weights
    cool = np.clip((pix[:, :, 2] - pix[:, :, 0] + .025) / .13, 0, 1)
    lit = np.clip((luminance - .012) / .085, 0, 1)
    count = masks.sum(0)
    result = linear.copy()
    for group, (exposure, chroma) in enumerate(settings, 1):
        # Protect shared glazing and braces. Extend only into empty texels so
        # the UV edge has enough padding for bilinear filtering and mipmaps.
        exclusive = masks[group] & (count == 1)
        margin = distance_transform_edt(~exclusive) < 3
        region = gaussian_filter((exclusive | ((count == 0) & margin)).astype("f4"), .7)
        neutral = linear * [2 ** (chroma / 2), 1., 2 ** (-chroma / 2)]
        scale = luminance / np.maximum(neutral @ luma_weights, .00001) * 2 ** exposure
        neutral *= scale[:, :, None]
        result += (neutral - linear) * (region * lit * cool)[:, :, None]
    srgb = np.where(result < .0031308, 12.92 * result, 1.055 * np.maximum(result, 0) ** (1 / 2.4) - .055)
    return Image.fromarray(np.uint8(np.rint(np.clip(srgb, 0, 1) * 255)))


def bake(raw):
    height, settings = ROOFS[hashlib.sha256(raw).hexdigest()]
    length = struct.unpack_from("<I", raw, 12)[0]
    doc = json.loads(raw[20:20 + length])
    binary = raw[28 + length:]

    def edit(image):
        return calibrate(image, surface_masks(doc, binary, image.size, height), settings)

    return replace_atlas(raw, edit, jpeg_quality=93)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, default=ROOT / "assets")
    assets = parser.parse_args().assets
    for source in ROOFS:
        result = bake((assets / (source + ".glb")).read_bytes())
        digest = hashlib.sha256(result).hexdigest()
        (assets / (digest + ".glb")).write_bytes(result)
        print(source, digest)
