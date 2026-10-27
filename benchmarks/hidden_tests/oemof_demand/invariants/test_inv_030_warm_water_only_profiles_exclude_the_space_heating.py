"""Hidden invariant test for INV-030: Warm-water-only profiles exclude the space-heating contribution.

Lifted from tests/test_particular_profiles.py::test_ww_only_sigmoid_parameters by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import datetime
import numpy as np
import pandas as pd
import pytest
from oemof.demand.bdew.heat_building import HeatBuilding
from oemof.demand.particular_profiles import IndustrialLoadProfile

def test_ww_only_sigmoid_parameters():
    """
    Test HeatBuilding sigmoid parameters with ww_only flag set to True
    """
    dt_index = pd.date_range(
        datetime.datetime(2010, 1, 1, 0), periods=24 * 7, freq="1h"
    )
    heat_building = HeatBuilding(
        df_index=dt_index,
        temperature=pd.Series([15] * len(dt_index)),
        annual_heat_demand=10000,
        shlp_type="EFH",
        wind_class=0,
        building_class=1,
        ww_only=True,  # Set the tested attribute
    )

    a, b, c, d = heat_building.get_sigmoid_parameters()
    assert a == 0
    assert b == 0
    assert c == 0
    assert (
        d != 0
    )  # Ensure d is not zero as it should be the only parameter used
