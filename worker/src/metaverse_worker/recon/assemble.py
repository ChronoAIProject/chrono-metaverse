"""assemble：把逐件做好的物件文件合并成 AI 物件集（`authored.json`），并做整房检查。

AI 物件集（写回路径接收的格式，`rebuild` 任务交给处理服务写进时间线）：

```json
{ "version": 1,
  "templates": [ 模板物件 body（kind "template"）… ],
  "entities":  [ 物件 body … ],     // 空间坐标（与 scan_import 的对齐坐标系相同，也就是 prepare 的坐标系）
  "notes": "建模过程记录（可选，≤ 64KB）",
  "structure": "keep" | "replace" }
  // keep：结构沿用算法结果；replace：用 entities 里 kind "structure" 的物件
```

物件可以是形状物件（shape + material，材质可带 `bake` 烘焙指令）或外部模型物件（`model` + `transform` +
`bounds` + `props.source`，见 `models.py`）。

合并时：模板按编号去重（内容不同就报错）、物件编号唯一、引用的模板必须存在、每个物件逐个校验、包围盒按形状
或模型重算。输出目录：`authored.json`、`room.glb`（整房预览：结构 + 物件）、`room.jpg`（扫描 | 现有算法 |
AI 重建：总览、俯视、四个角）、`report.json`（逐件偏差表、漏建的扫描团块）。
"""

from __future__ import annotations

import io
import json
import os
import time
from collections.abc import Iterator

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree

from ..canonical import canonical_json
from ..processing import shape_mesh as sm
from ..processing.fit_texture import SurfaceIndex
from . import core as wc
from . import models as md
from . import shapes_ext as sx
from .base import Base, from_args, load_records
from .compare import add_footer, check_model_body, check_shape_body, render_sheet, stats
from .core import r
from .glbout import export_glb
from .i18n import t
from .render import available as render_available

MAX_NOTES_BYTES = 64 * 1024
ENTITY_FILES = ("entity.json", "model.json")
MODEL_KEYS = {
    "entityId",
    "layer",
    "kind",
    "label",
    "anchorId",
    "regionId",
    "model",
    "transform",
    "bounds",
    "material",
    "fit",
    "props",
}


class AssembleError(wc.ReconError):
    pass


def entity_files(paths: list[str]) -> Iterator[str]:
    """文件原样用；目录里递归找 entity.json 和 model.json（概念验证的写法）。"""
    for p in paths:
        if os.path.isdir(p):
            for dirpath, _, files in sorted(os.walk(p)):
                for name in sorted(files):
                    if name in ENTITY_FILES:
                        yield os.path.join(dirpath, name)
        elif os.path.exists(p):
            yield p
        else:
            raise AssembleError(f"找不到 {p}")


def template_refs(shape) -> set[str]:
    out: set[str] = set()
    if isinstance(shape, dict):
        if shape.get("type") == "instance" and isinstance(shape.get("template"), str):
            out.add(shape["template"])
        for c in shape.get("children") or []:
            out |= template_refs(c)
    return out


def merge(paths: list[str]) -> tuple[dict[str, dict], dict[str, dict], list[str], list[str]]:
    """返回 (模板编号 → 模板物件 body, 物件编号 → body, 错误, 提示)。"""
    templates: dict[str, dict] = {}
    entities: dict[str, dict] = {}
    origin: dict[str, str] = {}
    errors: list[str] = []
    notes: list[str] = []
    for path in entity_files(paths):
        data = wc.read_json(path)
        if isinstance(data, dict) and "local" in data and "library" in data:
            notes.append(f"{path} 是 fetch 的模型旁注，不是物件记录，跳过")
            continue
        rs = load_records(path)
        for tid, shape in rs.templates.items():
            body = rs.template_bodies.get(tid) or {
                "entityId": tid,
                "layer": "rebuilt",
                "kind": "template",
                "shape": shape,
            }
            body = {**body, "entityId": tid, "kind": "template"}
            body.setdefault("layer", "rebuilt")
            body.setdefault("props", {})
            if tid in templates:
                if canonical_json(templates[tid]["shape"]) != canonical_json(body.get("shape")):
                    errors.append(f"模板 {tid} 在 {origin['tpl:' + tid]} 和 {path} 里内容不同")
                continue
            templates[tid] = body
            origin["tpl:" + tid] = path
        for eid, body in rs.bodies.items():
            if eid in entities:
                if canonical_json(entities[eid]) == canonical_json(body):
                    continue
                errors.append(f"物件编号 {eid} 重复：{origin[eid]} 和 {path}")
                continue
            entities[eid] = body
            origin[eid] = path
    clash = sorted(set(templates) & set(entities))
    if clash:
        errors.append(f"模板和物件编号重复：{clash[:5]}")
    return templates, entities, errors, notes


