"""Policy is read from a trusted base ref, never from the PR's working tree."""
from copy import deepcopy
import os
from pathlib import Path

import yaml

from .git import main_ref, read_at, sha


DEFAULT = {
    "trusted_authors": [], "always_two": ["payments/", ".github/workflows/", ".mergeguard/", ".codex/", ".claude/"],
    "always_one": [], "zero_review_allowed": True, "zero_review_additive": False, "prompter_counts_as_reviewer": False, "api_break_tier": 2,
    "breaker": {"window_days": 7, "strikes_to_trip": 2, "cooldown_days": 14},
}


def load(repo, ref=None) -> dict:
    """The trusted policy: `.mergeguard/policy.yaml` on main, or the file MERGEGUARD_POLICY_FILE names, which keeps
    policy outside the repository the agents edit (how IntentOS holds its trusted configuration)."""
    explicit = os.environ.get("MERGEGUARD_POLICY_FILE")
    if explicit:
        text = Path(explicit).expanduser().read_text(encoding="utf-8")
    else:
        text = read_at(repo, sha(repo, ref or main_ref()), ".mergeguard/policy.yaml")
    data = yaml.safe_load(text) if text else {}
    if not isinstance(data, dict):
        raise ValueError("Policy must be a YAML mapping")
    result = deepcopy(DEFAULT)
    result.update(data)
    result["breaker"] = {**DEFAULT["breaker"], **data.get("breaker", {})}
    for key in ("trusted_authors", "always_one", "always_two"):
        if not isinstance(result[key], list) or not all(isinstance(x, str) for x in result[key]):
            raise ValueError(f"Policy {key} must be a list of strings")
    for key in ("zero_review_allowed", "zero_review_additive", "prompter_counts_as_reviewer"):
        if not isinstance(result[key], bool):
            raise ValueError(f"Policy {key} must be boolean")
    if result["api_break_tier"] not in (0, 1, 2) or isinstance(result["api_break_tier"], bool):
        raise ValueError("Policy api_break_tier must be 0, 1, or 2")
    for key in ("window_days", "strikes_to_trip", "cooldown_days"):
        if not isinstance(result["breaker"][key], int) or result["breaker"][key] < 1:
            raise ValueError(f"Policy breaker.{key} must be a positive integer")
    return result


def matches(path: str, rule: str) -> bool:
    rule = rule.rstrip("/")
    return path == rule or path.startswith(rule + "/")


def base_tier(path: str, policy: dict) -> int:
    if any(matches(path, rule) for rule in policy["always_two"]):
        return 2
    # Folders that are not expressly protected have the standard code tier.
    return 1


def bucket(path: str, policy: dict) -> str:
    candidates = [rule for rule in policy["always_one"] + policy["always_two"] if matches(path, rule)]
    if candidates:
        return max(candidates, key=len).rstrip("/") + "/"
    return path.split("/")[0] + "/" if "/" in path else "./"
