"""Fit the three mapped trees beside the Dalhousie Obelisk to the OneMap canopy outlines."""
import argparse
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

from courtyard_tree import fit_crown, load_masked_tree, preserve_crown_normals
from fullerton_shrubs import combined
from scanned_canopy import ROOT, write_tree_asset


def bake(folder):
    survey = json.loads((ROOT / 'references/empress-lawn.json').read_text())
    trees = survey['gardenTrees']
    bark, leaves = load_masked_tree(folder)
    specimens = []
    for tree in trees:
        fit = tree['crownFit']
        major = np.asarray(fit['majorLocalXZ'])
        u, v = major / np.linalg.norm(major)
        basis = np.array([[u, 0, v], [0, 1, 0], [-v, 0, u]])
        half = .5 * tree['crownDiameterMetres'] * np.array([fit['stretch'], 1 / fit['stretch']])
        center = basis[np.ix_([0, 2], [0, 2])] @ fit['leanLocalXZ']
        x, z = tree['localXZ']
        foot = [x, tree['groundY'] - .03, z]
        specimens.append(fit_crown(bark, leaves, tree['estimatedHeightMetres'], 1.2,
                                   np.radians(tree['sourceYawDegrees']), foot, center-half, center+half, basis))
    scene = trimesh.Scene()
    for group in zip(*specimens, strict=True):
        mesh = combined(group)
        material = mesh.visual.material
        if material.name == 'Island tree branch clusters':
            preserve_crown_normals(mesh)
            atlas = material.baseColorTexture
            atlas.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            atlas.format = 'PNG'
        scene.add_geometry(mesh, geom_name=material.name)
    digest, bounds = write_tree_asset(scene)
    return dict(entityId='bay.empress-garden-trees', kind='structure', layer='ext',
                regionId='marina-bay-exterior', label='皇后坊 · 纪念碑园路树冠',
                assetHash=digest, bounds=bounds, material={'shading': 'albedo'},
                props={'background': True, 'surfaceRole': 'landscape',
                       '树位依据': [tree['osmNode'] for tree in trees],
                       '地图来源': '© OpenStreetMap contributors · ODbL',
                       '树冠依据': survey['ortho']['title'],
                       '现场照片': survey['photograph'],
                       '树形素材': 'Poly Haven · Island Tree 01 · CC0',
                       '植被依据': '树位来自地图，冠幅和偏向按正射影像估读。树高、胸围和枝形为近似值。'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path, help='Poly Haven Island Tree 01 source and original leaf mask')
    entry = bake(parser.parse_args().folder)
    path = ROOT / 'build/streetscape.json'
    entries = {e['entityId']: e for e in json.loads(path.read_text())}
    entries[entry['entityId']] = entry
    path.write_text(json.dumps(list(entries.values()), ensure_ascii=False, indent=2) + '\n')
    print(entry['assetHash'])
