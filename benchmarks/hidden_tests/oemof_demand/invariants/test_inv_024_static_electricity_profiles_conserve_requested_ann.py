"""Hidden invariant test for INV-024: Static electricity profiles conserve requested annual energy.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import pandas as pd
import pytest
from oemof.demand import bdew

@pytest.mark.parametrize("year", [2011, 2012])
def test_static_electricity_preserves_requested_annual_energy(year):
    slp = bdew.ElecSlp(year, holidays=[])
    demand = {"h0": 3000.0, "g0": 5000.0, "g1": 0.0, "l0": 1200.0}
    energy = slp.get_scaled_profiles(demand)
    power = slp.get_scaled_power_profiles(demand)
    pd.testing.assert_frame_equal(power / 4, energy)
    for sector, annual in demand.items():
        assert energy[sector].notna().all()
        assert energy[sector].sum() == pytest.approx(annual)
        assert power[sector].sum() * 0.25 == pytest.approx(annual)
