"""从 Granite Tile 04 的 1K 原始 PNG 烘焙步道的线性表面贴图。"""

import argparse
from pathlib import Path

import numpy as np
from PIL import Image


def periodic_blur(field, radius):
    """周期高斯滤波，使跨贴图边界的石缝也能向邻石渗水。"""
    rows, cols = field.shape
    fy = np.fft.fftfreq(rows)[:, None]
    fx = np.fft.rfftfreq(cols)
    kernel = np.exp(-2 * np.pi**2 * radius**2 * (fx * fx + fy * fy))
    return np.fft.irfft2(np.fft.rfft2(field) * kernel, s=field.shape, axes=(0, 1))


def bake(height_path, normal_path, roughness_path, output):
    height = np.asarray(Image.open(height_path), dtype=float)
    normals = np.asarray(Image.open(normal_path).convert("RGB"))
    roughness = np.asarray(Image.open(roughness_path))
    if not (height.shape == normals.shape[:2] == roughness.shape == (1024, 1024)):
        raise ValueError("高度、OpenGL 法线和粗糙度须来自同一份 1K 扫描")
    # 用分位数归一化，避免扫描里最深的单个孔洞支配整片铺装。
    low, high = np.percentile(height, [2, 98])
    relief = (height - low) / (high - low)
    basin = periodic_blur(relief, 38) - periodic_blur(relief, 2)
    joint = np.clip((periodic_blur(relief, 4) - relief) * 2.4, 0, 1)
    rim = periodic_blur(joint, 5)
    retention = 0.22 + 2.2 * basin + 0.25 * (0.6 - relief) + 1.7 * rim + 0.65 * joint
    retention = np.clip(periodic_blur(retention, 1.2), 0, 1)
    # A 的下半区留空，避免浏览器解码半透明像素时损失法线的有效位。
    alpha = (128 + 4 * np.rint(31 * retention)).astype("uint8")
    scale = 255 / np.iinfo(roughness.dtype).max
    dry_roughness = np.rint(roughness * scale).astype("uint8")
    packed = np.dstack((normals[..., :2], dry_roughness, alpha))
    Image.fromarray(packed).save(output, lossless=True, method=6)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("height", "normal", "roughness", "output"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    bake(args.height, args.normal, args.roughness, args.output)
