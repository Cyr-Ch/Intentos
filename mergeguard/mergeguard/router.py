"""Review tier = max(diff rules, author-controlled raises, breaker floor)."""
from __future__ import annotations

import ast
from collections import Counter

from . import breaker, changes, howmade
from .git import changed_files, read_at, sha
from .policy import bucket, load, matches


class WithoutDocstrings(ast.NodeTransformer):
    def strip(self, node):
        self.generic_visit(node)
        if node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant) and isinstance(node.body[0].value.value, str):
            node.body.pop(0)
        if not node.body and not isinstance(node, ast.Module):
            node.body.append(ast.Pass())
        return node

    visit_Module = strip
    visit_ClassDef = strip
    visit_FunctionDef = strip
    visit_AsyncFunctionDef = strip


class WithoutAnnotations(ast.NodeTransformer):
    """Type annotations are not executed on a call path; a change that only adds or edits them is a documentation change."""
    def visit_arg(self, node):
        node.annotation = None
        return node

    def visit_FunctionDef(self, node):
        self.generic_visit(node)
        node.returns = None
        return node

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_AnnAssign(self, node):
        self.generic_visit(node)
        if node.value is None:
            return None  # a bare `x: int` declaration adds no behaviour
        return ast.Assign(targets=[node.target], value=node.value, lineno=node.lineno)


def proof(before: str | None, after: str | None) -> str | None:
    if before is None or after is None:
        return None
    try:
        first, second = ast.parse(before), ast.parse(after)
    except SyntaxError:
        return None
    if ast.dump(first) == ast.dump(second):
        return "AST-equivalent (comments or formatting only)"
    first, second = WithoutDocstrings().visit(first), WithoutDocstrings().visit(second)
    if ast.dump(first) == ast.dump(second):
        return "docstring-only"
    if ast.dump(ast.fix_missing_locations(WithoutAnnotations().visit(first))) == ast.dump(ast.fix_missing_locations(WithoutAnnotations().visit(second))):
        return "annotation-only (type hints or docstrings)"
    return None


ADDITIVE_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Import, ast.ImportFrom)


def _header(node: ast.ClassDef) -> str:
    clone = ast.ClassDef(name=node.name, bases=node.bases, keywords=node.keywords, body=[], decorator_list=node.decorator_list, type_params=getattr(node, "type_params", []))
    return ast.dump(clone)


def _bound_names(body) -> set[str]:
    names = set()
    for node in body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return names


def _new_constant(node, existing: set[str]) -> bool:
    """A module-level assignment of a literal to a name that did not exist before cannot change existing behaviour."""
    if isinstance(node, ast.Assign) and all(isinstance(t, ast.Name) for t in node.targets):
        targets = [t.id for t in node.targets]
    elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
        targets = [node.target.id]
    else:
        return False
    literal = isinstance(node.value, (ast.Constant, ast.List, ast.Tuple, ast.Dict, ast.Set)) and all(
        isinstance(n, (ast.Constant, ast.List, ast.Tuple, ast.Dict, ast.Set, ast.UnaryOp, ast.Load, ast.USub, ast.UAdd)) for n in ast.walk(node.value))
    return literal and not any(t in existing for t in targets)


def _only_added(old_body, new_body) -> bool:
    """Every old statement survives unchanged and in order; the rest are new definitions, imports, or new literal constants."""
    old = list(old_body)
    existing = _bound_names(old)
    index = 0
    for node in new_body:
        if index < len(old) and ast.dump(node) == ast.dump(old[index]):
            index += 1
        elif (index < len(old) and isinstance(node, ast.ClassDef) and isinstance(old[index], ast.ClassDef)
              and _header(node) == _header(old[index]) and _only_added(old[index].body, node.body)):
            index += 1
        elif isinstance(node, ADDITIVE_NODES) or _new_constant(node, existing):
            continue
        else:
            return False
    return index == len(old)


def additive_proof(before: str | None, after: str | None) -> str | None:
    """A code change that adds definitions and changes nothing existing cannot break an existing caller."""
    if after is None:
        return None
    try:
        new = WithoutDocstrings().visit(ast.parse(after))
        if before is None:
            return "new module: nothing existing changed"
        old = WithoutDocstrings().visit(ast.parse(before))
    except SyntaxError:
        return None
    return "additive-only: adds definitions, imports or new constants, changes nothing existing" if _only_added(old.body, new.body) else None


