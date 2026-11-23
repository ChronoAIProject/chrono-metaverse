"""Bake diffuse sky occlusion from neighbouring alpha-tested crowns in a surveyed grove."""

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates


def crown_depth(projected, depth, faces, texcoords, alpha, cutoff):
    """Rasterize the nearest opaque leaf sample for a single tree and sky direction."""
    origin = np.floor(projected.min(axis=0)).astype(int)
    xy = projected - origin
    triangle = xy[faces]
    low = np.floor(triangle.min(axis=1)).astype(int)
    high = np.ceil(triangle.max(axis=1)).astype(int)
    width, height = (high - low + 1).T
    sizes = width * height
    face = np.repeat(np.arange(len(faces)), sizes)
    index = np.arange(sizes.sum()) - np.repeat(np.cumsum(sizes) - sizes, sizes)
    x = low[face, 0] + index % width[face]
    y = low[face, 1] + index // width[face]
    a, b, c = triangle.transpose(1, 0, 2)
    ab, ac = b - a, c - a
    det = ab[:, 0] * ac[:, 1] - ab[:, 1] * ac[:, 0]
    dx, dy = x - a[face, 0], y - a[face, 1]
    with np.errstate(invalid="ignore", divide="ignore"):
        s = (dx * ac[face, 1] - dy * ac[face, 0]) / det[face]
        t = (ab[face, 0] * dy - ab[face, 1] * dx) / det[face]
    inside = (abs(det[face]) > 1e-8) & (s >= 0) & (t >= 0) & (s + t <= 1)
    face, x, y, s, t = (v[inside] for v in (face, x, y, s, t))
    weights = np.column_stack([1 - s - t, s, t])
    uv = np.einsum("ij,ijk->ik", weights, texcoords[faces[face]])
    opaque = map_coordinates(alpha, [(1 - uv[:, 1]) * alpha.shape[0] - .5,
                                     uv[:, 0] * alpha.shape[1] - .5], order=1, mode="nearest") >= cutoff
    z = np.einsum("ij,ij->i", weights[opaque], depth[faces[face[opaque]]])
    image = np.full((high[:, 1].max() + 1, high[:, 0].max() + 1), -np.inf, np.float32)
    np.maximum.at(image, (y[opaque], x[opaque]), z)
    return origin, image


def neighbouring_sky(crowns, crown_normals, trunks, uvs, faces, atlas, cutoff, directions=48, pitch=.28):
    """Integrate the cosine-weighted blocked sky at each canopy and bark vertex."""
    points = [np.vstack([c, t.vertices]) for c, t in zip(crowns, trunks)]
    normals = np.vstack([np.vstack([n, t.vertex_normals]) for n, t in zip(crown_normals, trunks)])
    owner = np.repeat(np.arange(len(points)), [len(group) for group in points])
    samples = np.vstack(points)
    alpha = np.asarray(atlas)[:, :, 3].astype(np.float32) / 255
    blocked = np.zeros(len(samples))
    # Golden-angle directions uniformly cover the upper hemisphere in solid angle.
    for i in range(directions):
        up = (i + .5) / directions
        azimuth = np.pi * (3 - np.sqrt(5)) * i
        horizontal = np.sqrt(1 - up**2)
        ray = np.array([horizontal * np.cos(azimuth), up, horizontal * np.sin(azimuth)])
        right = np.array([-np.sin(azimuth), 0, np.cos(azimuth)])
        basis = np.array([right, np.cross(ray, right)])
        query = samples @ basis.T / pitch
        offset = np.floor(query.min(axis=0)).astype(int) - 2
        query -= offset
        width, height = np.ceil(query.max(axis=0)).astype(int) + 3
        front = np.full((height, width), -np.inf, np.float32)
        second = front.copy()
        first_owner = np.full((height, width), -1, np.int32)
        for tree, (crown, uv) in enumerate(zip(crowns, uvs)):
            (x, y), z = crown_depth(crown @ basis.T / pitch - offset, crown @ ray,
                                    faces, uv, alpha, cutoff)
            region = np.s_[y:y+z.shape[0], x:x+z.shape[1]]
            near = front[region]
            closer = z > near
            second[region] = np.where(closer, near, np.maximum(second[region], z))
            first_owner[region][closer] = tree
            near[closer] = z[closer]
        # The two closest distinct owners let each receiver ignore its own crown.
        # Interpolate the four binary visibility samples after the depth comparison.
        x, y = np.floor(query).astype(int).T
        sx, sy = (query - np.floor(query)).T
        receiver = samples @ ray
        weight = np.maximum(0, normals @ ray)
        for ox, wx in [(0, 1 - sx), (1, sx)]:
            for oy, wy in [(0, 1 - sy), (1, sy)]:
                index = (y + oy, x + ox)
                nearest = np.where(first_owner[index] == owner, second[index], front[index])
                blocked += weight * wx * wy * (nearest > receiver + .04)
    visibility = np.clip(1 - blocked * 2 / directions, 0, 1)
    groups = np.split(visibility, np.cumsum([len(group) for group in points])[:-1])
    return [np.split(v, [len(c)]) for c, v in zip(crowns, groups)]


def assign_occlusion(mesh, visibility):
    # A linear grayscale ramp lets glTF interpolate a baked scalar per vertex
    # with its standard secondary UV set and occlusion material channel.
    ramp = Image.fromarray(np.array([[0, 255], [0, 255]], dtype=np.uint8)).convert("RGB")
    ramp.format = "PNG"
    mesh.visual.material.occlusionTexture = ramp
    mesh.vertex_attributes["_OCCLUSIONUV"] = np.column_stack(
        (.25 + .5 * np.asarray(visibility), np.full(len(visibility), .5))).astype(np.float32)


def use_occlusion_uv(doc):
    for mesh in doc["meshes"]:
        for primitive in mesh["primitives"]:
            attrs = primitive["attributes"]
            if "_OCCLUSIONUV" in attrs:
                attrs["TEXCOORD_1"] = attrs.pop("_OCCLUSIONUV")
                doc["materials"][primitive["material"]]["occlusionTexture"]["texCoord"] = 1
