"""渲染调度：把模型和视图写成任务文件，交给 `render/render.js`（node + Playwright + Chromium + three.js）。

每次起一个只读的本地服务，一个页面加载一次模型、依次渲染全部视图（SwiftShader 软件渲染，不需要显卡）。
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time

from .core import ReconError, log
from .env import RENDER_DIR, render_tools
from .i18n import chinese


def available() -> bool:
    tools, _ = render_tools()
    return tools is not None


def page_strings() -> dict[str, str]:
    if chinese():
        return {}
    return {"toward": "toward you", "away": "away", "pxmm": "1 px = {v} mm", "width": "W", "height": "H"}


def run_render(
    models: dict[str, str | dict], views: list[dict], workdir: str, timeout: int = 600
) -> list[dict]:
    """models：名字 → glb 路径，或 `{path, matrix?, tint?, group?, lit?}`；
    views：每张图的参数（含 `out`）。"""
    tools, why = render_tools()
    if tools is None:
        raise ReconError(why)
    job = {
        "three": tools.three,
        "playwright": tools.playwright,
        "chromium": tools.chromium,
        "font": tools.font if chinese() else None,
        "strings": page_strings(),
        "models": models,
        "views": views,
    }
    fd, job_path = tempfile.mkstemp(prefix="render_", suffix=".json", dir=workdir)
    with os.fdopen(fd, "w") as fh:
        json.dump(job, fh)
    start = time.time()
    try:
        proc = subprocess.run(
            [tools.node, str(RENDER_DIR / "render.js"), job_path],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if proc.returncode != 0:
            raise ReconError(f"渲染失败：\n{proc.stdout}\n{proc.stderr}")
        with open(job_path + ".out.json") as fh:
            infos = json.load(fh)
    finally:
        for p in (job_path, job_path + ".out.json"):
            if os.path.exists(p):
                os.remove(p)
    log(f"  渲染 {len(views)} 张，{time.time() - start:.1f} 秒")
    return infos
