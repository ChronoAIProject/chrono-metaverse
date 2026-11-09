"""重建工作台 assemble：合并成 AI 物件集（模板去重、编号唯一、引用的模板存在、逐个校验、重算包围盒）
和整房检查。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaverse_worker.recon import assemble as asm
from metaverse_worker.recon.cli import build_parser
from recon_support import chair_mesh_raw, chair_scene, make_base, object_body, write_candidate

CHAIR_TPL = {
    "type": "group",
    "children": [
        {"type": "box", "size": [0.5, 0.08, 0.5], "transform": {"position": [0, 0.45, 0]}},
        {"type": "box", "size": [0.5, 0.45, 0.06], "transform": {"position": [0, 0.53, -0.22]}},
    ],
}


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False))
    return str(path)


@pytest.fixture
def base(tmp_path):
    return make_base(
        tmp_path,
        chair_scene(30.0, (2.0, 0.0, 3.0)),
        {"chair-01": object_body("chair-01", [1.6, 0.0, 2.6], [2.4, 0.98, 3.4])},
    )


def chair_file(tmp_path, name="a/entity.json", eid="chair-01", tpl=CHAIR_TPL, bounds=None):
    body = {
        "entityId": eid,
        "layer": "rebuilt",
        "kind": "object",
        "label": "椅子",
        "shape": {
            "type": "instance",
            "template": "tpl-chair",
            "transform": {"position": [2, 0, 3], "yaw": 30},
        },
        "props": {"category": "chair"},
    }
    if bounds:
        body["bounds"] = bounds
    return write(tmp_path / name, {"templates": {"tpl-chair": tpl}, "entities": [body]})


def placed_file(tmp_path):
    """place 输出的那种外部模型物件（模型文件在 --models-dir 里找）。"""
    V, F = chair_mesh_raw(scale=100.0, up="+z")
    side = json.loads(write_candidate(tmp_path / "models", V, F).read_text())
    body = {
        "entityId": "chair-02",
        "layer": "rebuilt",
        "kind": "object",
        "model": side["model"],
        "transform": {"position": [2, 0, 3], "yaw": 30, "pitch": -90, "scale": [0.01, 0.01, 0.01]},
        "bounds": {"min": [0, 0, 0], "max": [1, 1, 1]},  # 故意写错：assemble 按模型重算
        "props": {
            "category": "chair",
            "source": {k: side[k] for k in ("library", "id", "page", "author", "license", "title")},
        },
    }
    return write(tmp_path / "b" / "entity.json", body)


def run(tmp_path, base, *files, extra=()):
    args = build_parser().parse_args(
        [
            "assemble",
            "--base",
            str(base),
            "--entities",
            *files,
            "--out",
            str(tmp_path / "out"),
            "--no-render",
            "--models-dir",
            str(tmp_path / "models"),
            *extra,
        ]
    )
    return asm.cmd_assemble(args)


def test_assemble_merges_validates_and_reports(tmp_path, base):
    notes = tmp_path / "notes.md"
    notes.write_text("先搜库：椅子用 objaverse 的同款；")
    a = chair_file(tmp_path)
    same = chair_file(tmp_path, "c/entity.json", eid="chair-03")  # 同一个模板再出现一次：内容相同，去重
    rep = run(tmp_path, base, a, same, placed_file(tmp_path), extra=["--notes", str(notes)])
    assert rep["ok"]
    authored = json.loads((tmp_path / "out" / "authored.json").read_text())
    assert (
        authored["version"] == 1
        and authored["structure"] == "keep"
        and authored["notes"].startswith("先搜库")
    )
    assert [t["entityId"] for t in authored["templates"]] == ["tpl-chair"]
    assert authored["templates"][0]["kind"] == "template" and authored["templates"][0]["bounds"]
    ents = {e["entityId"]: e for e in authored["entities"]}
    assert set(ents) == {"chair-01", "chair-02", "chair-03"}
    assert ents["chair-01"]["bounds"]["max"][1] == pytest.approx(0.98, abs=1e-3)  # 按模板算出的包围盒
    assert ents["chair-02"]["bounds"]["max"][1] == pytest.approx(0.98, abs=1e-3)  # 按模型重算
    room = rep["room"]
    per = {e["entityId"]: e for e in room["entities"]}
    assert per["chair-02"]["kind"] == "model" and per["chair-02"]["source"].startswith("objaverse:")
    assert per["chair-02"]["scanToModel"]["meanCm"] < 1.0
    # 写回口径的 fit（处理服务写进记录的同一个函数）：摆对了的椅子很小
    assert per["chair-02"]["fit"]["meanCm"] < 1.0 and per["chair-02"]["fitPoints"] > 100
    assert (tmp_path / "out" / "room.glb").stat().st_size > 1000


@pytest.mark.parametrize(
    ("case", "message"),
    [
        ("dup", "重复"),
        ("tpl-conflict", "内容不同"),
        ("missing-tpl", "引用的模板不存在"),
        ("bad-plate", "厚度"),
        ("structure-keep", "structure = keep"),
        ("bad-license", "许可"),
        ("bad-host", "主机"),
        ("no-local", "本机找不到"),
        ("notes", "64KB"),
        ("layer", "layer = rebuilt"),
    ],
)
def test_assemble_errors(tmp_path, base, case, message, capsys):
    files = [chair_file(tmp_path)]
    extra: list[str] = []
    if case == "dup":
        files.append(
            write(tmp_path / "d.json", {"entityId": "chair-01", "shape": {"type": "box", "size": [1, 1, 1]}})
        )
    elif case == "tpl-conflict":
        other = {"type": "box", "size": [0.4, 0.9, 0.4]}
        files.append(chair_file(tmp_path, "e/entity.json", eid="chair-09", tpl=other))
    elif case == "missing-tpl":
        files = [
            write(tmp_path / "m.json", {"entityId": "x", "shape": {"type": "instance", "template": "nope"}})
        ]
    elif case == "bad-plate":
        files.append(
            write(
                tmp_path / "p.json",
                {
                    "entityId": "p",
                    "shape": {"type": "plate", "thickness": 0, "points": [[0, 0, 0], [1, 0, 0], [1, 0, 1]]},
                },
            )
        )
    elif case == "structure-keep":
        files.append(
            write(
                tmp_path / "s.json",
                {"entityId": "w", "kind": "structure", "shape": {"type": "box", "size": [1, 2, 0.1]}},
            )
        )
    elif case in ("bad-license", "bad-host", "no-local"):
        body = json.loads(Path(placed_file(tmp_path)).read_text())
        if case == "bad-license":
            body["props"]["source"]["license"] = "CC-BY-SA-4.0"
        elif case == "bad-host":
            body["model"]["url"] = "https://example.com/x.glb"
        else:
            body["model"]["sha256"] = "f" * 64
        files.append(write(tmp_path / "x.json", body))
    elif case == "notes":
        notes = tmp_path / "n.md"
        notes.write_text("长" * 30000)
        extra = ["--notes", str(notes)]
    elif case == "layer":
        files.append(
            write(
                tmp_path / "l.json",
                {"entityId": "l", "layer": "ext", "shape": {"type": "box", "size": [1, 1, 1]}},
            )
        )
    with pytest.raises(asm.AssembleError):
        run(tmp_path, base, *files, extra=extra)
    assert message in capsys.readouterr().out
    report = json.loads((tmp_path / "out" / "report.json").read_text())
    assert report["ok"] is False


def test_entity_files_from_directories_skip_sidecars(tmp_path):
    chair_file(tmp_path, "work/chair/entity.json")
    write(tmp_path / "work" / "sofa" / "model.json", {"library": "objaverse", "local": {}, "model": {}})
    write(tmp_path / "work" / "sofa" / "place.json", {"x": 1})
    files = list(asm.entity_files([str(tmp_path / "work")]))
    assert [f.split("work/")[1] for f in files] == ["chair/entity.json", "sofa/model.json"]
    _, entities, errors, notes = asm.merge([str(tmp_path / "work")])
    assert set(entities) == {"chair-01"} and "旁注" in notes[0] and not errors


def test_gltf_model_files_and_look_reach_the_writeback_format(tmp_path, base):
    """旧版旁注里 gltf 的 files 是数组：assemble 换成写回路径收的 {相对路径: {url, sha256, size}}，
    material 的 opacity / unlit 原样带上，整份通过 parse_authored。"""
    from metaverse_worker.authored import parse_authored

    V, F = chair_mesh_raw(scale=100.0, up="+z")
    side_path = write_candidate(tmp_path / "models", V, F, license="CC0-1.0")
    side = json.loads(side_path.read_text())
    side["library"], side["page"] = "polyhaven", "https://polyhaven.com/a/test_chair"
    side["model"].update(
        url="https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/x/x_1k.gltf",
        format="gltf",
        files=[
            {
                "path": "x.bin",
                "url": "https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/x/x.bin",
                "sha256": "b" * 64,
                "size": 5,
            }
        ],
    )
    side_path.write_text(json.dumps(side))
    body = json.loads(Path(placed_file(tmp_path)).read_text())
    body["model"] = side["model"]
    body["props"]["source"] = {k: side[k] for k in ("library", "id", "page", "author", "license", "title")}
    body["material"] = {"tint": [200, 190, 180], "opacity": 0.6}
    body["fit"] = {"meanCm": 1.0, "p90Cm": 2.0, "coverage3cm": 0.9}
    rep = run(tmp_path, base, write(tmp_path / "b" / "entity.json", body))
    assert rep["ok"]
    authored = json.loads((tmp_path / "out" / "authored.json").read_text())
    (chair,) = authored["entities"]
    assert chair["model"]["files"] == {
        "x.bin": {
            "url": "https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/x/x.bin",
            "sha256": "b" * 64,
            "size": 5,
        }
    }
    parsed = parse_authored(authored)
    assert parsed["entities"]["chair-02"]["material"] == {"opacity": 0.6}
    assert parsed["models"]["chair-02"]["tint"] == [200, 190, 180]


def test_assemble_rejects_what_the_writeback_would_reject(tmp_path, base):
    """CC0 也要写作者（与物件记录的署名规则相同）：assemble 当场报错，不等任务失败。"""
    body = json.loads(Path(placed_file(tmp_path)).read_text())
    body["props"]["source"]["author"] = ""
    with pytest.raises(asm.AssembleError):
        run(tmp_path, base, write(tmp_path / "b" / "entity.json", body))
    report = json.loads((tmp_path / "out" / "report.json").read_text())
    assert any("author" in e for c in report["checks"] for e in c.get("errors") or [])
