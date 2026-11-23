"""Open the two surveyed dining canopies in One Fullerton and furnish their decks."""

import argparse
import hashlib
import json
import math
import struct
from collections import defaultdict
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image, ImageDraw, ImageFilter
from scipy.interpolate import RegularGridInterpolator
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from fullerton_shopfront import GLASS as SHOP_GLASS, PHOTO as SHOP_PHOTO, shopfront, shopfront_patch
from fullerton_glazing import GLASS, PHOTO as GLAZING_PHOTO, glazing_patch
from fullerton_wicker import PHOTO as WICKER_PHOTO, cane_material, rounded_board, woven_chair
from fullerton_pendants import pendants

ROOT = Path(__file__).resolve().parents[1]
BUILDING = "bay.0c252ba3-f96a-4c82-b87b-fa5ef91708f2"
SOURCE_HASH = "051c63d6c1d2f890a01ce6d2e2872e025d1af2747818067ba9b75ffed936f6ee"
MIDDLE = "928bba087910672b69996dcd0a9eb38621bbf73c412f1d5c4b14ed9cf0b90a30"
CANONICAL_BUILDING = "97c6196a9b48ba761391e74d22ce10f5959fddca8f9f3d4e62a253f37a77a0d2"
PHOTO = "https://commons.wikimedia.org/wiki/File:One_Fullerton_12-05-2024(7).jpg"


def write_asset(data, folder):
    digest = hashlib.sha256(data).hexdigest()
    (folder / f"{digest}.glb").write_bytes(data)
    return digest


