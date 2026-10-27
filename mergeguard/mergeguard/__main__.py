"""CLI with machine-readable JSON and stable exit codes: 0 pass, 1 blocked, 2 error."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


def parser():
    cli = argparse.ArgumentParser(prog="mergeguard", description="Main is the meeting point.")
    cli.add_argument("--repo", default=".", help="Repository to inspect (default: current directory)")
    commands = cli.add_subparsers(dest="command", required=True)
    changes = commands.add_parser("changes", help="Detect Python API changes between two refs")
    changes.add_argument("old_ref")
    changes.add_argument("new_ref")
    uses = commands.add_parser("uses", help="Resolve imports and calls in branch-changed files")
    uses.add_argument("--base")
    sync = commands.add_parser("sync-check", help="Check changed code against current main")
    sync.add_argument("--fetch", action="store_true")
    sync.add_argument("--head", help="Check committed head instead of the working tree")
    sync.add_argument("--main", help="Ref main is read from (default: MERGEGUARD_MAIN or origin/main)")
    route = commands.add_parser("route", help="Route a diff to zero, one, or two human reviewers")
    for flag in ("base", "head", "author"):
        route.add_argument("--" + flag, required=True)
    route.add_argument("--howmade", type=Path)
    route.add_argument("--policy-ref", help="Trusted policy ref (defaults to base)")
    guardian = commands.add_parser("guardian", help="Reproduce, bisect, identify a clash, and open an undo PR")
    guardian.add_argument("--good", required=True)
    guardian.add_argument("--bad", required=True)
    guardian.add_argument("--test")
    guardian.add_argument("--no-undo", action="store_true")
    breaker = commands.add_parser("breaker", help="Inspect automatic floors or human-only loosening suggestions")
    breaker.add_argument("action", choices=["status", "suggest"])
    report = commands.add_parser("report", help="Print Markdown; optionally write a self-contained HTML report")
    report.add_argument("--html")
    run = commands.add_parser("run", help="Run a command and log its exact exit status as how-made evidence")
    run.add_argument("argv", nargs=argparse.REMAINDER)
    pr = commands.add_parser("pr", help="Offline PR simulation against a local bare origin")
    operations = pr.add_subparsers(dest="operation", required=True)
    opening = operations.add_parser("open")
    opening.add_argument("--branch", required=True)
    opening.add_argument("--title", required=True)
    opening.add_argument("--author")
    opening.add_argument("--prompter")
    opening.add_argument("--min-tier", type=int, default=0, help="A review tier the caller already requires; diff rules can only raise it")
    opening.add_argument("--min-tier-reason")
    approve = operations.add_parser("approve")
    approve.add_argument("number", type=int)
    approve.add_argument("--user", required=True)
    approve.add_argument("--kind", choices=["human", "bot", "agent"], default="human")
    for action in ("merge", "check", "show"):
        operations.add_parser(action).add_argument("number", type=int)
    operations.add_parser("list")
    hooks = commands.add_parser("hooks", help="Install or remove the agent hook files in a worktree (Codex and Claude Code)")
    hooks.add_argument("action", choices=["install", "remove", "trust", "home"])
    hooks.add_argument("directory", type=Path)
    hooks.add_argument("--python", help="Interpreter the hook commands run with (default: this one)")
    hooks.add_argument("--auth-from", type=Path, help="home: auth.json to link into the private CODEX_HOME (default: the current one)")
    for sub in (changes, uses, sync, route, guardian, breaker, report, hooks):
        sub.add_argument("--json", action="store_true")
    for sub in operations.choices.values():
        sub.add_argument("--json", action="store_true")
    return cli


def execute(args):
    from . import breaker, changes, guardian, prs, report, router, sync_check, uses
    repo = args.repo
    code = 0
    if args.command == "changes":
        result = changes.detect(repo, args.old_ref, args.new_ref)
    elif args.command == "uses":
        result = uses.collect(repo, args.base)
    elif args.command == "sync-check":
        result = sync_check.check(repo, fetch=args.fetch, head=args.head, main=args.main)
        code = 0 if result["clean"] else 1
    elif args.command == "route":
        result = router.route(repo, args.base, args.head, args.author, howmade_data=args.howmade.read_text() if args.howmade else None, policy_ref=args.policy_ref)
    elif args.command == "guardian":
        result = guardian.investigate(repo, good=args.good, bad=args.bad, test=args.test, undo=not args.no_undo)
        code = 2 if result["status"] in {"inconclusive", "undo_conflict", "undo_failed"} else 0
    elif args.command == "breaker":
        result = breaker.status(repo) if args.action == "status" else breaker.suggest(repo)
    elif args.command == "report":
        if args.json:
            result = report.data(repo)
        else:
            return report.generate(repo, args.html), 0
    elif args.command == "hooks":
        from .demo import codex_trust_override, hook_config, remove_hooks, write_codex_home, write_hooks
        if args.action == "install":
            files = write_hooks(args.directory, hook_config(args.python))
            result = {"files": [str(f) for f in files], "trust_override": codex_trust_override(args.directory)}
        elif args.action == "home":
            files = write_codex_home(args.directory, hook_config(args.python), auth_from=args.auth_from)
            result = {"codex_home": str(Path(args.directory).resolve()), "files": [str(f) for f in files],
                      "trust_override": codex_trust_override(args.directory, hooks_file=files[0])}
        elif args.action == "remove":
            result = {"removed": [str(f) for f in remove_hooks(args.directory)]}
        else:
            result = {"trust_override": codex_trust_override(args.directory)}
    elif args.operation == "open":
        result = prs.open_pr(repo, args.branch, args.title, author=args.author, prompter=args.prompter,
                             min_tier=args.min_tier, min_tier_reason=args.min_tier_reason)
    elif args.operation == "approve":
        result = prs.approve(repo, args.number, args.user, kind=args.kind)
    elif args.operation == "merge":
        result = prs.merge(repo, args.number)
    elif args.operation == "check":
        result = prs.refresh(repo, args.number)
        code = 0 if result["gate"]["allowed"] else 1
    elif args.operation == "show":
        result = prs.get(repo, args.number)
    else:
        result = list(prs.read(repo)["prs"].values())
    return result, code


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.command == "run":
            from .howmade import run_command
            return run_command(args.repo, args.argv)
        result, code = execute(args)
    except (RuntimeError, ValueError, KeyError, OSError, SyntaxError) as exc:
        if getattr(args, "json", False):
            print(json.dumps({"error": str(exc)}))
        else:
            print(f"mergeguard: {exc}", file=sys.stderr)
        return 2
    if isinstance(result, str):
        print(result, end="" if result.endswith("\n") else "\n")
    elif getattr(args, "json", False):
        print(json.dumps(result, indent=2))
    elif isinstance(result, dict) and "message" in result:
        print(result["message"])
    elif args.command == "sync-check":
        print("Sync clean." if result["clean"] else "\n".join(i["message"] for i in result["issues"]))
    elif isinstance(result, dict) and "tier" in result:
        print(f"Tier {result['tier']} · {result['required_approvals']} human approval(s)")
        print("\n".join("- " + reason for reason in result["reasons"]))
    elif isinstance(result, dict) and "number" in result:
        print(f"PR #{result['number']} · {result['state']} · tier {result['decision']['tier']} · " + ("gate ready" if result['gate']['allowed'] else "gate blocked"))
        print(result["body"])
        for reason in result["gate"]["reasons"]:
            print(reason)
    else:
        print(json.dumps(result, indent=2))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
