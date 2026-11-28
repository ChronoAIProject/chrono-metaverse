"""Reduce directional lighting baked into surveyed waterfront colour atlases."""
import argparse
import hashlib
import json
import struct
from pathlib import Path

import numpy as np

from facade_atlas import accessor, balance, replace_atlas

ROOT = Path(__file__).resolve().parents[1]


def wall_regions(document, binary, record):
    basis = np.asarray(record["normalToWorld"])
    regions = {}
    for mesh in document["meshes"]:
        for primitive in mesh["primitives"]:
            if "material" not in primitive:
                continue
            material = document["materials"][primitive["material"]]
            binding = material["pbrMetallicRoughness"].get("baseColorTexture")
            if not binding:
                continue
            image = document["textures"][binding["index"]]["source"]
            indices = accessor(document, binary, primitive["indices"]).reshape(-1, 3)
            attributes = primitive["attributes"]
            uv = accessor(document, binary, attributes["TEXCOORD_0"])[indices]
            if binding.get("extensions") or binding.get("texCoord", 0):
                raise ValueError("Survey expects the source atlas UVs")
            normals = accessor(document, binary, attributes["NORMAL"])[indices].mean(axis=1) @ basis
            normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-9)
            angles = (np.arctan2(normals[:, 2], normals[:, 0]) + np.pi) * 8 / np.pi
            bins = np.floor(angles + .5).astype(int) % 16
            gains = np.array([record["gains"].get(str(i), 0) for i in bins])
            gains[np.abs(normals[:, 1]) >= .35] = 0
            if material["name"] != record["material"]:
                gains[:] = 0
            regions.setdefault(image, []).extend(zip(uv, gains, strict=True))
    return regions


def bake(source, output, record):
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != record["source"]:
        raise ValueError(f"Unexpected source atlas for {record['label']}")
    header = struct.unpack_from("<I", raw, 12)[0]
    document = json.loads(raw[20:20 + header])
    for index, regions in wall_regions(document, raw[28 + header:], record).items():
        if any(stops for _, stops in regions):
            raw = replace_atlas(raw, lambda image: balance(image, regions), image_index=index,
                                keep_encoding=True)
    digest = hashlib.sha256(raw).hexdigest()
    (output / (digest + ".glb")).write_bytes(raw)
    return digest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, default=ROOT / "assets")
    parser.add_argument("--output", type=Path, default=ROOT / "assets")
    args = parser.parse_args()
    args.output.mkdir(exist_ok=True, parents=True)
    survey = json.loads((ROOT / "references/waterfront-facade-daylight.json").read_text())
    for building in survey["buildings"]:
        print(building["entityId"], bake(args.sources / (building["source"] + ".glb"), args.output, building))
