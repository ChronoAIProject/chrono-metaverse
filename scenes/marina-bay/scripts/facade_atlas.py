"""Replace the embedded colour atlas while retaining every geometry buffer."""

import io
import json
import struct

from PIL import Image, JpegImagePlugin


def replace_atlas(raw, edit, credit=None, *, jpeg_quality=None, keep_encoding=False):
    size = struct.unpack_from("<I", raw, 12)[0]
    doc = json.loads(raw[20:20+size])
    binary = raw[28+size:]
    blocks = [binary[v.get("byteOffset", 0):v.get("byteOffset", 0)+v["byteLength"]] for v in doc["bufferViews"]]
    if credit:
        doc["images"][0].setdefault("extras", {})["glazingAttribution"] = credit
    if not keep_encoding:
        doc["images"][0]["mimeType"] = "image/png" if jpeg_quality is None else "image/jpeg"
    image_view = doc["images"][0]["bufferView"]
    encoded = io.BytesIO()
    with Image.open(io.BytesIO(blocks[image_view])) as image:
        result = edit(image)
        if keep_encoding and image.format == "JPEG":
            result.save(encoded, "JPEG", qtables=image.quantization,
                        subsampling=JpegImagePlugin.get_sampling(image), optimize=True)
        elif keep_encoding:
            result.save(encoded, image.format, optimize=True)
        elif jpeg_quality is None:
            result.save(encoded, "PNG")
        else:
            result.convert("RGB").save(encoded, "JPEG", quality=jpeg_quality, subsampling=0)
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
    return data
