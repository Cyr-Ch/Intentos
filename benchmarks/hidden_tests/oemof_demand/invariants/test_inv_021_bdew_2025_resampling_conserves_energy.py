"""Hidden invariant test for INV-021: BDEW 2025 resampling conserves energy.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import pandas as pd
import pytest
from oemof.demand import bdew

@pytest.mark.parametrize("profile_type", [bdew.G25, bdew.H25, bdew.L25, bdew.P25, bdew.S25])
def test_bdew25_resampling_conserves_energy(profile_type):
    quarter = pd.date_range("2010-01-01", periods=8760*4, freq="15min")
    minute = pd.date_range("2010-01-01", periods=8760*60, freq="min")
    hourly = pd.date_range("2010-01-01", periods=8760, freq="h")
    reference = profile_type(quarter, holidays=[]).sum() / 4
    assert profile_type(minute, holidays=[]).sum() / 60 == pytest.approx(reference, rel=1e-4)
    assert profile_type(hourly, holidays=[]).sum() == pytest.approx(reference, rel=1e-4)
