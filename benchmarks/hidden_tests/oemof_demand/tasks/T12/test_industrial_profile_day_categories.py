"""Acceptance tests for T12, written before implementation by gpt-5.6-terra (IntentOS acceptance, thread 01a17d28-ed79-7d00-8d63-55ca4cfe8d96).

Base revision 6757f4f659, 2026-10-27T11:40:37.738Z. At that revision: test_simple_profile_rejects_overlapping_day_categories[week0-weekend0-holiday0] failed, test_simple_profile_rejects_overlapping_day_categories[week1-weekend1-holiday1] failed, test_simple_profile_rejects_overlapping_day_categories[week2-weekend2-holiday2] failed, test_simple_profile_rejects_weekday_numbers_outside_zero_to_seven[week--1] failed, test_simple_profile_rejects_weekday_numbers_outside_zero_to_seven[week-8] failed, test_simple_profile_rejects_weekday_numbers_outside_zero_to_seven[weekend--1] failed, test_simple_profile_rejects_weekday_numbers_outside_zero_to_seven[weekend-8] failed, test_simple_profile_rejects_weekday_numbers_outside_zero_to_seven[holiday--1] failed, test_simple_profile_rejects_weekday_numbers_outside_zero_to_seven[holiday-8] failed, test_simple_profile_default_day_categories_remain_usable passed.
Expectation: the requested behaviour does not exist yet; at least one test fails now and all pass once implemented.
Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.

Covers:
- Raises ValueError when week and weekend categories overlap.
- Raises ValueError when week and holiday categories overlap.
- Raises ValueError when weekend and holiday categories overlap.
- Raises ValueError for weekday numbers below 0 or above 7 in every category.
- Keeps the default day categories usable with their established relative factors.

Ticket:
    Industrial profile accepts overlapping day categories silently
    
    Calling `simple_profile` with `week=[1,2,3,4,5,6]` and `weekend=[6,7]` is accepted. Saturday then gets whichever
    factor the implementation happens to apply last, and the documentation says nothing about it.
    
    Please raise a ValueError when `week`, `weekend` and `holiday` overlap, and when a weekday number outside 0..7 is
    given. The default categories must keep working unchanged.
"""
import pandas as pd
import pytest

from oemof.demand.particular_profiles import IndustrialLoadProfile


def _profile():
    return IndustrialLoadProfile(
        pd.date_range("2010-01-01", periods=24 * 7, freq="h")
    )


@pytest.mark.parametrize(
    ("week", "weekend", "holiday"),
    [
        ([1, 2, 3, 4, 5, 6], [6, 7], [0]),
        ([1, 2, 3, 4, 5], [6, 7], [5]),
        ([1, 2, 3, 4, 5], [6, 7], [7]),
    ],
)
def test_simple_profile_rejects_overlapping_day_categories(
    week, weekend, holiday
):
    with pytest.raises(ValueError):
        _profile().simple_profile(
            1.0, week=week, weekend=weekend, holiday=holiday
        )


@pytest.mark.parametrize(
    ("category", "invalid_weekday"),
    [
        ("week", -1),
        ("week", 8),
        ("weekend", -1),
        ("weekend", 8),
        ("holiday", -1),
        ("holiday", 8),
    ],
)
def test_simple_profile_rejects_weekday_numbers_outside_zero_to_seven(
    category, invalid_weekday
):
    categories = {
        "week": [1, 2, 3, 4, 5],
        "weekend": [6, 7],
        "holiday": [0],
    }
    categories[category] = [invalid_weekday]

    with pytest.raises(ValueError):
        _profile().simple_profile(1.0, **categories)


def test_simple_profile_default_day_categories_remain_usable():
    profile = _profile().simple_profile(1.0)

    assert profile.sum() == pytest.approx(1.0)
    assert profile.loc["2010-01-02 07:00"] / profile.loc[
        "2010-01-04 07:00"
    ] == pytest.approx(0.9 / 0.8)
