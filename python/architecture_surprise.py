#!/usr/bin/env python3
"""Architectural-surprise review signals (spec §7.5): deterministic risk triage, never blocking.

Input (stdin JSON):
  {"base": {"<path>": "<source>", ...}, "candidate": {"<path>": "<source>", ...},
   "changed_paths": [...], "internal_modules": [...],
   "config": {"api_paths": [...], "domain_paths": [...], "ignore_names": [...]}}
Output (stdout JSON):
  {"findings": [{"kind", "path", "line", "message", "expected", "observed"}], "errors": [{"path", "error"}]}

Detectors (all compare the candidate against the base revision; files that fail to parse produce errors, never findings):
  new_dependency           a changed file that existed at base imports an internal module it did not import before
  duplicate_helper         a function/method added in the diff whose name matches an existing function elsewhere in the
                           base revision, or whose normalised body (docstring dropped, parameters renamed positionally,
                           whitespace collapsed, >= 3 statements) equals an existing function's body
  api_domain_construction  in files matching api_paths, a new call that constructs a class defined under domain_paths
                           (Enum classes and attribute access such as PlanTier.ENTERPRISE are not constructions)
Test files (tests/**, test_*.py) are not analysed for duplicate helpers: test fixtures legitimately repeat each other.
The script is standalone (stdlib only) so it can run under `python -I`.
"""
from __future__ import annotations

import ast
import copy
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass
from typing import Any

MIN_BODY_STATEMENTS = 3
ENUM_BASES = {"Enum", "IntEnum", "StrEnum", "Flag", "IntFlag"}


def glob_to_regex(glob: str) -> re.Pattern[str]:
    out = ""
    i = 0
    while i < len(glob):
        c = glob[i]
        if c == "*":
            if glob[i + 1 : i + 2] == "*":
                if glob[i + 2 : i + 3] == "/":
                    out += "(?:.*/)?"
                    i += 3
                    continue
                out += ".*"
                i += 2
                continue
            out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        else:
            out += re.escape(c)
        i += 1
    return re.compile(f"^{out}$")


def matches_any(path: str, globs: list[str]) -> bool:
    return any(glob_to_regex(g).match(path) for g in globs)


def module_name_for(path: str) -> str:
    rel = path[:-3] if path.endswith(".py") else path
    parts = rel.split("/")
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def is_test_path(path: str) -> bool:
    base = os.path.basename(path)
    return base.startswith("test_") or base == "conftest.py" or path.startswith("tests/") or "/tests/" in path


def is_internal(target: str, internal: set[str]) -> bool:
    if target in internal:
        return True
    parts = target.split(".")
    return any(".".join(parts[:i]) in internal for i in range(1, len(parts)))


def internal_imports(tree: ast.AST, path: str, internal: set[str]) -> dict[str, int]:
    """Module-level imports of internal modules: {module: first line}. Mirrors the indexer's extraction."""
    out: dict[str, int] = {}
    module = module_name_for(path)

    def add(target: str, line: int) -> None:
        if target and is_internal(target, internal) and target not in out:
            out[target] = line

    for node in getattr(tree, "body", []):
        if isinstance(node, ast.Import):
            for alias in node.names:
                add(alias.name, node.lineno)
        elif isinstance(node, ast.ImportFrom):
            target = node.module or ""
            if node.level:
                base_parts = module.split(".")
                if not path.endswith("__init__.py"):
                    base_parts = base_parts[:-1]
                base_parts = base_parts[: len(base_parts) - (node.level - 1)] if node.level > 1 else base_parts
                target = ".".join([*base_parts, target]) if target else ".".join(base_parts)
            add(target, node.lineno)
            for alias in node.names:
                candidate = f"{target}.{alias.name}" if target else alias.name
                if candidate in internal:
                    add(candidate, node.lineno)
    return out


@dataclass
class FunctionInfo:
    path: str
    name: str
    qualname: str
    line: int
    kind: str  # function | method
    normalised: str | None


