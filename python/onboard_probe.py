#!/usr/bin/env python3
"""Read-only repository probe for `intentos onboard`.

Usage: python -I onboard_probe.py <repo>   -> JSON on stdout

Collects what a draft policy and a per-repository verifier environment need, without executing any repository code:
project name and declared dependencies (pyproject `[project]`, poetry, setup.cfg, requirements files), the package
layout (`src/` or flat), the test directories, pytest configuration (testpaths / pythonpath / addopts from pyproject,
pytest.ini, setup.cfg or tox.ini), tox PYTHONPATH hints, documentation files and packaging files worth protecting.
Everything is a heuristic; the output is a draft for a human to review, never trusted configuration by itself.
"""
from __future__ import annotations

import configparser
import json
import os
import re
import sys
from typing import Any

try:  # Python >= 3.11
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None  # type: ignore[assignment]

SKIP_DIRS = {".git", "__pycache__", ".pytest_cache", ".tox", ".venv", "venv", "node_modules", "build", "dist", ".eggs", ".mypy_cache", ".ruff_cache", ".intentos", ".intentos_hidden"}
TEST_DIR_NAMES = ("tests", "test", "testing")
TEST_EXTRA_KEYS = ("test", "tests", "testing", "dev", "develop", "development")
PACKAGING_FILES = ("pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "noxfile.py", "MANIFEST.in", "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock", "requirements.txt", "requirements-dev.txt", "requirements-test.txt", "dev-requirements.txt", "test-requirements.txt")
DOC_EXTS = (".md", ".rst", ".txt")


def read_text(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except (OSError, UnicodeDecodeError):
        return None


def split_list(value: str) -> list[str]:
    return [v.strip() for v in re.split(r"[\s,]+", value.strip()) if v.strip()]


def normalise_rel(p: str) -> str:
    """`./tests/` -> `tests`; keeps paths relative and slash-separated."""
    out = os.path.normpath(str(p).strip().replace("\\", "/"))
    return "" if out in (".", "") else out.replace(os.sep, "/").lstrip("/")


def parse_requirements(path: str, warnings: list[str]) -> list[str]:
    text = read_text(path)
    if text is None:
        return []
    out: list[str] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith(("-r", "--requirement", "-c", "--constraint")):
            continue  # nested files are discovered by name below
        if line.startswith(("-e", "--editable", ".", "-")):
            warnings.append(f"{os.path.basename(path)}: skipped option/editable entry {line!r}")
            continue
        out.append(line)
    return out


def poetry_specifier(name: str, spec: Any) -> str | None:
    """Poetry constraint -> pip specifier; caret/tilde constraints are dropped to the bare name (pip has no equivalent)."""
    if name.lower() == "python":
        return None
    version: str | None = None
    if isinstance(spec, str):
        version = spec
    elif isinstance(spec, dict):
        if spec.get("optional"):
            return None
        version = spec.get("version")
    version = (version or "").strip()
    if not version or version == "*" or version[0] in "^~":
        return name
    return f"{name}{version}" if version[0] in "<>=!" else f"{name}=={version}"


def normalise_name(spec: str) -> str:
    return re.split(r"[\s<>=!~\[;@]", spec.strip(), maxsplit=1)[0].lower().replace("_", "-")


def probe(repo: str) -> dict[str, Any]:
    repo = os.path.abspath(repo)
    warnings: list[str] = []
    name: str | None = None
    requires_python: str | None = None
    deps: list[str] = []
    test_deps: list[str] = []
    dep_sources: list[str] = []
    pytest_cfg: dict[str, Any] = {"testpaths": [], "pythonpath": [], "addopts": None, "source": None}

    pyproject = os.path.join(repo, "pyproject.toml")
    data: dict[str, Any] = {}
    if os.path.exists(pyproject):
        text = read_text(pyproject) or ""
        if tomllib is not None:
            try:
                data = tomllib.loads(text)
            except Exception as exc:  # tomllib.TOMLDecodeError
                warnings.append(f"pyproject.toml could not be parsed: {exc}")
        else:  # pragma: no cover
            warnings.append("tomllib unavailable (Python < 3.11): pyproject.toml read with a minimal parser")
            m = re.search(r'^\s*name\s*=\s*"([^"]+)"', text, re.M)
            name = m.group(1) if m else None
        project = data.get("project") or {}
        if project:
            name = project.get("name") or name
            requires_python = project.get("requires-python")
            if isinstance(project.get("dependencies"), list):
                deps.extend(str(d) for d in project["dependencies"])
                dep_sources.append("pyproject.toml:project.dependencies")
            for key, extra in (project.get("optional-dependencies") or {}).items():
                if key.lower() in TEST_EXTRA_KEYS and isinstance(extra, list):
                    test_deps.extend(str(d) for d in extra)
                    dep_sources.append(f"pyproject.toml:project.optional-dependencies.{key}")
        poetry = (data.get("tool") or {}).get("poetry") or {}
        if poetry:
            name = name or poetry.get("name")
            for dep, spec in (poetry.get("dependencies") or {}).items():
                s = poetry_specifier(dep, spec)
                if s:
                    deps.append(s)
            if poetry.get("dependencies"):
                dep_sources.append("pyproject.toml:tool.poetry.dependencies")
            for group_name, group in (poetry.get("group") or {}).items():
                if group_name.lower() in TEST_EXTRA_KEYS:
                    for dep, spec in (group.get("dependencies") or {}).items():
                        s = poetry_specifier(dep, spec)
                        if s:
                            test_deps.append(s)
                    dep_sources.append(f"pyproject.toml:tool.poetry.group.{group_name}")
            for dep, spec in (poetry.get("dev-dependencies") or {}).items():
                s = poetry_specifier(dep, spec)
                if s:
                    test_deps.append(s)
        ini = ((data.get("tool") or {}).get("pytest") or {}).get("ini_options") or {}
        if ini:
            pytest_cfg["source"] = "pyproject.toml:[tool.pytest.ini_options]"
            tp = ini.get("testpaths")
            pytest_cfg["testpaths"] = [normalise_rel(x) for x in (split_list(tp) if isinstance(tp, str) else [str(x) for x in (tp or [])])]
            pp = ini.get("pythonpath")
            pytest_cfg["pythonpath"] = [normalise_rel(x) or "." for x in (split_list(pp) if isinstance(pp, str) else [str(x) for x in (pp or [])])]
            pytest_cfg["addopts"] = " ".join(ini["addopts"]) if isinstance(ini.get("addopts"), list) else ini.get("addopts")

    # setup.cfg: install_requires and [tool:pytest]
    setup_cfg = os.path.join(repo, "setup.cfg")
    if os.path.exists(setup_cfg):
        cp = configparser.ConfigParser(interpolation=None)
        try:
            cp.read(setup_cfg, encoding="utf-8")
            if cp.has_option("metadata", "name"):
                name = name or cp.get("metadata", "name").strip()
            if cp.has_option("options", "install_requires"):
                deps.extend(line.strip() for line in cp.get("options", "install_requires").splitlines() if line.strip())
                dep_sources.append("setup.cfg:options.install_requires")
            if cp.has_section("options.extras_require"):
                for key, value in cp.items("options.extras_require"):
                    if key.lower() in TEST_EXTRA_KEYS:
                        test_deps.extend(line.strip() for line in value.splitlines() if line.strip())
                        dep_sources.append(f"setup.cfg:options.extras_require.{key}")
            if cp.has_section("tool:pytest") and not pytest_cfg["source"]:
                pytest_cfg["source"] = "setup.cfg:[tool:pytest]"
                pytest_cfg["testpaths"] = [normalise_rel(x) for x in split_list(cp.get("tool:pytest", "testpaths", fallback=""))]
                pytest_cfg["pythonpath"] = [normalise_rel(x) or "." for x in split_list(cp.get("tool:pytest", "pythonpath", fallback=""))]
                pytest_cfg["addopts"] = cp.get("tool:pytest", "addopts", fallback=None)
        except configparser.Error as exc:
            warnings.append(f"setup.cfg could not be parsed: {exc}")

    # pytest.ini / tox.ini [pytest] and tox PYTHONPATH hints
    tox_pythonpath: list[str] = []
    for ini_name in ("pytest.ini", "tox.ini"):
        ini_path = os.path.join(repo, ini_name)
        if not os.path.exists(ini_path):
            continue
        cp = configparser.ConfigParser(interpolation=None)
        try:
            cp.read(ini_path, encoding="utf-8")
        except configparser.Error as exc:
            warnings.append(f"{ini_name} could not be parsed: {exc}")
            continue
        if cp.has_section("pytest") and not pytest_cfg["source"]:
            pytest_cfg["source"] = f"{ini_name}:[pytest]"
            pytest_cfg["testpaths"] = [normalise_rel(x) for x in split_list(cp.get("pytest", "testpaths", fallback=""))]
            pytest_cfg["pythonpath"] = [normalise_rel(x) or "." for x in split_list(cp.get("pytest", "pythonpath", fallback=""))]
            pytest_cfg["addopts"] = cp.get("pytest", "addopts", fallback=None)
        if ini_name == "tox.ini" and cp.has_section("testenv"):
            for line in cp.get("testenv", "setenv", fallback="").splitlines():
                if line.strip().upper().startswith("PYTHONPATH"):
                    value = line.split("=", 1)[1].strip() if "=" in line else ""
                    for part in re.split(r"[:;]", value):
                        part = part.replace("{toxinidir}", "").strip().strip("/").strip("\\")
                        if part and not part.startswith("{"):
                            tox_pythonpath.append(part)

    if os.path.exists(os.path.join(repo, "setup.py")) and not deps and not dep_sources:
        warnings.append("setup.py present but not evaluated (dependencies may be declared only there); add them to the draft policy by hand")

    # requirements files
    for fn in sorted(os.listdir(repo)):
        if re.match(r"^(requirements[-_a-z]*|[-_a-z]*requirements)\.txt$", fn, re.I):
            entries = parse_requirements(os.path.join(repo, fn), warnings)
            if not entries:
                continue
            target = test_deps if re.search(r"(dev|test)", fn, re.I) else deps
            target.extend(entries)
            dep_sources.append(fn)
    req_dir = os.path.join(repo, "requirements")
    if os.path.isdir(req_dir):
        for fn in sorted(os.listdir(req_dir)):
            if fn.endswith(".txt"):
                entries = parse_requirements(os.path.join(req_dir, fn), warnings)
                if entries:
                    (test_deps if re.search(r"(dev|test)", fn, re.I) else deps).extend(entries)
                    dep_sources.append(f"requirements/{fn}")

    # drop the project itself and duplicates
    own = normalise_name(name) if name else None
    def dedupe(items: list[str]) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for it in items:
            key = normalise_name(it)
            if not key or key == own or key in seen:
                continue
            seen.add(key)
            out.append(it)
        return out
    deps = dedupe(deps)
    test_deps = [d for d in dedupe(test_deps) if normalise_name(d) not in {normalise_name(x) for x in deps}]

    # layout, packages, tests
    def is_package_dir(p: str, depth: int = 0) -> bool:
        """A directory holding Python code directly or through namespace sub-packages (bounded depth)."""
        if not os.path.isdir(p) or depth > 3:
            return False
        entries = os.listdir(p)
        if "__init__.py" in entries or any(f.endswith(".py") for f in entries):
            return True
        return any(is_package_dir(os.path.join(p, d), depth + 1) for d in entries if not d.startswith(".") and d not in SKIP_DIRS)
    layout = "src" if is_src_layout(repo) else "flat"
    packages: list[str] = []
    package_dirs: list[str] = []
    base = os.path.join(repo, "src") if layout == "src" else repo
    for entry in sorted(os.listdir(base)):
        full = os.path.join(base, entry)
        if entry in SKIP_DIRS or entry.startswith(".") or entry in TEST_DIR_NAMES or entry in ("docs", "doc", "examples", "scripts", "benchmarks", "notebooks", "src"):
            continue
        if is_package_dir(full):
            packages.append(entry)
            package_dirs.append(f"src/{entry}" if layout == "src" else entry)
    test_paths = list(dict.fromkeys(t for t in pytest_cfg["testpaths"] if t and os.path.isdir(os.path.join(repo, t)))) or [t for t in TEST_DIR_NAMES if os.path.isdir(os.path.join(repo, t))]
    test_dirs = [t for t in test_paths if os.path.basename(t) in TEST_DIR_NAMES or re.search(r"(^|/)tests?$", t)]
    has_conftest = any(os.path.exists(os.path.join(repo, *parts)) for parts in (("conftest.py",), *[(t, "conftest.py") for t in test_paths]))
    test_helper_packages = [t for t in test_dirs if any(os.path.isdir(os.path.join(repo, t, d)) and os.path.exists(os.path.join(repo, t, d, "__init__.py")) for d in os.listdir(os.path.join(repo, t)))]

    pythonpath: list[str] = list(pytest_cfg["pythonpath"])
    if not pythonpath:
        pythonpath = ["src"] if layout == "src" else ["."]
        for hint in tox_pythonpath + test_helper_packages:
            if hint and hint not in pythonpath and os.path.isdir(os.path.join(repo, hint)):
                pythonpath.append(hint)

    # docs and protected candidates
    md_docs: list[str] = []
    rst_docs: list[str] = []
    doc_dirs: list[str] = []
    for entry in sorted(os.listdir(repo)):
        full = os.path.join(repo, entry)
        if os.path.isdir(full) and entry.lower() in ("docs", "doc", "documentation", "adr", "adrs", "decisions"):
            doc_dirs.append(entry)
    for dirpath, dirnames, filenames in os.walk(repo):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            rel = os.path.relpath(os.path.join(dirpath, fn), repo).replace(os.sep, "/")
            if fn.lower().endswith(".md"):
                md_docs.append(rel)
            elif fn.lower().endswith(".rst"):
                rst_docs.append(rel)
    protected: list[str] = [f"{d}/**" for d in doc_dirs]
    for fn in sorted(os.listdir(repo)):
        if fn in PACKAGING_FILES or re.match(r"^(README|CHANGELOG|CHANGES|HISTORY|LICENSE|LICENCE|AUTHORS|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT)(\.|$)", fn, re.I):
            protected.append(fn)
    if os.path.isdir(os.path.join(repo, ".github")):
        protected.append(".github/**")

    return {
        "repo": repo,
        "name": name,
        "requires_python": requires_python,
        "dependencies": deps,
        "test_dependencies": test_deps,
        "dependency_sources": dep_sources,
        "layout": layout,
        "packages": packages,
        "package_dirs": package_dirs,
        "test_paths": test_paths,
        "test_dirs": test_dirs,
        "has_conftest": has_conftest,
        "pytest": {"source": pytest_cfg["source"], "testpaths": pytest_cfg["testpaths"], "pythonpath": pytest_cfg["pythonpath"], "addopts": pytest_cfg["addopts"], "tox_pythonpath": tox_pythonpath},
        "pythonpath": pythonpath,
        "docs": {"dirs": doc_dirs, "markdown": sorted(md_docs)[:200], "rst": sorted(rst_docs)[:200]},
        "protected_candidates": protected,
        "warnings": warnings,
    }


def is_src_layout(repo: str) -> bool:
    src = os.path.join(repo, "src")
    if not os.path.isdir(src):
        return False
    return any(os.path.isdir(os.path.join(src, d)) and not d.startswith(".") for d in os.listdir(src))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: onboard_probe.py <repo>", file=sys.stderr)
        return 2
    json.dump(probe(argv[1]), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