def open_shell(source, record, start, inland, along, output, middle):
    # Keep OneMap's original image data, materials and vertex buffers. Edit only one index buffer.
    raw = source.read_bytes()
    source_hash = hashlib.sha256(raw).hexdigest()
    if source_hash not in {SOURCE_HASH, CANONICAL_BUILDING, MIDDLE}:
        raise ValueError("Expected the surveyed One Fullerton source GLB")
    json_size = struct.unpack_from("<I", raw, 12)[0]
    doc = json.loads(raw[20:20 + json_size])
    binary = bytearray(raw[28 + json_size:])
    prim, = [pr for m in doc["meshes"] for pr in m["primitives"] if "TEXCOORD_0" in pr["attributes"]]

    def accessor_data(index, dtype):
        acc = doc["accessors"][index]
        view = doc["bufferViews"][acc["bufferView"]]
        offset = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        count = acc["count"] * {"VEC3": 3, "VEC2": 2, "SCALAR": 1}[acc["type"]]
        return np.frombuffer(binary, dtype, count=count, offset=offset)

    index = doc["accessors"][prim["indices"]]
    assert index["componentType"] == 5125
    faces = accessor_data(prim["indices"], "<u4").reshape(-1, 3)
    xyz = accessor_data(prim["attributes"]["POSITION"], "<f4").reshape(-1, 3)
    low, high = np.array([record["bounds"][axis] for axis in ("min", "max")])
    center = (low + high) / 2
    center[1] = low[1]
    delta = xyz + center - start
    local = np.column_stack((delta[:, [0, 2]] @ inland, delta[:, 1], delta[:, [0, 2]] @ along))
    tri = local[faces]
    min_corner, max_corner = tri.min(axis=1), tri.max(axis=1)
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    upright = ((min_corner[:, 1] < .06) & (max_corner[:, 1] > 2) &
               (np.abs(cross[:, 1]) < .02 * np.linalg.norm(cross, axis=1)))
    glazing = []
    shop_corners = None
    if middle:
        # The landward service wall stays in place. Open the path-facing and end walls of the awnings.
        remove = upright & (min_corner[:, 0] < 10.5)
        # Each row is a surveyed gable end, ordered waterside eave, ridge, landward eave.
        # The SHA check fixes the vertex numbering of this SLA tile.
        end_indices = [[[12, 18, 75], [6, 11, 25]], [[44, 34, 96], [50, 47, 89]]]
        canopy_ends = local[end_indices]
        remove |= min_corner[:, 1] > 2
        expected = 64
    else:
        remove = (upright & (min_corner[:, 2] > 10.5) & (max_corner[:, 2] < 56.5) &
                  (min_corner[:, 0] < 5) & (max_corner[:, 0] < 11.4))
        above_deck = ((min_corner[:, 1] > 1.8) & (max_corner[:, 1] < 5.2) &
                      (min_corner[:, 2] > 10) & (max_corner[:, 2] < 57) &
                      (min_corner[:, 0] < 10.9) & (max_corner[:, 0] < 12))
        remove |= above_deck
        uv = accessor_data(prim["attributes"]["TEXCOORD_0"], "<f4").reshape(-1, 2)
        image = doc["images"][0]
        view = doc["bufferViews"][image["bufferView"]]
        offset = view.get("byteOffset", 0)
        glass_faces, glazing = glazing_patch(local, faces, uv, binary[offset:offset + view["byteLength"]])
        remove |= glass_faces
        shop_faces, shop_corners = shopfront_patch(local, faces)
        remove |= shop_faces
        expected = 74
        # Locate the measured eaves in either encoding of the south building.
        surveyed = np.array([
            [[[4.74, 2.22, 10.74], [8.41, 3.34, 10.76], [11.07, 2.22, 10.77]],
             [[4.66, 2.22, 32.44], [8.33, 3.34, 32.43], [10.98, 2.22, 32.42]]],
            [[[3.11, 2.70, 32.44], [7.21, 4.01, 32.43], [11.17, 2.75, 32.42]],
             [[3.19, 2.70, 56.22], [7.29, 4.01, 56.20], [11.22, 2.75, 56.19]]],
        ])
        points = surveyed.reshape(-1, 3)
        distances = np.linalg.norm(local[None, :, :] - points[:, None, :], axis=2)
        if distances.min(axis=1).max() > .03:
            raise ValueError("Missing a surveyed south canopy endpoint")
        canopy_ends = local[distances.argmin(axis=1)].reshape(surveyed.shape)
    if remove.sum() != expected:
        raise ValueError("Unexpected count of removed survey triangles")
    kept = faces[~remove].copy()
    faces[:len(kept)] = kept
    index.update(count=int(kept.size), min=[int(kept.min())], max=[int(kept.max())])
    encoded = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    length = 28 + len(encoded) + len(binary)
    packed = (struct.pack("<4sIII4s", b"glTF", 2, length, len(encoded), b"JSON") + encoded +
              struct.pack("<I4s", len(binary), b"BIN\0") + binary)
    record["assetHash"] = write_asset(packed, output)
    props = record["props"]
    props["三角形数"] = sum(doc["accessors"][pr["indices"]]["count"] // 3
                         for m in doc["meshes"] for pr in m["primitives"])
    props["原建筑资源"] = source_hash
    props["露台重建"] = ("保留陆侧服务墙，按 OneMap 屋脊与檐口控制点重建中段两座雨棚。"
                     if middle else "南段雨棚依 OneMap 檐口和屋脊重建。保留后方立面、屋顶和主体轮廓。")
    props["露台参考"] = PHOTO
    return canopy_ends, glazing, shop_corners


def box(extents, center):
    mesh = trimesh.creation.box(extents)
    mesh.apply_translation(center)
    return mesh


def strut(a, b, radius, sides=8):
    return trimesh.creation.cylinder(radius=radius, segment=[a, b], sections=sides)


def chair():
    # One bent back, one seat and four slightly splayed legs fit below an outdoor table.
    pieces = defaultdict(list)
    pieces["Teak"].append(box([0.43, 0.045, 0.42], [0, 0.44, 0]))
    for x in [-0.18, 0.18]:
        for z in [-0.16, 0.16]:
            pieces["Metal"].append(strut([x * 1.15, 0.01, z * 1.22], [x, 0.435, z], 0.017, 6))
        pieces["Metal"].append(strut([x, 0.44, 0.16], [x * 1.13, 0.81, 0.235], 0.017, 6))
    # Curving horizontal slats keep the back readable in silhouette and let daylight through.
    for y in [0.60, 0.69, 0.78]:
        points = [(-0.205, 0.18), (-0.1, 0.218), (0, 0.23), (0.1, 0.218), (0.205, 0.18)]
        for (x1, z1), (x2, z2) in zip(points, points[1:]):
            slat = box([math.hypot(x2 - x1, z2 - z1), 0.056, 0.024], [0, 0, 0])
            slat.apply_transform(trimesh.transformations.rotation_matrix(-math.atan2(z2 - z1, x2 - x1), [0, 1, 0]))
            slat.apply_translation([(x2 + x1) / 2, y, (z2 + z1) / 2])
            pieces["Teak"].append(slat)
    return {name: trimesh.util.concatenate(meshes) for name, meshes in pieces.items()}