class _Renamer(ast.NodeTransformer):
    def __init__(self, mapping: dict[str, str]) -> None:
        self.mapping = mapping

    def visit_Name(self, node: ast.Name) -> ast.AST:
        if node.id in self.mapping:
            return ast.copy_location(ast.Name(id=self.mapping[node.id], ctx=node.ctx), node)
        return node

    def visit_arg(self, node: ast.arg) -> ast.AST:
        if node.arg in self.mapping:
            node.arg = self.mapping[node.arg]
        return node


def _arg_names(args: ast.arguments) -> list[str]:
    names = [a.arg for a in [*args.posonlyargs, *args.args]]
    if args.vararg:
        names.append(args.vararg.arg)
    names.extend(a.arg for a in args.kwonlyargs)
    if args.kwarg:
        names.append(args.kwarg.arg)
    return names


def normalise_body(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> str | None:
    body = list(fn.body)
    if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) and isinstance(body[0].value.value, str):
        body = body[1:]
    if len(body) < MIN_BODY_STATEMENTS:
        return None
    mapping = {name: f"_a{i}" for i, name in enumerate(_arg_names(fn.args))}
    renamer = _Renamer(mapping)
    parts: list[str] = []
    for stmt in body:
        node = renamer.visit(copy.deepcopy(stmt))
        try:
            parts.append(ast.unparse(node))
        except Exception:  # pragma: no cover - unparse is total for parsed code
            return None
    return " ".join("\n".join(parts).split())


def functions(tree: ast.AST, path: str) -> list[FunctionInfo]:
    out: list[FunctionInfo] = []

    def visit(nodes: list[ast.stmt], prefix: str, kind: str) -> None:
        for node in nodes:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qual = f"{prefix}.{node.name}" if prefix else node.name
                out.append(FunctionInfo(path=path, name=node.name, qualname=qual, line=node.lineno, kind=kind, normalised=normalise_body(node)))
            elif isinstance(node, ast.ClassDef):
                visit(node.body, f"{prefix}.{node.name}" if prefix else node.name, "method")

    visit(getattr(tree, "body", []), "", "function")
    return out


def _base_name(expr: ast.expr) -> str:
    if isinstance(expr, ast.Name):
        return expr.id
    if isinstance(expr, ast.Attribute):
        return expr.attr
    if isinstance(expr, ast.Subscript):
        return _base_name(expr.value)
    return ""


def domain_classes(trees: dict[str, ast.AST], domain_paths: list[str]) -> dict[str, str]:
    """{class name: defining path} for classes defined under domain_paths, excluding Enum subclasses."""
    out: dict[str, str] = {}
    for path, tree in trees.items():
        if not matches_any(path, domain_paths):
            continue
        for node in getattr(tree, "body", []):
            if isinstance(node, ast.ClassDef) and not any(_base_name(b) in ENUM_BASES for b in node.bases):
                out.setdefault(node.name, path)
    return out


