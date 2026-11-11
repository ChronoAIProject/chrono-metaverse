"""用办公室所在高度的 Tower 1 外墙配准，并生成楼内剖面背景。"""
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import trimesh
from scipy.spatial import ConvexHull

ROOT = Path(__file__).resolve().parents[1]


def world_meshes(entity):
    scene = trimesh.load_scene(ROOT / 'assets' / f"{entity['assetHash']}.glb", process=False)
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
    tower = json.loads((ROOT / 'build/own-tower.json').read_text())[0]
    office = json.loads((ROOT / 'entities.json').read_text())
    glazing = next(e for e in office if e['entityId'] == 'rb.glazing-z15.38-1')
    floor = next(e for e in office if e['entityId'] == 'rb.floor')['shape']
    outline = np.array(floor['outline']['points']) + np.array(floor['transform']['position'])[[0, 2]]
    meshes = world_meshes(tower)
    merged = trimesh.util.concatenate(meshes)
    segments = trimesh.intersections.mesh_plane(merged, [0, 1, 0], [0, 1.4, 0])
    points = np.unique(np.round(segments.reshape(-1, 3)[:, [0, 2]], 5), axis=0)
    hull = points[ConvexHull(points).vertices]
    edges = []
    for a, b in zip(hull, np.roll(hull, -1, axis=0)):
        delta = b - a
        length = np.linalg.norm(delta)
        normal = np.array([delta[1], -delta[0]]) / length
        if normal[1] > 0.98 and length > 3:
            edges.append((length, a, b, normal))
    assert edges, '找不到临滨海湾的 Tower 1 外墙'
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
    support = (outline @ window_normal).max() + 0.12
    target_x = float(np.mean([outline[:, 0].min(), outline[:, 0].max()]))
    target = np.array([target_x, 1.4, (support - window_normal[0] * target_x) / window_normal[1]])
    shift = target - rotation @ np.array([facade[0], 1.4, facade[1]])
    placed_hull = (np.column_stack([hull[:, 0], np.zeros(len(hull)), hull[:, 1]]) @ rotation.T + shift)[:, [0, 2]]
    halfspaces = ConvexHull(placed_hull).equations
    distances = outline @ halfspaces[:, :2].T + halfspaces[:, 2]
    assert distances.max() < -0.05, '办公室地面仍有部分在 Tower 1 外'
    host = []

    def save(entity_id, label, parts, props):
        bounds = np.array([np.min([m.bounds[0] for m in parts], axis=0), np.max([m.bounds[1] for m in parts], axis=0)])
        center = bounds.mean(axis=0)
        center[1] = bounds[0, 1]
        for mesh in parts:
            mesh.vertices -= center
        blob = trimesh.Scene(parts).export(file_type='glb', include_normals=True)
        digest = hashlib.sha256(blob).hexdigest()
        (ROOT / 'assets' / f'{digest}.glb').write_bytes(blob)
        host.append({
            'entityId': entity_id, 'layer': 'ext', 'kind': 'object', 'label': label,
            'regionId': 'marina-bay-exterior', 'assetHash': digest,
            'bounds': {'min': bounds[0].round(6).tolist(), 'max': bounds[1].round(6).tolist()},
            'props': {**tower['props'], **props, '三角形数': sum(len(m.faces) for m in parts), 'background': True},
        })

    # 只显示所在楼层以下的楼体，上方切开供室内查看；保留官方外墙贴图。
    lower = []
    for mesh in meshes:
        mesh.vertices = mesh.vertices @ rotation.T + shift
        cut = trimesh.intersections.slice_mesh_plane(mesh, [0, -1, 0], [0, -0.13, 0], cap=False)
        if cut is not None and len(cut.faces):
            lower.append(cut)
    save('bay.tower1-below-office', 'MBFC Tower 1 · 十四层以下楼体（剖面）', lower, {'处理说明': '保留办公室以下的官方楼体，上方剖开以查看室内'})
    # 官方数据没有室内楼板；按所在高度的楼体截面补一块示意结构板。
    count = len(placed_hull)
    vertices = np.array([[x, y, z] for y in [-0.37, -0.12] for x, z in placed_hull])
    faces = []
    for i in range(1, count - 1):
        faces.extend([[0, i, i + 1], [count, count + i + 1, count + i]])
    for i in range(count):
        j = (i + 1) % count
        faces.extend([[i, count + i, count + j], [i, count + j, j]])
    slab = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    slab.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(baseColorFactor=[145, 147, 150, 255], roughnessFactor=1, metallicFactor=0))
    save('bay.tower1-office-slab', 'MBFC Tower 1 · 十四层示意结构楼板', [slab], {'处理说明': '根据官方楼体截面生成的示意楼板，不代表完整室内平面图'})
    source_alignment = json.loads((ROOT / 'build/alignment.json').read_text())
    placement = {
        'yaw': yaw, 'translation': shift.tolist(),
        'headingDegrees': source_alignment['headingDegrees'] + yaw,
        'officeFloor': 14, 'officeHeightMeters': source_alignment['officeHeightMeters'],
        'note': '按临滨海湾外墙及现有玻璃朝向配准，办公室位于楼体内。单元沿外墙的位置和楼层绝对标高仍待现场核准。',
        'sectionPolygon': placed_hull.tolist(),
        'officeContained': True, 'minimumFacadeClearanceMeters': float(-distances.max()),
        'hostEntities': host,
    }
    (ROOT / 'build/placement.json').write_text(json.dumps(placement, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in placement.items() if k not in ['sectionPolygon', 'hostEntities']}, ensure_ascii=False))
    print(f'生成 {len(host)} 个楼体剖面物件，原有滨海湾模型复用资源，仅调整摆放')


if __name__ == '__main__':
    main()
