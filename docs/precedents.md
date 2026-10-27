# Precedents: how similar tickets were solved here

A **precedent** is a resolved ticket together with the pull request that resolved it and what that pull request
changed. It answers the question a good colleague answers before touching code: *when this repository last faced a
task like this, where was the change made, which tests were added, and what exactly was asked?*

Precedents are evidence, not policy. Their authority is `historical_precedent`, the same as a document section
nobody has approved. They inform the planner, the implementer and the review signals; they never bind a run. An
invariant or an architecture rule from the policy always wins over a precedent, and a precedent whose code no
longer exists is reported as history, not as guidance.

## Where they come from

```bash
intentos precedents sync <repo> --issues owner/name [--pulls owner/name] [--limit N] [--no-timeline] [--no-index]
```

1. **Tickets.** The closed issues of `--issues` are fetched with the GitHub CLI (`gh api`, your login). Pull
   requests are skipped; only tickets count.
2. **The resolving pull request.** For each ticket IntentOS collects pull request references from the ticket
   text (full URLs anywhere; `#n` only when the text presents it as a pull request, e.g. "resolved by #n") and,
   unless `--no-timeline`, from the issue's timeline (pull requests that cross-reference the ticket). The first
   *merged* one is the resolving pull request. `--pulls` names the repository of the pull requests when it differs
   from the tracker, e.g. tickets reconstructed on a fork while the pull requests were merged upstream.
3. **What it changed.** The pull request's merge commit is read from the **local** git history (so the clone must
   contain it): changed files, the Python definitions that contain changed lines (found by walking up from each
   hunk to the enclosing `def`/`class` at the merge revision, as `module.Class.method`), and the test functions the
   pull request added. No network is needed for this step and nothing is executed.
4. **Storage.** The result is written to `<INTENTOS_HOME>/precedents/<repo-id>.json`, outside the target repository
   (an implementer working in a worktree of the repository cannot forge it), and the repository is re-indexed.

A tracker other than GitHub can write the same file: the shape is `PrecedentsFile` in
`src/knowledge/precedents.ts` (`analyzePullDiff` fills the `diff` block from a merge commit).

## How they are linked to the code

Every `index` re-links each precedent to the graph **at the current revision** (`linkPrecedent`):

| Step | What happens |
|---|---|
| files | A touched file that still exists is `current`. One that does not is followed through git's rename detection between the merge commit and HEAD (`git diff -M`), and when git gives up because the file changed too much, through its path tail (`bdew/elec_slp.py` is the same file under `src/oemof/demand/` when that tail is unique). |
| definitions | `module.Class.method` is looked up as it was recorded; after a traced rename, under the file's new module name; last, by bare name inside the file it came from (a renamed container). Matches carry `exact`, `renamed` or `name`. |
| tests added | Looked up as `path::name`. |
| staleness | `current` when everything resolves; `partially_stale` when some files or definitions are gone; `stale` when none of the touched code files exist or none of the touched definitions exist; `unlinked` when the ticket has no merged pull request or its merge commit is not in the clone (text-only precedent). |

The graph gets a `precedent` node (`PREC-<ticket number>`), `TOUCHES` edges to the symbols and modules it changed,
`ADDS_TEST` edges to the tests it added, and one evidence row (`source_type: precedent`, `source_ref` = ticket URL,
status `supported`, or `superseded` when stale). `intentos precedents show <repo>` lists the result.

## How they are used

| Stage | Behaviour |
|---|---|
| `explain` | Precedents are scored like everything else (task terms against ticket title, text, pull request title and labels, IDF-weighted) plus **structural overlap**: a precedent that changed a symbol retrieved for the task, a file in the probable impact, or a test retrieved for the task scores higher. The top three appear with evidence ids, locations at the current revision, tests added and the reasons. A `stale` one is also a `stale_precedent` conflict. A strong current precedent produces a suggestion naming its location. |
| planner prompt | The section "Precedents (historical, advisory)" lists them with their evidence ids and the rule: prefer the location and pattern of a current precedent when the task is of the same kind, cite its evidence id in the requirement it informs, treat a stale one as what was asked rather than where to change the code, and never let a precedent override an invariant or rule. |
| contract compiler | A precedent's evidence id is ordinary evidence: citable, checked against the pack like any other id. Nothing is injected; a precedent cannot make anything blocking. |
| implementer prompt | The precedents the contract cites (or the best current one, marked advisory) with the current location of what they changed and the tests they added. |
| verification | Review-only signals from the diff, next to the architectural-surprise signals: `PRECEDENT-FOLLOWED` (info) when the change lands in a file a strong current precedent changed, `PRECEDENT-DIVERGENCE` (review) when it lands only elsewhere. Thresholds: relevance ≥ 0.7, staleness `current` or `partially_stale`, at least one current code file. Never blocking. |
| report | The "Precedents" section lists each retrieved precedent, whether the contract cited it, and whether the diff followed or diverged from it. |
| MCP | The `precedents` tool runs the sync (the CLI in a child process); `explain` then shows the matches. The server instructions tell the host to load them once per repository. |

## Limits

- Definitions are attributed by walking up indentation to `def`/`class`; decorators, nested functions and
  module-level statements are attributed to their nearest enclosing definition or to nothing.
- Large pull requests (releases, template adoptions) touch many definitions and rank on text, not structure;
  the structural bonus is capped so one sweeping pull request does not outrank a focused one.
- Only the first merged pull request per ticket is linked. A ticket solved across several pull requests keeps the
  first one found.
- Tickets are repository text: they can be wrong, outdated or adversarial. They are quoted as evidence and never
  executed or treated as instructions.
