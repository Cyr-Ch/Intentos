"""Acceptance tests for T15, written before implementation by gpt-5.6-terra (IntentOS acceptance, thread 01a17d2a-8fcd-7a02-b4a3-fe447fe6741d).

Base revision 6757f4f659, 2026-10-27T11:42:34.958Z. At that revision: test_omitting_holidays_warns_and_keeps_dates_as_weekdays passed, test_empty_holidays_list_does_not_emit_missing_holidays_warning passed.
Expectation: the behaviour already exists; all tests pass now.
Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.

Covers:
- Omitting holidays from add_weekdays2df emits a UserWarning and leaves the date classified as its normal weekday.
- Passing an explicit empty holidays list does not emit the missing-holidays UserWarning.

Ticket:
    No warning when holidays are omitted
    
    When I forget to pass `holidays`, public holidays are silently treated as normal weekdays. A warning telling me
    that no holidays were given would have saved me a wrong annual result. An empty list should stay silent.
"""
import warnings

import pandas as pd
import pytest

from oemof.demand import tools


def test_omitting_holidays_warns_and_keeps_dates_as_weekdays():
    time_df = pd.DataFrame(index=pd.date_range("2024-01-01", periods=1))

    with pytest.warns(UserWarning, match="No holidays given"):
        result = tools.add_weekdays2df(time_df)

    assert result.loc[pd.Timestamp("2024-01-01"), "weekday"] == 1


def test_empty_holidays_list_does_not_emit_missing_holidays_warning():
    time_df = pd.DataFrame(index=pd.date_range("2024-01-01", periods=1))

    with warnings.catch_warnings(record=True) as caught_warnings:
        warnings.simplefilter("always")
        result = tools.add_weekdays2df(time_df, holidays=[])

    assert not any(
        issubclass(warning.category, UserWarning)
        and "No holidays given" in str(warning.message)
        for warning in caught_warnings
    )
    assert result.loc[pd.Timestamp("2024-01-01"), "weekday"] == 1
