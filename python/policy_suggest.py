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
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
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
CHANGELOG_RE = re.compile(r"\b(deprecat\w*|removed|remove|breaking|no longer|renamed|dropped|drop support|must now|is now required)\b", re.I)
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


def sentences(text: str) -> list[str]:
    cleaned = " ".join(text.split())
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", cleaned) if s.strip()]


class Miner:
    def __init__(self, repo: str, max_commits: int) -> None:
        self.repo = os.path.abspath(repo)
        self.max_commits = max_commits
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
        tags: list[str] = []
        for p in paths:
            parts = [x for x in p.split("/")[:-1] if x not in ("src", "app", "lib") and x not in TEST_DIR_NAMES]
            base = os.path.basename(p)[:-3] if p.endswith(".py") else os.path.basename(p)
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
        return out

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
            evidence = [{"type": "commit", "ref": sha[:7], "excerpt": subject, "detail": body.strip()[:300], "date": date, "files": files[:12]}]
            for t in added_tests:
                evidence.append({"type": "test", "ref": t, "excerpt": f"regression test added in {sha[:7]}", "path": next((f for f in test_files), None)})
            title = subject_clean[:1].upper() + subject_clean[1:]
            seen_subjects[key] = self.add("invariant", title, f"Preserve the behaviour established by {sha[:7]}: {subject_clean[:1].lower()}{subject_clean[1:]}", confidence, evidence, applies_to_paths=source_files[:6], scope=self.scope_tags(source_files), related_tests=added_tests[:6])
            seen += 1
            if seen >= 40:
                break

    # ---------- 2. tests
    def mine_tests(self) -> None:
        for rel in self.py_files:
            if not is_test_path(rel) or os.path.basename(rel) == "conftest.py":
                continue
            tree = self.tree(rel)
            if tree is None:
                continue
            source = self._sources[rel]
            import_lines = [ast.get_source_segment(source, n) or "" for n in getattr(tree, "body", []) if isinstance(n, (ast.Import, ast.ImportFrom))]
            internal_paths = [p for p in (self.path_for_module(m) for m, _ in self.internal_imports(rel)) if p and not is_test_path(p)]
            for node in ast.walk(tree):
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or not node.name.startswith("test_"):
                    continue
                tokens = set(node.name.split("_"))
                hits = tokens & RULE_TOKENS
                if not hits:
                    continue
                confidence = "high" if tokens & NEGATION_TOKENS else "medium"
                segment = ast.get_source_segment(source, node) or ""
                statement = humanize(node.name)
                self.add(
                    "invariant",
                    statement,
                    statement + ".",
                    confidence,
                    [{"type": "test", "ref": f"{rel}::{node.name}", "excerpt": segment.split("\n")[0], "path": rel, "line": node.lineno}],
                    applies_to_paths=internal_paths[:6],
                    scope=self.scope_tags(internal_paths),
                    suggested_hidden_test={"from": f"{rel}::{node.name}", "imports": "\n".join(import_lines), "source": segment},
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
                f"Modules under {b}/ must not import {a_mod} (today {a} depends on {b}, never the reverse).",
                confidence,
                ev[:6],
                rule={"kind": "forbidden_import", "paths": [f"{b}/**"], "forbidden_modules": [a_mod]},
                applies_to_paths=[f"{b}/**"],
                scope=self.scope_tags([b + "/x.py", a + "/x.py"]),
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
        tests = {c["suggested_hidden_test"]["from"].split("::")[1]: c for c in self.candidates if c.get("suggested_hidden_test")}
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
        self.mine_commits()
        self.mine_tests()
        self.merge_commits_into_tests()
        self.mine_docs()
        self.mine_structure()
        self.mine_changelogs()
        order = {"high": 0, "medium": 1, "low": 2}
        self.candidates.sort(key=lambda c: (order[c["confidence"]], c["kind"], c["id"]))
        for i, c in enumerate(self.candidates, 1):
            c["id"] = f"CAND-{i:03d}"
            c["policy_block"] = self.policy_block(c, policy_id)
        head = run_git(self.repo, "rev-parse", "HEAD").strip()
        return {"repo": self.repo, "head": head, "policy_id": policy_id, "candidates": self.candidates, "counts": {k: sum(1 for c in self.candidates if c["kind"] == k) for k in ("invariant", "architecture_rule", "frozen_paths", "decision")}, "warnings": self.warnings}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo")
    parser.add_argument("--policy-id", default="policy")
    parser.add_argument("--max-commits", type=int, default=500)
    args = parser.parse_args(argv)
    json.dump(Miner(args.repo, args.max_commits).run(args.policy_id), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
