"""`metaverse-recon bundle --from-snapshot <工作区>`：用拉下来的快照生成整体替换的包（设计 8.3、乙3）。

用途：把一个空间（例如 `metaverse pull --share <链接> --assets` 拉下来的公开快照）的重建层原样搬进新格式——
重建层的物件和模板编号改成 `rb.` 开头（模板引用一起改），`rebuilt.mode = replace`；展开、作用以后重建层的形状
与快照相同，只有编号不同。不读扫描、不重建，所以几秒钟就好。

- 物件、模板：工作区的 `entities.json` 里 `layer: rebuilt` 的；
- 文件：物件模型和贴图按哈希在工作区的 `assets/`（`<哈希>.<扩展名>`）和 `--textures-dir` 给的目录里找，
  缺了就报错
  （包必须完整）；
- 扫描：`space.json` 有网页用模型和变换、`assets/` 里有网页用模型、本地有原始扫描（`scan/scan.zip` 的哈希与
  `scan.assetHash` 相同，或 `--scan` 给的）时带上 `scan`；否则不带（扫描层不变），给出说明；
- 锚点不带（公开快照只有公开锚点，锚点已经在空间里）。
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable, Mapping
from typing import Any

from ..canonical import is_sha256_hex
from ..errors import InputRejected
from .build import prepare_out_dir, run_bundle_check
from .manifest import BundleWriter, prefixed_records, record_refs, sha256_file, write_manifest


def _load_json(path: str, what: str) -> Any:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as error:
        raise InputRejected(f"快照的 {what} 读不了：{error}") from error


def _index(dirs: Iterable[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for root in dirs:
        if not root or not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            stem = name.split(".", 1)[0]
            if is_sha256_hex(stem):
                out.setdefault(stem, os.path.join(root, name))
    return out


def build_from_snapshot(
    workspace: str,
    out_dir: str,
    *,
    upload_limits: Mapping[str, Any],
    base: Mapping[str, Any] | None = None,
    note: str | None = None,
    scan_path: str | None = None,
    texture_dirs: Iterable[str] = (),
    seed: bool = False,
    check: bool = True,
) -> dict[str, Any]:
    """见模块说明。返回打包的统计。"""
    space = _load_json(os.path.join(workspace, "space.json"), "space.json")
    bodies = _load_json(os.path.join(workspace, "entities.json"), "entities.json")
    if not isinstance(bodies, list):
        raise InputRejected("快照的 entities.json 必须是物件数组")
    rebuilt = [b for b in bodies if isinstance(b, Mapping) and b.get("layer") == "rebuilt"]
    if not rebuilt:
        raise InputRejected("快照里没有重建层的物件")
    raw_templates = sorted((b for b in rebuilt if b.get("kind") == "template"), key=lambda b: b["entityId"])
    raw_entities = sorted((b for b in rebuilt if b.get("kind") != "template"), key=lambda b: b["entityId"])
    templates, entities, mapping = prefixed_records(raw_templates, raw_entities)
    prepare_out_dir(out_dir)
    writer = BundleWriter(out_dir, upload_limits)
    files = _index([os.path.join(workspace, "assets"), *texture_dirs])
    missing = []
    for body in [*templates, *entities]:
        models, textures = record_refs(body)
        for sha in sorted(models):
            if sha in files:
                writer.add(files[sha], f"models/{sha[:12]}.glb", "model")
            else:
                missing.append(f"物件模型 {sha}（{body['entityId']}）")
        for sha in sorted(textures):
            if sha in files:
                ext = os.path.splitext(files[sha])[1].lstrip(".").lower() or "jpg"
                writer.add(
                    files[sha], f"textures/{sha[:12]}.{'jpg' if ext in ('jpeg', 'bin') else ext}", "texture"
                )
            else:
                missing.append(f"贴图 {sha}（{body['entityId']}）")
    if missing:
        raise InputRejected(
            "快照引用的这些文件本地没有（metaverse pull --share --assets 下载物件模型；贴图放进 assets/ 或用 "
            "--textures-dir 指定）：" + "；".join(sorted(set(missing))[:10])
        )
    scan = None
    notes = []
    info = space.get("scan") if isinstance(space, Mapping) else None
    if isinstance(info, Mapping) and info.get("webModelHashes") and info.get("transform"):
        local_scan = scan_path or os.path.join(workspace, "scan", "scan.zip")
        web = [files.get(h) for h in info["webModelHashes"]]
        if (
            info.get("assetHash")
            and os.path.isfile(local_scan)
            and sha256_file(local_scan) == info["assetHash"]
            and all(web)
        ):
            ext = os.path.splitext(local_scan)[1].lstrip(".") or "zip"
            scan = {
                "assetHash": writer.add(local_scan, f"scan/scan.{ext}", "scan"),
                "webModelHashes": [writer.add(p, f"web/scan-{i}.glb", "webmodel") for i, p in enumerate(web)],
                "transform": list(info["transform"]),
            }
            if info.get("observedAt"):
                scan["observedAt"] = info["observedAt"]
        else:
            notes.append("没有原始扫描或网页用模型的文件（或哈希对不上）：包里不带 scan，扫描层不变")
    if note is None:
        note = f"重建层按快照整体替换（编号改成 rb. 开头）：物件 {len(entities)} 件、模板 {len(templates)} 个"
    _, manifest_sha = write_manifest(
        writer,
        note=note,
        base=base,
        scan=scan,
        templates=templates,
        entities=entities,
        anchors=[],
        notes_sha=None,
        report={"entities": len(entities), "templates": len(templates), "fromSnapshot": True},
    )
    out = {
        "outDir": out_dir,
        "manifest": manifest_sha,
        "entities": len(entities),
        "templates": len(templates),
        "renamed": sum(1 for k, v in mapping.items() if k != v),
        "files": len(writer.files),
        "scan": scan is not None,
        "notes": notes,
    }
    out["check"] = run_bundle_check(out_dir, seed) if check else {"ran": False}
    return out


__all__ = ["build_from_snapshot"]
