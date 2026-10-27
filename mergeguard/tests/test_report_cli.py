import json
import subprocess
import sys

from mergeguard import prs, report
from mergeguard.demo import commit, write
from mergeguard.git import git


def test_report_escapes_untrusted_titles(world):
    b = world / "engineer_b"
    git(b, "checkout", "-b", "docs")
    write(b, "README.md", "Docs\n")
    commit(b, "Docs")
    prs.open_pr(b, "docs", "<script>alert('x')</script>")
    data = report.data(b)
    page = report.html(data)
    assert "<script>alert" not in page
    assert "&lt;script&gt;" in page
    assert "Tier" in report.markdown(data)


def test_cli_exit_codes_and_json(repo_factory):
    repo = repo_factory()
    repo.main_change({"users.py": "def fetch_user(uid):\n    return uid\n"})
    repo.write("account.py", "import users\nusers.get_user(3)\n")
    result = subprocess.run([sys.executable, "-m", "mergeguard", "--repo", str(repo.path), "sync-check", "--json"], capture_output=True, text=True)
    assert result.returncode == 1
    assert not json.loads(result.stdout)["clean"]
    result = subprocess.run([sys.executable, "-m", "mergeguard", "--repo", str(repo.path), "changes", "missing", "HEAD", "--json"], capture_output=True, text=True)
    assert result.returncode == 2 and "error" in json.loads(result.stdout)
