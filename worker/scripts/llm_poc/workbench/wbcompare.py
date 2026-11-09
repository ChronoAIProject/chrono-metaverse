"""compare：模型师写的物件记录 → 网格 → 与扫描、现有算法并排渲染；扫描↔模型偏差；形状校验。"""

from __future__ import annotations

import json
import os
import time

import numpy as np
import wbcore as wc
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree
from wbcore import r
from wbviews import VIEWS, prepare_scan, view_spec

from metaverse_worker.processing.fit_texture import SurfaceIndex, fit_stats
from metaverse_worker.processing.preview_glb import export_glb
from metaverse_worker.processing.shape_mesh import build_parts
from metaverse_worker.records import RecordError, validate_entity_body
from metaverse_worker.shapes import ShapeError, rounded_bounds, shape_bounds, validate_shape

# ---------------------------------------------------------------------------- 校验


def count_nodes(shape, acc=None):
    acc = acc if acc is not None else {}
    if not isinstance(shape, dict):
        return acc
    t = shape.get("type")
    acc[t] = acc.get(t, 0) + 1
    for c in shape.get("children") or []:
        count_nodes(c, acc)
    return acc


def check_body(eid: str, body: dict, templates: dict) -> dict:
    """SHAPES 结构校验 + 包围盒 + 按接口服务规则校验整条记录（缺的 layer/kind/bounds/props 先补上再校验）。"""
    out: dict = {"entityId": eid, "errors": [], "warnings": [], "filled": []}
    shape = body.get("shape")
    if shape is None:
        out["errors"].append("没有 shape")
        return out
    out["nodes"] = count_nodes(shape)
    try:
        validate_shape(shape)
    except ShapeError as e:
        out["errors"].append(f"形状校验：{e}")
    try:
        b = rounded_bounds(shape_bounds(shape, templates))
        out["computedBounds"] = b
    except ShapeError as e:
        out["errors"].append(f"包围盒：{e}")
        b = None
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
    try:
        validate_entity_body(full, templates)
    except (RecordError, ShapeError) as e:
        out["errors"].append(f"记录校验：{e}")
    out["ok"] = not out["errors"]
    if out["filled"]:
        out["warnings"].append(f"记录缺少 {', '.join(out['filled'])}，校验时按默认值补上（提交前请写全）")
    return out


# ---------------------------------------------------------------------------- 偏差


def node_at(shape, path: str, templates: dict):
    """按 build_parts 的路径（如 $.children[2]<tpl-a>.children[0]）找到叶子形状。"""
    import re

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


def describe_part(part, eid: str, shape=None, templates=None) -> dict:
    lo, hi = part.mesh.bounds()
    mat = part.material or {}
    leaf = node_at(shape, part.path, templates or {}) if shape is not None else None
    return {"path": f"{eid}{part.path[1:]}", "type": (leaf or {}).get("type"),
            "material": mat.get("color") or (mat.get("texture", "")[:12] + "…"),
            "bounds": {"min": r(lo, 3), "max": r(hi, 3)}, "triangles": len(part.mesh.indices)}  # fmt: skip


def stats(d: np.ndarray) -> dict:
    out = fit_stats(d)
    out["within1cm"] = round(float((d <= 0.01).mean()), 3) if len(d) else 0.0
    out["within5cm"] = round(float((d <= 0.05).mean()), 3) if len(d) else 0.0
    out["points"] = len(d)
    return out


def evaluate(
    parts, labels, P: np.ndarray, ref_tree: cKDTree, floor: float, gap: float, shapes=None, templates=None
) -> dict | None:
    """扫描点 → 模型表面（精确点到三角形），模型表面采样 → 扫描（密采样点近似），以及按部件拆开的数字。"""
    meshes = [p.mesh for p in parts if len(p.mesh.indices)]
    keep = [p for p in parts if len(p.mesh.indices)]
    if not meshes:
        return None
    idx = SurfaceIndex.build(meshes, spacing=0.01)
    d, _, tri = idx.query(P, k=4)
    part_of = idx.tri_part[tri]
    # 模型表面采样（地面以下的不算）
    S = idx.samples
    Sp = idx.tri_part[idx.sample_tri]
    m = S[:, 1] >= floor - 0.02
    S, Sp = S[m], Sp[m]
    d2, _ = ref_tree.query(S, k=1, distance_upper_bound=1.0)
    d2 = np.minimum(d2, 1.0)
    per = []
    for k, part in enumerate(keep):
        a = d[part_of == k]
        b = d2[Sp == k]
        lab = labels[k] if k < len(labels) else ""
        per.append({**describe_part(part, lab, (shapes or {}).get(lab), templates),
                    "scanPoints": len(a), "scanToPartMeanCm": round(float(a.mean() * 100), 2) if len(a) else None,
                    "partToScan": {"meanCm": round(float(b.mean() * 100), 2) if len(b) else None,
                                   "p90Cm": round(float(np.percentile(b, 90) * 100), 2) if len(b) else None,
                                   "coverage3cm": round(float((b <= 0.03).mean()), 3) if len(b) else None}})  # fmt: skip
    return {"scanToModel": stats(d), "modelToScan": stats(d2), "parts": per, "_d": d}


