"""用本机模拟数据源验证两个地点的完整导入流程，不依赖现有场景或外部网络。"""
import functools
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading

import numpy as np
from PIL import Image
import trimesh

SCRIPTS = Path(__file__).resolve().parent
# 固定赤道基准点及已知地心坐标，用于独立核对模拟模型的坐标变换。
SAMPLES = [
    {'name': 'alpha', 'reference': {'lat': 0, 'lon': 0}, 'ecefCenter': [6378137, 0, 0],
     'level': 8, 'height': 40, 'heading': 0, 'hostIndex': 1, 'zoom': 12,
     'position': {'centerX': 100, 'frontZ': 120}},
    {'name': 'beta', 'reference': {'lat': 0, 'lon': 90}, 'ecefCenter': [0, 6378137, 0],
     'level': 3, 'height': 12, 'heading': 90, 'hostIndex': 0, 'zoom': 13,
     'position': {'centerX': -60, 'frontZ': -80}},
]


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False))


def make_source(directory, sample):
    directory.mkdir(parents=True)
    name = sample['name']
    meridian = sample['reference']['lon']
    region = [math.radians(v) for v in [meridian - 0.001, -0.001, meridian + 0.001, 0.001]] + [0, 200]
    children = []
    for index in range(2):
        mesh = trimesh.creation.box(extents=[12 + index * 2, 80 + index * 10, 10 + index])
        mesh.vertex_attributes['_BATCHID'] = np.zeros((len(mesh.vertices), 1), dtype=np.float32)
        glb = trimesh.Scene(mesh).export(file_type='glb')
        feature = json.dumps({'RTC_CENTER': sample['ecefCenter'], 'BATCH_LENGTH': 1}).encode()
        batch = json.dumps({'gml:id': [f'{name}-{index}'], 'gml:name': [''], 'Latitude': [0], 'Longitude': [meridian]}).encode()
        header = struct.pack('<4s6I', b'b3dm', 1, 28 + len(feature) + len(batch) + len(glb), len(feature), 0, len(batch), 0)
        uri = f'{name}-building-{index}_0.b3dm'
        (directory / uri).write_bytes(header + feature + batch + glb)
        children.append({'boundingVolume': {'region': region}, 'geometricError': 0, 'content': {'uri': uri}})
    outside = region.copy()
    outside[0], outside[2] = outside[2] + 0.1, outside[2] + 0.2
    children.append({'boundingVolume': {'region': outside}, 'content': {'uri': 'must-not-download_0.b3dm'}})
    write_json(directory / 'tileset.json', {'asset': {'version': '1.0'}, 'root': {'children': children}})


def check_case(root, base, sample):
    root.mkdir()
    name, level, height = sample['name'], sample['level'], sample['height']
    heading, host_index, zoom = sample['heading'], sample['hostIndex'], sample['zoom']
    position = sample['position']
    meridian = sample['reference']['lon']
    workspace = {'spaceId': f'space-{name}', 'plot': f'plot-{name}'}
    region_id = f'region-{name}'
    source = {
        'bboxDegrees': [meridian - 0.001, -0.001, meridian + 0.001, 0.001],
        'reference': sample['reference'], 'officeFloor': level,
        'officeHeightMeters': height, 'headingDegrees': heading,
        'hostSourceId': f'{name}-{host_index}', 'initialPlacement': position,
        'fallbackBuildingLabel': f'{name}建筑', 'tilesBaseUrl': f'{base}/{name}/',
        'pageUrl': f'{base}/{name}', 'attribution': f'{name}署名',
        'manifestAttribution': f'{name}来源署名', 'tilesetFile': f'{name}-tileset.json',
        'imagery': {'urlTemplate': base + '/imagery/{z}/{x}/{y}.png', 'zoom': zoom,
                    'atlasFile': f'{name}-atlas.jpg', 'label': f'{name}地面'},
    }
    write_json(root / 'context.json', {'oneMap': source, 'entityPrefix': name + '.'})
    write_json(root / 'metaverse.json', workspace)
    write_json(root / 'space.json', {'plots': [{'id': workspace['plot'], 'regionId': region_id}]})
    for script in ['download-onemap.py', 'convert-onemap.py', 'prepare-ground.py']:
        result = subprocess.run([sys.executable, str(SCRIPTS / script), '--workspace', str(root)], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError(f'{name}/{script}：{result.stdout}\n{result.stderr}')
    read = lambda path: json.loads((root / path).read_text())
    manifest = read('assets/onemap/manifest.json')
    alignment = read('build/alignment.json')
    host = read('build/own-tower.json')
    buildings = read('build/onemap-entities.json')
    ground = read('build/ground.json')
    assert manifest['tileCount'] == 2 and manifest['bboxDegrees'] == source['bboxDegrees']
    assert manifest['source'] == source['tilesBaseUrl'] + 'tileset.json'
    assert manifest['attribution'] == source['manifestAttribution']
    assert (root / 'assets/onemap' / source['tilesetFile']).exists()
    assert alignment['reference'] == source['reference']
    assert alignment['officeFloor'] == level and alignment['officeHeightMeters'] == height
    assert alignment['headingDegrees'] == heading
    assert len(host) == 1 and host[0]['props']['官方建筑编号'] == source['hostSourceId']
    bounds = host[0]['bounds']
    assert abs((bounds['min'][0] + bounds['max'][0]) / 2 - position['centerX']) < 1e-6
    assert abs(bounds['max'][2] - position['frontZ']) < 1e-6
    # 两处赤道参考点分别位于地心坐标的 +X、+Y 轴，独立核对标高和朝向产生的范围。
    vertical_span = 12 + host_index * 2 if meridian == 0 else 10 + host_index
    width = 10 + host_index if heading == 0 else 80 + host_index * 10
    assert abs(bounds['min'][1] - (-height - vertical_span / 2)) < 1e-6
    assert abs(bounds['max'][0] - bounds['min'][0] - width) < 1e-6
    assert len(buildings) == 1 and len(ground) == 4
    assert all(e['label'] == source['fallbackBuildingLabel'] for e in host + buildings)
    assert all(e['label'] == source['imagery']['label'] and e['props']['影像级别'] == zoom for e in ground)
    assert (root / 'assets/onemap/imagery' / source['imagery']['atlasFile']).exists()
    for entity in host + buildings + ground:
        assert entity['entityId'].startswith(name + '.') and entity['regionId'] == region_id
        assert entity['props']['来源地址'] == source['pageUrl'] and entity['props']['版权'] == source['attribution']
        data = (root / 'assets' / (entity['assetHash'] + '.glb')).read_bytes()
        assert hashlib.sha256(data).hexdigest() == entity['assetHash']
    return {'case': name, 'level': level, 'heading': heading, 'host': source['hostSourceId'], 'zoom': zoom, 'verified': True}


def main():
    png = io.BytesIO()
    Image.new('RGB', (64, 64), color=(90, 140, 180)).save(png, format='PNG')

    class Handler(SimpleHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith('/imagery/'):
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.end_headers()
                self.wfile.write(png.getvalue())
            else:
                super().do_GET()

        def log_message(self, *args):
            pass

    with tempfile.TemporaryDirectory(prefix='metaverse-import-') as directory:
        root = Path(directory)
        for sample in SAMPLES:
            make_source(root / 'source' / sample['name'], sample)
        server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root / 'source')))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f'http://127.0.0.1:{server.server_port}'
            report = [check_case(root / f"workspace-{sample['name']}", base, sample) for sample in SAMPLES]
            print(json.dumps(report, ensure_ascii=False))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    main()