def canvas_tile():
    # One 1.15 m bolt of fabric with a lapped seam and two rows of stitching.
    y, x = np.indices((256, 256))
    warp = np.cos(x * math.tau / 4)
    weft = np.cos(y * math.tau / 4)
    value = 242 + 2 * warp + 2 * weft + 1.5 * warp * weft
    value[:, :5] -= 14
    value[:, 5:7] += 7
    for line in [1, 4]:
        value[:, line] += 10 * (y[:, line] % 8 < 4)
    image = Image.fromarray(np.uint8(value)).convert("RGB")
    image.format = "PNG"
    return image


def fit_canvas(ends, bays, fabric, frame, post_edge, deck):
    # Interpolate within each surveyed slope. The cloth is taut at rafters and
    # at the ridge, with a small drop midway between supports.
    first, last = ends
    for side in [0, 2]:
        if fabric is not None:
            vertices, faces = [], []
            for row in range(8 * bays + 1):
                t = row / (8 * bays)
                eave, ridge = (first + t * (last - first))[[side, 1]]
                droop = .082 * math.sin(row * math.pi / 8) ** 2
                # The turned-down hem sits over the edge rail.
                vertices.extend([eave - [0, .13 + droop * .17, 0], eave])
                for u in [.25, .5, .75, 1.]:
                    point = eave + u * (ridge - eave)
                    point[1] -= droop * math.sin(math.pi * u)
                    vertices.append(point)
                if row:
                    for col in range(5):
                        i = 6 * (row - 1) + col
                        faces.extend([[i, i + 6, i + 1], [i + 6, i + 7, i + 1]])
            if side == 2:
                faces = np.array(faces)[:, ::-1]
            fabric.append(trimesh.Trimesh(vertices=vertices, faces=faces, process=False))
        offset = [0, .052, 0]
        frame.append(strut(first[side] - offset, last[side] - offset, .034))
        for t in np.linspace(.012, .988, bays + 1):
            eave, ridge = (first + t * (last - first))[[side, 1]]
            frame.append(strut(eave - offset, ridge - offset, .035))
            post_x = max(eave[0] + .11, post_edge + .11) if side == 0 else eave[0] - .15
            post = eave + (ridge - eave) * ((post_x - eave[0]) / (ridge[0] - eave[0]))
            post -= offset
            frame.append(box([.065, post[1] - deck, .065], [post[0], (post[1] + deck) / 2, post[2]]))
    frame.append(strut(first[1] - [0, .052, 0], last[1] - [0, .052, 0], .034))


def roof_panels(ends, pieces):
    # The orthophoto resolves four large bays and a continuous pale ridge band.
    # Cover strips meet the infill edge-to-edge on each surveyed roof plane.
    ts = [0, .009, .245, .255, .495, .505, .745, .755, .991, 1]
    us = [0, .055, .79, 1]
    for side in [0, 2]:
        for row, (t0, t1) in enumerate(zip(ts, ts[1:])):
            for col, (u0, u1) in enumerate(zip(us, us[1:])):
                verts = []
                for t in [t0, t1]:
                    eave, ridge = (ends[0] + t * (ends[1] - ends[0]))[[side, 1]]
                    verts.extend([eave + u * (ridge - eave) for u in [u0, u1]])
                faces = np.array([[0, 2, 1], [2, 3, 1]])
                if side == 2:
                    faces = faces[:, ::-1]
                name = "Pale roof trim" if row % 2 == 0 or col != 1 else "Roof infill"
                pieces[name].append(trimesh.Trimesh(vertices=verts, faces=faces, process=False))
        a, b = ends[:, side]
        pieces["Pale roof trim"].append(strut(a - [0, .047, 0], b - [0, .047, 0], .049))


