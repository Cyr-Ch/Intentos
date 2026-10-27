from datetime import timedelta
import sys

import pytest

from mergeguard import breaker, howmade
from mergeguard.demo import POLICY
from mergeguard.git import sha, worktree, metadata_dir
from mergeguard.policy import load
from mergeguard.sync_check import check
from test_ledger_breaker import NOW, event


def test_positional_reordering_is_specific_but_keywords_stay_compatible(repo_factory):
    repo = repo_factory({"api.py": "def f(uid, org): return uid\n"})
    repo.main_change({"api.py": "def f(org, uid): return uid\n"})
    repo.write("caller.py", "from api import f\nf(7, 'acme')\n")
    assert "used to bind uid" in check(repo.path)["issues"][0]["message"]
    repo.write("caller.py", "from api import f\nf(uid=7, org='acme')\n")
    assert check(repo.path)["clean"]


def test_delayed_undo_cannot_erase_historical_breaker_trip():
    events = [event("culprit", "a", 25), event("culprit", "b", 24), event("reverted", "a", 1)]
    assert breaker.status(policy=POLICY, events=events, at=NOW)["folders"]["invoices/"]["floor"] == 2


def test_invalid_policy_fails_closed(repo_factory):
    repo = repo_factory({".mergeguard/policy.yaml": "zero_review_allowed: absolutely\n"})
    with pytest.raises(ValueError, match="boolean"):
        load(repo.path)


def test_worktree_has_own_hook_state_and_preserves_user_checkout(repo_factory):
    repo = repo_factory()
    repo.write("uncommitted.txt", "keep me\n")
    with worktree(repo.path, "HEAD") as checkout:
        assert metadata_dir(checkout) != metadata_dir(repo.path)
        assert sha(checkout, "HEAD") == repo.base
    assert (repo.path / "uncommitted.txt").read_text() == "keep me\n"


def test_run_receipt_records_real_failure(repo_factory):
    repo = repo_factory()
    assert howmade.run_command(repo.path, [sys.executable, "-c", "raise SystemExit(7)"]) == 7
    assert howmade.read(repo.path)[0]["exit_code"] == 7


def test_binary_documentation_does_not_need_python_decoding(repo_factory):
    from mergeguard.router import route
    repo = repo_factory()
    (repo.path / "docs").mkdir()
    (repo.path / "docs/diagram.png").write_bytes(b"\x89PNG\xff\x00")
    head = repo.commit()
    assert route(repo.path, repo.base, head, "engineer_b")["tier"] == 0


def test_imported_private_change_attribution_survives_unrelated_edits(repo_factory):
    from mergeguard.changes import detect
    repo = repo_factory({"api.py": "def _f(x): return x\n", "caller.py": "from api import _f\n"})
    repo.main_change({"api.py": "# comment\ndef _f(x): return x\n"})
    changed = repo.main_change({"api.py": "def _f(x, y): return x\n"})
    assert detect(repo.path, repo.base, "origin/main")[0]["commit"] == changed
