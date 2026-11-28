"""Bake historical offshore silhouettes as a single georeferenced 3D tile."""

import argparse
import json
import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "references/eastern-anchorage"


def tangent_frame(longitude, latitude):
    """Columns are east, north and up in WGS84 Earth-centered coordinates."""
    lon, lat = np.radians([longitude, latitude])
    slon, clon, slat, clat = np.sin(lon), np.cos(lon), np.sin(lat), np.cos(lat)
    radius = 6378137 / np.sqrt(1 - 0.0066943799901413165 * slat**2)
    point = radius * np.array([clat * clon, clat * slon, (1 - 0.0066943799901413165) * slat])
    return point, np.array([[-slon, -slat * clon, clat * clon],
                            [clon, -slat * slon, clat * slon], [0, clat, slat]])


def linear(srgb):
    return np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)


def hull_faces(vessel):
    length = vessel["length"]
    beam = min(vessel["beam"], 0.21 * length)
    freeboard = np.clip(0.20 * beam, 4, 10)
    deck = np.asarray(vessel["deck"])
    side = np.clip(0.22 * np.median(deck, axis=0) + [45, 51, 57], 42, 104)
    stations = [(-0.5, 0.3), (-0.42, 0.46), (-0.27, 0.5), (-0.04, 0.5),
                (0.17, 0.49), (0.32, 0.46), (0.43, 0.3), (0.5, 0.025)]
    for i, ((start, width), (end, next_width)) in enumerate(zip(stations, stations[1:])):
        x, u, w, v = start * length, end * length, width * beam, next_width * beam
        yield [(x, freeboard, -w), (x, freeboard, w), (u, freeboard, v),
               (u, freeboard, -v)], 0.72 * deck[i] + [17, 19, 18]
        for sign in [-1, 1]:
            for low, high, lower, upper, color in [
                (-3, 1.3, 0.84, 0.91, side * 0.8), (1.3, freeboard, 0.91, 1, side),
            ]:
                face = [(x, low, sign*w*lower), (u, low, sign*v*lower),
                        (u, high, sign*v*upper), (x, high, sign*w*upper)]
                yield face if sign == 1 else face[::-1], color
    for fraction, width in [stations[0], stations[-1]]:
        x, w = fraction * length, beam * width
        end = [(x, -3, -w*0.84), (x, -3, w*0.84), (x, freeboard, w), (x, freeboard, -w)]
        yield end if x < 0 else end[::-1], side

    bridge = freeboard + np.clip(0.27 * beam, 4.2, 12)
    for start, end, width, low, high, color in [
        (-0.39, -0.27, 0.31, freeboard, bridge, [154, 161, 157]),
        (-0.39, -0.29, 0.34, bridge, bridge+2.5, [178, 185, 180]),
    ]:
        x, u, w = start * length, end * length, width * beam
        outline = [(x, -w), (x, w), (u, w), (u, -w)]
        roof = [(a, high, b) for a, b in outline]
        for i, (a, b) in enumerate(outline):
            j = (i+1) % len(outline)
            c, d = outline[j]
            yield [(c, low, d), roof[j], roof[i], (a, low, b)], 0.91 * np.array(color)
        yield roof, np.array(color)


def geometry(vessels, origin, frame):
    positions, colors, indices = [], [], []
    site, _ = tangent_frame(103.8542, 1.2849)
    horizon = linear(np.array([0.57, 0.65, 0.70]))
    for vessel in vessels:
        anchor, local = tangent_frame(vessel["longitude"], vessel["latitude"])
        bearing = np.radians(vessel["bearing"])
        sine, cosine = np.sin(bearing), np.cos(bearing)
        ship = np.array([[sine, 0, cosine], [cosine, 0, -sine], [0, 1, 0]])
        for face, pigment in hull_faces(vessel):
            corners = anchor + np.asarray(face) @ (local @ ship).T
            enu = (corners - origin) @ frame
            gltf = enu[:, [0, 2, 1]].copy()
            gltf[:, 2] *= -1
            normal = np.cross(gltf[1]-gltf[0], gltf[2]-gltf[0])
            normal /= np.linalg.norm(normal)
            surface = linear(np.asarray(pigment) / 255) * (0.67 + 0.30 * max(0, normal[1]))
            # The vessels are several kilometres beyond the walkable area. Bake one
            # daylight appearance for the observed rooftop and shore viewing sector.
            transmission = np.exp2(-np.linalg.norm(corners-site, axis=1, keepdims=True) / 4800)
            colors.extend(surface * transmission + horizon * (1-transmission))
            offset = len(positions)
            positions.extend(gltf)
            indices.extend(offset + i for i in (0, 1, 2, 0, 2, 3))
    return np.array(positions, '<f4'), np.asarray(colors, '<f4'), np.array(indices, '<u2')


def write_tile(output):
    vessels = json.loads((SOURCE / "survey.json").read_text())["vessels"]
    center = np.mean([[v["longitude"], v["latitude"]] for v in vessels], axis=0)
    origin, frame = tangent_frame(*center)
    positions, colors, indices = geometry(vessels, origin, frame)
    arrays = [positions, colors, indices]
    material = {"name": "Daylit offshore silhouettes", "extensions": {"KHR_materials_unlit": {}}}
    views, binary = [], bytearray()
    for data in arrays:
        views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": data.nbytes})
        binary.extend(data.tobytes())
        binary.extend(bytes(-len(binary) % 4))
    gltf = {
        "asset": {"version": "2.0"}, "extensionsUsed": ["KHR_materials_unlit"],
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "COLOR_0": 1},
                                   "indices": 2, "material": 0}]}], "materials": [material],
        "buffers": [{"byteLength": len(binary)}], "bufferViews": views,
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(positions), "type": "VEC3",
             "min": positions.min(0).tolist(), "max": positions.max(0).tolist()},
            {"bufferView": 1, "componentType": 5126, "count": len(colors), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5123, "count": len(indices), "type": "SCALAR"},
        ],
    }
    document = json.dumps(gltf, separators=(",", ":")).encode()
    document += b" " * (-len(document) % 4)
    output.mkdir(parents=True, exist_ok=True)
    with (output / "anchorage.glb").open("wb") as stream:
        stream.write(struct.pack("<4sII", b"glTF", 2, 28 + len(document) + len(binary)))
        for tag, payload in [(b"JSON", document), (b"BIN\0", binary)]:
            stream.write(struct.pack("<I4s", len(payload), tag))
            stream.write(payload)
    enu = positions[:, [0, 2, 1]].copy()
    enu[:, 1] *= -1
    lower, upper = enu.min(0), enu.max(0)
    box = ((lower+upper)*0.5).tolist() + np.diag((upper-lower)*0.5+0.1).ravel().tolist()
    transform = np.eye(4)
    transform[:3, :3], transform[:3, 3] = frame, origin
    tileset = {"asset": {"version": "1.1"}, "geometricError": 0, "root": {
        "boundingVolume": {"box": box}, "geometricError": 0, "refine": "ADD",
        "transform": transform.T.ravel().tolist(), "content": {"uri": "anchorage.glb"}}}
    (output / "tileset.json").write_text(json.dumps(tileset, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, nargs="?", default=SOURCE / "tiles")
    write_tile(parser.parse_args().output)