def deck_occlusion(pieces, canopy_ends):
    # Project the opaque silhouettes onto the deck from cosine-weighted sky
    # directions. Only indirect light uses this map. The sun still casts live shadows.
    deck = trimesh.util.concatenate(pieces["Deck"])
    low, high = deck.bounds[:, [0, 2]]
    padding = .1
    low, high = low - padding, high + padding
    size = (320, 768)
    scale = (np.array(size) - 1) / (high - low)
    triangles = [mesh.triangles for name, meshes in pieces.items() if name != "Deck" for mesh in meshes]
    for first, last in canopy_ends:
        top = np.array([first[2], last[2]])
        bottom = top.copy()
        bottom[:, 1] = 0
        triangles.append(np.array([[top[0], top[1], bottom[0]], [top[1], bottom[1], bottom[0]]]))
    triangles = np.concatenate(triangles)
    # Discard surfaces fully below the receiving plane.
    floor = deck.bounds[1, 1]
    triangles = triangles[triangles[:, :, 1].max(axis=1) > floor + .005]
    planar = (triangles[:, :, [0, 2]] - low) * scale
    height = np.maximum(triangles[:, :, 1:2] - floor, 0)
    blocked = np.zeros(size[::-1], np.float32)
    samples = 128
    for i in range(samples):
        u = (i + .5) / samples
        angle = math.pi * (3 - math.sqrt(5)) * i
        slope = math.sqrt(u / (1 - u)) * np.array([math.cos(angle), math.sin(angle)])
        projected = (planar - height * slope * scale).round().astype(np.int32)
        mask = Image.new("L", size)
        draw = ImageDraw.Draw(mask)
        for triangle in projected.reshape(-1, 6).tolist():
            draw.polygon(triangle, fill=1)
        blocked += np.asarray(mask)
    # Allow some secondary bounce from the surrounding wood and pale pavement.
    image = Image.fromarray(np.uint8(255 * (1 - .68 * blocked / samples)))
    image = image.filter(ImageFilter.GaussianBlur(.8))
    image.format = "JPEG"
    return image, low, high


def set_deck_uv_channel(tree):
    for material in tree["materials"]:
        if "occlusionTexture" in material and material["name"] in {
            "Deck boards", "Woven dining cane", "Outdoor timber", "Painted steel", "Sheltered teak tabletops"
        }:
            material["occlusionTexture"]["texCoord"] = 1
        if material["name"] == "Sheltered teak tabletops":
            material["extras"] = {"prefilteredReflection": True}
        if material["name"] in {GLASS, SHOP_GLASS}:
            material["extras"] = {"reflectSky": True, "surfaceRole": "facade"}
        if material["name"] == SHOP_GLASS:
            material["extras"]["facadeProbes"] = {
                "span": 17.274, "height": 2.50, "eyeHeight": 1.36,
                "first": 2.40, "spacing": 6.24, "count": 3, "depth": 7.4,
            }
    for mesh in tree["meshes"]:
        for primitive in mesh["primitives"]:
            attrs = primitive["attributes"]
            if "_AO_UV" in attrs:
                attrs["TEXCOORD_1"] = attrs.pop("_AO_UV")


