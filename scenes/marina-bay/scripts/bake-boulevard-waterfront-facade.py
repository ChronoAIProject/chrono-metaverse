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
    # The clear lower bays have uprights at x=117, 130 and 142. A pale
    # freestanding sign covers the centre of the facade, so repeating an
    # entire window also repeats the sign. Estimate the glass by height
    # from the darker clear samples and the frame profile below the sign.
    clear = pixels[129:198, 106:163].astype(float)
    light = clear @ np.array([.2126, .7152, .0722])
    neutral = clear[:, :, 1] - clear[:, :, 2] < 15
    lo = np.quantile(np.where(neutral, light, np.inf), .17, axis=1)
    hi = np.quantile(np.where(neutral, light, np.inf), .47, axis=1)
    in_glass = neutral & (light >= lo[:, None]) & (light <= hi[:, None])
    glass_rows = np.array([np.median(values[valid], axis=0) for values, valid in zip(clear, in_glass)])
    # Smooth the measured profile only along this small texture island.
    weights = np.array([1, 2, 3, 2, 1], dtype=float) / 9
    padded = np.pad(glass_rows, ((2, 2), (0, 0)), mode="edge")
    glass_rows = sum(w * padded[i:i+len(glass_rows)] for i, w in enumerate(weights))
    period = 12.5
    sample_x = np.arange(108, 150)
    profile = np.median(pixels[180:193, sample_x].astype(float), axis=0)
    frame = []
    for phase in np.arange(25) / 2:
        distance = abs((sample_x - 117 - phase + period / 2) % period - period / 2)
        frame.append(np.average(profile, axis=0, weights=np.exp(-.5 * (distance / .75)**2)))
    frame = np.array(frame)
    frame -= np.median(frame, axis=0)
    glass = glass_rows[row - 129] + .68 * frame[((x - 117) * 2) % 25]
    glass = np.clip(glass, 0, 255)
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
