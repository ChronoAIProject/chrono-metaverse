"""Replace the published NParks street-tree tiles in final member coordinates."""
import argparse
import hashlib
import json
import subprocess
from collections import defaultdict
from pathlib import Path
from importlib import import_module

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from fullerton_shrubs import combined
from scanned_canopy import ROOT, sample_scan, slices, write_tree_asset
from street_foliage import branch_sprays

PALM_GENERA = {'Washingtonia', 'Dypsis', 'Roystonea', 'Bismarckia', 'Phoenix'}
SPREADING = {'Samanea', 'Peltophorum', 'Libidibia', 'Delonix', 'Pterocarpus'}
CREDIT = "Poly Haven: Tree Small 02, Island Tree 01 and Jacaranda Tree (CC0), adapted to layered crown meshes."
PALM_CREDIT = ("Royal palm mesh and textures adapted from 0 A.D., Wildfire Games, "
               "https://wildfiregames.com/, CC BY-SA 3.0, https://creativecommons.org/licenses/by-sa/3.0/. "
               "Scaled, rotated and batched for the street-tree census.")


def broadleaf(folder, name, sprays=False, distant=False):
    points, colours, leaves, trunk = sample_scan(folder, name)
    if distant:
        # Distant stems and leaves share the same textured depth sections. Including
        # the scanned bark keeps the root and fork visible without a separate draw.
        xyz, uv, normals, faces, atlas = slices(points, colours, np.ones_like(leaves),
                                                layer_count=2, cells=2)
    elif sprays:
        (xyz, uv, normals, faces), atlas = branch_sprays(points, colours, leaves)
    else:
        xyz, uv, normals, faces, atlas = slices(points, colours, leaves, fit_opacity=True, layer_count=3, cells=2)
    crown_paint = PBRMaterial(name=name + " street foliage", baseColorTexture=atlas, metallicFactor=0,
                              roughnessFactor=.95, alphaMode="MASK", alphaCutoff=.36)
    foliage = trimesh.Trimesh(vertices=xyz, faces=faces, vertex_normals=normals,
                              visual=TextureVisuals(uv=uv, material=crown_paint), process=False)
    foot = np.median(trunk.vertices[trunk.vertices[:, 1] < .08], axis=0)
    foot[1] = trunk.bounds[0, 1]
    foliage.apply_translation(-foot)
    if distant:
        return [foliage]
    bark_map = trunk.visual.material.baseColorTexture.resize((256, 256), Image.Resampling.LANCZOS)
    bark_map.format = "JPEG"
    trunk.visual.material.baseColorTexture = bark_map
    trunk.apply_translation(-foot)
    return [foliage, trunk]