def furniture_occlusion(canopies):
    """Estimate diffuse sky visibility at furniture height under the measured awnings."""
    points = canopies.reshape(-1, 3)
    axes = [np.linspace(points[:, 0].min() - 1, points[:, 0].max() + 1, 22),
            np.linspace(0, 1.15, 5),
            np.linspace(points[:, 2].min() - 1, points[:, 2].max() + 1, 85)]
    samples = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1).reshape(-1, 3)
    faces = []
    for first, last in canopies:
        for a, b, c, d in [(first[0], first[1], last[1], last[0]),
                           (first[1], first[2], last[2], last[1]),
                           (first[2], last[2], last[2] * [1, 0, 1], first[2] * [1, 0, 1])]:
            faces.extend([(a, b, c), (a, c, d)])
    count = 96
    occluded = np.zeros(len(samples))
    for i in range(count):
        u = (i + .5) / count
        angle = i * math.pi * (3 - math.sqrt(5))
        ray = np.array([math.sqrt(u) * math.cos(angle), math.sqrt(1-u), math.sqrt(u) * math.sin(angle)])
        blocked = np.zeros(len(samples), dtype=bool)
        for a, b, c in faces:
            edge, side = b - a, c - a
            p = np.cross(ray, side)
            det = p @ edge
            if abs(det) < 1e-8:
                continue
            delta = samples - a
            q = np.cross(delta, edge)
            s, t = delta @ p / det, q @ ray / det
            blocked |= (s >= 0) & (t >= 0) & (s + t <= 1) & (q @ side / det > 0)
        occluded += blocked
    # Retain diffuse bounce from the bay-facing paving and timber deck.
    visibility = (1 - .73 * occluded / count).reshape(*(len(axis) for axis in axes))
    return RegularGridInterpolator(axes, visibility, bounds_error=False, fill_value=1)


