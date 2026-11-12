"""下载滨海湾正射影像，生成与官方建筑坐标一致的地面模型。"""
import concurrent.futures
import hashlib
import io
import json
import math
from pathlib import Path
import urllib.request
import numpy as np
from PIL import Image
import trimesh

ROOT = Path(__file__).resolve().parents[1]
Z = 17
BBOX = [103.8500, 1.2780, 103.8647, 1.2918]


def tile(lon, lat):
    return (int((lon + 180) / 360 * 2 ** Z), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2 ** Z))


def coordinates(x, y):
    return (x / 2 ** Z * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / 2 ** Z)))))


def main():
    config = json.loads((ROOT / 'build/alignment.json').read_text())
    left, bottom = tile(BBOX[0], BBOX[1])
    right, top = tile(BBOX[2], BBOX[3])
    dest = ROOT / 'assets/onemap/imagery'
    dest.mkdir(parents=True, exist_ok=True)
    def fetch(xy):
        x, y = xy
        path = dest / f'{Z}-{x}-{y}.png'
        if not path.exists():
            request = urllib.request.Request(f'https://www.onemap.gov.sg/maps/tiles/OrthoJPG/{Z}/{x}/{y}.png', headers={'User-Agent': 'ChronoAI-MarinaBay-Scene/1.0', 'Referer': 'https://www.onemap.gov.sg/3d'})
            path.write_bytes(urllib.request.urlopen(request, timeout=30).read())
        return x, y, Image.open(io.BytesIO(path.read_bytes())).convert('RGB')
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        images = list(pool.map(fetch, [(x, y) for x in range(left, right + 1) for y in range(top, bottom + 1)]))
    size = images[0][2].width
    atlas = Image.new('RGB', ((right - left + 1) * size, (bottom - top + 1) * size))
    for x, y, image in images:
        atlas.paste(image, ((x - left) * size, (y - top) * size))
    atlas.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
    atlas.save(dest / 'marina-bay-orthophoto.jpg', quality=92)
    lat0, lon0 = config['reference']['lat'], config['reference']['lon']
    heading = math.radians(config['headingDegrees'])
    shift = np.array(config['shift'])
    def point(lon, lat):
        east = math.radians(lon - lon0) * 6378137 * math.cos(math.radians(lat0))
        north = math.radians(lat - lat0) * 6335439
        return np.array([-math.cos(heading) * east + math.sin(heading) * north, -config['officeHeightMeters'] - 0.25, math.sin(heading) * east + math.cos(heading) * north]) + shift
    # 分成四块，每块模型的局部坐标都小于平台的一千米上限。
    records = []
    for ix in range(2):
        for iy in range(2):
            x0 = left + (right + 1 - left) * ix / 2
            x1 = left + (right + 1 - left) * (ix + 1) / 2
            y0 = top + (bottom + 1 - top) * iy / 2
            y1 = top + (bottom + 1 - top) * (iy + 1) / 2
            image = atlas.crop((int(atlas.width * ix / 2), int(atlas.height * iy / 2), int(atlas.width * (ix + 1) / 2), int(atlas.height * (iy + 1) / 2)))
            image.format = 'JPEG'
            vertices = np.array([point(*coordinates(x0, y1)), point(*coordinates(x1, y1)), point(*coordinates(x1, y0)), point(*coordinates(x0, y0))])
            # 地面略低于官方建筑；避开五厘米网格的整数边界。
            vertices[:, 1] -= 0.007
            mesh = trimesh.Trimesh(vertices=vertices, faces=[[0, 2, 1], [0, 3, 2]], process=False)
            if mesh.face_normals[0][1] < 0:
                mesh.faces = mesh.faces[:, ::-1]
            material = trimesh.visual.material.PBRMaterial(baseColorTexture=image, metallicFactor=0, roughnessFactor=1, doubleSided=True)
            mesh.visual = trimesh.visual.texture.TextureVisuals(uv=[[0, 0], [1, 0], [1, 1], [0, 1]], material=material)
            bounds = mesh.bounds.copy()
            center = [(bounds[0, 0] + bounds[1, 0]) / 2, bounds[0, 1], (bounds[0, 2] + bounds[1, 2]) / 2]
            mesh.vertices -= center
            data = trimesh.Scene(mesh).export(file_type='glb', include_normals=True)
            digest = hashlib.sha256(data).hexdigest()
            (ROOT / 'assets' / (digest + '.glb')).write_bytes(data)
            record = {'entityId': f'bay.orthophoto-{ix}-{iy}', 'layer': 'ext', 'kind': 'object', 'label': '滨海湾岸线与地面（OneMap 正射影像）', 'regionId': 'marina-bay-exterior', 'assetHash': digest, 'bounds': {'min': bounds[0].round(6).tolist(), 'max': bounds[1].round(6).tolist()}, 'props': {'数据来源': 'OneMap OrthoJPG 正射影像', '来源地址': 'https://www.onemap.gov.sg/3d', '版权': 'Map Data © 2026 SLA', '影像级别': Z, '瓦片数': len(images)}}
            records.append(record)
    (ROOT / 'build/ground.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')
    print(f'已下载 {len(images)} 幅正射影像，生成四块地面模型', flush=True)



if __name__ == '__main__':
    main()
