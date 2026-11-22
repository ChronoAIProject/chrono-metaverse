"""Reconstruct the straight upper curtain wall facing the south One Fullerton terrace."""

import io

import numpy as np
import trimesh
from PIL import Image
from scipy.ndimage import map_coordinates
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

GLASS = "One Fullerton laminated glazing"
PHOTO = "https://commons.wikimedia.org/wiki/File:One_Fullerton_12-05-2024(6).jpg"


def glazing_patch(local, faces, uv, image_bytes):
    # Identify both coincident copies by surveyed corners, independent of index ordering.
    # Corner order runs from lower south, lower north, upper north to upper south.
    measured = np.array([[13.155, 3.553, 18.410], [13.211, 3.551, 40.569],
                         [13.211, 8.777, 40.570], [13.155, 10.614, 18.411]])
    distance = np.linalg.norm(local[:, None, :] - measured[None, :, :], axis=2)
    on_patch = (distance.min(axis=1)[faces] < .013).all(axis=1)
    if on_patch.sum() != 4:
        raise ValueError("Expected two surveyed curtain wall triangles in duplicate")
    corners = local[distance.argmin(axis=0)]
    glass = pane(corners, local, faces[on_patch], uv, Image.open(io.BytesIO(image_bytes)))
    return on_patch, [glass, mullions(corners)]


def pane(corners, vertices, faces, uv, image):
    low_y, low_z = corners[:, 1:].min(axis=0)
    high_y, high_z = corners[:, 1:].max(axis=0)
    z, y = np.meshgrid(np.linspace(low_z, high_z, 768), np.linspace(high_y, low_y, 256))
    points = np.stack([z.ravel(), y.ravel(), np.ones(z.size)])
    atlas = np.asarray(image.convert("RGB"), dtype=float)
    rgb = np.zeros((z.size, 3))
    for face in faces:
        triangle = vertices[face][:, [2, 1]]
        weights = np.linalg.solve(np.vstack((triangle.T, np.ones(3))), points).T
        inside = (weights >= -.002).all(axis=1)
        pixels = weights[inside] @ uv[face] * image.size
        rgb[inside] = np.column_stack([
            map_coordinates(channel, pixels[:, ::-1].T, order=1, mode="nearest")
            for channel in atlas.transpose(2, 0, 1)
        ])
    rgb = rgb.reshape((*z.shape, 3))
    luminance = rgb @ [.2126, .7152, .0722]
    tint = (.58 * luminance + 74)[..., None] * [.81, .95, 1.015] + .18 * (rgb - luminance[..., None])
    # The survey bakes trees into the opaque band below the windows. Borrow its
    # unoccluded tint just above that band, feathering in world-space height.
    weight = np.clip((5.5 - y) / 1.35, 0, 1)
    weight = (.85 * weight ** 2 * (3 - 2 * weight))[..., None]
    sill_color = (np.median(tint[(y > 5.45) & (y < 6.45)], axis=0) + [0, 1, 1]) * .88
    image = Image.fromarray(np.uint8(np.clip(tint * (1 - weight) + sill_color * weight, 0, 255)))
    image.format = "JPEG"
    material = PBRMaterial(name=GLASS, baseColorTexture=image, baseColorFactor=[210, 223, 228, 255],
                           metallicFactor=.10, roughnessFactor=.27)
    coords = (corners[:, [2, 1]] - [low_z, low_y]) / [high_z - low_z, high_y - low_y]
    return trimesh.Trimesh(vertices=corners.copy(), faces=[[0, 1, 2], [0, 2, 3]],
                           visual=TextureVisuals(uv=coords, material=material), process=False)


def mullions(corners):
    lower_south, lower_north, upper_north, upper_south = corners
    start, end = lower_south[2], lower_north[2]
    members = []

    def add(z, y, height, width, depth):
        bar = trimesh.creation.box([depth, height, width])
        bar.apply_translation([0, y, z])
        # Follow the actual glass plane at both ends of each long transom.
        plane_x = np.interp(bar.vertices[:, 2], [start, end], [lower_south[0], lower_north[0]])
        bar.vertices[:, 0] += plane_x - depth / 2
        members.append(bar)

    # Major uprights register with the image at 21.90, 27.14, 32.38 and 37.62 m.
    for index in range(-1, 8):
        z = 21.90 + index * 2.62
        if start < z < end:
            high = np.interp(z, [start, end], [upper_south[1], upper_north[1]])
            low = np.interp(z, [start, end], [lower_south[1], lower_north[1]])
            major = index % 2 == 0
            add(z, (low + high) / 2, high - low, .105 if major else .048, .115 if major else .065)
    for y in [3.62, 4.94, 6.65, 8.48]:
        add((start + end) / 2, y, .07, end - start, .071)
    mesh = trimesh.util.concatenate(members)
    mesh = trimesh.Trimesh(vertices=mesh.vertices[mesh.faces].reshape(-1, 3),
                           faces=np.arange(mesh.faces.size).reshape(-1, 3), process=False)
    mesh.vertex_normals = np.repeat(mesh.face_normals, 3, axis=0)
    mesh.visual = TextureVisuals(material=PBRMaterial(name="Anodised glazing bars",
                                 baseColorFactor=[88, 92, 92, 255], metallicFactor=.48, roughnessFactor=.46))
    return mesh
