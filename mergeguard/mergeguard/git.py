"""Small, shell-free Git adapter. No operation changes the caller's checkout."""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
from typing import Iterator


class GitError(RuntimeError):
    pass


def run(repo: str | Path, *args: str, check: bool = True, input: str | None = None,
        timeout: float = 30) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], input=input, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_MERGE_AUTOEDIT": "no"},
    )
    if check and result.returncode:
        raise GitError(f"git {' '.join(args[:3])}: {result.stderr.strip()}")
    return result


def git(repo: str | Path, *args: str, **kwargs) -> str:
    return run(repo, *args, **kwargs).stdout.strip()


def root(repo: str | Path = ".") -> Path:
    return Path(git(repo, "rev-parse", "--show-toplevel"))


def sha(repo: str | Path, ref: str) -> str:
    return git(repo, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}")


def main_ref() -> str:
    """The ref main is read from. `origin/main` by default; MERGEGUARD_MAIN names a local branch instead (local mode:
    a checkout plus git worktrees, as IntentOS runs its agents, where refs are shared and nothing is fetched)."""
    return os.environ.get("MERGEGUARD_MAIN") or "origin/main"


def local_mode() -> bool:
    return not main_ref().startswith("origin/")


def main_branch() -> str:
    ref = main_ref()
    return ref[len("origin/"):] if ref.startswith("origin/") else ref


def common_root(repo: str | Path) -> Path:
    """The repository every worktree of `repo` shares: its working tree root, or the bare repository itself."""
    common = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    return common.parent if common.name == ".git" else common


def merge_base(repo: str | Path, first: str = "HEAD", second: str | None = None) -> str:
    return git(repo, "merge-base", sha(repo, first), sha(repo, second or main_ref()))


def metadata_dir(repo: str | Path) -> Path:
    return Path(git(repo, "rev-parse", "--absolute-git-dir")) / "mergeguard"


def fetch(repo: str | Path) -> None:
    if local_mode():
        return
    branch = main_branch()
    git(repo, "fetch", "--quiet", "origin", f"+refs/heads/{branch}:refs/remotes/origin/{branch}", timeout=15)


def files_at(repo: str | Path, ref: str) -> list[str]:
    return [p for p in run(repo, "ls-tree", "-r", "--name-only", "-z", ref).stdout.split("\0") if p]


def read_at(repo: str | Path, ref: str, path: str) -> str | None:
    result = run(repo, "show", f"{ref}:{path}", check=False)
    return result.stdout if result.returncode == 0 else None


def changed_files(repo: str | Path, base: str, head: str | None = None) -> list[str]:
    args = ["diff", "--name-only", "--no-renames", "-z", base]
    if head:
        args.append(head)
    args.append("--")
    paths = set(run(repo, *args).stdout.split("\0"))
    if head is None:
        paths.update(run(repo, "ls-files", "--others", "--exclude-standard", "-z").stdout.split("\0"))
    return sorted(paths - {""})


def read_working(repo: str | Path, path: str) -> str | None:
    file = Path(repo) / path
    if not file.is_file() or file.is_symlink():
        return None
    return file.read_text(encoding="utf-8")


@contextlib.contextmanager
def lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def atomic_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".mergeguard-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def worktree(repo: str | Path, ref: str) -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="mergeguard-") as directory:
        checkout = Path(directory) / "checkout"
        git(repo, "worktree", "add", "--quiet", "--detach", str(checkout), sha(repo, ref))
        try:
            yield checkout
        finally:
            git(repo, "worktree", "remove", "--force", str(checkout), check=False)
