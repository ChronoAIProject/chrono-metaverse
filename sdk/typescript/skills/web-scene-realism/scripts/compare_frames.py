"""Measure paired browser screenshots at their original resolution. Requires Pillow."""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


def read_frame(path):
    with Image.open(path) as image:
        rgba = image.convert("RGBA")
        if rgba.getchannel("A").getextrema()[0] < 255:
            raise ValueError(f"Composite {path} over the viewer background before comparing.")
        return rgba.convert("RGB")


def check_size(image, expected, path):
    if image.size != expected:
        raise ValueError(f"{path} is {image.size}, expected {expected}.")


def difference(before, after):
    red, green, blue = ImageChops.difference(before, after).split()
    return ImageChops.lighter(ImageChops.lighter(red, green), blue)


def count(mask):
    return mask.histogram()[255]


def measurements(region, stable, changed):
    visible = count(region)
    usable = ImageChops.multiply(region, stable)
    samples = count(usable)
    changes = count(ImageChops.multiply(usable, changed))
    pixels = region.width * region.height
    return {
        "region_pixels": visible,
        "excluded_unstable_pixels": visible - samples,
        "changed_pixels": changes,
        "changed_percent_of_frame": round(100 * changes / pixels, 4),
        "changed_percent_of_stable_region": round(100 * changes / samples, 4) if samples else None,
    }


def reference_errors(before, after, references, regions):
    # Load this optional dependency only for linear-light reference comparisons.
    try:
        import numpy as np
    except ImportError as error:
        raise ValueError("Install NumPy to compare against reference frames.") from error

    srgb = np.arange(256, dtype=np.float64) / 255
    linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)

    def luminance(frame):
        red, green, blue = np.asarray(frame).transpose(2, 0, 1)
        return 0.2126 * linear[red] + 0.7152 * linear[green] + 0.0722 * linear[blue]

    baseline, candidate = luminance(before), luminance(after)
    masks = {name: np.asarray(mask) != 0 for name, mask in regions.items()}
    results = []
    for path in references:
        reference = read_frame(path)
        check_size(reference, before.size, path)
        target = luminance(reference)
        errors = {"path": str(path)}
        for name, mask in masks.items():
            count = int(np.count_nonzero(mask))
            errors[name] = {
                "stable_pixels": count,
                "before_mae": float(np.abs(baseline[mask] - target[mask]).mean()) if count else None,
                "after_mae": float(np.abs(candidate[mask] - target[mask]).mean()) if count else None,
            }
        results.append(errors)
    return results


def compare(args):
    before = read_frame(args.before)
    after = read_frame(args.after)
    check_size(after, before.size, args.after)
    full = Image.new("L", before.size, 255)
    stable = full
    for path in args.repeat:
        repeat = read_frame(path)
        check_size(repeat, before.size, path)
        passing = difference(before, repeat).point(lambda v: 255 if v <= args.noise else 0)
        stable = ImageChops.multiply(stable, passing)

    changed = difference(before, after).point(lambda v: 255 if v > args.threshold else 0)
    result = {
        "size": before.size,
        "repeat_count": len(args.repeat),
        "noise_threshold": args.noise,
        "change_threshold": args.threshold,
        "frame": measurements(full, stable, changed),
    }
    regions = {"frame": stable}
    if args.mask:
        with Image.open(args.mask) as mask:
            check_size(mask, before.size, args.mask)
            region = mask.convert("L").point(lambda v: 255 if v >= 128 else 0)
        result["mask"] = measurements(region, stable, changed)
        regions["mask"] = ImageChops.multiply(region, stable)
    if args.reference:
        result["linear_luminance_references"] = reference_errors(before, after, args.reference, regions)
    if args.sheet:
        if args.sheet.resolve() in {p.resolve() for p in [args.before, args.after, *args.repeat, *args.reference, args.mask] if p}:
            raise ValueError("The comparison sheet needs its own output path.")
        sheet = Image.new("RGB", (2 * before.width, before.height + 24), "#22272b")
        labels = ImageDraw.Draw(sheet)
        for x, frame, name in [(0, before, "Before"), (before.width, after, "After")]:
            sheet.paste(frame, (x, 24))
            labels.text((x + 6, 5), name, fill="white")
        sheet.save(args.sheet)
    return result


def threshold(value):
    n = int(value)
    if not 0 <= n <= 255:
        raise argparse.ArgumentTypeError("Use an 8-bit channel difference from 0 to 255.")
    return n


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    parser.add_argument("--repeat", action="append", default=[], type=Path,
                        help="Repeated baseline, zero-strength or restored frame. May be repeated.")
    parser.add_argument("--reference", action="append", default=[], type=Path,
                        help="Same-camera sRGB reference. May be repeated. Requires NumPy.")
    parser.add_argument("--mask", type=Path, help="Optional grayscale region mask, 128–255 included.")
    parser.add_argument("--noise", type=threshold, default=1, help="Maximum tolerated repeat difference.")
    parser.add_argument("--threshold", type=threshold, default=3, help="Minimum change, exclusive.")
    parser.add_argument("--sheet", type=Path, help="Save a full-resolution side-by-side image.")
    args = parser.parse_args()
    try:
        print(json.dumps(compare(args), indent=2))
    except (ValueError, OSError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
