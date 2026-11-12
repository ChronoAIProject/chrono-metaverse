"""通过已安装的命令完成背景导入，所有输出都留在用户工作区。"""

import copy
import hashlib
from pathlib import Path

import numpy as np
import trimesh

from ..bench.core import ReconError
from .config import (
    foreground_entities,
    number,
    plot_region_id,
    read,
    validate,
    vector,
    workspace_config,
    write,
)


def inspect(root):
    space = read(root, "space.json")
    entities = foreground_entities(read(root, "entities.json"))
    result = {
        "spaceId": space.get("spaceId"),
        "seq": space.get("seq"),
        "regions": space.get("regions", []),
        "plots": space.get("plots", []),
        "subjects": [
            {k: e[k] for k in ["entityId", "kind", "label", "regionId", "bounds"] if k in e} for e in entities
        ],
        "savedConfigs": [
            e["props"]["backgroundConfig"]
            for e in read(root, "entities.json")
            if "backgroundConfig" in (e.get("props") or {})
        ],
    }
    manifest = Path(root) / "assets/onemap/manifest.json"
    if manifest.exists():
        result["buildings"] = [
            {"id": source_id, "label": label}
            for tile in read(root, "assets/onemap/manifest.json")["tiles"]
            for source_id, label in zip(
                tile["batchTable"].get("gml:id", []), tile["batchTable"].get("gml:name", []), strict=True
            )
        ]
    return result


def placed(entity, placement):
    entity = copy.deepcopy(entity)
    angle = np.radians(placement["yaw"])
    c, s = np.cos(angle), np.sin(angle)
    rotation = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    bounds = entity["bounds"]
    points = np.array(
        [
            [x, y, z]
            for x in [bounds["min"][0], bounds["max"][0]]
            for y in [bounds["min"][1], bounds["max"][1]]
            for z in [bounds["min"][2], bounds["max"][2]]
        ]
    )
    points = points @ rotation.T + placement["translation"]
    entity["bounds"] = {"min": points.min(axis=0).tolist(), "max": points.max(axis=0).tolist()}
    entity.setdefault("transform", {})["yaw"] = entity.get("transform", {}).get("yaw", 0) + placement["yaw"]
    return entity


def build(root):
    root, config = workspace_config(root)
    buildings = read(root, "build/onemap-entities.json")
    ground = read(root, "build/ground.json") if config["oneMap"].get("imagery") else []
    if config.get("host"):
        placement = read(root, "build/placement.json")
        entities = [placed(e, placement) for e in buildings + ground] + placement["hostEntities"]
    else:
        entities = buildings + ground + read(root, "build/own-tower.json")
    return save(root, config, entities)


def save(root, config, entities):
    if not entities:
        raise ReconError("没有可导入的背景物件；请检查数据范围和宿主建筑编号")
    if len({e["entityId"] for e in entities}) != len(entities):
        raise ReconError("背景物件编号重复；调整前缀后重试")
    for entity in entities:
        if not entity["entityId"].startswith(config["entityPrefix"]):
            raise ReconError("背景物件超出配置前缀")
        entity.setdefault("props", {})["background"] = True
    # 配置随一个背景物件进入草稿与时间线，新 worker 可从快照恢复；不依赖 Git。
    entities[0]["props"]["backgroundConfig"] = config
    artifact = {
        "version": 1,
        "entityPrefix": config["entityPrefix"],
        "message": config.get("message", "调整空间背景"),
        "entities": entities,
    }
    write(root, "out/context/entities.json", artifact)
    return {
        "file": "out/context/entities.json",
        "entities": len(entities),
        "assets": len({e["assetHash"] for e in entities}),
    }


