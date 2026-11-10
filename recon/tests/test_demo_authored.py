"""演示空间的前厅 AI 物件集（`infra/chrono-cd/demo/lobby-authored.json`）随代码一起保持可用。

部署种子导入时处理服务按 `parse_authored` 校验它，校验规则改了而物件集没跟上，线上导入就会失败；
`demo/README.md` 的署名列表必须列全物件集里每个外部模型的标题、作者、来源页和许可（CC-BY 要署名）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaverse_recon.authored import parse_authored
from metaverse_recon.processing.authored_build import _texture_nodes

DEMO = Path(__file__).resolve().parents[2] / "infra" / "chrono-cd" / "demo"
AUTHORED = DEMO / "lobby-authored.json"

pytestmark = pytest.mark.skipif(not AUTHORED.exists(), reason="没有部署目录（只拿到了处理服务）")


def load() -> dict:
    return json.loads(AUTHORED.read_text(encoding="utf-8"))


def test_lobby_authored_set_passes_the_worker_checks():
    parsed = parse_authored(load())
    assert parsed["structure"] == "replace"
    # 线上第 4 版（精致模型版）：没有模板，外部模型物件 24 件
    assert len(parsed["templates"]) == 0 and len(parsed["entities"]) == 52 and len(parsed["models"]) == 24
    assert parsed["notes"] and parsed["notes"].startswith("# ")
    # 结构贴图只在结构物件上（回退按同编号、同部件路径找本次算法结构的贴图）
    for eid, body in parsed["entities"].items():
        paths = [path for path, _ in _texture_nodes(body["shape"])] if "shape" in body else []
        if body["kind"] != "structure":
            assert not paths, eid
        elif eid == "floor":
            assert paths == ["$"]
    assert len(parsed["textures"]) == 5


def test_readme_lists_every_model_attribution():
    readme = (DEMO / "README.md").read_text(encoding="utf-8")
    sources = {e["props"]["source"]["id"]: e["props"]["source"] for e in load()["entities"] if "model" in e}
    assert len(sources) == 14
    for source in sources.values():
        assert source["license"].startswith("CC-BY")
        row = next((line for line in readme.splitlines() if f"<{source['page']}>" in line), None)
        assert row is not None, source["title"]
        for key in ("title", "author", "license"):
            assert source[key] in row, (source["title"], key)


def test_labels_are_visitor_names():
    """标签会成为公开锚点的名称和"模型来源"面板的"用于"：建模说明（用了哪个库模型、怎么调色）只写进 notes。"""
    for entity in load()["entities"]:
        label = entity["label"]
        assert "库：" not in label and "tint" not in label, (entity["entityId"], label)
