"""配置、健康检查、入口（不需要数据库的部分）。"""

import json
import urllib.error
import urllib.request

import pytest

from metaverse_worker.__main__ import main
from metaverse_worker.config import Config, ConfigError, redact_uri
from metaverse_worker.handlers import COMMITTING_KINDS, HANDLERS
from metaverse_worker.health import HealthServer

BASE_ENV = {
    # 运行时拼出带用户名、密码的连接串（仓库里不出现像凭据的字符串）
    "MONGODB_URI": "mongodb://" + "user" + ":" + "pw" + "x" * 3 + "@db.example:27017/x?authSource=admin",
    "MONGODB_DATABASE": "mv",
}


def test_config_defaults_and_overrides(tmp_path):
    c = Config.from_env(BASE_ENV)
    assert c.health_port == 8080 and c.health_host == "0.0.0.0"
    assert c.model_max_triangles == 100_000 and c.align_max_error_cm == 3.0 and c.align_hold_days == 30.0
    assert c.workdir is None and c.log_level == "INFO"
    assert "dl.polyhaven.org" in c.model_hosts and ".hf.co" in c.model_hosts
    c = Config.from_env(
        {
            **BASE_ENV,
            "WORKER_HEALTH_PORT": "9001",
            "WORKER_ALIGN_MAX_ERROR_CM": "2.5",
            "WORKER_ALIGN_HOLD_DAYS": "14",
            "WORKER_MODEL_MAX_TRIANGLES": "5000",
            "WORKER_WORKDIR": str(tmp_path),
            "LOG_LEVEL": "debug",
            "WORKER_MODEL_HOSTS": "dl.polyhaven.org, .HF.co",
        }
    )
    assert c.model_hosts == ("dl.polyhaven.org", ".hf.co")
    assert (c.health_port, c.align_max_error_cm, c.model_max_triangles) == (9001, 2.5, 5000)
    assert c.align_hold_days == 14.0
    assert c.workdir == str(tmp_path) and c.log_level == "DEBUG"


@pytest.mark.parametrize(
    "env",
    [
        {"MONGODB_DATABASE": "mv"},
        {"MONGODB_URI": "mongodb://h"},
        {**BASE_ENV, "WORKER_HEALTH_PORT": "70000"},
        {**BASE_ENV, "WORKER_HEALTH_PORT": "abc"},
        {**BASE_ENV, "WORKER_ALIGN_MAX_ERROR_CM": "0"},
        {**BASE_ENV, "WORKER_ALIGN_HOLD_DAYS": "0"},
        {**BASE_ENV, "WORKER_WORKDIR": "/no/such/dir"},
        {**BASE_ENV, "LOG_LEVEL": "LOUD"},
        {**BASE_ENV, "WORKER_MODEL_MAX_TRIANGLES": "0"},
        {**BASE_ENV, "WORKER_HEARTBEAT_SECONDS": "100"},
        {**BASE_ENV, "WORKER_MODEL_HOSTS": "http://dl.polyhaven.org"},
        {**BASE_ENV, "WORKER_MODEL_HOSTS": ","},
    ],
)
def test_config_rejects(env):
    with pytest.raises(ConfigError):
        Config.from_env(env)


def test_summary_has_no_secret():
    c = Config.from_env(BASE_ENV)
    text = json.dumps(c.summary(), default=str)
    assert "pwxxx" not in text and "user" not in text and "mongodb://" not in text
    assert c.summary()["mongodb_hosts"] == "db.example:27017"
    assert redact_uri("mongodb+srv://a:b@cluster0.example.net/?retryWrites=true") == "cluster0.example.net"
    assert redact_uri("mongodb://h1:1,h2:2/?replicaSet=rs0") == "h1:1,h2:2"


def test_main_exits_2_on_bad_config(monkeypatch, capsys):
    monkeypatch.delenv("MONGODB_URI", raising=False)
    monkeypatch.delenv("MONGODB_DATABASE", raising=False)
    assert main([]) == 2
    assert "配置错误" in capsys.readouterr().err


def test_handler_kinds_exclude_ops_from_upload():
    assert set(HANDLERS) == {"upload_verify", "scan_import", "rebuild", "voxelize", "model_import"}
    assert "ops_from_upload" not in HANDLERS
    assert {"scan_import", "rebuild", "voxelize"} == COMMITTING_KINDS


def _get(url: str) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def test_health_server_status_codes():
    state = {"ok": False}

    def status():
        if state.get("boom"):
            raise RuntimeError("x")
        return state["ok"], {"status": "ok" if state["ok"] else "starting", "service": "metaverse-worker"}

    server = HealthServer("127.0.0.1", 0, status)
    server.start()
    try:
        base = f"http://127.0.0.1:{server.port}"
        assert _get(base + "/healthz") == (503, {"status": "starting", "service": "metaverse-worker"})
        state["ok"] = True
        code, body = _get(base + "/healthz?probe=1")
        assert code == 200 and body["status"] == "ok"
        assert _get(base + "/other")[0] == 404
        state["boom"] = True
        code, body = _get(base + "/healthz")
        assert code == 503 and body["status"] == "error"
    finally:
        server.stop()
