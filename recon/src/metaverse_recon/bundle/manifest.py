"""写重建包：目录、清单（设计 6.1、6.2，SHAPES 7）、编号前缀 `rb.`、种子用的包（6.8）。

```
out/bundle/
  manifest.json              清单
  scan/scan.zip              原始扫描
  web/scan-0.glb             网页用模型默认档（scan-1.glb 低细节档，可选）
  models/<哈希前 12 位>.glb   物件模型
  textures/<哈希前 12 位>.<扩展名> 贴图（烘焙、结构、工作台和下载的材质贴图）
  notes.md                   建模过程记录（可选）
```

- **编号**：重建层的物件和模板编号统一加 `rb.`（已经是 `rb.` 开头的不变），形状里 `instance` 引用的模板
  编号跟着改；物件的 `anchorId` 不变（锚点编号有现实含义）；
- **清单**：与托管位置无关，只有相对路径、用途、sha256、大小；记录不缩进（每条记录的原始 JSON 不超过 64 KiB，
  清单整体不超过 `limits.json` 的 `bundle.maxBytes`）；文件按用途的大小上限检查；
- **`--seed`**：种子包的一切都会公开，所以去掉内部级锚点和建模记录，`report` 只留偏差统计。

本模块不实现清单校验和展开（`metaverse bundle check`、接口服务做）。
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import subprocess
from collections.abc import Iterable, Mapping
from typing import Any

from .. import __version__
from ..canonical import is_sha256_hex
from ..errors import InputRejected
from ..ids import is_object_id
from ..shapes import material_textures
from ..timeutil import now_ts

FORMAT = "chrono-metaverse-rebuild-bundle"
VERSION = 1
PREFIX = "rb."
MAX_RECORD_BYTES = 64 << 10
MAX_NOTE_CHARS = 2000
MAX_ENTITIES = 2000
MAX_TEMPLATES = 200
MAX_ANCHORS = 2000


# ---------------------------------------------------------------------------- 编号


def rb_id(entity_id: str) -> str:
    """重建层编号：加 `rb.` 前缀（已经有的不变）。"""
    new = entity_id if entity_id.startswith(PREFIX) else PREFIX + entity_id
    if not is_object_id(new):
        raise InputRejected(f"物件编号 {entity_id} 加上 rb. 以后不合法（编号最长 128 个字符）")
    return new


def _rename_templates(shape: Any, mapping: Mapping[str, str]) -> Any:
    if isinstance(shape, dict):
        out = {k: _rename_templates(v, mapping) for k, v in shape.items()}
        if out.get("type") == "instance" and isinstance(out.get("template"), str):
            out["template"] = mapping.get(out["template"], out["template"])
        return out
    if isinstance(shape, list):
        return [_rename_templates(v, mapping) for v in shape]
    return shape


def prefixed_records(
    templates: Iterable[Mapping[str, Any]], entities: Iterable[Mapping[str, Any]]
) -> tuple[list[dict], list[dict], dict[str, str]]:
    """物件和模板换成重建层的 `rb.` 编号（模板引用跟着改），`layer` 一律 `rebuilt`。
    返回 (模板, 物件, 旧 → 新)。"""
    templates, entities = (
        [copy.deepcopy(dict(t)) for t in templates],
        [copy.deepcopy(dict(e)) for e in entities],
    )
    mapping = {b["entityId"]: rb_id(b["entityId"]) for b in [*templates, *entities]}
    if len(set(mapping.values())) != len(mapping):
        raise InputRejected("加上 rb. 以后有物件编号重复")
    for body in [*templates, *entities]:
        body["entityId"] = mapping[body["entityId"]]
        body["layer"] = "rebuilt"
        if "shape" in body:
            body["shape"] = _rename_templates(body["shape"], mapping)
    return templates, entities, mapping


# ---------------------------------------------------------------------------- 引用


def shape_texture_refs(shape: Any) -> set[str]:
    out: set[str] = set()
    if isinstance(shape, dict):
        out |= set(material_textures(shape.get("material")))
        for child in shape.get("children") or []:
            out |= shape_texture_refs(child)
    return out


def record_refs(body: Mapping[str, Any]) -> tuple[set[str], set[str]]:
    """一条记录引用的 (物件模型, 贴图) 哈希。"""
    models = {body["assetHash"]} if body.get("assetHash") else set()
    textures = shape_texture_refs(body.get("shape")) | set(body.get("textures") or [])
    return models, textures


# ---------------------------------------------------------------------------- 写出


def _ext(path: str, default: str) -> str:
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    return {"jpeg": "jpg"}.get(ext, ext) or default


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class BundleWriter:
    """往包目录里放文件，记下 `files[]`（同一哈希只放一次）。"""

    def __init__(self, out_dir: str, upload_limits: Mapping[str, Any]) -> None:
        self.out_dir = out_dir
        self.limits = upload_limits
        self.files: list[dict[str, Any]] = []
        self.by_hash: dict[str, dict[str, Any]] = {}

    def add(self, src: str, rel: str, purpose: str, sha: str | None = None) -> str:
        sha = sha or sha256_file(src)
        if sha in self.by_hash:
            if self.by_hash[sha]["purpose"] != purpose:
                raise InputRejected(
                    f"同一个文件 {sha[:12]} 同时当 {self.by_hash[sha]['purpose']} 和 {purpose} 用"
                )
            return sha
        size = os.path.getsize(src)
        cap = int(self.limits[purpose]["maxBytes"])
        if size > cap:
            raise InputRejected(f"{rel} 有 {size} 字节，超过 {purpose} 的上传上限 {cap}")
        if size == 0:
            raise InputRejected(f"{rel} 是空文件")
        dest = os.path.join(self.out_dir, *rel.split("/"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.abspath(src) != os.path.abspath(dest):
            if os.path.exists(dest):
                os.remove(dest)
            try:
                os.link(src, dest)
            except OSError:
                shutil.copyfile(src, dest)
        entry = {"path": rel, "purpose": purpose, "sha256": sha, "size": size}
        self.files.append(entry)
        self.by_hash[sha] = entry
        return sha

    def add_bytes(self, data: bytes, rel: str, purpose: str) -> str:
        dest = os.path.join(self.out_dir, *rel.split("/"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(data)
        return self.add(dest, rel, purpose, hashlib.sha256(data).hexdigest())

    def model(self, src: str) -> str:
        sha = sha256_file(src)
        return self.add(src, f"models/{sha[:12]}.glb", "model", sha)

    def texture(self, src: str) -> str:
        sha = sha256_file(src)
        return self.add(src, f"textures/{sha[:12]}.{_ext(src, 'jpg')}", "texture", sha)


def tool_info() -> dict[str, str]:
    """清单的 `tool`：名字、版本，从仓库源码运行时加上 `git:<提交哈希>`。"""
    out = {"name": "metaverse-recon", "version": __version__}
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        res = subprocess.run(
            ["git", "-C", here, "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return out
    head = res.stdout.strip()
    if res.returncode == 0 and len(head) == 40 and all(c in "0123456789abcdef" for c in head):
        out["source"] = f"git:{head}"
    return out


def fit_report(fits: Iterable[Mapping[str, Any]]) -> dict[str, Any] | None:
    """逐件偏差 → 清单 `report.fit`：按扫描点数加权的平均（`meanCm`、`p90Cm`、`within3cm`）。"""
    rows = [f for f in fits if f.get("meanCm") is not None and f.get("points")]
    total = sum(int(f["points"]) for f in rows)
    if not total:
        return None

    def avg(key: str) -> float:
        return sum(float(f[key]) * int(f["points"]) for f in rows) / total

    return {
        "meanCm": round(avg("meanCm"), 2),
        "p90Cm": round(avg("p90Cm"), 2),
        "within3cm": round(avg("coverage3cm"), 3),
        "entities": len(rows),
        "points": total,
    }


def dump_manifest(manifest: Mapping[str, Any]) -> bytes:
    """清单的 JSON 文本：顶层每个键一行，记录（模板、物件、锚点、文件）每条一行、不缩进。"""

    def compact(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

    def records(items: list) -> str:
        if not items:
            return "[]"
        return "[\n    " + ",\n    ".join(compact(x) for x in items) + "\n  ]"

    lines = []
    for key, value in manifest.items():
        if key == "rebuilt":
            inner = [f'"mode":{compact(value["mode"])}']
            for part in ("templates", "entities", "remove"):
                if part in value:
                    inner.append(
                        f'"{part}":{records(value[part]) if part != "remove" else compact(value[part])}'
                    )
            text = "{\n  " + ",\n  ".join(inner) + "\n  }"
        elif key in ("anchors", "files"):
            text = records(value)
        else:
            text = compact(value)
        lines.append(f'  "{key}":{text}')
    return ("{\n" + ",\n".join(lines) + "\n}\n").encode("utf-8")


def check_records(manifest: Mapping[str, Any]) -> None:
    """生成时守住清单的几条上限（每条记录 64 KiB、个数、`note` 长度）；完整校验交给
    `metaverse bundle check`。"""
    rebuilt = manifest.get("rebuilt") or {}
    if (
        len(rebuilt.get("entities") or []) > MAX_ENTITIES
        or len(rebuilt.get("templates") or []) > MAX_TEMPLATES
    ):
        raise InputRejected(f"物件最多 {MAX_ENTITIES} 个、模板最多 {MAX_TEMPLATES} 个")
    if len(manifest.get("anchors") or []) > MAX_ANCHORS:
        raise InputRejected(f"锚点最多 {MAX_ANCHORS} 个")
    for group in (
        rebuilt.get("templates") or [],
        rebuilt.get("entities") or [],
        manifest.get("anchors") or [],
    ):
        for body in group:
            size = len(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode())
            if size > MAX_RECORD_BYTES:
                ident = body.get("entityId") or body.get("anchorId")
                raise InputRejected(f"记录 {ident} 有 {size} 字节，超过每条 64 KiB 的上限（形状太复杂）")
    note = manifest.get("note")
    if not isinstance(note, str) or not note.strip() or len(note) > MAX_NOTE_CHARS:
        raise InputRejected(f"note 必须是 1–{MAX_NOTE_CHARS} 字")


def write_manifest(
    writer: BundleWriter,
    *,
    note: str,
    base: Mapping[str, Any] | None,
    scan: Mapping[str, Any] | None,
    templates: list[dict],
    entities: list[dict],
    anchors: list[dict],
    notes_sha: str | None,
    report: Mapping[str, Any] | None,
    mode: str = "replace",
) -> tuple[dict[str, Any], str]:
    """组装清单、守上限、写 `manifest.json`。返回 (清单, 清单的 sha256)。"""
    manifest: dict[str, Any] = {
        "format": FORMAT,
        "version": VERSION,
        "tool": tool_info(),
        "note": note,
        "createdAt": now_ts(),
    }
    if base is not None:
        manifest["base"] = dict(base)
    if scan is not None:
        manifest["scan"] = dict(scan)
    manifest["rebuilt"] = {"mode": mode, "templates": templates, "entities": entities}
    if mode == "merge":
        manifest["rebuilt"]["remove"] = []
    if anchors:
        manifest["anchors"] = anchors
    if notes_sha is not None:
        manifest["notes"] = notes_sha
    if report:
        manifest["report"] = dict(report)
    manifest["files"] = sorted(writer.files, key=lambda f: (f["purpose"] != "scan", f["path"]))
    for f in manifest["files"]:
        if not is_sha256_hex(f["sha256"]):
            raise InputRejected(f"{f['path']} 的哈希不对")
    check_records(manifest)
    data = dump_manifest(manifest)
    cap = int(writer.limits["bundle"]["maxBytes"])
    if len(data) > cap:
        raise InputRejected(f"清单有 {len(data)} 字节，超过上传上限 {cap}")
    path = os.path.join(writer.out_dir, "manifest.json")
    with open(path, "wb") as fh:
        fh.write(data)
    return manifest, hashlib.sha256(data).hexdigest()


def seed_filter(anchors: list[dict], report: Mapping[str, Any] | None) -> tuple[list[dict], dict | None, int]:
    """种子用的包（设计 6.8）：去掉内部级锚点，`report` 只留偏差统计。返回 (锚点, report, 去掉的锚点数)。"""
    public = [a for a in anchors if a.get("visibility") != "internal"]
    kept = {"fit": report["fit"]} if report and report.get("fit") else None
    return public, kept, len(anchors) - len(public)


__all__ = [
    "FORMAT",
    "PREFIX",
    "BundleWriter",
    "check_records",
    "dump_manifest",
    "fit_report",
    "prefixed_records",
    "rb_id",
    "record_refs",
    "seed_filter",
    "sha256_file",
    "tool_info",
    "write_manifest",
]
