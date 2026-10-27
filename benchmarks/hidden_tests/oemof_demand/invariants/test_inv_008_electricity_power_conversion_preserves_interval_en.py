"""Hidden invariant test for INV-008: Electricity power conversion preserves interval energy.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import pandas as pd
import pytest
from oemof.demand import bdew

def test_electricity_power_conversion_preserves_interval_energy():
    slp = bdew.ElecSlp(2010, holidays=[])
    demands = {"h0": 3000, "g0": 5000}
    energy = slp.get_scaled_profiles(demands)
    power = slp.get_scaled_power_profiles(demands)
    pd.testing.assert_frame_equal(power, energy * 4)
    for name, demand in demands.items():
        assert power[name].sum() / 4 == pytest.approx(demand)
    pd.testing.assert_frame_equal(
        slp.get_scaled_power_profiles(demands, conversion_factor=2),
        energy * 2)
