"""测试用的本机 https 服务：临时生成自签名证书（openssl 命令行），按路径返回固定内容或重定向。

只在测试里用：证书和私钥写在 pytest 的临时目录，测试结束就删掉，仓库里不放任何密钥。
"""

from __future__ import annotations

import hashlib
import http.server
import ssl
import subprocess
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field

from metaverse_recon.fetch import build_opener


@dataclass
class Route:
    status: int = 200
    body: bytes = b""
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class LocalHttps:
    port: int
    routes: dict[str, Route]
    context: ssl.SSLContext  # 信任这张自签名证书的客户端上下文
    hits: list[str] = field(default_factory=list)

    @property
    def host(self) -> str:
        return f"localhost:{self.port}"

    def url(self, path: str) -> str:
        return f"https://localhost:{self.port}{path}"

    def add(self, path: str, body: bytes) -> dict:
        """放一个文件，返回物件集里 `model` / `files` 需要的 `{url, sha256, size}`。"""
        self.routes[path] = Route(body=body)
        return {"url": self.url(path), "sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}

    def redirect(self, path: str, location: str, status: int = 302) -> str:
        self.routes[path] = Route(status=status, headers={"Location": location})
        return self.url(path)

    def opener(self):
        return build_opener(self.context, use_env_proxy=False)


def _certificate(directory: str) -> tuple[str, str]:
    cert, key = f"{directory}/cert.pem", f"{directory}/key.pem"
    args = "req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=localhost"
    san = "subjectAltName=DNS:localhost,IP:127.0.0.1"
    command = ["openssl", *args.split(), "-addext", san, "-keyout", key, "-out", cert]
    subprocess.run(command, check=True, capture_output=True)
    return cert, key


@contextmanager
def serve(directory: str) -> Iterator[LocalHttps]:
    cert, key = _certificate(directory)
    routes: dict[str, Route] = {}
    hits: list[str] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            hits.append(self.path)
            route = routes.get(self.path, Route(status=404, body=b"not found"))
            self.send_response(route.status)
            for name, value in route.headers.items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(route.body)))
            self.end_headers()
            self.wfile.write(route.body)

        def log_message(self, *args) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_ctx.minimum_version = ssl.TLSVersion.TLSv1_2  # 只用 TLS 1.2 及以上
    server_ctx.load_cert_chain(cert, key)
    server.socket = server_ctx.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    client = ssl.create_default_context(cafile=cert)
    try:
        yield LocalHttps(server.server_address[1], routes, client, hits)
    finally:
        server.shutdown()
        server.server_close()
