# Policies: what they are and what they can say

A policy is the **trusted configuration for one repository**. It is the only place where a statement about the
codebase gains authority. Everything else IntentOS reads is evidence: a docstring, an ADR, a README section, a
planner's contract, an implementer's final message. None of those can bind a run by themselves. A policy can.

Policies live in `policies/*.yaml` inside the IntentOS checkout, never inside the target repository. That is the
whole isolation argument in one sentence: the implementer works in a worktree of the target repository, so anything
in that repository is writable by the agent and therefore cannot be trusted; the policy, the hidden tests under
`benchmarks/hidden_tests/<policy_id>/` and the verifier code sit outside that worktree and are read-only to it.

Each file is validated against `PolicySchema` in `src/knowledge/policy.ts` when loaded; a malformed policy fails
`index` and `run` with the field path and message. `intentos onboard <repo>` writes a **draft** with the mechanical
parts filled in and the authoritative parts empty (`docs/policies.md` is referenced from the draft's comments).

## How a policy is used

| Stage | What the policy does |
|---|---|
| `index` | `applies_to` selects the policy. Every invariant, rule and decision `source` is resolved to a Markdown section of the repository at HEAD and bound as evidence with a status: `approved_policy` when found, `conflicted` when the text changed since approval (or a pinned `content_sha256` differs), `superseded` for decisions another decision replaces. Unresolvable sources are listed as `unresolved_sources` and the owner becomes `conflicted`. |
| `explain` / `plan` | `scope_tags`, `applies_to_paths` and `synonyms` decide which invariants and rules are relevant to the task and feed retrieval. The planner sees them as evidence ids it must cite; it cannot add or remove them. |
| contract compilation | The compiler **injects** every applicable blocking invariant and rule and every `required` command into the contract whatever the planner produced, rejects `allowed_paths` outside `default_allowed_paths` or overlapping `protected_paths`, and refuses to let a `conflicted` constraint be blocking (the run routes to clarification until a human re-approves). |
| verification | Only `commands` listed here run. Builtins are code; `argv` commands are executed verbatim from trusted config with four placeholders. Findings are attributed to the invariant or rule id so the report can say which approved statement was violated. |
| report | Invariant and rule statements, their sources and their statuses are quoted so a reviewer sees *why* something blocked. |

Nothing in the policy is executed as shell. `argv` is an argument vector, placeholders are substituted as data, and
in container mode the vector is translated to container paths and refused if any host path remains.

## The blocks

### Identity and matching

```yaml
schema_version: "1.0"
policy_id: startup_billing          # also the folder name under benchmarks/hidden_tests/
description: >                      # free text for humans
applies_to:
  project_name: startup_billing     # matched against `name = "…"` in the repository's pyproject.toml
  path_basename: startup_billing    # fallback: the checkout's folder name
```

The first policy whose `project_name` matches wins, then the first whose `path_basename` matches. A repository with
no matching policy gets the **fallback policy**: the project test suite, the scope check and the surprise signals,
with `**` as the allowed universe and no invariants or rules. That is enough to run, and never enough for
`REVIEW_READY`.

### Paths

```yaml
default_allowed_paths: ["app/**", "tests/**"]   # the universe; the planner narrows it per task
protected_paths: ["docs/**", "pyproject.toml"]  # never writable, whatever the contract says
scope_tags:
  "app/services/pricing.py": [pricing, billing]  # tags per glob
  "app/api/**": [api, billing]
```

`default_allowed_paths` is the outer bound of what any contract may make writable; the compiler rejects a contract
that lists anything outside it, and rejects catch-all globs such as `**` in a contract even when the universe allows
them. `protected_paths` are blocked twice: at compile time (a contract cannot make them writable) and after the
fact by the scope check on the diff. `scope_tags` are how a task is connected to the invariants and rules that
mention the same tags.

### Commands

```yaml
commands:
  pytest_project:
    description: Project test suite from the verification snapshot
    track: functional                 # functional | architecture | business_invariant | scope
    argv: ["{python}", "-m", "pytest", "tests", "-q", "-p", "no:cacheprovider", "-o", "pythonpath=src", "--junit-xml={junit}"]
    timeout_s: 600
    enforcement: blocking             # blocking gates REVIEW_READY; advisory only produces findings
    required: true                    # injected into every contract
  pytest_hidden_task:
    argv: ["{python}", "-m", "pytest", "{hidden_tests_dir}/task", …]
    requires_task_tests: true         # skipped when the task has no hidden acceptance tests
  pytest_invariants:
    track: business_invariant
    argv: ["{python}", "-m", "pytest", "{hidden_tests_dir}/invariants", …]
  architecture_rules:    { builtin: architecture_rules, track: architecture }
  scope_check:           { builtin: scope_check, track: scope }
  counterexamples:       { builtin: counterexamples, track: business_invariant, enforcement: advisory, required: false }
  architecture_surprise: { builtin: architecture_surprise, track: architecture, enforcement: advisory }
```

Placeholders: `{python}` is the verifier interpreter (`INTENTOS_PYTHON`, else the repository's onboarded venv,
else `.intentos/venv`), `{snapshot}` the read-only copy of the worktree, `{hidden_tests_dir}` the hidden tests
copied next to it, `{junit}` the JUnit file the verifier parses. Tests must import the code through `pythonpath`,
never through an editable install of your clone, because the snapshot is what is being judged.

Blocking commands that fail, time out, fail to start, or report zero collected tests become blocking findings; a
consistency guard makes sure a non-passing blocking command can never be silently ignored.

### Invariants

```yaml
invariants:
  - id: INV-001
    statement: Locked and cancelled contracts never receive discounts or promotions of any kind.
    scope: [pricing, discounts, promotions]
    applies_to_paths: ["app/services/pricing.py", "app/domain/**"]
    authority: approved_policy        # approved_policy | approved_decision | executable_contract
    approved_by: billing-owner
    sources:
      - path: docs/business-policy.md
        heading: Locked contracts
        content_sha256: <optional pin>
    verified_by:
      - benchmarks/hidden_tests/startup_billing/invariants/test_inv_001_locked_contracts.py
    enforcement: blocking
```

An invariant is a business rule a person has approved. Its `sources` must point at a Markdown section in the
repository; the indexer binds that section as evidence, so the planner cites a real document and the verifier can
tell when the document changed under the rule. `verified_by` names hidden tests; a blocking invariant whose hidden
test is unavailable **fails closed**. `applies_to_paths` and `scope` decide whether the invariant is injected into a
given task's contract.

### Architecture rules

```yaml
architecture_rules:
  - id: ARCH-001
    kind: forbidden_import            # forbidden_import | forbidden_call | frozen_paths | required_import | forbidden_names
    statement: The API layer formats results only; it must not import decimal or app.domain.money.
    paths: ["app/api/**"]
    forbidden_modules: [decimal, app.domain.money]
    authority: approved_decision
    approved_by: cto
    sources: [{ path: docs/adr-001-pricing-ownership.md }]
```

Rules are checked deterministically on the snapshot's AST (imports with aliases resolved, callee names, dotted
names and string literals) or on the diff (`frozen_paths`). `forbidden_call` takes `forbidden_callees` plus
`allowed_paths` where the call is legitimate; `forbidden_names` takes `forbidden_names` and `forbidden_literals`
and is how the verifier protects itself from tampering (`sys.argv`, `os._exit`, `junit`).

