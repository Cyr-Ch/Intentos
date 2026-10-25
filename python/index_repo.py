#!/usr/bin/env python3
"""Deterministic repository indexer for IntentOS.

Extracts Python symbols/imports/tests and Markdown doc sections from the
tracked files of a Git repository at HEAD, and prints a JSON document to
stdout. Everything here is static analysis: call extraction is name-based
and labelled with its extraction method and confidence.

Usage: index_repo.py <repo_path> [--max-file-bytes N]
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from typing import Any

MAX_FILE_BYTES_DEFAULT = 1_000_000
IGNORED_BASENAMES = {".env", ".env.local", ".env.production", "id_rsa", "credentials.json"}


def run_git(repo: str, *args: str) -> str:
    out = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True)
    return out.stdout


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def module_name_for(path: str) -> str:
    rel = path[:-3] if path.endswith(".py") else path
    parts = rel.split("/")
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


@dataclass
class Symbol:
    id: str
    kind: str  # module | class | function | method
    qualified_name: str
    name: str
    path: str
    line_start: int
    line_end: int
    docstring: str | None
    parent: str | None
    decorators: list[str]
    bases: list[str]
    is_test: bool
    signature: str | None


@dataclass
class Import:
    from_module: str
    to_module: str
    path: str
    line: int
    names: list[str]
    resolved_internal: bool


@dataclass
class CallRef:
    from_symbol: str
    callee: str
    path: str
    line: int
    extraction_method: str = "ast_name_match"
    confidence: float = 0.4


@dataclass
class DocSection:
    id: str
    path: str
    heading: str
    level: int
    line_start: int
    line_end: int
    text: str
    content_hash: str


@dataclass
class Doc:
    path: str
    title: str | None
    sections: list[DocSection]
    adr: dict[str, Any] | None
    content_hash: str


@dataclass
class TestCase:
    id: str
    path: str
    name: str
    line: int
    module: str


@dataclass
class IndexResult:
    repo: dict[str, Any]
    files: list[str]
    modules: list[str]
    symbols: list[Symbol] = field(default_factory=list)
    imports: list[Import] = field(default_factory=list)
    calls: list[CallRef] = field(default_factory=list)
    docs: list[Doc] = field(default_factory=list)
    tests: list[TestCase] = field(default_factory=list)
    skipped: list[dict[str, str]] = field(default_factory=list)
    limitations: list[str] = field(default_factory=list)


def _unparse(node: ast.AST) -> str:
    try:
        return ast.unparse(node)
    except Exception:  # pragma: no cover - defensive
        return node.__class__.__name__


def _signature(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    args = _unparse(fn.args)
    ret = f" -> {_unparse(fn.returns)}" if fn.returns else ""
    return f"({args}){ret}"


def _callee_name(call: ast.Call) -> str | None:
    func = call.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        base = func.value
        if isinstance(base, ast.Name):
            return f"{base.id}.{func.attr}"
        if isinstance(base, ast.Attribute):
            return f"{_unparse(base)}.{func.attr}"
        return func.attr
    return None


def index_python(path: str, source: str, internal_modules: set[str], result: IndexResult) -> None:
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as exc:
        result.skipped.append({"path": path, "reason": f"syntax error: {exc.msg} (line {exc.lineno})"})
        return
    module = module_name_for(path)
    is_test_file = os.path.basename(path).startswith("test_") or path.startswith("tests/") or "/tests/" in path
    mod_doc = ast.get_docstring(tree)
    line_end = max((getattr(n, "end_lineno", 1) or 1 for n in ast.walk(tree) if hasattr(n, "end_lineno")), default=1)
    result.symbols.append(
        Symbol(
            id=f"MOD:{module}",
            kind="module",
            qualified_name=module,
            name=module.rsplit(".", 1)[-1],
            path=path,
            line_start=1,
            line_end=line_end,
            docstring=mod_doc,
            parent=None,
            decorators=[],
            bases=[],
            is_test=is_test_file,
            signature=None,
        )
    )

    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name
                result.imports.append(
                    Import(module, top, path, node.lineno, [alias.asname or alias.name], _is_internal(top, internal_modules))
                )
        elif isinstance(node, ast.ImportFrom):
            target = node.module or ""
            if node.level:
                base_parts = module.split(".")
                if not path.endswith("__init__.py"):
                    base_parts = base_parts[:-1]
                base_parts = base_parts[: len(base_parts) - (node.level - 1)] if node.level > 1 else base_parts
                target = ".".join([*base_parts, target]) if target else ".".join(base_parts)
            names = [a.name for a in node.names]
            result.imports.append(Import(module, target, path, node.lineno, names, _is_internal(target, internal_modules)))
            # `from pkg import submodule` also implies an import of pkg.submodule
            for n in names:
                candidate = f"{target}.{n}"
                if candidate in internal_modules:
                    result.imports.append(Import(module, candidate, path, node.lineno, [n], True))

    def visit_function(fn: ast.FunctionDef | ast.AsyncFunctionDef, parent_qn: str | None, kind: str) -> None:
        qn = f"{parent_qn}.{fn.name}" if parent_qn else f"{module}.{fn.name}"
        sym = Symbol(
            id=f"SY:{qn}",
            kind=kind,
            qualified_name=qn,
            name=fn.name,
            path=path,
            line_start=fn.lineno,
            line_end=fn.end_lineno or fn.lineno,
            docstring=ast.get_docstring(fn),
            parent=parent_qn,
            decorators=[_unparse(d) for d in fn.decorator_list],
            bases=[],
            is_test=is_test_file and fn.name.startswith("test"),
            signature=_signature(fn),
        )
        result.symbols.append(sym)
        if sym.is_test:
            result.tests.append(TestCase(id=f"TEST:{path}::{fn.name}" if not parent_qn else f"TEST:{path}::{parent_qn.rsplit('.',1)[-1]}::{fn.name}", path=path, name=fn.name, line=fn.lineno, module=module))
        for sub in ast.walk(fn):
            if isinstance(sub, ast.Call):
                callee = _callee_name(sub)
                if callee:
                    result.calls.append(CallRef(from_symbol=sym.id, callee=callee, path=path, line=sub.lineno))

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            visit_function(node, None, "function")
        elif isinstance(node, ast.ClassDef):
            qn = f"{module}.{node.name}"
            result.symbols.append(
                Symbol(
                    id=f"SY:{qn}",
                    kind="class",
                    qualified_name=qn,
                    name=node.name,
                    path=path,
                    line_start=node.lineno,
                    line_end=node.end_lineno or node.lineno,
                    docstring=ast.get_docstring(node),
                    parent=module,
                    decorators=[_unparse(d) for d in node.decorator_list],
                    bases=[_unparse(b) for b in node.bases],
                    is_test=is_test_file and node.name.startswith("Test"),
                    signature=None,
                )
            )
            for child in node.body:
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    visit_function(child, qn, "method")


def _is_internal(target: str, internal_modules: set[str]) -> bool:
    if target in internal_modules:
        return True
    parts = target.split(".")
    return any(".".join(parts[:i]) in internal_modules for i in range(1, len(parts)))


ADR_FIELD_RE = re.compile(r"^\*{0,2}(Status|Date|Supersedes|Superseded-by|Deciders|Owner)\*{0,2}\s*:\s*\*{0,2}(.+?)\*{0,2}\s*$", re.IGNORECASE)
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "section"


def index_markdown(path: str, source: str, result: IndexResult) -> None:
    lines = source.splitlines()
    title: str | None = None
    sections: list[DocSection] = []
    current: tuple[str, int, int] | None = None  # heading, level, start line (1-based)
    adr: dict[str, Any] = {}

    def close(end_line: int) -> None:
        nonlocal current
        if current is None:
            return
        heading, level, start = current
        body = "\n".join(lines[start - 1 : end_line])
        sections.append(
            DocSection(
                id=f"DOC:{path}#{slugify(heading)}",
                path=path,
                heading=heading,
                level=level,
                line_start=start,
                line_end=end_line,
                text=body,
                content_hash=sha256_text(body),
            )
        )
        current = None

    for i, line in enumerate(lines, start=1):
        m = HEADING_RE.match(line)
        if m:
            close(i - 1)
            level = len(m.group(1))
            heading = m.group(2).strip()
            if level == 1 and title is None:
                title = heading
            current = (heading, level, i)
            continue
        fm = ADR_FIELD_RE.match(line.strip())
        if fm and i <= 40:
            adr[fm.group(1).lower().replace("-", "_")] = fm.group(2).strip()
    close(len(lines))

    is_adr = bool(re.search(r"(^|/)adr[-_]", path, re.IGNORECASE)) or "status" in adr
    adr_meta: dict[str, Any] | None = None
    if is_adr:
        status_raw = adr.get("status", "unknown")
        status_norm = "unknown"
        s = status_raw.lower()
        if "supersed" in s:
            status_norm = "superseded"
        elif "accept" in s:
            status_norm = "accepted"
        elif "propos" in s or "draft" in s:
            status_norm = "proposed"
        elif "deprecat" in s or "reject" in s:
            status_norm = "rejected"
        adr_meta = {
            "status_raw": status_raw,
            "status": status_norm,
            "date": adr.get("date"),
            "supersedes": adr.get("supersedes"),
            "superseded_by": adr.get("superseded_by") or _extract_superseded_by(status_raw),
            "title": title,
        }
    result.docs.append(Doc(path=path, title=title, sections=sections, adr=adr_meta, content_hash=sha256_text(source)))


def _extract_superseded_by(status: str) -> str | None:
    m = re.search(r"superseded\s+by\s+([\w\-./]+)", status, re.IGNORECASE)
    return m.group(1) if m else None


def index_repo(repo: str, max_file_bytes: int) -> IndexResult:
    repo = os.path.abspath(repo)
    head = run_git(repo, "rev-parse", "HEAD").strip()
    branch_out = subprocess.run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], cwd=repo, capture_output=True, text=True)
    branch = branch_out.stdout.strip() if branch_out.returncode == 0 else None
    dirty = bool(run_git(repo, "status", "--porcelain").strip())
    files = [f for f in run_git(repo, "ls-files", "-z").split("\0") if f]
    files = [f for f in files if os.path.basename(f) not in IGNORED_BASENAMES]

    py_files = [f for f in files if f.endswith(".py")]
    md_files = [f for f in files if f.lower().endswith(".md")]
    internal_modules = {module_name_for(f) for f in py_files}

    result = IndexResult(
        repo={"path": repo, "head_sha": head, "branch": branch, "dirty": dirty},
        files=files,
        modules=sorted(internal_modules),
    )
    result.limitations.extend(
        [
            "Call references are extracted by syntactic name matching only (no type inference); dynamic dispatch, reflection and decorators are not resolved.",
            "Imports inside functions and conditional imports are not recorded; only module-level imports are indexed.",
            "Only tracked files at HEAD are indexed; uncommitted working-tree changes are ignored.",
        ]
    )
    if dirty:
        result.limitations.append("Repository had uncommitted changes at index time; the index reflects HEAD, not the working tree.")

    for rel in py_files + md_files:
        full = os.path.join(repo, rel)
        try:
            size = os.path.getsize(full)
        except OSError as exc:
            result.skipped.append({"path": rel, "reason": str(exc)})
            continue
        if size > max_file_bytes:
            result.skipped.append({"path": rel, "reason": f"file too large ({size} bytes)"})
            continue
        try:
            with open(full, "r", encoding="utf-8") as fh:
                source = fh.read()
        except (OSError, UnicodeDecodeError) as exc:
            result.skipped.append({"path": rel, "reason": str(exc)})
            continue
        if rel.endswith(".py"):
            index_python(rel, source, internal_modules, result)
        else:
            index_markdown(rel, source, result)
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo")
    parser.add_argument("--max-file-bytes", type=int, default=MAX_FILE_BYTES_DEFAULT)
    args = parser.parse_args(argv)
    try:
        result = index_repo(args.repo, args.max_file_bytes)
    except subprocess.CalledProcessError as exc:
        print(json.dumps({"error": f"git failed: {exc.stderr.strip() if exc.stderr else exc}"}), file=sys.stdout)
        return 2
    json.dump(asdict(result), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
