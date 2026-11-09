"""配置：全部来自环境变量（与 CMA、接口服务一样，缺失或不合法就拒绝启动）。

必填：

- `MONGODB_URI`：数据库连接串（chrono-cd 的 MongoDB 插件注入）；
- `MONGODB_DATABASE`：数据库名。

可选：

- `WORKER_ID`：租约持有者编号，默认 `主机名-进程号-随机数`；同一时刻每个进程必须不同；
- `WORKER_LEASE_SECONDS`（180）、`WORKER_HEARTBEAT_SECONDS`（45，设计要求 30–60 秒）；
- `WORKER_WATCHDOG_SECONDS`（150）：任务心跳多久没成功就退出进程（交给平台重启）；
- `WORKER_POLL_SECONDS`（2）：没有任务时多久再查一次；
- `WORKER_STOP_GRACE_SECONDS`（20）：收到停止信号后，等手上的任务做完的最长时间；
- `WORKER_MAX_JOBS_PER_SPACE`（2）：每个空间同时运行的任务数上限；
- `WORKER_JOB_MEMORY_MB`（6144）、`WORKER_JOB_TIMEOUT_SECONDS`（1800）：重计算子进程的内存上限和超时；
- `WORKER_CLEANUP_INTERVAL_SECONDS`（600）：定期清理的间隔；
- `WORKER_UPLOAD_TTL_HOURS`（24）、`WORKER_ASSET_GRACE_DAYS`（7）：清理阈值（设计 6.1）；
- `WORKER_MAX_SCAN_BYTES`（1 GiB）、`WORKER_MAX_TRIANGLES`（500 万）、
  `WORKER_MAX_TEXTURE_PIXELS`（8192×8192）、`WORKER_MAX_GRID_CELLS`（4 亿）：解析前检查的上限（设计 6.4）；
- `WORKER_MAX_TEXTURE_SIDE`（8192）：贴图上传单边像素上限（设计 6.1）；
- `WORKER_MAX_MODEL_BYTES`（50 MiB）：物件模型资源的大小上限；
- `WORKER_MODEL_MAX_TRIANGLES`（10 万）、`WORKER_MODEL_MAX_TEXTURE_SIDE`（2048）：物件模型重新导出时的上限；
- `WORKER_MAX_OPS_BYTES`（256 MiB）：ops 上传解压后的大小上限（防压缩炸弹）；
- `WORKER_ALIGN_MAX_ERROR_CM`（3）：重扫配准误差超过它就不自动提交，转人工（设计 6.2）；
- `WORKER_HEALTH_HOST`（0.0.0.0）、`WORKER_HEALTH_PORT`（8080）：健康检查 `GET /healthz` 的监听地址；
- `WORKER_WORKDIR`（系统临时目录）：下载扫描、子进程交换数据用的本地目录；
- `LOG_LEVEL`（INFO）：日志级别。
"""

from __future__ import annotations

import os
import secrets
import socket
from collections.abc import Mapping
from dataclasses import dataclass, field


class ConfigError(ValueError):
    """配置缺失或不合法。"""


def _default_worker_id() -> str:
    host = socket.gethostname() or "worker"
    return f"{host}-{os.getpid()}-{secrets.token_hex(3)}"


