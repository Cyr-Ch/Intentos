"""Acceptance tests for T01, written before implementation by gpt-5.6-terra (IntentOS acceptance, thread 01a17d20-3079-71a2-8098-7079d52e6a92).

Base revision 6757f4f659, 2026-10-27T11:31:47.860Z. At that revision: test_simple_profile_uses_night_factor_for_inclusive_lunch_break_on_workdays failed, test_simple_profile_without_a_break_keeps_the_existing_workday_shape passed.
Expectation: the requested behaviour does not exist yet; at least one test fails now and all pass once implemented.
Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.

Covers:
- A workday lunch-break window applies the workday night factor at both inclusive break boundaries and restores the day factor after the break.
- A configured lunch break does not alter weekend daytime factors.
- The resulting hourly profile remains normalized to the supplied annual demand.
- Calling simple_profile without a break preserves the existing uninterrupted workday behaviour and demand normalization.

Ticket:
    Industrial profile: model a lunch break with night factors
    
    Our plants stop between 12:00 and 13:00. `IndustrialLoadProfile.simple_profile` only knows a workday from `am`
    to `pm`, so the break hour gets the "day" factor and the profile is too high around noon.
    
    Could `simple_profile` take an optional break window (start and end time, like `am`/`pm`) during which the
    "night" factors apply on workdays? Nothing should change when no break is given, and the result should still
    integrate to the `annual_demand` I pass in, as it does today.
"""
import datetime

import numpy as np
import pandas as pd
import pytest

from oemof.demand.particular_profiles import IndustrialLoadProfile


def test_simple_profile_uses_night_factor_for_inclusive_lunch_break_on_workdays():
    index = pd.date_range("2024-01-01", periods=24 * 6, freq="1h")
    factors = {
        "week": {"day": 1.0, "night": 0.2},
        "weekend": {"day": 0.7, "night": 0.1},
        "holiday": {"day": 0.5, "night": 0.05},
    }

    profile = IndustrialLoadProfile(index).simple_profile(
        annual_demand=720.0,
        am=datetime.time(7),
        pm=datetime.time(23),
        break_start=datetime.time(12),
        break_end=datetime.time(13),
        profile_factors=factors,
    )

    # 12:00 and 13:00 are the break boundaries, just as am and pm are
    # inclusive boundaries for the normal workday.
    assert profile.loc["2024-01-01 12:00"] == pytest.approx(
        profile.loc["2024-01-01 11:00"] * 0.2
    )
    assert profile.loc["2024-01-01 13:00"] == pytest.approx(
        profile.loc["2024-01-01 11:00"] * 0.2
    )
    assert profile.loc["2024-01-01 14:00"] == pytest.approx(
        profile.loc["2024-01-01 11:00"]
    )

    # The break is a workday rule; it must not change the weekend day factor.
    assert profile.loc["2024-01-06 12:00"] == pytest.approx(
        profile.loc["2024-01-06 11:00"]
    )
    assert np.isclose(profile.sum(), 720.0)


def test_simple_profile_without_a_break_keeps_the_existing_workday_shape():
    index = pd.date_range("2024-01-01", periods=24, freq="1h")
    factors = {
        "week": {"day": 1.0, "night": 0.2},
        "weekend": {"day": 0.7, "night": 0.1},
        "holiday": {"day": 0.5, "night": 0.05},
    }

    profile = IndustrialLoadProfile(index).simple_profile(
        annual_demand=240.0,
        am=datetime.time(7),
        pm=datetime.time(23),
        profile_factors=factors,
    )

    assert profile.loc["2024-01-01 12:00"] == pytest.approx(
        profile.loc["2024-01-01 11:00"]
    )
    assert np.isclose(profile.sum(), 240.0)
