"""Acceptance tests for T04, written before implementation by gpt-5.6-terra (IntentOS acceptance, thread 01a17d22-829d-73d0-982b-c6fc14dd9c1d).

Base revision 6757f4f659, 2026-10-27T11:33:54.397Z. At that revision: test_add_weekdays2df_leaves_the_supplied_dataframe_unchanged failed, test_add_weekdays2df_results_do_not_leak_holidays_between_scenarios failed.
Expectation: the requested behaviour does not exist yet; at least one test fails now and all pass once implemented.
Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.

Covers:
- The existing add_weekdays2df interface leaves its input DataFrame unchanged and returns a distinct DataFrame.
- Separate calls using different holiday calendars retain independent weekday results and do not add derived columns to the reused source frame.

Ticket:
    add_weekdays2df modifies the DataFrame it is given
    
    `tools.add_weekdays2df(df, ...)` adds the `weekday` and `date` columns to the DataFrame I pass in, not only to
    the one it returns. I reuse one frame for several scenarios with different holiday calendars and the columns
    leak between them.
    
    I would expect the input to be left alone and the result to be a new frame, or at least a documented way to
    opt out of the in-place change. Existing callers inside the package must keep working.
"""
import pandas as pd

from oemof.demand import tools


def test_add_weekdays2df_leaves_the_supplied_dataframe_unchanged():
    source = pd.DataFrame(
        {"demand": [1.5, 2.5, 3.5]},
        index=pd.date_range("2024-01-04", periods=3, freq="D"),
    )
    original = source.copy(deep=True)

    result = tools.add_weekdays2df(source, holidays=[])

    pd.testing.assert_frame_equal(source, original)
    assert result is not source


def test_add_weekdays2df_results_do_not_leak_holidays_between_scenarios():
    source = pd.DataFrame(
        {"demand": [1.5, 2.5, 3.5]},
        index=pd.date_range("2024-01-04", periods=3, freq="D"),
    )

    friday_holiday = tools.add_weekdays2df(
        source, holidays=[pd.Timestamp("2024-01-05")]
    )
    saturday_holiday = tools.add_weekdays2df(
        source, holidays=[pd.Timestamp("2024-01-06")]
    )

    assert friday_holiday["weekday"].tolist() == [4, 0, 6]
    assert saturday_holiday["weekday"].tolist() == [4, 5, 0]
    assert friday_holiday["date"].tolist() == [
        pd.Timestamp("2024-01-04").date(),
        pd.Timestamp("2024-01-05").date(),
        pd.Timestamp("2024-01-06").date(),
    ]
    assert list(source.columns) == ["demand"]
