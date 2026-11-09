"""处理服务入口：`metaverse-worker`（或 `python -m metaverse_worker`）。

1. 读配置（环境变量，缺必填项或不合法就以退出码 2 退出）；
2. 起健康检查 `GET /healthz`（建好索引之前返回 503）；
3. 幂等地建索引（数据库暂时不可用时每 5 秒重试，2 分钟后仍失败就退出，交给平台重启）；
4. 进入主循环（`runner.Runner`），收到 SIGTERM / SIGINT 后优雅退出。

日志不输出连接串和任何密钥（配置摘要里只有数据库主机名）。
"""

from __future__ import annotations

import logging
import sys
import time

from pymongo.errors import PyMongoError

from .config import Config, ConfigError
from .health import HealthServer
from .runner import Runner
from .store import Store

log = logging.getLogger("metaverse_worker")

INDEX_RETRY_SECONDS = 120.0


def setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
        force=True,
    )
    # 驱动的调试日志可能带连接细节，最多输出警告
    logging.getLogger("pymongo").setLevel(max(logging.WARNING, logging.getLogger().level))


def ensure_indexes(store: Store, runner: Runner, timeout: float = INDEX_RETRY_SECONDS) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        try:
            store.ensure_indexes()
            log.info("索引已就绪")
            return True
        except PyMongoError as error:
            if time.monotonic() > deadline:
                log.error("建索引一直失败，退出：%s", type(error).__name__)
                return False
            log.warning("建索引失败，5 秒后重试：%s", type(error).__name__)
            if runner.stopping.wait(5):
                return False


def main(argv: list[str] | None = None) -> int:
    try:
        config = Config.from_env()
    except ConfigError as error:
        print(f"配置错误：{error}", file=sys.stderr)
        return 2
    setup_logging(config.log_level)
    log.info("处理服务启动：%s", config.summary())
    store = Store.connect(config)
    runner = Runner(config, store)
    runner.install_signal_handlers()
    health = HealthServer(config.health_host, config.health_port, runner.health)
    health.start()
    try:
        if not ensure_indexes(store, runner):
            return 0 if runner.stopping.is_set() else 1
        runner.run()
        return 0
    finally:
        health.stop()
        store.client.close()
        log.info("处理服务已退出")


if __name__ == "__main__":
    sys.exit(main())
