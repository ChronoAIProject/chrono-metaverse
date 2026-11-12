"""背景配置的版本、输入校验与工作区隔离。"""

import json
import math
import re
from pathlib import Path
from urllib.parse import urlsplit

from ..bench.core import ReconError


def read(root, name):
    try:
        return json.loads((Path(root) / name).read_text())
    except (OSError, ValueError) as error:
        raise ReconError(f"无法读取 {name}：{error}") from error


def write(root, name, value):
    path = Path(root) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def fail(path, message):
    raise ReconError(f"context.json {path}：{message}")


def fields(value, path, allowed):
    if not isinstance(value, dict):
        fail(path, "需要一个对象")
    unknown = set(value) - set(allowed.split())
    if unknown:
        fail(path, "未知字段：" + ", ".join(sorted(unknown)))


def number(value, path, low=-1e9, high=1e9):
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        fail(path, "必须是有限数字")
    if not low <= value <= high:
        fail(path, f"必须在 {low}–{high} 之间")


def text(value, path):
    if not isinstance(value, str) or not value.strip() or len(value) > 2000:
        fail(path, "必须是不超过 2000 字的非空字符串")


def vector(value, path, count=3):
    if not isinstance(value, list) or len(value) != count:
        fail(path, f"需要 {count} 个数字")
    for i, item in enumerate(value):
        number(item, f"{path}[{i}]")


def relative_file(value, path):
    text(value, path)
    file = Path(value)
    if file.is_absolute() or ".." in file.parts or "\\" in value:
        fail(path, "必须是工作区内的相对路径")


def source_url(value, path):
    text(value, path)
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"https", "http"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or (parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"})
    ):
        fail(path, "来源须为 HTTPS；本机模拟源可用 HTTP，不能包含凭据")


