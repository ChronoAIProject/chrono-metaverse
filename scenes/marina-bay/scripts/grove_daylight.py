"""Calibrate the painted crown steel and surveyed shafts against daylight views."""
import hashlib
import json
import struct
from pathlib import Path

import numpy as np

from facade_atlas import accessor, balance, glb_blocks, pack_glb, replace_atlas

ROOT = Path(__file__).resolve().parents[1]


def brighten_steel(doc, blocks, index):
    field = doc["accessors"][index]
    view = doc["bufferViews"][field["bufferView"]]
    if (field["type"], field["componentType"], field.get("normalized")) != ("VEC4", 5121, True):
        raise ValueError("Expected normalized linear RGBA8 steel colours")
    data = bytearray(blocks[field["bufferView"]])
    color = np.ndarray((field["count"], 4), np.uint8, data, offset=field.get("byteOffset", 0),
                       strides=(view.get("byteStride", 4), 1))
    color[:, :3] = np.minimum(255, color[:, :3].astype(np.uint16) * 2)
    field.update(min=color.min(axis=0).tolist(), max=color.max(axis=0).tolist())
    blocks[field["bufferView"]] = data


def calibrate(raw):
    doc, blocks = glb_blocks(raw)
    binary = raw[28 + struct.unpack_from("<I", raw, 12)[0]:]
    regions = []
    steel = set()
    for mesh in doc["meshes"]:
        for primitive in mesh["primitives"]:
            if "material" not in primitive:  # Surveyed ground caps have no atlas.
                continue
            material = doc["materials"][primitive["material"]]
            attrs = primitive["attributes"]
            if material["name"] == "Radial steelwork":
                steel.add(attrs["COLOR_0"])
                continue
            binding = material["pbrMetallicRoughness"]["baseColorTexture"]
            if doc["textures"][binding["index"]]["source"] != 0 or binding.get("texCoord", 0) or binding.get("extensions"):
                raise ValueError("Unexpected surveyed surface UV binding")
            triangles = accessor(doc, binary, primitive["indices"]).reshape(-1, 3)
            uv = accessor(doc, binary, attrs["TEXCOORD_0"])[triangles]
            normal_y = np.abs(accessor(doc, binary, attrs["NORMAL"])[:, 1])
            t = np.clip((normal_y - .30) / .35, 0, 1)
            wall = 1 - t * t * (3 - 2 * t)
            # A small set of exposure bands bounds the atlas masks and preserves shared texels.
            stops = np.round(8 * wall[triangles].mean(axis=1)) / 8
            regions.extend(zip(uv, stops, strict=True))
    if not steel or not regions:
        raise ValueError("Missing steel or surveyed surface")
    for index in steel:
        brighten_steel(doc, blocks, index)
    return replace_atlas(pack_glb(doc, blocks), lambda image: balance(image, regions), keep_encoding=True)


if __name__ == "__main__":
    models = json.loads((ROOT / "references/supertree-grove.json").read_text())["models"]
    for model in models:
        revision = model["daylight"]
        raw = (ROOT / "assets" / (revision["source"] + ".glb")).read_bytes()
        if hashlib.sha256(raw).hexdigest() != revision["source"]:
            raise ValueError(f"Unexpected open crown source for {model['entityId']}")
        data = calibrate(raw)
        digest = hashlib.sha256(data).hexdigest()
        if digest != revision["output"]:
            raise ValueError(f"Unexpected daylight output for {model['entityId']}")
        (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