def validate(
    templates: dict[str, dict], entities: dict[str, dict], structure: str, models_dirs: list[str] | None
) -> tuple[list[dict], dict[str, str]]:
    """逐个校验，补默认字段、重算包围盒（原地改 entities / templates）。返回 (每个物件的校验结果,
    外部模型的本地文件)。"""
    shapes = {k: b.get("shape") for k, b in templates.items()}
    checks: list[dict] = []
    locals_: dict[str, str] = {}
    for tid, body in templates.items():
        chk = {"entityId": tid, "type": "template", "errors": [], "warnings": []}
        try:
            sx.validate_shape(body.get("shape"))
            body["bounds"] = sx.rounded_shape_bounds(body["shape"], shapes)
        except Exception as e:
            chk["errors"].append(f"模板形状不合法：{e}")
        missing = template_refs(body.get("shape")) - set(templates)
        if missing:
            chk["errors"].append(f"引用的模板不存在：{sorted(missing)}")
        chk["ok"] = not chk["errors"]
        checks.append(chk)
    for eid, body in entities.items():
        for k, v in (("layer", "rebuilt"), ("kind", "object"), ("props", {})):
            body.setdefault(k, v)
        if body.get("layer") != "rebuilt":
            chk = {"entityId": eid, "errors": ["AI 物件集里的物件必须是 layer = rebuilt"], "warnings": []}
        elif body.get("kind") == "structure" and structure == "keep":
            chk = {
                "entityId": eid,
                "errors": ["structure = keep 时不要放结构物件（要换结构就用 --structure replace）"],
                "warnings": [],
            }
        elif body.get("kind") not in ("object", "structure"):
            chk = {
                "entityId": eid,
                "errors": [f"kind 必须是 object 或 structure（模板放进 templates）：{body.get('kind')}"],
                "warnings": [],
            }
        elif body.get("shape") is not None:
            missing = template_refs(body["shape"]) - set(templates)
            chk = check_shape_body(eid, body, shapes)
            if missing:
                chk["errors"].append(f"引用的模板不存在：{sorted(missing)}")
            if chk.get("computedBounds"):
                body["bounds"] = chk["computedBounds"]
        elif body.get("model") is not None or body.get("assetHash") is not None:
            local = md.find_local(body, models_dirs)
            chk = check_model_body(eid, body, local)
            extra = sorted(set(body) - MODEL_KEYS - ({"assetHash"} if body.get("assetHash") else set()))
            if extra:
                chk["errors"].append(f"外部模型物件有不认识的字段：{extra}")
            if local is None:
                # 本机没有文件时不能重算包围盒；校验仍然报错（写回需要正确的包围盒）
                pass
            elif chk.get("computedBounds"):
                body["bounds"] = chk["computedBounds"]
                locals_[eid] = local
        else:
            chk = {"entityId": eid, "errors": ["既没有 shape 也没有 model"], "warnings": []}
        chk["ok"] = not chk["errors"]
        checks.append(chk)
    if structure == "replace" and not any(b.get("kind") == "structure" for b in entities.values()):
        checks.append(
            {
                "entityId": "(structure)",
                "errors": ["structure = replace 但没有任何 kind = structure 的物件"],
                "warnings": [],
                "ok": False,
            }
        )
    return checks, locals_


# ---------------------------------------------------------------------------- 整房检查


def external_parts(entities: dict[str, dict], locals_: dict[str, str], textures: dict[str, bytes]) -> dict:
    """外部模型 → 空间坐标里的网格块（带贴图，整房预览 glb 用）。"""
    import hashlib

    out = {}
    for eid, path in locals_.items():
        body = entities[eid]
        m = md.load_model_file(path)
        mesh = md.world_mesh(body, m)
        mat: dict = {"color": [round(c * 255) for c in m.base_color[:3]]}
        if m.texture is not None and m.uv is not None:
            buf = io.BytesIO()
            img = Image.fromarray(m.texture[:, :, :3])
            img.thumbnail((1024, 1024))
            img.save(buf, "JPEG", quality=85)
            key = hashlib.sha256(buf.getvalue()).hexdigest()
            textures[key] = buf.getvalue()
            mat = {"texture": key, "uv": "mesh"}
            tint = (body.get("material") or {}).get("tint")
            if tint:
                mat["tint"] = tint
        out[eid] = [sm.Part(mesh, mat, "$model")]
    return out


