"""命令行工作区的交接（设计 8.4）。

`metaverse init` 建的目录（有 `space.json`）就是工作区。本地工具从当前目录往上找 `space.json` 来定默认值：

| 参数 | 默认 | 谁写的 |
|---|---|---|
| `--scan` | `scan/scan.zip` | `metaverse pull --scan`、`metaverse-recon scan-zip` |
| `--transform` | `scan/transform.json`（`{transform: [16 个数], source, seq}`） | `pull`、`align` |
| `--limits` | `limits.json`（服务端各用途的上传上限，没有就用内置默认值） | `pull` |
| 基线 | `out/recon/` | `prepare` |
| 包 | `out/bundle/` | `bundle` |
| 包的 `base` | `space.json` 的 `{spaceId, seq}` | `pull` |

不在工作区里时，这些路径都要显式给。本模块只读本地文件，不连接本服务。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .core import ReconError

SPACE_FILE = "space.json"
SCAN_ZIP = "scan/scan.zip"
TRANSFORM_FILE = "scan/transform.json"
LIMITS_FILE = "limits.json"
BASE_DIR = "out/recon"
BUNDLE_DIR = "out/bundle"
MAX_WALK = 64


@dataclass(frozen=True)
class Workspace:
    root: Path
    space: dict[str, Any]

    def path(self, rel: str) -> Path:
        return self.root / rel

    @property
    def space_id(self) -> str | None:
        value = self.space.get("spaceId")
        return value if isinstance(value, str) else None

    @property
    def seq(self) -> int | None:
        value = self.space.get("seq")
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 1 else None

    def base_ref(self) -> dict[str, Any] | None:
        """包的 `base`：`space.json` 的 `{spaceId, seq}`（没拉取过版本时没有）。"""
        if self.space_id is None or self.seq is None:
            return None
        return {"spaceId": self.space_id, "seq": self.seq}


def find_workspace(start: str | os.PathLike[str] | None = None) -> Workspace | None:
    """从 `start`（默认当前目录）往上找 `space.json`；找不到返回 None。`space.json` 读不了时报错。"""
    here = Path(start or os.getcwd()).resolve()
    for folder in [here, *here.parents][:MAX_WALK]:
        candidate = folder / SPACE_FILE
        if candidate.is_file():
            try:
                with open(candidate, encoding="utf-8") as fh:
                    space = json.load(fh)
            except (OSError, ValueError) as error:
                raise ReconError(f"工作区的 {candidate} 读不了：{error}") from error
            if not isinstance(space, dict):
                raise ReconError(f"工作区的 {candidate} 不是 JSON 对象")
            return Workspace(folder, space)
    return None


def default_path(given: str | None, rel: str, *, must_exist: bool = True, what: str = "") -> str | None:
    """参数给了就用它；没给时在工作区里取 `rel`（不在工作区、或 `must_exist` 而文件不在时返回 None）。"""
    if given:
        return given
    ws = find_workspace()
    if ws is None:
        return None
    path = ws.path(rel)
    if must_exist and not path.exists():
        return None
    return str(path)


def require_path(given: str | None, rel: str, what: str, *, must_exist: bool = True) -> str:
    """同 `default_path`，取不到时报错，写明要给哪个参数。"""
    path = default_path(given, rel, must_exist=must_exist)
    if path is None:
        where = (
            "（不在工作区里：往上找不到 space.json）"
            if find_workspace() is None
            else f"（工作区里没有 {rel}）"
        )
        raise ReconError(f"缺少{what}{where}")
    return path


def read_transform(path: str) -> list[float]:
    """`scan/transform.json`（`{transform: [16 个数], ...}`）或直接是 16 个数的数组。"""
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as error:
        raise ReconError(f"变换文件 {path} 读不了：{error}") from error
    values = doc.get("transform") if isinstance(doc, dict) else doc
    if not (
        isinstance(values, list)
        and len(values) == 16
        and all(isinstance(v, int | float) and not isinstance(v, bool) for v in values)
    ):
        raise ReconError(
            f"变换文件 {path} 必须是 16 个数（列主序，扫描坐标 → 空间坐标）或 {{transform: [...]}}"
        )
    return [float(v) for v in values]


def write_transform(path: str, transform: list[float], source: str, seq: int | None, **extra: Any) -> None:
    """写 `scan/transform.json`，格式与命令行 `pull` 写的相同（`align` 用 `source: "align"`）。"""
    doc: dict[str, Any] = {"transform": [float(v) for v in transform], "source": source, "seq": seq}
    doc.update(extra)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
        fh.write("\n")


__all__ = [
    "BASE_DIR",
    "BUNDLE_DIR",
    "LIMITS_FILE",
    "SCAN_ZIP",
    "SPACE_FILE",
    "TRANSFORM_FILE",
    "Workspace",
    "default_path",
    "find_workspace",
    "read_transform",
    "require_path",
    "write_transform",
]
