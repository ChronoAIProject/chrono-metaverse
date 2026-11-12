"""按场景配置下载正射影像，生成与官方建筑坐标一致的地面模型。"""
import concurrent.futures
import hashlib
import io
import json
import math
import urllib.request
import numpy as np
from PIL import Image
import trimesh
from scene_config import plot_region_id, workspace_config


def tile(lon, lat, zoom):
    return (int((lon + 180) / 360 * 2 ** zoom), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2 ** zoom))


def coordinates(x, y, zoom):
    return (x / 2 ** zoom * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / 2 ** zoom)))))


def main():
    root, context = workspace_config()
    source = context['oneMap']
    imagery = source['imagery']
    zoom = imagery['zoom']
    bbox = source['bboxDegrees']
    region_id = plot_region_id(root)
    config = json.loads((root / 'build/alignment.json').read_text())
    left, bottom = tile(bbox[0], bbox[1], zoom)
    right, top = tile(bbox[2], bbox[3], zoom)
    dest = root / 'assets/onemap/imagery'
    dest.mkdir(parents=True, exist_ok=True)
    def fetch(xy):
        x, y = xy
        path = dest / f'{zoom}-{x}-{y}.png'
        if not path.exists():
            request = urllib.request.Request(imagery['urlTemplate'].format(z=zoom, x=x, y=y), headers={'User-Agent': 'chrono-metaverse/1.0', 'Referer': source['pageUrl']})
            path.write_bytes(urllib.request.urlopen(request, timeout=30).read())
        return x, y, Image.open(io.BytesIO(path.read_bytes())).convert('RGB')
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        images = list(pool.map(fetch, [(x, y) for x in range(left, right + 1) for y in range(top, bottom + 1)]))
    size = images[0][2].width
    atlas = Image.new('RGB', ((right - left + 1) * size, (bottom - top + 1) * size))
    for x, y, image in images:
        atlas.paste(image, ((x - left) * size, (y - top) * size))
    atlas.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
    atlas.save(dest / imagery['atlasFile'], quality=92)
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
            vertices = np.array([point(*coordinates(x0, y1, zoom)), point(*coordinates(x1, y1, zoom)), point(*coordinates(x1, y0, zoom)), point(*coordinates(x0, y0, zoom))])
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
            (root / 'assets' / (digest + '.glb')).write_bytes(data)
            record = {'entityId': f"{context['entityPrefix']}orthophoto-{ix}-{iy}", 'layer': 'ext', 'kind': 'object', 'label': imagery['label'], 'regionId': region_id, 'assetHash': digest, 'bounds': {'min': bounds[0].round(6).tolist(), 'max': bounds[1].round(6).tolist()}, 'props': {'数据来源': 'OneMap OrthoJPG 正射影像', '来源地址': source['pageUrl'], '版权': source['attribution'], '影像级别': zoom, '瓦片数': len(images)}}
            records.append(record)
    (root / 'build/ground.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')
    print(f'已下载 {len(images)} 幅正射影像，生成四块地面模型', flush=True)



if __name__ == '__main__':
    main()
