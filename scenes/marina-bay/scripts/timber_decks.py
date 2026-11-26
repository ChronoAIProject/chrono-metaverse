"""Apply registered wood scans to complete outdoor decks after their contact UVs are exported."""
from pathlib import Path
import json
import struct

SCANS = Path(__file__).resolve().parents[1] / "references/timber-decks"
CREDIT = ("Deck scans: Wooden Planks (Charlotte Baglioni and Dario Barresi), "
          "Weathered Planks (Dimitrios Savva and Dario Barresi), Poly Haven, CC0.")


def apply_deck_scans(glb, material_name, finish):
    header_length = struct.unpack_from("<I", glb, 12)[0]
    doc = json.loads(glb[20:20 + header_length])
    binary_start = 28 + header_length
    binary = bytearray(glb[binary_start:binary_start + doc["buffers"][0]["byteLength"]])
    material = next(mat for mat in doc["materials"] if mat.get("name") == material_name)
    pbr = material["pbrMetallicRoughness"]
    if set(pbr["baseColorTexture"]) != {"index"}:
        raise ValueError(f"Expected an untransformed primary chart for {material_name}")

    def attach(filename, mime_type):
        data = (SCANS / f"{finish}-{filename}").read_bytes()
        binary.extend(bytes(-len(binary) % 4))
        view = len(doc["bufferViews"])
        doc["bufferViews"].append(dict(buffer=0, byteOffset=len(binary), byteLength=len(data)))
        binary.extend(data)
        image = len(doc["images"])
        doc["images"].append(dict(bufferView=view, mimeType=mime_type))
        texture = len(doc["textures"])
        doc["textures"].append(dict(source=image))
        return {"index": texture, "extensions": {"KHR_texture_transform": {"scale": [.25, .5]}}}

    pbr["baseColorTexture"] = attach("grain.jpg", "image/jpeg")
    strength = material.get("normalTexture", {}).get("scale", .58)
    material["normalTexture"] = {**attach("normal.jpg", "image/jpeg"), "scale": strength}
    # The scanned roughness map averages about 0.75. Preserve the site's calibrated finish.
    pbr["metallicRoughnessTexture"] = attach("surface.png", "image/png")
    pbr["roughnessFactor"] = min(1., pbr.get("roughnessFactor", 1) / .75)
    pbr["metallicFactor"] = 0
    if "KHR_texture_transform" not in doc.setdefault("extensionsUsed", []):
        doc["extensionsUsed"].append("KHR_texture_transform")
    doc["asset"]["copyright"] = " ".join(filter(None, (doc["asset"].get("copyright"), CREDIT)))
    doc["buffers"][0]["byteLength"] = len(binary)
    binary.extend(bytes(-len(binary) % 4))
    header = json.dumps(doc, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    return (struct.pack("<4sIII4s", b"glTF", 2, 28 + len(header) + len(binary), len(header), b"JSON")
            + header + struct.pack("<I4s", len(binary), b"BIN\0") + binary)
