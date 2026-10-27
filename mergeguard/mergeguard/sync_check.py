"""Intersect main's API changes with this branch's actual imports and calls."""
from __future__ import annotations

from . import changes, uses
from .git import fetch as fetch_origin, main_ref, merge_base, root, sha


def incompatible(parameters: list[dict], call: dict) -> list[str]:
    positional = [p for p in parameters if p["kind"] in {"posonly", "positional"}]
    named = {p["name"]: p for p in parameters if p["kind"] in {"positional", "kwonly"}}
    has_varargs = any(p["kind"] == "varargs" for p in parameters)
    has_kwargs = any(p["kind"] == "kwargs" for p in parameters)
    count, keywords = call["positional"], set(call["keywords"])
    errors = []
    if count > len(positional) and not has_varargs:
        errors.append(f"too many positional arguments ({count}, accepts {len(positional)})")
    unknown = keywords - named.keys()
    if unknown and not has_kwargs:
        errors.append("unknown keyword(s): " + ", ".join(sorted(unknown)))
    assigned = {p["name"] for p in positional[:count]}
    duplicate = assigned & keywords & named.keys()
    if duplicate:
        errors.append("multiple values for: " + ", ".join(sorted(duplicate)))
    for param in parameters:
        if not param["required"]:
            continue
        name, kind = param["name"], param["kind"]
        if name in assigned or (kind != "posonly" and name in keywords):
            continue
        if call.get("starargs") and kind in {"posonly", "positional"}:
            continue
        if call.get("starkwargs") and kind in {"positional", "kwonly"}:
            continue
        errors.append(f"missing required argument: {name}")
    return errors


def call_errors(change: dict, call: dict) -> list[str]:
    errors = incompatible(change["new_signature"], call)
    old = [p["name"] for p in change["old_signature"] if p["kind"] in {"posonly", "positional"}]
    new = [p["name"] for p in change["new_signature"] if p["kind"] in {"posonly", "positional"}]
    for index, name in enumerate(old[:call["positional"]]):
        if name in new and new.index(name) != index:
            errors.append(f"positional argument {index + 1} used to bind {name}; it now binds {new[index] if index < len(new) else '*args'}")
    return errors


def check(repo=".", *, fetch: bool = False, head: str | None = None, main: str | None = None) -> dict:
    repo = root(repo)
    main = main or main_ref()
    if fetch:
        fetch_origin(repo)
    main_sha = sha(repo, main)
    base = merge_base(repo, head or "HEAD", main_sha)
    delta = changes.detect(repo, base, main_sha)
    used = uses.collect(repo, base, head=head, main=main_sha)
    issues = []
    for change in delta:
        sites = [site for site in used if site["symbol"] == change["symbol"]]
        errors = []
        if change["change"] == "signature_changed":
            sites = [site for site in sites if site["call"] and call_errors(change, site)]
            errors = sorted({reason for site in sites for reason in call_errors(change, site)})
        # Prefer actual calls over imports when explaining the required edit.
        calls = [site for site in sites if site["call"]]
        sites = calls or sites
        if not sites:
            continue
        locations = sorted({f"{s['path']}:{s['line']}" for s in sites})
        symbol, new, kind = change["symbol"], change["new"], change["change"]
        if kind in {"renamed", "moved"}:
            explanation = f"`{symbol}` was {kind} to `{new}`"
            action = f"Update the import and calls to use `{new}`"
        elif kind == "removed":
            explanation = f"`{symbol}` was removed (no unambiguous replacement found)"
            action = f"Replace the use of `{symbol}` with a supported API on main"
        else:
            explanation = f"`{symbol}` changed signature: " + "; ".join(errors)
            required = [p["name"] for p in change["new_signature"] if p["required"]]
            action = (f"Update the call to match the new signature (required: {', '.join(required) or 'none'}); take any new "
                      "required value from how main's own code and tests call it, and if none is evident, stop and say so rather than guess")
        # The first step is explicit: agents that edited the call without syncing left a branch that could not even import the new name.
        message = (f"While you were working, main changed: {explanation} in commit {change['commit'][:8]}. "
                   f"Your code uses it at {', '.join(locations)}. First bring main into your branch (git merge {main_ref()}), "
                   f"then {action[0].lower() + action[1:]}, re-run the tests, then finish.")
        issues.append({"id": f"{symbol}:{kind}", "symbol": symbol, "change": kind, "new": new,
                       "commit": change["commit"], "used_in": locations, "message": message})
    return {"clean": not issues, "base": base, "main": main_sha, "issues": issues}
