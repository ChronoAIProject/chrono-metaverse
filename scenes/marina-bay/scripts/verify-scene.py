"""检查实际下载、导出模型和摆放记录，生成本地验收报告。"""
import hashlib
import io
import json
from pathlib import Path
import struct

import numpy as np
from PIL import Image
import trimesh
from scipy.spatial import ConvexHull

ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    manifest = json.loads((ROOT / 'assets/onemap/manifest.json').read_text())
    for tile in manifest['tiles']:
        blob = (ROOT / 'assets/onemap' / tile['uri']).read_bytes()
        require(len(blob) == tile['bytes'], f"原始分片长度不符：{tile['uri']}")
        require(hashlib.sha256(blob).hexdigest() == tile['sha256'], f"原始分片哈希不符：{tile['uri']}")

    buildings = json.loads((ROOT / 'build/onemap-entities.json').read_text())
    ground = json.loads((ROOT / 'build/ground.json').read_text())
    placement = json.loads((ROOT / 'build/placement.json').read_text())
    host = placement['hostEntities']
    require(placement['officeContained'] and placement['minimumFacadeClearanceMeters'] > 0.05, '办公室没有完全位于 Tower 1 楼体内')
    office = json.loads((ROOT / 'entities.json').read_text())
    floor = next(entity for entity in office if entity['entityId'] == 'rb.floor')['shape']
    outline = np.array(floor['outline']['points']) + np.array(floor['transform']['position'])[[0, 2]]
    planes = ConvexHull(np.array(placement['sectionPolygon'])).equations
    require((outline @ planes[:, :2].T + planes[:, 2]).max() < -0.05, '当前办公室地面超出 Tower 1 截面')
    entities = buildings + ground + host
    require(len({item['entityId'] for item in entities}) == len(entities), '存在重复物件编号')
    results = []
    for entity in entities:
        label = entity['entityId']
        path = ROOT / 'assets' / (entity['assetHash'] + '.glb')
        blob = path.read_bytes()
        require(hashlib.sha256(blob).hexdigest() == entity['assetHash'], f'{label}：模型哈希不符')
        require(len(blob) <= 50 * 1024 * 1024, f'{label}：模型超过 50 MiB')
        magic, version, length, json_length, kind = struct.unpack_from('<4s4I', blob)
        require(magic == b'glTF' and version == 2 and length == len(blob) and kind == 0x4E4F534A, f'{label}：GLB 头不符')
        document = json.loads(blob[20:20 + json_length])
        require(not document.get('animations') and not document.get('skins'), f'{label}：含不支持的动画或骨骼')
        require(not document.get('extensionsRequired'), f'{label}：仍依赖扩展解码')
        require(all('uri' not in value for value in document.get('buffers', [])), f'{label}：含外部缓冲区')
        binary = blob[28 + json_length:]
        image_sizes = []
        for image in document.get('images', []):
            require('uri' not in image and image.get('mimeType') in ['image/jpeg', 'image/png'], f'{label}：贴图不是内嵌 PNG/JPEG')
            view = document['bufferViews'][image['bufferView']]
            offset = view.get('byteOffset', 0)
            with Image.open(io.BytesIO(binary[offset:offset + view['byteLength']])) as decoded:
                width, height = decoded.size
                require(0 < width <= 2048 and 0 < height <= 2048, f'{label}：贴图边长超限')
                image_sizes.append([width, height])
        require(sum(w * h for w, h in image_sizes) <= 4 * 2048 ** 2, f'{label}：贴图总像素超限')
        scene = trimesh.load_scene(path, process=False)
        vertices = []
        triangles = 0
        for node in scene.graph.nodes_geometry:
            transform, geometry = scene.graph[node]
            mesh = scene.geometry[geometry]
            points = trimesh.transform_points(mesh.vertices, transform)
            require(np.isfinite(points).all() and np.abs(points).max() <= 1000, f'{label}：坐标非有限或超过一千米')
            vertices.append(points)
            triangles += len(mesh.faces)
        require(vertices and 0 < triangles <= 100000, f'{label}：几何为空或三角形超限')
        points = np.concatenate(vertices)
        bounds = np.array([points.min(axis=0), points.max(axis=0)])
        center = np.array([(bounds[0, 0] + bounds[1, 0]) / 2, bounds[0, 1], (bounds[0, 2] + bounds[1, 2]) / 2])
        require(np.abs(center).max() <= 0.02, f'{label}：原点不是底面中心')
        placed = np.array([entity['bounds']['min'], entity['bounds']['max']])
        require(np.allclose(bounds[1] - bounds[0], placed[1] - placed[0], atol=0.02, rtol=0.01), f'{label}：摆放范围与模型不符')
        results.append({'entityId': label, 'bytes': len(blob), 'triangles': triangles, 'images': image_sizes})

    summary = {
        'source': manifest['source'],
        'attribution': manifest['attribution'],
        'bboxDegrees': manifest['bboxDegrees'],
        'downloadedAt': manifest['downloadedAt'],
        'sourceTiles': len(manifest['tiles']),
        'sourceBytes': manifest['totalBytes'],
        'orthophotoTiles': ground[0]['props']['瓦片数'],
        'buildingParts': len(buildings),
        'groundParts': len(ground),
        'hostTowerParts': len(host),
        'modelBytes': sum(item['bytes'] for item in results),
        'triangles': sum(item['triangles'] for item in results),
        'largestModelBytes': max(item['bytes'] for item in results),
        'verified': True,
    }
    (ROOT / 'out').mkdir(exist_ok=True)
    (ROOT / 'out/scene-check.json').write_text(json.dumps({'summary': summary, 'models': results}, ensure_ascii=False, indent=2) + '\n')
    (ROOT / 'build/download-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
