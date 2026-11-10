"""图上标注的语言：找到中文字体就写中文，找不到就退回英文（JSON 和终端输出始终是中文）。

`METAVERSE_RECON_LANG=en` 可以强制用英文标注。
"""

from __future__ import annotations

import functools
import os

from .env import find_font


@functools.cache
def chinese() -> bool:
    lang = os.environ.get("METAVERSE_RECON_LANG", "").lower()
    if lang.startswith("en"):
        return False
    return find_font() is not None


def t(zh: str, en: str) -> str:
    """按能不能显示中文选一种写法。"""
    return zh if chinese() else en
