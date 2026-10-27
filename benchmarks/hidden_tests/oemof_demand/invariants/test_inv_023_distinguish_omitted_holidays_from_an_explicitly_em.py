"""Hidden invariant test for INV-023: Distinguish omitted holidays from an explicitly empty calendar.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import warnings
import pandas as pd
import pytest
from oemof.demand import tools

@pytest.mark.parametrize("holidays, should_warn", [(None, True), ([], False)])
def test_missing_and_explicitly_empty_holidays_have_distinct_warning_behavior(holidays, should_warn):
    index = pd.date_range("2010-01-01", periods=7, freq="D")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        frame = tools.add_weekdays2df(pd.DataFrame(index=index), holidays=holidays)
    assert frame["weekday"].tolist() == [5, 6, 7, 1, 2, 3, 4]
    missing_holiday_warning = any(
        issubclass(item.category, UserWarning)
        and "No holidays given" in str(item.message)
        for item in caught
    )
    assert missing_holiday_warning == should_warn
