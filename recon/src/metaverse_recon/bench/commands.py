"""本地流水线的命令（设计 8.3）：`align`、`webmodel`、`models`、`bake`、`fit`、`scan-zip`、`bundle`。

都只读写本地文件，不连接本服务；`models`、`bundle`、`scan-zip` 会去模型库、贴图地址和扫描地址下载
（主机列表 `METAVERSE_RECON_MODEL_HOSTS`）。在命令行工作区里（往上能找到 `space.json`）时，扫描、变换、上限、
基线和包目录都有默认值（`workspace.py`）。
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from typing import Any

from ..errors import PermanentJobError
from . import core as wc
from .core import ReconError
from .workspace import (
    BUNDLE_DIR,
    LIMITS_FILE,
    SCAN_ZIP,
    TRANSFORM_FILE,
    WEB_DIR,
    default_path,
    find_workspace,
    read_transform,
    require_path,
    write_transform,
)


def _limits(args) -> dict:
    from ..bundle.limits import load_upload_limits

    path = default_path(getattr(args, "limits", None), LIMITS_FILE)
    return load_upload_limits(path)


def _emit(out: dict) -> dict:
    print(json.dumps(out, ensure_ascii=False, indent=1, default=str))
    return out


def _wrap(fn):
    """本地流水线抛的不可重试错误（`InputRejected` 等）换成工作台的 `ReconError`，命令行只打一行错误。"""

    def run(args):
        try:
            return fn(args)
        except PermanentJobError as error:
            raise ReconError(str(error)) from error

    return run


# ---------------------------------------------------------------------------- align


def _existing_transform_source(path: str) -> str | None:
    """已有变换文件的 `source`（`pull`、`align`……）；文件不在、读不了或没写来源时返回 None。"""
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return None
    source = doc.get("source") if isinstance(doc, dict) else None
    return source if isinstance(source, str) else None


def candidate_path(out: str) -> str:
    """误差超限时结果写到旁边的 `<名字>.candidate.json`，不动正式的变换文件。"""
    root, ext = os.path.splitext(out)
    return f"{root}.candidate{ext or '.json'}"


@_wrap
def cmd_align(args) -> dict:
    """只算对齐：首次自动对齐，或重扫配准到参考扫描；写 `transform.json`，误差超限时退出码非 0。

    两条保护（方法论 3.2）：输出文件是 `metaverse pull` 写的线上变换（`source: pull`）时不覆盖，除非
    `--force`——已有空间的物件和锚点都是按线上变换摆的；配准误差超过 `--max-error-cm` 时不写输出文件，
    结果写到旁边的 `*.candidate.json`，人工确认后再改名使用。"""
    from ..processing import tasks
    from ..processing.align import auto_align, matrix_from_params, register_rescan
    from ..processing.limits import default_limits

    scan = require_path(args.scan, SCAN_ZIP, "扫描（--scan）")
    ws = find_workspace()
    out = args.out or (str(ws.path(TRANSFORM_FILE)) if ws else None)
    if out is None:
        raise ReconError("缺少输出文件（--out；在工作区里默认 scan/transform.json）")
    if _existing_transform_source(out) == "pull" and not args.force:
        raise ReconError(
            f"{out} 是 metaverse pull 写的线上变换：已有空间的物件和锚点都按它摆，不要重新对齐"
            "（重扫要配准到参考扫描，结果用 --out 写到别的文件，确认后再替换）；确实要覆盖就加 --force"
        )
    with tempfile.TemporaryDirectory() as work:
        mesh = tasks.read_scan(scan, os.path.join(work, "scan"), default_limits())
        if args.reference:
            if not args.reference_transform:
                raise ReconError("给了 --reference 就要给 --reference-transform（参考扫描的变换）")
            ref = tasks.read_scan(args.reference, os.path.join(work, "ref"), default_limits())
            ref_space = ref.transformed(matrix_from_params(read_transform(args.reference_transform)))
            del ref
            align = register_rescan(mesh, ref_space)
        else:
            align = auto_align(mesh)
    result = {
        "transform": align.column_major(),
        "alignment": align.summary(),
        "errorCm": None if align.error_cm is None else round(float(align.error_cm), 2),
        "maxErrorCm": args.max_error_cm,
        "candidates": align.candidates,
    }
    too_far = result["errorCm"] is not None and result["errorCm"] > args.max_error_cm
    target = candidate_path(out) if too_far else out
    write_transform(
        target,
        result["transform"],
        "align",
        ws.seq if ws else None,
        alignment=result["alignment"],
        errorCm=result["errorCm"],
        **({"candidates": align.candidates} if align.candidates else {}),
    )
    result["out"] = target
    _emit(result)
    if too_far:
        raise ReconError(
            f"配准误差 {result['errorCm']} 厘米超过 {args.max_error_cm} 厘米：没有写 {out}；结果在 {target}，"
            "人工确认后再改名使用（或换参考扫描、放宽 --max-error-cm 重跑）"
        )
    return result


# ---------------------------------------------------------------------------- webmodel


@_wrap
def cmd_webmodel(args) -> dict:
    """网页用模型（两档 glb，保持扫描原坐标；接缝不裂开的减面、贴图补边），按上限检查三角形和贴图。"""
    from ..processing import tasks
    from ..processing.limits import default_limits
    from ..processing.webmodel import build_web_models

    scan = require_path(args.scan, SCAN_ZIP, "扫描（--scan）")
    limits = _limits(args)["webmodel"]
    ws = find_workspace()
    out_dir = args.out or (str(ws.path(WEB_DIR)) if ws else None)
    if out_dir is None:
        raise ReconError("缺少输出目录（--out；在工作区里默认 web/）")
    os.makedirs(out_dir, exist_ok=True)
    with tempfile.TemporaryDirectory() as work:
        mesh = tasks.read_scan(scan, work, default_limits())
        models = build_web_models(mesh)
    out = []
    for i, m in enumerate(models):
        if m.triangles > int(limits["maxTriangles"]) or m.texture_side > int(limits["maxTextureSide"]):
            raise ReconError(f"网页用模型第 {i} 档超过上限（{m.triangles} 个三角形，贴图 {m.texture_side}）")
        path = os.path.join(out_dir, f"scan-{i}.glb")
        with open(path, "wb") as fh:
            fh.write(m.data)
        out.append(
            {"path": path, "bytes": len(m.data), "triangles": m.triangles, "textureSide": m.texture_side}
        )
    return _emit({"webModels": out})


# ---------------------------------------------------------------------------- models


def _models_dirs(args) -> list[str]:
    from .models import models_dir

    return [models_dir(), *(getattr(args, "models_dir", None) or [])]


def _read_authored(path: str) -> Any:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as error:
        raise ReconError(f"物件集 {path} 读不了：{error}") from error


@_wrap
def cmd_models(args) -> dict:
    """外部模型：找本地文件或下载、核对，按物件模型的上限导出 glb（缩放、俯仰、翻滚、调色烘进模型，偏航写进
    记录），同一个模型只因偏航不同的共用一份；`--render` 出导出后与原文件的对照图（网站同样的灯光）。"""
    from ..authored import parse_authored
    from ..bundle.limits import processing_limits
    from ..bundle.models import export_entity_models, resolve_sources
    from ..bundle.textures import check_authored

    raw = _read_authored(args.authored)
    check_authored(raw)
    parsed = parse_authored(
        {**raw, "templates": [], "entities": [e for e in raw["entities"] if "model" in e]}
    )
    if args.only:
        keep = {s.strip() for s in args.only.split(",")}
        parsed["models"] = {k: v for k, v in parsed["models"].items() if k in keep}
    limits = processing_limits(_limits(args))
    os.makedirs(args.out, exist_ok=True)
    work = os.path.join(args.out, "_work")
    sources, stats = resolve_sources(
        {"sources": {v["source"]: parsed["sources"][v["source"]] for v in parsed["models"].values()}},
        work,
        search_dirs=_models_dirs(args),
        max_model_bytes=int(limits["max_model_bytes"]),
        download=not args.offline,
    )
    if stats["missing"]:
        raise ReconError(
            f"{len(stats['missing'])} 个外部模型本地没有（--offline）：先 fetch 或去掉 --offline"
        )
    files, placed = export_entity_models(parsed, sources, work, limits)
    out_files = {}
    for sha, info in files.items():
        dest = os.path.join(args.out, f"{sha[:12]}.glb")
        shutil.copyfile(info["path"], dest)
        out_files[sha] = {**{k: v for k, v in info.items() if k != "path"}, "file": os.path.basename(dest)}
    entities = {
        eid: {
            "assetHash": p["hash"],
            "file": f"{p['hash'][:12]}.glb",
            **({"transform": {"yaw": p["yaw"]}} if p["yaw"] else {}),
            "bounds": p["bounds"],
        }
        for eid, p in sorted(placed.items())
    }
    report = {
        "entities": entities,
        "files": out_files,
        "summary": {
            "entities": len(entities),
            "files": len(out_files),
            "bytes": sum(f["bytes"] for f in out_files.values()),
            "localSources": stats["local"],
            "downloaded": stats["downloaded"],
        },
    }
    wc.write_json(os.path.join(args.out, "models.json"), report)
    if args.render:
        from .exports_view import render_exports

        report["images"] = render_exports(parsed, sources, files, placed, args.out)
    shutil.rmtree(work, ignore_errors=True)
    _emit(report["summary"] | {"out": os.path.join(args.out, "models.json"), "images": report.get("images")})
    return report


# ---------------------------------------------------------------------------- bake / fit


def _base(args):
    from .base import Base, default_base

    base = Base(args.base or default_base())
    if not os.path.exists(base.scan):
        raise ReconError(f"基线 {base.dir} 里没有 scan.glb（先 prepare，或用 --base 指定）")
    return base


@_wrap
def cmd_bake(args) -> dict:
    """烘焙：物件集里带 `bake` 的部件从对齐后的扫描取色，写成贴图；输出新的物件集（贴图写成 `{file}`）。"""
    from ..authored import parse_authored
    from ..processing.authored_build import bake_entity
    from ..processing.bake import FaceTable
    from ..processing.scan import ScanMesh
    from ..shapes import material_textures

    raw = _read_authored(args.authored)
    from ..bundle.textures import check_authored

    check_authored(raw)
    placeholder, _ = _placeholder_textures(raw)
    parsed = parse_authored(placeholder)
    if not parsed["bakes"]:
        return _emit({"baked": 0, "note": "物件集里没有烘焙指令"})
    scan = wc.load_scan(_base(args).scan)
    table = FaceTable(ScanMesh(scan.V, scan.F, scan.UV, scan.texture()))
    templates = {e: b["shape"] for e, b in parsed["templates"].items()}
    os.makedirs(os.path.join(args.out, "textures"), exist_ok=True)
    textures: dict[str, bytes] = {}
    stats: dict[str, Any] = {}
    shapes: dict[str, Any] = {}
    for eid, bakes in sorted(parsed["bakes"].items()):
        body = parsed["entities"][eid]
        stats[eid] = bake_entity(eid, body, bakes, templates, table, textures)
        shapes[eid] = body["shape"]
    for sha, data in textures.items():
        with open(os.path.join(args.out, "textures", f"{sha}.jpg"), "wb") as fh:
            fh.write(data)
    out_doc = json.loads(json.dumps(raw))
    for ent in out_doc["entities"]:
        if ent.get("entityId") in shapes:
            ent["shape"] = _files_for(shapes[ent["entityId"]], set(textures), material_textures)
            ent.pop("textures", None)
    wc.write_json(os.path.join(args.out, "authored.json"), out_doc)
    return _emit(
        {
            "baked": len(shapes),
            "parts": sum(s["parts"] for s in stats.values()),
            "fallback": sum(s["fallback"] for s in stats.values()),
            "textures": len(textures),
            "out": os.path.join(args.out, "authored.json"),
            "note": "新物件集里烘焙出的贴图写成 {file: textures/<哈希>.jpg}（相对 --out），"
            "bundle 时作为贴图文件进包",
        }
    )


def _placeholder_textures(raw: dict) -> tuple[dict, dict]:
    """外链、本地文件的贴图引用先换成占位哈希（只为了能整理物件集；烘焙、偏差不看这些贴图）。"""
    import copy
    import hashlib

    from ..bundle.textures import ref_kind, texture_slots

    doc = copy.deepcopy(raw)
    back: dict[str, Any] = {}
    for where, material, key in texture_slots(doc):
        value = material[key]
        if ref_kind(value, f"{where}.{key}") != "hash":
            sha = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
            back[sha] = value
            material[key] = sha
    return doc, back


def _files_for(shape: Any, baked: set[str], material_textures) -> Any:
    if isinstance(shape, dict):
        out = {k: _files_for(v, baked, material_textures) for k, v in shape.items()}
        material = out.get("material")
        if isinstance(material, dict) and material.get("texture") in baked:
            out["material"] = {**material, "texture": {"file": f"textures/{material['texture']}.jpg"}}
        return out
    if isinstance(shape, list):
        return [_files_for(v, baked, material_textures) for v in shape]
    return shape


@_wrap
def cmd_fit(args) -> dict:
    """逐件偏差：与 `compare`、打包写进记录的 `fit` 同一个函数（外部模型按导出后的网格算）。"""
    from ..processing import object_fit as of
    from .base import load_records
    from .compare import build_modelset, scan_table, writeback_fits

    base = _base(args)
    rs = load_records(args.authored)
    ms = build_modelset("new", rs, base.templates, models_dirs=args.models_dir, check=False)
    structure = {k: v for k, v in rs.bodies.items() if v.get("kind") == "structure"} or base.structure
    background = of.background_meshes(structure, rs.templates)
    fits = writeback_fits(ms, scan_table(wc.load_scan(base.scan)), background)
    rows = [{"entityId": eid, "points": f["points"], **(f["fit"] or {})} for eid, f in sorted(fits.items())]
    from ..bundle.manifest import fit_report

    report = {"entities": rows, "summary": fit_report(rows)}
    if args.out:
        wc.write_json(args.out, report)
    return _emit(report["summary"] | {"out": args.out} if report["summary"] else {"entities": len(rows)})


# ---------------------------------------------------------------------------- scan-zip


@_wrap
def cmd_scan_zip(args) -> dict:
    """把扫描成员按接口服务部署种子的规则打成 zip（成员来自来源表或命令行，先下载、核对）。"""
    from ..bundle.manifest import sha256_file
    from ..bundle.scanzip import fetch_members, pack_stored_zip

    ws = find_workspace()
    out = args.out or (str(ws.path(SCAN_ZIP)) if ws else None)
    if out is None:
        raise ReconError("缺少输出文件（--out；在工作区里默认 scan/scan.zip）")
    expect = args.hash
    with tempfile.TemporaryDirectory() as work:
        if args.sources:
            doc = wc.read_json(args.sources)
            if not isinstance(doc, dict) or not isinstance(doc.get("files"), dict):
                raise ReconError(
                    '来源表要写成种子用的格式：{"format": "chrono-metaverse-bundle-sources", "version": 1, '
                    '"files": {<sha256>: {"url": …} 或 {"zip": [成员…]}}}（设计 7.1）'
                )
            entries = {k: v for k, v in doc["files"].items() if isinstance(v, dict) and "zip" in v}
            if args.hash:
                if args.hash not in entries:
                    raise ReconError(f"来源表里没有 {args.hash} 的 zip 成员")
                members_spec = entries[args.hash]["zip"]
            elif len(entries) == 1:
                expect, members_spec = next((k, v["zip"]) for k, v in entries.items())
            else:
                raise ReconError("来源表里有几个 zip，用 --hash 指定")
            members = fetch_members(members_spec, work)
        elif args.member:
            members = []
            for item in args.member:
                name, _, path = item.partition("=")
                if not name or not path:
                    raise ReconError("--member 写成 成员名=本地文件")
                members.append((name, path))
        else:
            raise ReconError("给 --sources（来源表）或 --member 成员名=文件")
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        pack_stored_zip(members, out)
    sha = sha256_file(out)
    result = {"out": out, "sha256": sha, "size": os.path.getsize(out), "members": [m[0] for m in members]}
    if expect and sha != expect:
        raise ReconError(f"打出来的 zip 哈希 {sha} 与期望的 {expect} 不同（成员或顺序不对）")
    return _emit(result)


# ---------------------------------------------------------------------------- bundle


@_wrap
def cmd_bundle(args) -> dict:
    """打包（设计 8.3）：物件集或 `--algorithm` → 重建包目录；`--from-snapshot` 用拉下来的快照。"""
    from ..bundle.build import build_bundle
    from ..bundle.snapshot import build_from_snapshot

    ws = find_workspace()
    out_dir = args.out or (str(ws.path(BUNDLE_DIR)) if ws else None)
    if out_dir is None:
        raise ReconError("缺少包目录（--out；在工作区里默认 out/bundle）")
    upload = _limits(args)
    base = None
    if not args.no_base and ws is not None:
        base = ws.base_ref()
        if base is None and not args.from_snapshot:
            print(
                "注意：工作区还没有 metaverse pull 过（没有 space.json 或版本号），清单不写 base；"
                "metaverse bundle push 时要加 --base latest，或者先 metaverse pull 再打包",
                file=sys.stderr,
            )
    if args.from_snapshot:
        snap_ws = find_workspace(args.from_snapshot)
        if base is None and not args.no_base and snap_ws is not None:
            base = snap_ws.base_ref()
        res = build_from_snapshot(
            args.from_snapshot,
            out_dir,
            upload_limits=upload,
            base=base,
            note=args.note,
            scan_path=args.scan,
            texture_dirs=args.textures_dir or [],
            seed=args.seed,
            check=not args.no_check,
        )
        return _report_bundle(res)
    if bool(args.authored) == bool(args.algorithm):
        raise ReconError(
            "给 --authored 物件集，或 --algorithm（用算法的结构和物体），二选一；或者 --from-snapshot"
        )
    scan = require_path(args.scan, SCAN_ZIP, "扫描（--scan）")
    transform_file = require_path(args.transform, TRANSFORM_FILE, "变换（--transform）")
    from .base import Base, default_base

    base_dir = Base(args.base or default_base()).dir
    texture_dirs = [
        *(args.textures_dir or []),
        os.path.join(base_dir, "structure_textures"),
        os.path.join(base_dir, "textures"),
    ]
    os.makedirs(os.path.dirname(os.path.abspath(out_dir)), exist_ok=True)
    work = tempfile.mkdtemp(prefix="bundle-", dir=os.path.dirname(os.path.abspath(out_dir)))
    try:
        res = build_bundle(
            scan_path=scan,
            transform=read_transform(transform_file),
            out_dir=out_dir,
            workdir=work,
            upload_limits=upload,
            authored_path=args.authored,
            hints=wc.read_json(args.hints) if args.hints else None,
            webmodels=args.webmodel,
            base=base,
            note=args.note,
            seed=args.seed,
            model_dirs=_models_dirs(args),
            texture_dirs=texture_dirs,
            observed_at=args.observed_at,
            notes_path=args.notes,
            check=not args.no_check,
            algorithm_anchors=args.anchors,
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)
    report_path = os.path.join(os.path.dirname(os.path.abspath(out_dir)), "bundle-report.json")
    wc.write_json(report_path, res)
    res["report"] = report_path
    return _report_bundle(res)


def _report_bundle(res: dict) -> dict:
    brief = {k: v for k, v in res.items() if k not in ("fit", "timings", "authored")}
    public = [a for a in res.get("anchorList") or [] if a.get("visibility") == "public"]
    if public:
        print(
            f"注意：包里有 {len(public)} 个公开锚点（服务端只建本空间从没出现过的编号；锚点只增不删，"
            "标签会显示在场景里和来源面板上，后面的包改不掉），发布前看一遍标签：",
            file=sys.stderr,
        )
        for a in public:
            print(f"  {a.get('anchorId')}（{a.get('kind')}）：{a.get('label', '')}", file=sys.stderr)
    if res.get("suggestedAnchors"):
        print(
            f"按类别建议了 {len(res['suggestedAnchors'])} 个锚点，没有放进包（--algorithm 的分类可能不对）；"
            "看过确认要建再加 --anchors，或者用实体区草稿另建：",
            file=sys.stderr,
        )
        for a in res["suggestedAnchors"]:
            print(f"  {a.get('anchorId')}（{a.get('kind')}）：{a.get('label', '')}", file=sys.stderr)
    check = res.get("check") or {}
    if not check.get("ran"):
        brief["check"] = (
            f"没有找到 metaverse 命令行，请运行：{check.get('command')}"
            if check.get("command")
            else "没有检查"
        )
    _emit(brief)
    if check.get("ran") and not check.get("ok"):
        print(check.get("output", ""), file=sys.stderr)
        raise ReconError("metaverse bundle check 没有通过（见上面的输出）")
    return res


__all__ = [
    "cmd_align",
    "cmd_bake",
    "cmd_bundle",
    "cmd_fit",
    "cmd_models",
    "cmd_scan_zip",
    "cmd_webmodel",
]
