"""Acceptance tests for T03, written before implementation by gpt-5.6-terra (IntentOS acceptance, thread 01a17d22-0f6a-7140-8351-5eefb0fa6acb).

Base revision 6757f4f659, 2026-10-27T11:32:55.865Z. At that revision: test_add_weekdays_marks_datetime_holidays_by_date[holidays0] failed, test_add_weekdays_marks_datetime_holidays_by_date[holidays1] failed, test_industrial_profile_accepts_datetime_holiday_list failed.
Expectation: the requested behaviour does not exist yet; at least one test fails now and all pass once implemented.
Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.

Covers:
- `add_weekdays2df` marks every timestamp on a holiday supplied as a noon datetime in a list.
- `add_weekdays2df` marks every timestamp on a holiday supplied as a noon datetime dictionary key.
- `IndustrialLoadProfile` gives a datetime holiday list the same public profile result as the equivalent date holiday list.

Ticket:
    Holidays given as datetimes with a time of day are not applied
    
    I build my holiday list from a calendar library that returns `datetime.datetime` objects at noon. Passing that
    list as `holidays` to `add_weekdays2df` (or any of the profile classes) silently applies nothing: every holiday
    keeps its ordinary weekday number and no warning is given.
    
    Example: `holidays=[datetime.datetime(2024, 1, 1, 12, 0)]` on a 2024 index leaves 1 January as weekday 1.
    Passing `datetime.date(2024, 1, 1)` works. Holidays should match by date regardless of the time component,
    for lists and for dicts.
"""
import datetime

import pandas as pd
import pytest

from oemof.demand.particular_profiles import IndustrialLoadProfile
from oemof.demand.tools import add_weekdays2df


@pytest.mark.parametrize(
    "holidays",
    [
        [datetime.datetime(2024, 1, 1, 12, 0)],
        {datetime.datetime(2024, 1, 1, 12, 0): "New Year"},
    ],
)
def test_add_weekdays_marks_datetime_holidays_by_date(holidays):
    index = pd.date_range("2024-01-01", periods=24, freq="1h")

    result = add_weekdays2df(pd.DataFrame(index=index), holidays=holidays)

    assert (result["weekday"] == 0).all()


def test_industrial_profile_accepts_datetime_holiday_list():
    index = pd.date_range("2024-01-01", periods=48, freq="1h")
    factors = {
        "week": {"day": 1.0, "night": 1.0},
        "weekend": {"day": 1.0, "night": 1.0},
        "holiday": {"day": 2.0, "night": 2.0},
    }

    datetime_holiday_profile = IndustrialLoadProfile(
        index, holidays=[datetime.datetime(2024, 1, 1, 12, 0)]
    ).simple_profile(annual_demand=1.0, profile_factors=factors)
    date_holiday_profile = IndustrialLoadProfile(
        index, holidays=[datetime.date(2024, 1, 1)]
    ).simple_profile(annual_demand=1.0, profile_factors=factors)

    pd.testing.assert_series_equal(datetime_holiday_profile, date_holiday_profile)
