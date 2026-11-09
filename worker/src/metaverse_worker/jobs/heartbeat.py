"""续约心跳与看门狗（设计 6.4、14）。

- `Heartbeat`：任务运行期间的后台线程，每 `interval` 秒按栅栏条件续一次约。续约匹配不到（租约丢了），
  或者连续出错直到已经无法保证租约还在（离到期不足一个续约间隔），就置位 `lost`，处理流程据此中止、
  杀掉子进程、不写回。每次续约成功都喂一次看门狗。
- `Watchdog`：进程级看门狗。主循环空闲时、心跳续约成功时喂狗；超过 `stall_seconds` 没被喂过，
  说明心跳停滞（线程卡死、数据库长时间不可达），直接退出进程交给平台重启，避免僵死的副本占着任务。
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable

from ..store import Store
from ..timeutil import parse_ts
from .lease import Lease, renew

log = logging.getLogger(__name__)

WATCHDOG_EXIT_CODE = 70


def _default_exit() -> None:
    log.critical("看门狗：心跳停滞，退出进程")
    logging.shutdown()
    os._exit(WATCHDOG_EXIT_CODE)


class Watchdog:
    def __init__(
        self,
        stall_seconds: float,
        on_stall: Callable[[], None] = _default_exit,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.stall_seconds = stall_seconds
        self.on_stall = on_stall
        self.monotonic = monotonic
        self._last = monotonic()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.fired = False

    def beat(self) -> None:
        with self._lock:
            self._last = self.monotonic()

    def idle_for(self) -> float:
        with self._lock:
            return self.monotonic() - self._last

    def check(self) -> bool:
        """超时就触发一次 on_stall，返回是否触发。"""
        if self.idle_for() > self.stall_seconds and not self.fired:
            self.fired = True
            self.on_stall()
            return True
        return False

    def start(self) -> None:
        def loop() -> None:
            period = max(0.05, min(1.0, self.stall_seconds / 4))
            while not self._stop.wait(period):
                if self.check():
                    return

        self._thread = threading.Thread(target=loop, name="watchdog", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)


class Heartbeat:
    def __init__(
        self,
        store: Store,
        lease: Lease,
        *,
        interval: float,
        lease_ms: int,
        watchdog: Watchdog | None = None,
    ) -> None:
        self.store = store
        self.lease = lease
        self.interval = interval
        self.lease_ms = lease_ms
        self.watchdog = watchdog
        self.lost = threading.Event()
        self.renewals = 0
        self._until_ms = parse_ts(lease.lease_until)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def lease_until_ms(self) -> int:
        return self._until_ms

    def beat_once(self) -> bool:
        """续约一次。返回租约是否仍然有效。"""
        try:
            until = renew(self.store, self.lease, self.lease_ms)
        except Exception as error:  # 网络抖动等：下次再试，但不能拖到租约过期
            log.warning("任务 %s 续约出错：%s", self.lease.job_id, error)
            if self.store.clock() + self.interval * 1000 >= self._until_ms:
                log.error("任务 %s 续约一直失败，已无法保证租约，放弃", self.lease.job_id)
                self.lost.set()
                return False
            return True
        if until is None:
            log.error("任务 %s 续约失败：租约已被回收或任务已结束", self.lease.job_id)
            self.lost.set()
            return False
        self._until_ms = parse_ts(until)
        self.renewals += 1
        if self.watchdog is not None:
            self.watchdog.beat()
        return True

    def start(self) -> None:
        def loop() -> None:
            while not self._stop.wait(self.interval):
                if not self.beat_once():
                    return

        self._thread = threading.Thread(target=loop, name=f"heartbeat-{self.lease.job_id}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=max(5.0, self.interval))

    def __enter__(self) -> Heartbeat:
        self.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()
