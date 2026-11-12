"""下载回执记录来源、摘要及 HTTP 新鲜期，不复用无期限的旧回执。"""

import hashlib
import json
import re
import time
import urllib.request
from email.utils import parsedate_to_datetime

from ..bench.core import ReconError


def fresh_seconds(headers, now):
    control = headers.get("Cache-Control", "").lower()
    directives = {part.strip().split("=", 1)[0].strip() for part in control.split(",")}
    if directives & {"no-store", "private"}:
        raise ReconError("来源禁止持久 HTTP 缓存，不能通过此下载器保存；请使用提供方正式授权的数据包")
    if "no-cache" in directives:
        return 0

    def date(name):
        try:
            return parsedate_to_datetime(headers.get(name, "")).timestamp()
        except (ValueError, TypeError, OverflowError):
            return None

    try:
        age = max(0, float(headers.get("Age", 0)))
    except (ValueError, TypeError):
        return 0
    issued = date("Date")
    age = max(age, now - issued if issued is not None else 0)
    match = re.search(r'(?:^|,)\s*max-age\s*=\s*"?(\d+)', control)
    expires = date("Expires")
    duration = int(match[1]) - age if match else (expires - now - age if expires is not None else 0)
    return max(0, min(duration, 604800))


def cached_bytes(url, target, headers, *, limit=128 * 1024 * 1024):
    receipt = target.with_name(target.name + ".source.json")
    if target.is_file() and receipt.is_file():
        try:
            saved = json.loads(receipt.read_text())
            data = target.read_bytes()
            if (
                saved.get("url") == url
                and saved.get("sha256") == hashlib.sha256(data).hexdigest()
                and time.time() < saved.get("expiresAt", 0)
                and len(data) <= limit
            ):
                return data
        except (OSError, ValueError, TypeError, AttributeError):
            pass
    started = time.time()
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=45) as response:
        response_headers = response.headers
        duration = fresh_seconds(response_headers, started)
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ReconError(f"下载超过 {limit // (1024 * 1024)} MiB，请缩小范围或使用其他精度")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".partial")
    temporary.write_bytes(data)
    temporary.replace(target)
    receipt.write_text(
        json.dumps(
            {
                "url": url,
                "sha256": hashlib.sha256(data).hexdigest(),
                "downloadedAt": started,
                "expiresAt": started + duration,
                "cacheControl": response_headers.get("Cache-Control"),
            }
        )
    )
    return data
