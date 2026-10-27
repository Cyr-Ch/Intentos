"""Resolve explicit Python imports in files changed by this branch."""
from __future__ import annotations

import ast

from .changes import imported_module, module_name
from .git import changed_files, main_ref, merge_base, read_at, read_working, root


def dotted(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = dotted(node.value)
        return f"{prefix}.{node.attr}" if prefix else None
    return None


class Uses(ast.NodeVisitor):
    def __init__(self, path: str):
        self.path = path
        self.scopes: list[dict[str, str | None]] = [{}]
        self.records: list[dict] = []

    def resolve(self, name: str | None) -> str | None:
        if not name:
            return None
        first, _, rest = name.partition(".")
        for scope in reversed(self.scopes):
            if first in scope:
                target = scope[first]
                return f"{target}.{rest}" if target and rest else target
        return None

    def record(self, symbol: str, node: ast.AST, *, call: bool = False, **kwargs):
        self.records.append({"symbol": symbol, "path": self.path, "line": node.lineno, "call": call,
                             "positional": 0, "keywords": [], "starargs": False, "starkwargs": False, **kwargs})

    def visit_ImportFrom(self, node):
        module = imported_module(self.path, node)
        for alias in node.names:
            if alias.name == "*":
                continue
            symbol = f"{module}.{alias.name}"
            self.scopes[-1][alias.asname or alias.name] = symbol
            self.record(symbol, node)

    def visit_Import(self, node):
        for alias in node.names:
            self.scopes[-1][alias.asname or alias.name.split(".")[0]] = alias.name if alias.asname else alias.name.split(".")[0]

    def visit_Call(self, node):
        symbol = self.resolve(dotted(node.func))
        if symbol:
            self.record(symbol, node, call=True,
                        positional=sum(not isinstance(a, ast.Starred) for a in node.args),
                        keywords=[k.arg for k in node.keywords if k.arg is not None],
                        starargs=any(isinstance(a, ast.Starred) for a in node.args),
                        starkwargs=any(k.arg is None for k in node.keywords))
        self.generic_visit(node)

    def visit_Attribute(self, node):
        symbol = self.resolve(dotted(node))
        if symbol:
            self.record(symbol, node)
        self.generic_visit(node)

    def visit_FunctionDef(self, node):
        # Arguments and assignments shadow imports throughout a Python function.
        self.scopes[-1][node.name] = f"{module_name(self.path)}.{node.name}"
        for default in node.args.defaults + [d for d in node.args.kw_defaults if d]:
            self.visit(default)
        for decorator in node.decorator_list:
            self.visit(decorator)
        locals_ = {a.arg: None for a in node.args.posonlyargs + node.args.args + node.args.kwonlyargs}
        if node.args.vararg:
            locals_[node.args.vararg.arg] = None
        if node.args.kwarg:
            locals_[node.args.kwarg.arg] = None
        for child in ast.walk(node):
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
                locals_[child.id] = None
        self.scopes.append(locals_)
        for statement in node.body:
            self.visit(statement)
        self.scopes.pop()

    visit_AsyncFunctionDef = visit_FunctionDef


def collect_source(path: str, source: str) -> list[dict]:
    visitor = Uses(path)
    tree = ast.parse(source, filename=path)
    # Preload top-level imports so functions defined before imports resolve correctly.
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            visitor.visit(node)
    visitor.records.clear()
    visitor.visit(tree)
    return visitor.records


def collect(repo=".", base: str | None = None, *, head: str | None = None, main: str | None = None) -> list[dict]:
    main = main or main_ref()
    repo = root(repo)
    base = base or merge_base(repo, head or "HEAD", main)
    records = []
    for path in changed_files(repo, base, head):
        if not path.endswith(".py"):
            continue
        source = read_at(repo, head, path) if head else read_working(repo, path)
        if source is not None:
            records.extend(collect_source(path, source))
    return records
