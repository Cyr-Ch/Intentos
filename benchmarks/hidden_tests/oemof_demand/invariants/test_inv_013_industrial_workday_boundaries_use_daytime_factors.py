"""Hidden invariant test for INV-013: Industrial workday boundaries use daytime factors.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import datetime
import pandas as pd
import pytest
from oemof.demand.particular_profiles import IndustrialLoadProfile

def test_industrial_workday_boundaries_use_day_factors():
    index = pd.date_range("2010-01-04", periods=96, freq="15min")
    factors = {category: {"day": 2.0, "night": 1.0}
               for category in ["week", "weekend", "holiday"]}
    profile = IndustrialLoadProfile(index, holidays=[]).simple_profile(
        1000, profile_factors=factors,
        am=datetime.time(7, 0), pm=datetime.time(22, 0))
    night = profile.loc["2010-01-04 06:45"]
    assert night > 0
    for stamp in ["2010-01-04 07:00", "2010-01-04 22:00"]:
        assert profile.loc[stamp] == pytest.approx(2 * night)
    assert profile.loc["2010-01-04 22:15"] == pytest.approx(night)
