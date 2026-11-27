"""Bake the palm groups on both banks of Dragonfly Lake from the OneMap crown survey."""
import argparse
from importlib import import_module
import json
from pathlib import Path

import trimesh

from scanned_canopy import ROOT, write_tree_asset


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='Directory containing the 0 A.D. royal palm models and textures')
    survey = json.loads((ROOT / 'references/dragonfly-palms.json').read_text())
    palms = import_module('bake-sands-waterfront-palms')
    stand = palms.palm_stand(parser.parse_args().source, survey['trees'], face_budget=1000)
    stand.visual.material.name = 'Dragonfly Lake palm fronds and bark'
    scene = trimesh.Scene()
    scene.add_geometry(stand, geom_name='Dragonfly Lake palm grove')
    sources = survey['sources']
    credit = ' | '.join([palms.CREDIT, sources['imagery'], sources['woodedHeight'], sources['shoreline']])
    digest, bounds = write_tree_asset(scene, copyright=credit)
    entity = {
        'entityId': 'bay.dragonfly-palm-grove', 'kind': 'structure', 'layer': 'ext',
        'regionId': 'marina-bay-exterior', 'label': '蜻蜓湖 · 棕榈林',
        'assetHash': digest, 'bounds': bounds, 'material': {'shading': 'albedo'},
        'props': {'background': True, 'surfaceRole': 'landscape', 'survey': survey['method'],
                  'attribution': credit},
    }
    (ROOT / 'build/dragonfly-palms.json').write_text(json.dumps(entity, indent=2, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
