"""规范化 JSON 与内容哈希（SHAPES 5），与接口服务 `metaverse-core/src/canonical.rs` 逐字一致。

- 对象的键按 Unicode 码点排序（Python 的 `str` 比较本来就按码点）；
- 不留空白；
- 数字按 ECMAScript `Number.prototype.toString` 输出（RFC 8785 的写法）：`1.0 → 1`、`-0 → 0`、
  `1e16 → 10000000000000000`、`1e21 → 1e+21`、`1e-7 → 1e-7`。Python 的 `repr` 在 `1e16` 上会写成
  `1e+16`，所以这里自己实现；
- 整数必须在 ±(2^53 − 1) 以内，超出就拒绝（JavaScript 无法精确表示）；
- 字符串只转义 `"`、`\\` 和 U+0000–U+001F（优先 `\\b \\f \\n \\r \\t`，其余小写 `\\u00xx`），
  其他字符原样输出 UTF-8。

内容哈希 = 规范化字符串的 UTF-8 字节做 sha256，小写十六进制。
"""

from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from typing import Any

import numpy as np

MAX_SAFE_INTEGER = (1 << 53) - 1


class CanonicalError(ValueError):
    """无法规范化。`code` 与测试向量里的 `error` 字段对应。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _write_string(text: str, out: list[str]) -> None:
    out.append('"')
    for ch in text:
        escaped = _ESCAPES.get(ch)
        if escaped is not None:
            out.append(escaped)
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    out.append('"')


def format_number(value: float) -> str:
    """按 ECMAScript `Number.prototype.toString` 的规则写一个浮点数。"""
    value = float(value)  # np.float64 是 float 的子类，但 repr 不同
    if not math.isfinite(value):
        raise CanonicalError("non_finite", "数字不是有限值")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    # repr 给出能往返的最短有效数字；Decimal 把它拆成数字串和指数。
    _, digit_tuple, exponent = Decimal(repr(abs(value))).as_tuple()
    digits = "".join(map(str, digit_tuple)).rstrip("0")
    exponent = int(exponent) + (len(digit_tuple) - len(digits))
    k = len(digits)
    n = k + exponent  # 值 = 0.d1d2…dk × 10^n
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        body = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + body


def _write_value(value: Any, out: list[str]) -> None:
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, str):
        _write_string(value, out)
    elif isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise CanonicalError("unsafe_integer", "整数超出 ±(2^53 − 1) 的安全范围")
        out.append(str(int(value)))
    elif isinstance(value, float):
        out.append(format_number(value))
    elif isinstance(value, dict):
        items = []
        for key, item in value.items():
            if not isinstance(key, str):
                raise CanonicalError("non_string_key", "对象的键必须是字符串")
            items.append((key, item))
        items.sort(key=lambda pair: pair[0])
        out.append("{")
        for index, (key, item) in enumerate(items):
            if index:
                out.append(",")
            _write_string(key, out)
            out.append(":")
            _write_value(item, out)
        out.append("}")
    elif isinstance(value, list | tuple):
        out.append("[")
        for index, item in enumerate(value):
            if index:
                out.append(",")
            _write_value(item, out)
        out.append("]")
    elif isinstance(value, np.ndarray):
        _write_value(value.tolist(), out)
    elif isinstance(value, np.generic):
        # numpy 标量（np.float64、np.int32、np.bool_ ...）
        _write_value(value.item(), out)
    else:
        raise CanonicalError("unsupported", f"不支持的类型：{type(value).__name__}")


def canonical_json(value: Any) -> str:
    """把 JSON 值（dict / list / str / 数字 / bool / None）写成规范化字符串。"""
    out: list[str] = []
    _write_value(value, out)
    return "".join(out)


def canonicalize_text(text: str) -> str:
    """解析 JSON 文本并规范化。Python 的 float 解析是精确舍入的（与 Rust 的 float_roundtrip 一致）。"""
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise CanonicalError("parse", f"不是合法的 JSON：{error}") from error
    return canonical_json(value)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def content_hash(value: Any) -> str:
    """JSON 值的内容哈希。"""
    return sha256_hex(canonical_json(value).encode("utf-8"))


def is_sha256_hex(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(c in "0123456789abcdef" for c in value)
    )
