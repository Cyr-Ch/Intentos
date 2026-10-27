"""Hook adapter shared by Codex and Claude Code. Hook errors allow the session; the PR gate fails closed."""
from __future__ import annotations

import json
import os
import re
import sys
import time

from . import howmade, ledger, sync_check
from .git import atomic_json, fetch, lock, main_ref, metadata_dir, root

EVENTS = {"PostToolUse": "post-tool-use", "Stop": "stop", "SessionStart": "session-start"}
SHELL_TOOLS = {"Bash", "exec_command", "shell", "shell_command"}


def fetch_interval() -> float:
    """Seconds between origin fetches after commands (default 60). Stop always fetches."""
    try:
        return max(0.0, float(os.environ.get("MERGEGUARD_FETCH_INTERVAL", "60")))
    except ValueError:
        return 60.0


def phrase(issue: dict) -> str:
    """Evaluation-only: MERGEGUARD_NOTE_STYLE=vague replaces the specific note with the kind of warning research found useless."""
    if os.environ.get("MERGEGUARD_NOTE_STYLE") == "vague":
        return ("Heads up: a teammate recently changed code on main that your branch may depend on. "
                "Make sure your changes are compatible with current main before you finish.")
    return issue["message"]


def command_result(payload: dict) -> tuple[str, int | None]:
    tool_input = payload.get("tool_input") or {}
    command = tool_input.get("command", tool_input.get("cmd", "")) if isinstance(tool_input, dict) else str(tool_input)
    response = payload.get("tool_response")
    if isinstance(response, dict):
        code = response.get("exit_code")
        if code is None and isinstance(response.get("metadata"), dict):
            code = response["metadata"].get("exit_code")
        if isinstance(code, int):
            return command, code
        response = json.dumps(response)
    match = re.search(r"(?:Process exited with code|exit_code[\"']?\s*[:=])\s*(-?\d+)", str(response))
    return command, int(match.group(1)) if match else None


def memory_note(repo) -> str:
    """Session-start memory: recent incidents from the shared ledger, named specifically per folder."""
    from . import breaker
    from .policy import bucket, load
    policy = load(repo)
    events = ledger.read(repo)
    window = policy["breaker"]["window_days"]
    cutoff = time.time() - window * 86400
    incidents: dict[str, dict] = {}
    for event in events:
        if event["type"] not in {"culprit", "clash"}:
            continue
        when = breaker.timestamp(event["ts"])
        if when.timestamp() < cutoff:
            continue
        key = event.get("details", {}).get("incident") or event.get("commit") or f"pr:{event.get('pr')}"
        item = incidents.setdefault(key, {"pr": event.get("pr"), "ts": when, "tests": [], "partner": None, "folders": set()})
        item["ts"] = max(item["ts"], when)
        item["tests"] = item["tests"] or list(event.get("details", {}).get("tests") or [])
        item["partner"] = item["partner"] or event.get("partner_pr")
        item["folders"].update(bucket(path, policy) for path in event.get("paths", []))
    if not incidents:
        return ""
    floors = breaker.status(repo, policy=policy, events=events)["folders"]
    lines = []
    for folder in sorted({folder for item in incidents.values() for folder in item["folders"]}):
        mine = sorted((item for item in incidents.values() if folder in item["folders"]), key=lambda item: item["ts"])
        latest = mine[-1]
        line = f"{folder} broke {len(mine)} time(s) in the last {window} days"
        if folder in floors:
            line += f"; its review floor is now tier {floors[folder]['floor']}"
        line += f". Latest: PR #{latest['pr']}"
        if latest["partner"]:
            line += f" clashed with PR #{latest['partner']}"
        if latest["tests"]:
            line += ", failing " + ", ".join(latest["tests"][:3])
        lines.append("- " + line + ".")
    return ("Memory from the mergeguard ledger:\n" + "\n".join(lines) +
            f"\nBefore relying on anything in those folders, read its current definition on {main_ref()}: "
            "a name can stay the same while its meaning changes.")


def handle(event: str, payload: dict) -> dict:
    if os.environ.get("MERGEGUARD_DISABLE") == "1":
        return {}
    repo = root(payload.get("cwd", "."))
    if event == "session-start":
        note = memory_note(repo)
        return {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": note}} if note else {}
    directory = metadata_dir(repo)
    state_path = directory / "state.json"
    with lock(directory / "hooks.lock"):
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        if event == "post-tool-use":
            if payload.get("tool_name", "Bash") not in SHELL_TOOLS:
                return {}
            command, code = command_result(payload)
            if not re.search(r"\bmergeguard\s+run\b", command):
                howmade.append(repo, "command", cmd=command, exit_code=code)
        if event == "stop" or time.time() - state.get("fetched_at", 0) >= fetch_interval():
            # Record attempts too so a disconnected laptop does not retry on every command.
            state["fetched_at"] = time.time()
            atomic_json(state_path, state)
            fetch(repo)
        result = sync_check.check(repo)
        if event == "stop":
            # MERGEGUARD_DISABLE_STOP is an evaluation-only ablation: notes without the stop gate.
            if not result["clean"] and not payload.get("stop_hook_active", False) and os.environ.get("MERGEGUARD_DISABLE_STOP") != "1":
                howmade.append(repo, "stop_block", issues=[issue["id"] for issue in result["issues"]])
                return {"decision": "block", "reason": "\n".join(phrase(i) for i in result["issues"])}
            return {}
        if os.environ.get("MERGEGUARD_DISABLE_NOTES") == "1":
            return {}  # evaluation-only ablation: the stop gate without notes during the task
        session = payload.get("session_id", "unknown")
        delivered = set(state.get("delivered", {}).get(session, []))
        notes = []
        for issue in result["issues"]:
            # Same symbol can break again in a later commit; deliver that new incident.
            key = f"{issue['id']}@{issue['commit']}"
            if key in delivered:
                continue
            delivered.add(key)
            text = phrase(issue)
            notes.append(text)
            howmade.append(repo, "sync_note", issue_id=issue["id"], message=text, commit=issue["commit"],
                           style=os.environ.get("MERGEGUARD_NOTE_STYLE", "specific"))
            ledger.append(repo, type="sync_note", commit=issue["commit"], paths=sorted({p.rsplit(":", 1)[0] for p in issue["used_in"]}),
                          details={"issue_id": issue["id"], "message": text})
        state.setdefault("delivered", {})[session] = sorted(delivered)
        atomic_json(state_path, state)
        return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "\n".join(notes)}} if notes else {}


def main() -> int:
    if os.environ.get("MERGEGUARD_DISABLE") == "1":
        print("{}")
        return 0
    payload = {}
    try:
        payload = json.load(sys.stdin)
        event = sys.argv[1] if len(sys.argv) > 1 else EVENTS.get(payload.get("hook_event_name"), "")
        if event not in EVENTS.values():
            raise ValueError(f"Unsupported hook event: {event}")
        output = handle(event, payload)
    except Exception as exc:
        output = {}
        message = f"mergeguard hook allowed action after error: {type(exc).__name__}: {exc}"
        print(message, file=sys.stderr)
        try:
            directory = metadata_dir(payload.get("cwd", "."))
            directory.mkdir(parents=True, exist_ok=True)
            with (directory / "errors.log").open("a") as stream:
                stream.write(message + "\n")
        except Exception:
            pass
    print(json.dumps(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