def furnish(start, along, inland, texture_path, output, region_id, canopy_ends, glazing, shop_corners, middle):
    pieces = defaultdict(list)
    timber_chair = chair()
    cane_chair = None if middle else woven_chair(strut)
    rng = np.random.default_rng(512)
    # Eave and ridge elevations are from the SLA mesh. Keep the middle deck behind the promenade.
    sections = (
        [(66.40, 77.52, 4.64, 11.12),
         (77.76, 85.33, 2.26, 11.44)]
        if middle else
        [(10.85, 32.32, 4.75, 11.02),
         (32.48, 56.12, 3.21, 11.13)]
    )
    for section, (z0, z1, outer_eave, x1) in enumerate(sections):
        wicker = not middle and section == 1
        prototype = cane_chair if wicker else timber_chair
        x0 = max(outer_eave, 3.67) if middle else outer_eave
        length = z1 - z0
        deck = 0.15
        pieces["Deck"].append(box([x1 - x0, deck - .018, length],
                                   [(x0 + x1) / 2, (deck - .018) / 2, (z0 + z1) / 2]))
        boards = round((x1 - x0) / .15)
        width = (x1 - x0) / boards
        for i in range(boards):
            pieces["Deck"].append(box([width - .004, .018, length],
                                      [x0 + (i + .5) * width, deck - .009, (z0 + z1) / 2]))
        bays = round(length / 3.6)
        if middle:
            fabric = pieces["Burgundy" if section else "Green"]
        elif section == 0:
            fabric = pieces["Charcoal"]
        else:
            roof_panels(canopy_ends[section], pieces)
            fabric = None
            bays = 4
        fit_canvas(canopy_ends[section], bays, fabric, pieces["Canopy frame"], x0, deck)
        # The low timber apron and actual eaves delimit the terrace along the waterside path.
        pieces["Teak"].append(box([0.10, 0.31, length], [x0 + 0.05, deck + 0.155, (z0 + z1) / 2]))
        for z in np.arange(z0 + 1.4, z1 - 0.9, 2.6):
            for x in [x0 + 1.15, x1 - 1.2]:
                offset = rng.uniform(-0.1, 0.1)
                if middle:
                    top = trimesh.creation.cylinder(radius=.42, height=.045, sections=24)
                    top.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0]))
                    top.apply_translation([x, deck + .74, z + offset])
                    pieces["Teak"].append(top)
                elif wicker:
                    pieces["Dining tables"].append(rounded_board(.83, .73, .042, .033, .005, [x, deck + .74, z + offset]))
                else:
                    pieces["Teak"].append(box([0.83, 0.045, 0.73], [x, deck + 0.74, z + offset]))
                pieces["Metal"].append(strut([x, deck + .04, z + offset], [x, deck + .73, z + offset], .041))
                pieces["Metal"].append(box([.49, .035, .44], [x, deck + .025, z + offset]))
                for sign in [-1, 1]:
                    angle = (0 if sign == 1 else math.pi) + rng.uniform(-.19, .19)
                    move = trimesh.transformations.rotation_matrix(angle, [0, 1, 0])
                    move[:3, 3] = [x + rng.uniform(-.10, .10), deck, z + offset + sign * rng.uniform(.53, .68)]
                    for name, source in prototype.items():
                        placed = source.copy()
                        placed.apply_transform(move)
                        pieces[name].append(placed)

    timber = Image.open(texture_path).convert("RGB").resize((512, 512), Image.Resampling.LANCZOS)
    timber.format = "JPEG"
    materials = {
        "Pale roof trim": PBRMaterial(name="Pale roof trim", baseColorFactor=[185, 182, 167, 255],
                                     doubleSided=True, metallicFactor=.13, roughnessFactor=.52),
        "Roof infill": PBRMaterial(name="Coated roof panels", baseColorFactor=[114, 107, 91, 255],
                                  doubleSided=True, metallicFactor=.06, roughnessFactor=.63),
        "Metal": PBRMaterial(name="Painted steel", baseColorFactor=[40, 43, 44, 255], metallicFactor=.43, roughnessFactor=.57),
        "Canopy frame": PBRMaterial(name="Grey aluminium", baseColorFactor=[106, 111, 106, 255], metallicFactor=.52, roughnessFactor=.49),
        "Deck": PBRMaterial(name="Deck boards", baseColorTexture=timber, baseColorFactor=[103, 98, 94, 255], metallicFactor=0, roughnessFactor=.83),
        "Teak": PBRMaterial(name="Outdoor timber", baseColorTexture=timber, baseColorFactor=[183, 169, 150, 255], metallicFactor=0, roughnessFactor=.66),
    }
    textile = canvas_tile()
    if "Dining tables" in pieces:
        # The tables under the pale canopy receive broad reflections of its underside and the quay.
        refs = ROOT / "references"
        grain = Image.open(refs / "teak-veneer-normal.png")
        rough = Image.open(refs / "teak-veneer-roughness.png")
        packed = Image.merge("RGB", (Image.new("L", rough.size, 255), rough, Image.new("L", rough.size)))
        packed.format = "PNG"
        materials["Dining tables"] = PBRMaterial(
            name="Sheltered teak tabletops", baseColorTexture=timber,
            baseColorFactor=[183, 169, 150, 255], metallicFactor=0, roughnessFactor=1,
            normalTexture=grain, metallicRoughnessTexture=packed,
            emissiveTexture=Image.open(refs / "fullerton-sheltered-timber.jpg"),
            emissiveFactor=[0, 0, 0],
        )
    if "Cane" in pieces:
        materials["Cane"] = cane_material()
        shelter = furniture_occlusion(canopy_ends)
        ramp = Image.fromarray(np.arange(256, dtype=np.uint8)[None, :]).convert("RGB")
        ramp.format = "PNG"
        for name in ("Cane", "Teak", "Metal", "Dining tables"):
            materials[name].occlusionTexture = ramp
    texture, deck_min, deck_max = deck_occlusion(pieces, canopy_ends)
    materials["Deck"].occlusionTexture = texture
    for name, color in [("Green", [23, 54, 39, 255]), ("Burgundy", [100, 25, 35, 255]),
                        ("Charcoal", [26, 29, 31, 255])]:
        if name in pieces:
            materials[name] = PBRMaterial(name=name + " canvas", baseColorFactor=color, baseColorTexture=textile, doubleSided=True,
                                          metallicFactor=0, roughnessFactor=.96)
    scene = trimesh.Scene()
    for name, meshes in pieces.items():
        m = trimesh.util.concatenate(meshes)
        if name in {"Teak", "Deck", "Canopy frame", "Dining tables"}:
            # Split at actual panel edges so thin boards do not acquire rounded, inflated normals.
            m = trimesh.Trimesh(vertices=m.vertices[m.faces].reshape(-1, 3),
                                faces=np.arange(m.faces.size).reshape(-1, 3), process=False)
            m.vertex_normals = np.repeat(m.face_normals, 3, axis=0)
            m.merge_vertices(merge_norm=False)
        xyz = m.vertices.copy()
        if name == "Deck":
            # Custom attributes pass through trimesh without its first-channel V flip.
            m.vertex_attributes["_AO_UV"] = (xyz[:, [0, 2]] - deck_min) / (deck_max - deck_min)
        elif not middle and name in {"Cane", "Teak", "Metal", "Dining tables"}:
            visibility = shelter(xyz)
            m.vertex_attributes["_AO_UV"] = np.column_stack([(visibility * 255 + .5) / 256,
                                                             np.full(len(xyz), .5)])
        # The photo sample's grain runs across U. Use metric coordinates on the broad faces.
        uv = np.column_stack((xyz[:, 2] / 1.6, (xyz[:, 0] + xyz[:, 1]) / 1.15))
        if name == "Cane":
            uv = np.concatenate([mesh.vertex_attributes["_CANE_UV"] for mesh in meshes])
            m.vertex_attributes.pop("_CANE_UV", None)
        if name in {"Burgundy", "Green", "Charcoal"}:
            uv = np.column_stack((xyz[:, 2] / 1.15, xyz[:, 0] + xyz[:, 1] * .35))
        m.visual = TextureVisuals(uv=uv, material=materials[name])
        scene.add_geometry(m, geom_name=name, node_name=name)
    if shop_corners is not None:
        stone_hash = json.loads((ROOT / "context.json").read_text())["quay"]["granite"]["color"]
        glazing.extend(shopfront(shop_corners, timber, ROOT / "assets" / (stone_hash + ".webp")))
    for mesh in glazing:
        scene.add_geometry(mesh, geom_name=mesh.visual.material.name, node_name=mesh.visual.material.name)
    for m in scene.geometry.values():
        xyz = m.vertices.copy()
        m.vertices[:, 0] = start[0] + inland[0] * xyz[:, 0] + along[0] * xyz[:, 2]
        m.vertices[:, 2] = start[2] + inland[1] * xyz[:, 0] + along[1] * xyz[:, 2]
        m.vertices[:, 1] = start[1] + xyz[:, 1]
    low, high = scene.bounds
    anchor = (low + high) / 2
    anchor[1] = low[1]
    for mesh in scene.geometry.values():
        mesh.vertices -= anchor
    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True,
                                            tree_postprocessor=set_deck_uv_channel)
    return dict(entityId="bay.fullerton-middle-terraces" if middle else "bay.fullerton-dining-terraces", regionId=region_id, layer="ext", kind="structure",
                label="One Fullerton · 中段临水茶座" if middle else "One Fullerton · 临水餐饮露台", assetHash=write_asset(data, output),
                bounds={"min": low.tolist(), "max": high.tolist()}, material={"shading": "albedo"},
                props={"background": True, "surfaceRole": "landscape", "现场参考": PHOTO,
                       "建筑来源": "Map Data © Singapore Land Authority / OneMap",
                       "木材来源": "Teak Veneer · Poly Haven · CC0 · https://polyhaven.com/a/teak_veneer",
                       "说明": "沿 OneMap 两段既有双坡棚顶配设支架、矮边和用餐区。桌椅样式、数量与排列为视觉近似。"})


