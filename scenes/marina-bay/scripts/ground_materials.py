"""Build PBR ground materials from the shared CC0 scans."""
from hashlib import sha256

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates
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


def turf_colour(cover, mean_rgb, size):
    folder = ROOT / 'references/ground-cover' / cover
    with Image.open(folder / 'Color.jpg') as source:
        pixels = np.asarray(source.convert('RGB').resize(size, Image.Resampling.LANCZOS)) / 255

    def linear(rgb):
        return np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)

    # Match the surveyed average in linear light, retaining the scan's clumps and bare soil.
    radiance = linear(pixels)
    radiance *= linear(np.asarray(mean_rgb) / 255) / radiance.mean(axis=(0, 1))
    rgb = np.where(radiance <= .0031308, radiance * 12.92, 1.055 * radiance ** (1 / 2.4) - .055)
    image = Image.fromarray(np.rint(255 * rgb).clip(0, 255).astype(np.uint8))
    image.format = 'JPEG'
    return image


def scanned_turf(name, mean_rgb, *, cover, roughness=200):
    folder = ROOT / 'references/ground-cover' / cover
    rgb = turf_colour(cover, mean_rgb, (768, 768))
    size = (384, 384)
    with Image.open(folder / 'NormalGL.jpg') as image:
        normals = np.asarray(image.convert('RGB').resize(size, Image.Resampling.LANCZOS)) / 127.5 - 1
    normals[:, :, :2] *= .75
    normals /= np.maximum(np.linalg.norm(normals, axis=2, keepdims=True), 1e-5)
    normal = Image.fromarray(np.rint((normals + 1) * 127.5).clip(0, 255).astype(np.uint8))
    normal.format = 'JPEG'
    with Image.open(folder / 'Roughness.jpg') as image:
        measured = np.asarray(image.convert('L').resize(size, Image.Resampling.LANCZOS), float)
    calibrated = np.rint(measured - measured.mean() + roughness).clip(175, 255).astype(np.uint8)
    packed = Image.merge('RGB', (Image.new('L', size, 255), Image.fromarray(calibrated), Image.new('L', size)))
    packed.format = 'PNG'
    return PBRMaterial(name=name, baseColorTexture=rgb, normalTexture=normal,
                       metallicRoughnessTexture=packed, metallicFactor=0, roughnessFactor=1)


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
