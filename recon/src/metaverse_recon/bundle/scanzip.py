"""扫描 zip：按接口服务部署种子的规则打包（设计 7.1、7.3、8.3 `scan-zip`），读别人的扫描 zip 时设上限。

**打包规则**（与 `api/crates/metaverse-api/src/demo_seed/pack.rs` 的 `stored_zip` 逐字节相同，
向量 `api/crates/metaverse-api/tests/vectors/demo_seed_zip.json`）：成员按给出的顺序；存储不压缩（方法 0），
标志 0；时间固定为 1980-01-01 00:00（DOS 日期 0x0021、时间 0）；"需要的版本" 10，"创建的版本" 20；
没有扩展字段和注释；内部、外部属性都是 0；成员名只能是 ASCII，不超过 65535 个成员，总长度不超过 4 GiB
（不用 zip64）。所以种子来源表里的 `zip` 成员（同样的文件、同样的顺序）打出来的哈希，就是线上已有的
扫描资源的哈希。

**读别人的扫描 zip**：成员不能是绝对路径、不能含 `..` 段，不能加密，解压后合计不超过 2 GiB（`MAX_UNPACKED`），
`__MACOSX/` 和 `.DS_Store` 忽略。

**下载成员**的主机列表是 `METAVERSE_RECON_SCAN_HOSTS`，默认与线上部署种子的 `METAVERSE_DEMO_SEED_HOSTS` 相同
（扫描成员通常是 Scaniverse 的原地址；来源表和种子用的是同一份），不是模型库那一组。
"""

from __future__ import annotations

import os
import posixpath
import struct
import zipfile
import zlib
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from ..errors import InputRejected
from ..fetch import build_opener, fetch, parse_hosts

LOCAL_HEADER = 0x04034B50
CENTRAL_HEADER = 0x02014B50
END_OF_DIRECTORY = 0x06054B50
VERSION_NEEDED = 10
VERSION_MADE_BY = 20
DOS_DATE = (1 << 5) | 1
DOS_TIME = 0
MAX_UNPACKED = 2 << 30
MAX_MEMBERS = 64
MEMBER_FETCH_TIMEOUT = 120.0
SCAN_HOSTS_ENV = "METAVERSE_RECON_SCAN_HOSTS"
#: 与 `infra/chrono-cd/app.json`、`infra/dev/up.sh` 的 `METAVERSE_DEMO_SEED_HOSTS` 相同（测试核对 `up.sh`，
#: `check-app` 核对那两处）。
DEFAULT_SCAN_HOSTS = (
    "raw.githubusercontent.com",
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
    "scaniverse.com",
)


def _crc32_file(path: str) -> int:
    crc = 0
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            crc = zlib.crc32(chunk, crc)
    return crc & 0xFFFFFFFF


def pack_stored_zip(members: Sequence[tuple[str, str]], dest: str) -> None:
    """按给出的顺序把 (成员名, 本地文件) 打成 stored zip（规则见模块说明），流式写，不把成员读进内存。"""
    if len(members) > 0xFFFF:
        raise InputRejected("zip 成员太多")
    central = bytearray()
    offset = 0
    with open(dest, "wb") as out:
        for name, path in members:
            raw = name.encode("ascii", errors="strict") if name.isascii() else None
            if not raw:
                raise InputRejected(f"zip 成员名只能是 ASCII：{name!r}")
            size = os.path.getsize(path)
            if offset + size > 0xFFFFFFFF:
                raise InputRejected("zip 超过 4 GiB（不用 zip64）")
            crc = _crc32_file(path)
            head = struct.pack(
                "<IHHHHHIIIHH",
                LOCAL_HEADER,
                VERSION_NEEDED,
                0,
                0,
                DOS_TIME,
                DOS_DATE,
                crc,
                size,
                size,
                len(raw),
                0,
            )
            out.write(head + raw)
            with open(path, "rb") as fh:
                for chunk in iter(lambda fh=fh: fh.read(1 << 20), b""):
                    out.write(chunk)
            central += struct.pack(
                "<IHHHHHHIIIHHHHHII",
                CENTRAL_HEADER,
                VERSION_MADE_BY,
                VERSION_NEEDED,
                0,
                0,
                DOS_TIME,
                DOS_DATE,
                crc,
                size,
                size,
                len(raw),
                0,
                0,
                0,
                0,
                0,
                offset,
            )
            central += raw
            offset += len(head) + len(raw) + size
        if offset + len(central) > 0xFFFFFFFF:
            raise InputRejected("zip 超过 4 GiB（不用 zip64）")
        out.write(bytes(central))
        out.write(
            struct.pack(
                "<IHHHHIIH", END_OF_DIRECTORY, 0, 0, len(members), len(members), len(central), offset, 0
            )
        )


