"""健康检查：`GET /healthz`（供 chrono-cd 探活）。

返回 JSON `{status, service, workerId, timestamp, currentJob, ...}`：

- 200：索引已建好、主循环在运行、看门狗没有超时；
- 503：还在启动（建索引）、正在停止，或主循环停滞。

只回答这一个路径，其他路径 404。不需要鉴权，也不输出任何配置和密钥。
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

log = logging.getLogger(__name__)

StatusFn = Callable[[], tuple[bool, dict[str, Any]]]


class HealthServer:
    def __init__(self, host: str, port: int, status: StatusFn) -> None:
        self.status = status
        outer = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "metaverse-worker"
            sys_version = ""

            def do_GET(self) -> None:
                path = self.path.split("?", 1)[0]
                if path != "/healthz":
                    self._send(404, {"status": "not_found"})
                    return
                try:
                    ok, body = outer.status()
                except Exception as error:  # 状态函数自己出错也要回答
                    log.exception("健康检查出错")
                    ok, body = False, {"status": "error", "error": type(error).__name__}
                self._send(200 if ok else 503, body)

            def do_HEAD(self) -> None:
                self.do_GET()

            def _send(self, code: int, body: dict[str, Any]) -> None:
                data = json.dumps(body, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(data)

            def log_message(self, format: str, *args: Any) -> None:
                log.debug("健康检查 %s", format % args)

        self.server = ThreadingHTTPServer((host, port), Handler)
        self.server.daemon_threads = True
        self._thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        return int(self.server.server_address[1])

    def start(self) -> None:
        self._thread = threading.Thread(target=self.server.serve_forever, name="healthz", daemon=True)
        self._thread.start()
        log.info("健康检查在端口 %d 上监听 /healthz", self.port)

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
