#!/usr/bin/env python3
"""Deterministic policy-candidate miner for `intentos suggest` (read-only, stdlib only, `-I` safe).

Usage: python -I policy_suggest.py <repo> [--max-commits N] [--layout src|flat] -> JSON on stdout

Mines what a repository already says about its own rules and reports CANDIDATES, each tied to the evidence it came
from: commits whose message records a fix or a prohibition, tests whose names read like rules, sentences in
documents with must/never/only, ADR documents, one-directional import relationships between layers, directories
that look frozen, and changelog entries announcing deprecations. Nothing here carries authority: a person reviews,
edits and approves; the output is a draft for `policies/<id>.yaml` and for ADR documents.
"""
from __future__ import annotations

import argparse
import ast
import fnmatch
import json
import os
import re
import math
import subprocess
import sys
import textwrap
from collections import Counter, defaultdict
from typing import Any

SKIP_DIRS = {".git", "__pycache__", ".pytest_cache", ".tox", ".venv", "venv", "node_modules", "build", "dist", ".eggs", ".mypy_cache", ".ruff_cache", ".intentos", ".intentos_hidden", "docs/_build"}
TEST_DIR_NAMES = ("tests", "test", "testing")
# A commit is a rule candidate when its subject starts like a fix/revert, or the message states a prohibition.
FIX_START_RE = re.compile(r"^\s*(?:\[[^\]]*\]\s*)?(fix(?:es)?|bugfix|hotfix|revert(?:s|ed)?)\b", re.I)
FIX_RE = re.compile(r"\bfix(?:es)?\b|\bfixed (?:a|an|the|bug|issue|regression)\b|\b(bug|regression|revert(?:s|ed)?|prevent(?:s|ed)?|forbid(?:s|den)?|never|must|always|only|guard(?:s|ed)?|enforce(?:s|d)?|disallow(?:s|ed)?|reject(?:s|ed)?|fail[- ]closed)\b", re.I)
# Tooling, style, environment and housekeeping commits say nothing about business rules.
NOISE_RE = re.compile(r"\b(typo|typos|lint|linting|linter|format|formatting|style|whitespace|spelling|grammar|wording|readme|docs?|documentation|docstrings?|ci|changelog|version bump|bump version|release|black|isort|flake8|ruff|pylint|mypy|pre-commit|precommit|tox|pytest|coverage|warnings?|deprecat\w*|futurewarning|merge conflicts?|conflicts?|line length|line-length|small issues?|minor|clean ?up|cleaning|refactor\w*|rename|naming|import order|unused imports?|typing|type hints?|packaging|setup\.py|pyproject|requirements|dependenc\w*|compat\w*|python ?3\.\d+|pandas ?\d|numpy ?\d|sphinx|rtd|readthedocs|badge|license|copyright|travis|github actions|workflow|moved?|moving|examples?|version(?: number)?|occurrenc\w*|after merge)\b", re.I)
DOC_SKIP_RE = re.compile(r"^(CONTRIBUTING|CODE_OF_CONDUCT|AUTHORS|LICENSE|LICENCE|INSTALL|MANIFEST|NOTICE)(\.|$)", re.I)
MODAL_RE = re.compile(r"\b(must not|must never|must|never|always|only|shall not|shall|cannot|can not|may not|is not allowed|are not allowed|forbidden|required|not permitted)\b", re.I)
ARCH_HINT_RE = re.compile(r"\b(import|imports|module|modules|layer|layers|package|packages|depend|depends|dependency|dependencies|api layer|domain|service layer)\b|`[a-z_./]+/\*\*`|\b(?:app|src|lib)/[a-z_/]+", re.I)
RULE_TOKENS = {"never", "no", "not", "cannot", "cant", "only", "must", "always", "forbid", "forbidden", "reject", "rejects", "rejected", "raise", "raises", "invalid", "unchanged", "preserve", "preserves", "preserved", "conserve", "conserves", "conserved", "idempotent", "roundtrip", "monotonic", "sum", "sums", "equal", "equals", "within", "bounded", "nonnegative", "positive", "negative", "requires", "required", "refuse", "refuses", "deny", "denies", "before", "after", "until", "expires", "expired", "without", "exactly", "once"}
NEGATION_TOKENS = {"never", "no", "not", "cannot", "cant", "unchanged", "raises", "raise", "rejects", "reject", "refuses", "forbidden", "invalid", "without"}
LAYER_VOCAB = {"api", "apis", "domain", "services", "service", "models", "model", "core", "infra", "infrastructure", "adapters", "adapter", "legacy", "cli", "web", "db", "storage", "repositories", "handlers", "controllers", "views", "use_cases", "usecases", "application", "ports"}
FROZEN_NAME_RE = re.compile(r"(legacy|deprecated|obsolete|old|compat|v1)", re.I)
SETUP_NAMES = {"setup_class", "setup_method", "setup", "setUp", "setUpClass", "teardown_class", "teardown_method", "teardown", "tearDown", "tearDownClass", "setup_function", "teardown_function"}
CHANGELOG_RE = re.compile(r"\b(deprecat\w*|removed|remove|breaking|no longer|renamed|dropped|drop support|must now|is now required)\b", re.I)
# --- ranking vocabulary -------------------------------------------------------------------------------------------
# Words that say nothing about a domain: everyday English plus programming vocabulary.
GENERIC_STOP = set("""a an the and or of to in for on with by from as at is are be been was were this that these those it its into
than then also not no yes if else when while do does did done get set add remove new old true false none null self cls args
kwargs return returns raise raises given should test tests testing case cases default defaults value values param params
parameter parameters argument arguments result results output outputs input inputs object objects type types list dict
tuple string str int float bool number numbers name names key keys item items data read write load save create make build
run call calls called check checks checked use used using function functions method methods class classes module modules
package packages import imports def main init print log logger error errors exception exceptions message messages format
formats option options config configuration setting settings mode modes flag flags start end first last next previous
current all any each every some more most less least other others same different based via without with empty given
correct wrong actually allow allows allowed usage use necessary needed need needs new adr adrs decision decisions policy
policies rule rules business house readme architecture overview summary notes note section sections heading app src lib
service services api domain module layer only without empty warning warnings invalid valid gets get goes given""".split())
# Library, tooling, packaging and file-system vocabulary: a candidate dominated by these is about the environment, not the domain.
INFRA_STOP = set("""pandas numpy pd np dataframe dataframes df series dtype dtypes index indexes column columns csv json yaml toml xml
pip install installed installation setup packaging wheel sdist version versions release releases merge merges merged merging
merger path paths filepath filepaths datapath file files folder folders dir directory directories position positions attribute
attributes label labels script scripts example examples black isort flake8 lint linting mypy pytest tox ci github workflow
deprecated deprecation deprecations futurewarning docstring docstrings typo typos readme docs documentation sphinx rst md
hardcoded hard coded include creation refactor rename renamed moved move cleanup workaround compat compatibility
python3 python requirements dependency dependencies""".split())
# Words that make a statement a property of behaviour (rule shape) versus a description of a mechanism (fix shape).
PROPERTY_WORDS = {"never", "no", "not", "only", "must", "always", "unchanged", "equal", "equals", "sum", "sums", "zero", "within", "bounded", "negative", "positive", "same", "conserve", "conserved", "conserves", "preserve", "preserved", "preserves", "raises", "rejects", "cannot", "exactly", "once", "invalid", "required", "forbidden", "idempotent", "monotonic", "total", "consistent", "valid"}
MECHANISM_WORDS = {"fix", "fixed", "merge", "merger", "correct", "position", "attribute", "label", "path", "filepath", "install", "installed", "rename", "move", "refactor", "workaround", "hardcoded", "replace", "include", "creation", "creating", "issue", "bug", "compat", "update", "updated", "upgrade", "bump"}
PRIOR_BY_SOURCE = {"adr": 0.8, "test": 0.6, "doc": 0.6, "import": 0.5, "history": 0.4, "commit": 0.3, "changelog": 0.3}
RELEVANCE_BANDS = ((0.6, "high"), (0.4, "medium"), (0.0, "low"))

