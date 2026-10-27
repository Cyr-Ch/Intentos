"""Hidden invariant test for INV-007: Static electricity profiles conserve annual demand.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import pandas as pd
import pytest
from oemof.demand import bdew

@pytest.mark.parametrize("year", [2010, 2012])
def test_static_electricity_profiles_conserve_annual_energy(year):
    slp = bdew.ElecSlp(year, holidays=[])
    demands = {name: 1000.0 + i * 100 for i, name in enumerate(
        ["h0", "g0", "g1", "g2", "g3", "g4", "g5", "g6", "l0", "l1", "l2"])}
    profile = slp.get_scaled_profiles(demands)
    assert set(profile.columns) == set(demands)
    assert profile.notna().all().all()
    for name, demand in demands.items():
        assert profile[name].sum() == pytest.approx(demand, rel=1e-10)
