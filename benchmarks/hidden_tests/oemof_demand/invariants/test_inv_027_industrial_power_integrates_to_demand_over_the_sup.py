"""Hidden invariant test for INV-027: Industrial power integrates to demand over the supplied period.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import pandas as pd
import pytest
from oemof.demand.particular_profiles import IndustrialLoadProfile

@pytest.mark.parametrize("minutes", [15, 60])
@pytest.mark.parametrize("total", [0.0, 1234.5])
def test_industrial_power_integrates_to_period_demand(minutes, total):
    index = pd.date_range("2010-01-01", periods=7 * 24 * 60 // minutes, freq=f"{minutes}min")
    profile = IndustrialLoadProfile(index, holidays=[]).simple_profile(total)
    assert profile.index.equals(index)
    assert profile.notna().all()
    assert profile.sum() * minutes / 60 == pytest.approx(total)
