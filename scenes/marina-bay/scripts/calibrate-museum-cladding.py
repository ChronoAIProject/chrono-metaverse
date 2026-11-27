"""Calibrate the measured ArtScience Museum shell against five daylight bay views."""

import argparse
import hashlib
import io
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "99b818c3f55392a7a582e268b2c5dfd171e2adf8309b85160594e6a9928a4c97"
MATERIAL = "ArtScience Museum fibre-reinforced cladding"


def accessor(doc, binary, index):
    a = doc["accessors"][index]
    view = doc["bufferViews"][a["bufferView"]]
    dtype = np.dtype({5126: "<f4", 5125: "<u4", 5123: "<u2", 5121: "u1"}[a["componentType"]])
    width = {"VEC2": 2, "SCALAR": 1}[a["type"]]
    offset = view.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = view.get("byteStride", width * dtype.itemsize)
    return np.ndarray((a["count"], width), dtype, binary, offset=offset,
                      strides=(stride, dtype.itemsize))


def linear_srgb(srgb):
    return np.where(srgb < .04045, srgb / 12.92, ((srgb + .055) / 1.055) ** 2.4)


def shell_texture(doc, binary, material_index, source_image):
    atlas = np.asarray(source_image.convert("RGB"), dtype="float32") / 255
    size = source_image.size
    coverage = Image.new("L", size)
    draw = ImageDraw.Draw(coverage)
    for mesh in doc["meshes"]:
        for primitive in mesh["primitives"]:
            if primitive.get("material") != material_index:
                continue
            uv = accessor(doc, binary, primitive["attributes"]["TEXCOORD_0"])
            indices = accessor(doc, binary, primitive["indices"]).reshape(-1, 3)
            for triangle in uv[indices]:
                draw.polygon([tuple(point * size) for point in triangle], fill=255)

    used = np.asarray(coverage) > 0
    # The atlas contains several real-world materials. Only the petal UVs
    # establish the median for this off-white shell. The target is an estimate
    # from the least underexposed of the five registered daylight views.
    median = np.median(atlas[used] * 255, axis=0).astype(float) / 255
    reflectance = np.clip(linear_srgb(atlas) * [.80, .80, .78] / linear_srgb(median), 0, 1)
    encoded = np.where(reflectance < .0031308, 12.92 * reflectance,
                       1.055 * reflectance ** (1 / 2.4) - .055)
    distance, nearest = distance_transform_edt(~used, return_indices=True)
    surface = np.empty_like(encoded)
    surface[:] = np.median(encoded[used], axis=0)
    # Dilate over the old glazing at UV island edges before downsampling.
    nearby = distance < 12
    surface[nearby] = encoded[nearest[0][nearby], nearest[1][nearby]]
    image = Image.fromarray(np.uint8(np.rint(surface * 255))).resize(
        (512, 512), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=91, subsampling=0)
    return buffer.getvalue()


def bake(source):
    if hashlib.sha256(source).hexdigest() != SOURCE:
        raise ValueError("Expected the curved museum with its baked directional fill")
    header_size = struct.unpack_from("<I", source, 12)[0]
    doc = json.loads(source[20:20 + header_size])
    start = 28 + header_size
    binary = bytearray(source[start:start + doc["buffers"][0]["byteLength"]])
    index = next(i for i, m in enumerate(doc["materials"]) if m.get("name") == MATERIAL)
    pbr = doc["materials"][index]["pbrMetallicRoughness"]
    reference = pbr["baseColorTexture"]
    texture = doc["textures"][reference["index"]]
    view = doc["bufferViews"][doc["images"][texture["source"]]["bufferView"]]
    offset = view.get("byteOffset", 0)
    with Image.open(io.BytesIO(binary[offset:offset + view["byteLength"]])) as image:
        jpeg = shell_texture(doc, binary, index, image)

    binary.extend(bytes(-len(binary) % 4))
    image_view = len(doc["bufferViews"])
    doc["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(jpeg)})
    binary.extend(jpeg)
    doc["images"].append({"bufferView": image_view, "mimeType": "image/jpeg",
                          "name": "Daylight shell cladding"})
    doc["textures"].append({**texture, "source": len(doc["images"]) - 1})
    pbr["baseColorTexture"] = {**reference, "index": len(doc["textures"]) - 1}
    pbr["baseColorFactor"] = [1, 1, 1, 1]
    doc["buffers"][0]["byteLength"] = len(binary)
    binary.extend(bytes(-len(binary) % 4))
    header = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    return (struct.pack("<4sIII4s", b"glTF", 2, 28 + len(header) + len(binary), len(header), b"JSON")
            + header + struct.pack("<I4s", len(binary), b"BIN\0") + binary)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, default=ROOT / "assets")
    assets = parser.parse_args().assets
    result = bake((assets / (SOURCE + ".glb")).read_bytes())
    digest = hashlib.sha256(result).hexdigest()
    (assets / (digest + ".glb")).write_bytes(result)
    print(digest)
