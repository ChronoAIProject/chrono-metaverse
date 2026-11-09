"""`uv.lock` 与 `pyproject.toml` 一致：镜像按锁定版本装依赖（infra/worker/Dockerfile 的 uv export --frozen），
改了依赖范围却忘了重新 `uv lock` 时这里先失败。"""

import tomllib
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.version import Version

ROOT = Path(__file__).resolve().parents[1]


def lock_mismatches(pyproject: dict, lock: dict) -> list[str]:
    """锁定文件没覆盖到、或锁定版本不满足 pyproject 版本范围的依赖。"""
    project = pyproject["project"]
    locked = {
        canonicalize_name(p["name"]): Version(p["version"]) for p in lock.get("package", []) if "version" in p
    }
    problems = []
    if lock.get("requires-python") != project.get("requires-python"):
        problems.append(
            f"requires-python 不一致：{lock.get('requires-python')} / {project.get('requires-python')}"
        )
    wanted = list(project.get("dependencies", []))
    for extra in project.get("optional-dependencies", {}).values():
        wanted += extra
    for text in wanted:
        req = Requirement(text)
        version = locked.get(canonicalize_name(req.name))
        if version is None:
            problems.append(f"{req.name} 没有锁定")
        elif not req.specifier.contains(version, prereleases=True):
            problems.append(f"{req.name} 锁定的 {version} 不满足 {req.specifier}")
    return problems


def test_lock_matches_pyproject():
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text("utf-8"))
    lock = tomllib.loads((ROOT / "uv.lock").read_text("utf-8"))
    assert lock_mismatches(pyproject, lock) == []


def test_lock_mismatch_detected():
    pyproject = {
        "project": {
            "requires-python": ">=3.13",
            "dependencies": ["numpy>=2.5,<3", "pymongo>=4.19,<5"],
            "optional-dependencies": {"dev": ["pytest>=9.2,<10"]},
        }
    }
    lock = {
        "requires-python": ">=3.12",
        "package": [{"name": "numpy", "version": "3.0.0"}, {"name": "PyMongo", "version": "4.19.0"}],
    }
    problems = lock_mismatches(pyproject, lock)
    assert len(problems) == 3
    assert any("requires-python" in p for p in problems)
    assert any("numpy" in p and "3.0.0" in p for p in problems)
    assert any("pytest" in p and "没有锁定" in p for p in problems)
