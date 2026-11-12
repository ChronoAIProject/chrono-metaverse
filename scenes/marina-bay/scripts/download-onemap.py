"""按场景配置下载 OneMap 公开三维地图中的最高精度分片。"""

import concurrent.futures
import hashlib
import json
import math
import re
import struct
import urllib.request
from scene_config import workspace_config


def download(uri, dest, base, headers):
    target = dest / uri
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        with urllib.request.urlopen(urllib.request.Request(base + uri, headers=headers), timeout=45) as response:
            data = response.read()
        if uri.endswith(".b3dm") and data[:4] != b"b3dm":
            raise ValueError(f"不是三维模型：{uri}")
        target.write_bytes(data)
    return target.read_bytes()


def main():
    root, context = workspace_config()
    config = context['oneMap']
    dest = root / 'assets/onemap'
    base = config['tilesBaseUrl']
    headers = {'User-Agent': 'chrono-metaverse/1.0', 'Referer': config['pageUrl']}
    dest.mkdir(parents=True, exist_ok=True)
    source = json.loads(download("tileset.json", dest, base, headers))
    bounds = [math.radians(x) for x in config['bboxDegrees']]
    selected = {}

    def intersects(region):
        return region[0] < bounds[2] and region[2] > bounds[0] and region[1] < bounds[3] and region[3] > bounds[1]

    def visit(node, transform=None):
        region = node.get("boundingVolume", {}).get("region")
        if region and not intersects(region):
            return
        # 当前官方数据没有嵌套变换；遇到变化时明确停止，避免静默放错位置。
        if node.get("transform"):
            raise ValueError("数据新增了节点变换，需要合并坐标变换后再下载")
        content = node.get("content", {})
        uri = content.get("uri", content.get("url", ""))
        region = content.get("boundingVolume", {}).get("region", region)
        match = re.fullmatch(r"(.+)_(\d+)\.b3dm", uri)
        if match and (region is None or intersects(region)):
            key, level = match[1], int(match[2])
            if key not in selected or level < selected[key]["level"]:
                selected[key] = {"uri": uri, "level": level, "region": region}
        for child in node.get("children", []):
            visit(child)

    visit(source["root"])
    print(f"筛选到 {len(selected)} 个最高精度分片", flush=True)

    def fetch(item):
        data = download(item["uri"], dest, base, headers)
        magic, version, length, fj, fb, bj, bb = struct.unpack_from("<4s6I", data)
        if magic != b"b3dm" or version != 1 or length != len(data):
            raise ValueError(f"分片头不合法：{item['uri']}")
        feature = json.loads(data[28:28 + fj]) if fj else {}
        batch = json.loads(data[28 + fj + fb:28 + fj + fb + bj]) if bj else {}
        offset = 28 + fj + fb + bj + bb
        glb = data[offset:]
        if glb[:4] != b"glTF":
            raise ValueError(f"分片没有 GLB：{item['uri']}")
        target = dest / item["uri"]
        target.with_suffix(".glb").write_bytes(glb)
        item = {**item, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "featureTable": feature, "batchTable": batch}
        print(f"已下载 {item['uri']}：{len(data):,} 字节", flush=True)
        return item

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        items = list(pool.map(fetch, sorted(selected.values(), key=lambda x: x["uri"])))
    local_tiles = [{"boundingVolume": {"region": item["region"]}, "geometricError": 0, "content": {"uri": item["uri"]}} for item in items]
    heights = [item['region'][4:6] for item in items if item.get('region')]
    if not heights:
        raise ValueError('所选分片没有地理范围')
    local = {"asset": source["asset"], "geometricError": 0, "root": {"boundingVolume": {"region": [*bounds, min(h[0] for h in heights), max(h[1] for h in heights)]}, "geometricError": 0, "refine": "ADD", "children": local_tiles}}
    (dest / config['tilesetFile']).write_text(json.dumps(local, ensure_ascii=False, indent=2) + "\n")
    manifest = {"source": base + "tileset.json", "page": config['pageUrl'], "attribution": config['manifestAttribution'], "bboxDegrees": config['bboxDegrees'], "downloadedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(), "tileCount": len(items), "totalBytes": sum(i["bytes"] for i in items), "tiles": items}
    (dest / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in manifest.items() if k != "tiles"}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
