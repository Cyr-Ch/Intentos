"""Hidden invariant test for INV-009: Holiday tagging preserves the chosen day category.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import datetime
import pandas as pd
import pytest
from oemof.demand import tools

@pytest.mark.parametrize("as_sunday, expected", [(False, 0), (True, 7)])
@pytest.mark.parametrize("as_dict", [False, True])
def test_holidays_use_the_chosen_day_category(as_sunday, expected, as_dict):
    day = datetime.date(2010, 1, 1)
    holidays = {day: "New year"} if as_dict else [day]
    index = pd.date_range("2010-01-01", periods=48, freq="h")
    result = tools.add_weekdays2df(
        pd.DataFrame(index=index), holidays=holidays,
        holiday_is_sunday=as_sunday)
    assert (result.loc["2010-01-01", "weekday"] == expected).all()
    assert (result.loc["2010-01-02", "weekday"] == 6).all()
