"""Rebuild the surveyed curtain wall facing the south One Fullerton terrace."""

import io

import numpy as np
import trimesh
from PIL import Image
from scipy.ndimage import distance_transform_edt, map_coordinates
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

GLASS = "One Fullerton laminated glazing"
PHOTO = "https://commons.wikimedia.org/wiki/File:One_Fullerton_12-05-2024(6).jpg"

# Lower south, lower north, upper north and upper south in the quay's metric frame.
# The short returns connect the two projecting volumes above the terrace roof.
SURVEY = [
    [[13.155, 3.553, 18.410], [13.211, 3.551, 40.569],
     [13.211, 8.777, 40.570], [13.155, 10.614, 18.411]],
    [[13.211, 3.551, 40.569], [14.806, 3.551, 40.586],
     [14.806, 9.630, 40.587], [13.211, 8.777, 40.570]],
    [[14.806, 3.551, 40.586], [14.402, 3.551, 42.482],
     [14.402, 12.059, 42.482], [14.806, 9.630, 40.587]],
    [[14.365, 3.551, 42.481], [14.360, 3.551, 47.649],
     [14.360, 11.266, 47.650], [14.365, 12.056, 42.482]],
    [[14.360, 3.551, 47.649], [13.585, 3.549, 68.342],
     [13.585, 8.102, 68.343], [14.360, 11.266, 47.650]],
]


def glazing_patch(local, faces, uv, image_bytes):
    atlas = np.asarray(Image.open(io.BytesIO(image_bytes)).convert("RGB"), dtype=float)
    on_patch = np.zeros(len(faces), dtype=bool)
    panels, images, coordinates, members = [], [], [], []
    for measured in SURVEY:
        distance = np.linalg.norm(local[:, None, :] - measured, axis=2)
        selected = (distance.min(axis=1)[faces] < .013).all(axis=1)
        if selected.sum() != 4:
            raise ValueError("Expected two surveyed curtain wall triangles in duplicate")
        on_patch |= selected
        corners = local[distance.argmin(axis=0)]
        tangent = corners[1, [0, 2]] - corners[0, [0, 2]]
        span = np.linalg.norm(tangent)
        tangent /= span
        image, coords = window_image(corners, tangent, span, local, faces[selected], uv, atlas)
        images.append(image)
        coordinates.append(coords)
        panels.append(corners)
        members.extend(mullions(corners, tangent, span))

    # Keep every orientation in one material. A two-texel gutter provides
    # continuous edge samples on each side of the atlas seams.
    texture = Image.new("RGB", (sum(image.width + 4 for image in images), images[0].height))
    offset = 0
    for image, coords in zip(images, coordinates, strict=True):
        width, height = image.size
        texture.paste(image.crop((0, 0, 1, height)).resize((2, height)), (offset, 0))
        texture.paste(image, (offset + 2, 0))
        texture.paste(image.crop((width - 1, 0, width, height)).resize((2, height)), (offset + width + 2, 0))
        coords[:, 0] = (offset + 2.5 + coords[:, 0] * (width - 1)) / texture.width
        offset += width + 4
    texture.format = "JPEG"
    material = PBRMaterial(name=GLASS, baseColorTexture=texture, baseColorFactor=[210, 223, 228, 255],
                           metallicFactor=.10, roughnessFactor=.27)
    quad_faces = np.array([[0, 1, 2], [0, 2, 3]]) + (np.arange(len(panels)) * 4)[:, None, None]
    glass = trimesh.Trimesh(vertices=np.vstack(panels), faces=quad_faces.reshape(-1, 3),
                            visual=TextureVisuals(uv=np.vstack(coordinates), material=material), process=False)
    bars = trimesh.util.concatenate(members)
    bars = trimesh.Trimesh(vertices=bars.vertices[bars.faces].reshape(-1, 3),
                           faces=np.arange(bars.faces.size).reshape(-1, 3), process=False)
    bars.vertex_normals = np.repeat(bars.face_normals, 3, axis=0)
    bars.visual = TextureVisuals(material=PBRMaterial(name="Anodised glazing bars",
                                 baseColorFactor=[88, 92, 92, 255], metallicFactor=.48, roughnessFactor=.46))
    return on_patch, [glass, bars]


