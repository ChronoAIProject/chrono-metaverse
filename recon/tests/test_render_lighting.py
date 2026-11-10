"""重建工作台渲染页和对比图查看页的灯光与网站 `web/src/viewer/lighting.ts` 一致（物理单位，强度 = 系数 × π）。

两处是手抄的同一组数：网站改了灯光、这里没跟上，工作台里看到的纯色件明暗就和网站不一样（评审时发现纯色件
在工作台里偏暗约四成，就是旧写法的 1.6 只相当于现在的系数 0.5）。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
LIGHTING_TS = ROOT / "web" / "src" / "viewer" / "lighting.ts"
PAGES = [
    ROOT / "recon" / "src" / "metaverse_recon" / "bench" / "render" / "index.html",
    ROOT / "recon" / "scripts" / "viewer" / "index.html",
]
NUMBER = r"(-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?))"


def _num(text: str) -> float:
    return float(int(text, 16)) if text.lower().startswith("0x") else float(text)


def _fields(block: str) -> dict[str, object]:
    out: dict[str, object] = {}
    for key, value in re.findall(rf"(\w+):\s*{NUMBER}", block):
        out[key] = _num(value)
    direction = re.search(r"direction:\s*\[([^\]]+)\]", block)
    if direction:
        out["direction"] = [float(v) for v in direction.group(1).split(",")]
    return out


def web_lights() -> dict[str, dict[str, object]]:
    text = LIGHTING_TS.read_text(encoding="utf-8")
    out = {}
    for name, const in (("hemisphere", "HEMISPHERE_LIGHT"), ("key", "KEY_LIGHT"), ("fill", "FILL_LIGHT")):
        block = re.search(rf"export const {const}\b[^=]*=\s*\{{(.*?)\}}", text, re.S)
        assert block, f"lighting.ts 里找不到 {const}"
        out[name] = _fields(block.group(1))
    for const in ("TEXTURE_DIFFUSE", "TEXTURE_EMISSIVE"):
        value = re.search(rf"export const {const}\s*=\s*{NUMBER}", text)
        assert value, f"lighting.ts 里找不到 {const}"
        out[const] = {"value": _num(value.group(1))}
    return out


def page_lights(path: Path) -> dict[str, dict[str, object]]:
    text = path.read_text(encoding="utf-8")
    block = re.search(r"const LIGHTS = \{(.*?)\n\};", text, re.S)
    assert block, f"{path.name} 里找不到 const LIGHTS"
    out = {}
    for name in ("hemisphere", "key", "fill"):
        item = re.search(rf"{name}:\s*\{{(.*?)\}}", block.group(1), re.S)
        assert item, f"{path.name} 的 LIGHTS 里没有 {name}"
        out[name] = _fields(item.group(1))
    for const in ("TEXTURE_DIFFUSE", "TEXTURE_EMISSIVE"):
        value = re.search(rf"const {const}\s*=\s*{NUMBER}", text)
        if value:
            out[const] = {"value": _num(value.group(1))}
    # 强度必须按 π 乘：漏了就回到旧写法的暗
    assert "factor * Math.PI" in text, f"{path.name} 的灯光强度没有乘 π"
    return out


@pytest.mark.skipif(not LIGHTING_TS.exists(), reason="没有网站源码（只拿到了处理服务）")
@pytest.mark.parametrize("page", PAGES, ids=lambda p: p.parent.name)
def test_page_lights_match_the_website(page):
    web = web_lights()
    mine = page_lights(page)
    for name in ("hemisphere", "key", "fill"):
        assert mine[name] == web[name], (page.name, name)
    for const in ("TEXTURE_DIFFUSE", "TEXTURE_EMISSIVE"):
        if const in mine:
            assert mine[const] == web[const], (page.name, const)
    if page == PAGES[0]:  # 工作台渲染页给模型库模型的贴图也用网站的明暗
        assert {"TEXTURE_DIFFUSE", "TEXTURE_EMISSIVE"} <= set(mine)
