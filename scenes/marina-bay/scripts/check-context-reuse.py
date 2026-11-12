"""用不同名称、实体编号、位置及朝向验证宿主场景生成器可复用，不修改当前场景。"""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return json.loads((ROOT / path).read_text())


def check_case(label, turn, offset, level):
    config = copy.deepcopy(read('context.json'))
    host = config['host']
    source = read(host['modelFile'])[0]
    entities = read('entities.json')
    space = read('space.json')
    workspace = read('metaverse.json')
    alignment = read('build/alignment.json')
    angle = np.radians(turn)
    rotation = np.array([[np.cos(angle), 0, np.sin(angle)], [0, 1, 0], [-np.sin(angle), 0, np.cos(angle)]])
    offset = np.array(offset)

    def moved_bounds(bounds):
        points = np.array([[x, y, z] for x in [bounds['min'][0], bounds['max'][0]]
                           for y in [bounds['min'][1], bounds['max'][1]]
                           for z in [bounds['min'][2], bounds['max'][2]]]) @ rotation.T + offset
        return {'min': points.min(axis=0).tolist(), 'max': points.max(axis=0).tolist()}

    for entity in entities:
        if entity['entityId'] in [host['floorEntityId'], host['facadeEntityId']]:
            key = 'floorEntityId' if entity['entityId'] == host['floorEntityId'] else 'facadeEntityId'
            entity['entityId'] = f'sample.{key}'
            host[key] = entity['entityId']
            transform = entity['shape']['transform']
            transform['position'] = (rotation @ transform['position'] + offset).tolist()
            transform['yaw'] = transform.get('yaw', 0) + turn
        if entity.get('bounds'):
            entity['bounds'] = moved_bounds(entity['bounds'])
    region = next(region for region in space['regions'] if region['id'] == host['focusRegionId'])
    for i, box in enumerate(region['boxes']):
        moved = moved_bounds({'min': (np.array(box[:3]) * 0.05).tolist(), 'max': (np.array(box[3:]) * 0.05).tolist()})
        region['boxes'][i] = np.rint(np.array(moved['min'] + moved['max']) / 0.05).astype(int).tolist()
    region['id'] = host['focusRegionId'] = 'sample-focus'
    plot = next(plot for plot in space['plots'] if plot['id'] == workspace['plot'])
    plot['regionId'] = 'sample-background'
    host.update({'entityPrefix': 'sample.context', 'label': label, 'levelLabel': f'{level}层'})
    host['landmark']['label'] = f'{label} · {level}层入口'
    host['overviewDistanceMeters'] = level * 10
    alignment['officeFloor'] = level
    with tempfile.TemporaryDirectory(prefix='metaverse-context-') as directory:
        root = Path(directory)
        (root / 'assets').mkdir()
        (root / 'build').mkdir()
        asset = f"assets/{source['assetHash']}.glb"
        (root / asset).symlink_to(ROOT / asset)
        for path, value in [('context.json', config), ('space.json', space), ('metaverse.json', workspace),
                            ('entities.json', entities), ('build/alignment.json', alignment), (host['modelFile'], [source])]:
            (root / path).write_text(json.dumps(value, ensure_ascii=False))
        subprocess.run([sys.executable, str(ROOT / 'scripts/align-office.py'), '--workspace', directory], check=True, capture_output=True, text=True)
        result = json.loads((root / 'build/placement.json').read_text())
        assert result['officeFloor'] == level and result['officeContained']
        assert result['minimumFacadeClearanceMeters'] > host['minimumClearanceMeters']
        assert all(entity['entityId'].startswith(host['entityPrefix']) and entity['regionId'] == plot['regionId'] for entity in result['hostEntities'])
        marker = next(entity['props']['landmark'] for entity in result['hostEntities'] if 'landmark' in entity['props'])
        assert marker['label'] == host['landmark']['label']
        assert marker['minDistance'] == host['overviewDistanceMeters']
        expected_min = np.min([entity['bounds']['min'] for entity in entities if entity.get('bounds')], axis=0)
        assert np.allclose(marker['focusBounds']['min'], expected_min)
        return {'label': label, 'turn': turn, 'offset': offset.tolist(), 'parts': len(result['hostEntities']), 'verified': True}


if __name__ == '__main__':
    report = [check_case('城市实验室', 0, [100, 0, -80], 8), check_case('山海展馆', 90, [-60, 0, 120], 3)]
    (ROOT / 'out').mkdir(exist_ok=True)
    (ROOT / 'out/context-reuse-check.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))
