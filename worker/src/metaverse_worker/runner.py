"""处理服务主循环（设计 6.4、14）。

- **领取**：每轮按 `lease.claim` 原子地领取一个任务（种类见 `handlers.HANDLERS`，不领取 `ops_from_upload`），
  每个空间同时运行的任务数有上限；没有任务时等 `WORKER_POLL_SECONDS` 再查；
- **续约**：任务运行期间后台线程按 `WORKER_HEARTBEAT_SECONDS` 续约；续约失败（租约丢了）就取消子进程、放弃，
  不写回；
- **执行**：产生提交的任务先查是否已经有带这个任务编号的提交（有就直接标记完成）；重计算在子进程里做
  （内存上限、超时，见 `jobs/isolate.py`）；每个任务一个临时工作目录，结束就删；
- **失败**：
  - 输入不合法、超出上限、子进程内存超限或超时：不可重试，直接标记失败；
  - 其他错误（数据库抖动、子进程崩溃等）：退回队列，重试次数用完后标记失败；
  - 租约丢失：什么也不写，由新的持有者决定；
  - 标记失败以后调用这个种类的收尾（`handlers.FAILURE_HOOKS`）：上传校验任务失败时，上传不能停在 `complete`；
- **定期清理**：后台线程每隔 `WORKER_CLEANUP_INTERVAL_SECONDS` 清理过期上传、过期草稿（连同草稿区块和预览
  令牌）和没人引用的资源，并把租约过期且重试次数用完的任务标记为失败；
- **优雅退出**：收到 SIGTERM / SIGINT 后不再领取新任务；手上的任务最多再等 `WORKER_STOP_GRACE_SECONDS`，
  还没做完就取消子进程、把任务退回队列（退还这一次的重试次数），其他副本马上可以接着做；
- **看门狗**：主循环空闲时、续约成功时喂狗；超过 `WORKER_WATCHDOG_SECONDS` 没被喂过（数据库长时间不可达、
  线程卡死）就退出进程，交给平台重启。
"""

from __future__ import annotations

import logging
import shutil
import signal
import tempfile
import threading
import time
from collections import Counter
from collections.abc import Callable, Mapping
from typing import Any

from . import __version__
from .config import Config
from .errors import PERMANENT_ERROR_TYPES, PermanentJobError
from .handlers import COMMITTING_KINDS, FAILURE_HOOKS, HANDLERS, Handler, JobContext
from .jobs.cleanup import run_cleanup
from .jobs.heartbeat import Heartbeat, Watchdog
from .jobs.isolate import (
    IsolatedCancelled,
    IsolatedCrash,
    IsolatedError,
    IsolatedMemoryError,
    IsolatedTimeout,
)
from .jobs.lease import Lease, LeaseLost, claim, mark_failed, reap_exhausted, requeue
from .jobs.writeback import finish_if_committed
from .store import JobStatus, Store
from .timeutil import now_ts

log = logging.getLogger(__name__)

SERVICE = "metaverse-worker"