def room_box(base: Base) -> wc.Box:
    boxes = [wc.Box.of(b["bounds"]) for b in base.structure.values() if "bounds" in b]
    if not boxes:
        boxes = [wc.Box.of(b["bounds"]) for b in base.objects.values() if "bounds" in b]
    box = boxes[0]
    for b in boxes[1:]:
        box = box.union(b)
    return box


def all_parts(bodies: dict[str, dict], templates: dict[str, dict], extra: dict | None = None):
    parts, labels = [], []
    for eid, body in bodies.items():
        if body.get("kind") == "template" or body.get("shape") is None:
            continue
        ps = sx.build_parts(body["shape"], templates)
        parts += ps
        labels += [eid] * len(ps)
    for eid, ps in (extra or {}).items():
        parts += ps
        labels += [eid] * len(ps)
    return parts, labels


def clusters(
    P: np.ndarray, far: np.ndarray, voxel: float = 0.1, min_points: int = 25, top: int = 15
) -> list[dict]:
    Q = P[far]
    if len(Q) < min_points:
        return []
    lo = Q.min(0)
    ijk = np.floor((Q - lo) / voxel).astype(int)
    grid = np.zeros(ijk.max(0) + 1, bool)
    grid[tuple(ijk.T)] = True
    lab, n = ndimage.label(grid, structure=np.ones((3, 3, 3)))
    pl = lab[tuple(ijk.T)]
    counts = np.bincount(pl, minlength=n + 1)
    out = []
    for k in np.argsort(-counts):
        if k == 0 or counts[k] < min_points:
            continue
        R = Q[pl == k]
        out.append(
            {
                "points": int(counts[k]),
                "min": r(R.min(0), 3),
                "max": r(R.max(0), 3),
                "center": r(R.mean(0), 3),
            }
        )
        if len(out) >= top:
            break
    return out


def overlapping(base: Base, c: dict) -> list[str]:
    box = wc.Box(np.array(c["min"]), np.array(c["max"]))
    out = []
    for eid, b in base.objects.items():
        if b.get("kind") != "object":
            continue
        bb = wc.Box.of(b["bounds"]).grow(0.05)
        if np.all(np.minimum(bb.hi, box.hi) > np.maximum(bb.lo, box.lo)):
            out.append(eid)
    return out


def room_report(base: Base, scan: wc.Scan, entities, templates, extra, density: float, cut: float):
    """整房偏差：扫描点（地面以上、剖切高度以下）到 AI 重建（结构 + 物件）的距离；逐件；漏建团块。"""
    floor = base.floor_y() or 0.0
    P, _, _, _ = wc.sample_points(scan, density, seed=11)
    P = P[(P[:, 1] > floor + 0.03) & (P[:, 1] < cut)]
    structure = {k: b for k, b in base.structure.items()}
    s_parts, _ = all_parts(structure, {})
    a_parts, a_labels = all_parts(entities, templates, extra)
    b_parts, _ = all_parts(
        {k: b for k, b in base.objects.items() if b.get("kind") == "object"}, base.templates
    )

    def dist(parts):
        idx = SurfaceIndex.build([p.mesh for p in parts], spacing=0.02)
        d, _, tri = idx.query(P, k=3)
        return d, idx.tri_part[tri], idx

    d_ai, _, idx_ai = dist(a_parts + s_parts)
    d_base, _, _ = dist(b_parts + s_parts)
    tree = cKDTree(P)
    per = []
    for eid, body in entities.items():
        ks = [i for i, lab in enumerate(a_labels) if lab == eid]
        if not ks or "bounds" not in body:
            continue
        own = wc.Box.of(body["bounds"]).grow(0.02).contains(P)
        S = idx_ai.samples[np.isin(idx_ai.tri_part[idx_ai.sample_tri], ks)]
        S = S[S[:, 1] > floor + 0.02]
        m2s = tree.query(S, k=1, distance_upper_bound=1.0)[0] if len(S) else np.zeros(0)
        m2s = np.minimum(m2s, 1.0)
        src = (body.get("props") or {}).get("source")
        src = src if isinstance(src, dict) and body.get("shape") is None else None
        base_d = d_base[own]
        per.append(
            {
                "entityId": eid,
                "kind": "model" if body.get("shape") is None else "shape",
                "source": f"{src['library']}:{src['id']}" if src else None,
                "scanToModel": stats(d_ai[own]) if own.any() else None,
                "baseScanToModel": stats(base_d) if own.any() else None,
                "modelToScan": stats(m2s) if len(m2s) else None,
            }
        )
    far = d_ai > 0.05
    miss = clusters(P, far)
    for c in miss:
        c["baseObjects"] = overlapping(base, c)
    return {
        "points": len(P),
        "floorY": r(floor, 4),
        "cut": cut,
        "ai": stats(d_ai),
        "base": stats(d_base),
        "entities": per,
        "uncovered": miss,
        "note": "扫描点：地面 3 厘米以上、剖切高度以下；AI 和现有算法都带上结构（墙、地面、玻璃）一起算；"
        "uncovered = 离 AI 重建超过 5 厘米的扫描点按 10 厘米体素连成的团块（漏建或放错），baseObjects = "
        "现有算法里"
        "和它重叠的物体",
    }