def missing_clusters(
    P: np.ndarray, d: np.ndarray, thr: float = 0.05, voxel: float = 0.05, top: int = 8
) -> list[dict]:
    """离模型超过 thr 的扫描点按 5 厘米体素（面相邻）连通成块：模型漏掉（或放错）的部分。"""
    Q = P[d > thr]
    if len(Q) < 20:
        return []
    lo = Q.min(0)
    ijk = np.floor((Q - lo) / voxel).astype(int)
    shape = ijk.max(0) + 1
    grid = np.zeros(shape, bool)
    grid[tuple(ijk.T)] = True
    lab, n = ndimage.label(grid)
    pl = lab[tuple(ijk.T)]
    out = []
    for k in range(1, n + 1):
        sel = pl == k
        if sel.sum() < 30:
            continue
        R = Q[sel]
        out.append({"points": int(sel.sum()), "min": r(R.min(0), 3), "max": r(R.max(0), 3),
                    "center": r(R.mean(0), 3), "meanDistCm": round(float(d[d > thr][sel].mean() * 100), 1)})  # fmt: skip
    out.sort(key=lambda c: -c["points"])
    return out[:top]


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
    """扫描点按到模型的距离上色（绿 ≤1 厘米，黄 1–3，橙 3–6，红 >6），三个正交投影，每个模型一行；差的点画在上面。"""
    lo, hi = box.lo - 0.05, box.hi + 0.05
    sx, sy, sz = hi - lo
    projs = [
        ("俯视 X→ Z↓", 0, 2, True),
        ("正面 X→ Y↑（从 +Z 看）", 0, 1, False),
        ("侧面 Z→ Y↑（从 -X 看）", 2, 1, False),
    ]
    # 俯视单独定比例；正面和侧面共用一个比例，便于对照高度
    ppm_top = min(440 / sx, 520 / sz)
    ppm_side = min(1150 / (sx + sz), 300 / sy)
    rows = []
    for name, d in results:
        cells = []
        for pname, a, b, down in projs:
            panel = wc.Panel(lo[a], hi[a], lo[b], hi[b], v_down=down, u_name="XYZ"[a], v_name="XYZ"[b],
                             title=f"{name} · {pname}", ppm=ppm_top if b == 2 else ppm_side)  # fmt: skip
            if d is not None and len(P):
                order = np.argsort(d)
                u, v = panel.px(P[order, a], P[order, b])
                cols = dist_colors(d[order])
                arr = np.asarray(panel.img).copy()
                ui, vi = np.round(u).astype(int), np.round(v).astype(int)
                for du in (0, 1):
                    for dv in (0, 1):
                        ok = (
                            (ui + du >= 0)
                            & (ui + du < arr.shape[1])
                            & (vi + dv >= 0)
                            & (vi + dv < arr.shape[0])
                        )
                        arr[vi[ok] + dv, ui[ok] + du] = cols[ok]
                panel.img = Image.fromarray(arr)
                panel.draw = ImageDraw.Draw(panel.img, "RGBA")
            else:
                panel.draw.text(
                    (panel.L + 10, panel.T + 10), "（没有这个模型）", font=wc.font(14), fill=(220, 220, 220)
                )
            cells.append(panel.finish())
        # 俯视在左，正面、侧面上下叠在右边
        top, front, side = cells
        bw = top.size[0] + 10 + max(front.size[0], side.size[0])
        bh = max(top.size[1], front.size[1] + 10 + side.size[1])
        block = Image.new("RGB", (bw, bh), (18, 19, 22))
        block.paste(top, (0, 0))
        block.paste(front, (top.size[0] + 10, 0))
        block.paste(side, (top.size[0] + 10, front.size[1] + 10))
        rows.append([block])
    W = sum(c.size[0] for c in rows[0]) + 10 * (len(rows[0]) - 1)
    H = sum(max(c.size[1] for c in row) for row in rows) + 10 * (len(rows) - 1) + 60
    img = Image.new("RGB", (W, H), (18, 19, 22))
    d = ImageDraw.Draw(img)
    d.text((10, 8), title, font=wc.font(16), fill=(255, 255, 255))
    x = 10
    for hi_, col in DIST_BINS:
        lab = {0.01: "≤1 厘米", 0.03: "1–3 厘米", 0.06: "3–6 厘米"}.get(hi_, ">6 厘米")
        d.rectangle([x, 36, x + 14, 50], fill=col)
        d.text((x + 20, 43), lab, font=wc.font(13), fill=(230, 233, 238), anchor="lm")
        x += 110
    d.text(
        (x + 10, 43),
        "点 = 范围内的扫描表面采样；颜色 = 到该模型表面的距离",
        font=wc.font(13),
        fill=(200, 205, 214),
        anchor="lm",
    )
    y = 60
    for row in rows:
        x = 0
        for c in row:
            img.paste(c, (x, y))
            x += c.size[0] + 10
        y += max(c.size[1] for c in row) + 10
    wc.save_jpeg(img, path, 600_000)


