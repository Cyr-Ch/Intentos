---
name: intentos-policy-mining
description: Mine a repository's tests, git history, documents and structure for the business rules it already follows, pick or write a test that proves each one, and submit them to IntentOS (MCP tool `propose`) for a person to approve. Use when asked to bring a repository under IntentOS, find its business logic, or produce policy candidates. Not for implementing features or fixing bugs.
---

# IntentOS policy mining

You are producing **policy candidates**: rules the repository already follows, which a person will approve into the
IntentOS policy. Every approved invariant becomes a hidden test that the verifier runs against future changes, so each
candidate needs a test that proves the rule at the current revision. You propose; a person decides. Never approve,
reject or edit a candidate on the reviewer's behalf, and never pad the list with rules you cannot back with evidence.

## Before you start

1. Call `status` with the absolute repository path. If it is not onboarded, call `onboard` and poll `status` until
   `phase` is `done`. Onboarding creates the venv your tests will run in, writes the draft policy and indexes the
   repository.
2. Call `mined`. It returns the deterministic miner's raw list: rule-like tests with ready-made hidden-test drafts,
   fix commits, must/never sentences from documents, layer imports and frozen directories. It is a starting point with
   noise, not the answer. Keep the ids: a proposal can cite one with `from_mined` and inherit its evidence and test.

## What counts as a business rule

Keep a candidate when a user of the software would notice if it broke and the rule can be stated in domain terms:

- a validation or guard: "a cancelled contract gets no discount", "negative load factors raise a warning";
- an arithmetic or conservation rule: "the yearly profile sums to the annual demand";
- a required side effect: "a frame computed without holidays warns";
- a format or protocol commitment: "the CSV export ends with a TOTAL line";
- a boundary that protects a design decision: "the API package never imports persistence" (kind `architecture_rule`).

Drop:

- implementation details (a helper being used, a variable renamed, a refactor);
- tooling and environment (CI, packaging, versions, linters, test infrastructure, dependency pins);
- restatements of what the code happens to do with no reason behind them;
- duplicates: when several tests prove one rule, make one candidate and cite the other tests as evidence.

Aim for 8 to 20 candidates. Fewer good ones beat a long list.

## Where to look, in this order

1. **Tests** (strongest evidence). `grep -rn "def test_" tests/` and read names and assertions. Names containing
   never, always, must, only, raises, warns, invalid, empty, negative, zero or limit usually guard a rule. Read the
   test body to state the rule precisely, then read the production code it exercises.
2. **Git history.** `git log --no-merges --format='%h %s' -n 500`; for subjects with fix, regression, guard, validate,
   reject, must, never, always, ensure, warn or limit, run `git show --stat <sha>` and read the diff. A fix commit
   says what broke and therefore what must hold; its diff shows the guard. A rule fixed twice is a strong candidate.
3. **Documents.** README, docs/, CHANGELOG, ADRs: sentences with must, never, always, only, required, invalid or
   not allowed. Cite the file and the line.
4. **Structure.** The import graph between top-level packages (which layer imports which), directories untouched for
   a year, modules everything depends on. These give `architecture_rule` and `frozen_paths` candidates; they need no
   test because the scope check enforces them.

Prefer rules corroborated by two sources: a test and the commit that added it, a document sentence and a test.

## Writing a candidate

- `statement`: one sentence, active voice, domain terms: "<subject> must | never <behaviour> [when <condition>]".
  Every identifier you use (function, class, constant) must appear in the evidence you cite.
- `evidence`: one to eight items, each with `type` (`test`, `commit`, `doc`, `adr`, `changelog`, `import`,
  `history`), a real `ref` (`tests/test_x.py::TestY::test_z`, a commit sha, `docs/x.md:12`) and an `excerpt` quoting
  the source line. IntentOS checks that the file, line and commit exist; a proposal with an invented reference is
  rejected.
- `applies_to_paths`: globs of the production code the rule governs (`src/pkg/module.py`, `src/pkg/sub/**`). Not
  test paths.
- `category`: `business_rule` or `robustness_rule`. `rationale`: one or two sentences on why a user would notice.
  `confidence` and `relevance`: `high`, `medium` or `low`.
- `kind`: `invariant` (needs a test), `architecture_rule` (needs `rule`, for example
  `{"kind": "forbidden_import", "paths": ["src/pkg/api/**"], "forbidden_modules": ["pkg.persistence"]}`),
  `frozen_paths` (`rule`: `{"kind": "frozen_paths", "paths": ["src/pkg/legacy/**"]}`), or `decision` (an ADR-style
  statement with `sources`).
- `sources` (decisions, and rules a document states): the documents the rule cites, as
  `[{"path": "docs/adr-001-pricing.md", "heading": "Decision"}]`; a bare path string is accepted too.

## The test

Every invariant needs `test`, one of:

- `{"existing": "tests/test_x.py::TestY::test_z"}` when a test in the repository already proves the rule. IntentOS
  lifts it with its imports, fixtures and class setup, and runs the original at the current revision. A test that
  fails there is rejected: either the rule is not established or the repository is broken, and you tell the reviewer
  which.
- `{"source": "<a complete pytest module>"}` when nothing proves the rule yet (typical for rules found in commits
  or documents). Requirements: import from the installed package only, no path hacks, no helpers from the repository's
  tests directory, no conftest fixtures; deterministic (fixed dates, no randomness, no network, writes only under
  `tmp_path`); one rule per test, named after the rule; assert the behaviour through public interfaces, not
  implementation details; short. IntentOS runs it in the repository's venv at the current revision and rejects a
  failing test with the pytest output.

Prefer an existing test. Write one when none exists.

## Submitting

Call `propose` once with the whole list: `{"repo": "<absolute path>", "candidates": [...]}`. The result names the
accepted candidates (with how each is verified: lifted, written or none) and the rejected ones with reasons. Fix what
can be fixed and call `propose` again with `append: true` for the fixed candidates only. Then call `review_start`.
The reviewer approves in the widget or through the host's prompts; you stop there and never decide for them.

## Example candidate

```json
{
  "kind": "invariant",
  "title": "Cancelled contracts get no discount",
  "statement": "A contract whose status is cancelled must never receive a volume discount.",
  "category": "business_rule",
  "rationale": "Discounting a cancelled contract understates revenue; it happened in production and was fixed in 2f1c9ab.",
  "confidence": "high",
  "relevance": "high",
  "evidence": [
    {"type": "test", "ref": "tests/test_discounts.py::test_cancelled_contract_gets_no_discount", "excerpt": "assert not eligible(C)"},
    {"type": "commit", "ref": "2f1c9ab", "excerpt": "Fix: cancelled contracts received volume discounts"}
  ],
  "applies_to_paths": ["app/services/discounts.py"],
  "test": {"existing": "tests/test_discounts.py::test_cancelled_contract_gets_no_discount"}
}
```
