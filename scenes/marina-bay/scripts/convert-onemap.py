"""把 OneMap 三维分片转换成米制、y 向上的独立建筑 GLB。"""

import hashlib
import json
import math
from pathlib import Path
import struct

import numpy as np
from PIL import Image
import trimesh

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/onemap"
OUT = ROOT / "assets"
BBOX = [103.8500, 1.2780, 103.8647, 1.2918]
# 朝向和办公室楼板标高可整体调整；扫描本身没有提供地理配准。
ORIGIN_LAT = 1.2801706774251347
ORIGIN_LON = 103.85419949862057
OFFICE_HEIGHT = 60.0
HEADING = 25.0
TOWER_ID = "SLA_BLDG2_481e89dc-0dd1-4b88-8f8b-80303d6842a2"
Y_UP_TO_Z_UP = np.array([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]], dtype=float)


def frame():
    lat, lon, heading = map(math.radians, [ORIGIN_LAT, ORIGIN_LON, HEADING])
    a, e2 = 6378137.0, 6.6943799901413165e-3
    radius = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    origin = np.array([(radius + OFFICE_HEIGHT) * math.cos(lat) * math.cos(lon), (radius + OFFICE_HEIGHT) * math.cos(lat) * math.sin(lon), (radius * (1 - e2) + OFFICE_HEIGHT) * math.sin(lat)])
    east = np.array([-math.sin(lon), math.cos(lon), 0])
    north = np.array([-math.sin(lat) * math.cos(lon), -math.sin(lat) * math.sin(lon), math.cos(lat)])
    up = np.array([math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])
    rotation = np.stack([-math.cos(heading) * east + math.sin(heading) * north, up, math.sin(heading) * east + math.cos(heading) * north])
    assert abs(np.linalg.det(rotation) - 1) < 1e-9
    return origin, rotation


def read_tables(path):
    data = path.read_bytes()
    _, _, _, fj, fb, bj, bb = struct.unpack_from("<4s6I", data)
    return json.loads(data[28:28 + fj]), json.loads(data[28 + fj + fb:28 + fj + fb + bj])


