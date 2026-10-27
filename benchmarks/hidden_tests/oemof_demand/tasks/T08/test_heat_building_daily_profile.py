"""Acceptance tests for T08, written before implementation by gpt-5.6-terra (IntentOS acceptance, thread 01a17d25-2602-7ad0-9140-b7a9529f4547).

Base revision 6757f4f659, 2026-10-27T11:36:32.826Z. At that revision: test_daily_profile_is_calendar_day_sum_of_hourly_bdew_profile failed.
Expectation: the requested behaviour does not exist yet; at least one test fails now and all pass once implemented.
Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.

Covers:
- HeatBuilding exposes a daily profile with exactly one value for every calendar day, including leap day.
- Daily values are sums of the hourly BDEW heat profile (not means), preserving the hourly profile's unit.
- The daily profile sums to the configured annual heat demand.

Ticket:
    Daily heat demand from HeatBuilding
    
    For reporting I need the BDEW heat profile aggregated per day. Today I call `get_bdew_profile()` and resample
    myself, and colleagues keep doing it differently (sum vs mean).
    
    Please add a daily accessor on `HeatBuilding` that returns one value per calendar day, in the same unit as the
    hourly profile, so the daily values add up to the annual heat demand.
"""
import numpy as np
import pandas as pd

from oemof.demand.bdew.heat_building import HeatBuilding


def test_daily_profile_is_calendar_day_sum_of_hourly_bdew_profile():
    index = pd.date_range(
        "2012-01-01 00:00", "2012-12-31 23:00", freq="1h"
    )
    annual_heat_demand = 12345.67
    heat_building = HeatBuilding(
        df_index=index,
        temperature=pd.Series(12.0, index=index),
        annual_heat_demand=annual_heat_demand,
        shlp_type="EFH",
        wind_class=0,
        building_class=1,
    )

    daily_profile = heat_building.get_daily_profile()
    hourly_profile = heat_building.get_bdew_profile()

    expected_daily_profile = hourly_profile.resample("D").sum()
    pd.testing.assert_series_equal(daily_profile, expected_daily_profile)
    assert len(daily_profile) == 366
    assert daily_profile.index.equals(pd.date_range("2012-01-01", periods=366, freq="D"))
    assert np.isclose(daily_profile.sum(), annual_heat_demand)
