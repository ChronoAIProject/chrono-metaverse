"""基线目录（`prepare` 的输出）和物件记录文件的读取。

基线目录：

```
base/
  base.json          清单：来源扫描、对齐方式、各文件、地面高度、耗时
  transform.json     扫描坐标 → 空间坐标的 4×4 变换（列主序，与处理服务 scan_import 的 scan.transform 相同）
  scan.glb           对齐后的扫描（空间坐标，贴图 ≤ 4096）
  structure.json     结构物件（地面、墙、玻璃；entityId → body）+ structure_textures/
  objects.json       现有算法的物体和模板（entityId → body）+ textures/
  candidates.json    候选清单：给 AI 模型师逐件处理
```

所有命令用 `--base <目录>` 指定（默认环境变量 `METAVERSE_RECON_BASE`，再默认 `./base`）。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import cached_property
from typing import Any

import numpy as np

from .core import Box, ReconError, parse_box, read_json

TEXTURE_DIRS = ("textures", "structure_textures")


def default_base() -> str:
    """基线目录：环境变量 `METAVERSE_RECON_BASE`；在命令行工作区里时是 `out/recon/`；再默认 `./base`。"""
    env = os.environ.get("METAVERSE_RECON_BASE")
    if env:
        return env
    from .workspace import BASE_DIR, find_workspace

    ws = find_workspace()
    if ws is not None and ws.path(BASE_DIR).is_dir():
        return str(ws.path(BASE_DIR))
    return "base"


@dataclass
class Base:
    dir: str
    scan_path: str | None = None
    objects_path: str | None = None

    @property
    def scan(self) -> str:
        return self.scan_path or os.path.join(self.dir, "scan.glb")

    @property
    def objects_file(self) -> str:
        return self.objects_path or os.path.join(self.dir, "objects.json")

    @property
    def structure_file(self) -> str:
        return os.path.join(self.dir, "structure.json")

    @cached_property
    def objects(self) -> dict[str, dict]:
        """现有算法的物件（含模板）：entityId → body。没有文件时为空。"""
        if not os.path.exists(self.objects_file):
            return {}
        return as_body_map(read_json(self.objects_file))

    @cached_property
    def structure(self) -> dict[str, dict]:
        if not os.path.exists(self.structure_file):
            return {}
        return as_body_map(read_json(self.structure_file))

    @cached_property
    def templates(self) -> dict[str, dict]:
        return {
            k: b["shape"] for k, b in self.objects.items() if b.get("kind") == "template" and "shape" in b
        }

    @cached_property
    def manifest(self) -> dict:
        path = os.path.join(self.dir, "base.json")
        return read_json(path) if os.path.exists(path) else {}

    def textures(self) -> dict[str, bytes]:
        out: dict[str, bytes] = {}
        for sub in TEXTURE_DIRS:
            d = os.path.join(self.dir, sub)
            if not os.path.isdir(d):
                continue
            for name in os.listdir(d):
                stem, ext = os.path.splitext(name)
                if ext.lower() in (".jpg", ".jpeg", ".png", ".webp") and len(stem) == 64:
                    with open(os.path.join(d, name), "rb") as fh:
                        out[stem] = fh.read()
        return out

    def body(self, eid: str) -> dict | None:
        return self.objects.get(eid) or self.structure.get(eid)

    def floor_y(self) -> float | None:
        ys = [
            b["bounds"]["max"][1]
            for b in self.structure.values()
            if (b.get("props") or {}).get("structure") == "floor"
        ]
        return float(min(ys)) if ys else None


def from_args(args) -> Base:
    return Base(
        getattr(args, "base", None) or default_base(),
        getattr(args, "scan", None),
        getattr(args, "objects", None),
    )


def resolve_box(args, base: Base) -> tuple[Box, str | None]:
    """--box 优先，否则按 --object 到基线的物件（或结构）里取 bounds。返回 (包围盒, entityId)。"""
    if getattr(args, "box", None):
        return parse_box(args.box), getattr(args, "object", None)
    eid = getattr(args, "object", None)
    if eid:
        body = base.body(eid)
        if body is None or "bounds" not in body:
            raise ReconError(f"基线 {base.dir} 里没有物体 {eid}（看 candidates.json 里的编号，或用 --box）")
        return Box.of(body["bounds"]), eid
    raise ReconError("需要 --box 或 --object")


# ---------------------------------------------------------------------------- 物件记录文件


def as_body_map(data: Any) -> dict[str, dict]:
    """entityId → body：接受 body 列表、{entityId: body}、{"objects"|"entities"|"bodies": …}。"""
    if isinstance(data, list):
        return {b["entityId"]: b for b in data if isinstance(b, dict) and "entityId" in b}
    if isinstance(data, dict):
        for key in ("objects", "entities", "bodies"):
            if key in data and isinstance(data[key], list | dict):
                return as_body_map(data[key])
        return {k: dict(v, entityId=v.get("entityId", k)) for k, v in data.items() if isinstance(v, dict)}
    raise ReconError("物件文件必须是对象或列表")


@dataclass
class RecordSet:
    bodies: dict[str, dict]  # 非模板物件
    templates: dict[str, dict]  # 模板编号 → 形状
    template_bodies: dict[str, dict]  # 模板编号 → 模板物件 body（有的话）
    notes: list[str]
    meta: dict  # authored 格式的其他字段（notes、structure、version）


def parse_records(data: Any, name: str = "model") -> RecordSet:
    """模型师的物件文件。支持：AI 物件集（authored.json：`{version, templates: [...], entities: [...]}`）、
    单个 body、body 列表、entityId → body、
    `{"bodies"|"objects"|"entities": [...], "templates": {编号: 形状}}`，
    以及裸形状（有 type 字段，按 entityId = 文件名处理）。"""
    notes: list[str] = []
    templates: dict[str, dict] = {}
    template_bodies: dict[str, dict] = {}
    bodies: list[dict] = []
    meta: dict = {}
    if isinstance(data, dict) and "type" in data and "shape" not in data and "entityId" not in data:
        notes.append(f"文件是裸形状，按 entityId={name} 的物件处理")
        bodies = [{"entityId": name, "kind": "object", "shape": data}]
    elif isinstance(data, list):
        bodies = list(data)
    elif isinstance(data, dict) and ("shape" in data or "entityId" in data or "model" in data):
        bodies = [data]
    elif isinstance(data, dict):
        found = False
        for key in ("entities", "bodies", "objects"):
            if key in data:
                v = data[key]
                bodies = list(v.values()) if isinstance(v, dict) else list(v)
                found = True
        tpls = data.get("templates")
        if isinstance(tpls, dict):
            for k, v in tpls.items():
                if isinstance(v, dict) and "shape" in v:
                    template_bodies[k] = dict(v, entityId=v.get("entityId", k))
                    templates[k] = v["shape"]
                else:
                    templates[k] = v
        elif isinstance(tpls, list):
            for v in tpls:
                if isinstance(v, dict) and "entityId" in v:
                    template_bodies[v["entityId"]] = v
                    templates[v["entityId"]] = v.get("shape")
        if not found and tpls is None:
            bodies = [dict(v, entityId=v.get("entityId", k)) for k, v in data.items() if isinstance(v, dict)]
        meta = {k: data[k] for k in ("version", "notes", "structure") if k in data}
    else:
        raise ReconError("物件文件格式不认识")
    out: dict[str, dict] = {}
    for i, b in enumerate(bodies):
        if not isinstance(b, dict):
            raise ReconError(f"第 {i} 个记录不是对象")
        eid = b.get("entityId") or f"model-{i + 1}"
        if b.get("kind") == "template":
            template_bodies[eid] = dict(b, entityId=eid)
            templates[eid] = b.get("shape")
        elif eid in out:
            raise ReconError(f"同一个文件里物件编号 {eid} 重复")
        else:
            out[eid] = dict(b, entityId=eid)
    return RecordSet(out, templates, template_bodies, notes, meta)


def load_records(path: str) -> RecordSet:
    data = read_json(path)
    return parse_records(data, os.path.splitext(os.path.basename(path))[0])


def is_model_entity(body: dict) -> bool:
    """外部模型物件：没有 shape、带 model（或已经处理好的 assetHash）。"""
    return body.get("shape") is None and (
        isinstance(body.get("model"), dict) or body.get("assetHash") is not None
    )


def bounds_box(bodies) -> Box | None:
    los, his = [], []
    for b in bodies:
        bb = b.get("bounds")
        if bb:
            los.append(bb["min"])
            his.append(bb["max"])
    if not los:
        return None
    return Box(np.min(np.array(los, float), 0), np.max(np.array(his, float), 0))


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