def window_image(corners, tangent, span, vertices, faces, uv, atlas):
    origin = corners[0, [0, 2]]
    low, high = corners[:, 1].min(), corners[:, 1].max()
    along, y = np.meshgrid(np.linspace(0, span, round(span * 31) + 1), np.linspace(high, low, 256))
    points = np.stack([along.ravel(), y.ravel(), np.ones(y.size)])
    rgb = np.zeros((y.size, 3))
    valid = np.zeros(y.size, dtype=bool)
    for face in faces:
        triangle = vertices[face]
        horizontal = (triangle[:, [0, 2]] - origin) @ tangent
        weights = np.linalg.solve(np.vstack((horizontal, triangle[:, 1], np.ones(3))), points).T
        inside = (weights >= -.002).all(axis=1)
        pixels = weights[inside] @ uv[face] * atlas.shape[1::-1]
        rgb[inside] = np.column_stack([
            map_coordinates(channel, pixels[:, ::-1].T, order=1, mode="nearest")
            for channel in atlas.transpose(2, 0, 1)
        ])
        valid |= inside
    # Pad the sloping roof boundary from its last valid texel for mip filtering.
    nearest = distance_transform_edt(~valid.reshape(y.shape), return_distances=False, return_indices=True)
    rgb = rgb.reshape((*y.shape, 3))[tuple(nearest)]
    luminance = rgb @ [.2126, .7152, .0722]
    tint = (.58 * luminance + 74)[..., None] * [.81, .95, 1.015] + .18 * (rgb - luminance[..., None])
    # Borrow the tint just above the opaque sill to remove vegetation baked into the glass.
    weight = np.clip((5.5 - y) / 1.35, 0, 1)
    weight = (.85 * weight ** 2 * (3 - 2 * weight))[..., None]
    sill_color = np.median(tint[(y > 5.45) & (y < 6.45)], axis=0) * .88
    image = Image.fromarray(np.uint8(np.clip(tint * (1 - weight) + sill_color * weight, 0, 255)))
    coords = np.column_stack(((corners[:, [0, 2]] - origin) @ tangent / span, (corners[:, 1] - low) / (high - low)))
    return image, coords


def mullions(corners, tangent, span):
    lower_south, lower_north, upper_north, upper_south = corners
    origin = lower_south[[0, 2]]
    normal = np.array([-tangent[1], tangent[0]])
    members = []

    def add(along, y, height, width, depth):
        bar = trimesh.creation.box([depth, height, width])
        xyz = bar.vertices.copy()
        bar.vertices[:, [0, 2]] = (origin + (along + xyz[:, 2:3]) * tangent +
                                   (depth / 2 - xyz[:, :1]) * normal)
        bar.vertices[:, 1] += y
        members.append(bar)

    # Main frames repeat every 5.24 m before the setback and 5.26 m beyond it.
    first_major, spacing = (21.90, 2.62) if lower_south[2] < 40 else (42.96, 2.63)
    start, end = lower_south[2], lower_north[2]
    for index in range(int(np.ceil((start - first_major) / spacing)), int(np.ceil((end - first_major) / spacing))):
        t = (first_major + index * spacing - start) / (end - start)
        high = (1 - t) * upper_south[1] + t * upper_north[1]
        low = (1 - t) * lower_south[1] + t * lower_north[1]
        major = index % 2 == 0
        add(t * span, (low + high) / 2, high - low, .105 if major else .048, .115 if major else .065)
    for y in [3.62, 4.94, 6.65, 8.48, 10.25]:
        top = y + .035
        if top >= max(upper_south[1], upper_north[1]):
            continue
        left, right = 0, span
        if top > min(upper_south[1], upper_north[1]):
            cross = span * (top - upper_south[1]) / (upper_north[1] - upper_south[1])
            if upper_south[1] < top:
                left = cross
            else:
                right = cross
        add((left + right) / 2, y, .07, right - left, .071)
    return members
