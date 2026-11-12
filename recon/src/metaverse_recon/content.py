"""把外部模型转换为普通空间物件；不预设家具、建筑、背景或地块。"""

import hashlib
import json
import math
from pathlib import Path

import numpy as np
import trimesh

from .bench.core import ReconError


def triangle_groups(meshes, limit=90000):
    groups, current, count = [], [], 0
    for mesh in meshes:
        for start in range(0, len(mesh.faces), limit):
            part = (
                mesh.copy()
                if start == 0 and len(mesh.faces) <= limit
                else mesh.submesh(
                    [np.arange(start, min(start + limit, len(mesh.faces)))], append=True, repair=False
                )
            )
            if current and count + len(part.faces) > limit:
                groups.append(current)
                current, count = [], 0
            current.append(part)
            count += len(part.faces)
    if current:
        groups.append(current)
    return groups


def finite_vector(values, name, count=3):
    if len(values) != count or any(isinstance(v, bool) or not math.isfinite(v) for v in values):
        raise ReconError(f"{name} 需要 {count} 个有限数字")


def import_glb(
    root, model, entity_id, label, at, yaw=0, scale=None, region=None, background=False, attribution=""
):
    root, model = Path(root), Path(model)
    if model.suffix.lower() != ".glb":
        raise ReconError("模型须为 GLB；其他格式请先用来源工具转换")
    if model.stat().st_size > 50 * 1024 * 1024:
        raise ReconError("单个输入 GLB 不能超过 50 MiB，请先拆分来源文件")
    scale = [1, 1, 1] if scale is None else scale
    finite_vector(at, "位置")
    finite_vector(scale, "缩放")
    finite_vector([yaw], "偏航", 1)
    if any(value <= 0 for value in scale):
        raise ReconError("缩放须为正数")
    scene = trimesh.load_scene(model, process=False)
    if not scene.geometry:
        raise ReconError("GLB 没有网格")
    scene.apply_scale(scale)
    minimum, maximum = scene.bounds
    center = (minimum + maximum) / 2
    center[1] = minimum[1]
    scene.apply_translation(-center)
    meshes = []
    for node in scene.graph.nodes_geometry:
        matrix, key = scene.graph[node]
        mesh = scene.geometry[key].copy()
        mesh.apply_transform(matrix)
        meshes.append(mesh)
    groups = triangle_groups(meshes)
    angle = math.radians(yaw)
    c, s = math.cos(angle), math.sin(angle)
    rotation = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    (root / "assets").mkdir(parents=True, exist_ok=True)
    entities, assets = [], {}
    for index, group in enumerate(groups):
        bounds = np.array(
            [np.min([m.bounds[0] for m in group], axis=0), np.max([m.bounds[1] for m in group], axis=0)]
        )
        part_center = bounds.mean(axis=0)
        part_center[1] = bounds[0, 1]
        for mesh in group:
            mesh.vertices -= part_center
        data = trimesh.Scene(group).export(file_type="glb", include_normals=True)
        if len(data) > 50 * 1024 * 1024:
            raise ReconError("转换后单个物件超过 50 MiB，请降低贴图精度")
        digest = hashlib.sha256(data).hexdigest()
        (root / "assets" / f"{digest}.glb").write_bytes(data)
        points = np.array([[x, y, z] for x in bounds[:, 0] for y in bounds[:, 1] for z in bounds[:, 2]])
        points = points @ rotation.T + at
        props = {"来源": label, "署名": attribution}
        if background:
            props["background"] = True
        entities.append(
            {
                "entityId": entity_id + (f".{index}" if len(groups) > 1 else ""),
                "layer": "ext",
                "kind": "object",
                "label": label,
                "assetHash": digest,
                "bounds": {"min": points.min(axis=0).tolist(), "max": points.max(axis=0).tolist()},
                "transform": {"yaw": yaw},
                "props": props,
                **({"regionId": region} if region else {}),
            }
        )
        assets[digest] = {"hash": digest, "format": "glb"}
    if not entities:
        raise ReconError("模型没有三角形")
    return entities, list(assets.values())


def cmd_content(args):
    root = Path(args.workspace).resolve()
    entities, assets = import_glb(
        root,
        Path(args.model).resolve(),
        args.id,
        args.label,
        args.at,
        args.yaw,
        args.scale,
        args.region,
        args.background,
        args.attribution,
    )
    plan = {
        "version": 1,
        "message": args.label,
        "ops": [{"op": "placeEntity", "entity": entity} for entity in entities],
        "assets": assets,
    }
    target = root / args.out
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n")
    return {
        "file": str(target),
        "entities": len(entities),
        "next": "metaverse edit check/push --file " + args.out,
    }


def add_parser(sub):
    parser = sub.add_parser("content", help="把模型转换为普通空间物件和标准编辑计划")
    commands = parser.add_subparsers(dest="content_action", required=True)
    command = commands.add_parser("import")
    command.add_argument("--workspace", default=".")
    command.add_argument("--model", required=True)
    command.add_argument("--id", required=True, help="当前空间里的物件编号")
    command.add_argument("--label", required=True)
    command.add_argument("--at", type=float, nargs=3, default=[0, 0, 0])
    command.add_argument("--yaw", type=float, default=0)
    command.add_argument("--scale", type=float, nargs=3, default=[1, 1, 1])
    command.add_argument("--region", help="可选区域编号；不要求新建地块")
    command.add_argument("--background", action="store_true", help="作为显示属性，可选")
    command.add_argument("--attribution", default="")
    command.add_argument("--out", default="work/edit.json")