ROOM_VIEWS = [
    ("overview", ("总览", "overview"), 210, 45, False),
    ("top", ("俯视", "top"), 0, 90, True),
    ("corner-ne", ("东北角", "corner +X+Z"), 45, 35, False),
    ("corner-se", ("东南角", "corner +X-Z"), 135, 35, False),
    ("corner-sw", ("西南角", "corner -X-Z"), 225, 35, False),
    ("corner-nw", ("西北角", "corner -X+Z"), 315, 35, False),
]


def cmd_assemble(args) -> dict:
    start = time.time()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    base = from_args(args)
    templates, entities, errors, notes = merge(args.entities)
    for n in notes:
        wc.log("  " + n)
    checks, locals_ = validate(templates, entities, args.structure, args.models_dir)
    bad = [c for c in checks if c.get("errors")]
    notes_text = ""
    if args.notes:
        with open(args.notes, encoding="utf-8") as fh:
            notes_text = fh.read()
        if len(notes_text.encode()) > MAX_NOTES_BYTES:
            errors.append(f"notes 超过 64KB（{len(notes_text.encode())} 字节）")
    authored = {
        "version": 1,
        "templates": [templates[k] for k in sorted(templates)],
        "entities": [entities[k] for k in sorted(entities)],
        "notes": notes_text,
        "structure": args.structure,
    }
    if not notes_text:
        del authored["notes"]
    path = os.path.join(out_dir, "authored.json")
    wc.write_json(path, authored)
    size = len(json.dumps(authored, ensure_ascii=False).encode())
    print(
        f"AI 物件集：{len(templates)} 个模板，{len(entities)} 个物件"
        f"（外部模型 {sum(1 for b in entities.values() if b.get('model'))} 个）"
        f"，{size // 1024} KB → {path}"
    )
    for c in checks:
        if c.get("errors") or c.get("warnings"):
            print(f"  {c['entityId']}：{'不通过' if c.get('errors') else '通过'}")
            for e in c.get("errors") or []:
                print(f"    错误：{e}")
            for w in c.get("warnings") or []:
                print(f"    提示：{w}")
    for e in errors:
        print(f"  错误：{e}")
    report: dict = {"authored": path, "checks": checks, "errors": errors, "ok": not errors and not bad}
    if report["ok"]:
        report.update(room_outputs(args, base, templates, entities, locals_, out_dir))
    elif not report["ok"]:
        print("有错误，先修好再出整房预览和对比图")
    wc.write_json(os.path.join(out_dir, "report.json"), report)
    print(f"共 {time.time() - start:.1f} 秒")
    if not report["ok"]:
        raise AssembleError(
            f"AI 物件集有 {len(bad) + len(errors)} 处错误（见上面和 {os.path.join(out_dir, 'report.json')}）"
        )
    return report


