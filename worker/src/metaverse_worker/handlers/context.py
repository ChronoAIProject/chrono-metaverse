"""任务处理函数共用的上下文：数据库、配置、租约、取消信号、本地工作目录、子进程调用。"""

from __future__ import annotations

import importlib
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from ..assets import download_asset, find_asset
from ..canonical import is_sha256_hex
from ..config import Config
from ..errors import PERMANENT_ERROR_TYPES, InputRejected, PermanentJobError
from ..jobs.isolate import IsolatedCancelled, IsolatedError, run_isolated
from ..jobs.lease import Lease
from ..store import Store


@dataclass
class JobContext:
    store: Store
    config: Config
    lease: Lease
    workdir: str
    cancel: Callable[[], bool] = lambda: False
    isolate: bool = True  # False：直接在本进程里调用（只给测试用）

    @property
    def params(self) -> Mapping[str, Any]:
        return self.lease.params

    def check_cancel(self) -> None:
        if self.cancel():
            raise IsolatedCancelled("任务被取消（租约丢失或进程正在停止）", kind="cancelled")

    def compute(self, target: str, **kwargs: Any) -> Any:
        """在子进程里调用 `target(**kwargs)`（内存上限、超时、可取消）。

        子进程里抛出的 `InputRejected` / `PermanentJobError` 在这里还原成同一类型（不可重试）。
        """
        self.check_cancel()
        if not self.isolate:
            module_name, _, func_name = target.partition(":")
            return getattr(importlib.import_module(module_name), func_name)(**kwargs)
        try:
            return run_isolated(
                target,
                kwargs,
                memory_mb=self.config.job_memory_mb,
                timeout=self.config.job_timeout_seconds,
                cancel=self.cancel,
            )
        except IsolatedError as error:
            if error.error_type in PERMANENT_ERROR_TYPES:
                message = str(error)
                prefix = f"{error.error_type}: "
                if message.startswith(prefix):
                    message = message[len(prefix) :]
                cls = InputRejected if error.error_type == "InputRejected" else PermanentJobError
                raise cls(message) from error
            raise

    def path(self, name: str) -> str:
        return os.path.join(self.workdir, name)

    def download(self, asset_hash: str, name: str, max_bytes: int) -> str:
        """把资源下载到工作目录（边写边核对哈希）。"""
        doc = find_asset(self.store, asset_hash)
        if doc is None:
            raise PermanentJobError(f"资源不存在：{asset_hash}")
        if int(doc["length"]) > max_bytes:
            raise InputRejected(f"资源 {asset_hash} 有 {doc['length']} 字节，超过上限 {max_bytes}")
        path = self.path(name)
        download_asset(self.store, asset_hash, path, max_bytes)
        return path

    def limits(self) -> dict[str, int]:
        c = self.config
        return {
            "max_scan_bytes": c.max_scan_bytes,
            "max_zip_bytes": c.max_scan_bytes * 2,
            "max_triangles": c.max_triangles,
            "max_texture_pixels": c.max_texture_pixels,
            "max_texture_side": c.max_texture_side,
            "max_grid_cells": c.max_grid_cells,
            "max_ops_bytes": c.max_ops_bytes,
            "max_model_bytes": c.max_model_bytes,
            "model_max_triangles": c.model_max_triangles,
            "model_max_texture_side": c.model_max_texture_side,
        }


def require_hash(params: Mapping[str, Any], name: str, *, optional: bool = False) -> str | None:
    value = params.get(name)
    if value is None and optional:
        return None
    if not is_sha256_hex(value):
        raise PermanentJobError(f"参数 {name} 必须是 64 位小写十六进制的内容哈希")
    return value


def optional_dict(params: Mapping[str, Any], name: str) -> dict[str, Any]:
    value = params.get(name)
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise PermanentJobError(f"参数 {name} 必须是对象")
    return dict(value)
