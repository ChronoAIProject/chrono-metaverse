"""Register the visible Merlion relief from Adam Wilson's 2018 photograph."""

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates


# Horizontal bounds just inside the sculpture, in pixels of the CC0 crop.
# The camera sees the near eye and one side of the mane and scales.
OUTLINE = np.array([
    [24, 232, 289], [35, 178, 318], [55, 138, 350], [80, 108, 380],
    [100, 70, 395], [128, 61, 418], [156, 48, 433], [185, 30, 440],
    [215, 25, 448], [244, 37, 454], [272, 71, 458], [300, 66, 458],
    [330, 70, 459], [363, 71, 459], [400, 76, 460], [440, 66, 460],
    [495, 57, 459], [540, 43, 463], [563, 42, 469], [582, 58, 446],
    [610, 65, 452], [657, 55, 455], [710, 61, 460], [741, 108, 473],
    [778, 95, 481], [808, 103, 442], [836, 106, 434], [867, 108, 430],
    [910, 109, 438], [950, 108, 434], [993, 100, 430], [1030, 97, 431],
    [1068, 92, 424], [1110, 87, 420], [1153, 90, 420], [1191, 83, 408],
    [1230, 80, 396], [1241, 117, 387], [1260, 188, 377], [1277, 278, 368],
])
# Row of the crest, mouth, hem of the mane and foot at their surveyed heights.
LEVELS = np.array([[3.85, 1277], [4.35, 1198], [5.15, 1050], [6.0, 902],
                   [6.9, 782], [7.42, 730], [8.48, 544], [9.32, 406],
                   [9.98, 288], [10.45, 160], [10.83, 84], [11.044, 24]])


def portrait(photo, positions, faces, normals):
    source = np.asarray(Image.open(photo).convert("RGB"), dtype=float)
    if source.shape[:2] != (1310, 520):
        raise ValueError("Expected the registered Adam Wilson 2018 crop")
    y, x = np.indices((1024, 1024), dtype=float)
    theta = np.abs((x / 1023 - .5) * 2 * np.pi)
    elevation = 11.044 - y / 1023 * (11.044 - 3.85)
    row = np.interp(elevation, LEVELS[:, 0], LEVELS[:, 1])
    left = np.interp(row, OUTLINE[:, 0], OUTLINE[:, 1])
    right = np.interp(row, OUTLINE[:, 0], OUTLINE[:, 2])

    # Past the photographed flank, continue the grooves with an interior strip
    # of the mane. Keep the tail scales in the lower part of that same strip.
    angle = np.minimum(theta - np.deg2rad(41), np.pi/2)
    u = .5 + .5 * np.sin(angle)
    back = np.clip((theta - np.deg2rad(84)) / np.deg2rad(96), 0, 1)
    back = back**2 * (3 - 2*back)
    u = u*(1-back) + .75*back
    col = left + (right-left)*u
    coords = np.stack([row, col])
    rgb = np.stack([map_coordinates(channel, coords, order=1, mode="nearest")
                    for channel in source.transpose(2, 0, 1)], axis=2)
    # The scale pattern needs its own arc length on the unseen side. A single
    # sample column spread around the back would stretch each scale into a band.
    scale_phase = np.cos((np.pi-theta)*7 + .28*np.sin(row/140))
    scale_col = left + (right-left)*(.80 + .12*scale_phase)
    scale_coords = np.stack([row, scale_col])
    scales = np.stack([map_coordinates(channel, scale_coords, order=1, mode="nearest")
                       for channel in source.transpose(2, 0, 1)], axis=2)
    tail = np.clip((row-724)/94, 0, 1)
    unseen = np.clip((theta-np.deg2rad(88))/np.deg2rad(40), 0, 1)
    blend = (unseen**2 * (3-2*unseen)*tail)[..., None]
    rgb = rgb*(1-blend) + scales*blend
    # The optical black of the photographed nozzle belongs inside the opening;
    # on the flank it would duplicate the mouth cut into the survey mesh.
    mouth = np.clip((1-np.abs(row-288)/54)*2, 0, 1) * np.clip((241-col)/38, 0, 1)
    rgb = np.maximum(rgb, (mouth*100)[..., None])
    luminance = rgb @ [0.2126, 0.7152, 0.0722]
    rgb = (.87 * luminance[..., None] + .13 * rgb) * [.927, .919, .901]
    atlas = Image.fromarray(np.uint8(np.clip(rgb, 0, 255)))

    xyz = positions[faces]
    forward = np.array([-np.cos(np.deg2rad(34.5)), 0, np.sin(np.deg2rad(34.5))])
    lateral = np.cross([0, 1, 0], forward)
    f = xyz @ forward
    s = xyz @ lateral - .15
    uvx = .5 + np.arctan2(s, f) / (2*np.pi)
    across = np.ptp(uvx, axis=1) > .5
    uvx[across] = np.where(uvx[across] < .5, uvx[across]+1, uvx[across])
    uvy = np.clip((11.044-xyz[:, :, 1])/(11.044-3.85), 0, 1)

    selected = (xyz[:, :, 1].min(1) > 3.85) & (np.hypot(f, s).max(1) < 2.25)
    # The survey exports every sculpture face twice. Keep its first winding.
    seen = set()
    chosen = []
    for index in np.flatnonzero(selected):
        key = tuple(sorted(map(tuple, xyz[index])))
        if key not in seen:
            chosen.append(index)
            seen.add(key)
    uv = np.stack([uvx[chosen], uvy[chosen]], axis=-1)
    return (selected, xyz[chosen].reshape(-1, 3), normals[faces[chosen]].reshape(-1, 3),
            uv.reshape(-1, 2), atlas)
