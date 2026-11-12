"""缓存绑定来源地址及内容摘要，切换来源时重新下载同名文件。"""

import hashlib
import json
import urllib.request

from ..bench.core import ReconError


def cached_bytes(url, target, headers, *, limit=128 * 1024 * 1024):
    receipt = target.with_name(target.name + ".source.json")
    if target.is_file() and receipt.is_file():
        try:
            saved = json.loads(receipt.read_text())
            data = target.read_bytes()
            if saved == {"url": url, "sha256": hashlib.sha256(data).hexdigest()} and len(data) <= limit:
                return data
        except (OSError, ValueError):
            pass
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=45) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ReconError(f"下载超过 {limit // (1024 * 1024)} MiB，请缩小范围或使用其他精度")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".partial")
    temporary.write_bytes(data)
    temporary.replace(target)
    receipt.write_text(json.dumps({"url": url, "sha256": hashlib.sha256(data).hexdigest()}))
    return data
