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
    if args.mask:
        with Image.open(args.mask) as mask:
            check_size(mask, before.size, args.mask)
            region = mask.convert("L").point(lambda v: 255 if v >= 128 else 0)
        result["mask"] = measurements(region, stable, changed)
    if args.sheet:
        if args.sheet.resolve() in {p.resolve() for p in [args.before, args.after, *args.repeat, args.mask] if p}:
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