class Runner:
    def __init__(
        self,
        config: Config,
        store: Store,
        *,
        handlers: Mapping[str, Handler] | None = None,
        isolate: bool = True,
        on_stall: Callable[[], None] | None = None,
    ) -> None:
        self.config = config
        self.store = store
        self.handlers = dict(HANDLERS if handlers is None else handlers)
        self.isolate = isolate
        self.stopping = threading.Event()
        self.ready = threading.Event()
        self.stop_deadline: float | None = None
        self.current: dict[str, Any] | None = None
        self.counts: Counter[str] = Counter()
        self.last_cleanup: dict[str, Any] | None = None
        self.watchdog = (
            Watchdog(config.watchdog_seconds, on_stall) if on_stall else Watchdog(config.watchdog_seconds)
        )
        self._housekeeper: threading.Thread | None = None

    # ------------------------------------------------------------------ 状态与停止

    @property
    def kinds(self) -> list[str]:
        return sorted(self.handlers)

    def request_stop(self, signum: int | None = None, _frame: Any = None) -> None:
        if self.stopping.is_set():
            return
        name = signal.Signals(signum).name if signum else "请求"
        log.info(
            "收到停止信号（%s）：不再领取新任务，手上的任务最多再等 %.0f 秒",
            name,
            self.config.stop_grace_seconds,
        )
        self.stop_deadline = time.monotonic() + self.config.stop_grace_seconds
        self.stopping.set()

    def install_signal_handlers(self) -> None:
        if threading.current_thread() is threading.main_thread():
            signal.signal(signal.SIGTERM, self.request_stop)
            signal.signal(signal.SIGINT, self.request_stop)

    def health(self) -> tuple[bool, dict[str, Any]]:
        idle = self.watchdog.idle_for()
        if self.stopping.is_set():
            status = "stopping"
        elif not self.ready.is_set():
            status = "starting"
        elif idle > self.config.watchdog_seconds:
            status = "stalled"
        else:
            status = "ok"
        body = {
            "status": status,
            "service": SERVICE,
            "version": __version__,
            "workerId": self.config.worker_id,
            "timestamp": now_ts(),
            "kinds": self.kinds,
            "currentJob": self.current,
            "jobs": dict(self.counts),
            "lastCleanup": self.last_cleanup,
        }
        return status == "ok", body

    # ------------------------------------------------------------------ 主循环

    def run(self) -> None:
        """一直运行到收到停止信号。调用前应已建好索引。"""
        self.watchdog.start()
        self._housekeeper = threading.Thread(target=self._housekeeping_loop, name="housekeeping", daemon=True)
        self._housekeeper.start()
        self.ready.set()
        log.info("开始领取任务：%s", ", ".join(self.kinds))
        try:
            while not self.stopping.is_set():
                try:
                    processed = self.run_once()
                    self.watchdog.beat()
                except Exception:
                    log.exception("领取任务出错，稍后再试")
                    processed = False
                if not processed:
                    self.stopping.wait(self.config.poll_seconds)
        finally:
            self.watchdog.stop()
            if self._housekeeper is not None:
                self._housekeeper.join(timeout=10)
            log.info("主循环已停止")

    def run_once(self) -> bool:
        """领取并处理一个任务。没有可领的任务时返回 False。"""
        if self.stopping.is_set():
            return False
        lease = claim(
            self.store,
            self.config.worker_id,
            self.kinds,
            self.config.lease_millis,
            self.config.max_jobs_per_space,
        )
        if lease is None:
            return False
        self.process(lease)
        return True

    def process(self, lease: Lease) -> str:
        """处理一个已领取的任务，返回结局（done / already / failed / queued / requeued / lost）。"""
        log.info(
            "领取任务 %s：%s，空间 %s，第 %d/%d 次",
            lease.job_id,
            lease.kind,
            lease.space_id,
            lease.attempt,
            lease.max_attempts,
        )
        started = time.monotonic()
        self.current = {
            "jobId": str(lease.job_id),
            "kind": lease.kind,
            "spaceId": lease.space_id,
            "since": now_ts(),
        }
        workdir = tempfile.mkdtemp(prefix=f"mvw-{lease.kind}-", dir=self.config.workdir)
        heartbeat = Heartbeat(
            self.store,
            lease,
            interval=self.config.heartbeat_seconds,
            lease_ms=self.config.lease_millis,
            watchdog=self.watchdog,
        )
        heartbeat.start()

        def cancelled() -> bool:
            deadline = self.stop_deadline
            return heartbeat.lost.is_set() or (deadline is not None and time.monotonic() > deadline)

        ctx = JobContext(self.store, self.config, lease, workdir, cancel=cancelled, isolate=self.isolate)
        outcome = "done"
        try:
            outcome = self._execute(ctx, heartbeat)
        finally:
            heartbeat.stop()
            shutil.rmtree(workdir, ignore_errors=True)
            self.current = None
            self.counts[outcome] += 1
            log.info("任务 %s 结束：%s，用时 %.1f 秒", lease.job_id, outcome, time.monotonic() - started)
        return outcome

    def _execute(self, ctx: JobContext, heartbeat: Heartbeat) -> str:
        lease = ctx.lease
        try:
            handler = self.handlers.get(lease.kind)
            if handler is None:
                raise PermanentJobError(f"不支持的任务种类：{lease.kind}")
            if lease.kind in COMMITTING_KINDS and finish_if_committed(self.store, lease) is not None:
                log.info("任务 %s 已经有提交，直接标记完成", lease.job_id)
                return "already"
            handler(ctx)
            return "done"
        except LeaseLost as error:
            log.warning("任务 %s 的租约已丢失，放弃，不写回：%s", lease.job_id, error)
            return "lost"
        except IsolatedCancelled:
            if heartbeat.lost.is_set():
                log.warning("任务 %s 的租约已丢失，已取消子进程", lease.job_id)
                return "lost"
            if self.stopping.is_set():
                ok = self._safe(lambda: requeue(self.store, lease))
                log.info(
                    "任务 %s 来不及做完，%s", lease.job_id, "已退回队列" if ok else "退回队列失败（租约已丢）"
                )
                return "requeued"
            return self._fail(lease, "任务被取消", retry=True)
        except (IsolatedTimeout, IsolatedMemoryError) as error:
            return self._fail(lease, error, retry=False)
        except IsolatedCrash as error:
            return self._fail(lease, error, retry=True)
        except IsolatedError as error:
            log.error("任务 %s 子进程出错：%s\n%s", lease.job_id, error, error.tb)
            return self._fail(lease, error, retry=error.error_type not in PERMANENT_ERROR_TYPES)
        except PermanentJobError as error:
            return self._fail(lease, error, retry=False)
        except Exception as error:
            log.exception("任务 %s 出错（可重试）", lease.job_id)
            return self._fail(lease, error, retry=True)

    def _fail(self, lease: Lease, error: BaseException | str, *, retry: bool) -> str:
        status = self._safe(lambda: mark_failed(self.store, lease, error, retry=retry))
        level = logging.WARNING if status == "queued" else logging.ERROR
        log.log(level, "任务 %s 失败（%s）：%s", lease.job_id, status or "未能更新状态", error)
        hook = FAILURE_HOOKS.get(lease.kind)
        if status == JobStatus.FAILED and hook is not None:
            # 失败了也不影响结局；没做成的由定期清理兜底（uploads.settle_stuck_uploads）
            self._safe(lambda: hook(self.store, lease, error))
        return {"queued": "queued", "failed": "failed"}.get(status or "", "lost")

    @staticmethod
    def _safe(fn: Callable[[], Any]) -> Any:
        try:
            return fn()
        except Exception:
            log.exception("更新任务状态失败")
            return None

    # ------------------------------------------------------------------ 定期清理

    def housekeeping(self) -> dict[str, Any]:
        # 先回收重试次数用完的任务：同一轮的清理就能处理这些任务留下的、还停在 complete 的上传
        exhausted = reap_exhausted(self.store)
        cleaned = run_cleanup(
            self.store,
            upload_ttl_hours=self.config.upload_ttl_hours,
            asset_grace_days=self.config.asset_grace_days,
        )
        cleaned["exhaustedJobs"] = exhausted
        self.last_cleanup = {"at": now_ts(), **cleaned}
        return cleaned

    def _housekeeping_loop(self) -> None:
        interval = self.config.cleanup_interval_seconds
        while True:
            try:
                self.housekeeping()
            except Exception:
                log.exception("定期清理出错，下次再试")
            if self.stopping.wait(interval):
                return