ADR_FIELD_RE = re.compile(r"^\*{0,2}(Status|Date|Supersedes|Superseded-by|Deciders|Owner)\*{0,2}\s*:\s*\*{0,2}(.+?)\*{0,2}\s*$", re.I)
MD_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
RST_UNDERLINE_RE = re.compile(r"^([=\-~^\"'`:#*+_.])\1{2,}\s*$")


def run_git(repo: str, *args: str) -> str:
    res = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)
    return res.stdout if res.returncode == 0 else ""


def read_text(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except (OSError, UnicodeDecodeError):
        return None


def module_name_for(path: str) -> str:
    rel = path[:-3] if path.endswith(".py") else path
    parts = rel.split("/")
    if len(parts) > 1 and parts[0] == "src":
        parts = parts[1:]
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def is_test_path(path: str) -> bool:
    base = os.path.basename(path)
    return base.startswith("test_") or base.endswith("_test.py") or base == "conftest.py" or any(p in TEST_DIR_NAMES for p in path.split("/")[:-1])


def tracked_files(repo: str) -> list[str]:
    return [f for f in run_git(repo, "ls-files", "-z").split("\0") if f]


def humanize(name: str) -> str:
    words = [w for w in name.replace("test_", "", 1).split("_") if w]
    text = " ".join(words)
    return text[:1].upper() + text[1:]


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "candidate"


def split_identifier(name: str) -> list[str]:
    """`add_weekdays2df` -> [add, weekdays, df]; `HeatBuilding` -> [heat, building]."""
    parts = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name).replace("_", " ").split()
    out: list[str] = []
    for part in parts:
        for tok in re.findall(r"[a-zA-Z]{3,}", part):
            out.append(tok.lower())
    return out


def stem(token: str) -> str:
    """Light plural folding so `discounts`/`discount` and `holidays`/`holiday` count as one term."""
    if len(token) > 4 and token.endswith("ies"):
        return token[:-3] + "y"
    if len(token) > 4 and token.endswith("s") and not token.endswith(("ss", "us", "is")):
        return token[:-1]
    return token


def text_tokens(text: str) -> list[str]:
    toks: list[str] = []
    for word in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", text):
        toks.extend(split_identifier(word) if ("_" in word or re.search(r"[a-z][A-Z]", word)) else [word.lower()] if len(word) >= 3 else [])
    return [stem(t) for t in toks]


class DomainVocabulary:
    """What the repository talks about, from its own identifiers, docstrings and headings; infra and generic words excluded."""

    def __init__(self, feedback: dict[str, list[str]] | None = None) -> None:
        self.counts: Counter[str] = Counter()
        self.max = 1
        fb = feedback or {}
        self.accept = {t.lower() for t in fb.get("accept_tokens", [])}
        self.reject = {t.lower() for t in fb.get("reject_tokens", [])}

    def learn(self, tokens: list[str], weight: int = 1) -> None:
        for t in tokens:
            t = stem(t)
            if t in GENERIC_STOP or t in INFRA_STOP or len(t) < 3 or t.isdigit():
                continue
            self.counts[t] += weight
        self.max = max(self.counts.values(), default=1)

    def weight(self, token: str) -> float | None:
        """Domain weight in [0.5, 1] (or 1.25 for reviewer-accepted terms), -1 for infra or reviewer-rejected terms, None for neutral."""
        if token in self.reject or token in INFRA_STOP:
            return -1.0
        if token in self.accept:
            return 1.25
        if token in GENERIC_STOP:
            return None
        c = self.counts.get(token, 0)
        if not c:
            return None
        return 0.5 + 0.5 * math.log1p(c) / math.log1p(self.max)


