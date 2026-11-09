"""模型库的许可过滤（硬性）：只要明确允许商用、不传染的许可。

- 保留：CC0（公共领域）和 CC-BY（署名）。CC-BY 必须署名：作者、来源页、许可写进物件的 `props.source`，网站显示
  "模型来源"。
- 排除：NC（非商用）、ND（禁止演绎）、SA（相同方式共享——会传染到我们的派生物，一律不要）、Sketchfab 的
  Standard / Editorial 许可，以及没写许可或认不出来的。

许可写成 SPDX 风格：`CC0-1.0`、`CC-BY-4.0`、`CC-BY-3.0`。
"""

from __future__ import annotations

ALLOWED = ("CC0-1.0", "CC-BY-4.0", "CC-BY-3.0")

# Sketchfab / Objaverse 元数据里的许可名（slug 或标签）→ SPDX；不在表里的一律不要
_SKETCHFAB = {
    "cc0": "CC0-1.0",
    "by": "CC-BY-4.0",
    "cc-by": "CC-BY-4.0",
    "cc by": "CC-BY-4.0",
    "cc attribution": "CC-BY-4.0",
    "attribution": "CC-BY-4.0",
    "cc0 public domain": "CC0-1.0",
    "public domain": "CC0-1.0",
}

_DENY_MARKERS = (
    "nc",
    "nd",
    "sa",
    "noncommercial",
    "non-commercial",
    "noderivs",
    "sharealike",
    "share-alike",
    "standard",
    "editorial",
    "st",
    "ed",
)


def normalize(raw: object) -> str | None:
    """把各库的许可写法换成 SPDX；不允许或认不出来的返回 None。"""
    if not isinstance(raw, str):
        if isinstance(raw, dict):  # Sketchfab 接口：{"slug": "by", "label": "CC Attribution", ...}
            return normalize(raw.get("slug") or raw.get("label"))
        return None
    text = raw.strip()
    if text in ALLOWED:
        return text
    low = text.lower().replace("_", "-")
    tokens = [t for t in low.replace(" ", "-").split("-") if t]
    if any(t in _DENY_MARKERS for t in tokens if t not in ("by", "cc", "cc0", "4.0", "3.0")):
        return None
    if low in _SKETCHFAB:
        return _SKETCHFAB[low]
    if low in ("cc0-1.0", "cc0 1.0", "cc0-1"):
        return "CC0-1.0"
    if low in ("cc-by-4.0", "cc by 4.0", "cc-by 4.0", "by-4.0"):
        return "CC-BY-4.0"
    if low in ("cc-by-3.0", "cc by 3.0", "by-3.0"):
        return "CC-BY-3.0"
    return None


def allowed(spdx: object) -> bool:
    return isinstance(spdx, str) and spdx in ALLOWED


def needs_attribution(spdx: str) -> bool:
    return spdx.startswith("CC-BY")


def license_url(spdx: str) -> str:
    return {
        "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
        "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
        "CC-BY-3.0": "https://creativecommons.org/licenses/by/3.0/",
    }.get(spdx, "")
