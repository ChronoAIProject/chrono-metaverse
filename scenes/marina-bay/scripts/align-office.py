"""兼容旧场景命令；实现由通用重建工具提供。"""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'recon/src'))
from metaverse_recon.context.host import main

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', type=Path, default=Path(__file__).resolve().parents[1])
    main(parser.parse_args().workspace)
