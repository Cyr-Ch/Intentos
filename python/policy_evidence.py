#!/usr/bin/env python3
"""Evidence digest and candidate ingestion for IntentOS policy mining (read-only, stdlib only, `-I` safe).

Two modes, both printing JSON on stdout:

  policy_evidence.py <repo> [--policy-id ID] [--max-commits N]
      The EVIDENCE DIGEST: the raw facts a model reads before it states a repository's business rules. Tests with
      their first assertion, commits with the files and tests they touched (fix-like ones flagged), must/never
      sentences from documents, ADR documents, import edges between source directories, directories nobody has
      touched for a year, changelog entries announcing deprecations. Nothing is scored, clustered or turned into a
      rule here: the model that follows the `intentos-policy-mining` skill selects, restates and proves the rules;
      the digest only saves it the first hour of grep.

  policy_evidence.py <repo> --ingest <proposals.json> [--policy-id ID] [--start N]
      INGESTION of model-authored candidates: every reference is checked against the repository (tracked files,
      lines, tests, commits), an existing test is lifted into a hidden-test draft that can run on its own, a written
      test is parsed, and a policy block is built for each accepted candidate. Nothing in the submission is trusted.

Python (pytest) and TypeScript/JavaScript (vitest, jest) repositories are both read.
"""
from __future__ import annotations

import argparse
import ast
import fnmatch
import json
import os
import re
import subprocess
import sys
import textwrap
from collections import defaultdict
from typing import Any

SKIP_DIRS = {".git", "__pycache__", ".pytest_cache", ".tox", ".venv", "venv", "node_modules", "build", "dist", ".eggs", ".mypy_cache", ".ruff_cache", ".intentos", ".intentos_hidden", "docs/_build", "coverage", ".next", ".turbo"}
TEST_DIR_NAMES = ("tests", "test", "testing", "__tests__", "spec")
PY_EXT = (".py",)
TS_EXT = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
TS_RESOLVE_EXT = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
HIDDEN_DEPTH = 2  # hidden tests run from <root>/.intentos_hidden/<dir>/: two levels below the repository root

FIX_START_RE = re.compile(r"^\s*(?:\[[^\]]*\]\s*)?(fix(?:es)?|bugfix|hotfix|revert(?:s|ed)?)\b", re.I)
FIX_RE = re.compile(r"\bfix(?:es|ed)?\b|\b(bug|regression|revert(?:s|ed)?|prevent(?:s|ed)?|forbid(?:s|den)?|never|must|always|only|guard(?:s|ed)?|enforce(?:s|d)?|disallow(?:s|ed)?|reject(?:s|ed)?|validat\w*|ensure\w*|fail[- ]closed)\b", re.I)
DOC_SKIP_RE = re.compile(r"^(CONTRIBUTING|CODE_OF_CONDUCT|AUTHORS|LICENSE|LICENCE|INSTALL|MANIFEST|NOTICE)(\.|$)", re.I)
MODAL_RE = re.compile(r"\b(must not|must never|must|never|always|only|shall not|shall|cannot|can not|may not|is not allowed|are not allowed|forbidden|required|not permitted)\b", re.I)
RULE_TOKENS = {"never", "no", "not", "cannot", "cant", "only", "must", "always", "forbid", "forbidden", "reject", "rejects", "rejected", "raise", "raises", "throws", "throw", "invalid", "unchanged", "preserve", "preserves", "preserved", "conserve", "conserves", "conserved", "idempotent", "roundtrip", "monotonic", "sum", "sums", "equal", "equals", "within", "bounded", "nonnegative", "positive", "negative", "requires", "required", "refuse", "refuses", "deny", "denies", "before", "after", "until", "expires", "expired", "without", "exactly", "once", "empty", "zero", "limit", "warns", "warn"}
FROZEN_NAME_RE = re.compile(r"(legacy|deprecated|obsolete|old|compat|v1)", re.I)
SETUP_NAMES = {"setup_class", "setup_method", "setup", "setUp", "setUpClass", "teardown_class", "teardown_method", "teardown", "tearDown", "tearDownClass", "setup_function", "teardown_function"}
CHANGELOG_RE = re.compile(r"\b(deprecat\w*|removed|remove|breaking|no longer|renamed|dropped|drop support|must now|is now required)\b", re.I)
ADR_FIELD_RE = re.compile(r"^\*{0,2}(Status|Date|Supersedes|Superseded-by|Deciders|Owner)\*{0,2}\s*:\s*\*{0,2}(.+?)\*{0,2}\s*$", re.I)
MD_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
RST_UNDERLINE_RE = re.compile(r"^([=\-~^\"'`:#*+_.])\1{2,}\s*$")
# `it("title", …)`, `test('title', …)`, with .only/.skip/.each/.concurrent modifiers; the title must be a plain string.
TS_TEST_RE = re.compile(r"^(?P<indent>[ \t]*)(?P<fn>it|test)(?:\.(?:only|skip|concurrent|todo|fails))*\s*\(\s*(?P<q>['\"`])(?P<title>(?:(?!(?P=q)).)+)(?P=q)", re.M)
TS_DESCRIBE_RE = re.compile(r"^(?P<indent>[ \t]*)describe(?:\.(?:only|skip|concurrent))*\s*\(\s*(?P<q>['\"`])(?P<title>(?:(?!(?P=q)).)+)(?P=q)", re.M)
TS_IMPORT_RE = re.compile(r"""(?:^|\n)[ \t]*(?:import\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+)(['"])(?P<spec>[^'"]+)\1""")
TS_REQUIRE_RE = re.compile(r"""require\(\s*(['"])(?P<spec>[^'"]+)\1\s*\)""")
TS_SPEC_RE = re.compile(r"""(?P<prefix>\b(?:from|import)\s*\(?\s*)(?P<q>['"])(?P<spec>[^'"]+)(?P=q)""")


def run_git(repo: str, *args: str) -> str:
    res = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)
    return res.stdout if res.returncode == 0 else ""


