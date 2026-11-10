"""重建工作台的运行环境：渲染要用的 three 包、Playwright、Chromium、字体，以及本地缓存目录。

全部可以用环境变量指定，不指定时按常见位置找（Mac 和 Linux 都试）：

| 环境变量 | 用途 | 默认查找 |
|---|---|---|
| `METAVERSE_RECON_THREE` | three 包目录（含 `build/three.module.js`） | 仓库的 `web/node_modules/three`、
缓存目录的 `node/node_modules/three` |
| `METAVERSE_RECON_PLAYWRIGHT` | playwright 或 playwright-core 包目录 | 仓库 `web/`、`sdk/typescript/` 的
node_modules，`npm root -g` |
| `METAVERSE_RECON_CHROMIUM` | Chromium 可执行文件 | `PLAYWRIGHT_BROWSERS_PATH`、`/opt/pw-browsers`、
`~/.cache/ms-playwright`、`~/Library/Caches/ms-playwright` |
| `METAVERSE_RECON_FONT` | 中文字体文件（图上的标注） | Mac：苹方、冬青黑体、华文黑体；Linux：文泉驿、Noto
CJK |
| `METAVERSE_RECON_NODE` | node 可执行文件 | `PATH` 里的 node |
| `METAVERSE_RECON_CACHE` | 缓存目录（模型库索引、下载的模型、缩略图） | `~/.cache/metaverse-recon` |

找不到中文字体时图上的标注改用英文（`i18n.py`）。
"""

from __future__ import annotations

import functools
import glob
import os
import platform
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
RENDER_DIR = HERE / "render"


def repo_root() -> Path | None:
    """从源码位置推出平台仓库根目录（`recon/src/metaverse_recon/bench/` 往上四级）；不是从源码装的就返回
    None。"""
    root = HERE.parents[3]
    return root if (root / "recon").is_dir() and (root / "web").is_dir() else None


def cache_dir() -> Path:
    path = Path(os.environ.get("METAVERSE_RECON_CACHE") or Path.home() / ".cache" / "metaverse-recon")
    path.mkdir(parents=True, exist_ok=True)
    return path


def _first(paths) -> str | None:
    for p in paths:
        if p and os.path.exists(p):
            return str(p)
    return None


@functools.cache
def _npm_root_global() -> str | None:
    npm = shutil.which("npm")
    if not npm:
        return None
    try:
        out = subprocess.run([npm, "root", "-g"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


def find_three() -> str | None:
    env = os.environ.get("METAVERSE_RECON_THREE")
    if env:
        return env if os.path.exists(os.path.join(env, "build", "three.module.js")) else None
    root = repo_root()
    cands = []
    if root:
        cands.append(root / "web" / "node_modules" / "three")
    cands.append(cache_dir() / "node" / "node_modules" / "three")
    g = _npm_root_global()
    if g:
        cands.append(Path(g) / "three")
    return _first(c for c in cands if (Path(c) / "build" / "three.module.js").exists())


def find_playwright() -> str | None:
    env = os.environ.get("METAVERSE_RECON_PLAYWRIGHT")
    if env:
        return env if os.path.exists(env) else None
    root = repo_root()
    cands: list[Path] = []
    if root:
        for sub in ("web", "sdk/typescript"):
            for name in ("playwright", "playwright-core", "@playwright/test"):
                cands.append(root / sub / "node_modules" / name)
    cands.append(cache_dir() / "node" / "node_modules" / "playwright-core")
    g = _npm_root_global()
    if g:
        cands += [Path(g) / "playwright", Path(g) / "playwright-core"]
    cands.append(Path("/opt/node22/lib/node_modules/playwright"))
    for c in cands:
        if (c / "package.json").exists():
            # @playwright/test 本身不导出 chromium，用它依赖的 playwright
            if c.name == "test" and c.parent.name == "@playwright":
                inner = c.parent.parent / "playwright"
                if (inner / "package.json").exists():
                    return str(inner)
                continue
            return str(c)
    return None


def find_chromium() -> str | None:
    """Chromium 可执行文件；返回 None 时交给 Playwright 自己找
    （`PLAYWRIGHT_BROWSERS_PATH` 或它的默认目录）。"""
    env = os.environ.get("METAVERSE_RECON_CHROMIUM")
    if env:
        return env if os.path.exists(env) else None
    roots = [
        os.environ.get("PLAYWRIGHT_BROWSERS_PATH"),
        "/opt/pw-browsers",
        str(Path.home() / ".cache" / "ms-playwright"),
        str(Path.home() / "Library" / "Caches" / "ms-playwright"),
    ]
    patterns = [
        "chromium-*/chrome-linux*/chrome",
        "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
        "chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chromium_headless_shell-*/chrome-*/headless_shell",
        "chromium_headless_shell-*/chrome-*/chrome-headless-shell",
    ]
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        for pat in patterns:
            hits = sorted(glob.glob(os.path.join(root, pat)), reverse=True)
            if hits:
                return hits[0]
    if platform.system() == "Darwin":
        return _first(
            [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
            ]
        )
    return _first([shutil.which("chromium"), shutil.which("chromium-browser"), shutil.which("google-chrome")])


FONT_CANDIDATES = [
    # Mac
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    # Linux
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/wenquanyi/wqy-zenhei/wqy-zenhei.ttc",
]


@functools.cache
def find_font() -> str | None:
    env = os.environ.get("METAVERSE_RECON_FONT")
    if env is not None:
        return env if env and os.path.exists(env) else None
    return _first(FONT_CANDIDATES)


def find_node() -> str | None:
    env = os.environ.get("METAVERSE_RECON_NODE")
    if env:
        return env if os.path.exists(env) else None
    return shutil.which("node")


@dataclass(frozen=True)
class RenderTools:
    node: str
    three: str
    playwright: str
    chromium: str | None
    font: str | None


def render_tools() -> tuple[RenderTools | None, str]:
    """渲染要用的工具；缺了哪样就返回 (None, 原因和安装提示)。"""
    node = find_node()
    three = find_three()
    pw = find_playwright()
    missing = []
    if not node:
        missing.append("node（装 Node.js 22 以上，或用 METAVERSE_RECON_NODE 指定）")
    if not three:
        missing.append(
            "three 包（在平台仓库的 web/ 下 npm ci，或 npm install --prefix "
            f"{cache_dir() / 'node'} three@0.184.0，或用 METAVERSE_RECON_THREE 指定）"
        )
    if not pw:
        missing.append(
            "Playwright（npm install --prefix "
            f"{cache_dir() / 'node'} playwright-core，或用 METAVERSE_RECON_PLAYWRIGHT 指定）"
        )
    if missing:
        return None, "渲染需要：" + "；".join(missing)
    return RenderTools(node, three, pw, find_chromium(), find_font()), ""


def describe() -> dict:
    """`metaverse-recon doctor` 的输出。"""
    tools, why = render_tools()
    return {
        "platform": platform.system(),
        "node": find_node(),
        "three": find_three(),
        "playwright": find_playwright(),
        "chromium": find_chromium() or "（交给 Playwright 自己找）",
        "font": find_font() or "（没有中文字体，图上用英文标注）",
        "cache": str(cache_dir()),
        "render": "可用" if tools else why,
    }
