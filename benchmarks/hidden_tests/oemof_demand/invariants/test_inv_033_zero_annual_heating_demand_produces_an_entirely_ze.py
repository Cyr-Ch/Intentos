"""Hidden invariant test for INV-033: Zero annual heating demand produces an entirely zero curve.

Lifted from tests/test_vdi4655.py::test_energy_demand_zero_sum by intentos review. Hidden tests run from the verification snapshot and must check behaviour
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
    def test_energy_demand_zero_sum(self, example_houses):
        """Test handling of zero sum energy demands."""
        houses = example_houses.copy()
        houses[0]["Q_Heiz_a"] = 0  # Set heating demand to zero

        region = Region(2017, Climate().from_try_data(4), houses=houses)
        load_curves = region.get_load_curve_houses()

        # Zero annual demand should result in zero load curve
        assert (load_curves.loc[:, ("EFH_1", "EFH", "Q_Heiz_TT")] == 0).all()
