"""从模型库下载外部模型（AI 物件集里的 `model.url`，`bundle.sources` 调用，只做网络读写，不解析内容）。

- **只用 https**，主机必须在允许列表里（`METAVERSE_RECON_MODEL_HOSTS`）：条目写主机名时精确匹配（端口只能
  是默认的 443）；写成 `.hf.co` 这样以点开头时匹配它的所有子域名；写成 `主机:端口` 时只匹配那个端口；
- **不自动跟随重定向**：每一跳的 `Location` 都按同样的规则检查（https、主机在列表里），最多 5 跳；
- **大小**：`Content-Length` 和声明的大小不一致就不读；边读边数，超过声明的大小立刻停；
- **哈希**：读完核对 sha256，不符就删掉文件。

错误分两类：地址或内容本身不对（主机不在列表、不是 https、大小或哈希不符、4xx）是 `DownloadRejected`，
不可重试；网络错误、超时、5xx 是 `DownloadFailed`，任务稍后重试。错误说明里不带完整地址（可能带签名参数），
只写主机。
"""

from __future__ import annotations

import hashlib
import os
import ssl
import urllib.error
import urllib.request
from collections.abc import Iterable
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

from .errors import PermanentJobError

DEFAULT_MODEL_HOSTS = (
    "dl.polyhaven.org",
    "huggingface.co",
    "cdn-lfs.huggingface.co",
    # Hugging Face 的文件实际从 hf.co 的各个 CDN 子域名下发（cdn-lfs.hf.co、cas-bridge.xethub.hf.co、
    # us.aws.cdn.hf.co 等，随地区和存储方式变化），所以按后缀放行
    ".hf.co",
)
MAX_REDIRECTS = 5
READ_BLOCK = 1 << 20
USER_AGENT = "metaverse-recon"


class DownloadRejected(PermanentJobError):
    """地址或内容不对（不可重试）。"""


class DownloadFailed(RuntimeError):
    """网络错误、超时、服务器错误（可重试）。"""


def parse_hosts(text: str | None, default: tuple[str, ...] = DEFAULT_MODEL_HOSTS) -> tuple[str, ...]:
    """逗号分隔的主机列表 → 小写去重的元组。空白时用默认列表（`default`，默认是模型库的那一组）。"""
    if text is None or not text.strip():
        return default
    out: list[str] = []
    for item in text.split(","):
        entry = item.strip().lower()
        if not entry:
            continue
        name = entry[1:] if entry.startswith(".") else entry
        host, _, port = name.partition(":")
        if (
            not host
            or any(c in host for c in "/@?#[]*")
            or (port and not (port.isdigit() and 0 < int(port) < 65536))
            or (entry.startswith(".") and (port or "." not in host))
        ):
            raise ValueError(f"主机列表里的 {item.strip()!r} 不是合法的主机名")
        if entry not in out:
            out.append(entry)
    if not out:
        raise ValueError("主机列表不能为空")
    return tuple(out)


def host_allowed(url: str, hosts: Iterable[str]) -> bool:
    """`url` 是 https、没有用户名密码、主机（和端口）在列表里。"""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    host = (parts.hostname or "").lower().rstrip(".")
    if parts.scheme != "https" or not host or parts.username is not None or parts.password is not None:
        return False
    for entry in hosts:
        if entry.startswith("."):
            if port in (None, 443) and host.endswith(entry) and len(host) > len(entry):
                return True
            continue
        name, _, want = entry.partition(":")
        if host == name and ((port in (None, 443)) if not want else port == int(want)):
            return True
    return False


def _host(url: str) -> str:
    try:
        return urlsplit(url).hostname or "?"
    except ValueError:
        return "?"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """不自动跟随重定向：交给调用方逐跳检查。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def build_opener(ssl_context: ssl.SSLContext | None = None, *, use_env_proxy: bool = True):
    handlers: list = [
        _NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl_context or ssl.create_default_context()),
    ]
    if not use_env_proxy:
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)


@dataclass(frozen=True)
class Fetched:
    bytes: int
    redirects: int
    host: str  # 最后一跳的主机


def fetch(
    url: str,
    dest: str,
    *,
    sha256: str,
    size: int,
    hosts: Iterable[str],
    timeout: float = 60.0,
    opener=None,
) -> Fetched:
    """下载 `url` 到 `dest`，核对大小和 sha256。见模块说明。"""
    hosts = tuple(hosts)
    opener = opener or build_opener()
    current = url
    for hop in range(MAX_REDIRECTS + 1):
        if not host_allowed(current, hosts):
            what = "第一跳" if hop == 0 else f"第 {hop} 次重定向"
            raise DownloadRejected(f"{what}的地址不是 https 或主机 {_host(current)} 不在允许列表里")
        request = urllib.request.Request(
            current, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"}
        )
        try:
            response = opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            location = error.headers.get("Location") if error.headers else None
            error.close()
            if error.code in (301, 302, 303, 307, 308) and location:
                current = urljoin(current, location)
                continue
            if 400 <= error.code < 500 and error.code not in (408, 425, 429):
                raise DownloadRejected(f"{_host(current)} 返回 {error.code}") from None
            raise DownloadFailed(f"{_host(current)} 返回 {error.code}") from None
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            reason = getattr(error, "reason", error)
            raise DownloadFailed(f"下载 {_host(current)} 失败：{type(reason).__name__}") from None
        with response:
            return Fetched(_save(response, dest, sha256, size, _host(current)), hop, _host(current))
    raise DownloadRejected(f"重定向超过 {MAX_REDIRECTS} 次")


def _save(response, dest: str, sha256: str, size: int, host: str) -> int:
    declared = response.headers.get("Content-Length")
    if declared is not None and declared.strip().isdigit() and int(declared) != size:
        raise DownloadRejected(f"{host} 的文件有 {declared} 字节，与声明的 {size} 不符")
    digest = hashlib.sha256()
    total = 0
    try:
        with open(dest, "wb") as out:
            while True:
                try:
                    block = response.read(READ_BLOCK)
                except (OSError, TimeoutError) as error:
                    raise DownloadFailed(f"读取 {host} 中断：{type(error).__name__}") from None
                if not block:
                    break
                total += len(block)
                if total > size:
                    raise DownloadRejected(f"{host} 的文件超过声明的 {size} 字节")
                digest.update(block)
                out.write(block)
        if total != size:
            raise DownloadRejected(f"{host} 的文件只有 {total} 字节，与声明的 {size} 不符")
        if digest.hexdigest() != sha256:
            raise DownloadRejected(f"{host} 的文件内容与声明的 sha256 不符")
    except BaseException:
        if os.path.exists(dest):
            os.unlink(dest)
        raise
    return total


__all__ = [
    "DEFAULT_MODEL_HOSTS",
    "DownloadFailed",
    "DownloadRejected",
    "Fetched",
    "build_opener",
    "fetch",
    "host_allowed",
    "parse_hosts",
]
