"""Integrate directional single-scattering reflectance for unresolved water slopes."""
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
        return fresnel(cosines)
    sx, sz = sigma * slopes.T
    ny = 1 / np.sqrt(1 + sx*sx + sz*sz)
    nx = sx * ny
    result = np.empty_like(cosines)
    for i, cosine in enumerate(np.maximum(1e-6, cosines)):
        view_dot_normal = nx * np.sqrt(1 - cosine**2) + ny * cosine
        reflected_y = 2 * view_dot_normal * ny - cosine
        # Height-correlated Smith G2. Back-facing facets and rays below the water
        # horizon do not contribute to single scattering from the environment.
        visibility = 1 / (1 + smith_lambda(cosine, sigma) + smith_lambda(reflected_y.clip(0, 1), sigma))
        weight = visibility * np.maximum(0, view_dot_normal) / (cosine * ny)
        result[i] = np.mean(np.where(reflected_y > 0, weight * fresnel(view_dot_normal.clip(0, 1)), 0))
    return result


def bake(output):
    slopes = ndtri(qmc.Sobol(2, scramble=True, seed=134).random_base2(12))
    cosines = np.linspace(0, 1, 192)**2
    # Concentrate samples at the small variances and grazing angles of distant water.
    # Six covers the encodable combined gravity/ripple slope range for this spectrum.
    sigmas = 6 * np.linspace(0, 1, 128)**3
    table = np.stack([integrate(cosines, sigma, slopes) for sigma in sigmas])
    if not np.isfinite(table).all() or table.min() < 0 or table.max() > 1.001:
        raise ValueError("Invalid integrated reflectance")
    # A linear eight-bit channel keeps the absolute quantization error below 0.002.
    Image.fromarray(np.rint(255 * table.clip(0, 1)).astype('u1')).save(output, optimize=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    bake(parser.parse_args().output)