def main():
    manifest = json.loads((SOURCE / "manifest.json").read_text())
    origin, rotation = frame()
    # 先按官方 Tower 1 外墙算窗边位置，避免把办公室摆进大楼中心。
    tower_file = SOURCE / "7/77/7_0.b3dm"
    feature, batch = read_tables(tower_file)
    tower_scene = trimesh.load_scene(tower_file.with_suffix(".glb"), process=False)
    vertices = []
    tower_batch = batch["gml:id"].index(TOWER_ID)
    for node in tower_scene.graph.nodes_geometry:
        matrix, geom = tower_scene.graph[node]
        mesh = tower_scene.geometry[geom]
        ids = np.rint(np.asarray(mesh.vertex_attributes["_BATCHID"]).reshape(-1)).astype(int)
        selected = mesh.vertices[ids == tower_batch]
        if len(selected):
            delta = trimesh.transform_points(selected, Y_UP_TO_Z_UP @ matrix) + feature["RTC_CENTER"] - origin
            vertices.append(delta @ rotation.T)
    tower_vertices = np.concatenate(vertices)
    shift = np.array([5.3 - (tower_vertices[:, 0].min() + tower_vertices[:, 0].max()) / 2, 0, 15.65 - tower_vertices[:, 2].max()])
    records = []
    own_tower = []
    total_triangles = 0
    for tile in manifest["tiles"]:
        path = SOURCE / tile["uri"]
        feature, batch = read_tables(path)
        chosen = {i for i, (lat, lon) in enumerate(zip(batch["Latitude"], batch["Longitude"])) if BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]}
        if not chosen:
            continue
        scene = trimesh.load_scene(path.with_suffix(".glb"), process=False)
        pieces = {i: [] for i in chosen}
        for node in scene.graph.nodes_geometry:
            matrix, geom = scene.graph[node]
            mesh = scene.geometry[geom]
            ids = np.rint(np.asarray(mesh.vertex_attributes["_BATCHID"]).reshape(-1)).astype(int)
            face_ids = ids[mesh.faces[:, 0]]
            for i in chosen & set(np.unique(face_ids).tolist()):
                sub = mesh.submesh([np.flatnonzero(face_ids == i)], append=True, repair=False)
                sub.apply_transform(Y_UP_TO_Z_UP @ matrix)
                sub.vertices = (sub.vertices + feature["RTC_CENTER"] - origin) @ rotation.T + shift
                # 解码后不再保留分片的批次属性；来源编号保存在独立建筑记录里。
                sub.vertex_attributes = {}
                material = getattr(sub.visual, "material", None)
                if material is not None:
                    material = material.copy()
                    image = getattr(material, "baseColorTexture", None)
                    uv = getattr(sub.visual, "uv", None)
                    # 分片的图集常被多座建筑共用，只保留当前建筑实际用到的区域。
                    other_maps = [getattr(material, key, None) for key in ["normalTexture", "metallicRoughnessTexture", "emissiveTexture", "occlusionTexture"]]
                    if image is not None and uv is not None and np.isfinite(uv).all() and uv.min() >= -1e-5 and uv.max() <= 1.00001 and all(item is None for item in other_maps):
                        width, height = image.size
                        u0, v0 = uv.min(axis=0)
                        u1, v1 = uv.max(axis=0)
                        left, right = max(0, int(u0 * width) - 2), min(width, math.ceil(u1 * width) + 2)
                        top, bottom = max(0, int((1 - v1) * height) - 2), min(height, math.ceil((1 - v0) * height) + 2)
                        if right > left and bottom > top:
                            material.baseColorTexture = image.crop((left, top, right, bottom))
                            sub.visual.uv = np.column_stack([(uv[:, 0] * width - left) / (right - left), (uv[:, 1] * height - (height - bottom)) / (bottom - top)])
                    for field in ["baseColorTexture", "normalTexture", "metallicRoughnessTexture", "emissiveTexture", "occlusionTexture"]:
                        image = getattr(material, field, None)
                        if image is not None:
                            image = image.copy()
                            image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
                            # 影像外墙使用 JPEG；透明材质仍保留 PNG。
                            if field == "baseColorTexture":
                                if image.mode == "RGBA" and image.getextrema()[3] == (255, 255):
                                    image = image.convert("RGB")
                                if image.mode == "RGB":
                                    image.format = "JPEG"
                            setattr(material, field, image)
                    sub.visual.material = material
                pieces[i].append(sub)
        for i, meshes in pieces.items():
            if not meshes:
                continue
            source_id = batch["gml:id"][i]
            name = batch.get("gml:name", [""] * len(batch["gml:id"]))[i].strip() or "滨海湾建筑"
            # 每个物件最多 9 万个三角形，为平台的 10 万上限留余量。
            groups = []
            current, count = [], 0
            for mesh in meshes:
                for start in range(0, len(mesh.faces), 90000):
                    part = mesh if start == 0 and len(mesh.faces) <= 90000 else mesh.submesh([np.arange(start, min(start + 90000, len(mesh.faces)))], append=True, repair=False)
                    if current and count + len(part.faces) > 90000:
                        groups.append(current)
                        current, count = [], 0
                    current.append(part)
                    count += len(part.faces)
            if current:
                groups.append(current)
            for part_index, group in enumerate(groups):
                bounds = np.array([np.min([m.bounds[0] for m in group], axis=0), np.max([m.bounds[1] for m in group], axis=0)])
                center = np.array([(bounds[0, 0] + bounds[1, 0]) / 2, bounds[0, 1], (bounds[0, 2] + bounds[1, 2]) / 2])
                for mesh in group:
                    mesh.vertices -= center
                blob = trimesh.Scene(group).export(file_type="glb", include_normals=True)
                digest = hashlib.sha256(blob).hexdigest()
                (OUT / (digest + ".glb")).write_bytes(blob)
                triangles = sum(len(m.faces) for m in group)
                if len(blob) > 50 * 1024 * 1024:
                    raise ValueError(f"转换结果超出模型大小限制：{name}")
                total_triangles += triangles
                record = {"entityId": "bay." + source_id.replace("SLA_BLDG2_", "") + (f".{part_index}" if len(groups) > 1 else ""), "layer": "ext", "kind": "object", "label": name, "regionId": "marina-bay-exterior", "assetHash": digest, "bounds": {"min": bounds[0].round(6).tolist(), "max": bounds[1].round(6).tolist()}, "props": {"数据来源": "OneMap 三维地图 · 新加坡土地管理局 SLA", "来源地址": "https://www.onemap.gov.sg/3d", "版权": "Map Data © 2026 SLA", "官方建筑编号": source_id, "原始分片": tile["uri"], "数据创建日期": batch.get("core:creationdate", [""] * len(batch["gml:id"]))[i], "官方测量高度（米）": batch.get("bldg:measuredheight", [0] * len(batch["gml:id"]))[i], "三角形数": triangles}}
                (own_tower if source_id == TOWER_ID else records).append(record)
        print(f"已转换 {tile['uri']}，累计 {len(records)} 个建筑部件", flush=True)
    build = ROOT / "build"
    (build / "onemap-entities.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    (build / "own-tower.json").write_text(json.dumps(own_tower, ensure_ascii=False, indent=2) + "\n")
    alignment = {"reference": {"lat": ORIGIN_LAT, "lon": ORIGIN_LON}, "officeFloor": 14, "officeHeightMeters": OFFICE_HEIGHT, "headingDegrees": HEADING, "shift": shift.tolist(), "note": "建筑坐标来自官方模型；办公室高度和朝向暂按估值配准，可以统一调整，不改变室内重建。", "modelParts": len(records), "ownTowerParts": len(own_tower), "totalTriangles": total_triangles}
    (build / "alignment.json").write_text(json.dumps(alignment, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(alignment, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
