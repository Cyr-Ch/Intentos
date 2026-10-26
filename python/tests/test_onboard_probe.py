from __future__ import annotations

import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import onboard_probe as op  # noqa: E402


def _write(root: pathlib.Path, rel: str, text: str = "") -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def test_src_layout_with_pyproject(tmp_path: pathlib.Path):
    _write(tmp_path, "pyproject.toml", '[project]\nname = "acme.demand"\nrequires-python = ">=3.10"\ndependencies = ["numpy", "pandas >= 2.1"]\n[project.optional-dependencies]\ntest = ["pytest", "pytest-cov"]\ndocs = ["sphinx"]\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n')
    _write(tmp_path, "src/acme/demand/__init__.py", "X = 1\n")
    _write(tmp_path, "tests/test_x.py", "def test_x():\n    assert True\n")
    _write(tmp_path, "tests/test_data/__init__.py")
    _write(tmp_path, "docs/index.rst", "Docs\n")
    _write(tmp_path, "README.rst", "readme\n")
    _write(tmp_path, "tox.ini", "[testenv]\nsetenv =\n    PYTHONPATH={toxinidir}/tests\n")
    out = op.probe(str(tmp_path))
    assert out["name"] == "acme.demand"
    assert out["dependencies"] == ["numpy", "pandas >= 2.1"]
    assert out["test_dependencies"] == ["pytest", "pytest-cov"]  # docs extra ignored
    assert out["layout"] == "src" and out["packages"] == ["acme"] and out["package_dirs"] == ["src/acme"]
    assert out["test_paths"] == ["tests"]
    assert out["pythonpath"] == ["src", "tests"]  # src layout + tox hint / helper package
    assert out["pytest"]["source"] == "pyproject.toml:[tool.pytest.ini_options]"
    assert "docs/**" in out["protected_candidates"] and "pyproject.toml" in out["protected_candidates"] and "README.rst" in out["protected_candidates"]
    assert out["docs"]["rst"] == ["README.rst", "docs/index.rst"] and out["docs"]["markdown"] == []
    assert out["warnings"] == []


def test_flat_layout_with_requirements_and_setup_cfg(tmp_path: pathlib.Path):
    _write(tmp_path, "requirements.txt", "# runtime\nrequests>=2\n-e .\n-r requirements-dev.txt\nflask  # web\n")
    _write(tmp_path, "requirements-dev.txt", "pytest\nblack\n")
    _write(tmp_path, "setup.cfg", "[metadata]\nname = billing\n[tool:pytest]\ntestpaths = test\naddopts = -ra\n")
    _write(tmp_path, "billing/__init__.py")
    _write(tmp_path, "billing/core.py", "def f():\n    return 1\n")
    _write(tmp_path, "test/test_core.py", "def test_f():\n    assert True\n")
    _write(tmp_path, "README.md", "# Billing\n")
    out = op.probe(str(tmp_path))
    assert out["name"] == "billing"
    assert out["layout"] == "flat" and out["packages"] == ["billing"] and out["package_dirs"] == ["billing"]
    assert out["dependencies"] == ["requests>=2", "flask"]
    assert out["test_dependencies"] == ["pytest", "black"]
    assert out["test_paths"] == ["test"] and out["pythonpath"] == ["."]
    assert out["pytest"]["source"] == "setup.cfg:[tool:pytest]" and out["pytest"]["addopts"] == "-ra"
    assert any("editable" in w for w in out["warnings"])
    assert out["docs"]["markdown"] == ["README.md"]


def test_explicit_pytest_pythonpath_wins_and_project_itself_is_dropped(tmp_path: pathlib.Path):
    _write(tmp_path, "pyproject.toml", '[project]\nname = "mypkg"\ndependencies = ["mypkg", "attrs"]\n[tool.pytest.ini_options]\npythonpath = ["lib", "."]\n')
    _write(tmp_path, "lib/mypkg/__init__.py")
    _write(tmp_path, "setup.py", "from setuptools import setup\nsetup()\n")
    out = op.probe(str(tmp_path))
    assert out["dependencies"] == ["attrs"]
    assert out["pythonpath"] == ["lib", "."]
    assert out["layout"] == "flat" and out["test_paths"] == []
    assert not any("setup.py" in w for w in out["warnings"])  # dependencies were found elsewhere


def test_cli_entry_point_emits_json(tmp_path: pathlib.Path):
    _write(tmp_path, "pkg/__init__.py")
    res = subprocess.run([sys.executable, "-I", str(HERE.parent / "onboard_probe.py"), str(tmp_path)], capture_output=True, text=True, check=True)
    assert '"layout": "flat"' in res.stdout


def test_testpaths_with_trailing_slashes_and_doctest_roots(tmp_path: pathlib.Path):
    _write(tmp_path, "pyproject.toml", '[project]\nname = "demand"\n[tool.pytest.ini_options]\ntestpaths = ["src/", "./tests/", "docs/"]\naddopts = "--doctest-modules"\n')
    _write(tmp_path, "src/demand/__init__.py")
    _write(tmp_path, "tests/test_a.py", "def test_a():\n    assert True\n")
    _write(tmp_path, "docs/index.rst", "x\n")
    out = op.probe(str(tmp_path))
    assert out["test_paths"] == ["src", "tests", "docs"]
    assert out["test_dirs"] == ["tests"]
    assert out["pythonpath"] == ["src"]
    assert out["pytest"]["addopts"] == "--doctest-modules"
