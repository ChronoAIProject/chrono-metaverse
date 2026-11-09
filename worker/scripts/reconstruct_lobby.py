"""前厅验收：扫描 → 对齐 → 结构 → 物体重建 → 物件 JSON、贴图、查看用 glb、指标报告（不进测试）。

用法（在 worker/ 下）：

    .venv/bin/python scripts/reconstruct_lobby.py --scan <mesh.drc> --texture <tex.jpg> \\
        --out <输出目录> [--hints scripts/lobby_hints.json] [--render --three <three 包目录>]

输出：
- `objects.json`：物件记录 body（entityId → body，含模板）；`structure.json`：结构物件；
- `textures/<哈希>.jpg`：物件贴图；`structure_textures/`：结构贴图；
- `lobby.glb`（结构 + 物体）、`objects.glb`（只有物体）、`scan.glb`（对齐后的原始扫描，渲染对比用）；
- `metrics.json`：物体模块的指标 + 各部分大小 + "家具区"偏差（第 3 轮同样的口径：家具包围盒 +5 厘米内、
  离地 2 厘米以上的扫描表面到整个模型的距离）。
- `--render`：用 Playwright + Chromium 打开 `scripts/viewer/index.html` 渲染扫描与重建的同角度对比图，
  拼成 `compare_*.jpg`（剖切掉天花板）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image

from metaverse_worker.processing import structure as st
from metaverse_worker.processing.fit_texture import SurfaceIndex, fit_stats
from metaverse_worker.processing.objects import FURNITURE, reconstruct_objects
from metaverse_worker.processing.preview_glb import export_glb
from metaverse_worker.processing.scan import compute_alignment, load_scan, sample_surface
from metaverse_worker.processing.shape_mesh import build_parts, merge_meshes
from metaverse_worker.records import entity_body

HERE = os.path.dirname(os.path.abspath(__file__))

VIEWS = [
    ("overview", "cut=2.3&cx=5.84&cy=0.6&cz=8.7&az=220&el=42&r=17"),
    ("top", "view=top"),
    ("counter", "cut=2.3&cx=7.0&cy=0.6&cz=5.9&az=272&el=28&r=4.6"),
    ("table", "cut=2.3&cx=4.7&cy=0.5&cz=11.4&az=200&el=36&r=4.8"),
    ("sofa", "cut=2.3&cx=4.2&cy=0.5&cz=14.4&az=190&el=28&r=5.2"),
    ("chairs", "cut=2.3&cx=4.4&cy=0.45&cz=11.3&az=330&el=30&r=3.2"),
]


def structure_entities(result) -> tuple[dict[str, dict], dict[str, bytes]]:
    entities: dict[str, dict] = {}
    textures: dict[str, bytes] = {}
    for e in result.elements:
        h = None
        if e.texture is not None:  # 玻璃是纯色的，没有贴图
            data = st.encode_texture(e.texture)
            h = hashlib.sha256(data).hexdigest()
            textures[h] = data
        shape = st.element_shape(e, h)
        entities[e.id] = entity_body(
            entity_id=e.id,
            kind="structure",
            shape=shape,
            label=st.LABELS[e.kind],
            textures=[h] if h else None,
            props=st.element_props(e),
        )
    return entities, textures


def scan_glb(mesh, path: str, max_tex: int = 4096) -> None:
    """对齐后的扫描写成 glb（贴图缩到 4096），渲染对比用。"""
    from metaverse_worker.processing.preview_glb import _Writer

    tex = Image.fromarray(mesh.texture)
    if max(tex.size) > max_tex:
        tex = tex.resize((max_tex, max_tex), Image.LANCZOS)
    import io

    buf = io.BytesIO()
    tex.save(buf, format="JPEG", quality=85)
    w = _Writer({"scan": buf.getvalue()}, True)
    pos = mesh.vertices.astype(np.float32)
    uv = mesh.uv.astype(np.float32)
    idx = mesh.faces.astype(np.uint32).reshape(-1)
    prim = {
        "attributes": {
            "POSITION": w.accessor(pos, 5126, "VEC3", 34962, True),
            "TEXCOORD_0": w.accessor(uv, 5126, "VEC2", 34962),
        },
        "indices": w.accessor(idx, 5125, "SCALAR", 34963),
        "material": w.material({"texture": "scan", "uv": "mesh"}),
    }
    doc = {
        "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "scan", "mesh": 0}],
        "meshes": [{"primitives": [prim]}], "materials": w.materials, "accessors": w.accessors,
        "bufferViews": w.views, "buffers": [{"byteLength": w.offset}], "images": w.images,
        "textures": [{"source": 0}], "extensionsUsed": ["KHR_materials_unlit"],
    }  # fmt: skip
    import struct

    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    binary = b"".join(w.chunks)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(binary)))
        fh.write(struct.pack("<I4s", len(js), b"JSON"))
        fh.write(js)
        fh.write(struct.pack("<I4s", len(binary), b"BIN\0"))
        fh.write(binary)


def zone_metric(mesh, objects: dict[str, dict], structure: dict[str, dict]) -> dict:
    """第 3 轮的"家具区"口径：扫描表面（每平方米 300 点，y ≤ 2.4）落在家具包围盒 +5 厘米内、
    离地 2 厘米以上的，到整个模型（结构 + 物体）的精确距离。"""
    P, _, _, _ = sample_surface(mesh, 300, seed=7)
    P = P[P[:, 1] <= 2.4]
    templates = {k: b["shape"] for k, b in objects.items() if b["kind"] == "template"}
    floor_y = min(
        (b["bounds"]["max"][1] for b in structure.values() if b["props"].get("structure") == "floor"),
        default=0.0,
    )
    zone = np.zeros(len(P), bool)
    for b in objects.values():
        if b["kind"] != "object" or b["props"].get("category") not in FURNITURE:
            continue
        lo = np.array(b["bounds"]["min"]) - 0.05
        hi = np.array(b["bounds"]["max"]) + 0.05
        lo[1] = max(lo[1], floor_y + 0.02)
        zone |= np.all((lo <= P) & (hi >= P), axis=1)
    meshes = []
    for b in list(objects.values()) + list(structure.values()):
        if b["kind"] == "template":
            continue
        meshes.append(merge_meshes([p.mesh for p in build_parts(b["shape"], templates)]))
    index = SurfaceIndex.build([merge_meshes(meshes)], spacing=0.01)
    d, _, _ = index.query(P[zone], k=4)
    out = fit_stats(d)
    out["points"] = int(zone.sum())
    out["within2cm"] = round(float((d <= 0.02).mean()), 3)
    return out


def render(out: str, three: str, playwright: str) -> list[str]:
    jobs = []
    for name, qs in VIEWS:
        jobs.append([f"{name}_scan", f"m=scan.glb&{qs}"])
        jobs.append([f"{name}_rebuilt", f"m=lobby.glb&{qs}"])
    shots = os.path.join(out, "shots")
    os.makedirs(shots, exist_ok=True)
    cmd = [
        "node",
        os.path.join(HERE, "viewer", "render.js"),
        os.path.join(HERE, "viewer"),
        out,
        three,
        shots,
        json.dumps(jobs),
        playwright,
    ]
    subprocess.run(cmd, check=True, timeout=1200)
    made = []
    for name, _ in VIEWS:
        a = Image.open(os.path.join(shots, f"{name}_scan.png")).convert("RGB")
        b = Image.open(os.path.join(shots, f"{name}_rebuilt.png")).convert("RGB")
        w, h = a.size
        grid = Image.new("RGB", (w * 2, h), (40, 40, 40))
        grid.paste(a, (0, 0))
        grid.paste(b, (w, 0))
        grid = grid.resize((1600, int(1600 * h / (2 * w))), Image.LANCZOS)
        path = os.path.join(out, f"compare_{name}.jpg")
        grid.save(path, quality=80, optimize=True)
        made.append(path)
    return made


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", required=True)
    ap.add_argument("--texture", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--hints")
    ap.add_argument("--render", action="store_true")
    ap.add_argument("--three", help="three 包的目录（含 build/three.module.js 和 examples/jsm）")
    ap.add_argument("--playwright", default="/opt/node22/lib/node_modules/playwright")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    t0 = time.time()
    mesh = load_scan(args.scan, args.texture)
    al = compute_alignment(mesh.vertices, mesh.faces)
    mesh = mesh.transformed(al.matrix)
    t1 = time.time()
    structure = st.extract_structure(mesh)
    t2 = time.time()
    params = None
    if args.hints:
        with open(args.hints, encoding="utf-8") as fh:
            params = json.load(fh)
    res = reconstruct_objects(mesh, structure, params=params)
    t3 = time.time()
    s_entities, s_textures = structure_entities(structure)
    for sub, items in (("textures", res.textures), ("structure_textures", s_textures)):
        os.makedirs(os.path.join(args.out, sub), exist_ok=True)
        for h, data in items.items():
            with open(os.path.join(args.out, sub, h + ".jpg"), "wb") as fh:
                fh.write(data)
    with open(os.path.join(args.out, "objects.json"), "w", encoding="utf-8") as fh:
        json.dump(res.entities, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, "structure.json"), "w", encoding="utf-8") as fh:
        json.dump(s_entities, fh, ensure_ascii=False, indent=1)
    all_entities = {**s_entities, **res.entities}
    all_textures = {**s_textures, **res.textures}
    g1 = export_glb(all_entities, all_textures, os.path.join(args.out, "lobby.glb"))
    g2 = export_glb(res.entities, res.textures, os.path.join(args.out, "objects.glb"))
    scan_glb(mesh, os.path.join(args.out, "scan.glb"))
    zone = zone_metric(mesh, res.entities, s_entities)
    obj_json = sum(
        len(json.dumps(b, ensure_ascii=False, separators=(",", ":")).encode()) for b in res.entities.values()
    )
    st_json = sum(
        len(json.dumps(b, ensure_ascii=False, separators=(",", ":")).encode()) for b in s_entities.values()
    )
    metrics = {
        "objects": res.metrics,
        "furnitureZone": zone,
        "sizes": {
            "objectsJsonBytes": obj_json,
            "objectTexturesBytes": sum(len(v) for v in res.textures.values()),
            "objectsTotalBytes": obj_json + sum(len(v) for v in res.textures.values()),
            "structureJsonBytes": st_json,
            "structureTexturesBytes": sum(len(v) for v in s_textures.values()),
            "allTotalBytes": obj_json + st_json + sum(len(v) for v in all_textures.values()),
            "lobbyGlb": g1,
            "objectsGlb": g2,
        },
        "seconds": {
            "load_align": round(t1 - t0, 1),
            "structure": round(t2 - t1, 1),
            "objects": round(t3 - t2, 1),
        },
        "hints": bool(args.hints),
    }
    with open(os.path.join(args.out, "metrics.json"), "w", encoding="utf-8") as fh:
        json.dump(metrics, fh, ensure_ascii=False, indent=1)
    print(json.dumps(metrics, ensure_ascii=False, indent=1))
    if args.render:
        if not args.three:
            sys.exit("--render 需要 --three")
        for p in render(args.out, args.three, args.playwright):
            print("渲染", p)


if __name__ == "__main__":
    main()