def import_model(args):
    root = Path(args.workspace).resolve()
    model = Path(args.model).resolve()
    if model.suffix.lower() != ".glb":
        raise ReconError("背景模型须为 GLB；其他地图来源请先用相应适配器转成 GLB")
    if model.stat().st_size > 50 * 1024 * 1024:
        raise ReconError("单个背景 GLB 不能超过 50 MiB；请先拆分模型")
    config = {"version": 1, "entityPrefix": args.prefix, "message": args.label}
    validate(config)
    vector(args.at, "at")
    number(args.yaw, "yaw")
    number(args.overview_distance, "overviewDistance", 0, 1e9)
    scene = trimesh.load_scene(model, process=False)
    if not scene.geometry:
        raise ReconError("GLB 没有网格")
    # 保留节点变换、贴图和米制比例；统一为底面中心原点。
    minimum, maximum = scene.bounds
    center = (minimum + maximum) / 2
    center[1] = minimum[1]
    scene.apply_translation(-center)
    data = scene.export(file_type="glb", include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (root / "assets").mkdir(parents=True, exist_ok=True)
    (root / "assets" / f"{digest}.glb").write_bytes(data)
    at = np.array(args.at)
    entity = {
        "entityId": args.prefix + "model",
        "layer": "ext",
        "kind": "object",
        "label": args.label,
        "regionId": plot_region_id(root),
        "assetHash": digest,
        "bounds": {"min": (minimum - center).tolist(), "max": (maximum - center).tolist()},
        "props": {"来源": args.label, "署名": args.attribution},
    }
    entity = placed(entity, {"yaw": args.yaw, "translation": at.tolist()})
    if args.landmark:
        subjects = [e for e in foreground_entities(read(root, "entities.json")) if e.get("bounds")]
        if not subjects:
            raise ReconError("当前空间没有主体范围，不能自动生成返回标记")
        bounds = {
            "min": np.min([e["bounds"]["min"] for e in subjects], axis=0).tolist(),
            "max": np.max([e["bounds"]["max"] for e in subjects], axis=0).tolist(),
        }
        entity["props"]["landmark"] = {
            "label": args.landmark,
            "focusBounds": bounds,
            "position": np.mean(list(bounds.values()), axis=0).tolist(),
            "minDistance": args.overview_distance,
        }
    return save(root, config, [entity])


def cmd_context(args):
    root = Path(args.workspace).resolve()
    action = args.context_action
    if action == "inspect":
        return inspect(root)
    if action == "import":
        return import_model(args)
    if action == "init":
        if (root / "context.json").exists():
            raise ReconError("context.json 已存在，请直接调整现有配置，避免覆盖已验收参数")
        config = {
            "version": 1,
            "entityPrefix": args.prefix,
            "message": args.label,
            "oneMap": {
                "bboxDegrees": args.bbox,
                "reference": {"lat": args.reference[0], "lon": args.reference[1]},
                "officeFloor": args.floor,
                "officeHeightMeters": args.height,
                "headingDegrees": args.heading,
                "hostSourceId": args.host_id or "待选择",
                "initialPlacement": {"centerX": 0, "frontZ": 0},
                "fallbackBuildingLabel": "地图建筑",
                "tilesBaseUrl": "https://www.onemap.gov.sg/omapi/tilesets/sg_noterrain_tiles/",
                "pageUrl": "https://www.onemap.gov.sg/3d",
                "attribution": args.attribution,
                "manifestAttribution": args.attribution,
                "tilesetFile": "context.tileset.json",
            },
        }
        validate(config)
        write(root, "context.json", config)
        return {"file": "context.json", "next": "download → inspect 选择宿主建筑编号 → convert"}
    if action == "restore":
        entities = read(root, "entities.json")
        configs = [
            e["props"]["backgroundConfig"]
            for e in entities
            if e["entityId"].startswith(args.prefix) and "backgroundConfig" in (e.get("props") or {})
        ]
        if len(configs) != 1:
            raise ReconError("该前缀没有唯一的已保存背景配置，请先 inspect 选择前缀")
        config = validate(configs[0])
        if (root / "context.json").exists() and read(root, "context.json") != config:
            raise ReconError("工作区已有其他配置，请在新的独立工作区恢复，避免覆盖未保存参数")
        write(root, "context.json", config)
        return save(
            root,
            config,
            [
                e
                for e in entities
                if e["entityId"].startswith(args.prefix) and (e.get("props") or {}).get("background") is True
            ],
        )
    root, config = workspace_config(root)
    validate(config, action)
    if action == "check":
        return {"ok": True, "version": config.get("version", 1)}
    if action == "build":
        return build(root)
    from . import convert, download, ground, host

    if action == "run":
        download.main(root)
        convert.main(root)
        if config["oneMap"].get("imagery"):
            ground.main(root)
        if config.get("host"):
            host.main(root)
        return build(root)
    {"download": download, "convert": convert, "ground": ground, "align": host}[action].main(root)
    return {"ok": True, "step": action}


def add_parser(sub):
    parser = sub.add_parser("context", help="背景下载、转换、楼内配准与 GLB 导入（不改平台源码）")
    commands = parser.add_subparsers(dest="context_action", required=True)
    for action in [
        "init",
        "restore",
        "inspect",
        "check",
        "download",
        "convert",
        "ground",
        "align",
        "build",
        "run",
        "import",
    ]:
        command = commands.add_parser(action)
        command.add_argument("--workspace", default=".", help="独立空间工作区（默认当前目录）")
        if action in {"init", "restore"}:
            command.add_argument("--prefix", required=True)
        if action == "init":
            command.add_argument("--label", required=True)
            command.add_argument("--bbox", type=float, nargs=4, required=True, help="西、南、东、北边界")
            command.add_argument("--reference", type=float, nargs=2, required=True, help="参考点纬度、经度")
            command.add_argument("--height", type=float, required=True, help="所在楼层的绝对标高，米")
            command.add_argument("--floor", type=int, required=True)
            command.add_argument("--heading", type=float, default=0)
            command.add_argument("--host-id")
            command.add_argument("--attribution", required=True)
        if action == "import":
            command.add_argument("--model", required=True)
            command.add_argument("--label", required=True)
            command.add_argument("--prefix", required=True, help="以点结尾的稳定物件编号前缀")
            command.add_argument("--at", type=float, nargs=3, default=[0, 0, 0])
            command.add_argument("--yaw", type=float, default=0)
            command.add_argument("--attribution", default="")
            command.add_argument("--landmark")
            command.add_argument("--overview-distance", type=float, default=80)
