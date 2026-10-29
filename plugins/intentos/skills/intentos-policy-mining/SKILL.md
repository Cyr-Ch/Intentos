---
name: intentos-policy-mining
description: Mine a repository's tests, git history, documents and structure (Python or TypeScript) for the business rules it already follows, pick or write a test that proves each one, and submit them to IntentOS (MCP tool `propose`) for a person to approve. Use when asked to bring a repository under IntentOS, find its business logic, or produce policy candidates. Not for implementing features or fixing bugs.
---

# IntentOS policy mining

You are producing **policy candidates**: rules the repository already follows, which a person will approve into the
IntentOS policy. Every approved invariant becomes a hidden test that the verifier runs against future changes, so each
candidate needs a test that proves the rule at the current revision. You propose; a person decides. Never approve,
reject or edit a candidate on the reviewer's behalf, and never pad the list with rules you cannot back with evidence.

## Before you start

1. Call `status` with the absolute repository path. If it is not onboarded, call `onboard` and poll `status` until
   `phase` is `done`. Onboarding creates the environment your tests will run in (a venv for Python, the repository's
   `node_modules` for TypeScript), writes the draft policy, indexes the repository and builds the evidence digest.
2. Call `evidence`. It returns the **evidence digest**: facts, not rules. Every test with its first assertion and the
   production files it exercises (`*` marks rule-like names), every commit that touched code with the tests it added
   (`*` marks fix-like messages), every must/never/always/only sentence from README, docs and CHANGELOG with its
   heading and line, every ADR with its status, the import edges between directories, directories nobody has touched
   in a long time, deprecation entries, every must/never sentence an author left in a docstring or comment of the
   production code (with the symbol it documents), and the resolved tickets synced from the tracker with the pull
   request that settled each and the tests it added. Nothing in it is ranked or classified; you decide what is a
   rule. Call it with `section` (`tests`, `commits`, `documents`, `adrs`, `imports`, `stale_dirs`, `changelog`,
   `code_notes`, `tickets`) for the full JSON of one part. Then read the code behind the facts that look like rules before you state anything.
3. If the user asks for an independent, second or unbiased opinion, names a model, or `status` says a mining model is
   configured, call `mine` with that model instead of mining yourself: IntentOS runs this skill in a separate read-only
   thread with that model and checks the result exactly as it checks yours; poll `status` until it is done, then call
   `review_start`. `append: true` puts that model's candidates next to yours instead of replacing them.

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

1. **Tests** (strongest evidence). Start from the digest's test list (pytest functions, or vitest/jest `it`/`test`
   titles with their `describe` chain) and read names and assertions. Names containing never, always, must, only,
   raises, throws, warns, invalid, empty, negative, zero or limit usually guard a rule. Read the test body to state
   the rule precisely, then read the production code it exercises (the digest lists those files).
2. **Git history.** `git log --no-merges --format='%h %s' -n 500`; for subjects with fix, regression, guard, validate,
   reject, must, never, always, ensure, warn or limit, run `git show --stat <sha>` and read the diff. A fix commit
   says what broke and therefore what must hold; its diff shows the guard. A rule fixed twice is a strong candidate.
3. **Documents.** README, docs/, CHANGELOG, ADRs: sentences with must, never, always, only, required, invalid or
   not allowed. Cite the file and the line.
4. **Code notes.** Docstrings and comments in the production code that say what must hold ("the only component
   that computes prices", "a balance never goes below zero"). They are the author's own statement of the rule, next
   to the code that keeps it: read the function or class they document and find the test that proves it, or write
   one. Cite as `code <path>:<line>`.
5. **Resolved tickets.** What users reported, and the pull request that settled it with the tests it added: the
   clearest statement of a rule somebody noticed when it broke. Cite as `ticket #<number>` and corroborate with the
   pull request's merge commit (`commit <sha>`) or the test it added. Present only after `intentos precedents sync`.
6. **Structure.** The import graph between top-level packages (which layer imports which), directories untouched for
   a year, modules everything depends on. These give `architecture_rule` and `frozen_paths` candidates; they need no
   test because the scope check enforces them.

Prefer rules corroborated by two sources: a test and the commit that added it, a document sentence and a test.

## Writing a candidate

- `statement`: one sentence, active voice, domain terms: "<subject> must | never <behaviour> [when <condition>]".
  Every identifier you use (function, class, constant) must appear in the evidence you cite.
- `evidence`: one to eight items, each with `type` (`test`, `commit`, `doc`, `adr`, `changelog`, `import`,
  `history`, `code`, `ticket`), a real `ref` (`tests/test_x.py::TestY::test_z`, `tests/ledger.test.ts::<it title>`,
  a commit sha, `docs/x.md:12`, `app/services/pricing.py:13`, `#43`) and an `excerpt` quoting the source line. IntentOS checks that the file, line and commit exist; a
  proposal with an invented reference is rejected.
- `applies_to_paths`: globs of the production code the rule governs (`src/pkg/module.py`, `src/domain/**`). Not
  test paths.
- `category`: `business_rule` or `robustness_rule`. `rationale`: one or two sentences on why a user would notice.
  `confidence` and `relevance`: `high`, `medium` or `low`.
- `kind`: `invariant` (needs a test), `architecture_rule` (needs `rule`, for example
  `{"kind": "forbidden_import", "paths": ["src/pkg/api/**"], "forbidden_modules": ["pkg.persistence"]}`; in a
  TypeScript repository name modules as package specifiers or repository paths: `["node:fs", "src/db"]`),
  `frozen_paths` (`rule`: `{"kind": "frozen_paths", "paths": ["src/pkg/legacy/**"]}`), or `decision` (an ADR-style
  statement with `sources`).
- `sources` (decisions, and rules a document states): the documents the rule cites, as
  `[{"path": "docs/adr-001-pricing.md", "heading": "Decision"}]`; a bare path string is accepted too.

## The test

Every invariant needs `test`, one of:

- `{"existing": "tests/test_x.py::TestY::test_z"}` (pytest) or `{"existing": "tests/ledger.test.ts::<it title>"}`
  (vitest/jest) when a test in the repository already proves the rule. IntentOS lifts it (a pytest test with its
  imports, fixtures and class setup; a vitest/jest file whole, with its relative imports re-pointed and the chosen
  test marked `.only`) and runs the original at the current revision. A test that fails there is rejected: either
  the rule is not established or the repository is broken, and you tell the reviewer which.
- `{"source": "<a complete test module>"}` when nothing proves the rule yet (typical for rules found in commits or
  documents). For Python: a pytest module importing from the installed package only, no path hacks, no helpers from
  the repository's tests directory, no conftest fixtures. For TypeScript: a vitest/jest module (`import { it, expect }
  from "vitest"`) that imports production code relative to the hidden directory two levels below the repository root,
  for example `../../src/domain/money.ts`, with the same extension style the repository's own tests use; no setup
  files. Both: deterministic (fixed dates, no randomness, no network, writes only under a temp dir); one rule per
  test, named after the rule; assert the behaviour through public interfaces, not implementation details; short.
  IntentOS runs it in the repository's environment at the current revision and rejects a failing test with the
  runner's output.

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
