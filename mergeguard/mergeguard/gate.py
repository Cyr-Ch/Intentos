"""Approvals are human identities bound to one exact head SHA."""
from __future__ import annotations


def evaluate(pr: dict, decision: dict, sync: dict, policy: dict) -> dict:
    eligible = set()
    ignored = []
    author = pr["author"].casefold()
    prompter = (pr.get("prompter") or "").casefold()
    for approval in pr.get("approvals", []):
        user = approval["user"]
        normalized = user.casefold()
        why = None
        if approval.get("kind", "human") != "human" or normalized.endswith("[bot]") or normalized in {"codex", "mergeguard", "dependabot", "github-actions"}:
            why = "bot or agent"
        elif normalized == author:
            why = "PR author"
        elif normalized == prompter and not policy["prompter_counts_as_reviewer"]:
            why = "prompter is not an eligible reviewer"
        elif approval.get("head") != pr["head"]:
            why = "stale approval on an earlier head"
        if why:
            ignored.append({"user": user, "reason": why})
        else:
            eligible.add(normalized)
    required = decision["tier"]
    reasons = []
    ci = pr.get("ci") or {}
    if ci.get("outcome") and ci["outcome"] != "pass":
        reasons.append(f"CI is not green on {pr['head'][:8]} ({ci['outcome']}): " + (", ".join(ci.get("failed") or []) or ci.get("summary", "")))
    if not sync["clean"]:
        reasons += [issue["message"] for issue in sync["issues"]]
    if len(eligible) < required:
        reasons.append(f"Needs {required} distinct human approvals on {pr['head'][:8]}; has {len(eligible)}")
    return {"allowed": not reasons, "required": required, "eligible": sorted(eligible),
            "ignored": ignored, "reasons": reasons}