def construction_calls(tree: ast.AST) -> list[tuple[str, int]]:
    calls: list[tuple[str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            if name:
                calls.append((name, node.lineno))
    return calls


def _ignored(name: str, ignore_names: list[str]) -> bool:
    return (name.startswith("__") and name.endswith("__")) or name.startswith("test_") or name in ignore_names


def check(payload: dict[str, Any]) -> dict[str, Any]:
    base_src: dict[str, str] = payload.get("base", {})
    cand_src: dict[str, str] = payload.get("candidate", {})
    changed: list[str] = payload.get("changed_paths", [])
    internal = set(payload.get("internal_modules", []))
    config = payload.get("config", {})
    api_paths = config.get("api_paths") or ["app/api/**"]
    domain_paths = config.get("domain_paths") or ["app/domain/**"]
    ignore_names = config.get("ignore_names") or []

    findings: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    base: dict[str, ast.AST] = {}
    cand: dict[str, ast.AST] = {}
    for store, sources, label in ((base, base_src, "base"), (cand, cand_src, "candidate")):
        for path, source in sources.items():
            try:
                store[path] = ast.parse(source, filename=path)
            except (SyntaxError, ValueError) as exc:
                errors.append({"path": path, "error": f"{label}: {exc}"})

    def emit(kind: str, path: str, line: int, message: str, expected: str, observed: str) -> None:
        findings.append({"kind": kind, "path": path, "line": line, "message": message, "expected": expected, "observed": observed})

    base_funcs = [fn for path, tree in base.items() for fn in functions(tree, path)]
    by_name: dict[str, list[FunctionInfo]] = {}
    by_body: dict[str, list[FunctionInfo]] = {}
    for fn in base_funcs:
        if not is_test_path(fn.path):
            by_name.setdefault(fn.name, []).append(fn)
            if fn.normalised:
                by_body.setdefault(fn.normalised, []).append(fn)
    base_qual = {(fn.path, fn.qualname) for fn in base_funcs}
    domain = domain_classes({**base, **cand}, domain_paths)

    for path in sorted(changed):
        ctree = cand.get(path)
        if ctree is None:
            continue  # deleted, unparsable or not a Python file
        btree = base.get(path)

        # 1. New cross-module dependency (only for files that existed at base; a new file's imports are visible in the diff).
        if btree is not None:
            before = internal_imports(btree, path, internal)
            after = internal_imports(ctree, path, internal)
            for mod, line in sorted(after.items(), key=lambda kv: kv[1]):
                if mod in before or module_name_for(path) == mod:
                    continue
                emit(
                    "new_dependency",
                    path,
                    line,
                    f"{path}:{line} now imports internal module {mod}, which it did not import at the base revision (new cross-module dependency; risk triage, not proof of bad design)",
                    f"internal imports at base: {', '.join(sorted(before)) or 'none'}",
                    f"adds import of {mod}",
                )

        # 2. Duplicate helper (added functions only; test files excluded on both sides).
        if not is_test_path(path):
            for fn in functions(ctree, path):
                if (path, fn.qualname) in base_qual or _ignored(fn.name, ignore_names):
                    continue
                same = [b for b in by_name.get(fn.name, []) if (b.path, b.qualname) != (path, fn.qualname)]
                if same:
                    b = same[0]
                    emit(
                        "duplicate_helper",
                        path,
                        fn.line,
                        f"{path}:{fn.line} adds {fn.qualname}() whose name matches existing {b.path}:{b.line} {b.qualname}() (possible duplicate helper; risk triage, not proof of bad design)",
                        f"reuse of {b.qualname} in {b.path}",
                        f"new definition {fn.qualname} in {path}",
                    )
                    continue
                if fn.normalised:
                    twins = [b for b in by_body.get(fn.normalised, []) if (b.path, b.qualname) != (path, fn.qualname)]
                    if twins:
                        b = twins[0]
                        emit(
                            "duplicate_helper",
                            path,
                            fn.line,
                            f"{path}:{fn.line} adds {fn.qualname}() whose body is equivalent to {b.path}:{b.line} {b.qualname}() after renaming parameters (duplicate helper; risk triage, not proof of bad design)",
                            f"reuse of {b.qualname} in {b.path}",
                            f"new definition {fn.qualname} in {path} with an equivalent body",
                        )

        # 3. Domain object construction in the API layer (new calls only).
        if matches_any(path, api_paths):
            before_calls = Counter(name for name, _ in construction_calls(btree)) if btree is not None else Counter()
            seen: Counter[str] = Counter()
            for name, line in sorted(construction_calls(ctree), key=lambda c: c[1]):
                if name not in domain:
                    continue
                seen[name] += 1
                if seen[name] <= before_calls.get(name, 0):
                    continue  # pre-existing construction
                emit(
                    "api_domain_construction",
                    path,
                    line,
                    f"{path}:{line} constructs domain object {name}() in the API layer; domain objects are normally built by services (risk triage, not proof of bad design)",
                    f"API layer formats service results; {name} is defined in {domain[name]}",
                    f"new call {name}(...) at line {line}",
                )
    return {"findings": findings, "errors": errors}


def main() -> int:
    payload = json.load(sys.stdin)
    json.dump(check(payload), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
