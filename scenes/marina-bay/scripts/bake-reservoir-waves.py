"""Generate the two linear wave slope/moment maps used by the Web viewer."""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image


def bake(output):
    output.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(1066)
    size = 512
    for name, period, low, high in [("gravity", 32, 0.35, 6), ("ripples", 8, 6, 43)]:
        axis = 2 * np.pi * np.fft.fftfreq(size, period / size)
        kx, ky = np.meshgrid(axis, axis)
        frequency = np.maximum(np.hypot(kx, ky), 0.001)
        # Directionally spread k^-4 height spectrum, windowed at both ends.
        direction = 0.12 + 0.88 * np.square(ky / frequency)
        power = direction * np.exp(-(low / frequency)**2 - (frequency / high)**4) / frequency**4
        height = np.fft.fft2(rng.normal(size=(size, size))) * np.sqrt(power)
        gradient = np.stack([np.fft.ifft2(1j * k * height).real for k in [kx, ky]], axis=-1)
        gradient /= np.sqrt(np.mean(np.sum(gradient**2, axis=-1)))

        signed = np.rint(127.5 + 36 * gradient).clip(0, 255)
        represented = (signed - 127.5) / 36
        moments = represented**2 * [28, 23] + [1, 32]
        channels = np.concatenate([signed, moments], axis=-1)
        # Prefilter the signed slope and squared slope separately. Subsequent GPU
        # mip levels can recover the unresolved variance from their difference.
        texels = channels.reshape(256, 2, 256, 2, 4).mean(axis=(1, 3))
        image = Image.fromarray(np.uint8(np.rint(texels).clip(0, 255)))
        image.save(output / f"reservoir-{name}.webp", lossless=True, exact=True, method=6)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    bake(parser.parse_args().output)
