"""Identify the curved window belt on the measured Fullerton Pavilion shell."""
import argparse
import copy
import hashlib
import io
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.ndimage import gaussian_filter

from pavilion_frames import frame_geometry

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "4c500895294277a5e1b01e113cea9ca5f4987df545598dead5e8eb390e6d4d9c"
ENTITY = "bay.5dcad293-673b-462b-b436-286de74f05d8"


def window_faces(positions, texcoords, triangles, image):
    points = positions[triangles]
    mid = points.mean(axis=1)
    normals = np.cross(points[:, 1] - points[:, 0], points[:, 2] - points[:, 0])
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-8)
    # Centre fitted to the two rings of survey vertices at 2.65 and 5.20 m.
    radial = mid[:, [0, 2]] - [-7.8, 17.7]
    radius = np.linalg.norm(radial, axis=1)
    outward = (normals[:, [0, 2]] * radial).sum(axis=1) / np.maximum(radius, 1e-4)
    belt = ((radius > 9.8) & (radius < 12.6) & (outward > .40) &
            (normals[:, 1] > -.12) & (mid[:, 1] > .70) & (mid[:, 1] < 6.05))
    weights = [[a/7, b/7, 1-(a+b)/7] for a in range(1, 6) for b in range(1, 7-a)]
    samples = np.einsum("si,tij->tsj", weights, texcoords[triangles])
    pixels = np.asarray(image, dtype=float)
    samples = np.clip(samples, 0, 1 - 1e-8)
    x = (samples[:, :, 0] * image.width).astype(int)
    y = (samples[:, :, 1] * image.height).astype(int)
    rgb = pixels[y, x]
    cool = (rgb[:, :, 1] > rgb[:, :, 0] + 6) & (rgb[:, :, 2] > rgb[:, :, 0] + 4)
    score = cool.mean(axis=1)
    # The two triangles of a measured pane share its diagonal. Classify them together
    # so a dark part of the photograph cannot split one pane into two materials.
    pairs = {}
    for index in np.flatnonzero(belt):
        vertices = points[index]
        lengths = np.linalg.norm(np.roll(vertices, -1, axis=0) - vertices, axis=1)
        edge = int(np.argmax(lengths))
        key = tuple(sorted((tuple(vertices[edge]), tuple(vertices[(edge + 1) % 3]))))
        pairs.setdefault(key, []).append(index)
    for group in pairs.values():
        if len(group) == 2:
            score[group] = score[group].mean()
    return belt & (score > .4)


