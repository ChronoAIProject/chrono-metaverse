"""pytest_require_mongo 插件的测试（用 pytester 在临时目录里跑小测试集）。

在仓库根目录：

    worker/.venv/bin/pytest -p pytester -p no:cacheprovider .github/scripts/test_pytest_require_mongo.py
"""

from __future__ import annotations

from pathlib import Path

import pytest

PLUGIN = Path(__file__).with_name("pytest_require_mongo.py").read_text(encoding="utf-8")

# 与 worker/tests/conftest.py 的写法一致：连不上就在夹具里 skip。
CONFTEST = """
import pytest

@pytest.fixture
def store():
    pytest.skip("本地 MongoDB 不可用")

@pytest.fixture
def db_config(store):
    return {"db": "x"}

@pytest.fixture
def working_store():
    return object()
"""


@pytest.fixture
def suite(pytester: pytest.Pytester) -> pytest.Pytester:
    pytester.makeini("[pytest]\nmarkers =\n    mongo: 需要 MongoDB\n")
    pytester.makepyfile(pytest_require_mongo=PLUGIN)
    pytester.makeconftest(CONFTEST)
    pytester.syspathinsert()
    return pytester


def run(suite: pytest.Pytester, monkeypatch: pytest.MonkeyPatch, uri: str | None) -> pytest.RunResult:
    if uri is None:
        monkeypatch.delenv("METAVERSE_TEST_MONGODB_URI", raising=False)
    else:
        monkeypatch.setenv("METAVERSE_TEST_MONGODB_URI", uri)
    return suite.runpytest("-p", "pytest_require_mongo", "-p", "no:cacheprovider", "-rA")


URI = "mongodb://127.0.0.1:27017/?replicaSet=rs0"


def test_store_fixture_skip_becomes_error_when_uri_set(suite, monkeypatch):
    suite.makepyfile(
        test_a="""
        def test_direct(store):
            pass

        def test_indirect(db_config):
            pass
        """
    )
    result = run(suite, monkeypatch, URI)
    result.assert_outcomes(errors=2)
    result.stdout.fnmatch_lines(["*MongoDB 测试不能跳过（本地 MongoDB 不可用）*"])
    assert result.ret != 0


def test_mongo_marker_skip_becomes_failure_when_uri_set(suite, monkeypatch):
    suite.makepyfile(
        test_b="""
        import pytest

        pytestmark = pytest.mark.mongo

        def test_body_skips():
            pytest.skip("副本集没有主节点")
        """
    )
    result = run(suite, monkeypatch, URI)
    result.assert_outcomes(failed=1)
    result.stdout.fnmatch_lines(["*MongoDB 测试不能跳过（副本集没有主节点）*"])


def test_skips_are_kept_without_uri(suite, monkeypatch):
    suite.makepyfile(
        test_c="""
        import pytest

        def test_direct(store):
            pass

        @pytest.mark.mongo
        def test_marked():
            pytest.skip("没有副本集")
        """
    )
    result = run(suite, monkeypatch, None)
    result.assert_outcomes(skipped=2)
    assert result.ret == 0


def test_empty_uri_counts_as_unset(suite, monkeypatch):
    suite.makepyfile(test_d="def test_direct(store):\n    pass\n")
    result = run(suite, monkeypatch, "")
    result.assert_outcomes(skipped=1)


def test_other_skips_and_passes_are_untouched(suite, monkeypatch):
    suite.makepyfile(
        test_e="""
        import pytest

        def test_vectors_missing():
            pytest.skip("没有测试向量目录")

        def test_mongo_ok(working_store):
            assert working_store is not None

        @pytest.mark.mongo
        def test_marked_passes():
            pass

        @pytest.mark.mongo
        @pytest.mark.xfail(reason="已知问题")
        def test_marked_xfail():
            raise AssertionError("预期失败")
        """
    )
    result = run(suite, monkeypatch, URI)
    result.assert_outcomes(passed=2, skipped=1, xfailed=1)
    assert result.ret == 0