def palm(folder):
    reference = json.loads((ROOT / 'references/sands-waterfront-palms.json').read_text())
    for name, digest in reference['sourceHashes'].items():
        if hashlib.sha256((folder / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f"Unexpected palm resource {name}")
    xyz, normals, uv, triangles = import_module('bake-sands-waterfront-palms').read_palm(
        folder / 'tree_roystonea_regia_d.dae')
    paint = PBRMaterial(name='Census palm fronds and trunk', baseColorTexture=Image.open(folder/'palm_royal.png'),
                        normalTexture=Image.open(folder/'palm_areca_norm.png'), baseColorFactor=[125,176,168,255],
                        alphaMode='MASK', alphaCutoff=.38, doubleSided=True, roughnessFactor=.93, metallicFactor=0)
    # Keep the alpha-mapped fronds while reducing their interior triangle density.
    request = dict(faces=triangles.ravel().tolist(), position=xyz.ravel().tolist(),
                   attributes=np.column_stack((normals, uv)).ravel().tolist(),
                   targetTriangles=720, maxError=.025)
    result = subprocess.run(["node", str(Path(__file__).with_name("simplify-skypark-tree.mjs"))],
                            input=json.dumps(request), text=True, capture_output=True, check=True)
    triangles = np.asarray(json.loads(result.stdout)).reshape(-1, 3)
    span = np.ptp(xyz, axis=0)
    normals *= span
    normals /= np.linalg.norm(normals, axis=1)[:, None]
    return [trimesh.Trimesh(vertices=xyz/span, faces=triangles, vertex_normals=normals,
                            visual=TextureVisuals(uv=uv, material=paint), process=False)]


def bake(folders, selected_tile=None):
    reference = json.loads((ROOT/'references/city-street-trees.json').read_text())
    output = ROOT/'build/city-street-trees.json'
    if selected_tile and selected_tile not in reference['tiles']:
        raise ValueError(f'Unknown street-tree tile {selected_tile}')
    records = {e['entityId']: e for e in json.loads(output.read_text())} if selected_tile else {}
    source_folders = dict(zip(('tree_small_02', 'island_tree_01', 'jacaranda_tree'), folders[:3]))
    models = {}
    for key, tile in reference['tiles'].items():
        if selected_tile and selected_tile != key:
            continue
        groups = defaultdict(list)
        painted = defaultdict(list)
        palms = 0
        for tree_id, x, y, z, height, width, species in tile['trees']:
            rng = np.random.default_rng(tree_id)
            genus = species.split()[0]
            if genus in PALM_GENERA:
                form = 'palm'
                palms += 1
            elif genus in SPREADING:
                form = 'jacaranda_tree'
                if not tile.get('surveyedCrownWidths'):
                    width = max(width, height * rng.uniform(.88, 1.18))
            elif genus in {'Sindora', 'Khaya', 'Millettia', 'Dalbergia'}:
                form = 'tree_small_02'
            else:
                form = 'island_tree_01'
            yaw = rng.uniform(-np.pi, np.pi)
            rotation = trimesh.transformations.rotation_matrix(yaw, [0,1,0])[:3, :3]
            scale = np.array([width, height, width*rng.uniform(.85,1.09)])
            leaf_tint = np.rint(np.array([235,240,225])*rng.uniform(.85,1.05)).clip(0,255)
            detailed = tile.get('branchSprays') or (tile.get('spreadingBranches') and form == 'jacaranda_tree')
            distant = tile.get('distantCrowns', False)
            cache_key = (form, bool(detailed), distant)
            if cache_key not in models:
                models[cache_key] = (palm(folders[3]) if form == 'palm' else
                                     broadleaf(source_folders[form], form, sprays=detailed, distant=distant))
            model = models[cache_key]
            for source in model:
                mesh = source.copy()
                mesh.vertices = (source.vertices * scale) @ rotation.T + [x,y,z]
                normals = (source.vertex_normals / scale) @ rotation.T
                # Limit only the road-facing branches of surveyed trees beside raised decks.
                edge = tile.get('flyoverEdges', {}).get(str(tree_id))
                if edge is not None:
                    axis = np.array([edge[2], 0., edge[3]])
                    distance = (mesh.vertices - [edge[0], y, edge[1]]) @ axis
                    # A smooth maximum bends growth back into the verge and keeps continuous normals.
                    clearance = np.logaddexp(0., distance)
                    mesh.vertices += np.outer(clearance - distance, axis)
                    slope = 1 / (1 + np.exp(-distance))
                    normals += np.outer((normals @ axis) * (1 / slope - 1), axis)
                mesh.vertex_normals = normals / np.linalg.norm(normals, axis=1)[:,None]
                group = source.visual.material.name
                groups[group].append(mesh)
                tint = source.visual.vertex_attributes.get("color")
                painted[group].append(tint if tint is not None else
                                      np.tile([*leaf_tint,255], (len(mesh.vertices),1)))
        scene = trimesh.Scene()
        for group, meshes in groups.items():
            mesh = combined(meshes)
            mesh.visual.vertex_attributes['color'] = np.vstack(painted[group]).astype(np.uint8)
            scene.add_geometry(mesh, geom_name=group)
        credit = CREDIT + (' ' + PALM_CREDIT if palms else '')
        digest, bounds = write_tree_asset(scene, copyright=credit)
        records[key] = dict(entityId=key, kind='object', layer='ext', regionId='marina-bay-exterior',
                            label=tile.get('label', '滨海湾 · 街道与滨水树冠'), assetHash=digest, bounds=bounds,
                            material={'shading':'albedo'}, props={'background':True,'surfaceRole':'landscape',
                            '位置来源':reference['source'], '树位数':len(tile['trees']), '棕榈数':palms,
                            '已单独建模树位数':len(tile['coveredTreeIds']), '树形素材':credit,
                            '树冠':'树位按 NParks 名录。按树形选用扫描阔叶树或游戏棕榈近似，冠幅和高度为估值。'})
        print(key, len(tile['trees']), digest, flush=True)
    output.write_text(json.dumps(list(records.values()), ensure_ascii=False, indent=2)+'\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folders', type=Path, nargs=4, metavar='SOURCE',
                        help='Tree Small 02, Island Tree 01, Jacaranda Tree, and 0 A.D. royal palm directories')
    parser.add_argument("--tile", help="Rebuild a single census tile in the existing manifest")
    args = parser.parse_args()
    bake(args.folders, args.tile)
