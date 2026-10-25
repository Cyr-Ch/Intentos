#!/usr/bin/env python3
"""Deterministic architecture rule checks over a Python source tree.

Input (stdin JSON): {"root": "<dir>", "rules": [...], "changed_files": [...]}
Output (stdout JSON): {"findings": [...], "checked_files": N, "errors": [...]}

Rule kinds:
  forbidden_import: files matching `paths` may not import any of `forbidden_modules`
                    (exact module or dotted prefix match).
  forbidden_call:   files matching `paths` (minus `allowed_paths`) may not call a callee whose
                    dotted name ends with one of `forbidden_callees`.
  required_import:  files matching `paths` that define functions must import one of `required_modules`.
  frozen_paths:     handled by the TypeScript verifier from the Git diff (reported here as skipped).
"""
from __future__ import annotations

import ast
import fnmatch
import json
import os
import re
import sys
from typing import Any


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


def iter_python_files(root: str) -> list[str]:
    files: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in {".git", "__pycache__", ".pytest_cache", ".venv", "node_modules", ".intentos_hidden"}]
        for fn in filenames:
            if fn.endswith(".py"):
                rel = os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/")
                files.append(rel)
    return sorted(files)


def module_imports(tree: ast.AST) -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                out.append((alias.name, node.lineno))
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            out.append((mod, node.lineno))
            for alias in node.names:
                out.append((f"{mod}.{alias.name}" if mod else alias.name, node.lineno))
    return out


def callee_name(call: ast.Call) -> str | None:
    func = call.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        try:
            return ast.unparse(func)
        except Exception:
            return func.attr
    return None


def imports_match(imported: str, forbidden: str) -> bool:
    return imported == forbidden or imported.startswith(forbidden + ".")


def check(root: str, rules: list[dict[str, Any]], changed_files: list[str]) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    files = iter_python_files(root)
    trees: dict[str, ast.AST] = {}
    for rel in files:
        try:
            with open(os.path.join(root, rel), "r", encoding="utf-8") as fh:
                trees[rel] = ast.parse(fh.read(), filename=rel)
        except (SyntaxError, UnicodeDecodeError, OSError) as exc:
            errors.append({"path": rel, "error": str(exc)})

    for rule in rules:
        kind = rule.get("kind")
        rid = rule.get("id", "ARCH-?")
        paths = rule.get("paths") or ["**"]
        targets = [f for f in trees if matches_any(f, paths)]
        if kind == "forbidden_import":
            for rel in targets:
                for imported, line in module_imports(trees[rel]):
                    for forb in rule.get("forbidden_modules", []):
                        if imports_match(imported, forb):
                            findings.append(
                                {
                                    "rule_id": rid,
                                    "kind": kind,
                                    "path": rel,
                                    "line": line,
                                    "message": f"{rel}:{line} imports '{imported}' which is forbidden for {', '.join(paths)} ({rid})",
                                    "in_changed_file": rel in changed_files,
                                }
                            )
        elif kind == "forbidden_call":
            allowed = rule.get("allowed_paths", [])
            callees = rule.get("forbidden_callees", [])
            for rel in targets:
                if matches_any(rel, allowed):
                    continue
                for node in ast.walk(trees[rel]):
                    if isinstance(node, ast.Call):
                        name = callee_name(node)
                        if not name:
                            continue
                        last = name.split(".")[-1]
                        if any(last == c or name.endswith("." + c) or name == c for c in callees):
                            findings.append(
                                {
                                    "rule_id": rid,
                                    "kind": kind,
                                    "path": rel,
                                    "line": node.lineno,
                                    "message": f"{rel}:{node.lineno} calls '{name}', which may only be called from {', '.join(allowed) or 'nowhere'} ({rid})",
                                    "in_changed_file": rel in changed_files,
                                }
                            )
        elif kind == "required_import":
            required = rule.get("required_modules", [])
            for rel in targets:
                tree = trees[rel]
                has_defs = any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) for n in ast.walk(tree))
                if not has_defs:
                    continue
                imported = [m for m, _ in module_imports(tree)]
                if not any(imports_match(m, r) for m in imported for r in required):
                    findings.append(
                        {
                            "rule_id": rid,
                            "kind": kind,
                            "path": rel,
                            "line": 1,
                            "message": f"{rel} must import one of {', '.join(required)} ({rid})",
                            "in_changed_file": rel in changed_files,
                        }
                    )
        elif kind == "frozen_paths":
            continue  # evaluated from the diff by the orchestrator
        else:
            errors.append({"path": "", "error": f"unknown rule kind {kind!r} for {rid}"})
    return {"findings": findings, "checked_files": len(trees), "errors": errors}


def main() -> int:
    payload = json.load(sys.stdin)
    result = check(payload["root"], payload.get("rules", []), payload.get("changed_files", []))
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
