"""Append-only, locked JSONL incident history shared by the offline laptops."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path

from .git import git, lock, metadata_dir


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def ledger_path(repo=".") -> Path:
    explicit = os.environ.get("MERGEGUARD_LEDGER")
    if explicit:
        return Path(explicit).expanduser().resolve()
    state_dir = os.environ.get("MERGEGUARD_STATE_DIR")
    if state_dir:
        return Path(state_dir).expanduser().resolve() / "ledger.jsonl"
    origin = git(repo, "remote", "get-url", "origin", check=False)
    local = Path(origin).expanduser()
    if not local.is_absolute():
        local = Path(repo) / local
    if origin and local.is_dir():
        return local.resolve().parent / ".mergeguard-ledger.jsonl"
    return metadata_dir(repo) / "ledger.jsonl"


def read(repo=".", *, path: Path | None = None) -> list[dict]:
    path = path or ledger_path(repo)
    if not path.exists():
        return []
    with lock(path.with_suffix(".lock")):
        rows = []
        for number, line in enumerate(path.read_text().splitlines(), 1):
            if not line.strip():
                continue
            try:
                event = json.loads(line)
                if not isinstance(event, dict) or "ts" not in event or "type" not in event:
                    raise ValueError("missing ts/type")
                rows.append(event)
            except (json.JSONDecodeError, ValueError) as exc:
                raise ValueError(f"Invalid ledger {path}, line {number}: {exc}") from exc
        return rows


def append(repo=".", *, path: Path | None = None, **event) -> dict:
    path = path or ledger_path(repo)
    event = {"ts": now(), "paths": [], "details": {}, **event}
    if "type" not in event:
        raise ValueError("Ledger event needs a type")
    path.parent.mkdir(parents=True, exist_ok=True)
    with lock(path.with_suffix(".lock")):
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(event, sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
    return event
