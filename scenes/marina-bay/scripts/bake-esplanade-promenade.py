"""Build the waterfront tree row from measured crown footprints in final scene coordinates."""
import argparse
from collections import defaultdict
from importlib import import_module
import json
from pathlib import Path

import numpy as np
import trimesh

from fullerton_shrubs import combined
from esplanade_quay import QuaySurface
from scanned_canopy import ROOT, write_tree_asset


def bake(spreading, compact):
    quay = QuaySurface()
    reference = json.loads((ROOT / 'references/esplanade-promenade-trees.json').read_text())
    forms = {}
    broadleaf = import_module('bake-city-street-trees').broadleaf
    for name, folder in [('jacaranda_tree', spreading), ('island_tree_01', compact)]:
        crown, trunk = broadleaf(folder, name, sprays=True)
        # The source spray meshes contain each face twice, once for each side.
        normals = crown.vertex_normals.copy()
        crown.update_faces(np.arange(0, len(crown.faces), 2))
        crown.vertex_normals = normals
        crown.visual.material.doubleSided = True
        crown.visual.material.name = name + ' promenade foliage'
        trunk.visual.material.name = name + ' promenade bark'
        forms[name] = crown, trunk

    batches, colors = defaultdict(list), defaultdict(list)
    median_rgb = np.median([tree['rgb'] for tree in reference['crowns']], axis=0)
    for tree in reference['crowns']:
        minor, major = tree['diameters']
        form = 'jacaranda_tree' if major > 8 or major / minor > 1.45 else 'island_tree_01'
        crown, trunk = forms[form]
        rng = np.random.default_rng(tree['crown'])
        yaw = trimesh.transformations.rotation_matrix(rng.uniform(-np.pi, np.pi), [0,1,0])[:3,:3]
        silhouette = crown.vertices @ yaw.T
        low, high = silhouette.min(axis=0), silhouette.max(axis=0)
        scale = [major / (high[0]-low[0]), tree['estimatedHeight'] / high[1], minor / (high[2]-low[2])]
        # A clockwise geographic bearing maps to (sin(heading-bearing), cos(heading-bearing)).
        angle = np.deg2rad(reference['heading'] - tree['bearing'])
        orient = np.array([[np.sin(angle),0,-np.cos(angle)], [0,1,0], [np.cos(angle),0,np.sin(angle)]])
        transform = orient @ np.diag(scale) @ yaw
        crown_center = (high + low) / 2
        crown_center[1] = 0
        base = np.array(tree['root']) - orient @ (crown_center * scale)
        deck_height = quay.height(base[[0, 2]])
        if deck_height is not None:
            base[1] = deck_height
        tint = np.clip(np.rint(230 * (np.array(tree['rgb']) / median_rgb) ** .65), 155, 255)
        for source in (crown, trunk):
            mesh = source.copy()
            normals = source.vertex_normals @ np.linalg.inv(transform)
            mesh.vertices = source.vertices @ transform.T + base
            # Collapsed vertices in the decimated bark can lack a usable normal.
            normals[np.linalg.norm(normals, axis=1) < 1e-12] = [0, 1, 0]
            mesh.vertex_normals = normals / np.linalg.norm(normals, axis=1)[:, None]
            name = mesh.visual.material.name
            batches[name].append(mesh)
            color = [*tint, 255] if source is crown else [255] * 4
            colors[name].append(np.tile(color, (len(mesh.vertices), 1)))

    scene = trimesh.Scene()
    for name, meshes in batches.items():
        mesh = combined(meshes)
        mesh.visual.vertex_attributes['color'] = np.vstack(colors[name]).astype(np.uint8)
        scene.add_geometry(mesh, geom_name=name)
    credit = 'Tree forms adapted from Poly Haven Jacaranda Tree and Island Tree 01, CC0. Crown footprints from OneMap, Singapore Land Authority.'
    digest, bounds = write_tree_asset(scene, copyright=credit)
    entity = dict(entityId='bay.esplanade-promenade-trees', layer='ext', kind='object',
                  regionId='marina-bay-exterior', label='滨海艺术中心 · 临水步道树列',
                  bounds=bounds, assetHash=digest, material={'shading':'albedo'},
                  props={'background':True, 'surfaceRole':'landscape', '影像来源':reference['orthophoto'],
                         '树冠数':len(reference['crowns']), '素材来源':credit,
                         '树木依据':'按航拍树冠位置、长短轴及色差布设。树形与高度为估计。'})
    (ROOT / 'build/esplanade-promenade-trees.json').write_text(json.dumps(entity, ensure_ascii=False, indent=2)+'\n')
    print(digest, (ROOT / 'assets' / (digest + '.glb')).stat().st_size)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('spreading', type=Path, help='Poly Haven Jacaranda Tree 1k glTF directory')
    parser.add_argument('compact', type=Path, help='Poly Haven Island Tree 01 1k glTF directory')
    args = parser.parse_args()
    bake(args.spreading, args.compact)
