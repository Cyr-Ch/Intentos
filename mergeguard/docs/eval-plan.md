# Overnight evaluation plan

Goal: make every claim on the slides rest on more runs, show which component carries the effect, and find the limits before the interviewer does. Every number lands in `eval/results.md` via `eval/render.py`; raw logs under `eval/runs/`; each phase is committed when it finishes. Nothing is hand-edited.

Budget guard: Haiku runs cost about a cent each, Sonnet about ten; Codex is limited by the ChatGPT usage window, so its runs are last and failures are recorded, not retried in a loop.

## Phase 1 · Ablations: which part of the harness carries the effect (Haiku, K=3, 5 scenarios, 5 arms, 75 runs)

The research claim behind the design is that vague coordination is worthless and specificity is everything. Test it on our own runs with three new arms, all evaluation-only switches in the hook adapter:

- **vague**: the same hooks deliver "a teammate changed code on main that your branch may depend on; check before you finish" instead of the exact symbol, file, line and commit.
- **stop-only**: no notes during the task; only the Stop gate.
- **notes-only**: notes during the task; the Stop gate never blocks.

Compared with baseline and the full harness on: main left broken, clashes caught, extra tool calls, stop blocks, agent ignoring the note. Shows whether specificity and the second layer each matter, in numbers.

## Phase 2 · Statistical weight on the headline (Haiku K=10, 100 runs; Sonnet K=3, 30 runs)

Same two arms, more repeats, with 95% Wilson intervals on "main left broken" and "clash caught" in the table. Turns 12/15 into a rate with an interval.

## Phase 3 · Sync check at scale: precision, recall, latency (deterministic, no model)

Generate synthetic repos (50–200 modules, hundreds of symbols), inject random renames, moves, signature changes and uses with known ground truth, run the sync check, report precision and recall per change kind, plus the documented blind spots (dynamic import, method on unknown type) as measured misses. Benchmark hook latency at each repo size, cached and uncached; the design requires under one second cached.

## Phase 4 · Realistic task mix for the no-reviewer share (Haiku K=2, Sonnet K=1, 20 tasks)

Twenty typical small tasks (docstring, comment, README, typo, new test, new helper, refactor an existing function, change behavior, a change in payments, a rename) run by real agents; route each resulting PR; report the tier split, approvals versus a flat rule, and whether any tier-0 PR changed existing behavior (checked by running the base tests on it). Answers "what share of ordinary agent work skips review" on a broader mix than task B, and whether agents that "just add a comment" stay AST-equivalent.

## Phase 5 · Guardian limits (deterministic)

- Flaky tests with 10%, 30%, 50% failure probability, 10 runs each: labelling accuracy and wrong-blame rate. The 3× rerun rule has a known failure mode at high flake rates; measure it.
- Histories of 100–300 commits: bisect steps and time to report.
- A deliberately non-monotonic clash (the failure appears, disappears, reappears along main): the partner search must report "unresolved" rather than guess.
- An ordinary defect (not a clash) on a long history: culprit named, no partner, undo opened.

## Phase 6 · Codex, more repeats (K=3, 30 runs; quota permitting, scheduled late)

Repeats the Codex arm; records quota failures honestly. Adds per-model note compliance and cost to the model comparison.

## Phase 7 · Cheap additions to the results page

Time to healthy main per arm from existing logs; dollar cost per arm where the CLI reports it; a per-model table (Haiku, Sonnet, Codex): notes acted on, extra tool calls, cost.

## Phase 8 · If time remains: five agents on one main

Extend the world to N clones; five Haiku agents on mixed tasks against one origin; breaks, notes, PR-check blocks, throughput. The stress version of the two-laptop story.

## Morning

A summary at the top of `BUILD_LOG.md`: what ran, what the numbers say, what failed, and which slide cells changed.