def room_outputs(args, base: Base, templates, entities, locals_, out_dir: str) -> dict:
    textures = base.textures()
    tpl_shapes = {k: b["shape"] for k, b in templates.items()}
    extra = external_parts(entities, locals_, textures)
    structure = base.structure if args.structure == "keep" else {}
    room = {**structure, **entities}
    glb = os.path.join(out_dir, "room.glb")
    st = export_glb(room, tpl_shapes, textures, glb, extra_parts=extra)
    print(f"整房预览：{glb}（{st['triangles']} 个三角形，{st['bytes'] // 1024} KB）")
    floor = base.floor_y() or 0.0
    cut = args.cut if args.cut is not None else floor + 2.2
    scan = wc.load_scan(base.scan)
    rep = room_report(base, scan, entities, tpl_shapes, extra, args.density, cut)
    out: dict = {"glb": glb, "room": rep}
    print(f"\n== 整房偏差（{rep['points']} 个扫描点，剖切 y ≤ {cut:.2f}；单位厘米）")
    for name, s in (("现有算法", rep["base"]), ("AI 重建", rep["ai"])):
        print(f"  {name}：扫描→模型 均值 {s['meanCm']}，P90 {s['p90Cm']}，3 厘米内 {s['coverage3cm']:.1%}")
    print("\n== 逐件（包围盒内的扫描点 → AI 重建 / 现有算法；模型 → 扫描）")
    for e in rep["entities"]:
        a, b, m = e["scanToModel"], e["baseScanToModel"], e["modelToScan"]
        print(
            f"  {e['entityId']:<16} {e['kind']:<5} {e['source'] or '':<24} "
            f"扫描→AI {a['meanCm'] if a else '-':>6} "
            f"（3cm内 {a['coverage3cm'] if a else '-'}）  扫描→现有 {b['meanCm'] if b else '-':>6}  "
            f"模型→扫描 {m['meanCm'] if m else '-'}"
        )
    if rep["uncovered"]:
        print("\n== 没被任何物件覆盖的扫描团块（离 AI 重建 >5 厘米）")
        for c in rep["uncovered"]:
            print(
                f"  {c['points']:5d} 点  {c['min']} – {c['max']}  现有算法里："
                f"{', '.join(c['baseObjects']) or '无'}"
            )
    if not args.no_render and render_available():
        out["image"] = room_image(args, base, entities, glb, textures, out_dir, cut, rep)
        print(f"\n对比图：{out['image']}")
    return out


def room_image(args, base: Base, entities, glb, textures, out_dir, cut, rep) -> str:
    base_glb = os.path.join(out_dir, "_base.glb")
    export_glb(
        {**base.structure, **{k: b for k, b in base.objects.items()}}, base.templates, textures, base_glb
    )
    models: dict = {"scan": base.scan, "base": base_glb, "new": glb}
    box = room_box(base)
    box.hi[1] = min(box.hi[1], cut)
    clip = box.grow(0.05)
    hm = wc.flat_heightmap(clip, base.floor_y() or 0.0)
    grid = wc.draped_grid(hm, clip, step=0.25, unit=0.5, major=2, big=10)
    cw, ch = (int(v) for v in args.cell.lower().split("x"))
    angles = [(n, t(*names), az, el, ortho) for n, names, az, el, ortho in ROOM_VIEWS]
    columns = [
        ("scan", t("扫描", "scan")),
        ("base", t("现有算法", "current")),
        ("new", t("AI 重建", "AI rebuild")),
    ]
    try:
        sheet = render_sheet(
            columns=columns,
            models=models,
            angles=angles,
            box=box,
            clip=clip,
            floor_y=base.floor_y() or 0.0,
            grid=grid,
            cut=cut,
            cell=(cw, ch),
            workdir=out_dir,
            near_clip=False,
        )
    finally:
        os.remove(base_glb)
    ai, b = rep["ai"], rep["base"]
    lines = [
        t(
            f"现有算法：扫描→模型 均值 {b['meanCm']} 厘米，P90 {b['p90Cm']}，3 厘米内 {b['coverage3cm']:.1%}",
            f"current: scan→model mean {b['meanCm']} cm, P90 {b['p90Cm']}, ≤3cm {b['coverage3cm']:.1%}",
        ),
        t(
            f"AI 重建：扫描→模型 均值 {ai['meanCm']} 厘米，P90 {ai['p90Cm']}，3 厘米内 "
            f"{ai['coverage3cm']:.1%}"
            f"（{len(entities)} 个物件，漏建团块 {len(rep['uncovered'])} 个）",
            f"AI: scan→model mean {ai['meanCm']} cm, P90 {ai['p90Cm']}, ≤3cm {ai['coverage3cm']:.1%}",
        ),
    ]
    path = os.path.join(out_dir, "room.jpg")
    wc.save_jpeg(add_footer(sheet, lines), path, 1_500_000)
    return path
