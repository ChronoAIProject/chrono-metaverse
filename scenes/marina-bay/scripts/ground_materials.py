"""Build PBR ground materials from the shared CC0 scans."""
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
    # Two differently oriented fields move across the lawn in metres, independent of UV.
    rot = np.array([[.8, -.6], [.6, .8]])
    coarse = map_coordinates(np.random.default_rng(5201).uniform(-1, 1, (79, 83)),
                             (xz / 17).T, order=3, mode="grid-wrap")
    fine = map_coordinates(np.random.default_rng(5203).uniform(-1, 1, (61, 89)),
                           (xz @ rot / 6.8).T, order=3, mode="grid-wrap")
    return 1 + (.68 * coarse + .32 * fine)[:, None] * [.30, .16, -.06]


def scanned_turf(name, mean_rgb, *, minimum_roughness=200):
    scan, packed = ground_scan('turf')
    scan = turf_grain(scan)
    rgb = scan / np.mean(scan, axis=(0, 1)) * mean_rgb
    slope = (packed[:, :, :2] / 127.5 - 1) * .68
    rough = np.maximum(packed[:, :, 2], minimum_roughness)
    return ground_pbr(name, rgb, slope, rough)


def scanned_pavers(name, mean_rgb, pitch):
    scan, packed = ground_scan('pavers')
    size = len(scan)
    y, x = np.indices((size, size))
    # The source grain comes from the face of one clean granite unit. Set out
    # staggered rectangular stones at the pitch seen in the ground photograph.
    col, row = (x + .5) / size * 4, (y + .5) / size * 6
    col += .5 * (row.astype(int) % 2)
    u, v = col % 1, row % 1
    i, j = (48 + v * 49).astype(int), (48 + u * 49).astype(int)
    grain = scan[i, j] @ [.2126, .7152, .0722]
    pitch = np.asarray(pitch)
    seam = np.minimum(np.minimum(u, 1-u)*pitch[0], np.minimum(v, 1-v)*pitch[1])
    joint = np.clip(1-seam/.0055, 0, 1)
    tone = np.random.default_rng(149).normal(0, 5, (6,4))[row.astype(int), col.astype(int)%4]
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
