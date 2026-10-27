"""Reconstruct review floors from incidents; never lower them automatically."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

from . import ledger
from .policy import base_tier, bucket, load


def timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def status(repo=".", *, policy: dict | None = None, events: list[dict] | None = None,
           at: datetime | None = None) -> dict:
    policy = policy if policy is not None else load(repo)
    events = events if events is not None else ledger.read(repo)
    at = at or datetime.now(timezone.utc)
    config = policy["breaker"]
    strikes = defaultdict(dict)
    for event in events:
        if event["type"] not in {"culprit", "reverted"} or timestamp(event["ts"]) > at:
            continue
        # Undoing the same culprit is one incident, not two independent failures.
        identity = event.get("details", {}).get("incident") or event.get("commit") or f"pr:{event.get('pr')}"
        for path in event.get("paths", []):
            folder = bucket(path, policy)
            reset = config.get("resets", {}).get(folder)
            date = timestamp(event["ts"])
            if reset and date <= timestamp(reset):
                continue
            strikes[folder][identity] = min(strikes[folder].get(identity, date), date)
    folders = {}
    for folder, incidents in sorted(strikes.items()):
        dates = sorted(incidents.values())
        tripped = any(sum(start <= d <= start + timedelta(days=config["window_days"]) for d in dates)
                      >= config["strikes_to_trip"] for start in dates)
        recent = sum(d >= at - timedelta(days=config["window_days"]) for d in dates)
        cooldown_complete = at - dates[-1] >= timedelta(days=config["cooldown_days"])
        if tripped:
            folders[folder] = {"floor": min(2, base_tier(folder, policy) + 1), "strikes": recent,
                               "last_strike": dates[-1].isoformat(), "cooldown_complete": cooldown_complete,
                               "reason": f"{folder}: incident cluster raised the minimum review tier" +
                               ("; cooldown complete, human-approved policy reset required" if cooldown_complete else "")}
    return {"folders": folders, "automatic_loosening": False}


def suggest(repo=".", *, policy=None, events=None, at=None) -> list[str]:
    policy = policy if policy is not None else load(repo)
    events = events if events is not None else ledger.read(repo)
    at = at or datetime.now(timezone.utc)
    clean = defaultdict(set)
    struck = set()
    incident_ids = {e.get("pr") for e in events if e["type"] in {"culprit", "reverted"}}
    for event in events:
        if not at - timedelta(days=30) <= timestamp(event["ts"]) <= at:
            continue
        for path in event.get("paths", []):
            folder = bucket(path, policy)
            if event["type"] in {"culprit", "reverted"}:
                struck.add(folder)
            if event["type"] == "merged" and event.get("pr") not in incident_ids:
                clean[folder].add(event.get("commit") or event.get("pr"))
    suggestions = [f"{folder}: {len(commits)} clean merges and zero strikes in 30 days; consider a human-reviewed lower floor."
                   for folder, commits in sorted(clean.items()) if len(commits) >= 20 and folder not in struck]
    for folder, state in status(repo, policy=policy, events=events, at=at)["folders"].items():
        if state["cooldown_complete"]:
            suggestions.append(f"{folder}: cooldown complete; a human may approve a breaker.resets policy timestamp on main.")
    return suggestions
