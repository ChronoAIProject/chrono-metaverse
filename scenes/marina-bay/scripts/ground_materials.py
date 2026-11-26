"""Build PBR ground materials from the shared CC0 scans."""
from hashlib import sha256

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates
from trimesh.visual.material import PBRMaterial

from scanned_canopy import ROOT

ASSETS = ROOT.parents[1] / 'web/src/assets/geography'


def ground_scan(name):
    size = 768
    with Image.open(ASSETS / f'{name}-color.webp') as image:
        scan = np.asarray(image.convert('RGB').resize((size, size), Image.Resampling.LANCZOS), float)
    with Image.open(ASSETS / f'{name}-surface.webp') as image:
        packed = np.asarray(image.resize((size, size), Image.Resampling.LANCZOS), float)
    return scan, packed


def turf_grain(scan):
    # Keep the blade texture without repeating the same patch of drying grass every 1.4 m.
    mean = scan.mean(axis=(0, 1))
    local = gaussian_filter(scan, (scan.shape[0] / 62, scan.shape[1] / 62, 0), mode="wrap")
    return scan * mean / np.maximum(local, 1.0)


def turf_wear(xz):
    # Grass dries in connected areas across the blade scan. Bend the patch edges
    # on a larger scale so neighbouring lawns don't read as grids from above.
    rng = np.random.default_rng(5201)
    broad = map_coordinates(rng.uniform(-1, 1, (79, 83)), (xz / 29).T,
                            order=3, mode="grid-wrap")
    angle = np.array([[.8, -.6], [.6, .8]])
    warped = xz @ angle + broad[:, None] * [7.5, -4.0]
    patch = map_coordinates(rng.uniform(-1, 1, (67, 73)), (warped / [8.0, 14.0]).T,
                            order=3, mode="grid-wrap")
    # Dry blades are lighter and warmer, with fresh growth at the cool end.
    # These are linear-light multipliers on each site's sampled ground colour.
    dryness = np.clip(.60 * patch + .40 * broad, -1, 1)
    return np.exp(dryness[:, None] * [.86, .53, -.12])


def scanned_turf(name, mean_rgb, *, minimum_roughness=200):
    scan, packed = ground_scan('turf')
    scan = turf_grain(scan)
    # Select intact blade clusters from a second part of the scan. Apply the same
    # periodic mask to colour, normals and roughness so the highlights follow the blades.
    rng = np.random.default_rng(int.from_bytes(sha256(name.encode()).digest()[:8], 'little'))
    side = len(scan)
    grid = rng.uniform(-1, 1, (7, 9))
    coords = np.indices((side, side)) * (np.array(grid.shape) / side)[:, None, None]
    weight = np.clip(.5 + 5 * map_coordinates(grid, coords, mode='grid-wrap'), 0, 1)[..., None]
    shift = rng.integers(side // 5, 4 * side // 5, size=2)
    for channel in (scan, packed):
        channel += weight * (np.roll(channel, shift, axis=(0, 1)) - channel)
    rgb = scan / np.mean(scan, axis=(0, 1)) * mean_rgb
    slope = (packed[:, :, :2] / 127.5 - 1) * .68
    rough = np.maximum(packed[:, :, 2], minimum_roughness)
    return ground_pbr(name, rgb, slope, rough)


def scanned_pavers(name, mean_rgb, pitch):
    scan, packed = ground_scan('pavers')
    size = len(scan)
    y, x = np.indices((size, size))
    # The scan contains five courses of five stones. Take a different face
    # for each unit, clear of the source joints, at this site's surveyed pitch.
    col, row = (x + .5) / size * 4, (y + .5) / size * 6
    col += .5 * (row.astype(int) % 2)
    u, v = col % 1, row % 1
    rng = np.random.default_rng(int.from_bytes(sha256(name.encode()).digest()[:8], 'little'))
    unit = rng.permutation(25)[:24].reshape(6, 4)[row.astype(int), col.astype(int) % 4]
    i = (size * ((unit // 5 + .10 + .80 * v) / 5)).astype(int) % size
    j = (size * ((unit % 5 + .60 + .80 * u) / 5)).astype(int) % size
    grain = scan[i, j] @ [.2126, .7152, .0722]
    pitch = np.asarray(pitch)
    seam = np.minimum(np.minimum(u, 1-u)*pitch[0], np.minimum(v, 1-v)*pitch[1])
    joint = np.clip(1-seam/.0055, 0, 1)
    tone = rng.normal(0, 4, (6, 4))[row.astype(int), col.astype(int) % 4]
    rgb = np.asarray(mean_rgb) + (tone + (grain - grain.mean())*.56 - 28*joint)[:,:,None]
    relief = -.0032 * joint + .000015*(grain - grain.mean())
    dy = (np.roll(relief,-1,0)-np.roll(relief,1,0)) * size/(12*pitch[1])
    dx = (np.roll(relief,-1,1)-np.roll(relief,1,1)) * size/(8*pitch[0])
    slope = np.dstack((-dx,dy))
    rough = np.clip(packed[i,j,2]*.27 + 145 + 31*joint, 145, 245)
    return ground_pbr(name, rgb, slope, rough)


def ground_pbr(name, rgb, slope, rough):
    rgb = Image.fromarray(np.uint8(np.clip(rgb,0,255)))
    rgb.format = 'JPEG'
    normals = np.dstack((slope, np.ones_like(rough)))
    normals /= np.linalg.norm(normals,axis=2,keepdims=True)
    normal = Image.fromarray(np.uint8((normals+1)*127.5)).resize((384,384),Image.Resampling.LANCZOS)
    normal.format = 'JPEG'
    mr = Image.fromarray(np.uint8(np.dstack((np.full_like(rough,255),rough,np.zeros_like(rough))))).resize(
        (384,384),Image.Resampling.BOX)
    mr.format = 'PNG'
    return PBRMaterial(name=name,
                       baseColorTexture=rgb, normalTexture=normal, metallicRoughnessTexture=mr,
                       metallicFactor=0, roughnessFactor=1)
