"""Rebuild the surveyed canopy along the Promontory waterfront in final member coordinates."""

import argparse
import json
from pathlib import Path

import numpy as np

from broadleaf_stand import bake_stand
from scanned_canopy import ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scan", type=Path, help="Poly Haven Tree Small 02, 1k glTF directory")
    args = parser.parse_args()
    survey = json.loads((ROOT / "references/promontory-canopy.json").read_text())
    trees = survey["trees"]
    median = np.median([tree["aerialRGB"] for tree in trees], axis=0)
    digest, bounds = bake_stand(args.scan, trees, median, "Promontory waterfront canopy")
    record = ROOT / "build/promontory-canopy.json"
    entity = json.loads(record.read_text())
    entity.update(assetHash=digest, bounds=bounds)
    record.write_text(json.dumps(entity, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
