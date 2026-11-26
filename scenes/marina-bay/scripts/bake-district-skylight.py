"""Apply the surveyed district sky visibility to the existing glTF facades."""
import argparse
import hashlib
import io
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SURVEY = ROOT / "references/district-skylight"


def bake(source, record, fields):
    if hashlib.sha256(source).hexdigest() != record["source"]:
        raise ValueError(f"Unexpected facade source for {record['label']}")
    header_length = struct.unpack_from("<I", source, 12)[0]
    document = json.loads(source[20:20 + header_length])
    binary = bytearray(source[28 + header_length:])

    def add_view(data, target=None):
        binary.extend(bytes(-len(binary) % 4))
        view = {"buffer": 0, "byteOffset": len(binary), "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        index = len(document["bufferViews"])
        document["bufferViews"].append(view)
        binary.extend(data)
        return index

    # A mip chain would average adjacent lookup values across facade boundaries.
    # Sample linearly at level zero. The UV values already interpolate over the facade.
    ramp = io.BytesIO()
    Image.fromarray(np.arange(256, dtype="u1")[None, :]).save(ramp, "PNG")
    image = len(document["images"])
    document["images"].append(dict(bufferView=add_view(ramp.getvalue()), mimeType="image/png",
                                   name="Diffuse sky visibility"))
    samplers = document.setdefault("samplers", [])
    sampler = len(samplers)
    samplers.append(dict(magFilter=9729, minFilter=9729, wrapS=33071, wrapT=33071))
    texture = len(document["textures"])
    document["textures"].append(dict(source=image, sampler=sampler))
    for address, field in record["primitives"].items():
        mesh, primitive = map(int, address.split("/"))
        part = document["meshes"][mesh]["primitives"][primitive]
        attrs = part["attributes"]
        u = fields[field]
        count = document["accessors"][attrs["POSITION"]]["count"]
        if u.shape != (count,) or "TEXCOORD_1" in attrs:
            raise ValueError(f"Survey no longer matches {record['label']} at {address}")
        uv = np.column_stack((u, np.full(count, 32768))).astype("<u2")
        index = len(document["accessors"])
        document["accessors"].append(dict(bufferView=add_view(uv.tobytes(), 34962),
                                          componentType=5123, normalized=True, count=count, type="VEC2"))
        attrs["TEXCOORD_1"] = index
        document["materials"][part["material"]]["occlusionTexture"] = dict(index=texture, texCoord=1)
    binary.extend(bytes(-len(binary) % 4))
    document["buffers"][0]["byteLength"] = len(binary)
    header = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    return (struct.pack("<4sIII4s", b"glTF", 2, 28 + len(header) + len(binary), len(header), b"JSON")
            + header + struct.pack("<I4s", len(binary), b"BIN\0") + binary)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, default=ROOT / "assets")
    assets = parser.parse_args().assets
    with np.load(SURVEY / "facade-exposure.npz", allow_pickle=False) as fields:
        for record in json.loads((SURVEY / "survey.json").read_text())["buildings"]:
            raw = bake((assets / (record["source"] + ".glb")).read_bytes(), record, fields)
            digest = hashlib.sha256(raw).hexdigest()
            if digest != record["output"]:
                raise ValueError(f"Unexpected output digest for {record['label']}")
            (assets / (digest + ".glb")).write_bytes(raw)