def stored_zip_bytes(members: Sequence[tuple[str, bytes]]) -> bytes:
    """内存里的成员打包（测试和小文件用），规则与 `pack_stored_zip` 相同。"""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for i, (name, data) in enumerate(members):
            path = os.path.join(tmp, f"m{i}")
            with open(path, "wb") as fh:
                fh.write(data)
            paths.append((name, path))
        dest = os.path.join(tmp, "out.zip")
        pack_stored_zip(paths, dest)
        with open(dest, "rb") as fh:
            return fh.read()


def fetch_members(
    members: Sequence[Mapping[str, Any]],
    workdir: str,
    *,
    hosts: Iterable[str] | None = None,
    opener: Any = None,
) -> list[tuple[str, str]]:
    """来源表的 `zip` 成员 `[{name, url, sha256, size}]`：逐个下载、核对大小和哈希，
    返回 (成员名, 本地文件)。"""
    if not 1 <= len(members) <= 32:
        raise InputRejected("zip 成员必须是 1–32 个")
    allowed = (
        tuple(hosts) if hosts is not None else parse_hosts(os.environ.get(SCAN_HOSTS_ENV), DEFAULT_SCAN_HOSTS)
    )
    opener = opener if opener is not None else build_opener()
    os.makedirs(workdir, exist_ok=True)
    out = []
    for i, m in enumerate(members):
        name = m.get("name")
        if not isinstance(name, str) or not name or "/" in name or not name.isascii():
            raise InputRejected(f"第 {i} 个成员名不合法（ASCII，不含 /）")
        dest = os.path.join(workdir, f"{i:02d}-{name}")
        fetch(
            str(m["url"]),
            dest,
            sha256=str(m["sha256"]),
            size=int(m["size"]),
            hosts=allowed,
            timeout=MEMBER_FETCH_TIMEOUT,
            opener=opener,
        )
        out.append((name, dest))
    return out


def check_scan_zip(path: str, max_unpacked: int = MAX_UNPACKED) -> list[zipfile.ZipInfo]:
    """读别人的扫描 zip 之前的检查（见模块说明）。返回要用的成员。"""
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as error:
        raise InputRejected(f"zip 无法打开：{error}") from error
    with zf:
        infos = zf.infolist()
    if len(infos) > MAX_MEMBERS:
        raise InputRejected(f"zip 成员超过 {MAX_MEMBERS} 个")
    used = []
    total = 0
    for info in infos:
        name = info.filename
        if name.startswith("/") or "\\" in name or ".." in name.split("/") or posixpath.isabs(name):
            raise InputRejected(f"zip 成员路径不合法：{name!r}")
        if info.flag_bits & 0x1:
            raise InputRejected("不支持加密的 zip")
        if info.is_dir() or name.startswith("__MACOSX/") or posixpath.basename(name) == ".DS_Store":
            continue
        total += info.file_size
        if total > max_unpacked:
            raise InputRejected(f"zip 解压后超过 {max_unpacked} 字节")
        used.append(info)
    if not used:
        raise InputRejected("zip 里没有文件")
    return used


__all__ = [
    "MAX_UNPACKED",
    "check_scan_zip",
    "fetch_members",
    "pack_stored_zip",
    "stored_zip_bytes",
]
