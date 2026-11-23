"""Reconstruct the surveyed Sindora row at the Marina Boulevard waterfront."""

import argparse
import json
from pathlib import Path

from broadleaf_stand import bake_stand
from scanned_canopy import ROOT


def bake(scan_folder):
    reference = json.loads((ROOT / "references/marina-boulevard-sindora.json").read_text())
    trees = reference["trees"]
    digest, bounds = bake_stand(scan_folder, trees + reference["waterfrontCrowns"],
                                reference["aerialReferenceRGB"], "Marina Boulevard Sindora")
    return dict(entityId="bay.marina-boulevard-sindora", regionId="marina-bay-exterior", layer="ext",
                kind="structure", label="滨海大道 · 两侧行道树", assetHash=digest, bounds=bounds,
                material={"shading": "albedo"},
                props={"background": True, "surfaceRole": "landscape", "树木名录": reference["source"],
                       "树木依据": f"{len(trees)} 株 Sindora wallichii 的树位和高度档取自 NParks 2021 名录。冠幅、偏向与色差按 OneMap 航拍估读，档内高度与枝形为估值。",
                       "滨水步道":"03391 站朝湾一侧另有两株树，冠幅与冠心来自航拍，树种未确认。树高分别估为 12 米和 9 米，枝形借用同一扫描。",
                       "树形素材": "Poly Haven · Tree Small 02 · CC0。使用 Burkea africana 的枝叶与主干近似同为豆科的 Sindora。"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Directory containing the 1k Tree Small 02 glTF")
    record = bake(parser.parse_args().folder)
    path = ROOT / "build/streetscape.json"
    entries = {entry["entityId"]: entry for entry in json.loads(path.read_text())}
    entries[record["entityId"]] = record
    path.write_text(json.dumps(list(entries.values()), ensure_ascii=False, indent=2) + "\n")
    print(record["assetHash"])
