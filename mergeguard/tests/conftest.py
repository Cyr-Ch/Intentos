from pathlib import Path

import pytest
import yaml

from mergeguard.git import git, sha
from mergeguard.demo import POLICY, commit, write


class Repository:
    def __init__(self, directory, files):
        self.path = directory
        directory.mkdir()
        git(directory, "init", "--initial-branch=main")
        git(directory, "config", "user.name", "engineer_b")
        git(directory, "config", "user.email", "engineer_b@example.test")
        write(directory, ".mergeguard/policy.yaml", yaml.safe_dump(POLICY))
        for path, source in files.items():
            write(directory, path, source)
        self.base = commit(directory, "Base")
        git(directory, "update-ref", "refs/remotes/origin/main", self.base)
        git(directory, "checkout", "-b", "feature")

    def write(self, path, source):
        write(self.path, path, source)

    def commit(self, message="Change"):
        return commit(self.path, message)

    def main_change(self, files):
        git(self.path, "checkout", "main")
        for path, source in files.items():
            if source is None:
                (self.path / path).unlink()
            else:
                self.write(path, source)
        head = self.commit("Main changed")
        git(self.path, "update-ref", "refs/remotes/origin/main", head)
        git(self.path, "checkout", "feature")
        return head


@pytest.fixture
def repo_factory(tmp_path, monkeypatch):
    monkeypatch.delenv("MERGEGUARD_DISABLE", raising=False)
    monkeypatch.delenv("MERGEGUARD_LEDGER", raising=False)
    count = 0
    def create(files=None):
        nonlocal count
        count += 1
        return Repository(tmp_path / f"repo-{count}", files or {"users.py": "def get_user(uid):\n    return uid\n"})
    return create


@pytest.fixture
def world(tmp_path, monkeypatch):
    from mergeguard.demo import setup
    monkeypatch.delenv("MERGEGUARD_DISABLE", raising=False)
    monkeypatch.delenv("MERGEGUARD_LEDGER", raising=False)
    folder = tmp_path / "world"
    setup(folder)
    return folder