def parse_angles(text: str, front: float) -> list[tuple[str, str, float, float, bool]]:
    out = []
    toks = [p.strip() for p in text.split(",")]
    parts = toks if all(t in VIEWS for t in toks) else [p.strip() for p in text.split(";") if p.strip()]
    for i, part in enumerate(parts):
        if len(part.split(",")) == 1 and part in VIEWS:
            title, daz, el, ortho = VIEWS[part]
            out.append((part, title, front + daz if part != "top" else front, el, ortho))
        else:
            v = part.split(",")
            ortho = len(v) > 2 and v[2].strip().lower().startswith("o")
            out.append(
                (
                    f"cam{i + 1}",
                    f"方位 {float(v[0]):g}° 仰角 {float(v[1]):g}°",
                    float(v[0]),
                    float(v[1]),
                    ortho,
                )
            )
    if len(out) != 3:
        raise SystemExit("--angles 需要正好 3 个角度")
    return out


# ---------------------------------------------------------------------------- 命令


def cmd_compare(args) -> None:
    t0 = time.time()
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    bodies, tpls, notes = wc.load_records(args.model)
    if not bodies:
        raise SystemExit("记录文件里没有物件（只有模板？）")
    objs = wc.load_objects(args.objects)
    base_tpls = {k: b["shape"] for k, b in objs.items() if b.get("kind") == "template" and "shape" in b}
    all_tpls = {**base_tpls, **tpls}
    base_id = args.base_id or args.object or next((k for k in bodies if k in objs), None)
    base_body = objs.get(base_id) if base_id else None
    if not args.box and not args.object and base_body is not None:
        args.object = base_id
    if not args.box and not args.object:
        try:
            bs = [shape_bounds(b["shape"], all_tpls) for b in bodies.values()]
            args.box = ",".join(
                str(v)
                for v in list(np.min([b["min"] for b in bs], 0)) + list(np.max([b["max"] for b in bs], 0))
            )
        except Exception as e:
            raise SystemExit(f"需要 --box 或 --object（模型的包围盒也算不出来：{e}）") from e
    box, _ = wc.resolve_box(args)
    wc.log(f"compare：模型 {args.model}（{len(bodies)} 个物件，{len(tpls)} 个模板）；现有算法 {base_id or '无'}；"
           f"包围盒 {r(box.lo, 3)} – {r(box.hi, 3)}")  # fmt: skip
    for n in notes:
        wc.log("  " + n)

    # (c) 形状校验
    checks = [check_body(eid, b, all_tpls) for eid, b in bodies.items()]

    # 网格
    new_parts, new_labels = [], []
    for eid, b in bodies.items():
        if b.get("shape") is None:
            continue
        try:
            ps = build_parts(b["shape"], all_tpls)
        except Exception as e:  # 形状写错时网格生成也可能失败
            next(c for c in checks if c["entityId"] == eid)["errors"].append(f"网格生成失败：{e}")
            continue
        new_parts += ps
        new_labels += [eid] * len(ps)
    base_parts = build_parts(base_body["shape"], base_tpls) if base_body and base_body.get("shape") else []
    textures = wc.load_textures(
        os.path.join(wc.BASE, "textures"), os.path.join(wc.BASE, "structure_textures")
    )
    tpl_bodies = {k: {"kind": "template", "shape": s} for k, s in all_tpls.items()}
    new_glb = os.path.join(args.out, "_new.glb")
    base_glb = os.path.join(args.out, "_base.glb")
    new_mesh_tris = 0
    if new_parts:
        st = export_glb(
            {**tpl_bodies, **{k: b for k, b in bodies.items() if b.get("shape") is not None}},
            textures,
            new_glb,
        )
        new_mesh_tris = st["triangles"]
    if base_body:
        export_glb({**{k: {"kind": "template", "shape": s} for k, s in base_tpls.items()}, base_id: base_body}, textures,
                   base_glb)  # fmt: skip

    # (a) 并排渲染
    clip, floor_y, scan_glb, near, grid, floor_range = prepare_scan(args, box, args.margin, args.out)
    angles = parse_angles(args.angles, args.front)
    cw, ch = (int(v) for v in args.cell.lower().split("x"))
    cols = [("scan", "扫描（只看包围盒附近）"), ("base", f"现有算法 {base_id or '（无）'}"),
            ("new", f"新模型 {os.path.basename(args.model)}")]  # fmt: skip
    models = {"scan": scan_glb}
    if base_body:
        models["base"] = base_glb
    if new_parts:
        models["new"] = new_glb
    specs, slots = [], []
    for ai, (name, title, az, el, ortho) in enumerate(angles):
        for ci, (col, _) in enumerate(cols):
            png = os.path.join(args.out, f"_cell_{ai}_{ci}.png")
            ov = {"header": False, "rulers": ortho, "grid2d": ortho, "dims": False, "gizmo": ci == 0,
                  "tag": f"{title}" if ci == 0 else None}  # fmt: skip
            sp = view_spec(name=name, title=title, az=az, el=el, ortho=ortho, box=box, clip=clip, floor_y=floor_y,
                           cut=args.cut, near_clip=True, size=[cw, ch], show=[col] if col in models else [],
                           clip_models=["scan"], overlay=ov, out=png, grid=grid)  # fmt: skip
            specs.append(sp)
            slots.append((ai, ci, png))
    wc.run_render(models, specs, args.out)
    head, foot = 34, 0
    sheet = Image.new("RGB", (cw * 3 + 8, head + ch * 3 + 8), (18, 19, 22))
    d = ImageDraw.Draw(sheet)
    for ci, (_, label) in enumerate(cols):
        d.text((ci * (cw + 4) + cw / 2, head / 2), label, font=wc.font(17), fill=(255, 255, 255), anchor="mm")
    for ai, ci, png in slots:
        im = Image.open(png)
        if cols[ci][0] not in models:
            dd = ImageDraw.Draw(im)
            dd.text((cw / 2, ch / 2), "（没有）", font=wc.font(20), fill=(200, 200, 200), anchor="mm")
        sheet.paste(im, (ci * (cw + 4), head + ai * (ch + 4)))
        os.remove(png)

    # (b) 偏差
    t = time.time()
    fit_box = box.grow(args.fit_margin)
    part = wc.crop_scan(near, fit_box.grow(0.1))
    P, _, _, _ = wc.sample_points(part, args.density, seed=3)
    P = P[fit_box.contains(P) & (P[:, 1] >= wc.floor_at(args._heightmap, P) + args.floor_gap)]
    R, _, _, _ = wc.sample_points(part, 20000, seed=4)
    ref_tree = cKDTree(R[fit_box.grow(0.1).contains(R)])
    shapes_new = {k: b.get("shape") for k, b in bodies.items()}
    res_new = (evaluate(new_parts, new_labels, P, ref_tree, floor_y, args.floor_gap, shapes_new, all_tpls)
               if new_parts else None)  # fmt: skip
    res_base = (evaluate(base_parts, [base_id] * len(base_parts), P, ref_tree, floor_y, args.floor_gap,
                         {base_id: base_body["shape"]}, base_tpls) if base_parts else None)  # fmt: skip
    if res_base is not None and base_body.get("fit"):
        res_base["recordedFit"] = base_body["fit"]
    wc.log(f"  偏差：{len(P)} 个扫描点（{args.density:g} 点/平方米，包围盒外扩 {args.fit_margin}，去掉离局部地面 {args.floor_gap} 米以内的），"
           f"{time.time() - t:.1f} 秒")  # fmt: skip

    # 并排图底部写数字
    lines = []
    for name, res in (("现有算法", res_base), ("新模型", res_new)):
        if res is None:
            lines.append(f"{name}：无")
            continue
        a, b = res["scanToModel"], res["modelToScan"]
        lines.append(f"{name}：扫描→模型 均值 {a['meanCm']} 厘米，P90 {a['p90Cm']}，3 厘米内 {a['coverage3cm']:.1%}"
                     f"  |  模型→扫描 均值 {b['meanCm']}，P90 {b['p90Cm']}，3 厘米内 {b['coverage3cm']:.1%}")  # fmt: skip
    foot = 26 * len(lines) + 12
    full = Image.new("RGB", (sheet.size[0], sheet.size[1] + foot), (18, 19, 22))
    full.paste(sheet, (0, 0))
    dd = ImageDraw.Draw(full)
    for i, line in enumerate(lines):
        dd.text(
            (12, sheet.size[1] + 6 + 26 * i),
            line,
            font=wc.font(16),
            fill=(255, 230, 140) if "新模型" in line else (220, 224, 230),
        )
    cmp_path = os.path.join(args.out, "compare.jpg")
    nbytes, _ = wc.save_jpeg(full, cmp_path, 700_000)

    err_path = os.path.join(args.out, "compare_error.jpg")
    error_map(P, [(f"现有算法 {base_id or ''}", res_base["_d"] if res_base else None),
                  ("新模型", res_new["_d"] if res_new else None)], fit_box, err_path,
              f"扫描点到模型的距离（{base_id or ''}，{len(P)} 点）")  # fmt: skip
    missing = missing_clusters(P, res_new["_d"]) if res_new else []
    for res in (res_new, res_base):
        if res:
            res.pop("_d")

    out = {"model": os.path.abspath(args.model), "entityIds": list(bodies), "baseId": base_id, "box": box.as_dict(),
           "floorY": r(floor_y), "fitRegion": fit_box.as_dict(), "scanPoints": len(P),
           "images": {"compare": cmp_path, "error": err_path}, "angles": [a[:4] for a in angles],
           "validation": checks, "triangles": {"new": new_mesh_tris},
           "new": res_new, "base": res_base, "missingFromNew": missing,
           "notes": {"scanToModel": "范围内扫描点到模型表面的距离：均值低、3 厘米内比例高 = 扫描到的东西模型都有",
                     "modelToScan": "模型表面采样点到扫描的距离：数值大 = 模型有扫描里没有的部分（多建、放错；贴墙、贴地、"
                                    "被挡住的背面没被扫到也会偏大）",
                     "missingFromNew": "离新模型超过 5 厘米的扫描点连成的块（漏建或位置不对的地方）"}}  # fmt: skip
    with open(os.path.join(args.out, "compare.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    os.remove(scan_glb)

    p = print
    p("\n== 形状校验")
    for c in checks:
        p(
            f"  {c['entityId']}：{'通过' if c.get('ok') else '不通过'}  节点 {c.get('nodes')}  包围盒 {c.get('computedBounds')}"
        )
        for e in c["errors"]:
            p(f"    错误：{e}")
        for w in c["warnings"]:
            p(f"    提示：{w}")
    p(f"\n== 偏差（{len(P)} 个扫描点；单位厘米）")
    p("               扫描→模型: 均值   P90   3cm内  1cm内  |  模型→扫描: 均值   P90   3cm内")
    for name, res in (("现有算法", res_base), ("新模型  ", res_new)):
        if res:
            a, b = res["scanToModel"], res["modelToScan"]
            p(f"  {name}            {a['meanCm']:6.2f} {a['p90Cm']:6.2f} {a['coverage3cm']:6.1%} {a['within1cm']:6.1%}  |"
              f"            {b['meanCm']:6.2f} {b['p90Cm']:6.2f} {b['coverage3cm']:6.1%}")  # fmt: skip
    if res_base and res_base.get("recordedFit"):
        p(f"  （objects.json 里现有算法自己记录的 fit：{res_base['recordedFit']}，是在它分割出的物体点上算的，"
          f"口径不同，只作参考）")  # fmt: skip
    if res_new:
        p("\n== 新模型分部件（扫描点数 = 离这个部件最近的扫描点；部件→扫描 越小越贴合）")
        for q in res_new["parts"]:
            pt = q["partToScan"]
            p(f"  {q['path']:<30} {q['type']!s:<8} 颜色 {q['material']!s:<16} 扫描点 {q['scanPoints']:6d} 均距 {q['scanToPartMeanCm']}  "
              f"| 部件→扫描 均值 {pt['meanCm']} P90 {pt['p90Cm']} 3cm内 {pt['coverage3cm']}")  # fmt: skip
    if missing:
        p("\n== 新模型漏掉的扫描块（离模型 >5 厘米）")
        for m in missing:
            p(f"  {m['points']} 点  范围 {m['min']} – {m['max']}  平均距离 {m['meanDistCm']} 厘米")
    p(
        f"\n图：{cmp_path}（{nbytes // 1024} KB）\n    {err_path}\n数字：{os.path.join(args.out, 'compare.json')}"
    )
    wc.log(f"完成，共 {time.time() - t0:.1f} 秒")
