"""Bake ambient visibility through the open front and the smaller opening at the stair landing."""

import math

import numpy as np
from PIL import Image


def portal_visibility(quads, lower, upper, landing, left, right, floor, head, depth):
    # Equal-area directions on a sphere. Lambert's cosine term converts these
    # to irradiance for each surface orientation. A ray can reach the outside
    # only through the waterfront entrance; landing rays cross both openings.
    count = 768
    index = np.arange(count) + .5
    y = 1 - 2*index/count
    radial = np.sqrt(1-y*y)
    angle = index*np.pi*(3-np.sqrt(5))
    sky = np.column_stack((radial*np.cos(angle), y, radial*np.sin(angle)))
    front = sky[:, 0] < -1e-6
    y_slope, s_slope = (sky[front, 1:] / -sky[front, :1]).T

    tile, padding = 16, 3
    side = math.ceil(math.sqrt(len(quads)))
    atlas = np.full((side*tile, side*tile), 255, np.uint8)
    uv = []
    # Duplicate boundary texels in each gutter for bilinear filtering between quads.
    axis = np.clip((np.arange(tile)-padding)/(tile-1-2*padding), 0, 1)
    u, v = np.meshgrid(axis, axis)
    for i, (corners, normal, photographed_glass) in enumerate(quads):
        pos = corners[0] + u[:,:,None]*(corners[1]-corners[0]) + v[:,:,None]*(corners[3]-corners[0])
        # Avoid rays hitting their emitting plane at exactly the top or side.
        p = (pos + np.array(normal)*.003).reshape(-1,3)
        x, height, station = p.T
        reach = np.maximum(x, 0)[:,None]
        end_y = height[:,None] + reach*y_slope
        end_s = station[:,None] + reach*s_slope
        visible = (end_y>=floor)&(end_y<=head)&(end_s>=left)&(end_s<=right)
        rear = x > depth
        if rear.any():
            between = (x[rear]-depth)[:,None]
            middle_y = height[rear,None]+between*y_slope
            middle_s = station[rear,None]+between*s_slope
            visible[rear] &= ((middle_y>=landing)&(middle_y<=landing+2.8)&
                              (middle_s>=lower)&(middle_s<=upper))
        weights = np.maximum(0, sky @ normal)
        flux = visible @ weights[front] / weights.sum()
        # Residual light is a diffuse interreflection estimate; no illuminance
        # measurement is available for the shaded interior in the source photo.
        brightness = .095 + .905*flux
        if photographed_glass:
            # The rectified return photograph already contains its indoor
            # exposure and reflections. Preserve that measured tonal range.
            brightness = .85 + .15*brightness
        row, col = divmod(i, side)
        atlas[row*tile:(row+1)*tile,col*tile:(col+1)*tile] = np.uint8(np.rint(255*brightness.reshape(tile,tile)))
        a,b = padding+.5,tile-padding-.5
        uv.extend((np.array([[a,a],[b,a],[b,b],[a,b]])+[col*tile,row*tile])/(side*tile))
    return Image.fromarray(atlas), np.array(uv, dtype=np.float32)


def occlusion_coordinates(document):
    # The exporter accepts custom vertex attributes. Expose the second UV set
    # as the standard glTF semantic and leave the photo atlas on TEXCOORD_0.
    for mesh in document["meshes"]:
        for primitive in mesh["primitives"]:
            attrs = primitive["attributes"]
            attrs["TEXCOORD_1"] = attrs.pop("_OCCLUSION_UV")
    document["materials"][0]["occlusionTexture"]["texCoord"] = 1
