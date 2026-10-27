# Judge rubric: code quality of a ticket resolution

Used by the LLM judge in the demandlib comparison (Codex alone versus Codex under IntentOS), and by the human
calibration pass. The judge scores what tests cannot see. It never sees the verifier's findings, the run's state,
which arm produced a diff, or the other arm's diff when scoring absolutely; pairwise judgements see two diffs with
neutral labels and are repeated with the order swapped.

## What the judge receives

- the ticket text, exactly as the agents saw it
- the diff (unified, against the ticket's base revision), including new files
- read-only access to the repository at the base revision, for context
- this rubric

It does not receive the acceptance tests, the invariants, the agents' messages, or any run metadata.

## Criteria

Each criterion is scored 1 to 5 with a one-sentence reason that cites a line of the diff. Anchors are given for
1, 3 and 5; 2 and 4 are in between.

### C1. Solves what was asked

- 5: the change does exactly what the ticket asks, including the edge cases the ticket names; a user who filed it
  would close it.
- 3: the main case is handled; a named edge case is missing or handled differently from the ticket.
- 1: the change misses the point of the ticket or does something else.

For a ticket whose correct outcome is a question or a refusal (vague request, already-fixed request), score 5 for a
precise question or a cited refusal, 3 for an implementation that is harmless, 1 for an implementation that
duplicates or breaks what exists.

### C2. Minimal and in scope

- 5: touches only what the ticket needs; no unrelated formatting, renames, or drive-by changes; no files outside the
  modules the ticket concerns.
- 3: one unrelated change or one file that did not need touching.
- 1: broad rewrites, reformatting of whole files, or changes to documentation, packaging or policy files the ticket
  did not ask for.

### C3. Fits the codebase

- 5: reuses the existing helpers and classes where they exist (the holiday helpers in `tools`, the profile base
  classes, the validation style already used), follows the module's naming, docstring and error-message
  conventions, and keeps the public API shape.
- 3: works but duplicates an existing helper or departs from local conventions in a visible way.
- 1: introduces a parallel mechanism for something the package already does, or breaks an existing public call
  signature without the ticket asking for it.

### C4. Behaviour preserved where the ticket did not ask for change

- 5: defaults, numbering conventions, existing errors and warnings are unchanged; the change is additive or
  guarded by an option.
- 3: a default changed in a way the ticket did not ask for but that is documented in the diff.
- 1: existing behaviour changed silently (different output for the same input, removed error, removed warning).

### C5. Tests

- 5: new tests cover the ticket's main case and its named edge cases, fail without the change, and follow the
  existing test layout; no existing test was weakened or deleted.
- 3: a test exists for the main case only, or the tests assert implementation details rather than behaviour.
- 1: no tests, or an existing test was changed to pass.

### C6. Readability of the change

- 5: a reviewer reads the diff once and understands it; names say what things are; the docstring of a changed
  public function describes the new behaviour; the commit message or summary matches the diff.
- 3: understandable with effort; a docstring is stale or a name is misleading.
- 1: the diff needs the ticket and a debugger to follow.

## Pairwise verdict

After scoring both diffs, the judge states which one a maintainer should merge, or "tie", with one sentence that
names the deciding criterion. The pair is judged twice with the order swapped; a verdict that flips with the order
is recorded as a tie.

## Calibration

Before any aggregate is reported, a person scores ten randomly chosen pairs with the same rubric, blind to the arm.
Agreement between the person and the judge on the pairwise verdict, and the mean absolute difference per criterion,
are reported next to every result that uses the judge. Without that number the judge's scores are not reported.

## Reporting

- Per ticket: both arms' criterion scores, the pairwise verdict, and the judge's reasons.
- Aggregate: wins, losses and ties per arm; mean per criterion with a 95% interval over tickets; the calibration
  numbers.
- The judge's model and prompt version are recorded with every score. The judge is a different model from the one
  that implemented the change.
