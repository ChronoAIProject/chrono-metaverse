"""重计算放进子进程（设计 6.4、14）：设内存上限（`resource.setrlimit`）和超时，可随时取消。

用法：`run_isolated("metaverse_worker.processing.voxelize:run_voxelize", {"...": ...}, memory_mb=..., timeout=...)`。
目标函数在子进程里执行，参数和返回值经临时文件用 pickle 传递（结果里可以有大数组、贴图）。
子进程用 spawn 启动：不继承父进程的线程、数据库连接和信号处理。

- 超时、取消（租约丢失、收到停止信号）：杀掉子进程，抛 `IsolatedTimeout` / `IsolatedCancelled`；
- 内存超限：子进程里的 `MemoryError` 变成 `IsolatedMemoryError`；被系统按信号杀掉也归为崩溃；
- 目标函数抛出的其他异常：`IsolatedError`，带原异常类型、说明和调用栈。
"""

from __future__ import annotations

import importlib
import logging
import multiprocessing
import os
import pickle
import tempfile
import threading
import time
import traceback
from collections.abc import Callable, Mapping
from typing import Any

log = logging.getLogger(__name__)


class IsolatedError(RuntimeError):
    def __init__(self, message: str, *, kind: str = "error", error_type: str = "", tb: str = "") -> None:
        super().__init__(message)
        self.kind = kind
        self.error_type = error_type
        self.tb = tb


class IsolatedTimeout(IsolatedError):
    pass


class IsolatedCancelled(IsolatedError):
    pass


class IsolatedMemoryError(IsolatedError):
    pass


class IsolatedCrash(IsolatedError):
    pass


def _resolve(target: str) -> Callable[..., Any]:
    module_name, _, func_name = target.partition(":")
    if not module_name or not func_name:
        raise ValueError("target 必须写成 '模块:函数'")
    return getattr(importlib.import_module(module_name), func_name)


def _child_main(target: str, args_path: str, result_path: str, memory_bytes: int | None) -> None:
    if memory_bytes:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    try:
        with open(args_path, "rb") as fh:
            kwargs = pickle.load(fh)
        value = _resolve(target)(**kwargs)
        payload = {"ok": True, "value": value}
    except MemoryError as error:
        payload = {"ok": False, "kind": "memory", "type": "MemoryError", "message": str(error) or "内存超限"}
    except BaseException as error:
        payload = {
            "ok": False,
            "kind": "error",
            "type": type(error).__name__,
            "message": str(error),
            "traceback": traceback.format_exc(),
        }
    try:
        with open(result_path, "wb") as fh:
            pickle.dump(payload, fh, protocol=pickle.HIGHEST_PROTOCOL)
    except MemoryError:
        os._exit(3)
    os._exit(0 if payload["ok"] else 1)


def run_isolated(
    target: str,
    kwargs: Mapping[str, Any] | None = None,
    *,
    memory_mb: int | None = None,
    timeout: float | None = None,
    cancel: threading.Event | Callable[[], bool] | None = None,
    poll: float = 0.2,
) -> Any:
    """在子进程里调用 `target(**kwargs)` 并返回结果。"""
    ctx = multiprocessing.get_context("spawn")
    with tempfile.TemporaryDirectory(prefix="mvw-isolate-") as tmp:
        args_path = os.path.join(tmp, "args.pkl")
        result_path = os.path.join(tmp, "result.pkl")
        with open(args_path, "wb") as fh:
            pickle.dump(dict(kwargs or {}), fh, protocol=pickle.HIGHEST_PROTOCOL)
        memory_bytes = memory_mb * 1024 * 1024 if memory_mb else None
        proc = ctx.Process(
            target=_child_main, args=(target, args_path, result_path, memory_bytes), name=f"isolated:{target}"
        )
        started = time.monotonic()
        proc.start()

        def cancelled() -> bool:
            if cancel is None:
                return False
            return cancel.is_set() if isinstance(cancel, threading.Event) else bool(cancel())

        try:
            while True:
                proc.join(poll)
                if proc.exitcode is not None:
                    break
                if timeout is not None and time.monotonic() - started > timeout:
                    raise IsolatedTimeout(f"子进程超时（{timeout:.0f} 秒）", kind="timeout")
                if cancelled():
                    raise IsolatedCancelled("子进程被取消", kind="cancelled")
        finally:
            if proc.exitcode is None:
                proc.kill()
                proc.join(10)
        payload = None
        if os.path.exists(result_path):
            try:
                with open(result_path, "rb") as fh:
                    payload = pickle.load(fh)
            except Exception:  # 写了一半就被杀
                payload = None
        if payload is None:
            code = proc.exitcode
            if code is not None and code < 0:
                raise IsolatedCrash(f"子进程被信号 {-code} 终止（可能超出内存）", kind="crash")
            raise IsolatedCrash(f"子进程异常退出（退出码 {code}）", kind="crash")
        if payload["ok"]:
            return payload["value"]
        if payload["kind"] == "memory":
            raise IsolatedMemoryError(f"子进程内存超限（上限 {memory_mb} MB）", kind="memory", error_type="MemoryError")
        raise IsolatedError(
            f"{payload['type']}: {payload['message']}",
            kind="error",
            error_type=payload["type"],
            tb=payload.get("traceback", ""),
        )
