"""把 OneMap 三维分片转换成米制、y 向上的独立建筑 GLB。"""

import hashlib
import json
import math
import struct

import numpy as np
import trimesh
from PIL import Image

from ..bench.core import ReconError
from .config import plot_region_id, workspace_config
from .meshes import triangle_groups

Y_UP_TO_Z_UP = np.array([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]], dtype=float)


def frame(config):
    lat, lon, heading = map(
        math.radians, [config["reference"]["lat"], config["reference"]["lon"], config["headingDegrees"]]
    )
    height = config["officeHeightMeters"]
    a, e2 = 6378137.0, 6.6943799901413165e-3
    radius = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    origin = np.array(
        [
            (radius + height) * math.cos(lat) * math.cos(lon),
            (radius + height) * math.cos(lat) * math.sin(lon),
            (radius * (1 - e2) + height) * math.sin(lat),
        ]
    )
    east = np.array([-math.sin(lon), math.cos(lon), 0])
    north = np.array([-math.sin(lat) * math.cos(lon), -math.sin(lat) * math.sin(lon), math.cos(lat)])
    up = np.array([math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])
    rotation = np.stack(
        [
            -math.cos(heading) * east + math.sin(heading) * north,
            up,
            math.sin(heading) * east + math.cos(heading) * north,
        ]
    )
    assert abs(np.linalg.det(rotation) - 1) < 1e-9
    return origin, rotation


def read_tables(path):
    data = path.read_bytes()
    _, _, _, fj, fb, bj, _bb = struct.unpack_from("<4s6I", data)
    return json.loads(data[28 : 28 + fj]), json.loads(data[28 + fj + fb : 28 + fj + fb + bj])


