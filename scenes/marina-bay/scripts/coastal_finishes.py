"""Assign coordinated, metre-scale roof and wall finishes to the surveyed Tanjong Rhu blocks."""
import copy
import hashlib
import json
import struct
from pathlib import Path

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "references/coastal-finishes"
SCANS = json.loads((SOURCES / "scans.json").read_text())
CLAY = ("barrel", "interlock", "flat-clay")
# Relative linear-light tints. The same sample controls masonry warmth on each block.
PALETTES = np.array([[1.19, 1.02, .83], [1.04, .95, .86], [.86, .88, .96],
                     [1.08, 1.12, 1.04], [.92, .82, .73], [1.06, .92, .78]])


class Model:
    """Keep existing geometry, photographic UVs and baked occlusion accessors intact."""
    def __init__(self, blob):
        size = struct.unpack_from("<I", blob, 12)[0]
        self.doc = json.loads(blob[20:20 + size])
        start = 28 + size
        self.data = bytearray(blob[start:start + self.doc["buffers"][0]["byteLength"]])
        self.textures = {}

    def append_view(self, octets):
        self.data.extend(bytes(-len(self.data) % 4))
        views = self.doc["bufferViews"]
        views.append(dict(buffer=0, byteOffset=len(self.data), byteLength=len(octets)))
        self.data.extend(octets)
        return len(views) - 1

    def read(self, index, width):
        acc = self.doc["accessors"][index]
        view = self.doc["bufferViews"][acc["bufferView"]]
        dtype = np.dtype({5121: "u1", 5123: "<u2", 5125: "<u4", 5126: "<f4"}[acc["componentType"]])
        return np.ndarray((acc["count"], width), dtype, buffer=self.data,
                          offset=view.get("byteOffset", 0) + acc.get("byteOffset", 0),
                          strides=(view.get("byteStride", dtype.itemsize * width), dtype.itemsize)).copy()

    def attribute(self, values, kind, component):
        attrs = self.doc["accessors"]
        attrs.append(dict(bufferView=self.append_view(values.tobytes()), componentType=component,
                          count=len(values), type=kind))
        return len(attrs) - 1

    def texture(self, family, channel):
        key = (family, channel)
        if key not in self.textures:
            ext = "png" if channel == "surface" else "jpg"
            view = self.append_view((SOURCES / f"{family}-{channel}.{ext}").read_bytes())
            self.doc["images"].append(dict(bufferView=view, mimeType="image/" + ("jpeg" if ext == "jpg" else ext)))
            self.textures[key] = len(self.doc["textures"])
            self.doc["textures"].append(dict(source=len(self.doc["images"]) - 1))
        return {"index": self.textures[key]}

    def finish(self):
        self.doc["buffers"][0]["byteLength"] = len(self.data)
        self.data.extend(bytes(-len(self.data) % 4))
        header = json.dumps(self.doc, separators=(",", ":")).encode()
        header += b" " * (-len(header) % 4)
        return (struct.pack("<4sIII4s", b"glTF", 2, 28 + len(header) + len(self.data), len(header), b"JSON")
                + header + struct.pack("<I4s", len(self.data), b"BIN\0") + self.data)


def building_ids(points, faces, buildings):
    # Join vertices across duplicated normal/UV seams. Use one surveyed building for a whole roof island.
    _, weld = np.unique(np.round(points, 2), axis=0, return_inverse=True)
    weld = weld.ravel()
    tri = weld[faces]
    size = weld.max() + 1
    graph = coo_matrix((np.ones(tri.size, dtype=bool), (tri.ravel(), np.roll(tri, 1, axis=1).ravel())),
                       shape=(size, size))
    _, labels = connected_components(graph, directed=False)
    labels = labels[weld]
    count = np.bincount(labels)
    centres = np.column_stack([np.bincount(labels, weights=points[:, axis]) / count for axis in (0, 2)])
    spans = np.array([b["extent"] for b in buildings])
    distances = np.abs(centres[:, None] - np.array([b["center"] for b in buildings]))
    # Prefer a footprint containing the island; resolve stepped or overlapping footprints by proximity.
    score = (np.maximum(distances - spans, 0) ** 2).sum(2) + .02 * (distances ** 2).sum(2)
    return score.argmin(1)[labels]


def coordinates(points, normals, phase):
    # U follows the eave. V descends the slope from the ridge. Horizontal caps use the local scene axes.
    axis = np.column_stack([normals[:, 2], np.zeros(len(points)), -normals[:, 0]])
    length = np.linalg.norm(axis, axis=1)
    axis[length < .02] = [1, 0, 0]
    axis /= np.maximum(.0001, np.linalg.norm(axis, axis=1, keepdims=True))
    fall = np.cross(axis, normals)
    return np.column_stack([(points * axis).sum(1), (points * fall).sum(1)]) + phase


