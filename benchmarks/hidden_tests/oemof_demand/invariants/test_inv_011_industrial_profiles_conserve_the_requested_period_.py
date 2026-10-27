"""Hidden invariant test for INV-011: Industrial profiles conserve the requested period demand.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import pandas as pd
import pytest
from oemof.demand.particular_profiles import IndustrialLoadProfile

@pytest.mark.parametrize("frequency, steps, hours", [("h", 168, 1), ("15min", 672, 0.25)])
@pytest.mark.parametrize("demand", [0.0, 1.0, 12345.0])
def test_industrial_profiles_conserve_period_demand(frequency, steps, hours, demand):
    index = pd.date_range("2010-01-01", periods=steps, freq=frequency)
    profile = IndustrialLoadProfile(index, holidays=[]).simple_profile(demand)
    assert profile.index.equals(index)
    assert profile.notna().all()
    assert profile.sum() * hours == pytest.approx(demand)
