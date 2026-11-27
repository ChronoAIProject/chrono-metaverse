"""Bake unresolved-water reflectance and its measured reflection-direction bias."""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.special import erfc, ndtri
from scipy.stats import qmc


def fresnel(cosine):
    ior = 1.333
    transmitted = np.sqrt(1 - (1 - cosine**2) / ior**2)
    perpendicular = (cosine - ior * transmitted) / (cosine + ior * transmitted)
    parallel = (ior * cosine - transmitted) / (ior * cosine + transmitted)
    return (perpendicular**2 + parallel**2) / 2


def smith_lambda(cosine, sigma):
    # Beckmann projected-area masking for Gaussian slopes of standard deviation sigma.
    tangent = np.sqrt(np.maximum(0, 1 - cosine**2)) / np.maximum(cosine, 1e-9)
    a = 1 / np.maximum(sigma * tangent, 1e-9)
    return np.exp(-a*a/2) / (np.sqrt(2*np.pi)*a) - .5*erfc(a/np.sqrt(2))


def integrate(cosines, sigma, slopes):
    if sigma == 0:
        return fresnel(cosines), np.zeros_like(cosines)
    sx, sz = sigma * slopes.T
    ny = 1 / np.sqrt(1 + sx*sx + sz*sz)
    nx = sx * ny
    result = np.empty_like(cosines)
    direction = np.empty_like(cosines)
    for i, cosine in enumerate(np.maximum(1e-6, cosines)):
        view_dot_normal = nx * np.sqrt(1 - cosine**2) + ny * cosine
        reflected_x = 2 * view_dot_normal * nx - np.sqrt(1 - cosine**2)
        reflected_y = 2 * view_dot_normal * ny - cosine
        # Height-correlated Smith G2. Back-facing facets and rays below the water
        # horizon do not contribute to single scattering from the environment.
        visibility = 1 / (1 + smith_lambda(cosine, sigma) + smith_lambda(reflected_y.clip(0, 1), sigma))
        weight = visibility * np.maximum(0, view_dot_normal) / (cosine * ny)
        weighted = np.where(
            reflected_y > 0,
            weight * fresnel(view_dot_normal.clip(0, 1)),
            0,
        )
        result[i] = np.mean(weighted)
        direction[i] = np.arctan2(weighted @ reflected_y, -(weighted @ reflected_x)) - np.arcsin(cosine)
    return result, direction


def bake(output):
    slopes = ndtri(qmc.Sobol(2, scramble=True, seed=134).random_base2(12))
    cosines = np.linspace(0, 1, 192)**2
    # Concentrate samples at the small variances and grazing angles of distant water.
    # Six covers the encodable combined gravity/ripple slope range for this spectrum.
    sigmas = 6 * np.linspace(0, 1, 128)**3
    integrated = [integrate(cosines, sigma, slopes) for sigma in sigmas]
    table = np.stack([row[0] for row in integrated])
    direction = np.stack([row[1] for row in integrated])
    if not np.isfinite(table).all() or table.min() < 0 or table.max() > 1.001:
        raise ValueError("Invalid integrated reflectance")
    if not np.isfinite(direction).all():
        raise ValueError("Invalid integrated reflection direction")
    # Keep the Fresnel response in R. G/B store a signed 16-bit direction
    # displacement so the shader can reuse this lookup for the reflected image.
    # A 75% scale keeps the broad photographic bias while suppressing shoreline
    # sky leakage at the most grazing angles.
    encoded = np.rint(
        np.clip(direction * 0.75 / np.pi, -1, 1) * 32767 + 32768
    ).astype(np.uint16)
    baked = np.empty((*table.shape, 3), dtype=np.uint8)
    baked[:, :, 0] = np.rint(255 * table.clip(0, 1)).astype(np.uint8)
    baked[:, :, 1] = encoded >> 8
    baked[:, :, 2] = encoded & 255
    Image.fromarray(baked, mode='RGB').save(output, optimize=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    bake(parser.parse_args().output)
