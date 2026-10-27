"""Hidden invariant test for INV-037: Summer heating suppression removes summer space-heating demand.

Lifted from tests/test_vdi4655.py::test_zero_summer_heat_demand by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import datetime
import os
import sys
from pathlib import Path
import pandas as pd
import pytest
from oemof import demand
from oemof.demand.vdi import Climate
from oemof.demand.vdi.regions import Region

@pytest.fixture
def example_houses():
    return [
        {
            "N_Pers": 3,
            "name": "EFH_1",
            "N_WE": 1,
            "Q_Heiz_a": 6000,
            "house_type": "EFH",
            "Q_TWW_a": 1500,
            "W_a": 5250,
            "summer_temperature_limit": 15,
            "winter_temperature_limit": 5,
        },
        {
            "N_Pers": 45,
            "name": "MFH_1",
            "N_WE": 15,
            "Q_Heiz_a": 60000,
            "house_type": "MFH",
            "Q_TWW_a": 15000,
            "W_a": 45000,
            "summer_temperature_limit": 14,
            "winter_temperature_limit": 4,
        },
    ]

class TestVDI4655Profiles:
    def test_zero_summer_heat_demand(self, example_houses):
        """Test zero summer heat demand option."""
        region = Region(
            2017,
            Climate().from_try_data(4),
            houses=example_houses,
            resample_rule="1h",
            zero_summer_heat_demand=True,
        )
        load_curves = region.get_load_curve_houses()

        # Verify that summer heat demand is zero
        # (This would need more specific checks based on actual summer days)
        assert isinstance(load_curves, pd.DataFrame)
        assert not load_curves.empty
        assert (
            load_curves.loc[
                "2017-06-02 12:00", (slice(None), slice(None), "Q_Heiz_TT")
            ].sum()
            == 0
        )
