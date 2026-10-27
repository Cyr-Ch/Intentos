from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest

from mergeguard import breaker, ledger
from mergeguard.demo import POLICY

NOW = datetime(2026, 10, 27, tzinfo=timezone.utc)


def event(kind, commit, days=0, path="invoices/total.py", **extra):
    return {"type": kind, "ts": (NOW - timedelta(days=days)).isoformat(), "commit": commit,
            "pr": commit, "paths": [path], "details": {}, **extra}


def test_ledger_concurrent_append_preserves_records(tmp_path):
    path = tmp_path / "ledger.jsonl"
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda i: ledger.append(path=path, type="merged", pr=i), range(30)))
    assert len(ledger.read(path=path)) == 30
    with path.open("a") as stream:
        stream.write("corrupted\n")
    with pytest.raises(ValueError, match="line 31"):
        ledger.read(path=path)


def test_two_distinct_incidents_trip_not_culprit_plus_revert():
    events = [event("culprit", "a", 2), event("reverted", "a", 1)]
    assert breaker.status(policy=POLICY, events=events, at=NOW)["folders"] == {}
    events += [event("culprit", "b")]
    result = breaker.status(policy=POLICY, events=events, at=NOW)
    assert result["folders"]["invoices/"]["floor"] == 2


def test_longest_policy_path_and_capped_tier():
    policy = {**POLICY, "always_two": ["payments/", "payments/cards/"]}
    events = [event("culprit", c, path="payments/cards/charge.py") for c in ("a", "b")]
    result = breaker.status(policy=policy, events=events, at=NOW)
    assert result["folders"]["payments/cards/"]["floor"] == 2


def test_cooldown_only_suggests_and_reviewed_reset_clears():
    events = [event("culprit", "a", 25), event("culprit", "b", 24)]
    assert breaker.status(policy=POLICY, events=events, at=NOW)["folders"]["invoices/"]["cooldown_complete"]
    assert any("cooldown" in s for s in breaker.suggest(policy=POLICY, events=events, at=NOW))
    reset_policy = {**POLICY, "breaker": {**POLICY["breaker"], "resets": {"invoices/": (NOW - timedelta(days=1)).isoformat()}}}
    assert not breaker.status(policy=reset_policy, events=events, at=NOW)["folders"]


def test_twenty_clean_merges_suggest_never_apply():
    events = [event("merged", str(i), 1) for i in range(20)]
    assert len(breaker.suggest(policy=POLICY, events=events, at=NOW)) == 1
    assert breaker.status(policy=POLICY, events=events, at=NOW)["automatic_loosening"] is False
    events.append(event("culprit", "bad"))
    assert not breaker.suggest(policy=POLICY, events=events, at=NOW)
