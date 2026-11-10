"""prepare：扫描 → 基线目录（对齐后的扫描、变换、结构、现有算法物体、候选清单）。

与处理服务 `scan_import` 首次导入**完全相同**的代码路径：直接调用 `processing.tasks.scan_task`（读取 →
`processing.align.auto_align` 对齐 → 结构 + 物体重建，带提示），只是不生成网页用模型、不写数据库。所以基线的
坐标系、结构和物体编号与线上导入同一份扫描的结果一致，AI 物件集打包时不用换算。

输入：Scaniverse 式的 zip（Draco 网格 + 贴图）、glb，或 drc + 单独的贴图（打包成同样的 zip 再处理）。
提示 `--hints` 用处理服务坐标系（与 `scan_import` 的 `hints` 参数相同）。
"""

from __future__ import annotations

import hashlib
import io
import os
import shutil
import time
import zipfile

import numpy as np
from PIL import Image

from ..processing import tasks
from ..processing.limits import default_limits
from ..processing.rebuild import OBJECTS_TARGET, body_textures
from ..processing.scan import matrix_from_column_major, sniff_file
from ..records import detected_by
from . import core as wc
from .core import r

# 现有算法的类别 → (建议做法, 检索用的英文关键词)。只是建议：搜不到或差太多就手写。
CATEGORY_PLAN = {
    "chair": ("search", "office chair conference chair armchair"),
    "armchair": ("search", "armchair lounge chair"),
    "stool": ("search", "stool"),
    "sofa": ("search", "sofa couch"),
    "table": ("search", "table conference table"),
    "plant": ("search", "potted plant"),
    "lamp": ("search", "lamp"),
    "clutter": ("search", ""),
    "counter": ("author", ""),
    "cabinet": ("author", ""),
    "pillar": ("author", ""),
}


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def scan_input(scan: str, texture: str | None, workdir: str) -> str:
    """处理服务收到的那个文件：drc + 单独贴图打包成 Scaniverse 式 zip，其他原样。"""
    if not os.path.exists(scan):
        raise wc.ReconError(f"找不到扫描 {scan}")
    fmt = sniff_file(scan)
    if texture and fmt == "draco":
        if not os.path.exists(texture):
            raise wc.ReconError(f"找不到贴图 {texture}")
        path = os.path.join(workdir, "scan.zip")
        # 与部署种子打包的一样（api 的 demo_seed/pack.rs：不压缩、原文件名）
        with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as zf:
            zf.write(scan, os.path.basename(scan))
            zf.write(texture, os.path.basename(texture))
        return path
    if texture:
        wc.log(f"  提示：扫描不是 drc（{fmt}），忽略 --texture（贴图用文件里自带的）")
    return scan


def write_scan_glb(mesh, path: str, max_tex: int = 4096) -> dict:
    """对齐后的扫描写成 glb（贴图缩到 max_tex、JPEG 质量 85、不打光）。"""
    image = None
    if mesh.texture is not None and mesh.uv is not None:
        tex = Image.fromarray(mesh.texture)
        if max(tex.size) > max_tex:
            s = max_tex / max(tex.size)
            tex = tex.resize((max(1, round(tex.size[0] * s)), max(1, round(tex.size[1] * s))), Image.LANCZOS)
        buf = io.BytesIO()
        tex.convert("RGB").save(buf, format="JPEG", quality=85)
        image = buf.getvalue()
    scan = wc.Scan(mesh.vertices, mesh.faces, mesh.uv if image is not None else None, image)
    wc.write_scan_glb(scan, path)
    return {
        "triangles": len(mesh.faces),
        "vertices": len(mesh.vertices),
        "bytes": os.path.getsize(path),
    }


def candidate_list(objects: dict[str, dict], metrics: dict) -> list[dict]:
    per = (metrics or {}).get("perObject") or {}
    templates = {k for k, b in objects.items() if b.get("kind") == "template"}
    users: dict[str, list[str]] = {}
    for eid, b in objects.items():
        tpl = (
            (b.get("shape") or {}).get("template")
            if (b.get("shape") or {}).get("type") == "instance"
            else None
        )
        if tpl in templates:
            users.setdefault(tpl, []).append(eid)
    out = []
    for eid in sorted(k for k, b in objects.items() if b.get("kind") == "object"):
        b = objects[eid]
        props = b.get("props") or {}
        cat = props.get("category") or "object"
        plan, query = CATEGORY_PLAN.get(cat, ("author", ""))
        lo, hi = np.array(b["bounds"]["min"]), np.array(b["bounds"]["max"])
        shape = b.get("shape") or {}
        tpl = shape.get("template") if shape.get("type") == "instance" else None
        item = {
            "id": eid,
            "category": cat,
            "label": b.get("label"),
            "anchorId": b.get("anchorId"),
            "bounds": b["bounds"],
            "size": r(hi - lo, 3),
            "center": r((lo + hi) / 2, 3),
            "yaw": (shape.get("transform") or {}).get("yaw"),
            "points": (per.get(eid) or {}).get("points"),
            "fit": b.get("fit"),
            "detectedBy": detected_by(props),
            "suggest": plan,
            "query": query,
        }
        if tpl:
            item["template"] = tpl
            item["sameAs"] = sorted(users.get(tpl, []))
        out.append(item)
    return out


