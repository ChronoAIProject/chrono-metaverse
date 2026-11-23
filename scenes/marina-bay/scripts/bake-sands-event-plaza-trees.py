"""Place the six broadleaf crowns bordering the open Sands event plaza."""

import argparse
import json
from pathlib import Path

import numpy as np

from broadleaf_stand import bake_stand
from scanned_canopy import ROOT


def bake(scan_folder):
    reference = json.loads((ROOT / "references/sands-event-plaza-trees.json").read_text())
    trees = reference["trees"]
    median = np.median([tree["aerialRGB"] for tree in trees], axis=0)
    digest, bounds = bake_stand(scan_folder, trees, median, "Sands event plaza broadleaf")
    record = dict(entityId="bay.sands-event-plaza-trees", regionId="marina-bay-exterior", layer="ext",
                  kind="structure", label="金沙活动广场 · 临水阔叶树", assetHash=digest, bounds=bounds,
                  material={"shading": "albedo"}, props={
                      "background": True, "surfaceRole": "landscape",
                      "树木依据": "两侧六株阔叶树的冠心、冠幅与偏向取自 SLA / OneMap 正射影像。以冠心近似树位，按鱼尾狮公园实拍估读树高。",
                      "树形素材": "Poly Haven · Tree Small 02 · CC0。树种未确认，使用扫描阔叶树的枝干近似。",
                      "实拍参考": "https://commons.wikimedia.org/wiki/File:Marina_Bay_Sands_view_from_Merlion_Park,_Singapore_(Ank_Kumar)_01.jpg",
                  })
    path = ROOT / "build/streetscape.json"
    entries = {e["entityId"]: e for e in json.loads(path.read_text())}
    entries[record["entityId"]] = record
    path.write_text(json.dumps(list(entries.values()), ensure_ascii=False, indent=2) + "\n")
    print(digest)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="The Poly Haven Tree Small 02 source directory")
    bake(parser.parse_args().folder)
