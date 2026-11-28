"""Give the surveyed exterior arches their paint while preserving the indexed OneMap mesh."""
import hashlib
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image

from facade_atlas import replace_atlas

ROOT = Path(__file__).resolve().parents[1]


def balance_glazing(image):
    # Daylight photos show a warmer middle tone on both roofs. Preserve the atlas endpoints.
    srgb = np.asarray(image.convert("RGB"), dtype=np.float64) / 255
    linear = np.where(srgb <= .04045, srgb / 12.92, ((srgb + .055) / 1.055) ** 2.4)
    gain = np.array([2.0, 1.48, 1.0])
    adjusted = gain * linear / (1 + (gain - 1) * linear)
    encoded = np.where(adjusted <= .0031308, adjusted * 12.92, 1.055 * adjusted ** (1 / 2.4) - .055)
    return Image.fromarray(np.rint(encoded * 255).astype(np.uint8))


def bake():
    survey = json.loads((ROOT / "references/garden-conservatory-arches.json").read_text())
    source = survey["sourceAssetHash"]
    raw = (ROOT / "assets" / f"{source}.glb").read_bytes()
    if hashlib.sha256(raw).hexdigest() != source:
        raise ValueError("Survey face ranges require the recorded source model")
    # Repack images before splitting the index buffer into overlapping views for steel and glass.
    # The two original measured meshes each have one colour atlas.
    for image_index in (0, 1):
        raw = replace_atlas(raw, balance_glazing, image_index=image_index, keep_encoding=True)
    header_size = struct.unpack_from("<I", raw, 12)[0]
    model = json.loads(raw[20:20 + header_size])
    binary = bytearray(raw[28 + header_size:])
    coating = dict(survey["coating"])
    material = {"name": coating.pop("name"), "doubleSided": True, "pbrMetallicRoughness": coating}
    paint = len(model["materials"])
    model["materials"].append(material)

    for mesh in model["meshes"]:
        primitive, = mesh["primitives"]
        accessor = model["accessors"][primitive["indices"]]
        view = model["bufferViews"][accessor["bufferView"]]
        if accessor["componentType"] != 5125 or accessor["count"] % 3 or "byteStride" in view:
            raise ValueError("Expected tightly packed indexed triangles")
        offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        count = accessor["count"] // 3
        faces = list(struct.iter_unpack("<3I", binary[offset:offset + count * 12]))
        arch = bytearray(count)
        for start, length in survey["faceRanges"][mesh["name"]]:
            if start < 0 or length <= 0 or start + length > count or any(arch[start:start + length]):
                raise ValueError("Invalid arch range")
            arch[start:start + length] = bytes([1]) * length
        mesh["primitives"] = []
        for kind, index in enumerate((primitive["material"], paint)):
            subset = [face for face, selection in zip(faces, arch) if selection == kind]
            payload = b"".join(struct.pack("<3I", *face) for face in subset)
            model["bufferViews"].append({"buffer": 0, "byteOffset": offset,
                                         "byteLength": len(payload), "target": 34963})
            binary[offset:offset + len(payload)] = payload
            offset += len(payload)
            model["accessors"].append({"componentType": 5125, "type": "SCALAR",
                                       "bufferView": len(model["bufferViews"]) - 1, "count": 3 * len(subset),
                                       "min": [min(map(min, subset))], "max": [max(map(max, subset))]})
            mesh["primitives"].append({**primitive, "indices": len(model["accessors"]) - 1, "material": index})

    header = json.dumps(model, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    result = (struct.pack("<4sII", b"glTF", 2, 28 + len(header) + len(binary)) +
              struct.pack("<I4s", len(header), b"JSON") + header +
              struct.pack("<I4s", len(binary), b"BIN\0") + binary)
    digest = hashlib.sha256(result).hexdigest()
    (ROOT / "assets" / f"{digest}.glb").write_bytes(result)
    return digest


if __name__ == "__main__":
    print(bake())
