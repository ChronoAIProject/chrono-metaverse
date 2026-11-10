"""模型库的网络访问：带用户代理、超时、重试、大小上限的下载，以及按网址缓存的小文件（元数据、缩略图）。

只用标准库（`urllib`），代理和证书按环境变量（`HTTPS_PROXY`、`SSL_CERT_FILE`）走。令牌只在请求头里传，
不写进任何输出文件或日志。
"""

from __future__ import annotations

import hashlib
import json
import os
import ssl
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from ..core import ReconError, log
from ..env import cache_dir

USER_AGENT = "metaverse-recon/0.1 (chrono-metaverse reconstruction workbench)"
DEFAULT_TIMEOUT = 60


class DownloadError(ReconError):
    pass


def _context() -> ssl.SSLContext:
    cafile = os.environ.get("SSL_CERT_FILE")
    return ssl.create_default_context(cafile=cafile if cafile and os.path.exists(cafile) else None)


def request(url: str, headers: dict[str, str] | None = None, timeout: float = DEFAULT_TIMEOUT):
    if not url.startswith("https://"):
        raise DownloadError(f"只允许 https 地址：{url}")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout, context=_context())


def get_json(url: str, headers: dict[str, str] | None = None, retries: int = 3):
    return json.loads(get_bytes(url, headers=headers, retries=retries, max_bytes=64 << 20))


def get_bytes(
    url: str, *, headers: dict[str, str] | None = None, retries: int = 3, max_bytes: int = 64 << 20
) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with request(url, headers) as resp:
                data = resp.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise DownloadError(f"{url} 超过 {max_bytes} 字节")
            return data
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (401, 403, 404, 410):
                break
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            last = e
        time.sleep(1.5 * (attempt + 1))
    raise DownloadError(f"下载失败 {_safe(url)}：{last}")


def _safe(url: str) -> str:
    """日志里不带查询参数（临时下载地址的签名）。"""
    return url.split("?", 1)[0]


def download(
    url: str, dest: str | Path, *, max_bytes: int, headers: dict[str, str] | None = None, retries: int = 3
) -> tuple[str, int]:
    """流式下载到 dest（先写临时文件，完成后改名）；超过 max_bytes 就中止。返回 (sha256, 字节数)。"""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    last: Exception | None = None
    for attempt in range(retries):
        fd, tmp = tempfile.mkstemp(prefix=".part-", dir=dest.parent)
        try:
            h = hashlib.sha256()
            total = 0
            with os.fdopen(fd, "wb") as out, request(url, headers, timeout=120) as resp:
                length = resp.headers.get("Content-Length")
                if length and int(length) > max_bytes:
                    raise DownloadError(f"{_safe(url)} 有 {int(length)} 字节，超过上限 {max_bytes}")
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise DownloadError(f"{_safe(url)} 超过上限 {max_bytes} 字节")
                    h.update(chunk)
                    out.write(chunk)
            os.replace(tmp, dest)
            return h.hexdigest(), total
        except DownloadError:
            raise
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (401, 403, 404, 410):
                break
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            last = e
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
        log(f"  下载重试 {attempt + 1}：{_safe(url)}（{last}）")
        time.sleep(2 * (attempt + 1))
    raise DownloadError(f"下载失败 {_safe(url)}：{last}")


def cached(
    url: str,
    sub: str,
    *,
    max_age_s: float | None = None,
    max_bytes: int = 64 << 20,
    suffix: str = "",
    headers: dict[str, str] | None = None,
) -> Path:
    """按网址缓存的文件（`<缓存>/<sub>/<网址哈希><后缀>`）；过期或没有时重新下载。"""
    key = hashlib.sha256(url.encode()).hexdigest()[:32]
    path = cache_dir() / sub / f"{key}{suffix}"
    if path.exists() and (max_age_s is None or time.time() - path.stat().st_mtime < max_age_s):
        return path
    download(url, path, max_bytes=max_bytes, headers=headers)
    return path


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
