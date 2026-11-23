"""Rebuild the photographed waterfront arcade in the Shoppes at Marina Bay Sands atlas."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates

from facade_atlas import replace_atlas
from sands_glazing import CREDIT, PROJECTION

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "54795e699927d46b1d354d4f17e59fb7142cd073937b84bed3d4cf5e689586be"
ENTITY = "bay.e33331a5-741c-41d1-b700-4fe77186a470"


def shopping_glass(image):
    # These three corners of the 58 m waterfront facade define its atlas-to-world map.
    texels = np.array([[638.6, 939.7], [638.6, 870.6], [493.6, 939.7]])
    world = np.array([[-286.487, -60.036, 539.320], [-286.487, -37.5, 539.320],
                      [-291.721, -60.036, 597.206]])
    transform = np.linalg.solve(texels[1:] - texels[0], world[1:] - world[0])
    with Image.open(ROOT / "references/sands-waterfront-shopping-glass.png") as reference:
        photo = np.array(reference.convert("RGB"), dtype=float)
    # Reference crop starts at (2960, 890) in the same photograph as the hotel crop.
    delta = np.array([2960 - 2344, 890 - 155])
    atlas = np.array(image.convert("RGB"))
    y, x = np.mgrid[869:940, 494:639]
    samples = np.zeros((*y.shape, 3))
    for dx, dy in [(.25, .25), (.75, .25), (.25, .75), (.75, .75)]:
        pos = (np.stack((x + dx, y + dy), axis=-1) - texels[0]) @ transform + world[0]
        p = pos @ PROJECTION[:, :3].T + PROJECTION[:, 3]
        u, v = (p[:, :, :2] / p[:, :, 2:] - delta).transpose(2, 0, 1)
        # Continue the vertical fins behind the foreground tree using a clear
        # neighbouring bay. Take the entrance below the rail from visible glass.
        foliage = np.clip((45 - u) / 6, 0, 1) * np.clip((v - 36) / 7, 0, 1)
        donor = 53 + (u - 53) % 8
        v = np.minimum(v, 110)
        for channel in range(3):
            layer = photo[:, :, channel]
            a = map_coordinates(layer, [v, u], order=1, mode="nearest")
            b = map_coordinates(layer, [v, donor], order=1, mode="nearest")
            samples[:, :, channel] += (a * (1 - foliage) + b * foliage) / 4
    atlas[y, x] = np.clip(np.rint(samples), 0, 255).astype(np.uint8)
    return Image.fromarray(atlas)


def bake(source):
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE:
        raise ValueError("Expected the original Shoppes at Marina Bay Sands mesh")
    data = replace_atlas(raw, shopping_glass, CREDIT)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / f"{digest}.glb").write_bytes(data)
    path = ROOT / "build/onemap-entities.json"
    entities = json.loads(path.read_text())
    shop = next(e for e in entities if e["entityId"] == ENTITY)
    shop["assetHash"] = digest
    shop["props"].update({"原建筑资源": SOURCE, "玻璃影像署名": CREDIT,
                          "立面处理": "购物中心临湾中央玻璃依鱼尾狮公园实拍配准。树冠和行人遮挡处的立柱与底层玻璃按邻窗估补。"})
    path.write_text(json.dumps(entities, ensure_ascii=False, indent=2) + "\n")
    print(digest)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    bake(parser.parse_args().source)