def convert(raw):
    size = struct.unpack_from("<I", raw, 12)[0]
    document = json.loads(raw[20:20 + size])
    binary = raw[28 + size:]
    views = [binary[v.get("byteOffset", 0):][:v["byteLength"]] for v in document["bufferViews"]]

    def read(index):
        a = document["accessors"][index]
        width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[a["type"]]
        dtype = {5126: "<f4", 5125: "<u4", 5123: "<u2"}[a["componentType"]]
        return np.frombuffer(views[a["bufferView"]], dtype=dtype, count=a["count"]*width).reshape(-1, width)

    def indices(index, triangles):
        a = document["accessors"][index]
        a.update(count=triangles.size, min=[int(triangles.min())], max=[int(triangles.max())])
        views[a["bufferView"]] = triangles.tobytes()

    image_view = document["images"][0]["bufferView"]
    image = Image.open(io.BytesIO(views[image_view])).convert("RGB")
    mask = Image.new("L", image.size)
    painter = ImageDraw.Draw(mask)
    original = document["materials"][0]
    glass = copy.deepcopy(original)
    # Retain the diffuse/emissive proportions used by the viewer for the surveyed photograph.
    original["pbrMetallicRoughness"]["baseColorFactor"] = [.3, .3, .3, 1]
    original["emissiveTexture"] = copy.deepcopy(original["pbrMetallicRoughness"]["baseColorTexture"])
    original["emissiveFactor"] = [.72, .72, .72]
    reflection = (ROOT / "references/fullerton-pavilion-reflection.jpg").read_bytes()
    probe_view = len(views)
    views.append(reflection)
    document["bufferViews"].append({"buffer": 0})
    probe_image = len(document["images"])
    document["images"].append({"bufferView": probe_view, "mimeType": "image/jpeg"})
    probe_texture = len(document["textures"])
    document["textures"].append({"source": probe_image})
    glass["emissiveTexture"] = {"index": probe_texture}
    glass["emissiveFactor"] = [0, 0, 0]
    glass.update(name="Fullerton Pavilion curved glazing", extras={"prefilteredReflection": True, "surfaceRole": "facade"})
    glass["pbrMetallicRoughness"].update(roughnessFactor=.28, metallicFactor=0)
    document["materials"].append(glass)
    total = count = 0
    for mesh in document["meshes"]:
        primitive, = mesh["primitives"]
        attrs = {k: read(v) for k, v in primitive["attributes"].items()}
        faces = read(primitive["indices"]).reshape(-1, 3)
        # Deduplicate only identical triples including texture coordinates, winding and normals.
        _, ids = np.unique(np.column_stack(list(attrs.values())), axis=0, return_inverse=True)
        _, keep = np.unique(ids[faces], axis=0, return_index=True)
        faces = faces[np.sort(keep)]
        total += len(faces)
        if "TEXCOORD_0" not in attrs:
            indices(primitive["indices"], faces)
            continue
        selection = window_faces(attrs["POSITION"], attrs["TEXCOORD_0"], faces, image)
        pane = copy.deepcopy(primitive)
        new = copy.deepcopy(document["accessors"][primitive["indices"]])
        new["bufferView"] = len(views)
        views.append(b"")
        document["bufferViews"].append({"buffer": 0, "target": 34963})
        pane["indices"] = len(document["accessors"])
        document["accessors"].append(new)
        pane["material"] = len(document["materials"]) - 1
        mesh["primitives"].append(pane)
        indices(primitive["indices"], faces[~selection])
        indices(pane["indices"], faces[selection])
        count = int(selection.sum())
        for triangle in attrs["TEXCOORD_0"][faces[selection]] * image.size:
            painter.polygon(list(map(tuple, triangle)), fill=255)
        frames = frame_geometry(attrs["POSITION"], faces)
        _, unique, remap = np.unique(np.column_stack(list(frames.values())), axis=0,
                                     return_index=True, return_inverse=True)
        frame_attrs = {}
        for name, values in frames.items():
            values = values[unique]
            normalized = name == "COLOR_0"
            if normalized:
                # Vertex attributes in glTF are four-byte aligned. Opaque RGBA8
                # preserves both metal finishes in a single draw.
                rgb = np.rint(values * 255).astype("u1")
                values = np.column_stack((rgb, np.full(len(rgb), 255, dtype="u1")))
            view = len(views)
            views.append(values.tobytes())
            document["bufferViews"].append({"buffer": 0, "target": 34962})
            frame_attrs[name] = len(document["accessors"])
            accessor = {"bufferView": view, "componentType": 5121 if normalized else 5126,
                        "count": len(values), "type": "VEC4" if normalized else "VEC3"}
            if normalized:
                accessor["normalized"] = True
            if name == "POSITION":
                accessor.update(min=values.min(axis=0).tolist(), max=values.max(axis=0).tolist())
            document["accessors"].append(accessor)
        index = len(document["accessors"])
        document["accessors"].append({"bufferView": len(views), "componentType": 5123,
                                      "type": "SCALAR", "count": len(remap)})
        document["bufferViews"].append({"buffer": 0, "target": 34963})
        views.append(remap.astype("<u2").tobytes())
        mesh["primitives"].append({"attributes": frame_attrs, "indices": index,
                                   "material": len(document["materials"])})
        document["materials"].append({"name": "Pavilion door and window profiles",
            "pbrMetallicRoughness": {"metallicFactor": .42, "roughnessFactor": .38}})
        frame_count = len(frames["POSITION"]) // 3
    if total != 978 or not 100 <= count <= 130:
        raise ValueError(f"Unexpected surveyed geometry: {count} window faces, {total} total")
    # Reduce broad fixed reflections; retain fine luminance changes in the photographed mullions.
    rgb = np.asarray(image, dtype=float)
    weight = np.asarray(mask.filter(ImageFilter.GaussianBlur(.45)), dtype=float) / 255
    luminance = rgb @ [.2126, .7152, .0722]
    local = gaussian_filter(luminance * weight, 4) / np.maximum(.001, gaussian_filter(weight, 4))
    corrected = rgb - (.42 * (local - 89) * weight)[:, :, None]
    encoded = io.BytesIO()
    Image.fromarray(np.uint8(np.clip(corrected, 0, 255))).save(encoded, "PNG", optimize=True)
    views[image_view] = encoded.getvalue()
    document["images"][0]["mimeType"] = "image/png"
    packed = bytearray()
    for view, data in zip(document["bufferViews"], views):
        view.update(byteOffset=len(packed), byteLength=len(data))
        packed.extend(data)
        packed.extend(b"\0" * (-len(packed) % 4))
    document["buffers"][0]["byteLength"] = len(packed)
    header = json.dumps(document, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    print(f"Selected {count} window triangles from {total} unique survey triangles")
    return frame_count, (struct.pack("<4sIIII", b"glTF", 2, 28+len(header)+len(packed), len(header), 0x4e4f534a)
            + header + struct.pack("<I4s", len(packed), b"BIN\0") + packed)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    raw = parser.parse_args().source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE:
        raise ValueError("Expected the original SLA Pavilion GLB")
    frame_count, result = convert(raw)
    digest = hashlib.sha256(result).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(result)
    path = ROOT / "build/onemap-entities.json"
    records = json.loads(path.read_text())
    entity = next(e for e in records if e["entityId"] == ENTITY)
    entity["assetHash"] = digest
    entity["material"] = {"shading": "albedo"}
    entity["props"].update({"原建筑资源": SOURCE, "三角形数": 978 + frame_count,
                           "圆亭窗框": "按测绘影像圆柱展开图配准十二道竖框和两组双扇门。投影到原测绘外壳，55–65 毫米宽、38 毫米凸出量和金属表面参数为估值。",
                           "圆亭玻璃": "按测绘外壳朝向、高度和原影像颜色选取成对玻璃三角面。原窗框纹理保留，日间反光从圆亭中部采集的岸楼、天空和水面计算，玻璃粗糙度 0.28 为估值。"})
    path.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    print(digest, len(result))
