"""Bake the surveyed pane and frame contrast into a core glTF roughness texture."""
import hashlib
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.ndimage import gaussian_filter

from coastal_finishes import Model

ROOT = Path(__file__).resolve().parents[1]
GLASS_ROUGHNESS = .16
FRAME_ROUGHNESS = .52


def used_uvs(model, material_index, size):
    mask = Image.new("L", size)
    draw = ImageDraw.Draw(mask)
    for mesh in model.doc["meshes"]:
        for primitive in mesh["primitives"]:
            if primitive.get("material") != material_index:
                continue
            uv = model.read(primitive["attributes"]["TEXCOORD_0"], 2)
            coords = np.rint(uv * size - .5).astype(int)
            faces = model.read(primitive["indices"], 1).reshape(-1, 3)
            for face in coords[faces]:
                draw.polygon(face.ravel().tolist(), fill=255)
    return np.asarray(mask.filter(ImageFilter.MaxFilter(5))) != 0


def surface_mask(model, texture, material_index):
    image = model.doc["images"][texture["source"]]
    view = model.doc["bufferViews"][image["bufferView"]]
    start = view.get("byteOffset", 0)
    with Image.open(io.BytesIO(model.data[start:start + view["byteLength"]])) as source:
        rgb = np.asarray(source.convert("RGB"), np.float32) / 255
    linear = np.where(rgb < .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    luma = linear @ np.array([.2126, .7152, .0722], dtype=np.float32)
    local_mean = gaussian_filter(luma, 4)
    # Broad baked lighting should not modulate a second copy of the reflected sky.
    ratio = (luma + .015) / (local_mean + .015)
    # The dark glazing and brighter frame bands use the same surveyed UVs.
    # Keep the original response over locally featureless sections of the image.
    roughness = np.clip(.28 + .30 * np.log2(ratio), GLASS_ROUGHNESS, FRAME_ROUGHNESS)
    full = Image.fromarray(roughness.astype(np.float32))
    half = full.resize((full.width // 2, full.height // 2), Image.Resampling.BOX)
    mapped = np.where(used_uvs(model, material_index, half.size), np.asarray(half), .28)
    normalized = (mapped - GLASS_ROUGHNESS) / (FRAME_ROUGHNESS - GLASS_ROUGHNESS)
    levels = np.rint(normalized * 31).astype(np.uint8)
    image = Image.frombytes("P", half.size, levels.tobytes())
    palette = []
    for roughness in np.linspace(GLASS_ROUGHNESS, FRAME_ROUGHNESS, 32):
        palette.extend((255, round(roughness * 255), 0))
    image.putpalette(bytes(palette))
    encoded = io.BytesIO()
    image.save(encoded, "PNG", optimize=True)
    return encoded.getvalue()


def bake(raw, material_name):
    model = Model(raw)
    doc = model.doc
    material, = [m for m in doc["materials"] if m["name"] == material_name]
    base = material["pbrMetallicRoughness"]["baseColorTexture"]
    texture = doc["textures"][base["index"]]
    mask = surface_mask(model, texture, doc["materials"].index(material))
    image_index = len(doc["images"])
    doc["images"].append({"mimeType": "image/png", "bufferView": model.append_view(mask)})
    surface = {**base, "index": len(doc["textures"])}
    doc["textures"].append({**texture, "source": image_index})
    pbr = material["pbrMetallicRoughness"]
    pbr["roughnessFactor"] = 1
    pbr["metallicRoughnessTexture"] = surface
    return model.finish()


if __name__ == "__main__":
    survey = json.loads((ROOT / "references/financial-window-reflection.json").read_text())
    for row in survey["models"]:
        source = ROOT / "assets" / (row["source"] + ".glb")
        data = source.read_bytes()
        if hashlib.sha256(data).hexdigest() != row["source"]:
            raise ValueError(f"Source hash mismatch for {row['id']}")
        result = bake(data, row["material"])
        digest = hashlib.sha256(result).hexdigest()
        if row.get("output", digest) != digest:
            raise ValueError(f"Unexpected rebuilt hash for {row['id']}")
        (ROOT / "assets" / (digest + ".glb")).write_bytes(result)
        print(row["id"], digest)