@dataclass(frozen=True)
class Config:
    mongodb_uri: str
    mongodb_database: str
    worker_id: str = field(default_factory=_default_worker_id)
    lease_seconds: float = 180.0
    heartbeat_seconds: float = 45.0
    watchdog_seconds: float = 150.0
    poll_seconds: float = 2.0
    stop_grace_seconds: float = 20.0
    max_jobs_per_space: int = 2
    job_memory_mb: int = 6144
    job_timeout_seconds: float = 1800.0
    cleanup_interval_seconds: float = 600.0
    upload_ttl_hours: float = 24.0
    asset_grace_days: float = 7.0
    max_scan_bytes: int = 1 << 30
    max_triangles: int = 5_000_000
    max_texture_pixels: int = 8192 * 8192
    max_grid_cells: int = 400_000_000
    max_texture_side: int = 8192
    max_model_bytes: int = 50 << 20
    model_max_triangles: int = 100_000
    model_max_texture_side: int = 2048
    max_ops_bytes: int = 256 << 20
    align_max_error_cm: float = 3.0
    health_host: str = "0.0.0.0"
    health_port: int = 8080
    workdir: str | None = None
    log_level: str = "INFO"

    def __post_init__(self) -> None:
        if not self.mongodb_uri.startswith(("mongodb://", "mongodb+srv://")):
            raise ConfigError("MONGODB_URI 必须以 mongodb:// 或 mongodb+srv:// 开头")
        if not self.mongodb_database or any(c in self.mongodb_database for c in '/\\. "$'):
            raise ConfigError("MONGODB_DATABASE 不是合法的数据库名")
        if not self.worker_id or len(self.worker_id) > 128:
            raise ConfigError("WORKER_ID 必须是 1–128 个字符")
        for name in (
            "lease_seconds",
            "heartbeat_seconds",
            "watchdog_seconds",
            "poll_seconds",
            "job_timeout_seconds",
            "cleanup_interval_seconds",
            "upload_ttl_hours",
            "asset_grace_days",
        ):
            if not getattr(self, name) > 0:
                raise ConfigError(f"{name} 必须大于 0")
        if self.stop_grace_seconds < 0:
            raise ConfigError("stop_grace_seconds 不能小于 0")
        # 一个租约期内至少要有两次续约机会，否则一次网络抖动就会丢租约。
        if self.heartbeat_seconds * 2 >= self.lease_seconds:
            raise ConfigError("WORKER_HEARTBEAT_SECONDS 必须小于租约时长的一半")
        # 看门狗必须比续约间隔宽松，又不能晚于租约过期太久。
        if not self.heartbeat_seconds < self.watchdog_seconds <= self.lease_seconds:
            raise ConfigError("WORKER_WATCHDOG_SECONDS 必须大于续约间隔且不超过租约时长")
        for name in (
            "max_jobs_per_space",
            "job_memory_mb",
            "max_scan_bytes",
            "max_triangles",
            "max_texture_pixels",
            "max_grid_cells",
            "max_texture_side",
            "max_model_bytes",
            "model_max_triangles",
            "model_max_texture_side",
            "max_ops_bytes",
        ):
            if getattr(self, name) < 1:
                raise ConfigError(f"{name} 必须是正整数")
        if not self.align_max_error_cm > 0:
            raise ConfigError("WORKER_ALIGN_MAX_ERROR_CM 必须大于 0")
        if not 0 <= self.health_port <= 65535:
            raise ConfigError("WORKER_HEALTH_PORT 必须在 0–65535 之间")
        if not self.health_host:
            raise ConfigError("WORKER_HEALTH_HOST 不能为空")
        if self.workdir is not None and not os.path.isdir(self.workdir):
            raise ConfigError("WORKER_WORKDIR 不是已存在的目录")
        if self.log_level.upper() not in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
            raise ConfigError("LOG_LEVEL 必须是 DEBUG、INFO、WARNING、ERROR 或 CRITICAL")

    @property
    def lease_millis(self) -> int:
        return int(self.lease_seconds * 1000)

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Config:
        env = os.environ if environ is None else environ

        def required(name: str) -> str:
            value = env.get(name, "").strip()
            if not value:
                raise ConfigError(f"{name} 缺失")
            return value

        def number(name: str, default: float) -> float:
            raw = env.get(name)
            if raw is None or raw.strip() == "":
                return default
            try:
                return float(raw)
            except ValueError as error:
                raise ConfigError(f"{name} 不是数字") from error

        def integer(name: str, default: int) -> int:
            raw = env.get(name)
            if raw is None or raw.strip() == "":
                return default
            try:
                return int(raw)
            except ValueError as error:
                raise ConfigError(f"{name} 不是整数") from error

        worker_id = env.get("WORKER_ID", "").strip() or _default_worker_id()
        defaults = cls.__dataclass_fields__
        return cls(
            mongodb_uri=required("MONGODB_URI"),
            mongodb_database=required("MONGODB_DATABASE"),
            worker_id=worker_id,
            lease_seconds=number("WORKER_LEASE_SECONDS", defaults["lease_seconds"].default),
            heartbeat_seconds=number("WORKER_HEARTBEAT_SECONDS", defaults["heartbeat_seconds"].default),
            watchdog_seconds=number("WORKER_WATCHDOG_SECONDS", defaults["watchdog_seconds"].default),
            poll_seconds=number("WORKER_POLL_SECONDS", defaults["poll_seconds"].default),
            stop_grace_seconds=number("WORKER_STOP_GRACE_SECONDS", defaults["stop_grace_seconds"].default),
            max_jobs_per_space=integer("WORKER_MAX_JOBS_PER_SPACE", defaults["max_jobs_per_space"].default),
            job_memory_mb=integer("WORKER_JOB_MEMORY_MB", defaults["job_memory_mb"].default),
            job_timeout_seconds=number("WORKER_JOB_TIMEOUT_SECONDS", defaults["job_timeout_seconds"].default),
            cleanup_interval_seconds=number(
                "WORKER_CLEANUP_INTERVAL_SECONDS", defaults["cleanup_interval_seconds"].default
            ),
            upload_ttl_hours=number("WORKER_UPLOAD_TTL_HOURS", defaults["upload_ttl_hours"].default),
            asset_grace_days=number("WORKER_ASSET_GRACE_DAYS", defaults["asset_grace_days"].default),
            max_scan_bytes=integer("WORKER_MAX_SCAN_BYTES", defaults["max_scan_bytes"].default),
            max_triangles=integer("WORKER_MAX_TRIANGLES", defaults["max_triangles"].default),
            max_texture_pixels=integer("WORKER_MAX_TEXTURE_PIXELS", defaults["max_texture_pixels"].default),
            max_grid_cells=integer("WORKER_MAX_GRID_CELLS", defaults["max_grid_cells"].default),
            max_texture_side=integer("WORKER_MAX_TEXTURE_SIDE", defaults["max_texture_side"].default),
            max_model_bytes=integer("WORKER_MAX_MODEL_BYTES", defaults["max_model_bytes"].default),
            model_max_triangles=integer(
                "WORKER_MODEL_MAX_TRIANGLES", defaults["model_max_triangles"].default
            ),
            model_max_texture_side=integer(
                "WORKER_MODEL_MAX_TEXTURE_SIDE", defaults["model_max_texture_side"].default
            ),
            max_ops_bytes=integer("WORKER_MAX_OPS_BYTES", defaults["max_ops_bytes"].default),
            align_max_error_cm=number("WORKER_ALIGN_MAX_ERROR_CM", defaults["align_max_error_cm"].default),
            health_host=env.get("WORKER_HEALTH_HOST", "").strip() or defaults["health_host"].default,
            health_port=integer("WORKER_HEALTH_PORT", defaults["health_port"].default),
            workdir=env.get("WORKER_WORKDIR", "").strip() or None,
            log_level=(env.get("LOG_LEVEL", "").strip() or defaults["log_level"].default).upper(),
        )

    def summary(self) -> dict[str, object]:
        """启动日志里打印的配置摘要：不含连接串（可能带密码），只给主机部分。"""
        out: dict[str, object] = {}
        for name in self.__dataclass_fields__:
            if name == "mongodb_uri":
                out["mongodb_hosts"] = redact_uri(self.mongodb_uri)
            else:
                out[name] = getattr(self, name)
        return out


def redact_uri(uri: str) -> str:
    """`mongodb://user:pass@host1,host2/db?x=y` → `host1,host2`（不含用户名、密码和参数）。"""
    rest = uri.split("://", 1)[-1]
    rest = rest.rsplit("@", 1)[-1]
    return rest.split("/", 1)[0].split("?", 1)[0]