### Decisions

```yaml
decisions:
  - id: DEC-003
    statement: InvoiceExportService is the home for all invoice export formats; the legacy adapter is deprecated.
    status: approved                  # approved | superseded | proposed | rejected
    supersedes: DEC-002
    sources: [{ path: docs/adr-003-invoice-export-service.md }]
```

Decisions are the memory the planner is shown. A superseded decision is still bound, marked `superseded`, so an
old ADR cannot resurrect itself; symbols named in approved decisions rank higher in retrieval. `intentos decision
propose/approve/supersede` and `intentos feedback` write proposals into the database with `model_inference`
authority; they never bind until promoted into this file by a person.

### Counterexamples and surprise detectors

```yaml
counterexamples:
  - id: CX-001
    invariant: INV-001
    authority: exploratory            # exploratory never blocks; authoritative requires approved sources
    grid: { status: [LOCKED, CANCELLED], seats: [1, 500] }
    template: |
      def test_{case_id}(): …
architecture_surprise:
  api_paths: ["app/api/**"]
  domain_paths: ["app/domain/**"]
  ignore_names: []
```

Counterexample templates generate edge-case probes for an invariant from a value grid. `architecture_surprise`
configures the advisory review signals (new cross-module dependency, duplicate helper, domain construction in the
API layer); with empty path lists the third detector is simply inactive.

## Writing one for a new repository

1. Run `intentos onboard <repo>`: it drafts identity, paths, scope tags and commands, creates the venv, runs the
   suite once and indexes. The draft is explicit about being a draft.
2. Run `intentos suggest <repo> --write-adrs` to get candidates instead of a blank page. It mines commits whose
   message records a fix or a prohibition, tests whose names read like rules (`test_subtraction_never_goes_negative`),
   must/never/only sentences in documents with their heading, existing ADRs with their lineage, import relationships
   that only ever go one way between layers (proposed as the rule that keeps it so), directories that look frozen,
   and changelog deprecations. Each candidate carries its evidence, a confidence, a paste-ready block with
   `approved_by: TODO`, and, for rule-like tests, a hidden-test draft lifted from the existing test. Candidates that
   have no document of their own get an ADR draft with `Status: Proposed`; `--with-codex` lets Codex write the ADR
   prose from the evidence in a read-only thread, and any ADR that cites evidence it was not given is dropped.
   Candidates are ordered by a business-relevance score computed from the repository itself (how much of the
   candidate is in the repository's own vocabulary rather than library or tooling words, whether it is shaped like a
   property or like a fix, how many independent sources corroborate its cluster, how central the code it touches
   is, how long its test has existed). `--classify` adds a model pass over the top candidates: Codex labels each as
   business rule, robustness rule, implementation detail, environment, tooling or duplicate, keeps or sets aside,
   rewrites the statement as one testable sentence, and names its cluster. The model cannot add candidates, its
   rewrite is discarded if it uses an identifier the evidence does not contain, and set-aside candidates stay in
   the review document under a rescue heading. After you have pasted what you keep, `--record` derives accept and
   reject terms from your decisions and the next run ranks with them.
   Nothing in these files has authority: you delete what is wrong, edit the rest, and approve by pasting.
3. Decide what must never change and write it down as Markdown in the repository, one heading per rule (ADRs,
   `docs/business-policy.md`). The indexer needs headings to bind. Accepted ADR drafts count: change their status.
4. Turn each rule into an invariant or an architecture rule with `sources` pointing at those headings and
   `approved_by` naming a person. Write the hidden tests for invariants under
   `benchmarks/hidden_tests/<policy_id>/invariants/`; they are the only tests the implementer cannot edit.
5. Run `intentos index <repo>` again and check that nothing is listed under `unresolved policy sources`.
6. For benchmark-style tasks, add an entry to `benchmarks/tasks.json` with `hidden_tests` and select it with
   `run --task <id>`; that is what makes `REVIEW_READY` reachable.

The division of labour is deliberate: IntentOS derives everything that can be derived from the repository, and
refuses to derive what carries authority.
