"""Metric pool floor and ripple material shared by outdoor pools."""
import numpy as np
from PIL import Image
from trimesh.visual.material import PBRMaterial


def tile_finish(name="SkyPark pool water"):
    # An eight-tile repeat across two metres. Create a standard glTF fallback
    # with metric grout and a gently rippled normal even in a static viewer.
    y, x = np.indices((256, 256))
    gx, gy = x % 32, y % 32
    rng = np.random.default_rng(948)
    varied = rng.normal(0, 2.2, (8, 8))[y // 32, x // 32]
    rgb = np.array([72, 135, 136])[None, None, :] + varied[:, :, None]
    rgb += ((gx == 0) | (gy == 0))[:, :, None] * np.array([-6, -9, -9])
    color = Image.fromarray(np.uint8(rgb))
    color.format = "PNG"
    u, v = 2 * np.pi * x / 256, 2 * np.pi * y / 256
    dx = .13 * np.cos(3*u + 2*v + .7*np.sin(u - v)) + .06 * np.cos(5*v - 2*u)
    dy = .10 * np.cos(3*u + 2*v + .7*np.sin(u - v)) - .12 * np.cos(5*v - 2*u)
    normal = np.stack((dx, dy, np.ones_like(dx)), axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    ripple = Image.fromarray(np.uint8((normal * .5 + .5) * 255))
    ripple.format = "PNG"
    return PBRMaterial(name=name, baseColorTexture=color, normalTexture=ripple,
                       roughnessFactor=.19, metallicFactor=0)
