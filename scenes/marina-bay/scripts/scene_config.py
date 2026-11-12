"""读取导入工作区和场景参数；空间与地块编号沿用系统工作区配置。"""
import argparse
import json
from pathlib import Path


def workspace_config():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', type=Path, default=Path(__file__).resolve().parents[1])
    root = parser.parse_args().workspace.resolve()
    return root, json.loads((root / 'context.json').read_text())


def plot_region_id(root):
    workspace = json.loads((root / 'metaverse.json').read_text())
    space = json.loads((root / 'space.json').read_text())
    return next(plot['regionId'] for plot in space['plots'] if plot['id'] == workspace['plot'])


def foreground_entities(entities):
    return [entity for entity in entities
            if not (entity.get('layer') == 'ext' and (entity.get('props') or {}).get('background') is True)]
