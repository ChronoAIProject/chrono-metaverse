"""compare：模型师写的物件记录（形状物件或外部模型物件）→ 网格 → 与扫描、现有算法并排渲染；
扫描↔模型偏差；校验。

- 一件或几件物体：范围默认取现有算法里同编号物体的包围盒（或记录自己的包围盒）；
- `--scene`：多物件 / 整房对比，范围取全部物件包围盒的并（或 `--box`），现有算法一列显示范围里的全部旧物体，
  逐个物件给偏差；
- `--exclude`：不算这些框里的扫描点（相邻物体、墙上的东西）；
- `--color-parts`：新模型按部件着色（编号与 `compare.json` 的 parts 一致），找哪一块放歪了；
- 结构（墙、玻璃）默认作为背景参与偏差计算（两列都算），贴墙的扫描点不会被当成"没建"。`--no-structure` 关掉。
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree

from ..processing import shape_mesh as sm
from ..processing.fit_texture import SurfaceIndex, fit_stats
from ..records import RecordError, validate_entity_body
from ..shapes import ShapeError
from . import core as wc
from . import models as md
from . import shapes_ext as sx
from .base import Base, RecordSet, from_args, is_model_entity, load_records, parse_records, resolve_box
from .core import r
from .glbout import export_glb
from .i18n import t
from .render import available as render_available
from .render import run_render
from .views import VIEWS, prepare_scan, view_spec, view_title

# ---------------------------------------------------------------------------- 校验


def count_nodes(shape, acc=None):
    acc = acc if acc is not None else {}
    if not isinstance(shape, dict):
        return acc
    kind = shape.get("type")
    acc[kind] = acc.get(kind, 0) + 1
    for c in shape.get("children") or []:
        count_nodes(c, acc)
    return acc


def check_shape_body(eid: str, body: dict, templates: dict) -> dict:
    """形状物件：SHAPES 结构校验（含 plate、hull、opacity、unlit、bake）+ 包围盒 + 按接口服务规则校验整条记录
    （缺的 layer/kind/bounds/props 先补上再校验）。"""
    out: dict = {"entityId": eid, "errors": [], "warnings": [], "filled": [], "type": "shape"}
    shape = body.get("shape")
    out["nodes"] = count_nodes(shape)
    ext = sx.uses_ext(shape)
    if ext:
        out["uses"] = ext
    b = None
    try:
        sx.validate_shape(shape)
        b = sx.rounded_shape_bounds(shape, templates)
        out["computedBounds"] = b
    except ShapeError as e:
        out["errors"].append(f"形状校验：{e}")
    full = dict(body)
    full.setdefault("entityId", eid)
    for k, v in (("layer", "rebuilt"), ("kind", "object"), ("props", {})):
        if k not in full:
            full[k] = v
            out["filled"].append(k)
    if "bounds" not in full and b is not None:
        full["bounds"] = b
        out["filled"].append("bounds")
    elif b is not None and "bounds" in body:
        db = body["bounds"]
        diff = max(abs(db[k][i] - b[k][i]) for k in ("min", "max") for i in range(3))
        if diff > 0.005:
            out["warnings"].append(f"记录里的 bounds 与形状算出的差 {diff:.3f} 米（以算出的为准：{b}）")
            full["bounds"] = b
    if b is not None:
        try:
            validate_entity_body(sx.lower_body(full), sx.lower_templates(templates))
        except (RecordError, ShapeError) as e:
            out["errors"].append(f"记录校验：{e}")
    out["ok"] = not out["errors"]
    if out["filled"]:
        out["warnings"].append(f"记录缺少 {', '.join(out['filled'])}，校验时按默认值补上（提交前请写全）")
    return out


def check_model_body(eid: str, body: dict, local: str | None) -> dict:
    errors, warnings = md.check_model_entity(body)
    out: dict = {"entityId": eid, "type": "model", "errors": errors, "warnings": warnings, "local": local}
    if local is None:
        out["errors"].append(
            "本机找不到这个模型的文件（先用 metaverse-recon fetch 下载，或用 --models-dir 指定目录）"
        )
    else:
        try:
            m = md.load_model_file(local)
            b = md.world_bounds(body, m)
            out["computedBounds"] = b
            out["triangles"] = m.triangles
            if isinstance(body.get("bounds"), dict):
                db = body["bounds"]
                diff = max(abs(db[k][i] - b[k][i]) for k in ("min", "max") for i in range(3))
                if diff > 0.005:
                    out["warnings"].append(f"记录里的 bounds 与按模型算出的差 {diff:.3f} 米（以算出的为准）")
            lo, hi = m.bounds()
            if max(np.abs(lo).max(), np.abs(hi).max()) > md.PROCESSING_COORD_LIMIT:
                out["errors"].append("模型原始坐标超过 ±1000 米，处理服务会拒收（换一个候选）")
        except wc.ReconError as e:
            out["errors"].append(str(e))
    out["ok"] = not out["errors"]
    return out


# ---------------------------------------------------------------------------- 模型集合


@dataclass
class ModelSet:
    """一组要渲染、要算偏差的物件。parts / labels 是空间坐标里的网格块和它们所属的物件编号。"""

    name: str
    bodies: dict[str, dict]
    templates: dict[str, dict]
    parts: list[sm.Part] = field(default_factory=list)
    labels: list[str] = field(default_factory=list)
    externals: dict[str, dict] = field(default_factory=dict)  # 物件编号 → {path, matrix, tint}
    checks: list[dict] = field(default_factory=list)

    @property
    def shape_bodies(self) -> dict[str, dict]:
        return {k: b for k, b in self.bodies.items() if b.get("shape") is not None}


def build_modelset(
    name: str,
    rs: RecordSet,
    extra_templates: dict[str, dict] | None = None,
    models_dirs: list[str] | None = None,
    check: bool = True,
) -> ModelSet:
    templates = {**(extra_templates or {}), **{k: v for k, v in rs.templates.items() if v is not None}}
    ms = ModelSet(name, dict(rs.bodies), templates)
    for eid, body in rs.bodies.items():
        if body.get("shape") is not None:
            chk = check_shape_body(eid, body, templates) if check else {"entityId": eid, "errors": []}
            try:
                ps = sx.build_parts(body["shape"], templates)
            except Exception as e:  # 形状写错时网格生成也可能失败
                chk["errors"].append(f"网格生成失败：{e}")
                chk["ok"] = False
                ps = []
            ms.parts += ps
            ms.labels += [eid] * len(ps)
        elif is_model_entity(body):
            local = md.find_local(body, models_dirs)
            chk = check_model_body(eid, body, local) if check else {"entityId": eid, "errors": []}
            if (local is not None and "computedBounds" in chk) or (local is not None and not check):
                m = md.load_model_file(local)
                ps = md.model_parts(body, m)
                ms.parts += ps
                ms.labels += [eid] * len(ps)
                ms.externals[eid] = {
                    "path": local,
                    "matrix": md.column_major(md.transform_matrix(body.get("transform"))),
                    "tint": (body.get("material") or {}).get("tint"),
                }
        else:
            chk = {"entityId": eid, "errors": ["既没有 shape 也没有 model"], "ok": False}
        if check:
            ms.checks.append(chk)
    return ms


def structure_parts(base: Base, box: wc.Box) -> list[sm.Part]:
    """范围附近的结构（墙、玻璃；不含地面）网格，作为偏差计算的背景。"""
    out = []
    grown = box.grow(0.3)
    for body in base.structure.values():
        if (body.get("props") or {}).get("structure") == "floor" or body.get("shape") is None:
            continue
        bb = wc.Box.of(body["bounds"])
        if np.any(bb.hi < grown.lo) or np.any(bb.lo > grown.hi):
            continue
        out += sm.build_parts(body["shape"], {})
    return out


def base_modelset(base: Base, ids: list[str]) -> ModelSet:
    rs = RecordSet({k: base.objects[k] for k in ids if k in base.objects}, {}, {}, [], {})
    return build_modelset("base", rs, base.templates, check=False)


def objects_in(base: Base, box: wc.Box) -> list[str]:
    out = []
    for eid, body in base.objects.items():
        if body.get("kind") == "template" or "bounds" not in body:
            continue
        bb = wc.Box.of(body["bounds"])
        inter = np.minimum(bb.hi, box.hi) - np.maximum(bb.lo, box.lo)
        if np.all(inter > 0) and np.prod(inter) > 0.3 * np.prod(np.maximum(bb.size, 1e-6)):
            out.append(eid)
    return out


# ---------------------------------------------------------------------------- 偏差


def node_at(shape, path: str, templates: dict):
    """按 build_parts 的路径（如 $.children[2]<tpl-a>.children[0]）找到叶子形状。"""
    node = shape
    for tok in re.findall(r"\.children\[(\d+)\]|<([^>]+)>", path):
        if node is None:
            return None
        if tok[0]:
            kids = node.get("children") or []
            i = int(tok[0])
            node = kids[i] if i < len(kids) else None
        else:
            node = templates.get(tok[1])
    return node


def describe_part(part: sm.Part, eid: str, shape=None, templates=None) -> dict:
    lo, hi = part.mesh.bounds()
    mat = part.material or {}
    leaf = node_at(shape, part.path, templates or {}) if shape is not None else None
    kind = "model" if part.path == "$model" else (leaf or {}).get("type")
    material = mat.get("color") or (mat.get("texture", "")[:12] + "…" if mat.get("texture") else None)
    out = {
        "path": f"{eid}{part.path[1:]}" if part.path != "$model" else eid,
        "type": kind,
        "material": material,
        "bounds": {"min": r(lo, 3), "max": r(hi, 3)},
        "triangles": len(part.mesh.indices),
    }
    for key in ("opacity", "unlit", "bake"):
        if key in mat:
            out[key] = mat[key]
    return out


def stats(d: np.ndarray) -> dict:
    out = fit_stats(d)
    out["within1cm"] = round(float((d <= 0.01).mean()), 3) if len(d) else 0.0
    out["within5cm"] = round(float((d <= 0.05).mean()), 3) if len(d) else 0.0
    out["points"] = len(d)
    return out


def evaluate(
    ms: ModelSet,
    P: np.ndarray,
    C: np.ndarray | None,
    ref_tree: cKDTree,
    floor: float,
    background: list[sm.Part] | None = None,
) -> dict | None:
    """扫描点 → 模型表面（精确点到三角形），模型表面采样 → 扫描（密采样点近似），按部件、按物件拆开的数字。
    背景（结构）参与扫描点的最近距离，但不算进模型→扫描，也不列进部件。"""
    keep = [p for p in ms.parts if len(p.mesh.indices)]
    labels = [lab for p, lab in zip(ms.parts, ms.labels, strict=True) if len(p.mesh.indices)]
    if not keep:
        return None
    bg = [p for p in background or [] if len(p.mesh.indices)]
    meshes = [p.mesh for p in keep] + ([sm.merge_meshes([p.mesh for p in bg])] if bg else [])
    idx = SurfaceIndex.build(meshes, spacing=0.01)
    d, _, tri = idx.query(P, k=4)
    part_of = idx.tri_part[tri]
    is_bg = part_of >= len(keep)
    S = idx.samples
    Sp = idx.tri_part[idx.sample_tri]
    m = (S[:, 1] >= floor - 0.02) & (Sp < len(keep))
    S, Sp = S[m], Sp[m]
    d2, _ = ref_tree.query(S, k=1, distance_upper_bound=1.0)
    d2 = np.minimum(d2, 1.0)
    per = []
    for k, part in enumerate(keep):
        a = d[part_of == k]
        b = d2[Sp == k]
        lab = labels[k]
        shape = (ms.bodies.get(lab) or {}).get("shape")
        item = {
            **describe_part(part, lab, shape, ms.templates),
            "index": k,
            "scanPoints": len(a),
            "scanToPartMeanCm": round(float(a.mean() * 100), 2) if len(a) else None,
            "partToScan": {
                "meanCm": round(float(b.mean() * 100), 2) if len(b) else None,
                "p90Cm": round(float(np.percentile(b, 90) * 100), 2) if len(b) else None,
                "coverage3cm": round(float((b <= 0.03).mean()), 3) if len(b) else None,
            },
        }
        if C is not None and len(a):
            sel = (part_of == k) & (d <= 0.03)
            if sel.sum() >= 5:
                item["scanColor"] = [int(v) for v in np.median(C[sel], 0)]
        per.append(item)
    entities = {}
    for eid in dict.fromkeys(labels):
        ks = [k for k, lab in enumerate(labels) if lab == eid]
        a = d[np.isin(part_of, ks)]
        b = d2[np.isin(Sp, ks)]
        body = ms.bodies.get(eid) or {}
        own = np.zeros(len(P), bool)
        if "bounds" in body:
            own = wc.Box.of(body["bounds"]).grow(0.02).contains(P)
        entities[eid] = {
            "nearestScanPoints": len(a),
            "nearestMeanCm": round(float(a.mean() * 100), 2) if len(a) else None,
            "inBounds": stats(d[own]) if own.any() else None,
            "modelToScan": stats(b) if len(b) else None,
        }
    return {
        "scanToModel": stats(d),
        "scanToBackground": int(is_bg.sum()),
        "modelToScan": stats(d2),
        "parts": per,
        "entities": entities,
        "_d": d,
    }


def missing_clusters(
    P: np.ndarray, d: np.ndarray, thr: float = 0.05, voxel: float = 0.05, top: int = 10, min_points: int = 30
) -> list[dict]:
    """离模型超过 thr 的扫描点按 5 厘米体素（面相邻）连通成块：模型漏掉（或放错）的部分。"""
    far = d > thr
    Q = P[far]
    if len(Q) < 20:
        return []
    lo = Q.min(0)
    ijk = np.floor((Q - lo) / voxel).astype(int)
    grid = np.zeros(ijk.max(0) + 1, bool)
    grid[tuple(ijk.T)] = True
    lab, n = ndimage.label(grid)
    pl = lab[tuple(ijk.T)]
    counts = np.bincount(pl, minlength=n + 1)
    out = []
    for k in np.argsort(-counts):
        if k == 0 or counts[k] < min_points:
            continue
        sel = pl == k
        R = Q[sel]
        out.append(
            {
                "points": int(sel.sum()),
                "min": r(R.min(0), 3),
                "max": r(R.max(0), 3),
                "center": r(R.mean(0), 3),
                "meanDistCm": round(float(d[far][sel].mean() * 100), 1),
            }
        )
        if len(out) >= top:
            break
    return out


# ---------------------------------------------------------------------------- 图


DIST_BINS = [(0.01, (60, 200, 90)), (0.03, (200, 225, 60)), (0.06, (250, 150, 40)), (1e9, (235, 55, 50))]


def dist_colors(d: np.ndarray) -> np.ndarray:
    out = np.zeros((len(d), 3), np.uint8)
    lo = 0.0
    for hi, col in DIST_BINS:
        out[(d >= lo) & (d < hi)] = col
        lo = hi
    return out


def error_map(
    P: np.ndarray, results: list[tuple[str, np.ndarray | None]], box: wc.Box, path: str, title: str
) -> None:
    """扫描点按到模型的距离上色（绿 ≤1 厘米，黄 1–3，橙 3–6，红 >6），三个正交投影，每个模型一行；
    差的点画在上面。"""
    lo, hi = box.lo - 0.05, box.hi + 0.05
    sx_, sy, sz = hi - lo
    projs = [
        (t("俯视 X→ Z↓", "top X→ Z↓"), 0, 2, True),
        (t("正面 X→ Y↑（从 +Z 看）", "front X→ Y↑ (from +Z)"), 0, 1, False),
        (t("侧面 Z→ Y↑（从 -X 看）", "side Z→ Y↑ (from -X)"), 2, 1, False),
    ]
    ppm_top = min(440 / sx_, 520 / sz)
    ppm_side = min(1150 / (sx_ + sz), 300 / sy)
    rows = []
    for name, d in results:
        cells = []
        for pname, a, b, down in projs:
            panel = wc.Panel(
                lo[a],
                hi[a],
                lo[b],
                hi[b],
                v_down=down,
                u_name="XYZ"[a],
                v_name="XYZ"[b],
                title=f"{name} · {pname}",
                ppm=ppm_top if b == 2 else ppm_side,
            )
            if d is not None and len(P):
                order = np.argsort(d)
                wc.plot_points(panel, P[order, a], P[order, b], dist_colors(d[order]))
            else:
                panel.draw.text(
                    (panel.L + 10, panel.T + 10),
                    t("（没有这个模型）", "(no model)"),
                    font=wc.font(14),
                    fill=(220, 220, 220),
                )
            cells.append(panel.finish())
        top, front, side = cells
        bw = top.size[0] + 10 + max(front.size[0], side.size[0])
        bh = max(top.size[1], front.size[1] + 10 + side.size[1])
        block = Image.new("RGB", (bw, bh), (18, 19, 22))
        block.paste(top, (0, 0))
        block.paste(front, (top.size[0] + 10, 0))
        block.paste(side, (top.size[0] + 10, front.size[1] + 10))
        rows.append(block)
    W = max(b.size[0] for b in rows)
    H = sum(b.size[1] for b in rows) + 10 * (len(rows) - 1) + 60
    img = Image.new("RGB", (W, H), (18, 19, 22))
    dr = ImageDraw.Draw(img)
    dr.text((10, 8), title, font=wc.font(16), fill=(255, 255, 255))
    x = 10
    for hi_, col in DIST_BINS:
        lab = {0.01: t("≤1 厘米", "≤1 cm"), 0.03: t("1–3 厘米", "1–3 cm"), 0.06: t("3–6 厘米", "3–6 cm")}.get(
            hi_, t(">6 厘米", ">6 cm")
        )
        dr.rectangle([x, 36, x + 14, 50], fill=col)
        dr.text((x + 20, 43), lab, font=wc.font(13), fill=(230, 233, 238), anchor="lm")
        x += 110
    dr.text(
        (x + 10, 43),
        t("点 = 范围内的扫描表面采样；颜色 = 到该模型表面的距离", "dots = scan samples; color = distance"),
        font=wc.font(13),
        fill=(200, 205, 214),
        anchor="lm",
    )
    y = 60
    for block in rows:
        img.paste(block, (0, y))
        y += block.size[1] + 10
    wc.save_jpeg(img, path, 600_000)


def parse_angles(text: str, front: float, n: int | None = 3) -> list[tuple[str, str, float, float, bool]]:
    out = []
    toks = [p.strip() for p in text.split(",")]
    parts = toks if all(tok in VIEWS for tok in toks) else [p.strip() for p in text.split(";") if p.strip()]
    for i, part in enumerate(parts):
        if part in VIEWS:
            _, _, daz, el, ortho = VIEWS[part]
            out.append((part, view_title(part), front + daz if part != "top" else front, el, ortho))
        else:
            v = part.split(",")
            ortho = len(v) > 2 and v[2].strip().lower().startswith("o")
            title = t(
                f"方位 {float(v[0]):g}° 仰角 {float(v[1]):g}°", f"az {float(v[0]):g}° el {float(v[1]):g}°"
            )
            out.append((f"cam{i + 1}", title, float(v[0]), float(v[1]), ortho))
    if n is not None and len(out) != n:
        raise wc.ReconError(f"--angles 需要正好 {n} 个角度")
    return out


def render_sheet(
    *,
    columns: list[tuple[str, str]],
    models: dict,
    angles,
    box: wc.Box,
    clip: wc.Box,
    floor_y: float,
    grid: dict,
    cut: float | None,
    cell: tuple[int, int],
    workdir: str,
    frame: wc.Box | None = None,
    near_clip: bool = True,
    header: str | None = None,
) -> Image.Image:
    """角度 × 列 的并排图（同一相机、同一贴地网格和黄框）。columns：(组名, 列标题)；models：
    渲染任务的模型表。"""
    cw, ch = cell
    present = {(v.get("group") if isinstance(v, dict) else None) or k for k, v in models.items()}
    specs, slots = [], []
    for ai, (name, title, az, el, ortho) in enumerate(angles):
        for ci, (col, _) in enumerate(columns):
            png = os.path.join(workdir, f"_cell_{ai}_{ci}.png")
            ov = {
                "header": False,
                "rulers": ortho,
                "grid2d": ortho,
                "dims": False,
                "gizmo": ci == 0,
                "tag": title if ci == 0 else None,
            }
            specs.append(
                view_spec(
                    name=name,
                    title=title,
                    az=az,
                    el=el,
                    ortho=ortho,
                    box=box,
                    clip=clip,
                    floor_y=floor_y,
                    cut=cut,
                    near_clip=near_clip,
                    size=[cw, ch],
                    show=[col] if col in present else [],
                    clip_models=["scan"],
                    overlay=ov,
                    out=png,
                    grid=grid,
                    frame=frame,
                )
            )
            slots.append((ai, ci, png))
    run_render(models, specs, workdir)
    head = 34 + (24 if header else 0)
    sheet = Image.new("RGB", ((cw + 4) * len(columns) + 4, head + (ch + 4) * len(angles) + 4), (18, 19, 22))
    d = ImageDraw.Draw(sheet)
    if header:
        d.text((10, 6), header, font=wc.font(15), fill=(255, 230, 140))
    for ci, (_, label) in enumerate(columns):
        d.text(
            (ci * (cw + 4) + cw / 2, head - 17), label, font=wc.font(17), fill=(255, 255, 255), anchor="mm"
        )
    for ai, ci, png in slots:
        with Image.open(png) as im:
            im = im.convert("RGB")
            if columns[ci][0] not in present:
                ImageDraw.Draw(im).text(
                    (cw / 2, ch / 2),
                    t("（没有）", "(none)"),
                    font=wc.font(20),
                    fill=(200, 200, 200),
                    anchor="mm",
                )
            sheet.paste(im, (ci * (cw + 4), head + ai * (ch + 4)))
        os.remove(png)
    return sheet


def add_footer(sheet: Image.Image, lines: list[str]) -> Image.Image:
    foot = 26 * len(lines) + 12
    full = Image.new("RGB", (sheet.size[0], sheet.size[1] + foot), (18, 19, 22))
    full.paste(sheet, (0, 0))
    dd = ImageDraw.Draw(full)
    for i, line in enumerate(lines):
        dd.text(
            (12, sheet.size[1] + 6 + 26 * i),
            line,
            font=wc.font(16),
            fill=(255, 230, 140) if i == len(lines) - 1 else (220, 224, 230),
        )
    return full


def summary_line(name: str, res: dict | None) -> str:
    if res is None:
        return t(f"{name}：无", f"{name}: none")
    a, b = res["scanToModel"], res["modelToScan"]
    return t(
        f"{name}：扫描→模型 均值 {a['meanCm']} 厘米，P90 {a['p90Cm']}，3 厘米内 {a['coverage3cm']:.1%}"
        f"  |  模型→扫描 均值 {b['meanCm']}，P90 {b['p90Cm']}，3 厘米内 {b['coverage3cm']:.1%}",
        f"{name}: scan→model mean {a['meanCm']} cm, P90 {a['p90Cm']}, ≤3cm {a['coverage3cm']:.1%}"
        f"  |  model→scan mean {b['meanCm']}, P90 {b['p90Cm']}, ≤3cm {b['coverage3cm']:.1%}",
    )


def render_models(
    base_glb: str | None, new: ModelSet, new_glb: str | None, scan_glb: str, color_parts: bool
) -> dict:
    models: dict = {"scan": scan_glb}
    if base_glb:
        models["base"] = base_glb
    if new_glb:
        models["new"] = new_glb
    for i, (eid, ext) in enumerate(new.externals.items()):
        tint = list(wc.PALETTE[i % len(wc.PALETTE)]) if color_parts else ext.get("tint")
        models[f"new#{eid}"] = {
            "path": ext["path"],
            "matrix": ext["matrix"],
            "group": "new",
            "lit": True,
            "tint": tint,
        }
    return models


def bake_overrides(ms: ModelSet, res: dict | None) -> dict[str, dict]:
    """烘焙指令的部件按最近扫描点的中位色预览（处理服务会把扫描颜色烘焙成贴图）。"""
    out: dict[str, dict] = {}
    if res is None:
        return out
    for item in res["parts"]:
        if item.get("bake") and item.get("scanColor"):
            out[item["path"]] = {"color": item["scanColor"], "bake": item["bake"]}
    return out


# ---------------------------------------------------------------------------- 命令


def load_model_arg(args) -> RecordSet:
    paths = args.model if isinstance(args.model, list) else [args.model]
    if len(paths) == 1:
        return load_records(paths[0])
    merged = RecordSet({}, {}, {}, [], {})
    for p in paths:
        rs = load_records(p)
        clash = set(rs.bodies) & set(merged.bodies)
        if clash:
            raise wc.ReconError(f"{p} 里的物件编号和前面的文件重复：{sorted(clash)[:5]}")
        merged.bodies.update(rs.bodies)
        merged.templates.update(rs.templates)
        merged.template_bodies.update(rs.template_bodies)
        merged.notes += rs.notes
    return merged


def render_compare(
    args,
    base: Base,
    new: ModelSet,
    old: ModelSet,
    res_new,
    base_ids,
    name,
    scan_glb,
    angles,
    box,
    clip,
    floor_y,
    grid,
    out_dir,
) -> tuple[int, Image.Image]:
    new_glb = os.path.join(out_dir, "_new.glb") if new.shape_bodies else None
    base_glb = os.path.join(out_dir, "_base.glb") if old.parts else None
    textures = base.textures()
    tri_new = 0
    if new_glb:
        tri_new = export_glb(
            {**new.shape_bodies},
            new.templates,
            textures,
            new_glb,
            color_parts=args.color_parts,
            material_override=bake_overrides(new, res_new),
        )["triangles"]
    if base_glb:
        export_glb(old.shape_bodies, old.templates, textures, base_glb)
    cw, ch = (int(v) for v in args.cell.lower().split("x"))
    columns = [
        ("scan", t("扫描（只看包围盒附近）", "scan (near the box)")),
        (
            "base",
            t(f"现有算法 {', '.join(base_ids)[:40] or '（无）'}", f"current {', '.join(base_ids)[:40]}"),
        ),
        ("new", t(f"新模型 {name}", f"new {name}")),
    ]
    if args.columns:
        want = [c.strip() for c in args.columns.split(",")]
        columns = [c for c in columns if c[0] in want]
    models = render_models(base_glb, new, new_glb, scan_glb, args.color_parts)
    sheet = render_sheet(
        columns=columns,
        models=models,
        angles=angles,
        box=box,
        clip=clip,
        floor_y=floor_y,
        grid=grid,
        cut=args.cut,
        cell=(cw, ch),
        workdir=out_dir,
    )
    return tri_new, sheet


def cmd_compare(args) -> dict:
    start = time.time()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    base = from_args(args)
    rs = load_model_arg(args) if args.model else parse_records([], "model")
    if not rs.bodies:
        raise wc.ReconError("记录文件里没有物件（只有模板？）")
    models_dirs = list(args.models_dir or [])
    new = build_modelset("new", rs, base.templates, models_dirs)
    name = os.path.basename(args.model[0] if isinstance(args.model, list) else args.model)

    # 范围和现有算法里对应的物体
    if args.scene:
        if args.box:
            box = wc.parse_box(args.box)
        else:
            bs = [wc.Box.of(c["computedBounds"]) for c in new.checks if c.get("computedBounds")]
            if not bs:
                raise wc.ReconError("算不出物件的包围盒（先修校验错误），或用 --box 指定范围")
            box = bs[0]
            for b in bs[1:]:
                box = box.union(b)
        base_ids = [args.base_id] if args.base_id else objects_in(base, box)
    else:
        base_id = args.base_id or args.object or next((k for k in rs.bodies if k in base.objects), None)
        if not args.box and not args.object and base_id in base.objects:
            args.object = base_id
        if not args.box and not args.object:
            bs = [c["computedBounds"] for c in new.checks if c.get("computedBounds")]
            if not bs:
                raise wc.ReconError("需要 --box 或 --object（模型的包围盒也算不出来）")
            args.box = ",".join(
                str(v) for v in [*np.min([b["min"] for b in bs], 0), *np.max([b["max"] for b in bs], 0)]
            )
        box, _ = resolve_box(args, base)
        base_ids = [base_id] if base_id in base.objects else []
    old = base_modelset(base, base_ids)
    wc.log(
        f"compare：{name}（{len(rs.bodies)} 个物件，{len(rs.templates)} 个模板，"
        f"{len(new.externals)} 个外部模型）；"
        f"现有算法 {', '.join(base_ids) or '无'}；包围盒 {r(box.lo, 3)} – {r(box.hi, 3)}"
    )
    for n in rs.notes:
        wc.log("  " + n)

    clip, floor_y, scan_glb, near, grid, _, hm = prepare_scan(args, box, args.margin, out_dir, base)
    try:
        # 偏差
        t1 = time.time()
        fit_box = box.grow(args.fit_margin)
        part = wc.crop_scan(near, fit_box.grow(0.1))
        P, C, _, _ = wc.sample_points(part, args.density, seed=3)
        keep = fit_box.contains(P) & (P[:, 1] >= wc.floor_at(hm, P) + args.floor_gap)
        excludes = [wc.parse_box(e) for e in args.exclude or []]
        for ex in excludes:
            keep &= ~ex.contains(P)
        P, C = P[keep], C[keep]
        R, _, _, _ = wc.sample_points(part, 20000, seed=4)
        ref_tree = cKDTree(R[fit_box.grow(0.1).contains(R)])
        background = [] if args.no_structure else structure_parts(base, fit_box)
        res_new = evaluate(new, P, C, ref_tree, floor_y, background) if new.parts else None
        res_base = evaluate(old, P, C, ref_tree, floor_y, background) if old.parts else None
        if res_base is not None and len(base_ids) == 1 and base.objects[base_ids[0]].get("fit"):
            res_base["recordedFit"] = base.objects[base_ids[0]]["fit"]
        wc.log(
            f"  偏差：{len(P)} 个扫描点（{args.density:g} 点/平方米，包围盒外扩 {args.fit_margin}，"
            "去掉离局部地面 "
            f"{args.floor_gap} 米以内的和 {len(excludes)} 个排除框里的），背景结构 {len(background)} 块，"
            f"{time.time() - t1:.1f} 秒"
        )

        angles = parse_angles(
            args.angles or ("oblique,top,front" if args.scene else "oblique,front,top"), args.front
        )
        tri_new = 0
        sheet = None
        if args.no_render or not render_available():
            wc.log("  不出并排图（--no-render，或没有渲染工具：metaverse-recon doctor 查看）")
        else:
            tri_new, sheet = render_compare(
                args,
                base,
                new,
                old,
                res_new,
                base_ids,
                name,
                scan_glb,
                angles,
                box,
                clip,
                floor_y,
                grid,
                out_dir,
            )
    finally:
        os.remove(scan_glb)
    cmp_path, nbytes = None, 0
    if sheet is not None:
        lines = [summary_line(t("现有算法", "current"), res_base), summary_line(t("新模型", "new"), res_new)]
        cmp_path = os.path.join(out_dir, "compare.jpg")
        nbytes, _ = wc.save_jpeg(add_footer(sheet, lines), cmp_path, 900_000)

    err_path = os.path.join(out_dir, "compare_error.jpg")
    error_map(
        P,
        [
            (t(f"现有算法 {', '.join(base_ids)[:30]}", "current"), res_base["_d"] if res_base else None),
            (t("新模型", "new"), res_new["_d"] if res_new else None),
        ],
        fit_box,
        err_path,
        t(f"扫描点到模型的距离（{len(P)} 点）", f"scan point to model distance ({len(P)} points)"),
    )
    missing = missing_clusters(P, res_new["_d"]) if res_new else []
    for res in (res_new, res_base):
        if res:
            res.pop("_d")

    out = {
        "model": [os.path.abspath(p) for p in (args.model if isinstance(args.model, list) else [args.model])],
        "entityIds": list(rs.bodies),
        "baseIds": base_ids,
        "box": box.as_dict(),
        "floorY": r(floor_y),
        "fitRegion": fit_box.as_dict(),
        "excluded": [e.as_dict() for e in excludes],
        "scanPoints": len(P),
        "images": {"compare": cmp_path, "error": err_path},
        "rendered": cmp_path is not None,
        "angles": [a[:4] for a in angles],
        "validation": new.checks,
        "triangles": {"new": tri_new},
        "colorParts": bool(args.color_parts),
        "new": res_new,
        "base": res_base,
        "missingFromNew": missing,
        "notes": {
            "scanToModel": "范围内扫描点到模型表面的距离：均值低、3 厘米内比例高 = 扫描到的东西模型都有",
            "modelToScan": "模型表面采样点到扫描的距离：数值大 = 模型有扫描里没有的部分（多建、放错；贴墙、"
            "贴地、"
            "被挡住的背面没被扫到也会偏大）",
            "missingFromNew": "离新模型（和背景结构）超过 5 厘米的扫描点连成的块（漏建或位置不对的地方）",
            "parts.index": "部件编号；--color-parts 时第 i 个部件用调色板第 i 种颜色",
        },
    }
    wc.write_json(os.path.join(out_dir, "compare.json"), out)
    print_compare(out, cmp_path, nbytes, err_path, out_dir)
    print(f"完成，共 {time.time() - start:.1f} 秒")
    return out


def print_compare(out: dict, cmp_path: str | None, nbytes: int, err_path: str, out_dir: str) -> None:
    p = print
    p("\n== 校验")
    for c in out["validation"]:
        extra = f"  用到 {c['uses']}" if c.get("uses") else ""
        p(
            f"  {c['entityId']}（{'外部模型' if c.get('type') == 'model' else '形状'}）："
            f"{'通过' if c.get('ok') else '不通过'}  包围盒 {c.get('computedBounds')}{extra}"
        )
        for e in c["errors"]:
            p(f"    错误：{e}")
        for w in c["warnings"]:
            p(f"    提示：{w}")
    p(f"\n== 偏差（{out['scanPoints']} 个扫描点；单位厘米）")
    p("               扫描→模型: 均值   P90   3cm内  1cm内  |  模型→扫描: 均值   P90   3cm内")
    for name, res in (("现有算法", out["base"]), ("新模型  ", out["new"])):
        if res:
            a, b = res["scanToModel"], res["modelToScan"]
            p(
                f"  {name}            {a['meanCm']:6.2f} {a['p90Cm']:6.2f} "
                f"{a['coverage3cm']:6.1%} {a['within1cm']:6.1%}  |"
                f"            {b['meanCm']:6.2f} {b['p90Cm']:6.2f} {b['coverage3cm']:6.1%}"
            )
    if out["base"] and out["base"].get("recordedFit"):
        p(
            f"  （现有算法自己记录的 fit：{out['base']['recordedFit']}，在它分割出的点上算，口径不同，"
            "只作参考）"
        )
    res = out["new"]
    if res and len(res["entities"]) > 1:
        p("\n== 逐个物件（包围盒内的扫描点到整个新模型；模型→扫描）")
        for eid, e in res["entities"].items():
            ib, ms = e.get("inBounds"), e.get("modelToScan")
            p(
                f"  {eid:<24} 包围盒内 {ib['points'] if ib else 0:6d} 点 均值 {ib['meanCm'] if ib else '-'} "
                f"3cm内 {ib['coverage3cm'] if ib else '-'}  |  模型→扫描 均值 {ms['meanCm'] if ms else '-'}"
            )
    if res:
        p("\n== 新模型分部件（编号 = --color-parts 的颜色序号；扫描点数 = 离这个部件最近的扫描点）")
        for q in res["parts"][:80]:
            pt = q["partToScan"]
            p(
                f"  #{q['index']:<3} {q['path']:<34} {q['type']!s:<8} 颜色 {q['material']!s:<16} "
                f"扫描点 {q['scanPoints']:6d} 均距 {q['scanToPartMeanCm']}  | "
                f"部件→扫描 均值 {pt['meanCm']} P90 {pt['p90Cm']} 3cm内 {pt['coverage3cm']}"
            )
        if len(res["parts"]) > 80:
            p(f"  …… 共 {len(res['parts'])} 个部件，完整列表见 compare.json")
    if out["missingFromNew"]:
        p("\n== 新模型漏掉的扫描块（离模型 >5 厘米）")
        for m in out["missingFromNew"]:
            p(f"  {m['points']} 点  范围 {m['min']} – {m['max']}  平均距离 {m['meanDistCm']} 厘米")
    if cmp_path:
        p(f"\n图：{cmp_path}（{nbytes // 1024} KB）")
    p(f"偏差图：{err_path}\n数字：{os.path.join(out_dir, 'compare.json')}")
