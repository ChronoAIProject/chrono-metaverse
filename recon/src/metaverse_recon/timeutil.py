"""时间戳：与接口服务相同，以 RFC 3339 字符串存储（`metaverse-core/src/timestamp.rs`）。

统一写成 `YYYY-MM-DDTHH:MM:SS.mmmZ`（UTC、毫秒、四位年份），字符串的字典序就是时间先后，
所以 MongoDB 上的 `leaseUntil < 现在`、`createdAt < 某时` 这类条件可以直接按字符串比较。
"""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import UTC, datetime

# 0000-01-01T00:00:00.000Z .. 9999-12-31T23:59:59.999Z（与 Rust 端相同）
MIN_MILLIS = -62_167_219_200_000
MAX_MILLIS = 253_402_300_799_999

Clock = Callable[[], int]
"""返回 Unix 纪元以来毫秒数的时钟。测试里可以换成可控的假时钟。"""


def system_clock() -> int:
    return time.time_ns() // 1_000_000


def format_ts(millis: int) -> str:
    """毫秒数 → `YYYY-MM-DDTHH:MM:SS.mmmZ`。"""
    if not MIN_MILLIS <= millis <= MAX_MILLIS:
        raise ValueError("时间戳超出 0000–9999 年的范围")
    if millis < -62_135_596_800_000:
        # datetime 不支持 0 年；实际不会用到这么早的时间。
        raise ValueError("不支持公元 1 年以前的时间")
    seconds, ms = divmod(millis, 1000)
    moment = datetime.fromtimestamp(seconds, tz=UTC)
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{ms:03d}Z"


def parse_ts(text: str) -> int:
    """解析 RFC 3339 时间（接受任意时区和小数位），返回毫秒数。"""
    if not isinstance(text, str) or "T" not in text:
        raise ValueError("时间戳不是合法的 RFC 3339 时间")
    normalized = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
    try:
        moment = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError("时间戳不是合法的 RFC 3339 时间") from error
    if moment.tzinfo is None:
        raise ValueError("时间戳必须带时区")
    delta = moment - datetime(1970, 1, 1, tzinfo=UTC)
    return (delta.days * 86_400 + delta.seconds) * 1000 + delta.microseconds // 1000


def now_ts(clock: Clock = system_clock) -> str:
    return format_ts(clock())
