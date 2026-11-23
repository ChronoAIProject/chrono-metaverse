"""Bake a distant rooftop tree from the same textured branches as the near model."""

import numpy as np
import trimesh
from PIL import Image
from scipy.ndimage import distance_transform_edt
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals


def tree_cards(bark, leaves):
    size = 96
    atlas = Image.new("RGBA", (size * 4, size))
    vertices, faces, texcoords, normals = [], [], [], []
    # Keep one nearly horizontal slice for elevated viewpoints.
    for tile, (azimuth, elevation) in enumerate([(0, .06), (1.047, -.12), (2.094, .20), (.46, 1.35)]):
        side = np.array([np.cos(azimuth), 0, np.sin(azimuth)])
        facing = np.array([-np.sin(azimuth) * np.cos(elevation), np.sin(elevation),
                           np.cos(azimuth) * np.cos(elevation)])
        basis = np.array([side, np.cross(facing, side), facing])
        projected = [mesh.vertices @ basis.T for mesh in (bark, leaves)]
        low, high = np.min(np.vstack(projected), axis=0), np.max(np.vstack(projected), axis=0)
        span = high[:2] - low[:2]
        low[:2] -= span * .025
        high[:2] += span * .025
        depth = np.full((size, size), -np.inf)
        rgba = np.zeros((size, size, 4), dtype=np.uint8)
        for mesh, coords in zip((bark, leaves), projected, strict=True):
            uv = mesh.visual.uv.copy()
            uv[:, 1] = 1 - uv[:, 1]
            texture = np.asarray(mesh.visual.material.baseColorTexture.convert("RGBA"))
            screen = (coords[:, :2] - low[:2]) / (high[:2] - low[:2]) * (size - 1)
            screen[:, 1] = size - 1 - screen[:, 1]
            for face in mesh.faces:
                tri = screen[face]
                a, b, c = tri
                ab, ac = b - a, c - a
                det = ab[0] * ac[1] - ab[1] * ac[0]
                if abs(det) < 1e-5:
                    continue
                x0, y0 = np.maximum(0, np.floor(tri.min(axis=0)).astype(int))
                x1, y1 = np.minimum(size - 1, np.ceil(tri.max(axis=0)).astype(int))
                x, y = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
                x, y = x.ravel(), y.ravel()
                dx, dy = x + .5 - a[0], y + .5 - a[1]
                vb, vc = (dx * ac[1] - dy * ac[0]) / det, (ab[0] * dy - ab[1] * dx) / det
                weights = np.column_stack((1 - vb - vc, vb, vc))
                z = weights @ coords[face, 2]
                inside = (weights.min(axis=1) >= 0) & (z > depth[y, x])
                x, y = x[inside], y[inside]
                pixels = ((weights[inside] @ uv[face] % 1) * texture.shape[1::-1]).astype(int)
                paint = texture[pixels[:, 1], pixels[:, 0]]
                opaque = paint[:, 3] >= 128
                rgba[y[opaque], x[opaque]] = paint[opaque]
                depth[y[opaque], x[opaque]] = z[inside][opaque]
        nearest = distance_transform_edt(rgba[:, :, 3] == 0, return_indices=True, return_distances=False)
        rgba[:, :, :3] = rgba[tuple(nearest)][:, :, :3]
        atlas.paste(Image.fromarray(rgba), (size * tile, 0))
        z = (low[2] + high[2]) / 2
        quad = np.array([[low[0], low[1], z], [high[0], low[1], z],
                         [high[0], high[1], z], [low[0], high[1], z]]) @ basis
        base = len(vertices)
        vertices.extend(quad)
        faces.extend([[base, base + 1, base + 2], [base, base + 2, base + 3]])
        texcoords.extend([[(tile + u) / 4, v] for u, v in [(0, 0), (1, 0), (1, 1), (0, 1)]])
        radial = quad - (leaves.bounds.mean(axis=0) - [0, 1.4, 0])
        radial[:, 1] = np.maximum(radial[:, 1], .7)
        normals.extend(radial / np.linalg.norm(radial, axis=1)[:, None])
    atlas.format = "PNG"
    material = PBRMaterial(name="SkyPark distant crowns", baseColorTexture=atlas, alphaMode="MASK",
                           alphaCutoff=.38, doubleSided=True, metallicFactor=0, roughnessFactor=.94)
    return trimesh.Trimesh(vertices=vertices, faces=faces, vertex_normals=normals,
                           visual=TextureVisuals(uv=texcoords, material=material), process=False)
