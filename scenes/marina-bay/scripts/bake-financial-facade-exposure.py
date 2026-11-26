"""Balance registered facade scans against the two surveyed cross-bay views."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import struct

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def expose_image(data, mime_type, stops):
    with Image.open(io.BytesIO(data)) as source:
        rgba = np.asarray(source.convert("RGBA")) / 255
    rgb = rgba[:, :, :3]
    linear = np.where(rgb < .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    luminance = linear @ [.2126, .7152, .0722]
    # Keep the brightest lettering and cladding within the original daylight range.
    weight = np.clip((.85 - luminance) / .55, 0, 1)
    weight = weight * weight * (3 - 2 * weight)
    linear = np.clip(linear * 2 ** (stops * weight[:, :, None]), 0, 1)
    srgb = np.where(linear < .0031308, 12.92 * linear, 1.055 * linear ** (1 / 2.4) - .055)
    image = Image.fromarray(np.rint(255 * np.dstack([srgb, rgba[:, :, 3]])).astype("u1"))
    result = io.BytesIO()
    if mime_type == "image/jpeg":
        image.convert("RGB").save(result, "JPEG", quality=94, subsampling=0)
    else:
        image.save(result, "PNG", optimize=True)
    return result.getvalue()


def texture_bindings(properties):
    for key, value in properties.items():
        if isinstance(value, dict):
            if key.endswith("Texture") and "index" in value:
                yield value
            else:
                yield from texture_bindings(value)


def keep_referenced(table, bindings, key):
    indices = sorted({binding[key] for binding in bindings})
    remap = {original: current for current, original in enumerate(indices)}
    for binding in bindings:
        binding[key] = remap[binding[key]]
    return [table[i] for i in indices]


def bake(raw, record):
    if hashlib.sha256(raw).hexdigest() != record["source"]:
        raise ValueError(f"Source mismatch for {record['label']}")
    size = struct.unpack_from("<I", raw, 12)[0]
    doc = json.loads(raw[20:20 + size])
    binary = bytearray(raw[28 + size:])
    images = {}
    for material in doc["materials"]:
        if material.get("name") not in record["materials"]:
            continue
        binding = material["pbrMetallicRoughness"]["baseColorTexture"]
        original = doc["textures"][binding["index"]]
        index = original["source"]
        if index not in images:
            image = doc["images"][index]
            view = doc["bufferViews"][image["bufferView"]]
            offset = view.get("byteOffset", 0)
            pixels = expose_image(binary[offset:offset + view["byteLength"]], image["mimeType"], record["stops"])
            binary.extend(bytes(-len(binary) % 4))
            image_view = len(doc["bufferViews"])
            doc["bufferViews"].append(dict(buffer=0, byteOffset=len(binary), byteLength=len(pixels)))
            binary.extend(pixels)
            images[index] = len(doc["images"])
            doc["images"].append({**image, "bufferView": image_view})
        binding["index"] = len(doc["textures"])
        doc["textures"].append({**original, "source": images[index]})

    # A source image may also supply the roof, a different material or another map.
    # Repack only after all base-color bindings have been updated.
    bindings = [b for m in doc["materials"] for b in texture_bindings(m)]
    doc["textures"] = keep_referenced(doc["textures"], bindings, "index")
    doc["images"] = keep_referenced(doc["images"], doc["textures"], "source")
    references = [a for a in doc["accessors"] if "bufferView" in a] + doc["images"]
    if any(a.get("sparse") for a in doc["accessors"]) or set(doc.get("extensionsRequired", [])) - {
        "KHR_mesh_quantization", "KHR_texture_transform"
    }:
        raise ValueError("This survey expects ordinary or quantized, dense geometry")
    doc["bufferViews"] = keep_referenced(doc["bufferViews"], references, "bufferView")
    packed = bytearray()
    for view in doc["bufferViews"]:
        start = view.get("byteOffset", 0)
        packed.extend(bytes(-len(packed) % 4))
        view["byteOffset"] = len(packed)
        packed.extend(binary[start:start + view["byteLength"]])
    packed.extend(bytes(-len(packed) % 4))
    doc["buffers"][0]["byteLength"] = len(packed)
    header = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode()
    header += b" " * (-len(header) % 4)
    return (struct.pack("<4sIII4s", b"glTF", 2, 28 + len(header) + len(packed), len(header), b"JSON")
            + header + struct.pack("<I4s", len(packed), b"BIN\0") + packed)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, default=ROOT / "assets",
                        help="Model directory containing the original scans and generated outputs")
    assets = parser.parse_args().assets
    survey = json.loads((ROOT / "references/financial-facade-exposure.json").read_text())
    for record in survey["buildings"]:
        result = bake((assets / (record["source"] + ".glb")).read_bytes(), record)
        digest = hashlib.sha256(result).hexdigest()
        if digest != record["output"]:
            raise ValueError(f"Unexpected output for {record['label']}")
        (assets / (digest + ".glb")).write_bytes(result)
