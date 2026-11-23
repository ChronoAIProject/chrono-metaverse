"""Bake Poly Haven's Island Tree 01 (1k glTF) into a detailed trunk and small cutout clusters."""

import hashlib
import json
import math
import subprocess
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals


def load_tree(folder, leaf_mask=None):
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
    return simplify_trunk(parts[0]), bake_crown(parts[1:], leaf_mask)


def simplify_trunk(part):
    xyz, indices, uv, normals, texture = part
    # Retain distinct texture islands when snapping nearby trunk vertices.
    keys = np.column_stack((np.floor(xyz / .088), np.floor(uv * 7))).astype(np.int32)
    _, kept, remap = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    faces = remap[indices]
    distinct = ((faces[:, 0] != faces[:, 1]) & (faces[:, 0] != faces[:, 2]) & (faces[:, 1] != faces[:, 2]))
    texture = texture.resize((512, 512), Image.Resampling.LANCZOS)
    texture.format = "JPEG"
    material = PBRMaterial(name="Island tree bark", baseColorTexture=texture, metallicFactor=0, roughnessFactor=.93)
    mesh = trimesh.Trimesh(vertices=xyz[kept], faces=faces[distinct], vertex_normals=normals[kept],
                           visual=TextureVisuals(uv=uv[kept] * [1, -1] + [0, 1], material=material), process=False)
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


def compact_bark(mesh):
    source = {"faces": mesh.faces.ravel().tolist(), "position": mesh.vertices.ravel().tolist(),
              "attributes": np.column_stack((mesh.vertex_normals, mesh.visual.uv)).ravel().tolist()}
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
