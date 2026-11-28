"""Summarize one foreground replay from requestAnimationFrame timestamps in milliseconds."""

import argparse
import json
import math
from pathlib import Path


def percentile(ordered, fraction):
    rank = (len(ordered) - 1) * fraction
    low = math.floor(rank)
    weight = rank - low
    return ordered[low] * (1 - weight) + ordered[math.ceil(rank)] * weight


def summarize(timestamps, start, end, threshold):
    if not isinstance(timestamps, list) or len(timestamps) < 2:
        raise ValueError("Supply a JSON array with at least two frame timestamps in ms.")
    if not all(type(t) in (float, int) and math.isfinite(t) for t in timestamps):
        raise ValueError("Frame timestamps must be finite numbers.")
    elapsed = [t - timestamps[0] for t in timestamps]
    if any(b <= a for a, b in zip(elapsed, elapsed[1:])):
        raise ValueError("Frame timestamps must increase. Analyze each replay separately.")
    if end is None:
        end = elapsed[-1]
    if not (0 <= start < end <= elapsed[-1]):
        raise ValueError("The selected phase must lie inside the recorded route.")
    if not math.isfinite(threshold) or threshold <= 0:
        raise ValueError("The long-frame threshold must be finite and positive.")

    # Attribute each complete interval to the phase where its first frame started.
    # Adjacent phases therefore count an interval crossing their boundary exactly once.
    intervals = [(a, b) for a, b in zip(elapsed, elapsed[1:]) if start <= a < end]
    if not intervals:
        raise ValueError("No interval starts inside the selected phase.")
    ordered = sorted(b - a for a, b in intervals)
    worst_start, worst_end = max(intervals, key=lambda pair: pair[1] - pair[0])
    long_frames = [gap for gap in ordered if gap > threshold]
    return {
        "phase_ms": [start, end],
        "sampled_ms": [intervals[0][0], intervals[-1][1]],
        "intervals": len(ordered),
        "p50_ms": round(percentile(ordered, 0.5), 3),
        "p95_ms": round(percentile(ordered, 0.95), 3),
        "p99_ms": round(percentile(ordered, 0.99), 3),
        "worst_ms": round(ordered[-1], 3),
        "worst_interval_ms": [worst_start, worst_end],
        "threshold_ms": threshold,
        "long_intervals": len(long_frames),
        "time_above_threshold_ms": round(sum(gap - threshold for gap in long_frames), 3),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("timestamps", type=Path, help="JSON array of rAF timestamps in ms")
    parser.add_argument("--start-ms", type=float, default=0, help="inclusive, relative to first frame")
    parser.add_argument("--end-ms", type=float, help="exclusive, relative to first frame")
    parser.add_argument("--threshold-ms", type=float, default=50)
    args = parser.parse_args()
    try:
        with args.timestamps.open(encoding="utf-8") as source:
            result = summarize(json.load(source), args.start_ms, args.end_ms, args.threshold_ms)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
