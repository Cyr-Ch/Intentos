"""AST-level API deltas. Deliberately does not infer semantic changes."""
from __future__ import annotations

import ast
import copy
from dataclasses import asdict, dataclass
from pathlib import PurePosixPath

import re

from .git import files_at, git, read_at, run, sha


def module_name(path: str) -> str:
    """Dotted module name of a file. A leading `src/` (the src layout) is not part of the import path, so it is
    dropped: otherwise `from pkg.mod import f` in one file and `from .mod import f` in another would name two
    different symbols and an absolute import would never match the index."""
    parts = list(PurePosixPath(path).with_suffix("").parts)
    if len(parts) > 1 and parts[0] == "src":
        parts = parts[1:]
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def imported_module(path: str, node: ast.ImportFrom) -> str:
    if not node.level:
        return node.module or ""
    parts = module_name(path).split(".")
    if not path.endswith("/__init__.py"):
        parts = parts[:-1]
    parts = parts[:len(parts) - node.level + 1]
    return ".".join(parts + ([node.module] if node.module else []))


def signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[dict]:
    args = node.args
    positional = args.posonlyargs + args.args
    required = len(positional) - len(args.defaults)
    parameters = [
        {"name": arg.arg, "kind": "posonly" if i < len(args.posonlyargs) else "positional", "required": i < required}
        for i, arg in enumerate(positional)
    ]
    if args.vararg:
        parameters.append({"name": args.vararg.arg, "kind": "varargs", "required": False})
    parameters += [{"name": arg.arg, "kind": "kwonly", "required": default is None}
                   for arg, default in zip(args.kwonlyargs, args.kw_defaults)]
    if args.kwarg:
        parameters.append({"name": args.kwarg.arg, "kind": "kwargs", "required": False})
    return parameters


@dataclass
class Symbol:
    name: str
    path: str
    module: str
    signature: list[dict] | None
    fingerprint: str


def imported_names(trees: dict[str, ast.Module]) -> set[str]:
    """Fully qualified names these modules import, via from-imports or `import m` followed by `m.name`."""
    imported = set()
    for path, tree in trees.items():
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                imported.update(f"{imported_module(path, node)}.{a.name}" for a in node.names)
            # import package; package._helper() counts as an external use too.
            if isinstance(node, ast.Import):
                aliases = {a.asname or a.name: a.name for a in node.names}
                for child in ast.walk(tree):
                    if isinstance(child, ast.Attribute) and isinstance(child.value, ast.Name):
                        if child.value.id in aliases:
                            imported.add(f"{aliases[child.value.id]}.{child.attr}")
    return imported


def index_sources(sources: dict[str, str], *, include_private: bool = False, extra_imported: set[str] = frozenset()) -> dict[str, Symbol]:
    symbols: dict[str, Symbol] = {}
    trees = {p: ast.parse(text, filename=p) for p, text in sources.items()}
    imported = imported_names(trees) | set(extra_imported)
    for path, tree in trees.items():
        module = module_name(path)
        for node in tree.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            entries = [(node.name, node)]
            if isinstance(node, ast.ClassDef):
                entries += [(f"{node.name}.{method.name}", method) for method in node.body
                            if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef))]
            for short, entry in entries:
                name = f"{module}.{short}"
                if not include_private and short.split(".")[-1].startswith("_") and name not in imported:
                    continue
                normalized = copy.deepcopy(entry)
                normalized.name = "__symbol__"
                symbols[name] = Symbol(name, path, module,
                                       signature(entry) if not isinstance(entry, ast.ClassDef) else None,
                                       ast.dump(normalized, include_attributes=False))
    return symbols


def changed_python_files(repo, old_ref: str, new_ref: str) -> list[str]:
    """Only a file that differs between the refs can hold a removed, renamed, moved or re-signed symbol, or its destination."""
    out = run(repo, "diff", "--name-only", "--no-renames", "-z", old_ref, new_ref, "--").stdout
    return sorted(p for p in out.split("\0") if p.endswith(".py"))


def index(repo, ref: str, paths: list[str] | None = None) -> dict[str, Symbol]:
    """Index the given files at a ref (default: every Python file). The private-helper rule needs to know whether other
    files import a helper, so for private names a text search finds those files and only they are parsed as well."""
    paths = [p for p in (files_at(repo, ref) if paths is None else paths) if p.endswith(".py")]
    sources = {p: text for p in paths if (text := read_at(repo, ref, p)) is not None}
    extra: set[str] = set()
    private = set()
    for path, text in sources.items():
        try:
            tree = ast.parse(text, filename=path)
        except SyntaxError:
            continue
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names = [node.name] + ([m.name for m in node.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))] if isinstance(node, ast.ClassDef) else [])
                private.update(n for n in names if n.startswith("_"))
    if private:
        pattern = "|".join(re.escape(n) for n in sorted(private))
        hits = run(repo, "grep", "-l", "-E", "-e", pattern, ref, "--", "*.py", check=False).stdout.splitlines()
        others = {h.split(":", 1)[1] for h in hits if ":" in h} - set(sources)
        extra = imported_names({p: ast.parse(text, filename=p) for p in others if (text := read_at(repo, ref, p)) is not None})
    return index_sources(sources, extra_imported=extra)


def breaking_signature(old: list[dict], new: list[dict]) -> bool:
    old_by_name = {p["name"]: p for p in old}
    new_by_name = {p["name"]: p for p in new}
    if any(p["name"] not in new_by_name or new_by_name[p["name"]]["kind"] != p["kind"] for p in old):
        return True
    if any(p["required"] and (p["name"] not in old_by_name or not old_by_name[p["name"]]["required"]) for p in new):
        return True
    old_pos = [p["name"] for p in old if p["kind"] in {"posonly", "positional"}]
    new_pos = [p["name"] for p in new if p["kind"] in {"posonly", "positional"}]
    return new_pos[:len(old_pos)] != old_pos


def detect(repo, old_ref: str, new_ref: str, *, attribute: bool = True) -> list[dict]:
    old_ref, new_ref = sha(repo, old_ref), sha(repo, new_ref)
    paths = changed_python_files(repo, old_ref, new_ref)
    if not paths:
        return []
    old, new = index(repo, old_ref, paths), index(repo, new_ref, paths)
    added = {key: value for key, value in new.items() if key not in old}
    changes = []
    for name, before in old.items():
        after = new.get(name)
        kind, replacement = None, None
        if after is None:
            matches = [value for value in added.values() if value.fingerprint == before.fingerprint]
            same_module = [value for value in matches if value.module == before.module]
            matches = same_module or matches
            if len(matches) == 1:
                replacement = matches[0].name
                kind = "renamed" if matches[0].module == before.module else "moved"
            else:
                kind = "removed"
        elif before.signature is not None and after.signature is not None and breaking_signature(before.signature, after.signature):
            kind = "signature_changed"
        if kind:
            change = {"symbol": name, "change": kind, "new": replacement, "path": before.path,
                      "old_signature": before.signature, "new_signature": after.signature if after else None,
                      "commit": new_ref}
            if attribute:
                # Walk only commits touching the old definition, oldest first. This avoids
                # blaming an unrelated later edit to the file for an earlier API change.
                for commit in git(repo, "rev-list", "--reverse", "--first-parent", f"{old_ref}..{new_ref}", "--", before.path).splitlines():
                    source = read_at(repo, commit, before.path)
                    at_commit = index_sources({before.path: source}, include_private=True) if source is not None else {}
                    current = at_commit.get(name)
                    if current is None or (kind == "signature_changed" and current.signature != before.signature):
                        change["commit"] = commit
                        break
            changes.append(change)
    return changes