def pendant_entity(ends, start, along, inland, output, region):
    mesh = pendants(ends)
    xyz = mesh.vertices.copy()
    mesh.vertices[:, 0] = start[0] + inland[0] * xyz[:, 0] + along[0] * xyz[:, 2]
    mesh.vertices[:, 2] = start[2] + inland[1] * xyz[:, 0] + along[1] * xyz[:, 2]
    mesh.vertices[:, 1] = start[1] + xyz[:, 1]
    low, high = mesh.bounds
    focus = (low + high) / 2
    center = [focus[0], low[1], focus[2]]
    mesh.apply_translation(-np.asarray(center))
    scene = trimesh.Scene()
    scene.add_geometry(mesh, geom_name="Woven pendants", node_name="Woven pendants")
    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True)
    return dict(entityId="bay.fullerton-woven-pendants", layer="ext", kind="object",
                regionId=region, label="浮尔顿露台 · 编织吊灯", assetHash=write_asset(data, output),
                bounds={"min":low.tolist(),"max":high.tolist()}, material={"shading":"albedo"},
                props={"background":True,"现场参考":WICKER_PHOTO,
                       "建筑来源":"Map Data © Singapore Land Authority / OneMap",
                       "backgroundView":{"focus":focus.tolist(),"maxDistance":180},
                       "吊灯":"根据 2024 年现场晚间照片重建编织灯罩。吊绳按实测坡面收顶，两排共 14 盏的位置、尺寸和日间灯芯亮度为估值。"})


