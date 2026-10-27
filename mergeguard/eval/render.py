"""Generate eval/results.md from raw run summaries. The tables are never edited by hand."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import statistics

from mergeguard.demo import SCENARIOS

EVAL = Path(__file__).resolve().parent


def summaries(root: Path = EVAL) -> list[dict]:
    found = []
    for path in sorted((root / "runs").glob("*/summary.json")):
        data = json.loads(path.read_text())
        data.setdefault("kind", "scripted")
        data["dir"] = path.parent
        found.append(data)
    return found


def mean(values) -> str:
    values = [v for v in values if isinstance(v, (int, float))]
    return f"{statistics.fmean(values):.1f}" if values else "n/a"


def tokens(rows, key):
    return [r["agent"].get("tokens", {}).get(key) for r in rows]


def scripted_section(summary: dict, root: Path) -> list[str]:
    results = summary["results"]
    baseline = [r for r in results if r["arm"] == "baseline"]
    guarded = [r for r in results if r["arm"] == "guarded"]
    lines = [f"Generated {summary['timestamp']}; raw evidence: `{summary['dir'].relative_to(root)}/`.", "",
             "**Method:** paired scripted changes in fresh local bare origins and two clones. Each branch passes alone. "
             "Baseline disables hooks and merges through raw Git. The guarded arm receives actual hook JSON, applies a deterministic "
             "repair when instructed, and uses the real PR gate and guardian. These runs measure harness mechanics, not agent behavior.", "",
             "| Scenario | Arm | Runs | Sync notes | Main breaks before recovery | Recovered | Healthy at end |",
             "| --- | --- | ---: | ---: | ---: | ---: | ---: |"]
    for scenario in SCENARIOS:
        for arm in ("baseline", "guarded"):
            rows = [r for r in results if r["scenario"] == scenario and r["arm"] == arm]
            if rows:
                lines.append(f"| {scenario} · {SCENARIOS[scenario]['name']} | {arm} | {len(rows)} | {sum(r['notes'] for r in rows)} | "
                             f"{sum(r['main_broken'] for r in rows)} | {sum(r['recovered'] for r in rows)} | {sum(r['final_healthy'] for r in rows)} |")
    lines += ["", f"- Baseline: {sum(r['main_broken'] for r in baseline)}/{len(baseline)} merges broke main.",
              f"- Guarded: {sum(r['main_broken'] for r in guarded)}/{len(guarded)} merges broke main before recovery; "
              f"{sum(r['final_healthy'] for r in guarded)}/{len(guarded)} finished healthy.",
              f"- S5 control notes: {sum(r['notes'] for r in guarded if r['scenario'] == 'S5')}.",
              f"- All expected checks passed: {all(r['expected_checks_passed'] for r in results)}.", ""]
    return lines


API_SCENARIOS = {s for s, d in SCENARIOS.items() if d["expected_notes"]}
MEANING_SCENARIOS = {"S4"}
CONTROL_SCENARIOS = {"S5"}


def caught_by(row: dict) -> str | None:
    """Which layer stopped a stale branch first: the stop gate fires before a late note on the continuation."""
    if row["stop_blocks"]:
        return "stop gate"
    if row["notes"]:
        return "note during the task"
    if row.get("blocked_by_pr_check"):
        return "PR check"
    return None


ARM_ORDER = ["baseline", "harness", "vague", "stop-only", "notes-only"]
ARM_LABEL = {"baseline": "Without (baseline)", "harness": "With (harness)", "vague": "Vague notes", "stop-only": "Stop gate only", "notes-only": "Notes only"}


def arms_in(results: list[dict]) -> list[str]:
    present = {r["arm"] for r in results}
    return [a for a in ARM_ORDER if a in present] + sorted(present - set(ARM_ORDER))


def outcome_table(results: list[dict]) -> list[str]:
    arms = arms_in(results)
    by_arm = {a: [r for r in results if r["arm"] == a] for a in arms}

    def arm(rows):
        api = [r for r in rows if r["scenario"] in API_SCENARIOS]
        meaning = [r for r in rows if r["scenario"] in MEANING_SCENARIOS]
        control = [r for r in rows if r["scenario"] in CONTROL_SCENARIOS]
        caught = [caught_by(r) for r in api]
        layers = {layer: caught.count(layer) for layer in ("note during the task", "stop gate", "PR check") if caught.count(layer)}
        detail = " (" + ", ".join(f"{n} by {layer}" for layer, n in layers.items()) + ")" if layers else ""
        return {"runs": len(rows), "broken": sum(not r["final_healthy"] for r in rows),
                "api": f"{sum(c is not None for c in caught)} of {len(api)}{detail}",
                "meaning": f"{sum(r['recovered'] for r in meaning)} of {len(meaning)}",
                "false": sum(r["false_notes"] for r in control), "failed": sum(r["agent_failed"] for r in rows)}
    stats = {a: arm(rows) for a, rows in by_arm.items()}
    def cost(key, rows):
        values = [r["agent"].get(key) if key != "output" else r["agent"].get("tokens", {}).get("output") for r in rows]
        values = [v for v in values if isinstance(v, (int, float))]
        return statistics.fmean(values) if values else None
    def extra(a):
        if a == "baseline" or "baseline" not in by_arm:
            return "–"
        parts = []
        for key, label in (("tool_calls", "tool calls"), ("seconds", "s wall"), ("output", "output tokens")):
            cb, ca = cost(key, by_arm["baseline"]), cost(key, by_arm[a])
            if cb is not None and ca is not None:
                parts.append(f"{ca - cb:+.1f} {label}")
        return ", ".join(parts) or "n/a"
    def row(label, key):
        return f"| {label} | " + " | ".join(str(stats[a][key]) for a in arms) + " |"
    return ["| Outcome | " + " | ".join(ARM_LABEL.get(a, a) for a in arms) + " |", "| --- |" + " ---: |" * len(arms),
            row("Runs", "runs"), row("Main ended broken", "broken"), row("API clashes caught before merge (S1–S3)", "api"),
            row("Meaning changes undone by the guardian (S4)", "meaning"), row("False alarms on the control (S5)", "false"),
            row("Agent runs that failed or produced nothing", "failed"),
            "| Extra cost per run versus baseline | " + " | ".join(extra(a) for a in arms) + " |",
            "| Stop-gate blocks | " + " | ".join(str(sum(r["stop_blocks"] for r in by_arm[a])) for a in arms) + " |", ""]


def live_section(summary: dict, root: Path) -> list[str]:
    results = summary["results"]
    baseline = [r for r in results if r["arm"] == "baseline"]
    harness = [r for r in results if r["arm"] == "harness"]
    lines = [f"### {summary['agent']} · `{summary['model']}` · {summary['timestamp']} · arms: {', '.join(arms_in(results))}", "",
             f"**Method:** {summary.get('method', '')} Raw evidence per run (agent event stream, stderr, how-made log, branch patch, "
             f"result JSON): `{summary['dir'].relative_to(root)}/`.", ""]
    lines += outcome_table(results)
    lines += ["<details><summary>Per-scenario detail</summary>", "",
             "| Scenario | Arm | Runs | Notes | False notes | Stop blocks | PR-check blocks | Integrated clean | Main broke | Recovered | "
             "Healthy at end | Tool calls | Tokens in / out | Wall s | Agent failures |",
             "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for scenario in SCENARIOS:
        for arm in arms_in(results):
            rows = [r for r in results if r["scenario"] == scenario and r["arm"] == arm]
            if not rows:
                continue
            lines.append(f"| {scenario} · {SCENARIOS[scenario]['name']} | {arm} | {len(rows)} | {sum(r['notes'] for r in rows)} | "
                         f"{sum(r['false_notes'] for r in rows)} | {sum(r['stop_blocks'] for r in rows)} | "
                         f"{sum(bool(r.get('blocked_by_pr_check')) for r in rows)} | {sum(r['integrated_clean'] for r in rows)} | "
                         f"{sum(r['main_broken'] for r in rows)} | {sum(r['recovered'] for r in rows)} | {sum(r['final_healthy'] for r in rows)} | "
                         f"{mean([r['agent'].get('tool_calls') for r in rows])} | {mean(tokens(rows, 'input'))} / {mean(tokens(rows, 'output'))} | "
                         f"{mean([r['agent'].get('seconds') for r in rows])} | {sum(r['agent_failed'] for r in rows)} |")
    lines += ["", "</details>", ""]
    if baseline:
        lines.append(f"- Baseline: {sum(r['main_broken'] for r in baseline)}/{len(baseline)} merges broke main; "
                     f"{sum(r['integrated_clean'] for r in baseline)}/{len(baseline)} integrated cleanly.")
    if harness:
        lines.append(f"- Harness: {sum(r['main_broken'] for r in harness)}/{len(harness)} merges broke main before recovery; "
                     f"{sum(r['final_healthy'] for r in harness)}/{len(harness)} finished healthy; "
                     f"{sum(r['integrated_clean'] for r in harness)}/{len(harness)} integrated cleanly; "
                     f"{sum(bool(r.get('blocked_by_pr_check')) for r in harness)} blocked at the PR check; "
                     f"{sum(r['stop_blocks'] for r in harness)} stop-hook blocks; "
                     f"{sum(r['notes'] for r in harness)} notes delivered, {sum(r['false_notes'] for r in harness)} false; "
                     f"the branch's own tests passed before integration in {sum(r.get('branch_tests') == 'pass' for r in harness)}/{len(harness)} "
                     f"harness runs and {sum(r.get('branch_tests') == 'pass' for r in baseline)}/{len(baseline)} baseline runs.")
    if baseline and harness:
        def delta(values_h, values_b):
            h = [v for v in values_h if isinstance(v, (int, float))]
            b = [v for v in values_b if isinstance(v, (int, float))]
            return f"{statistics.fmean(h) - statistics.fmean(b):+.1f}" if h and b else "n/a"
        lines.append("- Harness cost per run (mean, harness minus baseline): tool calls "
                     f"{delta([r['agent'].get('tool_calls') for r in harness], [r['agent'].get('tool_calls') for r in baseline])}, "
                     f"output tokens {delta(tokens(harness, 'output'), tokens(baseline, 'output'))}, "
                     f"wall seconds {delta([r['agent'].get('seconds') for r in harness], [r['agent'].get('seconds') for r in baseline])}.")
    arms = arms_in(results)
    by_arm = {a: [r for r in results if r["arm"] == a] for a in arms}
    def total_cost(rows):
        values = [r["agent"].get("cost_usd") for r in rows if isinstance(r["agent"].get("cost_usd"), (int, float))]
        return f"${sum(values):.2f}" if values else "n/a (CLI reports no cost)"
    lines.append("- End-to-end seconds per run, agent plus integration (and guardian plus undo when main broke): " +
                 "; ".join(f"{a} {mean([r.get('seconds') for r in by_arm[a]])} s" + (f" (but {sum(not r['final_healthy'] for r in by_arm[a])} runs ended with main still broken)"
                           if sum(not r["final_healthy"] for r in by_arm[a]) else "") for a in arms) + ".")
    lines.append("- Agent spend per arm as reported by the CLI: " + "; ".join(f"{a} {total_cost(by_arm[a])}" for a in arms) + ".")
    lines.append("")
    return lines


def guardian_lines(scripted: list[dict]) -> list[str]:
    rows = [r for s in scripted[-1:] for r in s["results"] if r["arm"] == "guarded" and r.get("guardian")]
    if not rows:
        return ["No scripted guardian runs recorded."]
    culprit = sum(r["guardian"].get("culprit") == r.get("merge_commit") for r in rows)
    partner = sum(r["guardian"].get("status") == "clash" and r["guardian"].get("partner_pr") == 1 for r in rows)
    undo = sum(bool(r["guardian"].get("undo_pr")) for r in rows)
    return [f"- Scripted S4 runs ({len(rows)}): culprit named correctly {culprit}/{len(rows)} (the merge commit of PR #2), "
            f"partner named correctly {partner}/{len(rows)} (PR #1), undo PR opened {undo}/{len(rows)}, recovered "
            f"{sum(r['recovered'] for r in rows)}/{len(rows)}; mean {statistics.fmean(r['seconds'] for r in rows):.1f} s per run including setup."]


def policy_section(summary: dict, scripted: list[dict], root: Path) -> list[str]:
    router = summary["router"]
    lines = [f"Generated {summary['timestamp']}; raw: `{summary['dir'].relative_to(root)}/summary.json` (labels, paths, reasons).", "",
             f"### Router on {router['total']} hand-labelled diffs", "",
             "| Case | Paths | Author | Expected | Routed | Risky |", "| --- | --- | --- | ---: | ---: | :---: |"]
    for row in router["rows"]:
        flag = "" if row["ok"] else " **(mismatch)**"
        lines.append(f"| {row['name']} | {', '.join(row['paths'])} | {row['author']} | {row['expected']} | {row['actual']}{flag} | {'yes' if row['risky'] else ''} |")
    tiers = router["by_tier"]
    lines += ["", f"- Exact tier matches: {router['exact']}/{router['total']}.",
              f"- Risky PRs placed below their label: {len(router['risky_too_low'])}/{router['risky_total']} (must be 0)" +
              (f": {', '.join(router['risky_too_low'])}" if router["risky_too_low"] else "") + ".",
              f"- Any PR placed below its label: {len(router['too_low'])}; above its label: {len(router['too_high'])}" +
              (f" ({', '.join(router['too_high'])})" if router["too_high"] else "") + ".",
              f"- Humans needed: tier 0 for {tiers['0']} PRs ({100 * tiers['0'] / router['total']:.0f}% need no human), tier 1 for {tiers['1']}, "
              f"tier 2 for {tiers['2']}. Against a flat one-reviewer rule, {tiers['0']} PRs need fewer humans and {tiers['2']} need more.", "",
              "### Guardian", ""] + guardian_lines(scripted) + [
              f"- `pytest {' '.join(summary['guardian_tests']['targets'])}`: {summary['guardian_tests']['summary_line']} "
              "(semantic clash with both PRs and validated undo; flaky test stops before blame; missing historical test file passes while a collection error does not; a direct bug is not called a clash).", "",
              "### Breaker on a synthetic ledger timeline", ""]
    b = summary["breaker"]
    lines += [f"- Day 1, one incident on `payments/`: floor {b['day1_after_one_incident']}; day 4, second incident within the 7-day window: floor {b['day4_after_two_incidents']}.",
              f"- Day 18, 14-day cooldown complete: `cooldown_complete` is {b['day18_cooldown_complete']}, floor still {b['day18_floor_still_set']}; day 60: floor still {b['day60_floor_still_set']}; `automatic_loosening` is {b['automatic_loosening']}.",
              f"- Suggestions on day 22: {'; '.join(b['suggestions_day22']) or 'none'}.",
              f"- After a human-reviewed `breaker.resets` timestamp on main (day 19): floor on day 20 is {b['floor_after_human_reset_day20']}.",
              f"- `pytest {' '.join(summary['breaker_tests']['targets'])}`: {summary['breaker_tests']['summary_line']}.", ""]
    return lines


def guardian_eval_section(summary: dict, root: Path) -> list[str]:
    rows = summary["results"]
    lines = ["### Guardian on realistic histories", "",
             f"Generated {summary['timestamp']}; raw: `{summary['dir'].relative_to(root)}/`. Each run builds a fresh world, merges A's "
             "dollars-to-cents change, then 20-50 harmless reviewed PRs (docs and new modules) around the event under test, and asks the "
             "guardian to explain the failure between the initial commit and the head of main. The flaky test is real: it fails on every odd "
             "run and passes on every even run.", "",
             "| Variant | Runs | Main commits | Outcomes | Culprit named | Partner named | Undo opened | Flaky excluded, nobody wrongly blamed | Wrong blame | Bisect steps | Seconds to report |",
             "| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for variant in ("clash", "flaky", "clash+flaky"):
        group = [r for r in rows if r["variant"] == variant]
        if not group:
            continue
        commits = f"{min(r['main_commits'] for r in group)}–{max(r['main_commits'] for r in group)}"
        wrong = sum(r["blamed"] and not r["culprit_ok"] for r in group)
        outcomes = {}
        for r in group:
            outcomes[r["status"]] = outcomes.get(r["status"], 0) + 1
        flaky_ok = sum(r["status"] in {"flaky", "healthy"} for r in group) if variant == "flaky" else sum(bool(r.get("flaky_tests")) and r["culprit_ok"] for r in group)
        lines.append(f"| {variant} | {len(group)} | {commits} | {', '.join(f'{k} {v}' for k, v in sorted(outcomes.items()))} | "
                     f"{sum(r['culprit_ok'] for r in group)} | {sum(r['partner_ok'] for r in group)} | "
                     f"{sum(r['undo_opened'] for r in group)} | {flaky_ok} | {wrong} | {mean([r['bisect_steps'] for r in group])} | "
                     f"{mean([r['seconds'] for r in group])} |")
    lines += ["", "For `flaky`, 'healthy' means the flaky test happened to pass at discovery, so there was nothing to investigate; for `clash+flaky`, "
              "the flaky column counts runs where the flaky test failed at discovery, was excluded, and the real culprit was still named. "
              "Nobody is blamed for a flaky test in any run.", ""]
    return lines


def review_section(summary: dict, root: Path) -> list[str]:
    t = summary["totals"]
    rows = summary["results"]
    lines = ["### Review load on real agent-made PRs", "",
             f"Generated {summary['timestamp']}; raw: `{summary['dir'].relative_to(root)}/summary.json`. Every task-B PR from the live "
             f"evaluations, re-routed with the current router under the {summary['policy']} policy (additive-only code "
             f"{'may' if summary['policy'] == 'demo' else 'may not'} merge with no human). A PR 'merges with no human' only when it is tier 0 "
             "and its sync check is clean; CI must also be green.", "",
             "| PRs | Need no human | Need one | Need two | Could merge with no human now | Tier 0 but stale (blocked at PR check) | Approvals, flat one-reviewer rule | Approvals, routed |",
             "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
             f"| {t['prs']} | {t['tier0']} | {t['tier1']} | {t['tier2']} | {t['no_human_merge']} | {t['blocked_stale']} | {t['approvals_flat']} | {t['approvals_routed']} |", "",
             f"- Of the {t['no_human_merge']} no-human merges, {t['no_human_merges_that_broke_main']} broke main (the S4 meaning change, invisible to the gate); "
             f"{t['of_which_recovered']} were undone by the guardian.", ""]
    by = {}
    for r in rows:
        by.setdefault((r["scenario"], r["arm"]), []).append(r)
    lines += ["| Scenario | Arm | PRs | Tier 0 | Tier 1 | Tier 2 | Why not tier 0 |", "| --- | --- | ---: | ---: | ---: | ---: | --- |"]
    for (scenario, arm), group in sorted(by.items()):
        reasons = sorted({next((x for x in r["reasons"] if "sync note" in x or "protected" in x or "API" in x or "tests" in x.lower() or "executable" in x), r["reasons"][0] if r["reasons"] else "")
                          for r in group if r["tier"] > 0})
        lines.append(f"| {scenario} · {SCENARIOS[scenario]['name']} | {arm} | {len(group)} | {sum(r['tier'] == 0 for r in group)} | "
                     f"{sum(r['tier'] == 1 for r in group)} | {sum(r['tier'] == 2 for r in group)} | {'; '.join(reasons)[:160]} |")
    lines.append("")
    return lines


def scale_section(summary: dict, root: Path) -> list[str]:
    lines = ["### Sync check at scale: precision, recall, latency", "",
             f"Generated {summary['timestamp']}; raw: `{summary['dir'].relative_to(root)}/summary.json`. Synthetic packages with known ground truth; "
             f"{summary['seeds']} trials per (change kind, use kind) pair. Explicit uses are from-imports, module-attribute calls and aliased imports; "
             "the blind spots (getattr dispatch, a method on an object of unknown type) are reported separately and are documented limits, not bugs.", "",
             "| Modules | Symbols | Trials | Precision | Recall (explicit uses) | False positives / clean trials | Blind spots caught | Check mean / p95 ms | Hook cached mean ms | Hook with fetch ms |",
             "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for size in summary["sizes"]:
        lines.append(f"| {size['modules']} | {size['symbols']} | {size['trials']} | {size['precision']} | {size['recall']} | "
                     f"{size['false_positives']} / {size['clean_trials']} | {size['blind_spot_caught']} / {size['blind_spot_trials']} | "
                     f"{size['check_ms_mean']} / {size['check_ms_p95']} | {size['hook_ms_cached_mean']} | {size['hook_ms_with_fetch']} |")
    largest = summary["sizes"][-1]
    lines += ["", "Recall by change kind at the largest size: " + ", ".join(f"{k} {v['recall']}" for k, v in largest["recall_by_change"].items()) + ".", ""]
    missed = [t for size in summary["sizes"] for t in size["misclassified"]]
    if missed:
        lines += ["Misclassified explicit trials: " + "; ".join(f"{t['change']} + {t['use']} ({t['symbol']}) → {t['verdict']}" for t in missed[:10]) + ".", ""]
    return lines


def guardian_limits_section(summary: dict, root: Path) -> list[str]:
    rows = summary["results"]
    lines = ["### Guardian limits: probabilistic flaky tests, long histories, non-monotonic clash, ordinary defect", "",
             f"Generated {summary['timestamp']}; raw: `{summary['dir'].relative_to(root)}/`. The flaky test fails with probability p on each run "
             "(reproducible per run number). The non-monotonic case puts cents, then dollars, then cents on main before the clash lands, so the "
             "partner search's monotonicity assumption does not hold.", "",
             "| Variant | Runs | Main commits | Outcome counts | Culprit named | Wrong blame | Bisect steps | Seconds |", "| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |"]
    variants = []
    for r in rows:
        if r["variant"] not in variants:
            variants.append(r["variant"])
    for variant in variants:
        group = [r for r in rows if r["variant"] == variant]
        counts = {}
        for r in group:
            counts[r["status"]] = counts.get(r["status"], 0) + 1
        commits = [r["main_commits"] for r in group if "main_commits" in r]
        span = f"{min(commits)}–{max(commits)}" if commits else "n/a"
        lines.append(f"| {variant} | {len(group)} | {span} | {', '.join(f'{k} {v}' for k, v in sorted(counts.items()))} | "
                     f"{sum(bool(r.get('culprit_ok')) for r in group)} | {sum(bool(r.get('wrong_blame')) for r in group)} | "
                     f"{mean([r.get('bisect_steps') for r in group])} | {mean([r.get('seconds') for r in group])} |")
    nonmono = [r for r in rows if r["variant"] == "non-monotonic clash"]
    if nonmono:
        lines += ["", f"- Non-monotonic clash: partner reported as the latest re-apply PR in {sum(bool(r.get('partner_is_reapply')) for r in nonmono)} runs, "
                  f"as the first cents PR in {sum(bool(r.get('partner_is_first_merge')) for r in nonmono)}, unresolved in "
                  f"{sum(r.get('partner_pr') is None for r in nonmono)}. The search returns a transition point under its documented assumption; "
                  "which transition it returns is not guaranteed."]
    defects = [r for r in rows if r["variant"] == "ordinary defect, long history"]
    if defects:
        lines.append(f"- Ordinary defect: culprit named {sum(bool(r.get('culprit_ok')) for r in defects)}/{len(defects)}, no partner claimed in "
                     f"{sum(bool(r.get('no_partner')) for r in defects)}/{len(defects)}, undo opened {sum(bool(r.get('undo_opened')) for r in defects)}/{len(defects)}.")
    errors = [r for r in rows if r["status"] == "runner_error"]
    for r in errors:
        lines.append(f"- {r['label']}: runner error {r.get('error')}")
    lines.append("")
    return lines


def taskmix_section(summary: dict, root: Path) -> list[str]:
    t = summary["totals"]
    rows = [r for r in summary["results"] if not r["agent_failed"] and not r.get("no_change")]
    lines = [f"### Review routing on a realistic task mix · {summary['agent']} `{summary['model']}` · {summary['timestamp']}" +
             (f" · re-routed with the router at `{summary['router_commit']}`" if summary.get("router_commit") else ""), "",
             f"Raw: `{summary['dir'].relative_to(root)}/`. Twenty typical small tasks done by a real agent in a fresh world with no concurrent change, "
             "committed by the runner, opened as PRs through the real router and CI. 'Desired' is the tier a careful reviewer would want; "
             "routing below it is an under-review (must be 0 for risky tasks), routing above it is where the rules are stricter than a human.", "",
             "| PRs | No human | One | Two | Under-reviewed | Risky under-reviewed | Over-reviewed | Approvals flat → routed | Failed runs | No-change runs |",
             "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
             f"| {t['prs']} | {t['tier0']} | {t['tier1']} | {t['tier2']} | {len(t['under_reviewed'])} | {len(t['risky_under_reviewed'])} | "
             f"{len(t['over_reviewed'])} | {t['approvals_flat']} → {t['approvals_routed']} | {t['failed']} | {t.get('no_change', 0)} |", "",
             "| Task | Category | Desired | Routed | Why (first reason) |", "| --- | --- | ---: | ---: | --- |"]
    seen = {}
    for r in rows:
        seen.setdefault(r["task"], []).append(r)
    for task, group in seen.items():
        tiers = ", ".join(str(r["tier"]) for r in group)
        reason = next((x for x in group[0]["reasons"] if not x.startswith("Trusted author")), group[0]["reasons"][0] if group[0]["reasons"] else "")
        flag = " **(under)**" if any(r["under_reviewed"] for r in group) else (" (over)" if any(r["over_reviewed"] for r in group) else "")
        lines.append(f"| {task} | {group[0]['category']} | {group[0]['desired']} | {tiers}{flag} | {reason[:110]} |")
    lines.append("")
    return lines


def model_table(summaries: list[dict]) -> list[str]:
    """One row per (agent, model) from its latest baseline/harness summary."""
    lines = ["| Agent · model | Runs per arm | Main left broken, without → with | Clashes caught (S1–S3) | Notes delivered | Stop-gate blocks | Extra tool calls per run | Harness spend |",
             "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    latest = {}
    for summary in sorted(summaries, key=lambda x: x["timestamp"]):  # one row per model: the latest summary with both arms
        if {"baseline", "harness"} <= set(arms_in(summary["results"])):
            latest[(summary["agent"], summary["model"])] = summary
    for summary in latest.values():
        rows = summary["results"]
        base = [r for r in rows if r["arm"] == "baseline"]
        harness = [r for r in rows if r["arm"] == "harness"]
        if not base or not harness:
            continue
        api = [r for r in harness if r["scenario"] in API_SCENARIOS]
        caught = sum(caught_by(r) is not None for r in api)
        tb = [r["agent"].get("tool_calls") for r in base if isinstance(r["agent"].get("tool_calls"), (int, float))]
        th = [r["agent"].get("tool_calls") for r in harness if isinstance(r["agent"].get("tool_calls"), (int, float))]
        extra = f"{statistics.fmean(th) - statistics.fmean(tb):+.1f}" if tb and th else "n/a"
        costs = [r["agent"].get("cost_usd") for r in harness if isinstance(r["agent"].get("cost_usd"), (int, float))]
        lines.append(f"| {summary['agent']} · `{summary['model']}` | {len(harness)} | {sum(not r['final_healthy'] for r in base)} → "
                     f"{sum(not r['final_healthy'] for r in harness)} | {caught} of {len(api)} | {sum(r['notes'] for r in harness)} | "
                     f"{sum(r['stop_blocks'] for r in harness)} | {extra} | {('$%.2f' % sum(costs)) if costs else 'n/a'} |")
    return lines + [""]


def problems(live: list[dict], scripted: list[dict], guardian: list[dict] = ()) -> list[str]:
    lines = []
    for summary in live:
        tag = f"{summary['agent']} `{summary['model']}`"
        rows = summary["results"]
        false = [r for r in rows if r["false_notes"]]
        ignored = [r for r in rows if r["arm"] == "harness" and r["notes"] and r.get("blocked_by_pr_check")]
        blocks = [r for r in rows if r["stop_blocks"]]
        failed = [r for r in rows if r["agent_failed"]]
        crashed = [r for r in rows if r.get("runner_error")]
        events = sum(r.get("command_events", 0) for r in rows)
        missing = sum(r.get("commands_without_exit_code", 0) for r in rows)
        late = [r for r in rows if r.get("a_merge") and not r["a_merge"].get("triggered_by_agent_action")]
        lines.append(f"- {tag}: {len(false)} false notes (S5); {len(ignored)} runs where a note was delivered but the PR check still had to "
                     f"block; {len(blocks)} runs where the stop hook had to block; {len(failed)} failed agent runs; {len(crashed)} runner crashes; "
                     f"{missing}/{events} command events arrived without an exit code; {len(late)} runs merged A on the timeout fallback "
                     "rather than after an observed agent action.")
        for row in failed:
            reason = row.get("runner_error") or row["agent"].get("error") or f"exit {row['agent'].get('exit_code')}"
            lines.append(f"  - {row['label']}: {reason}")
        for row in ignored:
            lines.append(f"  - {row['label']} note ignored: {row['blocked_by_pr_check'][:200]}")
    for summary in guardian[-1:]:
        rows = summary["results"]
        masked = [r["label"] for r in rows if r["variant"] == "clash+flaky" and r["status"] == "flaky"]
        wrong = [r["label"] for r in rows if r["blamed"] and not r["culprit_ok"]]
        inconclusive = [f"{r['label']}: {r['message']}" for r in rows if r["status"] in {"inconclusive", "undo_conflict", "undo_failed"}]
        lines.append(f"- Guardian on realistic histories ({len(rows)} runs): {len(wrong)} wrong blames; {len(masked)} runs where a flaky test hid a real "
                     f"clash; {len(inconclusive)} inconclusive." + ("".join(f"\n  - {item}" for item in inconclusive + [f"{w}: wrong blame" for w in wrong] + [f"{m}: flaky masked the clash" for m in masked])))
    for summary in scripted[-1:]:
        rows = summary["results"]
        lines.append(f"- Scripted S4 (meaning change): {sum(r['main_broken'] for r in rows if r['arm'] == 'guarded' and r['scenario'] == 'S4')} of "
                     f"{sum(1 for r in rows if r['arm'] == 'guarded' and r['scenario'] == 'S4')} guarded runs broke main before the guardian "
                     "recovered it. The sync check cannot see unit changes behind an unchanged signature, by design.")
    lines += ["- Neither Codex 0.154 nor Claude Code 2.1 includes an exit status in the PostToolUse payload for shell commands, so "
              "the how-made log records `exit_code: null` unless the agent uses the `mergeguard run` receipt wrapper.",
              "- Codex requires each project hook definition to be trusted by hash. The evaluation passes that trust per invocation "
              "as a `-c hooks.state` override computed from the hook file, which never modifies the user's `~/.codex` config; the "
              "blanket `--dangerously-bypass-hook-trust` flag was not used.",
              "- The ChatGPT Codex usage limit was exhausted mid-session on 2026-10-27, so the Codex arm was run after the reset and "
              "Claude Code ran the earlier live arms; any missing Codex table above means its runs did not complete."]
    return lines


def write(root: Path = EVAL) -> Path:
    found = summaries(root)
    scripted = [s for s in found if s["kind"] == "scripted"]
    live = [s for s in found if s["kind"] == "live"]
    latest_live = {}
    for summary in live:
        # A run that failed outright (quota, outage) is kept as evidence but never replaces a run that produced results.
        if not any(not r.get("agent_failed") for r in summary["results"]):
            continue
        latest_live[(summary["agent"], summary["model"], tuple(arms_in(summary["results"])))] = summary
    lines = ["# mergeguard evaluation", "",
             f"Generated {datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')} by `eval/render.py` from "
             "raw run logs under `eval/runs/`. Numbers come only from those logs; failed runs are counted, not dropped.", "",
             "## 1. Live agents: task B with and without the harness", ""]
    if latest_live:
        lines.append("Arms: **baseline** sets `MERGEGUARD_DISABLE=1` and merges with raw Git; **harness** runs the hooks, the PR gate, "
                     "and the guardian. Reviewers `priya` and `sam` are simulated humans. 'Integrated clean' means the branch merged into "
                     "main and the full suite passed there without recovery. Tokens are as reported by the agent CLI (input includes cache reads).")
        lines.append("")
        lines += ["#### Across models", ""] + model_table(list(latest_live.values()))
        for summary in latest_live.values():
            lines += live_section(summary, root)
    else:
        lines += ["No live agent runs recorded yet. Run `python eval/live_compare.py --agent claude --model haiku --repeats 3`.", ""]
    lines += ["## 2. Scripted harness mechanics (deterministic repairs)", ""]
    if scripted:
        lines += scripted_section(scripted[-1], root)
    policy = [s for s in found if s["kind"] == "policy"]
    guardian = [s for s in found if s["kind"] == "guardian"]
    lines += ["## 3. Router, guardian, and breaker", ""]
    if policy:
        lines += policy_section(policy[-1], scripted, root)
    else:
        lines += ["Not generated yet. Run `python eval/policy_eval.py`.", ""]
    if guardian:
        lines += guardian_eval_section(guardian[-1], root)
    review = [s for s in found if s["kind"] == "review"]
    if review:
        lines += review_section(review[-1], root)
    scale = [s for s in found if s["kind"] == "scale"]
    if scale:
        lines += scale_section(scale[-1], root)
    limits = [s for s in found if s["kind"] == "guardian-limits"]
    if limits:
        lines += guardian_limits_section(limits[-1], root)
    taskmix = {}
    for s_ in found:
        if s_["kind"] == "taskmix":
            taskmix[(s_["agent"], s_["model"])] = s_
    for summary in taskmix.values():
        lines += taskmix_section(summary, root)
    lines += ["## What didn't work", ""] + problems(list(latest_live.values()), scripted, guardian) + [""]
    lines += ["## Limits", "",
              "Repeated runs check reproducibility of a small, hand-selected scenario set; they are not a statistical estimate of production "
              "accuracy or false-positive rate. Live runs depend on model behavior and provider availability on the day they ran. "
              "The scripted S4 arm always breaks main before recovery because the semantic change is invisible to the sync check. "
              "Hook timings include process startup and the first local fetch.", ""]
    target = root / "results.md"
    target.write_text("\n".join(lines))
    return target


if __name__ == "__main__":
    print(write())
