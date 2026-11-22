"""Rebalance the bay-facing hotel glass in the SLA atlas and compact repeated opaque geometry."""

import argparse
import hashlib
import io
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.ndimage import gaussian_filter

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "95664d417851f133b6a370bda1e85cf1851107852768a377516e02ff5653e8ea",
    "798131dc0624167c639000bd26be350b6ba49c8902a7631387922d2a044b7e48",
    "827fcc819e9171157b0540bd1fa1d054f69ccd42350737f86c614fe1febd92bd",
}
REFERENCE = "https://commons.wikimedia.org/wiki/File:Marina_Bay_Sands_view_from_Merlion_Park,_Singapore_(Ank_Kumar)_01.jpg"


def rebalance(image, mask):
    # Separate window divisions from broad patches of baked sunlight in the glass.
    rgb = np.asarray(image.convert("RGB"), dtype=float)
    luminance = rgb @ np.array([.2126, .7152, .0722])
    weight = gaussian_filter(np.asarray(mask.filter(ImageFilter.MaxFilter(3)), dtype=float) / 255, .6)
    local = gaussian_filter(luminance * weight, 3) / np.maximum(gaussian_filter(weight, 3), .001)
    mullions = np.clip(luminance - local, -55, 55)
    value = 113 + .28 * (local - 115) + .88 * mullions
    balanced = value[..., None] * [.86, 1.015, 1.035] + .23 * (rgb - luminance[..., None])
    output = rgb + (balanced - rgb) * weight[..., None]
    return Image.fromarray(np.uint8(np.clip(output, 0, 255)))


def primitive(doc, views, prim, floor, pixels, painter):
    def read(index):
        acc = doc["accessors"][index]
        width = {"VEC2": 2, "VEC3": 3, "VEC4": 4, "SCALAR": 1}[acc["type"]]
        dtype = {5125: "<u4", 5123: "<u2", 5126: "<f4"}[acc["componentType"]]
        view = doc["bufferViews"][acc["bufferView"]]
        assert not view.get("byteStride") and not acc.get("byteOffset")
        return np.frombuffer(views[acc["bufferView"]], dtype, count=acc["count"] * width).reshape(-1, width)

    def write(index, data):
        acc = doc["accessors"][index]
        views[acc["bufferView"]] = data.tobytes()
        acc["count"] = len(data)
        if "min" in acc:
            acc.update(min=data.min(axis=0).tolist(), max=data.max(axis=0).tolist())

    attrs = {key: read(i) for key, i in prim["attributes"].items()}
    faces = read(prim["indices"]).reshape(-1, 3)
    # A seam with distinct UVs, colors or normals is a distinct vertex. Keep first-use ordering.
    payload = np.ascontiguousarray(np.column_stack(list(attrs.values())))
    rows = payload.view(np.dtype((np.void, payload.strides[0]))).ravel()
    _, unique, inverse = np.unique(rows, return_index=True, return_inverse=True)
    order = np.argsort(unique)
    keep_vertices = unique[order]
    remap = np.argsort(order)[inverse].ravel()
    triangles = remap[faces]
    # Cyclic permutations have the same winding. Mirrored triangles stay independent.
    cyclic = (np.arange(3) + np.argmin(triangles, axis=1)[:, None]) % 3
    _, first = np.unique(np.take_along_axis(triangles, cyclic, axis=1), axis=0, return_index=True)
    first.sort()
    if "TEXCOORD_0" in attrs:
        original = faces[first]
        normals = attrs["NORMAL"][original].mean(axis=1)
        altitude = attrs["POSITION"][original, 1].mean(axis=1) + floor
        facing_bay = ((normals[:, 0] > .82) & (np.abs(normals[:, 1]) < .25)
                      & (altitude > 22) & (altitude < 182.4))
        for face in original[facing_bay]:
            uv = attrs["TEXCOORD_0"][face] * pixels
            painter.polygon([tuple(point) for point in uv], fill=255)
    for key, index in prim["attributes"].items():
        write(index, attrs[key][keep_vertices])
    write(prim["indices"], triangles[first].astype(faces.dtype).reshape(-1, 1))
    return len(first)


def convert(raw, floor):
    json_length = struct.unpack_from("<I", raw, 12)[0]
    doc = json.loads(raw[20:20 + json_length])
    binary = raw[28 + json_length:]
    views = [binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]
             for v in doc["bufferViews"]]
    image_info, = doc["images"]
    image = Image.open(io.BytesIO(views[image_info["bufferView"]]))
    mask = Image.new("L", image.size)
    painter = ImageDraw.Draw(mask)
    count = sum(primitive(doc, views, prim, floor, image.size, painter)
                for mesh in doc["meshes"] for prim in mesh["primitives"])
    jpeg = io.BytesIO()
    rebalance(image, mask).save(jpeg, "JPEG", quality=95, subsampling=0, optimize=True)
    views[image_info["bufferView"]] = jpeg.getvalue()
    image_info["mimeType"] = "image/jpeg"

    data = bytearray()
    for view, block in zip(doc["bufferViews"], views, strict=True):
        data.extend(b"\0" * (-len(data) % 4))
        view.update(byteOffset=len(data), byteLength=len(block))
        data.extend(block)
    data.extend(b"\0" * (-len(data) % 4))
    doc["buffers"][0]["byteLength"] = len(data)
    header = json.dumps(doc, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    return (struct.pack("<4sIII4s", b"glTF", 2, 28 + len(header) + len(data), len(header), b"JSON")
            + header + struct.pack("<I4s", len(data), b"BIN\0") + data), count


def bake(sources):
    records_file = ROOT / "build/onemap-entities.json"
    records = json.loads(records_file.read_text())
    environment = json.loads((ROOT / "context.json").read_text())
    office_height = environment["oneMap"]["officeHeightMeters"]
    found = set()
    for e in records:
        source = e["props"].get("原建筑资源", e["assetHash"])
        if source not in SOURCES:
            continue
        raw = (sources / f"{source}.glb").read_bytes()
        if hashlib.sha256(raw).hexdigest() != source:
            raise ValueError(f"Source does not match {source}")
        data, triangles = convert(raw, e["bounds"]["min"][1] + office_height)
        digest = hashlib.sha256(data).hexdigest()
        (ROOT / "assets" / f"{digest}.glb").write_bytes(data)
        e["assetHash"] = digest
        e["props"].update({"三角形数": triangles, "原建筑资源": source, "玻璃参考": REFERENCE,
                           "立面处理": "按朝湾立面朝向和高度校正贴图中的大面积固定亮斑；窗格和几何轮廓沿用 SLA 模型。"})
        found.add(source)
        print(e["label"], digest, len(data), triangles)
    if found != SOURCES:
        raise ValueError("The workspace is missing a hotel tower")
    records_file.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", type=Path, help="Directory containing the three original OneMap GLBs")
    bake(parser.parse_args().sources)