def _inputs(args) -> tuple[str, str, list[float] | None]:
    """扫描、输出目录、给定的变换：参数给了就用；在命令行工作区里时默认 scan/scan.zip、out/recon、
    scan/transform.json（`--auto-align` 时不用工作区的变换，重新自动对齐）。"""
    from .workspace import BASE_DIR, SCAN_ZIP, TRANSFORM_FILE, default_path, read_transform, require_path

    scan = require_path(args.scan, SCAN_ZIP, "扫描（--scan）")
    out = require_path(args.out, BASE_DIR, "输出目录（--out）", must_exist=False)
    transform_file = getattr(args, "transform", None)
    if transform_file is None and not getattr(args, "auto_align", False):
        transform_file = default_path(None, TRANSFORM_FILE)
    return scan, out, (read_transform(transform_file) if transform_file else None)


def cmd_prepare(args) -> dict:
    start = time.time()
    args.scan, args.out, transform = _inputs(args)
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    work = os.path.join(out_dir, "_work")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    hints = wc.read_json(args.hints) if args.hints else None
    try:
        source = scan_input(args.scan, args.texture, work)
        limits = default_limits()
        wc.log(
            f"prepare：{args.scan}"
            + (f" + {args.texture}" if args.texture else "")
            + ("（给定的变换，不重新对齐）" if transform is not None else "（首次自动对齐）")
        )
        res = tasks.scan_task(
            scan_path=source,
            workdir=os.path.join(work, "task"),
            limits=limits,
            transform=transform,
            transform_method="given",
            reference=None,
            web_models=False,
            do_rebuild=True,
            hints=hints,
            objects_target=getattr(args, "objects_target", None) or OBJECTS_TARGET,
        )
        mesh = tasks.read_scan(source, os.path.join(work, "read"), limits)
        matrix = matrix_from_column_major(res["transform"])
        scan_info = write_scan_glb(
            mesh.transformed(matrix), os.path.join(out_dir, "scan.glb"), args.max_texture
        )
        src_sha = sha256_file(source)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    rebuild = res["rebuild"]
    entities = rebuild["entities"]
    structure_ids = set(rebuild["structureIds"])
    structure = {k: entities[k] for k in sorted(structure_ids)}
    objects = {k: v for k, v in entities.items() if k not in structure_ids}
    for sub, bodies in (("structure_textures", structure), ("textures", objects)):
        d = os.path.join(out_dir, sub)
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        for sha in sorted({s for b in bodies.values() for s in body_textures(b)}):
            data = rebuild["textures"][sha]
            ext = ".png" if data[:4] == b"\x89PNG" else ".jpg"
            with open(os.path.join(d, sha + ext), "wb") as fh:
                fh.write(data)
    wc.write_json(os.path.join(out_dir, "structure.json"), structure)
    wc.write_json(os.path.join(out_dir, "objects.json"), objects)
    transform = {
        "transform": res["transform"],
        "alignment": res["alignment"],
        "boundsSpace": res.get("boundsSpace"),
        "sameAs": "处理服务 scan_import 首次导入（processing.tasks.scan_task → processing.align.auto_align）",
        "note": "列主序 4×4，扫描坐标 → 空间坐标；与 scan_import 提交里的 scan.transform 相同",
    }
    wc.write_json(os.path.join(out_dir, "transform.json"), transform)
    metrics = rebuild.get("metrics") or {}
    cands = candidate_list(objects, metrics.get("objects") or {})
    wc.write_json(
        os.path.join(out_dir, "candidates.json"),
        {
            "note": "现有算法分出的物体，按编号排列。suggest = search（先去模型库搜现成的）或 "
            "author（定制件，手写形状）；"
            "query 是检索关键词建议；sameAs = 同一个模板的同款物体（只需处理一次，再做模板实例）",
            "objects": cands,
        },
    )
    floor = [
        b["bounds"]["max"][1]
        for b in structure.values()
        if (b.get("props") or {}).get("structure") == "floor"
    ]
    manifest = {
        "version": 1,
        "source": {
            "scan": os.path.abspath(args.scan),
            "texture": os.path.abspath(args.texture) if args.texture else None,
            "sha256": src_sha,
            "processedAs": "zip" if source.endswith("scan.zip") else sniff_file(args.scan),
        },
        "hints": os.path.abspath(args.hints) if args.hints else None,
        "files": {
            "scan": "scan.glb",
            "transform": "transform.json",
            "structure": "structure.json",
            "objects": "objects.json",
            "candidates": "candidates.json",
        },
        "scan": {**(res.get("scan") or {}), "glb": scan_info},
        "floorY": r(min(floor), 4) if floor else None,
        "counts": {
            "structure": len(structure),
            "objects": sum(1 for b in objects.values() if b.get("kind") == "object"),
            "templates": sum(1 for b in objects.values() if b.get("kind") == "template"),
        },
        "metrics": metrics,
        "timings": {**(res.get("timings") or {}), "prepare": round(time.time() - start, 1)},
    }
    wc.write_json(os.path.join(out_dir, "base.json"), manifest)
    print(f"基线 → {out_dir}")
    print(f"  对齐：{res['alignment']}（与原处理服务首次导入相同）")
    print(
        f"  结构 {manifest['counts']['structure']} 个，物体 {manifest['counts']['objects']} 个，模板 "
        f"{manifest['counts']['templates']} 个；地面 y={manifest['floorY']}"
    )
    print("  候选（suggest = search 先搜库，author 手写）：")
    for c in cands:
        same = f"，同款 {len(c['sameAs'])} 个" if c.get("sameAs") else ""
        print(
            f"    {c['id']:<14} {c['category']:<8} {c.get('label') or '':<10} 尺寸 {c['size']}  "
            f"{c['suggest']}{same}"
        )
    print(f"  共 {time.time() - start:.1f} 秒")
    return manifest
