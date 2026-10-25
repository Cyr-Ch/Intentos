#!/usr/bin/env python3
"""Materialize a fixture directory as a Git repository with a deterministic history.

Usage:
    python3 python/build_fixture.py <source_dir> <dest_dir> [--force]

History steps come from ``<fixtures>/<source name>.history.json``: a list of
``{"message", "date", "files": {"<dest relative path>": "<path relative to fixtures/>" | null}}``.
A string copies that file into the destination; ``null`` deletes the path.
Author/committer identity and dates are fixed, so the resulting SHAs are the
same on every build. After the last step the tracked tree must be byte-identical
to ``<source_dir>``.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

AUTHOR_NAME = "Fixture Bot"
AUTHOR_EMAIL = "fixture@example.com"
IGNORED_DIRS = {"__pycache__", ".pytest_cache", ".git", ".venv"}


class BuildError(Exception):
    pass


def git(dest: Path, *args: str, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        ["git", "-C", str(dest), *args],
        check=True, capture_output=True, text=True, env=env,
    )
    return result.stdout.strip()


def load_steps(fixtures_dir: Path, source: Path) -> list[dict]:
    history = fixtures_dir / f"{source.name}.history.json"
    if not history.is_file():
        raise BuildError(f"history file not found: {history}")
    steps = json.loads(history.read_text(encoding="utf-8"))
    if not isinstance(steps, list) or not steps:
        raise BuildError(f"{history} must contain a non-empty list of steps")
    return steps


def prepare_dest(dest: Path, source: Path, force: bool) -> None:
    if dest == source or source in dest.parents:
        raise BuildError(f"destination {dest} must not be inside the source fixture {source}")
    if dest.exists() and any(dest.iterdir()):
        if not force:
            raise BuildError(f"destination {dest} exists and is not empty (use --force to replace it)")
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    git(dest, "init", "-q", "-b", "main")
    git(dest, "config", "user.name", AUTHOR_NAME)
    git(dest, "config", "user.email", AUTHOR_EMAIL)
    git(dest, "config", "commit.gpgsign", "false")


def apply_step(dest: Path, fixtures_dir: Path, step: dict) -> None:
    for rel_path, source_rel in step["files"].items():
        target = dest / rel_path
        if source_rel is None:
            if target.is_dir():
                shutil.rmtree(target)
            elif target.exists():
                target.unlink()
            continue
        source_file = fixtures_dir / source_rel
        if not source_file.is_file():
            raise BuildError(f"step {step['message']!r}: source file missing: {source_file}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_file, target)


def commit_step(dest: Path, step: dict) -> str:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": AUTHOR_NAME,
        "GIT_AUTHOR_EMAIL": AUTHOR_EMAIL,
        "GIT_COMMITTER_NAME": AUTHOR_NAME,
        "GIT_COMMITTER_EMAIL": AUTHOR_EMAIL,
        "GIT_AUTHOR_DATE": step["date"],
        "GIT_COMMITTER_DATE": step["date"],
    }
    git(dest, "add", "-A")
    git(dest, "commit", "-q", "--no-verify", "-m", step["message"], env=env)
    return git(dest, "rev-parse", "HEAD")


def source_files(source: Path) -> dict[str, Path]:
    files: dict[str, Path] = {}
    for path in source.rglob("*"):
        rel = path.relative_to(source)
        if any(part in IGNORED_DIRS for part in rel.parts):
            continue
        if path.is_file():
            files[rel.as_posix()] = path
    return files


def verify_tree(dest: Path, source: Path) -> None:
    tracked = set(git(dest, "ls-files").splitlines())
    expected = source_files(source)
    problems: list[str] = []
    for missing in sorted(set(expected) - tracked):
        problems.append(f"missing from built repo: {missing}")
    for extra in sorted(tracked - set(expected)):
        problems.append(f"extra file in built repo: {extra}")
    for rel in sorted(tracked & set(expected)):
        if (dest / rel).read_bytes() != expected[rel].read_bytes():
            problems.append(f"content differs: {rel}")
    if problems:
        raise BuildError("built tree does not match source fixture:\n  " + "\n  ".join(problems))


def build(source: Path, dest: Path, force: bool) -> str:
    if not source.is_dir():
        raise BuildError(f"source fixture not found: {source}")
    fixtures_dir = source.parent
    steps = load_steps(fixtures_dir, source)
    prepare_dest(dest, source, force)
    for step in steps:
        apply_step(dest, fixtures_dir, step)
        sha = commit_step(dest, step)
        print(f"{sha[:12]}  {step['date']}  {step['message']}")
    verify_tree(dest, source)
    return git(dest, "rev-parse", "HEAD")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source_dir", help="fixture directory, e.g. fixtures/startup_billing")
    parser.add_argument("dest_dir", help="where to create the Git repository")
    parser.add_argument("--force", action="store_true", help="delete and recreate a non-empty destination")
    args = parser.parse_args(argv)
    try:
        head = build(Path(args.source_dir).resolve(), Path(args.dest_dir).resolve(), args.force)
    except BuildError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"error: git failed: {' '.join(exc.cmd)}\n{exc.stderr}", file=sys.stderr)
        return 1
    print(head)
    return 0


if __name__ == "__main__":
    sys.exit(main())
