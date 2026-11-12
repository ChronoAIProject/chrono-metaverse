"""按场景配置与实体区边界配准宿主模型，并生成近景剖面和远景外壳。"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import trimesh
from scipy.spatial import ConvexHull
from context_geometry import floor_outline
from scene_config import foreground_entities

ROOT = Path(__file__).resolve().parents[1]
# 空间协议的网格单位，所有场景一致。
GRID_UNIT = 0.05


def world_meshes(root, entity):
    scene = trimesh.load_scene(root / 'assets' / f"{entity['assetHash']}.glb", process=False)
    bounds = np.array([entity['bounds']['min'], entity['bounds']['max']])
    center = bounds.mean(axis=0)
    center[1] = bounds[0, 1]
    result = []
    for node in scene.graph.nodes_geometry:
        matrix, key = scene.graph[node]
        mesh = scene.geometry[key].copy()
        mesh.apply_transform(matrix)
        mesh.vertices += center
        result.append(mesh)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=ROOT)
    args = parser.parse_args()
    root = args.workspace.resolve()
    config = json.loads((root / 'context.json').read_text())['host']
    space = json.loads((root / 'space.json').read_text())
    workspace = json.loads((root / 'metaverse.json').read_text())
    plot = next(p for p in space['plots'] if p['id'] == workspace['plot'])
    region = next(r for r in space['regions'] if r['id'] == config['focusRegionId'])
    boxes = np.array(region['boxes'], dtype=float) * GRID_UNIT
    region_min = boxes[:, :3].min(axis=0)
    region_max = boxes[:, 3:].max(axis=0)
    margin = config['boundaryMarginMeters']
    overlap = config['sliceOverlapMeters']
    low = region_min - margin
    high = region_max + margin
    cut_lower = low[1] - overlap
    cut_upper = region_max[1] + overlap
    section_height = config['sectionHeightMeters']
    source_alignment = json.loads((root / 'build/alignment.json').read_text())
    tower = json.loads((root / config['modelFile']).read_text())[0]
    office = foreground_entities(json.loads((root / 'entities.json').read_text()))
    glazing = next(e for e in office if e['entityId'] == config['facadeEntityId'])
    floor = next(e for e in office if e['entityId'] == config['floorEntityId'])['shape']
    outline = floor_outline(floor)
    meshes = world_meshes(root, tower)
    merged = trimesh.util.concatenate(meshes)
    segments = trimesh.intersections.mesh_plane(merged, [0, 1, 0], [0, section_height, 0])
    points = np.unique(np.round(segments.reshape(-1, 3)[:, [0, 2]], 5), axis=0)
    hull = points[ConvexHull(points).vertices]
    edges = []
    facade_direction = np.array(config['facadeDirection'], dtype=float)
    facade_direction /= np.linalg.norm(facade_direction)
    for a, b in zip(hull, np.roll(hull, -1, axis=0)):
        delta = b - a
        length = np.linalg.norm(delta)
        normal = np.array([delta[1], -delta[0]]) / length
        if normal @ facade_direction > config['facadeNormalMinDot'] and length > config['facadeEdgeMinLengthMeters']:
            edges.append((length, a, b, normal))
    assert edges, '在指定方向找不到宿主外墙'
    # 对这一侧的整条外墙求加权方向，不用整栋楼最远的角点。
    length = sum(e[0] for e in edges)
    normal = sum(e[0] * e[3] for e in edges) / length
    normal /= np.linalg.norm(normal)
    facade = sum(e[0] * (e[1] + e[2]) / 2 for e in edges) / length
    window_yaw = glazing['shape']['transform']['yaw'] - 180
    facade_yaw = math.degrees(math.atan2(normal[0], normal[1]))
    yaw = window_yaw - facade_yaw
    angle = math.radians(yaw)
    rotation = np.array([[math.cos(angle), 0, math.sin(angle)], [0, 1, 0], [-math.sin(angle), 0, math.cos(angle)]])
    window_normal = np.array([math.sin(math.radians(window_yaw)), math.cos(math.radians(window_yaw))])
    # 官方外墙与扫描窗玻璃存在窗台厚度；让整块现有室内地面都落在楼体内。
    support = (outline @ window_normal).max() + config['facadeInsetMeters']
    target_x, target_z = (outline.min(axis=0) + outline.max(axis=0)) / 2
    # 沿法向占比更大的轴求交，适用于任意朝向，避免接近零的分母。
    if abs(window_normal[1]) >= abs(window_normal[0]):
        target_z = (support - window_normal[0] * target_x) / window_normal[1]
    else:
        target_x = (support - window_normal[1] * target_z) / window_normal[0]
    target = np.array([target_x, section_height, target_z])
    shift = target - rotation @ np.array([facade[0], section_height, facade[1]])
    placed_hull = (np.column_stack([hull[:, 0], np.zeros(len(hull)), hull[:, 1]]) @ rotation.T + shift)[:, [0, 2]]
    halfspaces = ConvexHull(placed_hull).equations
    distances = outline @ halfspaces[:, :2].T + halfspaces[:, 2]
    assert distances.max() < -config['minimumClearanceMeters'], '主体地面仍有部分在宿主模型外'
    office_bounds = np.array([
        np.min([e['bounds']['min'] for e in office if e.get('bounds')], axis=0),
        np.max([e['bounds']['max'] for e in office if e.get('bounds')], axis=0),
    ])
    focus = office_bounds.mean(axis=0).tolist()
    far_view = {'focus': focus, 'minDistance': config['overviewDistanceMeters']}
    near_view = {'focus': focus, 'maxDistance': config['overviewDistanceMeters']}
    host = []
    prefix = config['entityPrefix']
    label = config['label']
    level_label = config['levelLabel']

    def save(entity_id, label, parts, props):
        bounds = np.array([np.min([m.bounds[0] for m in parts], axis=0), np.max([m.bounds[1] for m in parts], axis=0)])
        center = bounds.mean(axis=0)
        center[1] = bounds[0, 1]
        for mesh in parts:
            mesh.vertices -= center
        blob = trimesh.Scene(parts).export(file_type='glb', include_normals=True)
        digest = hashlib.sha256(blob).hexdigest()
        (root / 'assets' / f'{digest}.glb').write_bytes(blob)
        host.append({
            'entityId': entity_id, 'layer': 'ext', 'kind': 'object', 'label': label,
            'regionId': plot['regionId'], 'assetHash': digest,
            'bounds': {'min': bounds[0].round(6).tolist(), 'max': bounds[1].round(6).tolist()},
            'props': {**tower['props'], **props, '三角形数': sum(len(m.faces) for m in parts), 'background': True},
        })

    # 只显示所在楼层以下的楼体，上方切开供室内查看；保留官方外墙贴图。
    lower = []
    for mesh in meshes:
        mesh.vertices = mesh.vertices @ rotation.T + shift
        cut = trimesh.intersections.slice_mesh_plane(mesh, [0, -1, 0], [0, cut_lower, 0], cap=False)
        if cut is not None and len(cut.faces):
            lower.append(cut)
    save(f'{prefix}-below-office', f'{label} · {level_label}以下楼体（剖面）', lower, {'处理说明': '保留办公室以下的官方楼体，上方剖开以查看室内'})
    host[-1]['props']['landmark'] = {
        'label': config['landmark']['label'],
        'position': (target + config['landmark']['offset']).tolist(),
        'minDistance': config['overviewDistanceMeters'],
        'focusBounds': {'min': office_bounds[0].tolist(), 'max': office_bounds[1].tolist()},
    }
    # 拉远后补回楼体上部；所有片段仍位于扩展地块，室内重建层保持原样。
    upper = [trimesh.intersections.slice_mesh_plane(mesh, [0, 1, 0], [0, cut_upper, 0], cap=False) for mesh in meshes]
    upper = [mesh for mesh in upper if mesh is not None and len(mesh.faces)]
    save(f'{prefix}-above-office', f'{label} · 完整楼体上部', upper, {'backgroundView': far_view, '处理说明': '远看时显示所在楼层以上的完整官方楼体'})
    zones = {
        'west': [([low[0], 0, 0], [-1, 0, 0])],
        'east': [([high[0], 0, 0], [1, 0, 0])],
        'north': [([low[0], 0, 0], [1, 0, 0]), ([high[0], 0, 0], [-1, 0, 0]), ([0, 0, low[2]], [0, 0, -1])],
        'south': [([low[0], 0, 0], [1, 0, 0]), ([high[0], 0, 0], [-1, 0, 0]), ([0, 0, high[2]], [0, 0, 1])],
    }
    for zone, planes in zones.items():
        parts = []
        for mesh in meshes:
            part = trimesh.intersections.slice_mesh_plane(mesh, [0, 1, 0], [0, cut_lower, 0], cap=False)
            part = trimesh.intersections.slice_mesh_plane(part, [0, -1, 0], [0, cut_upper, 0], cap=False)
            for origin, normal in planes:
                part = trimesh.intersections.slice_mesh_plane(part, normal, origin, cap=False)
                if part is None or not len(part.faces):
                    break
            if part is not None and len(part.faces):
                parts.append(part)
        if parts:
            save(f'{prefix}-office-facade-{zone}', f'{label} · {level_label}外墙', parts, {'backgroundView': far_view})
    # 官方数据没有室内楼板；按所在高度的楼体截面补一块示意结构板。
    count = len(placed_hull)
    vertices = np.array([[x, y, z] for y in [low[1] - config['slab']['thicknessMeters'], low[1]] for x, z in placed_hull])
    faces = []
    for i in range(1, count - 1):
        faces.extend([[0, i, i + 1], [count, count + i + 1, count + i]])
    for i in range(count):
        j = (i + 1) % count
        faces.extend([[i, count + i, count + j], [i, count + j, j]])
    slab = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    slab.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(baseColorFactor=config['slab']['color'], roughnessFactor=1, metallicFactor=0))
    save(f'{prefix}-office-slab', f'{label} · {level_label}示意结构楼板', [slab], {'backgroundView': near_view, '处理说明': '根据官方楼体截面生成的示意楼板，不代表完整室内平面图'})
    placement = {
        'yaw': yaw, 'translation': shift.tolist(),
        'headingDegrees': source_alignment['headingDegrees'] + yaw,
        'officeFloor': source_alignment['officeFloor'], 'officeHeightMeters': source_alignment['officeHeightMeters'],
        'note': config['note'],
        'sectionPolygon': placed_hull.tolist(),
        'officeContained': True, 'minimumFacadeClearanceMeters': float(-distances.max()),
        'hostEntities': host,
    }
    (root / 'build/placement.json').write_text(json.dumps(placement, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in placement.items() if k not in ['sectionPolygon', 'hostEntities']}, ensure_ascii=False))
    print(f'生成 {len(host)} 个楼体剖面物件，原有外景模型复用资源，仅调整摆放')


if __name__ == '__main__':
    main()
