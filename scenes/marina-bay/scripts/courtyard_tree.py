"""Bake Poly Haven's Island Tree 01 (1k glTF) into a detailed trunk and small cutout clusters."""

import hashlib
import json
import math
import subprocess
from pathlib import Path

import numpy as np
import trimesh
from scipy.optimize import brentq
from scipy.spatial import ConvexHull
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals


def load_tree(folder, leaf_mask=None, bark_budget=None):
    raw = (folder / "island_tree_01_1k.gltf").read_bytes()
    if hashlib.sha256(raw).hexdigest() != "78e905a40670bfabb2760601d4d9a6c17193a50d68e6271c66893eb7bd75906d":
        raise ValueError("Expected Poly Haven Island Tree 01, 1k glTF")
    doc = json.loads(raw)
    binary = (folder / doc["buffers"][0]["uri"]).read_bytes()

    def read(index):
        accessor = doc["accessors"][index]
        view = doc["bufferViews"][accessor["bufferView"]]
        width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[accessor["type"]]
        dtype = {5126: "<f4", 5125: "<u4", 5123: "<u2"}[accessor["componentType"]]
        offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        return np.frombuffer(binary, dtype, accessor["count"] * width, offset).reshape(-1, width)

    parts = []
    for primitive in doc["meshes"][0]["primitives"]:
        attrs = primitive["attributes"]
        material = doc["materials"][primitive["material"]]
        texture = material["pbrMetallicRoughness"]["baseColorTexture"]
        source = doc["textures"][texture["index"]]["source"]
        image = Image.open(folder / doc["images"][source]["uri"]).convert("RGB")
        transform = texture.get("extensions", {}).get("KHR_texture_transform", {})
        uv = read(attrs["TEXCOORD_0"]) * transform.get("scale", [1, 1]) + transform.get("offset", [0, 0])
        parts.append((read(attrs["POSITION"]), read(primitive["indices"]).reshape(-1, 3), uv,
                      read(attrs["NORMAL"]), image))
    bark = simplify_trunk(parts[0], keep_source_edges=bark_budget is not None)
    if bark_budget is not None:
        bark = compact_bark(bark, bark_budget, lock_border=True)
    return bark, bake_crown(parts[1:], leaf_mask)


def simplify_trunk(part, keep_source_edges=False):
    xyz, indices, uv, normals, texture = part
    if keep_source_edges:
        faces = indices
    else:
        # Retain distinct texture islands when snapping nearby trunk vertices.
        keys = np.column_stack((np.floor(xyz / .088), np.floor(uv * 7))).astype(np.int32)
        _, kept, remap = np.unique(keys, axis=0, return_index=True, return_inverse=True)
        faces = remap[indices]
        distinct = ((faces[:, 0] != faces[:, 1]) & (faces[:, 0] != faces[:, 2]) & (faces[:, 1] != faces[:, 2]))
        faces = faces[distinct]
        xyz, normals, uv = xyz[kept], normals[kept], uv[kept]
    texture = texture.resize((512, 512), Image.Resampling.LANCZOS)
    texture.format = "JPEG"
    material = PBRMaterial(name="Island tree bark", baseColorTexture=texture, metallicFactor=0, roughnessFactor=.93)
    mesh = trimesh.Trimesh(vertices=xyz, faces=faces, vertex_normals=normals,
                           visual=TextureVisuals(uv=uv * [1, -1] + [0, 1], material=material), process=False)
    mesh.update_faces(mesh.nondegenerate_faces(height=1e-6))
    mesh.remove_unreferenced_vertices()
    return mesh


def foliage_tile(polygons, shades, basis, size, samples=None):
    plane = polygons @ basis.T
    low, high = plane.min(axis=(0, 1)), plane.max(axis=(0, 1))
    low[:2] -= .035
    high[:2] += .035
    pixels = (plane[:, :, :2] - low[:2]) / (high[:2] - low[:2]) * (size - 1)
    pixels[:, :, 1] = size - 1 - pixels[:, :, 1]
    if samples is not None:
        from leaf_atlas import render_tile
        image = render_tile(pixels, plane[:, :, 2], *samples, size)
    else:
        order = np.argsort(plane[:, :, 2].mean(axis=1))
        image = Image.new("RGBA", (size, size))
        draw = ImageDraw.Draw(image)
        for points, color in zip(np.rint(pixels[order]).astype(int).reshape(-1, 6).tolist(), shades[order].tolist()):
            draw.polygon(points, fill=(*color, 255))
    # Extend leaf colour into transparent texels for browser mip generation.
    rgba = np.array(image)
    nearest = distance_transform_edt(rgba[:, :, 3] == 0, return_distances=False, return_indices=True)
    rgba[:, :, :3] = rgba[tuple(nearest)][:, :, :3]
    depth = np.median(plane[:, :, 2])
    quad = [[low[0], low[1], depth], [high[0], low[1], depth],
            [high[0], high[1], depth], [low[0], high[1], depth]]
    return Image.fromarray(rgba), quad @ basis


