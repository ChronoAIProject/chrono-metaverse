"""Restore the bay-facing glazing obscured by photographed trees near bus stop 03391."""

import argparse
import hashlib
import io
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "001355853fdca2297779ffa1c2635c454bd0b7973d7ae3b7ae72a941ab5e5a42"
ENTITY = "bay.cd02949d-d6c1-470a-a088-b34619514451"


def repair_glazing(image):
    pixels = np.array(image.convert("RGB"))
    # This UV island belongs to the long waterfront wall. The pale object in
    # front of its middle bays and the window frames at the bottom are visible.
    x, y = np.meshgrid(np.arange(261), np.arange(125, 200))
    row = np.clip(y, 129, 197)
    left = np.interp(row, [129, 148, 173, 197], [115, 109, 91, 62])
    right = np.interp(row, [129, 147, 171, 197], [156, 158, 174, 193])
    blend = np.clip(np.maximum(left - x, x - right) / 5 + .5, 0, 1)
    # Extend the observed bay rhythm using two adjoining panels between the
    # upright at x=117 and the one at x=142. Reconstruct concealed portions
    # of the upper glass from clear glazing at the same height.
    sample = 117 + (x - 117) % 25
    glass = pixels[row, sample].astype(float)
    sign = (row >= 154) & (row <= 172) & (sample < 134)
    t = np.clip((row - 153) / 20, 0, 1)[:, :, None]
    above, below = pixels[153, sample], pixels[173, sample]
    glass[sign] = ((1 - t) * above + t * below)[sign]
    pixels[y, x] = np.rint(pixels[y, x] * (1 - blend[:, :, None]) + glass * blend[:, :, None])
    return Image.fromarray(pixels)


def bake(path):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE:
        raise ValueError("Expected the original SLA waterfront building")
    size = struct.unpack_from("<I", raw, 12)[0]
    doc = json.loads(raw[20:20+size])
    binary = raw[28+size:]
    blocks = [binary[v.get("byteOffset", 0):v.get("byteOffset", 0)+v["byteLength"]] for v in doc["bufferViews"]]
    image_view = doc["images"][0]["bufferView"]
    encoded = io.BytesIO()
    with Image.open(io.BytesIO(blocks[image_view])) as image:
        repair_glazing(image).save(encoded, "PNG")
    blocks[image_view] = encoded.getvalue()
    payload = bytearray()
    for view, block in zip(doc["bufferViews"], blocks, strict=True):
        payload.extend(bytes(-len(payload) % 4))
        view.update(byteOffset=len(payload), byteLength=len(block))
        payload.extend(block)
    payload.extend(bytes(-len(payload) % 4))
    doc["buffers"][0]["byteLength"] = len(payload)
    header = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    data = (struct.pack("<4sIII4s", b"glTF", 2, 28 + len(header) + len(payload), len(header), b"JSON")
            + header + struct.pack("<I4s", len(payload), b"BIN\0") + payload)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest+".glb")).write_bytes(data)
    entities = ROOT / "build/onemap-entities.json"
    records = json.loads(entities.read_text())
    row = next(e for e in records if e["entityId"] == ENTITY)
    row["assetHash"] = digest
    row["props"].update({"原建筑资源": SOURCE, "立面处理": "滨海大道 03391 站旁朝湾立面的航测纹理含前景树影。遮挡区域的窗格依据同一立面露出的相邻窗格估补。"})
    entities.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    print(digest)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    bake(parser.parse_args().source)
