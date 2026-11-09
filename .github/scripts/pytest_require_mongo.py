"""持续集成用的 pytest 插件：设置了 METAVERSE_TEST_MONGODB_URI 时，MongoDB 测试不许跳过。

处理服务的 `store` 夹具（worker/tests/conftest.py）在 MongoDB 连不上时 `pytest.skip`，本地没有
副本集时这样很方便；但持续集成里副本集一旦出问题，所有 MongoDB 集成测试都会被跳过，任务照样
显示通过。接口服务的测试只有显式设置 METAVERSE_SKIP_MONGO_TESTS=1 才跳过，这里对齐那条规则：

- 环境变量 METAVERSE_TEST_MONGODB_URI 有值（持续集成里有）时，用到 MongoDB 的测试一旦被跳过，
  就改判为失败，并带上原来的跳过原因；
- "用到 MongoDB" 指带 `mongo` 标记，或者夹具里（含间接依赖）有 `store`；
- 没设置这个变量时（本地）不改变任何结果；预期失败（xfail）也不改。

用法（在 worker/ 下）：

    PYTHONPATH=../.github/scripts .venv/bin/pytest -p pytest_require_mongo
"""

from __future__ import annotations

import os

import pytest

ENV = "METAVERSE_TEST_MONGODB_URI"
MONGO_MARKER = "mongo"
MONGO_FIXTURES = frozenset({"store"})


def uses_mongo(item: pytest.Item) -> bool:
    if item.get_closest_marker(MONGO_MARKER) is not None:
        return True
    return bool(MONGO_FIXTURES.intersection(getattr(item, "fixturenames", ())))


def skip_reason(report: pytest.TestReport) -> str:
    longrepr = report.longrepr
    reason = str(longrepr[2]) if isinstance(longrepr, tuple) and len(longrepr) == 3 else str(longrepr)
    return reason.removeprefix("Skipped: ")


@pytest.hookimpl(wrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo) -> pytest.TestReport:
    report = yield
    if os.environ.get(ENV) and report.skipped and not hasattr(report, "wasxfail") and uses_mongo(item):
        report.outcome = "failed"
        report.longrepr = (
            f"设置了 {ENV}，MongoDB 测试不能跳过（{skip_reason(report)}）。"
            "检查持续集成里起的副本集是否还在运行。"
        )
    return report