def bake_crown(parts, leaf_mask=None):
    triangles, colors = [], []
    source_uv, face_materials, textures = [], [], []
    for index, (xyz, faces, uv, normals, texture) in enumerate(parts):
        triangles.append(xyz[faces])
        if leaf_mask is not None:
            source_uv.append(uv[faces])
            face_materials.append(np.full(len(faces), index, np.uint8))
            bitmap = texture.convert("RGBA")
            if index == 0:
                bitmap.putalpha(leaf_mask)
            textures.append(np.asarray(bitmap))
        else:
            px = ((uv[faces].mean(axis=1) % 1.) * texture.size).astype(int)
            rgb = np.asarray(texture)[px[:, 1], px[:, 0]].astype(np.float32)
            if index == 0:
                rgb *= (.90 + .13 * np.abs(normals[faces].mean(axis=1)[:, 1]))[:, None]
            colors.append(rgb)
    triangles = np.concatenate(triangles)
    colors = np.uint8(np.clip(np.concatenate(colors), 0, 255)) if colors else None
    centers = triangles.mean(axis=1)
    grid = np.floor((centers - centers.min(axis=0)) / .96).astype(int)
    cell = np.ravel_multi_index(grid.T, tuple(grid.max(axis=0) + 1))
    order = np.argsort(cell, kind="stable")
    groups = [idx for idx in np.split(order, np.flatnonzero(np.diff(cell[order])) + 1) if len(idx) > 120]
    if leaf_mask is not None:
        source_uv = np.concatenate(source_uv)
        face_materials = np.concatenate(face_materials)
    tile = 96 if leaf_mask is not None else 80
    columns = math.ceil(math.sqrt(len(groups) * 3))
    atlas = Image.new("RGBA", (columns * tile, columns * tile))
    vertices, faces, texcoords, normals = [], [], [], []
    for group, indices in enumerate(groups):
        for angle, elevation in [(0, 0), (math.pi / 3, .46), (2 * math.pi / 3, -.59)]:
            azimuth = group * .73 + angle
            side = np.array([math.cos(azimuth), 0, math.sin(azimuth)])
            forward = np.array([-math.sin(azimuth) * math.cos(elevation), math.sin(elevation),
                                math.cos(azimuth) * math.cos(elevation)])
            basis = np.array([side, np.cross(forward, side), forward])
            samples = (source_uv[indices], face_materials[indices], textures) if leaf_mask is not None else None
            shades = colors[indices] if colors is not None else None
            image, quad = foliage_tile(triangles[indices], shades, basis, tile, samples)
            start = len(vertices)
            row, column = divmod(start // 4, columns)
            atlas.paste(image, (column * tile, row * tile))
            vertices.extend(quad)
            faces.extend([[start, start + 1, start + 2], [start, start + 2, start + 3]])
            texcoords.extend([[(column + u) / columns, 1 - (row + 1 - v) / columns]
                              for u, v in [(0, 0), (1, 0), (1, 1), (0, 1)]])
            # Leaf clusters share the crown's rounded light response when viewed from the side.
            radial = quad - [0, 2.8, 0]
            radial[:, 1] = np.maximum(radial[:, 1], .45)
            normals.extend(radial / np.linalg.norm(radial, axis=1)[:, None])
    # Use four opacity levels for the resolved sample coverage. Legacy
    # polygon-coloured clusters need only the two original cutout states.
    levels = 4 if leaf_mask is not None else 2
    count = 256 // levels
    opacity = np.rint(np.asarray(atlas.getchannel("A"), dtype=float) * (levels - 1) / 255).astype(np.uint8)
    colors = atlas.convert("RGB").quantize(colors=count, method=Image.Quantize.MEDIANCUT)
    indices = np.uint8(np.asarray(colors) + opacity * count)
    atlas = Image.frombytes("P", atlas.size, indices.tobytes())
    palette = colors.getpalette()[:3 * count]
    atlas.putpalette(palette * levels)
    atlas.info["transparency"] = bytes(a for a in np.linspace(0, 255, levels).astype(int) for _ in range(count))
    atlas.format = "PNG"
    material = PBRMaterial(name="Island tree branch clusters", baseColorTexture=atlas, doubleSided=True,
                           metallicFactor=0, roughnessFactor=.94, alphaMode="MASK", alphaCutoff=.48)
    return trimesh.Trimesh(vertices=vertices, faces=faces, vertex_normals=normals,
                           visual=TextureVisuals(uv=texcoords, material=material), process=False)


def compact_bark(mesh, target_triangles=420, lock_border=False, max_error=None):
    source = {"targetTriangles": target_triangles, "lockBorder": lock_border,
              "faces": mesh.faces.ravel().tolist(), "position": mesh.vertices.ravel().tolist(),
              "attributes": np.column_stack((mesh.vertex_normals, mesh.visual.uv)).ravel().tolist()}
    if max_error is not None:
        source["maxError"] = max_error
    result = subprocess.run(["node", str(Path(__file__).with_name("simplify-skypark-tree.mjs"))],
                            input=json.dumps(source), text=True, capture_output=True, check=True)
    faces = np.asarray(json.loads(result.stdout)).reshape(-1, 3)
    vertices, inverse = np.unique(faces, return_inverse=True)
    material = mesh.visual.material
    image = material.baseColorTexture.convert("RGB").resize((384, 384), Image.Resampling.LANCZOS)
    image.format = "JPEG"
    material.baseColorTexture = image
    return trimesh.Trimesh(vertices=mesh.vertices[vertices], faces=inverse.reshape(-1, 3),
                            vertex_normals=mesh.vertex_normals[vertices],
                            visual=TextureVisuals(uv=mesh.visual.uv[vertices], material=material), process=False)


def load_masked_tree(folder):
    mask = folder / "textures/island_tree_01_leaves_alpha_1k.png"
    if hashlib.sha256(mask.read_bytes()).hexdigest() != "f4341f147988dbe6b58d9ca841a8f0e4bcff25bc40d05f9877da82006d489c39":
        raise ValueError("Expected the original 1k Island Tree 01 leaf opacity map")
    with Image.open(mask) as source:
        raw = np.asarray(source)
        leaf_mask = Image.fromarray(np.uint8(raw.astype(float) * (255 / np.iinfo(raw.dtype).max))).convert("L")
    return load_tree(folder, leaf_mask, bark_budget=850)


def fit_crown(bark, leaves, height, girth, angle, foot_position, lo, hi, compass):
    """Fit a scanned specimen to measured crown extents in the supplied horizontal frame."""
    bottom = bark.bounds[0, 1]
    foot = bark.vertices[bark.vertices[:, 1] < bottom + .08].mean(axis=0)
    foot[1] = bottom
    top = leaves.bounds[1, 1] - bottom
    # Match estimated breast-height circumference before the first branch.
    # Lift the lowest branches of the compact source specimen onto a clear stem.
    vertical = height / top
    lift = .53
    def relative_height(h):
        return h + lift * h * (1 - h) * (2 - h)

    breast = top * brentq(lambda h: height * relative_height(h) - 1.3, 0, 1)
    section = trimesh.intersections.mesh_plane(bark, [0, 1, 0], [0, bottom + breast, 0])
    perimeter = ConvexHull(section.reshape(-1, 3)[:, [0, 2]]).area
    stem = girth / perimeter
    rotation = trimesh.transformations.rotation_matrix(angle, [0, 1, 0])[:3, :3]
    # Work in geographic east/north so the source rotation never rotates the
    # measured footprint. Bark and leaves receive the same continuous warp.
    cardinal = rotation @ compass.T
    crown = (leaves.vertices - foot) @ cardinal
    spread = (hi - lo) / np.ptp(crown[:, [0, 2]], axis=0)
    lean = lo - crown[:, [0, 2]].min(axis=0) * spread
    result = []
    for source in (bark, leaves):
        mesh = source.copy()
        xyz = (mesh.vertices - foot) @ cardinal
        h = np.clip(xyz[:, 1] / top, 0, 1)
        blend = np.clip((h - .12) / .24, 0, 1)
        weight = (blend**2 * (3 - 2 * blend))[:, None]
        slope = (6 * blend * (1 - blend) / (.24 * top))[:, None]
        scale = stem + weight * (spread - stem)
        dxz_dy = slope * (xyz[:, [0, 2]] * (spread - stem) + lean)
        dy = vertical * (1 + 2 * lift - 6 * lift * h + 3 * lift * h**2)
        normals = source.vertex_normals.copy()
        bad = np.linalg.norm(normals, axis=1) < 1e-6
        normals[bad] = trimesh.geometry.mean_vertex_normals(
            len(mesh.vertices), mesh.faces, mesh.face_normals)[bad]
        normals = normals @ cardinal
        normals[:, [0, 2]] /= scale
        normals[:, 1] = (normals[:, 1] - (dxz_dy * normals[:, [0, 2]]).sum(axis=1)) / dy
        xyz[:, [0, 2]] = xyz[:, [0, 2]] * scale + weight * lean
        xyz[:, 1] = height * relative_height(h)
        mesh.vertices = xyz @ compass + foot_position
        normals = normals @ compass
        lengths = np.linalg.norm(normals, axis=1)
        normals[lengths < 1e-8] = [0, 1, 0]
        mesh.vertex_normals = normals / np.linalg.norm(normals, axis=1)[:, None]
        result.append(mesh)
    return result
