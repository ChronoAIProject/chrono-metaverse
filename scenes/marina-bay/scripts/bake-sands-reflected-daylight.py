"""Refresh the height-dependent waterfront reflections and diffuse glass colour."""
import argparse
import hashlib
import json
from pathlib import Path

from facade_atlas import glb_blocks, pack_glb

ROOT = Path(__file__).resolve().parents[1]
SURVEY = ROOT / "references/sands-daylight"


def bake(raw, record, survey):
    if hashlib.sha256(raw).hexdigest() != record["source"]:
        raise ValueError(f"Unexpected source model for {record['entityId']}")
    document, blocks = glb_blocks(raw)
    material, = [m for m in document["materials"] if m["name"] == survey["material"]]
    pbr = material["pbrMetallicRoughness"]
    pbr["baseColorFactor"][2] *= survey["blueFactor"]
    texture = document["textures"][material["emissiveTexture"]["index"]]
    image = document["images"][texture["source"]]
    blocks[image["bufferView"]] = (SURVEY / record["atlas"]).read_bytes()
    return pack_glb(document, blocks)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, default=ROOT / "assets")
    parser.add_argument("--output", type=Path, default=ROOT / "assets")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    survey = json.loads((SURVEY / "survey.json").read_bytes())
    for record in survey["buildings"]:
        data = bake((args.sources / (record["source"] + ".glb")).read_bytes(), record, survey)
        digest = hashlib.sha256(data).hexdigest()
        (args.output / (digest + ".glb")).write_bytes(data)
        print(record["entityId"], digest)