def is_test(path: str) -> bool:
    name = path.rsplit("/", 1)[-1]
    return path.endswith(".py") and (path.startswith("tests/") or "/tests/" in path or name.startswith("test_") or name.endswith("_test.py"))


def assertions(source: str) -> Counter:
    tree = ast.parse(source)
    return Counter(ast.dump(n) for n in ast.walk(tree) if isinstance(n, ast.Assert) or
                   isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr.startswith("assert"))


def route(repo, base: str, head: str, author: str, *, howmade_data: dict | str | None = None,
          policy_ref: str | None = None, events: list[dict] | None = None, policy: dict | None = None,
          floor: int = 0, floor_reason: str | None = None) -> dict:
    """`floor` is a tier the caller already knows is required (an independent verifier that asked for a human,
    for instance); the diff rules can only raise it further."""
    base, head = sha(repo, base), sha(repo, head)
    policy = policy or load(repo, policy_ref or base)
    paths = changed_files(repo, base, head)
    tier, reasons, proofs = 0, [], {}

    def raise_to(level, reason):
        nonlocal tier
        tier = max(tier, level)
        reasons.append(reason)

    if floor:
        raise_to(min(max(int(floor), 0), 2), floor_reason or f"Caller requires tier {floor}")

    if not policy["zero_review_allowed"]:
        raise_to(1, "Policy requires a quick skim even for documentation and comments")
    if author not in policy["trusted_authors"]:
        raise_to(1, f"Author {author} is not in the trusted-author list on main")
    modified_tests = False
    for path in paths:
        before, after = (read_at(repo, base, path), read_at(repo, head, path)) if path.endswith(".py") else (None, None)
        if any(matches(path, rule) for rule in policy["always_two"]):
            raise_to(2, f"{path} is protected by an always-two rule")
        elif any(matches(path, rule) for rule in policy["always_one"]):
            raise_to(1, f"{path} requires at least one human")
        if is_test(path) and before is not None:
            modified_tests = True
            raise_to(1, f"Existing tests modified: {path}")
            if after is None:
                raise_to(2, f"Existing test file deleted: {path}")
            else:
                try:
                    if assertions(before) - assertions(after):
                        raise_to(2, f"Existing test assertion removed or replaced: {path}")
                except SyntaxError:
                    raise_to(2, f"Cannot parse existing test changes: {path}")
        if path.endswith(".md") or path.startswith("docs/"):
            proofs[path] = "documentation"
        elif path.endswith(".py") and (evidence := proof(before, after)):
            proofs[path] = evidence
        elif path.endswith(".py") and policy["zero_review_additive"] and (evidence := additive_proof(before, after)):
            proofs[path] = evidence
        else:
            raise_to(1, f"{path} changes executable code or has no comment-only proof")
    if policy["api_break_tier"] and any(path.endswith(".py") for path in paths):
        # A proven public API break is what breaks parallel sessions; it is routed like a protected path.
        for change in changes.detect(repo, base, head):
            if is_test(change.get("path", "")):
                continue
            replacement = f" (now {change['new']})" if change.get("new") else ""
            raise_to(policy["api_break_tier"], f"Public API changed: {change['symbol']} {change['change'].replace('_', ' ')}{replacement}")
    evidence = howmade.parse(howmade_data) if isinstance(howmade_data, str) else howmade_data or {}
    if evidence.get("test_runs", 0) >= 3:
        raise_to(1, f"How-made: {evidence['test_runs']} recorded test attempts")
    if evidence.get("sync_notes", 0):
        raise_to(1, "How-made: agent received a specific sync note")
    if evidence.get("existing_tests_modified"):
        raise_to(1, "How-made: existing tests were modified")
    floors = breaker.status(repo, policy=policy, events=events)["folders"]
    for folder in sorted({bucket(p, policy) for p in paths}):
        if folder in floors:
            raise_to(floors[folder]["floor"], floors[folder]["reason"])
    if tier == 0:
        reasons.append("Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only")
    return {"tier": tier, "required_approvals": tier, "reasons": list(dict.fromkeys(reasons)),
            "paths": paths, "proofs": proofs, "base": base, "head": head, "author": author,
            "existing_tests_modified": modified_tests}
