"""Hidden invariant test for INV-014: Non-residential heat profiles require building class zero.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import pandas as pd
import pytest
from oemof.demand.bdew import HeatBuilding

@pytest.mark.parametrize("profile_type", ["GMF", "GPD", "GHD", "GWA", "GGB", "GKO", "GBD", "GBA", "GMK", "GBH", "GGA", "GHA"])
def test_nonresidential_heat_requires_building_class_zero(profile_type):
    index = pd.date_range("2010-01-01", periods=24, freq="h")
    parameters = dict(temperature=pd.Series([10.0]*24), annual_heat_demand=10000,
                      shlp_type=profile_type, wind_class=0, holidays=[])
    HeatBuilding(index, building_class=0, **parameters)
    for building_class in [1, 11]:
        with pytest.raises(ValueError, match="Building class must be 0"):
            HeatBuilding(index, building_class=building_class, **parameters)
