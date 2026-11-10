"""编号格式，与接口服务 `metaverse-core/src/ids.rs` 一致。"""

from __future__ import annotations

import re

_SPACE_ID = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,62})[a-z0-9]$")
_OBJECT_ID = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$")

SPACE_ANCHOR_ID = "_space"


def is_space_id(value: object) -> bool:
    """空间、组合编号：3–64 个字符，小写字母、数字和 `-`，首尾不能是 `-`。"""
    return isinstance(value, str) and _SPACE_ID.fullmatch(value) is not None


def is_object_id(value: object) -> bool:
    """物件、锚点、模板等编号：1–128 个字符，字母、数字、`-`、`_`、`.`，不能以 `.` 开头。"""
    return isinstance(value, str) and value.isascii() and _OBJECT_ID.fullmatch(value) is not None


def slug_id(text: str, max_len: int = 128) -> str:
    """把任意文字变成合法的物件编号（不合法字符换成 `-`）。"""
    out = re.sub(r"[^A-Za-z0-9_.-]+", "-", text).strip("-.") or "x"
    out = out[:max_len]
    if out.startswith("."):
        out = "x" + out[1:]
    return out
