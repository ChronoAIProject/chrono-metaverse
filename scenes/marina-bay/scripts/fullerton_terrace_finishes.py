"""Bind coated-sheet and painted-frame scans to the existing metric facade UVs."""

import json
from pathlib import Path
import struct

REFERENCES = Path(__file__).resolve().parents[1] / "references/terrace-finishes"
CREDIT = "Corrugated Iron 03 and Blue Metal Plate by Poly Haven (CC0); panel seams and paint are approximations."
FINISH = {"Pale roof trim": "enamel", "Grey aluminium": "enamel", "Coated roof panels": "sheet"}


def apply_canopy_finishes(data):
    size = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + size])
    binary = bytearray(data[28 + size:28 + size + doc["buffers"][0]["byteLength"]])
    textures = {}

    def image_info(kind, role):
        key = (kind, role)
        if key not in textures:
            image = (REFERENCES / f"{kind}-{role}.jpg").read_bytes()
            binary.extend(bytes(-len(binary) % 4))
            doc["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(image)})
            binary.extend(image)
            doc["images"].append({"bufferView": len(doc["bufferViews"]) - 1, "mimeType": "image/jpeg"})
            textures[key] = len(doc["textures"])
            doc["textures"].append({"source": len(doc["images"]) - 1})
        # The 6.4 m roof tile carries eight panel seams across its width.
        scale = [.25, .42] if kind == "sheet" else [.55, .75]
        return {"index": textures[key], "extensions": {"KHR_texture_transform": {"scale": scale}}}

    for material in doc["materials"]:
        kind = FINISH.get(material.get("name"))
        if not kind:
            continue
        pbr = material["pbrMetallicRoughness"]
        pbr["baseColorTexture"] = image_info(kind, "color")
        material["normalTexture"] = image_info(kind, "normal")
        pbr["metallicRoughnessTexture"] = image_info(kind, "rough")
        gain = 1.08 if kind == "sheet" else 1.27
        color = pbr["baseColorFactor"]
        color[:3] = [min(1, gain * channel) for channel in color[:3]]
        pbr["roughnessFactor"] = min(1, pbr["roughnessFactor"] / .86)
    extensions = doc.setdefault("extensionsUsed", [])
    if "KHR_texture_transform" not in extensions:
        extensions.append("KHR_texture_transform")
    doc["asset"]["copyright"] = " ".join(filter(None, [doc["asset"].get("copyright"), CREDIT]))
    doc["buffers"][0]["byteLength"] = len(binary)
    binary.extend(bytes(-len(binary) % 4))
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    return (struct.pack("<4sIII4s", b"glTF", 2, 28 + len(encoded) + len(binary), len(encoded), b"JSON")
            + encoded + struct.pack("<I4s", len(binary), b"BIN\0") + binary)