def apply(model, prim, source, buildings):
    d = model.doc
    name = source["name"].lower()
    roof = "clay" in name or "hip roof" in name
    attrs = prim["attributes"]
    points = model.read(attrs["POSITION"], 3)
    normals = model.read(attrs["NORMAL"], 3)
    faces = model.read(prim["indices"], 1).reshape(-1, 3)
    owners = building_ids(points, faces, buildings)
    seeds = np.array([int(hashlib.sha256(b["surveyID"].encode()).hexdigest()[:8], 16) for b in buildings])
    seeds = seeds[owners]
    tint = PALETTES[(seeds // 11) % len(PALETTES)]
    phase = np.column_stack([seeds % 127, (seeds // 127) % 131]) * .67
    surface_uv = coordinates(points, normals, phase)
    if roof:
        families = np.array(CLAY)[seeds[faces[:, 0]] % len(CLAY)]
        if "grey" in name:
            families[:] = "grey-tile"
    else:
        families = np.where(normals[faces, 1].mean(1) > .60, "cut-stone", "render")
    result = []
    chart_cache = {}
    colour_attr = None
    for family in np.unique(families):
        selected = faces[families == family]
        mat = copy.deepcopy(source)
        mat["name"] = source["name"] + " / " + family
        pbr = mat["pbrMetallicRoughness"]
        colour = np.array(pbr["baseColorFactor"][:3])
        white = .47 if roof else .69
        # Keep headroom in the vertex channel for sun-bleached panels. Wall and coping use the same root hue.
        colour_gain = 1.30 if roof else 1.16
        material_colour = np.clip(colour * colour_gain / white, .01, 1)
        daylight = tint if roof else 1 + .38 * (tint - 1)
        variation = np.clip(colour * daylight / (white * material_colour), 0, 1)
        pbr.update(baseColorTexture=model.texture(family, "colour"),
                   baseColorFactor=[*material_colour, 1.], metallicFactor=0., roughnessFactor=1.,
                   metallicRoughnessTexture=model.texture(family, "surface"))
        mat["normalTexture"] = {**model.texture(family, "normal"), "scale": .70 if roof else .45}
        new_attrs = dict(attrs)
        # Share position, normals, lightmap and the existing index ordering with the surveyed mesh.
        span = SCANS[family]["span"]
        if span not in chart_cache:
            chart_cache[span] = model.attribute((surface_uv / span).astype("<f4"), "VEC2", 5126)
        if colour_attr is None:
            colour_attr = model.attribute(variation.astype("<f4"), "VEC3", 5126)
        new_attrs["TEXCOORD_0"] = chart_cache[span]
        new_attrs["COLOR_0"] = colour_attr
        new_prim = dict(prim, attributes=new_attrs, material=len(d["materials"]))
        id_type = d["accessors"][prim["indices"]]["componentType"]
        new_prim["indices"] = model.attribute(selected.ravel(), "SCALAR", id_type)
        d["materials"].append(mat)
        result.append(new_prim)
    return result


def bake(blob, buildings):
    model = Model(blob)
    for mesh in model.doc["meshes"]:
        updated = []
        for prim in mesh["primitives"]:
            source = model.doc["materials"][prim["material"]]
            if "baseColorTexture" in source["pbrMetallicRoughness"]:
                updated.append(prim)
            else:
                updated.extend(apply(model, prim, source, buildings))
        mesh["primitives"] = updated
    model.doc["asset"]["copyright"] += " Roof and masonry scans from Poly Haven (CC0)."
    return model.finish()


def dress_risers(blob):
    model = Model(blob)
    for mesh in model.doc["meshes"]:
        parts = []
        for prim in mesh["primitives"]:
            mat = model.doc["materials"][prim["material"]]
            if mat["name"] != "Merlion Park granite":
                parts.append(prim)
                continue
            normals = model.read(prim["attributes"]["NORMAL"], 3)
            points = model.read(prim["attributes"]["POSITION"], 3)
            faces = model.read(prim["indices"], 1).reshape(-1, 3)
            up = normals[faces, 1].mean(1)
            # Vertical faces of the stone courses. Short curved marker posts have smooth radial normals.
            flat = np.linalg.norm(np.ptp(normals[faces], axis=1), axis=1) < .02
            risers = (abs(up) < .24) & flat & (np.ptp(points[faces, 1], axis=1) > .02)
            if not risers.any():
                parts.append(prim)
                continue
            new_mat = copy.deepcopy(mat)
            new_mat["name"] = "Merlion Park dressed granite risers"
            pbr = new_mat["pbrMetallicRoughness"]
            pbr.update(baseColorTexture=model.texture("dressed-granite", "colour"),
                       metallicRoughnessTexture=model.texture("dressed-granite", "surface"),
                       metallicFactor=0., roughnessFactor=1.)
            new_mat["normalTexture"] = {**model.texture("dressed-granite", "normal"), "scale": .49}
            index = len(model.doc["materials"])
            model.doc["materials"].append(new_mat)
            component = model.doc["accessors"][prim["indices"]]["componentType"]
            for material_id, mask in [(prim["material"], ~risers), (index, risers)]:
                if mask.any():
                    parts.append(dict(prim, material=material_id,
                                      indices=model.attribute(faces[mask].ravel(), "SCALAR", component)))
        mesh["primitives"] = parts
    model.doc["asset"]["copyright"] = (model.doc["asset"].get("copyright", "") +
                                        " Granite Tile 02, Poly Haven (CC0).")
    return model.finish()


if __name__ == "__main__":
    records = ROOT / "build/streetscape.json"
    spec = json.loads((SOURCES / "residences.json").read_text())
    rows = json.loads(records.read_text())
    for row in rows:
        entry = spec.get(row["entityId"])
        if entry:
            source = ROOT / "assets" / (entry["source"] + ".glb")
            blob = bake(source.read_bytes(), entry["buildings"])
            digest = hashlib.sha256(blob).hexdigest()
            (ROOT / "assets" / (digest + ".glb")).write_bytes(blob)
            row["assetHash"] = digest
    records.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n")
