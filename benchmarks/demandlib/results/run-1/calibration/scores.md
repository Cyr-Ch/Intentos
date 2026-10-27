# Calibration scores

Scored by Claude (Fable 5.1) with the rubric, blind to `KEY.json`, on the ten regenerated pairs. **This is a second model's reading, not a person's**; the write-up labels it so. The judge was gpt-5.6-sol.

| ticket | A was | my verdict | judge | agree | deciding | reason |
|---|---|---|---|---|---|---|
| T01 | full | baseline | baseline | yes | C1 | B matches the ticket's inclusive window exactly and validates that both ends are given; A adds an unrequested rule that keeps am/pm stamps on the day factor even inside the break. |
| T02 | full | baseline | baseline | yes | C5 | Same change; B's tests add 30-minute and daily steps, a leap year, shape preservation and a sub-year excerpt. |
| T03 | baseline | baseline | tie | no | C2 | A is the one-line idiomatic fix (normalize) with a test that compares against the date form; B also edits two unrelated existing tests. |
| T04 | baseline | tie | tie | yes | C1 | Identical copy() fix; A's test proves mutating the result leaves the input alone, B's covers more calendars; neither is better. |
| T07 | full | full | full | yes | C5 | Identical one-line fix; A adds the regression tests under warnings-as-errors, B adds none. |
| T09 | full | full | full | yes | C5 | Both validate all three parameters; A rejects bool, float and string classes explicitly and tests them, B's messages are nicer and its test module is better placed. |
| T10 | baseline | tie | tie | yes | C5 | Identical check; A documents it and tests the constructor path, B tests the load curves after adding; parity. |
| T11 | baseline | baseline | full | no | C5 | A implements the path with a documented default for the energy factors and tests it; B's question about those factors is the right question, but the ticket was answerable with a stated assumption and B ships no tests. |
| T13 | full | full | tie | no | C5 | Same guard; A's positive-demand test pins the exact expected series at two resolutions, B's checks proportionality only. |
| T14 | full | baseline | baseline | yes | C4 | A re-normalises inside get_scaled_profiles, changing that public method's result for resampled frames; B confines the change to the power profiles the ticket names. |

Verdict agreement: 7 of 10. Mean absolute difference per criterion (my score vs the judge's order-averaged score, both arms): C1 0.2, C2 0.12, C3 0.35, C4 0.03, C5 0.15, C6 0.15.