def read_text(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except (OSError, UnicodeDecodeError):
        return None


def language_of(path: str) -> str | None:
    if path.endswith(PY_EXT):
        return "python"
    if path.endswith(TS_EXT) and not path.endswith(".d.ts"):
        return "typescript"
    return None


def module_name_for(path: str) -> str:
    """Python: dotted module name (`src/` of a src layout is not part of it). TypeScript: the path without extension."""
    if language_of(path) == "typescript":
        return re.sub(r"\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$", "", path)
    rel = path[:-3] if path.endswith(".py") else path
    parts = rel.split("/")
    if len(parts) > 1 and parts[0] == "src":
        parts = parts[1:]
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def is_test_path(path: str) -> bool:
    base = os.path.basename(path)
    if base.startswith("test_") or base.endswith("_test.py") or base == "conftest.py":
        return True
    if re.search(r"\.(test|spec)\.[cm]?[jt]sx?$", base):
        return True
    return any(p in TEST_DIR_NAMES for p in path.split("/")[:-1])


def tracked_files(repo: str) -> list[str]:
    return [f for f in run_git(repo, "ls-files", "-z").split("\0") if f]


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "candidate"


def node_source(source: str, node: ast.AST) -> str:
    """Full source lines of a node including its decorators, dedented to column 0 (keeps relative indentation)."""
    lines = source.splitlines()
    start = min([getattr(node, "lineno", 1), *[d.lineno for d in getattr(node, "decorator_list", [])]])
    end = getattr(node, "end_lineno", start) or start
    return textwrap.dedent("\n".join(lines[start - 1 : end]))


def sentences(text: str) -> list[str]:
    cleaned = " ".join(text.split())
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", cleaned) if s.strip()]


def md_sections(text: str) -> list[tuple[str, int, str]]:
    """(heading, start line, body) for Markdown; the preamble before the first heading has heading ''."""
    out: list[tuple[str, int, str]] = []
    heading, start, buf = "", 1, []
    for i, line in enumerate(text.splitlines(), 1):
        m = MD_HEADING_RE.match(line)
        if m:
            out.append((heading, start, "\n".join(buf)))
            heading, start, buf = m.group(2).strip(), i, []
        else:
            buf.append(line)
    out.append((heading, start, "\n".join(buf)))
    return out


def rst_sections(text: str) -> list[tuple[str, int, str]]:
    lines = text.splitlines()
    out: list[tuple[str, int, str]] = []
    heading, start, buf = "", 1, []
    i = 0
    while i < len(lines):
        line = lines[i]
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if line.strip() and RST_UNDERLINE_RE.match(nxt) and len(nxt.strip()) >= len(line.strip()):
            out.append((heading, start, "\n".join(buf)))
            heading, start, buf = line.strip(), i + 1, []
            i += 2
            continue
        buf.append(line)
        i += 1
    out.append((heading, start, "\n".join(buf)))
    return out


class Repo:
    """What both modes need from the repository: the tracked files, parsed sources, imports, test lookups and lifting."""

    def __init__(self, repo: str) -> None:
        self.repo = os.path.abspath(repo)
        self.files = tracked_files(self.repo)
        self.py_files = [f for f in self.files if language_of(f) == "python"]
        self.ts_files = [f for f in self.files if language_of(f) == "typescript"]
        self.internal = {module_name_for(f) for f in self.py_files}
        self.ts_modules = {module_name_for(f): f for f in self.ts_files}
        self.ts_aliases = self._ts_path_aliases()
        self._trees: dict[str, ast.AST] = {}
        self._sources: dict[str, str] = {}
        self.top_dirs = sorted({f.split("/")[0] for f in self.files if "/" in f})

    @property
    def language(self) -> str:
        py, ts = len([f for f in self.py_files if not is_test_path(f)]), len([f for f in self.ts_files if not is_test_path(f)])
        if py and ts:
            return "mixed"
        return "typescript" if ts else "python"

    # ---------- sources
    def source(self, rel: str) -> str | None:
        if rel in self._sources:
            return self._sources[rel]
        src = read_text(os.path.join(self.repo, rel))
        if src is not None:
            self._sources[rel] = src
        return src

    def tree(self, rel: str) -> ast.AST | None:
        if rel in self._trees:
            return self._trees[rel]
        src = self.source(rel)
        if src is None or not rel.endswith(".py"):
            return None
        try:
            tree = ast.parse(src, filename=rel)
        except SyntaxError:
            return None
        self._trees[rel] = tree
        return tree

    # ---------- imports
    def _is_internal(self, target: str) -> bool:
        if target in self.internal:
            return True
        parts = target.split(".")
        return any(".".join(parts[:i]) in self.internal for i in range(1, len(parts)))

    def path_for_module(self, module: str) -> str | None:
        for f in self.py_files:
            if module_name_for(f) == module:
                return f
        return None

    def py_imports(self, rel: str) -> list[tuple[str, int]]:
        """Internal modules a Python file imports at module level, with the line."""
        tree = self.tree(rel)
        if tree is None:
            return []
        module = module_name_for(rel)
        out: list[tuple[str, int]] = []
        for node in getattr(tree, "body", []):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if self._is_internal(alias.name):
                        out.append((alias.name, node.lineno))
            elif isinstance(node, ast.ImportFrom):
                target = node.module or ""
                if node.level:
                    base_parts = module.split(".")
                    if not rel.endswith("__init__.py"):
                        base_parts = base_parts[:-1]
                    base_parts = base_parts[: len(base_parts) - (node.level - 1)] if node.level > 1 else base_parts
                    target = ".".join([*base_parts, target]) if target else ".".join(base_parts)
                if self._is_internal(target):
                    out.append((target, node.lineno))
                for alias in node.names:
                    candidate = f"{target}.{alias.name}" if target else alias.name
                    if candidate in self.internal:
                        out.append((candidate, node.lineno))
        return out

    def _ts_path_aliases(self) -> list[tuple[str, str]]:
        """(prefix, repository directory) pairs from tsconfig.json `compilerOptions.paths` entries of the form `@x/*: [dir/*]`."""
        out: list[tuple[str, str]] = []
        if "tsconfig.json" not in self.files:
            return out
        text = read_text(os.path.join(self.repo, "tsconfig.json"))
        if not text:
            return out
        # tsconfig allows comments and trailing commas; strip the common forms before parsing
        cleaned = re.sub(r"//[^\n]*|/\*.*?\*/", "", text, flags=re.S)
        cleaned = re.sub(r",(\s*[}\]])", r"\1", cleaned)
        try:
            cfg = json.loads(cleaned)
        except json.JSONDecodeError:
            return out
        opts = cfg.get("compilerOptions") or {}
        base_url = str(opts.get("baseUrl") or ".").strip("./") or "."
        for key, targets in (opts.get("paths") or {}).items():
            if not isinstance(targets, list) or not targets or not str(key).endswith("/*"):
                continue
            target = str(targets[0])
            if not target.endswith("/*"):
                continue
            directory = os.path.normpath(os.path.join(base_url if base_url != "." else "", target[:-2])).replace(os.sep, "/")
            out.append((str(key)[:-1], directory.strip("/")))
        return out

    def resolve_ts(self, rel: str, spec: str) -> str | None:
        """Repository path a TypeScript import specifier points at, or None for packages and unknown aliases."""
        if spec.startswith("."):
            base = os.path.normpath(os.path.join(os.path.dirname(rel), spec)).replace(os.sep, "/")
        else:
            alias = next(((prefix, directory) for prefix, directory in self.ts_aliases if spec.startswith(prefix)), None)
            if alias is None:
                return None
            base = os.path.normpath(os.path.join(alias[1], spec[len(alias[0]):])).replace(os.sep, "/")
        if base in self.files and language_of(base):
            return base
        stripped = re.sub(r"\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$", "", base)
        if stripped in self.ts_modules:
            return self.ts_modules[stripped]
        tracked = set(self.files)
        for ext in TS_RESOLVE_EXT:
            idx = f"{stripped}/index{ext}"
            if idx in tracked:
                return idx
        return None

    def ts_imports(self, rel: str) -> list[tuple[str, int, str]]:
        """(resolved path or None, line, specifier) for every import/export-from/require in a TypeScript file."""
        src = self.source(rel)
        if src is None:
            return []
        out: list[tuple[str, int, str]] = []
        for m in TS_SPEC_RE.finditer(src):
            spec = m.group("spec")
            line = src.count("\n", 0, m.start()) + 1
            out.append((self.resolve_ts(rel, spec), line, spec))
        for m in TS_REQUIRE_RE.finditer(src):
            spec = m.group("spec")
            line = src.count("\n", 0, m.start()) + 1
            out.append((self.resolve_ts(rel, spec), line, spec))
        return out

    def source_imports(self, rel: str) -> list[tuple[str, int]]:
        """Internal source paths a file depends on (module-level), language-independent: [(path, line)]."""
        if language_of(rel) == "python":
            out: list[tuple[str, int]] = []
            for target, line in self.py_imports(rel):
                p = self.path_for_module(target) or self.path_for_module(target + ".__init__")
                if p:
                    out.append((p, line))
            return out
        return [(p, line) for p, line, _ in self.ts_imports(rel) if p]

    def paths_for_modules(self, modules: list[str]) -> list[str]:
        """Repository paths (or `dir/**` for packages) for internal Python modules, most specific first, without duplicates."""
        out: list[str] = []
        for m in modules:
            path = self.path_for_module(m)
            if not path:
                continue
            entry = f"{os.path.dirname(path)}/**" if path.endswith("__init__.py") else path
            if entry not in out:
                out.append(entry)
        specific = [p for p in out if not p.endswith("/**")]
        packages = [p for p in out if p.endswith("/**") and not any(sp.startswith(p[:-3] + "/") for sp in specific)]
        return [*specific, *packages]

    def production_paths_for_test(self, rel: str) -> list[str]:
        """Production files a test file imports (the code a rule proven by that test governs)."""
        if language_of(rel) == "python":
            paths = self.paths_for_modules([m for m, _ in self.py_imports(rel)])
        else:
            paths = list(dict.fromkeys(p for p, _, _ in self.ts_imports(rel) if p))
        return [p for p in paths if not is_test_path(p.replace("/**", ""))][:6]

    def scope_tags(self, paths: list[str]) -> list[str]:
        """Tags from the directory a path lives in and its module name (globs like `pkg/**` contribute their directory)."""
        tags: list[str] = []
        for p in paths:
            clean = p.replace("/**", "")
            parts = [x for x in clean.split("/")[:-1] if x not in ("src", "app", "lib") and x not in TEST_DIR_NAMES]
            base = os.path.basename(clean)
            base = re.sub(r"\.(py|ts|tsx|js|jsx|mts|cts|mjs|cjs)$", "", base)
            if language_of(p) is None:
                parts, base = [*parts, base], ""
            for t in [*parts[-1:], base]:
                t = t.lower()
                if t and t not in ("__init__", "index") and t not in tags:
                    tags.append(t)
        return tags[:4]

    def current_paths(self, paths: list[str]) -> tuple[list[str], list[str]]:
        """Map historical paths to HEAD: keep existing ones, resolve moved files by unique basename, report the rest."""
        kept: list[str] = []
        lost: list[str] = []
        tracked = set(self.files)
        by_base: dict[str, list[str]] = defaultdict(list)
        for f in [*self.py_files, *self.ts_files]:
            by_base[os.path.basename(f)].append(f)
        for p in paths:
            if p in tracked:
                kept.append(p)
                continue
            same = by_base.get(os.path.basename(p), [])
            if len(same) == 1:
                kept.append(same[0])
            else:
                lost.append(p)
        return kept, lost

    def layer_of(self, rel: str) -> str | None:
        """The directory a module lives in; top-level scripts (no directory) are not a layer."""
        d = os.path.dirname(rel)
        return d or None

    # ---------- Python tests and lifting
    def _is_fixture(self, node: ast.AST) -> bool:
        for d in getattr(node, "decorator_list", []):
            target = d.func if isinstance(d, ast.Call) else d
            name = target.attr if isinstance(target, ast.Attribute) else target.id if isinstance(target, ast.Name) else ""
            if name == "fixture":
                return True
        return False

    def _fixture_sources(self, rel: str) -> dict[str, tuple[str, str]]:
        """{fixture name: (source, defining file)} from the test file and the conftest.py files above it."""
        out: dict[str, tuple[str, str]] = {}
        candidates = [rel]
        d = os.path.dirname(rel)
        while True:
            candidates.append(f"{d}/conftest.py" if d else "conftest.py")
            if not d:
                break
            d = os.path.dirname(d)
        for f in candidates:
            if f not in self.files:
                continue
            tree = self.tree(f)
            if tree is None:
                continue
            src = self._sources[f]
            for n in getattr(tree, "body", []):
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and self._is_fixture(n) and n.name not in out:
                    out[n.name] = (node_source(src, n), f)
        return out

    def draft_py_hidden_test(self, rel: str, node: ast.FunctionDef | ast.AsyncFunctionDef, cls: ast.ClassDef | None) -> dict[str, Any]:
        """A hidden-test draft that can run on its own: imports, used constants, fixtures, class setup and the test."""
        tree = self.tree(rel)
        source = self._sources[rel]
        notes: list[str] = []
        body = getattr(tree, "body", [])
        import_lines = [ast.get_source_segment(source, n) or "" for n in body if isinstance(n, (ast.Import, ast.ImportFrom))]
        fixtures = self._fixture_sources(rel)
        pieces: list[str] = []
        included_fixture_files: set[str] = set()

        def needed_fixtures(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
            return [a.arg for a in [*fn.args.posonlyargs, *fn.args.args, *fn.args.kwonlyargs] if a.arg not in ("self", "cls")]

        resolved: dict[str, str] = {}
        queue = needed_fixtures(node)
        while queue:
            name = queue.pop(0)
            if name in resolved:
                continue
            if name in fixtures:
                src, where = fixtures[name]
                resolved[name] = src
                included_fixture_files.add(where)
                try:
                    fn = ast.parse(src).body[0]
                    if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        queue.extend(needed_fixtures(fn))
                except SyntaxError:
                    pass
            elif name in ("request", "tmp_path", "tmp_path_factory", "monkeypatch", "capsys", "caplog", "recwarn"):
                continue  # pytest built-ins
            else:
                notes.append(f"fixture `{name}` is not defined in {rel} or a conftest.py above it; define it in the draft")
        for name, src in resolved.items():
            pieces.append(src)
        for f in sorted(included_fixture_files - {rel}):
            ftree = self.tree(f)
            if ftree is not None:
                import_lines.extend(ast.get_source_segment(self._sources[f], n) or "" for n in getattr(ftree, "body", []) if isinstance(n, (ast.Import, ast.ImportFrom)))
        if cls is not None:
            members = [m for m in cls.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and (m.name in SETUP_NAMES or m is node)]
            header = f"class {cls.name}({', '.join(ast.unparse(b) for b in cls.bases)}):" if cls.bases else f"class {cls.name}:"
            class_lines = [header]
            for m in members:
                class_lines.append(textwrap.indent(node_source(source, m), "    "))
                class_lines.append("")
            pieces.append("\n".join(class_lines).rstrip())
            if not any(m.name in SETUP_NAMES for m in members) and any(isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name) and sub.value.id == "self" for sub in ast.walk(node)):
                notes.append(f"{cls.name} has no setup method in this file; `self.*` attributes used by the test must be defined in the draft")
        else:
            pieces.append(node_source(source, node))
        combined = "\n\n".join(pieces)
        constants = [n for n in body if isinstance(n, ast.Assign) and all(isinstance(t, ast.Name) for t in n.targets)]
        const_lines = [ast.get_source_segment(source, n) or "" for n in constants if any(re.search(rf"\b{re.escape(t.id)}\b", combined) for t in n.targets if isinstance(t, ast.Name))]
        uniq = list(dict.fromkeys(line for line in import_lines if line))
        imports = "\n".join([l for l in uniq if l.startswith("from __future__")] + [l for l in uniq if not l.startswith("from __future__")])
        draft = "\n\n".join(x for x in [imports, "\n".join(const_lines), combined] if x.strip())
        return {"from": f"{rel}::{node.name}", "language": "python", "imports": imports, "source": draft, "notes": notes, "standalone": not notes}

    def py_tests(self, rel: str) -> list[tuple[ast.FunctionDef | ast.AsyncFunctionDef, ast.ClassDef | None]]:
        tree = self.tree(rel)
        if tree is None:
            return []
        owners: list[tuple[ast.FunctionDef | ast.AsyncFunctionDef, ast.ClassDef | None]] = []
        for n in getattr(tree, "body", []):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith("test"):
                owners.append((n, None))
            elif isinstance(n, ast.ClassDef):
                owners.extend((m, n) for m in n.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and m.name.startswith("test"))
        return owners

    # ---------- TypeScript tests and lifting
    def ts_tests(self, rel: str) -> list[dict[str, Any]]:
        """`it`/`test` blocks of a vitest/jest file: title, line, enclosing describe titles, first expect line."""
        src = self.source(rel)
        if src is None:
            return []
        lines = src.splitlines()
        describe_lines = {src.count("\n", 0, m.start()) + 1: (len(m.group("indent")), m.group("title")) for m in TS_DESCRIBE_RE.finditer(src)}
        out: list[dict[str, Any]] = []
        for m in TS_TEST_RE.finditer(src):
            if "${" in m.group("title"):
                continue  # a template title with an expression: the runner names the test by its evaluated value, which we cannot know
            line = src.count("\n", 0, m.start()) + 1
            indent = len(m.group("indent"))
            # enclosing describes: those indented less and seen before this line, keeping the latest one per indentation level
            by_indent: dict[int, str] = {}
            for l, (ind, t) in sorted(describe_lines.items()):
                if l < line and ind < indent:
                    for k in [k for k in by_indent if k > ind]:
                        del by_indent[k]
                    by_indent[ind] = t
            chain = [by_indent[k] for k in sorted(by_indent)]
            expect = next((lines[i].strip() for i in range(line, min(len(lines), line + 40)) if "expect(" in lines[i] or "assert" in lines[i]), "")
            out.append({"name": m.group("title"), "line": line, "describe": chain, "excerpt": expect[:200], "fn": m.group("fn")})
        return out

    def rewrite_ts_imports(self, source: str, origin_dir: str, hidden_dir: str = ".intentos_hidden/invariants") -> str:
        """Point relative specifiers of a test module at the same files from `hidden_dir` (where hidden tests run)."""

        def fix(m: re.Match[str]) -> str:
            spec = m.group("spec")
            if not spec.startswith("."):
                return m.group(0)
            target = os.path.normpath(os.path.join(origin_dir, spec)).replace(os.sep, "/")
            new = os.path.relpath(target, hidden_dir).replace(os.sep, "/")
            if not new.startswith("."):
                new = "./" + new
            return f"{m.group('prefix')}{m.group('q')}{new}{m.group('q')}"

        return TS_SPEC_RE.sub(fix, source)

    def normalize_written_ts_imports(self, source: str) -> str:
        """A written test may import `src/x` or `./src/x` meaning repository-root-relative: make it relative to the hidden directory."""
        prefix = "../" * HIDDEN_DEPTH
        tops = set(self.top_dirs)
        top_files = {re.sub(r"\.[cm]?[jt]sx?$", "", f) for f in self.files if "/" not in f}

        def fix(m: re.Match[str]) -> str:
            spec = m.group("spec")
            if spec.startswith("../"):
                return m.group(0)
            rest = spec[2:] if spec.startswith("./") else spec
            head = rest.split("/")[0]
            if head in tops or re.sub(r"\.[cm]?[jt]sx?$", "", rest) in top_files:
                return f"{m.group('prefix')}{m.group('q')}{prefix}{rest}{m.group('q')}"
            return m.group(0)

        return TS_SPEC_RE.sub(fix, source)

    def draft_ts_hidden_test(self, rel: str, test: dict[str, Any]) -> dict[str, Any]:
        """The test file copied with its relative imports re-pointed and the chosen test marked `.only`.

        The verifier runs hidden tests through a wrapper vitest config with `allowOnly: true`, so the marker narrows the
        file to the one test the invariant is bound to even when CI would otherwise refuse `.only`.
        """
        src = self.source(rel) or ""
        lines = src.splitlines()
        idx = test["line"] - 1
        lines[idx] = re.sub(r"^(\s*)(it|test)\b((?:\.(?:only|skip|concurrent|todo|fails))*)", lambda m: f"{m.group(1)}{m.group(2)}.only", lines[idx], count=1)
        body = self.rewrite_ts_imports("\n".join(lines) + "\n", os.path.dirname(rel))
        notes = ["whole test file copied; the bound test is marked .only (the verifier's vitest config allows it)"]
        return {"from": f"{rel}::{test['name']}", "language": "typescript", "imports": "", "source": body, "notes": notes, "standalone": True, "lift": "file_copy_only"}

    # ---------- policy blocks
    def policy_block(self, c: dict[str, Any], policy_id: str) -> dict[str, Any]:
        slug = slugify(c["title"])
        if c["kind"] == "invariant":
            src = c.get("sources") or [{"path": "docs/intentos-policy.md", "heading": c["title"]}]
            draft = c.get("suggested_hidden_test")
            ts = bool(draft and draft.get("language") == "typescript")
            test_file = f"inv_TODO_{slug.replace('-', '_')}.test.ts" if ts else f"test_inv_TODO_{slug.replace('-', '_')}.py"
            return {"id": "INV-TODO", "statement": c["statement"], "scope": c.get("scope", []), "applies_to_paths": c.get("applies_to_paths", []), "authority": "approved_policy", "approved_by": "TODO", "sources": src, "verified_by": [f"benchmarks/hidden_tests/{policy_id}/invariants/{test_file}"] if draft else [], "enforcement": "blocking"}
        if c["kind"] in ("architecture_rule", "frozen_paths"):
            rule = c.get("rule") or {"kind": "forbidden_import", "paths": c.get("applies_to_paths", []), "forbidden_modules": []}
            block = {"id": "ARCH-TODO", "kind": rule["kind"], "statement": c["statement"], "paths": rule.get("paths", []), "authority": "approved_policy", "approved_by": "TODO", "sources": c.get("sources") or [{"path": "docs/intentos-policy.md", "heading": c["title"]}], "enforcement": "blocking", "scope": c.get("scope", [])}
            if rule.get("forbidden_modules"):
                block["forbidden_modules"] = rule["forbidden_modules"]
            return block
        block = {"id": "DEC-TODO", "statement": c["statement"], "status": c.get("status", "proposed"), "scope": c.get("scope", []), "sources": c.get("sources", [])}
        if c.get("supersedes"):
            block["supersedes"] = c["supersedes"]
        return block


# ---------------------------------------------------------------------------------------------------------------------
# The evidence digest


class Digest:
    def __init__(self, repo: str, max_commits: int = 300) -> None:
        self.r = Repo(repo)
        self.max_commits = max_commits
        self.warnings: list[str] = []

    def tests(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for rel in [*self.r.py_files, *self.r.ts_files]:
            if not is_test_path(rel) or os.path.basename(rel) == "conftest.py":
                continue
            production = self.r.production_paths_for_test(rel)
            if language_of(rel) == "python":
                src = self.r.source(rel) or ""
                for node, cls in self.r.py_tests(rel):
                    segment = (ast.get_source_segment(src, node) or "").split("\n")
                    first_assert = next((l.strip() for l in segment if re.match(r"\s*(assert\b|with pytest\.raises|pytest\.raises|self\.assert)", l)), "")
                    tokens = set(node.name.lower().split("_"))
                    out.append({"ref": f"{rel}::{(cls.name + '::') if cls else ''}{node.name}", "path": rel, "line": node.lineno, "name": node.name, "language": "python", "excerpt": first_assert[:200], "rule_like": bool(tokens & RULE_TOKENS), "production_paths": production})
            else:
                for t in self.r.ts_tests(rel):
                    words = set(re.findall(r"[a-z]+", t["name"].lower()))
                    out.append({"ref": f"{rel}::{t['name']}", "path": rel, "line": t["line"], "name": t["name"], "language": "typescript", "describe": t["describe"], "excerpt": t["excerpt"], "rule_like": bool(words & RULE_TOKENS), "production_paths": production})
        return out[:600]

    def commits(self) -> list[dict[str, Any]]:
        raw = run_git(self.r.repo, "log", "--no-merges", f"-n{self.max_commits}", "--date=short", "--format=%H%x1f%ad%x1f%s%x1f%b%x1e")
        if not raw.strip():
            self.warnings.append("no git history available for commit evidence")
            return []
        out: list[dict[str, Any]] = []
        for record in raw.split("\x1e"):
            record = record.strip("\n")
            if not record:
                continue
            sha, date, subject, body = (record.split("\x1f") + ["", "", "", ""])[:4]
            files = [f for f in run_git(self.r.repo, "show", "--name-only", "--format=", sha).split("\n") if f.strip()]
            source_files = [f for f in files if language_of(f) and not is_test_path(f)]
            test_files = [f for f in files if language_of(f) and is_test_path(f)]
            if not source_files and not test_files:
                continue  # docs, packaging, CI: no behaviour in there
            tests_added: list[str] = []
            if test_files:
                diff = run_git(self.r.repo, "show", "--format=", "--unified=0", sha, "--", *test_files)
                tests_added = [m.group(1) for m in re.finditer(r"^\+\s*(?:async\s+)?def\s+(test_\w+)", diff, re.M)]
                tests_added += [m.group("title") for m in re.finditer(r"^\+\s*(?:it|test)(?:\.\w+)*\s*\(\s*(?P<q>['\"`])(?P<title>(?:(?!(?P=q)).)+)(?P=q)", diff, re.M)]
            text = f"{subject}\n{body}"
            out.append({"sha": sha[:10], "date": date, "subject": subject.strip()[:200], "body": " ".join(body.split())[:300], "source_files": source_files[:10], "test_files": test_files[:6], "tests_added": tests_added[:8], "looks_like_fix": bool(FIX_START_RE.search(subject) or FIX_RE.search(text))})
        return out

    def documents(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        statements: list[dict[str, Any]] = []
        adrs: list[dict[str, Any]] = []
        docs = [f for f in self.r.files if f.lower().endswith((".md", ".rst")) and not any(part in SKIP_DIRS for part in f.split("/")) and not DOC_SKIP_RE.match(os.path.basename(f))]
        for rel in docs:
            text = read_text(os.path.join(self.r.repo, rel))
            if text is None:
                continue
            is_md = rel.lower().endswith(".md")
            fields: dict[str, str] = {}
            for line in text.splitlines()[:40]:
                m = ADR_FIELD_RE.match(line.strip())
                if m:
                    fields[m.group(1).lower()] = m.group(2).strip()
            sections = md_sections(text) if is_md else rst_sections(text)
            title = next((h for h, _, _ in sections if h), os.path.basename(rel))
            if "status" in fields:
                status_raw = fields["status"].lower()
                status = "superseded" if "supersed" in status_raw else "approved" if ("accept" in status_raw or "approved" in status_raw) else "rejected" if "reject" in status_raw else "proposed"
                decision_body = next((body for h, _, body in sections if h.lower().startswith("decision")), "")
                adrs.append({"path": rel, "title": title, "status": status, "status_raw": fields["status"], "decision": " ".join(sentences(decision_body)[:2])[:400], "supersedes": fields.get("supersedes")})
            base = os.path.basename(rel).lower()
            if base.startswith(("changelog", "changes", "history")):
                continue  # see changelog()
            for heading, start, body in sections:
                if not body.strip() or heading.lower().startswith(("context", "consequences", "status")):
                    continue
                for sent in sentences(body):
                    if MODAL_RE.search(sent) and len(sent) >= 25 and not sent.startswith(("- [", "|")):
                        statements.append({"path": rel, "heading": heading or None, "line": start, "sentence": sent[:300], "format": "markdown" if is_md else "rst"})
        return statements[:400], adrs

    def structure(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Import edges between source directories, and directories that look frozen."""
        layers: dict[str, list[str]] = defaultdict(list)
        for rel in [*self.r.py_files, *self.r.ts_files]:
            if is_test_path(rel):
                continue
            layer = self.r.layer_of(rel)
            if layer:
                layers[layer].append(rel)
        edges: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for layer, files in layers.items():
            for rel in files:
                for target, line in self.r.source_imports(rel):
                    tlayer = self.r.layer_of(target)
                    if tlayer and tlayer != layer:
                        edges[(layer, tlayer)].append({"path": rel, "line": line, "imports": target})
        edge_rows = []
        for (a, b), ev in sorted(edges.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            edge_rows.append({"from_dir": a, "to_dir": b, "count": len(ev), "reverse_exists": (b, a) in edges, "examples": ev[:3]})
        last_repo = run_git(self.r.repo, "log", "-1", "--format=%ad", "--date=short").strip()
        stale: list[dict[str, Any]] = []
        for layer in sorted(layers):
            name = os.path.basename(layer)
            by_name = bool(FROZEN_NAME_RE.search(name))
            last = run_git(self.r.repo, "log", "-1", "--format=%ad", "--date=short", "--", layer).strip()
            years = int(last_repo[:4]) - int(last[:4]) if (last[:4].isdigit() and last_repo[:4].isdigit()) else 0
            if by_name or years >= 1:
                stale.append({"dir": layer, "files": len(layers[layer]), "last_commit": last or None, "repo_last_commit": last_repo or None, "name_suggests_legacy": by_name})
        return edge_rows[:60], stale

    def changelog(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for rel in self.r.files:
            base = os.path.basename(rel).lower()
            if not base.startswith(("changelog", "changes", "history")) or not base.endswith((".md", ".rst", ".txt")):
                continue
            text = read_text(os.path.join(self.r.repo, rel))
            if text is None:
                continue
            version = ""
            for i, line in enumerate(text.splitlines(), 1):
                m = MD_HEADING_RE.match(line)
                if m or re.match(r"^v?\d+\.\d+", line.strip()):
                    version = (m.group(2) if m else line).strip()
                    continue
                if CHANGELOG_RE.search(line) and len(line.strip()) > 15:
                    out.append({"path": rel, "line": i, "version": version or None, "text": line.strip().lstrip("-* ")[:300]})
        return out[:200]

    def run(self, policy_id: str) -> dict[str, Any]:
        tests = self.tests()
        commits = self.commits()
        statements, adrs = self.documents()
        edges, stale = self.structure()
        changelog = self.changelog()
        head = run_git(self.r.repo, "rev-parse", "HEAD").strip()
        return {
            "repo": self.r.repo,
            "head": head,
            "policy_id": policy_id,
            "language": self.r.language,
            "source_dirs": sorted({self.r.layer_of(f) for f in [*self.r.py_files, *self.r.ts_files] if not is_test_path(f) and self.r.layer_of(f)}),
            "tests": tests,
            "commits": commits,
            "documents": statements,
            "adrs": adrs,
            "imports": edges,
            "stale_dirs": stale,
            "changelog": changelog,
            "counts": {"tests": len(tests), "rule_like_tests": sum(1 for t in tests if t["rule_like"]), "commits": len(commits), "fix_commits": sum(1 for c in commits if c["looks_like_fix"]), "documents": len(statements), "adrs": len(adrs), "imports": len(edges), "stale_dirs": len(stale), "changelog": len(changelog)},
            "warnings": self.warnings,
        }


# ---------------------------------------------------------------------------------------------------------------------
# Ingestion of model-authored candidates

EVIDENCE_TYPES = ("test", "commit", "doc", "adr", "changelog", "import", "history")
CANDIDATE_KINDS = ("invariant", "architecture_rule", "frozen_paths", "decision")
CATEGORIES = ("business_rule", "robustness_rule")
LEVELS = ("high", "medium", "low")


class Ingestor:
    def __init__(self, repo: str) -> None:
        self.r = Repo(repo)
        self.tracked = set(self.r.files)

    def path_ok(self, p: str) -> bool:
        if p.endswith("/**"):
            prefix = p[:-3].rstrip("/") + "/"
            return any(f.startswith(prefix) for f in self.tracked)
        return p in self.tracked or any(fnmatch.fnmatch(f, p) for f in self.tracked)

    def find_test(self, ref: str) -> tuple[dict[str, Any] | None, str | None, Any]:
        """(hidden-test draft, error, located node) for `path::test`, `path::Class::test` (pytest) or `path::title` (vitest/jest)."""
        parts = ref.split("::")
        rel, names = parts[0], parts[1:]
        if not names:
            return None, f"test reference {ref!r} must be path::test_name (pytest), path::Class::test_name, or path::\"test title\" (vitest/jest)", None
        if rel not in self.tracked:
            return None, f"{rel} is not a tracked file in this repository", None
        lang = language_of(rel)
        if lang == "typescript":
            title = "::".join(names)
            hit = next((t for t in self.r.ts_tests(rel) if t["name"] == title), None)
            if hit is None:
                return None, f"no it()/test() titled {title!r} in {rel}", None
            return self.r.draft_ts_hidden_test(rel, hit), None, hit
        if len(names) > 2:
            return None, f"test reference {ref!r} must be path::test_name or path::Class::test_name", None
        tree = self.r.tree(rel)
        if tree is None:
            return None, f"{rel} is not a Python file in the repository", None
        cls = None
        if len(names) == 2:
            cls = next((n for n in getattr(tree, "body", []) if isinstance(n, ast.ClassDef) and n.name == names[0]), None)
            if cls is None:
                return None, f"class {names[0]} not found in {rel}", None
            node = next((n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == names[1]), None)
        else:
            node = next((n for n in getattr(tree, "body", []) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == names[0]), None)
        if node is None:
            return None, f"test {names[-1]} not found in {rel}", None
        return self.r.draft_py_hidden_test(rel, node, cls), None, node

    def check_evidence(self, e: dict[str, Any]) -> str | None:
        t, ref, excerpt = e.get("type"), str(e.get("ref", "")).strip(), str(e.get("excerpt", "")).strip()
        if t not in EVIDENCE_TYPES:
            return f"evidence type {t!r} must be one of {', '.join(EVIDENCE_TYPES)}"
        if not ref:
            return "evidence needs a ref"
        if not excerpt:
            return f"evidence {ref}: quote the source line in excerpt"
        e["ref"], e["excerpt"] = ref, excerpt[:400]
        if t == "commit":
            if not re.fullmatch(r"[0-9a-fA-F]{7,40}", ref):
                return f"commit evidence {ref!r} is not a sha"
            if run_git(self.r.repo, "cat-file", "-t", ref).strip() != "commit":
                return f"commit {ref} is not in this repository"
            return None
        if t == "history":
            return None
        rel, line = ref.split("::")[0], None
        if "::" not in ref and ":" in rel:
            head, _, maybe = rel.rpartition(":")
            if maybe.isdigit():
                rel, line = head, int(maybe)
        if rel not in self.tracked:
            return f"{rel} is not a tracked file in this repository"
        if line is not None and line > len((read_text(os.path.join(self.r.repo, rel)) or "").splitlines()):
            return f"{rel} has no line {line}"
        e.setdefault("path", rel)
        if line is not None:
            e.setdefault("line", line)
        if t == "test" and "::" in ref:
            _, err, node = self.find_test(ref)
            if err:
                return err
            e.setdefault("line", node["line"] if isinstance(node, dict) else node.lineno)
        return None

    def written_test(self, title: str, src: str, reasons: list[str]) -> dict[str, Any] | None:
        """Parse a test the model wrote: a pytest module, or a vitest/jest module (imports made relative to the hidden directory)."""
        src = src.strip()
        is_ts = bool(re.search(r"^\s*(import\s|export\s|const\s|let\s)", src, re.M)) and bool(re.search(r"\b(it|test)\s*\(", src)) and "def test_" not in src
        if is_ts:
            if not re.search(r"\bexpect\s*\(|\bassert", src):
                reasons.append("test.source (vitest/jest) must assert something with expect()")
                return None
            if self.r.ts_files and not self.r.py_files and "def test_" in src:
                reasons.append("this is a TypeScript repository: write the test as a vitest/jest module, not pytest")
                return None
            body = self.r.normalize_written_ts_imports(src) + "\n"
            # relative imports are resolved from the hidden directory (HIDDEN_DEPTH levels below the root): they must exist
            hidden_file = "/".join([".intentos_hidden"] * HIDDEN_DEPTH) + "/written.test.ts"
            missing = sorted({spec for spec in (m.group("spec") for m in TS_SPEC_RE.finditer(body)) if spec.startswith(".") and self.r.resolve_ts(hidden_file, spec) is None})
            if missing:
                reasons.append(f"test.source imports {', '.join(missing)}, which do not resolve to tracked files from .intentos_hidden/<dir>/ (production code is at {'../' * HIDDEN_DEPTH}src/…)")
                return None
            return {"from": f"codex:{slugify(title)}", "language": "typescript", "imports": "", "source": body, "notes": [], "standalone": True, "pending_run": True}
        if "def test_" not in src:
            reasons.append("test.source must define at least one test_ function (pytest) or an it()/test() block (vitest/jest)")
            return None
        if self.r.language == "typescript":
            reasons.append("this is a TypeScript repository: write the test as a vitest/jest module importing the production code relative to the hidden directory (../../src/…), not pytest")
            return None
        try:
            ast.parse(src)
        except SyntaxError as ex:
            reasons.append(f"test.source does not parse: {ex.msg} (line {ex.lineno})")
            return None
        return {"from": f"codex:{slugify(title)}", "language": "python", "imports": "", "source": src + "\n", "notes": [], "standalone": True, "pending_run": True}

    def ingest(self, proposals: list[dict[str, Any]], policy_id: str, start: int = 1) -> dict[str, Any]:
        accepted: list[dict[str, Any]] = []
        rejected: list[dict[str, Any]] = []
        for p in proposals:
            reasons: list[str] = []
            kind = p.get("kind", "invariant")
            title = str(p.get("title", "")).strip()[:120]
            statement = str(p.get("statement", "")).strip()[:400]
            if kind not in CANDIDATE_KINDS:
                reasons.append(f"kind must be one of {', '.join(CANDIDATE_KINDS)}")
            if len(title) < 3:
                reasons.append("title is missing")
            if len(statement) < 10:
                reasons.append("statement is missing or too short")
            evidence = [dict(e) for e in p.get("evidence", []) if isinstance(e, dict)]
            for e in evidence:
                err = self.check_evidence(e)
                if err:
                    reasons.append(err)
            paths = [str(x) for x in p.get("applies_to_paths", []) or []]
            for x in paths:
                if is_test_path(x.replace("/**", "")):
                    reasons.append(f"applies_to_paths {x} is a test path; name the production code the rule governs")
                elif not self.path_ok(x):
                    reasons.append(f"applies_to_paths {x} matches no tracked file")
            draft: dict[str, Any] | None = None
            test = p.get("test") or {}
            if kind == "invariant":
                if isinstance(test, dict) and test.get("existing"):
                    ref = str(test["existing"])
                    draft, err, node = self.find_test(ref)
                    if err:
                        reasons.append(err)
                    elif not any(e.get("type") == "test" and e.get("ref") == ref for e in evidence):
                        rel = ref.split("::")[0]
                        if isinstance(node, dict):
                            evidence.append({"type": "test", "ref": ref, "excerpt": node.get("excerpt") or node["name"], "path": rel, "line": node["line"]})
                        else:
                            evidence.append({"type": "test", "ref": ref, "excerpt": (ast.get_source_segment(self.r._sources[rel], node) or "").split("\n")[0].strip(), "path": rel, "line": node.lineno})
                elif isinstance(test, dict) and isinstance(test.get("source"), str) and test["source"].strip():
                    draft = self.written_test(title, test["source"], reasons)
                else:
                    reasons.append("an invariant needs a test: test.existing (a test in the repository) or test.source (a pytest or vitest/jest module you wrote)")
            if not evidence and not reasons:
                reasons.append("at least one evidence item is required")
            rule = p.get("rule")
            if kind in ("architecture_rule", "frozen_paths"):
                if not isinstance(rule, dict) or not rule.get("paths"):
                    reasons.append("an architecture rule needs rule.paths (globs) and, for forbidden_import, rule.forbidden_modules")
                    rule = None
                else:
                    rule = {"kind": rule.get("kind") or ("forbidden_import" if kind == "architecture_rule" else "frozen_paths"), "paths": [str(x) for x in rule["paths"]]}
                    if p["rule"].get("forbidden_modules"):
                        rule["forbidden_modules"] = [str(x) for x in p["rule"]["forbidden_modules"]]
                    for x in rule["paths"]:
                        if not self.path_ok(x):
                            reasons.append(f"rule path {x} matches no tracked file")
                    if rule["kind"] == "forbidden_import" and not rule.get("forbidden_modules"):
                        reasons.append("forbidden_import needs rule.forbidden_modules")
            else:
                rule = None
            if reasons:
                rejected.append({"title": title or "(untitled)", "reasons": reasons})
                continue
            category = p.get("category") if p.get("category") in CATEGORIES else "business_rule"
            relevance = p.get("relevance") if p.get("relevance") in LEVELS else "medium"
            confidence = p.get("confidence") if p.get("confidence") in LEVELS else "medium"
            c: dict[str, Any] = {
                "id": "",
                "kind": kind,
                "title": title,
                "statement": statement,
                "category": category,
                "rationale": str(p.get("rationale", "")).strip()[:600],
                "confidence": confidence,
                "relevance": relevance,
                "evidence": evidence,
                "applies_to_paths": paths,
                "scope": self.r.scope_tags(paths or list((rule or {}).get("paths", []))),
                "suggested_hidden_test": draft,
                "authored_by": "codex",
                "rank": 0,
            }
            if rule:
                c["rule"] = rule
            sources = [s for s in p.get("sources", []) or [] if isinstance(s, dict) and s.get("path")]
            if sources:
                c["sources"] = [{"path": str(s["path"]), "heading": s.get("heading")} for s in sources]
            if kind == "decision":
                c["status"] = str(p.get("status") or "approved")
                if p.get("supersedes"):
                    c["supersedes"] = str(p["supersedes"])
            accepted.append(c)
        for i, c in enumerate(accepted, start):
            c["id"] = f"CAND-{i:03d}"
            c["rank"] = i - start + 1
            c["policy_block"] = self.r.policy_block(c, policy_id)
        head = run_git(self.r.repo, "rev-parse", "HEAD").strip()
        counts = {k: sum(1 for c in accepted if c["kind"] == k) for k in CANDIDATE_KINDS}
        return {"repo": self.r.repo, "head": head, "policy_id": policy_id, "language": self.r.language, "candidates": accepted, "rejected": rejected, "counts": counts, "warnings": []}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("repo")
    parser.add_argument("--policy-id", default="policy")
    parser.add_argument("--max-commits", type=int, default=300)
    parser.add_argument("--ingest", help="validate model-authored candidates from this JSON file (a list, or {candidates: [...]}) instead of printing the digest")
    parser.add_argument("--start", type=int, default=1, help="with --ingest: first candidate number (appending to an earlier list)")
    args = parser.parse_args(argv)
    if args.ingest:
        with open(args.ingest, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        proposals = loaded["candidates"] if isinstance(loaded, dict) else loaded
        json.dump(Ingestor(args.repo).ingest(list(proposals), args.policy_id, args.start), sys.stdout)
        return 0
    json.dump(Digest(args.repo, args.max_commits).run(args.policy_id), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