def validate(config, stage=None):
    fields(config, "$", "version entityPrefix message oneMap host")
    # 旧场景配置没有版本字段，按第一版读取；新建配置始终显式写入版本。
    if type(config.get("version", 1)) is not int or config.get("version", 1) != 1:
        fail("version", "只支持版本 1")
    prefix = config.get("entityPrefix")
    if not isinstance(prefix, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}\.", prefix):
        fail("entityPrefix", "需要以点结尾的物件编号前缀，最多 64 字符")
    if prefix.startswith("rb."):
        fail("entityPrefix", "不能使用重建层保留的 rb. 前缀")
    if "message" in config:
        text(config["message"], "message")
    source = config.get("oneMap")
    if stage in {"download", "convert", "ground", "run"} and source is None:
        fail("oneMap", "该步骤需要 OneMap 来源；本地 GLB 使用 context import")
    if source is not None:
        fields(
            source,
            "oneMap",
            "bboxDegrees reference officeFloor officeHeightMeters headingDegrees hostSourceId "
            "initialPlacement fallbackBuildingLabel tilesBaseUrl pageUrl attribution manifestAttribution "
            "tilesetFile imagery maxTiles",
        )
        bbox = source.get("bboxDegrees")
        vector(bbox, "oneMap.bboxDegrees", 4)
        if not (-180 <= bbox[0] < bbox[2] <= 180 and -85 <= bbox[1] < bbox[3] <= 85):
            fail("oneMap.bboxDegrees", "范围顺序应为西、南、东、北；纬度须在 ±85° 内")
        ref = source.get("reference", {})
        fields(ref, "oneMap.reference", "lat lon")
        number(ref.get("lat"), "oneMap.reference.lat", -85, 85)
        number(ref.get("lon"), "oneMap.reference.lon", -180, 180)
        for key in ["officeHeightMeters", "headingDegrees", "officeFloor"]:
            number(source.get(key), f"oneMap.{key}")
        for key in ["hostSourceId", "fallbackBuildingLabel", "attribution", "manifestAttribution"]:
            text(source.get(key), f"oneMap.{key}")
        for key in ["tilesBaseUrl", "pageUrl"]:
            source_url(source.get(key), f"oneMap.{key}")
        relative_file(source.get("tilesetFile"), "oneMap.tilesetFile")
        initial = source.get("initialPlacement", {})
        fields(initial, "oneMap.initialPlacement", "centerX frontZ")
        if "maxTiles" in source:
            number(source["maxTiles"], "oneMap.maxTiles", 1, 4096)
            if type(source["maxTiles"]) is not int:
                fail("oneMap.maxTiles", "须为整数")
        for key in ["centerX", "frontZ"]:
            number(initial.get(key), f"oneMap.initialPlacement.{key}")
        imagery = source.get("imagery")
        if imagery is not None:
            fields(imagery, "oneMap.imagery", "urlTemplate zoom atlasFile label")
            source_url(imagery.get("urlTemplate"), "oneMap.imagery.urlTemplate")
            number(imagery.get("zoom"), "oneMap.imagery.zoom", 0, 20)
            if not isinstance(imagery["zoom"], int):
                fail("oneMap.imagery.zoom", "须为整数")
            relative_file(imagery.get("atlasFile"), "oneMap.imagery.atlasFile")
            text(imagery.get("label"), "oneMap.imagery.label")
    host = config.get("host")
    if stage == "align" and host is None:
        fail("host", "先从 context inspect 返回的主体中选择楼层、地面和外墙")
    if host is not None:
        fields(
            host,
            "host",
            "modelFile entityPrefix label levelLabel focusRegionId floorEntityId facadeEntityId "
            "sectionHeightMeters facadeDirection facadeNormalMinDot facadeEdgeMinLengthMeters "
            "facadeInsetMeters minimumClearanceMeters boundaryMarginMeters sliceOverlapMeters "
            "overviewDistanceMeters landmark slab note",
        )
        for key in [
            "entityPrefix",
            "label",
            "levelLabel",
            "focusRegionId",
            "floorEntityId",
            "facadeEntityId",
            "note",
        ]:
            text(host.get(key), f"host.{key}")
        if not host["entityPrefix"].startswith(prefix):
            fail("host.entityPrefix", "必须位于当前背景前缀下")
        relative_file(host.get("modelFile"), "host.modelFile")
        for key in [
            "facadeInsetMeters",
            "minimumClearanceMeters",
            "boundaryMarginMeters",
            "sliceOverlapMeters",
            "overviewDistanceMeters",
            "facadeEdgeMinLengthMeters",
        ]:
            number(host.get(key), f"host.{key}", 0, 1e6)
        number(host.get("sectionHeightMeters"), "host.sectionHeightMeters")
        number(host.get("facadeNormalMinDot"), "host.facadeNormalMinDot", -1, 1)
        vector(host.get("facadeDirection"), "host.facadeDirection", 2)
        if sum(x * x for x in host["facadeDirection"]) == 0:
            fail("host.facadeDirection", "方向不能为零")
        marker = host.get("landmark", {})
        fields(marker, "host.landmark", "label offset")
        text(marker.get("label"), "host.landmark.label")
        vector(marker.get("offset"), "host.landmark.offset")
        slab = host.get("slab", {})
        fields(slab, "host.slab", "thicknessMeters color")
        number(slab.get("thicknessMeters"), "host.slab.thicknessMeters", 0.001, 10)
        vector(slab.get("color"), "host.slab.color", 4)
        for value in slab["color"]:
            number(value, "host.slab.color", 0, 255)
    return config


def workspace_config(root=None):
    root = Path(root or Path.cwd()).resolve()
    return root, validate(read(root, "context.json"))


def plot_region_id(root):
    workspace = read(root, "metaverse.json")
    space = read(root, "space.json")
    for plot in space.get("plots", []):
        if plot["id"] == workspace.get("plot"):
            return plot["regionId"]
    # 初次导入时地块可尚未创建，先产生计划，再经管理接口设置布局。
    if workspace.get("plot"):
        return workspace["plot"]
    raise ReconError("背景需要单独的地块；先在 metaverse init 中指定 --plot，再生成布局计划")


def foreground_entities(entities):
    return [
        entity
        for entity in entities
        if not (entity.get("layer") == "ext" and (entity.get("props") or {}).get("background") is True)
    ]