def bake(source, timber, output, buildings_file, streetscape_file):
    config = json.loads((ROOT / "context.json").read_text())
    buildings = json.loads(buildings_file.read_text())
    middle = hashlib.sha256(source.read_bytes()).hexdigest() == MIDDLE
    if middle:
        building = next(b for b in buildings if b["assetHash"] == MIDDLE or b["props"].get("原建筑资源") == MIDDLE)
    else:
        building = next(b for b in buildings if b["entityId"] == BUILDING)
    start = np.array(config["quay"]["start"])
    along = (np.array(config["quay"]["end"]) - start)[[0, 2]]
    along /= np.linalg.norm(along)
    inland = along[[1, 0]] * [1, -1]
    ends, glazing, shop_corners = open_shell(source, building, start, inland, along, output, middle)
    furniture = furnish(start, along, inland, timber, output, building["regionId"], ends, glazing, shop_corners, middle)
    if middle:
        furniture["props"]["棚顶"] = "屋脊和檐口坐标取自 SLA 原模型。帆布颜色参照现场照片，分幅、垂度与棚架尺寸为估值。"
    else:
        furniture["props"]["桌面木纹"] = "颜色、法线与粗糙度取自 Poly Haven 的 CC0 Teak Veneer。同一浅棚下两个桌高机位的线性辐射亮度按粗糙度 0.65 预过滤，用于日间宽高光。"
        furniture["props"]["藤椅参考"] = WICKER_PHOTO
        furniture["props"]["藤椅"] = "浅色雨棚下的编织靠背、扶手和细金属椅脚参照现场照片。藤条宽度、桌边倒角和排布为估值。"
        furniture["props"]["庭院店面参考"] = SHOP_PHOTO
        furniture["props"]["庭院店面"] = "沿 OneMap 约 17.3 米的一层墙线重建。柱、门框、内退玻璃和檐下空间参照街景照片，分隔、进深及室内陈设为估值。"
        furniture["props"]["入口玻璃倒影"] = "在窗前沿线三个机位采集庭院、树池和海湾，反射随视线与玻璃位置变化。采集反映场景当前的日间布置。"
        furniture["props"]["幕墙参考"] = GLAZING_PHOTO
        furniture["props"]["幕墙"] = "二层五个窗面沿折线合计约 52 米，采用 OneMap 原始立面和影像。主窗框按影像配准，框深、颜色和反射强度为估值。"
        furniture["props"]["棚顶"] = "两座棚体的坡面采用 SLA 实测坐标。深浅表面、浅棚的四段横框和屋脊色带参照正射影像。材料和构件厚度为估值。"
    streetscape = {item["entityId"]: item for item in json.loads(streetscape_file.read_text())}
    streetscape[furniture["entityId"]] = furniture
    if not middle:
        lights = pendant_entity(ends[1], start, along, inland, output, building["regionId"])
        streetscape[lights["entityId"]] = lights
    streetscape = list(streetscape.values())
    for file, value in [(buildings_file, buildings), (streetscape_file, streetscape)]:
        file.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    print(building["assetHash"], furniture["assetHash"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Original OneMap building GLB")
    parser.add_argument("timber", type=Path, help="teak_veneer_diff_1k.jpg")
    parser.add_argument("--assets", type=Path, default=ROOT / "assets")
    parser.add_argument("--buildings", type=Path, default=ROOT / "build/onemap-entities.json")
    parser.add_argument("--streetscape", type=Path, default=ROOT / "build/streetscape.json")
    args = parser.parse_args()
    bake(args.source, args.timber, args.assets, args.buildings, args.streetscape)