def node_source(source: str, node: ast.AST) -> str:
    """Full source lines of a node including its decorators, dedented to column 0 (keeps relative indentation)."""
    lines = source.splitlines()
    start = min([getattr(node, "lineno", 1), *[d.lineno for d in getattr(node, "decorator_list", [])]])
    end = getattr(node, "end_lineno", start) or start
    return textwrap.dedent("\n".join(lines[start - 1 : end]))


def sentences(text: str) -> list[str]:
    cleaned = " ".join(text.split())
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", cleaned) if s.strip()]


class Miner:
    def __init__(self, repo: str, max_commits: int, feedback: dict[str, list[str]] | None = None) -> None:
        self.repo = os.path.abspath(repo)
        self.max_commits = max_commits
        self.vocab = DomainVocabulary(feedback)
        self._indegree: dict[str, int] | None = None
        self._test_age: dict[str, int] = {}
        self.files = tracked_files(self.repo)
        self.py_files = [f for f in self.files if f.endswith(".py")]
        self.internal = {module_name_for(f) for f in self.py_files}
        self.candidates: list[dict[str, Any]] = []
        self.warnings: list[str] = []
        self._trees: dict[str, ast.AST] = {}
        self._sources: dict[str, str] = {}

    # ---------- helpers
    def tree(self, rel: str) -> ast.AST | None:
        if rel in self._trees:
            return self._trees[rel]
        src = read_text(os.path.join(self.repo, rel))
        if src is None:
            return None
        try:
            tree = ast.parse(src, filename=rel)
        except SyntaxError:
            return None
        self._trees[rel] = tree
        self._sources[rel] = src
        return tree

    def add(self, kind: str, title: str, statement: str, confidence: str, evidence: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
        cand: dict[str, Any] = {"id": f"CAND-{len(self.candidates) + 1:03d}", "kind": kind, "title": title[:120], "statement": statement[:400], "confidence": confidence, "evidence": evidence}
        cand.update(extra)
        self.candidates.append(cand)
        return cand

    def scope_tags(self, paths: list[str]) -> list[str]:
        """Tags from the directory a path lives in and its module name (globs like `pkg/**` contribute their directory)."""
        tags: list[str] = []
        for p in paths:
            clean = p.replace("/**", "")
            parts = [x for x in clean.split("/")[:-1] if x not in ("src", "app", "lib") and x not in TEST_DIR_NAMES]
            base = os.path.basename(clean)
            base = base[:-3] if base.endswith(".py") else base
            if not p.endswith(".py"):
                parts, base = [*parts, base], ""
            for t in [*parts[-1:], base]:
                t = t.lower()
                if t and t != "__init__" and t not in tags:
                    tags.append(t)
        return tags[:4]

    def internal_imports(self, rel: str) -> list[tuple[str, int]]:
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

    def paths_for_modules(self, modules: list[str]) -> list[str]:
        """Repository paths (or `dir/**` for packages) for internal modules, most specific first, without duplicates."""
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

    def current_paths(self, paths: list[str]) -> tuple[list[str], list[str]]:
        """Map historical paths to HEAD: keep existing ones, resolve moved files by unique basename, report the rest."""
        kept: list[str] = []
        lost: list[str] = []
        tracked = set(self.files)
        by_base: dict[str, list[str]] = defaultdict(list)
        for f in self.py_files:
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

    # ---------- 1. commits
    def mine_commits(self) -> None:
        raw = run_git(self.repo, "log", "--no-merges", f"-n{self.max_commits}", "--date=short", "--format=%H%x1f%ad%x1f%s%x1f%b%x1e")
        if not raw.strip():
            self.warnings.append("no git history available for commit mining")
            return
        seen = 0
        seen_subjects: dict[str, dict[str, Any]] = {}
        for record in raw.split("\x1e"):
            record = record.strip("\n")
            if not record:
                continue
            sha, date, subject, body = (record.split("\x1f") + ["", "", "", ""])[:4]
            text = f"{subject}\n{body}"
            starts_like_fix = bool(FIX_START_RE.search(subject))
            if not (starts_like_fix or FIX_RE.search(text)) or NOISE_RE.search(subject):
                continue
            subject_clean = re.sub(r"^\s*(?:\[[^\]]*\]\s*)?(fix(?:es|ed)?|bug(?:fix)?|hotfix|revert(?:ed)?)\s*[:\-]?\s*", "", subject, flags=re.I).strip() or subject
            if len(subject_clean.split()) < 3:
                continue  # "Fix tests", "Fix build": no rule in there
            files = [f for f in run_git(self.repo, "show", "--name-only", "--format=", sha).split("\n") if f.strip()]
            source_files = [f for f in files if f.endswith(".py") and not is_test_path(f)]
            test_files = [f for f in files if f.endswith(".py") and is_test_path(f)]
            if not source_files:
                continue  # a behaviour fix touches source; test-only or docs-only commits are not rules
            key = re.sub(r"[^a-z0-9]+", " ", subject_clean.lower()).strip()
            if key in seen_subjects:
                seen_subjects[key]["evidence"].append({"type": "commit", "ref": sha[:7], "excerpt": subject, "detail": body.strip()[:300], "date": date, "files": files[:12]})
                continue
            added_tests = []
            if test_files:
                diff = run_git(self.repo, "show", "--format=", "--unified=0", sha, "--", *test_files)
                added_tests = [m.group(1) for m in re.finditer(r"^\+\s*(?:async\s+)?def\s+(test_\w+)", diff, re.M)]
            confidence = "high" if added_tests else "medium" if starts_like_fix else "low"
            current, lost = self.current_paths(source_files[:6])
            evidence = [{"type": "commit", "ref": sha[:7], "excerpt": subject, "detail": body.strip()[:300], "date": date, "files": files[:12]}]
            if lost:
                evidence.append({"type": "history", "ref": sha[:7], "excerpt": f"touched files no longer at HEAD: {', '.join(lost)}"})
            for t in added_tests:
                evidence.append({"type": "test", "ref": t, "excerpt": f"regression test added in {sha[:7]}", "path": next((f for f in test_files), None)})
            title = subject_clean[:1].upper() + subject_clean[1:]
            seen_subjects[key] = self.add("invariant", title, f"Preserve the behaviour established by {sha[:7]}: {subject_clean[:1].lower()}{subject_clean[1:]}", confidence, evidence, applies_to_paths=current, scope=self.scope_tags(current or source_files), related_tests=added_tests[:6])
            seen += 1
            if seen >= 40:
                break

    # ---------- 2. tests
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

    def _draft_hidden_test(self, rel: str, tree: ast.AST, source: str, node: ast.FunctionDef | ast.AsyncFunctionDef, cls: ast.ClassDef | None) -> dict[str, Any]:
        """A hidden-test draft that can run on its own: imports, used constants, fixtures, class setup and the test."""
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
        draft = "\n\n".join(x for x in ["\n".join(dict.fromkeys(line for line in import_lines if line)), "\n".join(const_lines), combined] if x.strip())
        return {"from": f"{rel}::{node.name}", "imports": "\n".join(dict.fromkeys(line for line in import_lines if line)), "source": draft, "notes": notes, "standalone": not notes}

    def mine_tests(self) -> None:
        for rel in self.py_files:
            if not is_test_path(rel) or os.path.basename(rel) == "conftest.py":
                continue
            tree = self.tree(rel)
            if tree is None:
                continue
            source = self._sources[rel]
            internal_paths = [p for p in self.paths_for_modules([m for m, _ in self.internal_imports(rel)]) if not is_test_path(p.replace("/**", ""))]
            owners: list[tuple[ast.FunctionDef | ast.AsyncFunctionDef, ast.ClassDef | None]] = []
            for n in getattr(tree, "body", []):
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    owners.append((n, None))
                elif isinstance(n, ast.ClassDef):
                    owners.extend((m, n) for m in n.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)))
            for node, cls in owners:
                if not node.name.startswith("test_"):
                    continue
                tokens = set(node.name.split("_"))
                if not (tokens & RULE_TOKENS):
                    continue
                confidence = "high" if tokens & NEGATION_TOKENS else "medium"
                segment = ast.get_source_segment(source, node) or ""
                statement = humanize(node.name)
                draft = self._draft_hidden_test(rel, tree, source, node, cls)
                self.add(
                    "invariant",
                    statement,
                    statement + ".",
                    confidence,
                    [{"type": "test", "ref": f"{rel}::{(cls.name + '::') if cls else ''}{node.name}", "excerpt": segment.split("\n")[0].strip(), "path": rel, "line": node.lineno}],
                    applies_to_paths=internal_paths[:6],
                    scope=self.scope_tags(internal_paths),
                    suggested_hidden_test=draft,
                )

    # ---------- 3. documents
    def _md_sections(self, text: str) -> list[tuple[str, int, str]]:
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

    def _rst_sections(self, text: str) -> list[tuple[str, int, str]]:
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

    def mine_docs(self) -> None:
        docs = [f for f in self.files if f.lower().endswith((".md", ".rst")) and not any(part in SKIP_DIRS for part in f.split("/")) and not DOC_SKIP_RE.match(os.path.basename(f))]
        for rel in docs:
            text = read_text(os.path.join(self.repo, rel))
            if text is None:
                continue
            is_md = rel.lower().endswith(".md")
            fields: dict[str, str] = {}
            for line in text.splitlines()[:40]:
                m = ADR_FIELD_RE.match(line.strip())
                if m:
                    fields[m.group(1).lower()] = m.group(2).strip()
            sections = self._md_sections(text) if is_md else self._rst_sections(text)
            title = next((h for h, _, _ in sections if h), os.path.basename(rel))
            if "status" in fields:
                status_raw = fields["status"].lower()
                status = "superseded" if "supersed" in status_raw else "approved" if ("accept" in status_raw or "approved" in status_raw) else "rejected" if "reject" in status_raw else "proposed"
                decision_body = next((body for h, _, body in sections if h.lower().startswith("decision")), "")
                stmt = sentences(decision_body)[:2]
                self.add("decision", title, " ".join(stmt) if stmt else title, "high", [{"type": "adr", "ref": rel, "excerpt": f"Status: {fields['status']}", "path": rel, "fields": fields}], status=status, supersedes=fields.get("supersedes"), sources=[{"path": rel}])
            if NOISE_RE.search(os.path.basename(rel)) and os.path.basename(rel).lower().startswith(("changelog", "changes", "history")):
                continue  # handled by mine_changelogs
            generic = {"decision", "decisions", "rules", "rule", "summary", "overview", "notes", "policy", "policies"}
            for heading, start, body in sections:
                if not body.strip() or heading.lower().startswith(("context", "consequences", "status")):
                    continue
                hits = [sent for sent in sentences(body) if MODAL_RE.search(sent) and len(sent) >= 25 and not sent.startswith(("- [", "|"))]
                if not hits:
                    continue
                # One candidate per section: the first modal sentence is the statement, the others are extra evidence.
                kind = "architecture_rule" if ARCH_HINT_RE.search(hits[0]) else "invariant"
                label = heading if heading and heading.lower() not in generic else f"{title}: {heading}" if heading else title
                evidence = [{"type": "doc", "ref": f"{rel}#{heading}" if heading else rel, "excerpt": sent[:300], "path": rel, "heading": heading or None, "line": start} for sent in hits[:4]]
                self.add(kind, label[:80], hits[0][:300], "medium" if heading else "low", evidence, sources=[{"path": rel, "heading": heading}] if (is_md and heading) else [{"path": rel}], applies_to_paths=[], scope=[])

    # ---------- 4. structure
    def layer_of(self, rel: str) -> str | None:
        """The directory a module lives in; top-level scripts (no directory) are not a layer."""
        d = os.path.dirname(rel)
        return d or None

    def mine_structure(self) -> None:
        layers: dict[str, list[str]] = defaultdict(list)
        for rel in self.py_files:
            if is_test_path(rel):
                continue
            layer = self.layer_of(rel)
            if layer:
                layers[layer].append(rel)
        edges: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for layer, files in layers.items():
            for rel in files:
                for target, line in self.internal_imports(rel):
                    tpath = self.path_for_module(target)
                    if not tpath:
                        # package import (e.g. app.services): resolve to its __init__
                        tpath = self.path_for_module(target + ".__init__") or next((f for f in self.py_files if module_name_for(f) == target), None)
                    tlayer = self.layer_of(tpath) if tpath else None
                    if tlayer and tlayer != layer:
                        edges[(layer, tlayer)].append({"type": "import", "ref": f"{rel}:{line}", "excerpt": f"{module_name_for(rel)} imports {target}", "path": rel, "line": line})
        substantial = {l for l, fs in layers.items() if len([f for f in fs if not f.endswith("__init__.py")]) >= 1}
        emitted = 0
        for (a, b), ev in sorted(edges.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            if (b, a) in edges or a not in substantial or b not in substantial:
                continue
            siblings = os.path.dirname(a) == os.path.dirname(b)
            child_to_parent = os.path.dirname(a) == b  # a subpackage uses its parent's utilities; the parent must not import the subpackage
            if not (siblings or child_to_parent):
                continue
            a_mod = module_name_for(a + "/__init__.py")
            known = os.path.basename(a).lower() in LAYER_VOCAB and os.path.basename(b).lower() in LAYER_VOCAB
            confidence = "medium" if known or (siblings and len(ev) >= 2) else "low"
            self.add(
                "architecture_rule",
                f"{b} must not import {a}",
                f"Modules under {b}/ must not import {a_mod} (as of this revision {a} depends on {b}, never the reverse).",
                confidence,
                ev[:6],
                rule={"kind": "forbidden_import", "paths": [f"{b}/**"], "forbidden_modules": [a_mod]},
                applies_to_paths=[f"{b}/**"],
                scope=self.scope_tags([f"{b}/**", f"{a}/**"]),
            )
            emitted += 1
            if emitted >= 12:
                break
        # frozen directories: name says so, or nothing committed there for a year while the repo moved on
        last_repo = run_git(self.repo, "log", "-1", "--format=%ad", "--date=short").strip()
        for layer in sorted(layers):
            if layer not in substantial:
                continue
            name = os.path.basename(layer)
            by_name = bool(FROZEN_NAME_RE.search(name))
            last = run_git(self.repo, "log", "-1", "--format=%ad", "--date=short", "--", layer).strip()
            stale = bool(last and last_repo and last[:4].isdigit() and last_repo[:4].isdigit() and (int(last_repo[:4]) - int(last[:4]) >= 1))
            if by_name or stale:
                reason = f"directory name suggests legacy code" if by_name else f"no commits since {last} while the repository was last changed {last_repo}"
                self.add("frozen_paths", f"{layer} is frozen", f"{layer}/ must not receive new code ({reason}).", "medium" if by_name else "low", [{"type": "history", "ref": layer, "excerpt": reason, "path": layer, "last_commit": last}], rule={"kind": "frozen_paths", "paths": [f"{layer}/**"]}, applies_to_paths=[f"{layer}/**"], scope=[name.lower()])

    # ---------- 5. changelogs
    def mine_changelogs(self) -> None:
        for rel in self.files:
            base = os.path.basename(rel).lower()
            if not base.startswith(("changelog", "changes", "history")) or not base.endswith((".md", ".rst", ".txt")):
                continue
            text = read_text(os.path.join(self.repo, rel))
            if text is None:
                continue
            version = ""
            for i, line in enumerate(text.splitlines(), 1):
                m = MD_HEADING_RE.match(line)
                if m or re.match(r"^v?\d+\.\d+", line.strip()):
                    version = (m.group(2) if m else line).strip()
                    continue
                if CHANGELOG_RE.search(line) and len(line.strip()) > 15:
                    self.add("decision", f"{base}: {version or 'entry'}", line.strip().lstrip("-* ")[:300], "low", [{"type": "changelog", "ref": f"{rel}:{i}", "excerpt": line.strip()[:300], "path": rel, "line": i, "version": version}], status="approved", sources=[{"path": rel}])

    # ---------- merge + blocks
    def merge_commits_into_tests(self) -> None:
        tests = {c["suggested_hidden_test"]["from"].split("::")[-1]: c for c in self.candidates if c.get("suggested_hidden_test")}
        drop: set[str] = set()
        for c in self.candidates:
            if c["kind"] != "invariant" or c["evidence"][0]["type"] != "commit":
                continue
            for name in c.get("related_tests", []):
                t = tests.get(name)
                if t:
                    t["evidence"].extend(c["evidence"])
                    t["confidence"] = "high"
                    for p in c.get("applies_to_paths", []):
                        if p not in t["applies_to_paths"]:
                            t["applies_to_paths"].append(p)
                    drop.add(c["id"])
        self.candidates = [c for c in self.candidates if c["id"] not in drop]
        for i, c in enumerate(self.candidates, 1):
            c["id"] = f"CAND-{i:03d}"

    # ---------- ranking
    def build_vocabulary(self) -> None:
        for rel in self.py_files:
            if is_test_path(rel):
                continue
            tree = self.tree(rel)
            if tree is None:
                continue
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    self.vocab.learn(split_identifier(node.name), 2)
                    doc = ast.get_docstring(node)
                    if doc:
                        self.vocab.learn(text_tokens(doc.split("\n")[0]))
                elif isinstance(node, ast.arg):
                    self.vocab.learn(split_identifier(node.arg))
                elif isinstance(node, ast.Attribute):
                    self.vocab.learn(split_identifier(node.attr))
                elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                    self.vocab.learn(split_identifier(node.id))
            self.vocab.learn(split_identifier(os.path.basename(rel)[:-3]), 2)
        for rel in self.files:
            if rel.lower().endswith((".md", ".rst")) and not DOC_SKIP_RE.match(os.path.basename(rel)):
                text = read_text(os.path.join(self.repo, rel)) or ""
                for line in text.splitlines():
                    m = MD_HEADING_RE.match(line)
                    if m:
                        self.vocab.learn(text_tokens(m.group(2)), 2)

    def indegree(self) -> dict[str, int]:
        """How many internal modules import each source file (centrality in the import graph)."""
        if self._indegree is None:
            importers: dict[str, set[str]] = defaultdict(set)
            for rel in self.py_files:
                if is_test_path(rel):
                    continue
                for target, _ in self.internal_imports(rel):
                    tpath = self.path_for_module(target)
                    if tpath and tpath != rel:
                        importers[tpath].add(rel)
            self._indegree = {k: len(v) for k, v in importers.items()}
        return self._indegree

    def test_age_days(self, path: str, name: str) -> int | None:
        key = f"{path}::{name}"
        if key in self._test_age:
            return self._test_age[key]
        first = run_git(self.repo, "log", "--format=%ad", "--date=short", "--reverse", "-S", f"def {name}(", "--", path).strip().split("\n")[0]
        head = run_git(self.repo, "log", "-1", "--format=%ad", "--date=short").strip()
        age = None
        if first and head:
            try:
                import datetime as _dt
                age = (_dt.date.fromisoformat(head) - _dt.date.fromisoformat(first)).days
            except ValueError:
                age = None
        self._test_age[key] = age if age is not None else -1
        return age

    def candidate_tokens(self, c: dict[str, Any]) -> list[str]:
        """Words the candidate is about: title, statement, test names, document sentences and commit subjects (not signatures)."""
        parts = [c["title"], c["statement"]]
        for e in c["evidence"]:
            if e["type"] in ("doc", "commit", "adr"):
                parts.append(str(e.get("excerpt", "")))
            if e["type"] == "test":
                parts.append(str(e.get("ref", "")).split("::")[-1])
        return text_tokens(" ".join(parts))

    def domain_tokens(self, c: dict[str, Any]) -> set[str]:
        return {t for t in self.candidate_tokens(c) if (self.vocab.weight(t) or 0) > 0}

    def score(self, c: dict[str, Any], cluster_types: set[str]) -> tuple[float, dict[str, float]]:
        toks = self.candidate_tokens(c)
        weights = [self.vocab.weight(t) for t in toks]
        scored = [w for w in weights if w is not None]
        if scored:
            density = (sum(scored)) / len(scored)  # in [-1, 1.25]
            domain = max(0.0, min(1.0, (density + 1) / 2))
        else:
            domain = 0.5  # nothing domain-specific and nothing infrastructural either: neutral
        tset = set(toks)
        shape_raw = (1 if tset & PROPERTY_WORDS else 0) - (1 if tset & MECHANISM_WORDS else 0)
        shape = (shape_raw + 1) / 2
        corroboration = 0.0 if len(cluster_types) <= 1 else 0.6 if len(cluster_types) == 2 else 1.0
        deg = self.indegree()
        maxdeg = max(deg.values(), default=0)
        cent = 0.0
        for p in c.get("applies_to_paths", []):
            if p.endswith("/**"):
                prefix = p[:-3] + "/"
                cent = max(cent, max((v for k, v in deg.items() if k.startswith(prefix)), default=0))
            else:
                cent = max(cent, deg.get(p, 0))
        centrality = cent / maxdeg if maxdeg else 0.0
        primary = c["evidence"][0]["type"]
        stability = 0.5
        if primary == "test":
            e = c["evidence"][0]
            age = self.test_age_days(str(e.get("path", "")), str(e.get("ref", "")).split("::")[-1]) if e.get("path") else None
            stability = min(1.0, age / 365) if age is not None and age >= 0 else 0.3
        elif primary in ("doc", "adr"):
            stability = 0.7
        elif primary == "commit":
            stability = 0.3
        prior = PRIOR_BY_SOURCE.get(primary, 0.4)
        signals = {"domain": round(domain, 3), "shape": round(shape, 3), "corroboration": round(corroboration, 3), "centrality": round(centrality, 3), "stability": round(stability, 3), "prior": prior}
        total = 0.35 * domain + 0.15 * shape + 0.2 * corroboration + 0.1 * centrality + 0.1 * stability + 0.1 * prior
        return round(max(0.0, min(1.0, total)), 3), signals

    def cluster(self) -> None:
        """Group candidates that express the same rule; clusters pool their evidence types for corroboration.

        Links need shared distinctive terms weighted by rarity, and a cluster is capped so one common word can never
        chain most of the candidates together.
        """
        n = len(self.candidates)
        toksets = [self.domain_tokens(c) for c in self.candidates]
        df: Counter[str] = Counter()
        for ts in toksets:
            df.update(ts)
        # A term in more than half of the candidates says nothing about a cluster.
        distinctive = [{t for t in ts if df[t] <= max(2, n * 0.5)} for ts in toksets]
        idf = {t: math.log((n + 1) / (c + 1)) + 0.1 for t, c in df.items()}
        parent = list(range(n))
        size = [1] * n

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        pairs: list[tuple[float, int, int]] = []
        for i in range(n):
            for j in range(i + 1, n):
                a, b = distinctive[i], distinctive[j]
                if not a or not b:
                    continue
                shared = a & b
                if not shared:
                    continue
                jac = sum(idf[t] for t in shared) / sum(idf[t] for t in a | b)
                if (len(shared) >= 2 and jac >= 0.25) or jac >= 0.5:
                    pairs.append((jac, i, j))
        for _, i, j in sorted(pairs, reverse=True):  # strongest links first; a cluster never exceeds 8 members
            ri, rj = find(i), find(j)
            if ri == rj or size[ri] + size[rj] > 8:
                continue
            parent[rj] = ri
            size[ri] += size[rj]

        groups: dict[int, list[int]] = defaultdict(list)
        for i in range(n):
            groups[find(i)].append(i)
        for members in groups.values():
            common: Counter[str] = Counter()
            for i in members:
                common.update(distinctive[i] if len(members) > 1 else toksets[i])
            key = "-".join(t for t, _ in common.most_common(2)) or "misc"
            types = {e["type"] for i in members for e in self.candidates[i]["evidence"] if e["type"] != "history"}  # a lost path is not a second source
            for i in members:
                c = self.candidates[i]
                c["cluster"] = key
                c["cluster_size"] = len(members)
                c["cluster_members"] = [self.candidates[j]["id"] for j in members if j != i]
                c["score"], c["signals"] = self.score(c, types)
                c["relevance"] = next(label for threshold, label in RELEVANCE_BANDS if c["score"] >= threshold)

    def policy_block(self, c: dict[str, Any], policy_id: str) -> dict[str, Any]:
        slug = slugify(c["title"])
        if c["kind"] == "invariant":
            src = c.get("sources") or [{"path": "docs/intentos-policy.md", "heading": c["title"]}]
            return {"id": "INV-TODO", "statement": c["statement"], "scope": c.get("scope", []), "applies_to_paths": c.get("applies_to_paths", []), "authority": "approved_policy", "approved_by": "TODO", "sources": src, "verified_by": [f"benchmarks/hidden_tests/{policy_id}/invariants/test_inv_TODO_{slug.replace('-', '_')}.py"] if c.get("suggested_hidden_test") else [], "enforcement": "blocking"}
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

    def run(self, policy_id: str) -> dict[str, Any]:
        self.build_vocabulary()
        self.mine_commits()
        self.mine_tests()
        self.merge_commits_into_tests()
        self.mine_docs()
        self.mine_structure()
        self.mine_changelogs()
        for i, c in enumerate(self.candidates, 1):
            c["id"] = f"CAND-{i:03d}"
        self.cluster()
        order = {"high": 0, "medium": 1, "low": 2}
        self.candidates.sort(key=lambda c: (-c["score"], order[c["confidence"]], c["kind"], c["id"]))
        old_ids = {c["id"]: f"CAND-{i:03d}" for i, c in enumerate(self.candidates, 1)}
        for i, c in enumerate(self.candidates, 1):
            c["id"] = f"CAND-{i:03d}"
            c["rank"] = i
            c["cluster_members"] = [old_ids[m] for m in c.get("cluster_members", [])]
            c["policy_block"] = self.policy_block(c, policy_id)
        head = run_git(self.repo, "rev-parse", "HEAD").strip()
        top_terms = [t for t, _ in self.vocab.counts.most_common(25)]
        return {"repo": self.repo, "head": head, "policy_id": policy_id, "candidates": self.candidates, "counts": {k: sum(1 for c in self.candidates if c["kind"] == k) for k in ("invariant", "architecture_rule", "frozen_paths", "decision")}, "vocabulary": top_terms, "warnings": self.warnings}


# ---------------------------------------------------------------------------------------------------------------------
# Host-authored candidates: the coding agent follows the intentos-policy-mining skill and submits candidates with a
# test each. Nothing in the submission is trusted: every reference is checked against the repository, existing tests
# are lifted with the miner's machinery, policy blocks are built the same way as for mined candidates. Tests the agent
# wrote are run by the caller (they need the repository's interpreter); here they are only parsed.

EVIDENCE_TYPES = ("test", "commit", "doc", "adr", "changelog", "import", "history")
CANDIDATE_KINDS = ("invariant", "architecture_rule", "frozen_paths", "decision")
CATEGORIES = ("business_rule", "robustness_rule")
LEVELS = ("high", "medium", "low")
RELEVANCE_SCORE = {"high": 0.9, "medium": 0.6, "low": 0.3}


class Ingestor:
    def __init__(self, repo: str) -> None:
        self.m = Miner(repo, max_commits=0)
        self.tracked = set(self.m.files)

    def path_ok(self, p: str) -> bool:
        if p.endswith("/**"):
            prefix = p[:-3].rstrip("/") + "/"
            return any(f.startswith(prefix) for f in self.tracked)
        return p in self.tracked or any(fnmatch.fnmatch(f, p) for f in self.tracked)

    def find_test(self, ref: str) -> tuple[dict[str, Any] | None, str | None, Any]:
        parts = ref.split("::")
        rel, names = parts[0], parts[1:]
        if not names or len(names) > 2:
            return None, f"test reference {ref!r} must be path::test_name or path::Class::test_name", None
        tree = self.m.tree(rel)
        if tree is None:
            return None, f"{rel} is not a Python file in the repository", None
        source = self.m._sources[rel]
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
        return self.m._draft_hidden_test(rel, tree, source, node, cls), None, node

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
            if run_git(self.m.repo, "cat-file", "-t", ref).strip() != "commit":
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
        if line is not None and line > len((read_text(os.path.join(self.m.repo, rel)) or "").splitlines()):
            return f"{rel} has no line {line}"
        e.setdefault("path", rel)
        if line is not None:
            e.setdefault("line", line)
        if t == "test" and "::" in ref:
            _, err, node = self.find_test(ref)
            if err:
                return err
            e.setdefault("line", node.lineno)
        return None

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
                        evidence.append({"type": "test", "ref": ref, "excerpt": (ast.get_source_segment(self.m._sources[rel], node) or "").split("\n")[0].strip(), "path": rel, "line": node.lineno})
                elif isinstance(test, dict) and isinstance(test.get("source"), str) and test["source"].strip():
                    src = test["source"]
                    if "def test_" not in src:
                        reasons.append("test.source must define at least one test_ function")
                    else:
                        try:
                            ast.parse(src)
                        except SyntaxError as ex:
                            reasons.append(f"test.source does not parse: {ex.msg} (line {ex.lineno})")
                    draft = {"from": f"codex:{slugify(title)}", "imports": "", "source": src.strip() + "\n", "notes": [], "standalone": True, "pending_run": True}
                else:
                    reasons.append("an invariant needs a test: test.existing (a test in the repository) or test.source (a pytest module you wrote)")
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
            slug = slugify(title)[:40]
            c: dict[str, Any] = {
                "id": "",
                "kind": kind,
                "title": title,
                "statement": statement,
                "confidence": confidence,
                "evidence": evidence,
                "applies_to_paths": paths,
                "scope": self.m.scope_tags(paths or list((rule or {}).get("paths", []))),
                "suggested_hidden_test": draft,
                "authored_by": "codex",
                "classification": {"category": category, "keep": True, "reason": str(p.get("rationale", "")).strip()[:600], "rule": None, "rule_rejected": None, "cluster": slug, "duplicate_of": None},
                "score": RELEVANCE_SCORE[relevance],
                "signals": {k: 0.0 for k in ("domain", "shape", "corroboration", "centrality", "stability", "prior")},
                "relevance": relevance,
                "cluster": slug,
                "cluster_size": 1,
                "cluster_members": [],
                "rank": 0,
            }
            if rule:
                c["rule"] = rule
            sources = [s for s in p.get("sources", []) or [] if isinstance(s, dict) and s.get("path")]
            if sources:
                c["sources"] = [{"path": str(s["path"]), "heading": s.get("heading")} for s in sources]
            if kind == "decision":
                c["status"] = str(p.get("status") or "approved")
            accepted.append(c)
        for i, c in enumerate(accepted, start):
            c["id"] = f"CAND-{i:03d}"
            c["rank"] = i - start + 1
            c["policy_block"] = self.m.policy_block(c, policy_id)
        head = run_git(self.m.repo, "rev-parse", "HEAD").strip()
        counts = {k: sum(1 for c in accepted if c["kind"] == k) for k in CANDIDATE_KINDS}
        return {"repo": self.m.repo, "head": head, "policy_id": policy_id, "candidates": accepted, "rejected": rejected, "counts": counts, "warnings": []}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo")
    parser.add_argument("--policy-id", default="policy")
    parser.add_argument("--max-commits", type=int, default=500)
    parser.add_argument("--feedback", help="JSON file with accept_tokens / reject_tokens learned from earlier reviews")
    parser.add_argument("--ingest", help="do not mine: validate host-authored candidates from this JSON file (a list, or {candidates: [...]}) and print them in the miner's shape")
    parser.add_argument("--start", type=int, default=1, help="with --ingest: first candidate number (appending to an earlier list)")
    args = parser.parse_args(argv)
    if args.ingest:
        with open(args.ingest, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        proposals = loaded["candidates"] if isinstance(loaded, dict) else loaded
        json.dump(Ingestor(args.repo).ingest(list(proposals), args.policy_id, args.start), sys.stdout)
        return 0
    feedback = None
    if args.feedback and os.path.exists(args.feedback):
        try:
            feedback = json.load(open(args.feedback, "r", encoding="utf-8"))
        except (OSError, ValueError):
            feedback = None
    json.dump(Miner(args.repo, args.max_commits, feedback).run(args.policy_id), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
