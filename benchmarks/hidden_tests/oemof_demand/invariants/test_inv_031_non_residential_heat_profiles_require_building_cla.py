"""Hidden invariant test for INV-031: Non-residential heat profiles require building class zero.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import pandas as pd
import pytest
from oemof.demand import bdew

@pytest.mark.parametrize("profile_type", ["GHD", "GHA", "GMK"])
@pytest.mark.parametrize("building_class", [-1, 1, 11])
def test_nonresidential_heat_rejects_nonzero_building_class(profile_type, building_class):
    index = pd.date_range("2010-01-01", periods=24, freq="h")
    with pytest.raises(ValueError, match="Building class must be 0"):
        bdew.HeatBuilding(
            index, temperature=pd.Series(10.0, index=index),
            annual_heat_demand=1000, shlp_type=profile_type,
            wind_class=0, building_class=building_class, holidays=[],
        )