def main(root=None):
    root, context = workspace_config(root)
    config = context["oneMap"]
    source = root / "assets/onemap"
    out = root / "assets"
    bbox = config["bboxDegrees"]
    tower_id = config["hostSourceId"]
    region_id = plot_region_id(root)
    manifest = json.loads((source / "manifest.json").read_text())
    origin, rotation = frame(config)
    # 在来源清单中查找宿主建筑，不依赖某一座楼的固定分片路径。
    tower_tile = next(
        (tile for tile in manifest["tiles"] if tower_id in tile["batchTable"].get("gml:id", [])), None
    )
    if tower_tile is None:
        raise ReconError("找不到宿主建筑：用 context inspect 查看编号，再更新 oneMap.hostSourceId")
    tower_file = source / tower_tile["uri"]
    feature, batch = read_tables(tower_file)
    tower_scene = trimesh.load_scene(tower_file.with_suffix(".glb"), process=False)
    vertices = []
    tower_batch = batch["gml:id"].index(tower_id)
    for node in tower_scene.graph.nodes_geometry:
        matrix, geom = tower_scene.graph[node]
        mesh = tower_scene.geometry[geom]
        ids = np.rint(np.asarray(mesh.vertex_attributes["_BATCHID"]).reshape(-1)).astype(int)
        selected = mesh.vertices[ids == tower_batch]
        if len(selected):
            delta = trimesh.transform_points(selected, Y_UP_TO_Z_UP @ matrix) + feature["RTC_CENTER"] - origin
            vertices.append(delta @ rotation.T)
    tower_vertices = np.concatenate(vertices)
    initial = config["initialPlacement"]
    shift = np.array(
        [
            initial["centerX"] - (tower_vertices[:, 0].min() + tower_vertices[:, 0].max()) / 2,
            0,
            initial["frontZ"] - tower_vertices[:, 2].max(),
        ]
    )
    records = []
    own_tower = []
    total_triangles = 0
    for tile in manifest["tiles"]:
        path = source / tile["uri"]
        feature, batch = read_tables(path)
        chosen = {
            i
            for i, (lat, lon) in enumerate(zip(batch["Latitude"], batch["Longitude"], strict=True))
            if bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]
        }
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
                    other_maps = [
                        getattr(material, key, None)
                        for key in [
                            "normalTexture",
                            "metallicRoughnessTexture",
                            "emissiveTexture",
                            "occlusionTexture",
                        ]
                    ]
                    if (
                        image is not None
                        and uv is not None
                        and np.isfinite(uv).all()
                        and uv.min() >= -1e-5
                        and uv.max() <= 1.00001
                        and all(item is None for item in other_maps)
                    ):
                        width, height = image.size
                        u0, v0 = uv.min(axis=0)
                        u1, v1 = uv.max(axis=0)
                        left, right = max(0, int(u0 * width) - 2), min(width, math.ceil(u1 * width) + 2)
                        top, bottom = (
                            max(0, int((1 - v1) * height) - 2),
                            min(height, math.ceil((1 - v0) * height) + 2),
                        )
                        if right > left and bottom > top:
                            material.baseColorTexture = image.crop((left, top, right, bottom))
                            sub.visual.uv = np.column_stack(
                                [
                                    (uv[:, 0] * width - left) / (right - left),
                                    (uv[:, 1] * height - (height - bottom)) / (bottom - top),
                                ]
                            )
                    for field in [
                        "baseColorTexture",
                        "normalTexture",
                        "metallicRoughnessTexture",
                        "emissiveTexture",
                        "occlusionTexture",
                    ]:
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
            name = (
                batch.get("gml:name", [""] * len(batch["gml:id"]))[i].strip()
                or config["fallbackBuildingLabel"]
            )
            # 每个物件最多 9 万个三角形，为平台的 10 万上限留余量。
            groups = triangle_groups(meshes)
            for part_index, group in enumerate(groups):
                bounds = np.array(
                    [
                        np.min([m.bounds[0] for m in group], axis=0),
                        np.max([m.bounds[1] for m in group], axis=0),
                    ]
                )
                center = np.array(
                    [(bounds[0, 0] + bounds[1, 0]) / 2, bounds[0, 1], (bounds[0, 2] + bounds[1, 2]) / 2]
                )
                for mesh in group:
                    mesh.vertices -= center
                blob = trimesh.Scene(group).export(file_type="glb", include_normals=True)
                digest = hashlib.sha256(blob).hexdigest()
                (out / (digest + ".glb")).write_bytes(blob)
                triangles = sum(len(m.faces) for m in group)
                if len(blob) > 50 * 1024 * 1024:
                    raise ValueError(f"转换结果超出模型大小限制：{name}")
                total_triangles += triangles
                record = {
                    "entityId": context["entityPrefix"]
                    + source_id.replace("SLA_BLDG2_", "")
                    + (f".{part_index}" if len(groups) > 1 else ""),
                    "layer": "ext",
                    "kind": "object",
                    "label": name,
                    "regionId": region_id,
                    "assetHash": digest,
                    "bounds": {"min": bounds[0].round(6).tolist(), "max": bounds[1].round(6).tolist()},
                    "props": {
                        "数据来源": "OneMap 三维地图 · 新加坡土地管理局 SLA",
                        "来源地址": config["pageUrl"],
                        "版权": config["attribution"],
                        "官方建筑编号": source_id,
                        "原始分片": tile["uri"],
                        "数据创建日期": batch.get("core:creationdate", [""] * len(batch["gml:id"]))[i],
                        "官方测量高度（米）": batch.get("bldg:measuredheight", [0] * len(batch["gml:id"]))[i],
                        "三角形数": triangles,
                    },
                }
                (own_tower if source_id == tower_id else records).append(record)
        print(f"已转换 {tile['uri']}，累计 {len(records)} 个建筑部件", flush=True)
    build = root / "build"
    build.mkdir(exist_ok=True)
    (build / "onemap-entities.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    (build / "own-tower.json").write_text(json.dumps(own_tower, ensure_ascii=False, indent=2) + "\n")
    alignment = {
        "reference": config["reference"],
        "officeFloor": config["officeFloor"],
        "officeHeightMeters": config["officeHeightMeters"],
        "headingDegrees": config["headingDegrees"],
        "shift": shift.tolist(),
        "note": "建筑坐标来自官方模型；办公室高度和朝向暂按估值配准，可以统一调整，不改变室内重建。",
        "modelParts": len(records),
        "ownTowerParts": len(own_tower),
        "totalTriangles": total_triangles,
    }
    (build / "alignment.json").write_text(json.dumps(alignment, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(alignment, ensure_ascii=False), flush=True)
