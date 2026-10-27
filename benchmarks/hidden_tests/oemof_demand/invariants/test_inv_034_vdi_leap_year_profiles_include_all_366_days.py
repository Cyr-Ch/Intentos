"""Hidden invariant test for INV-034: VDI leap-year profiles include all 366 days.

Lifted from tests/test_vdi4655.py::test_leap_year by intentos review. Hidden tests run from the verification snapshot and must check behaviour
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

@pytest.fixture
def example_holidays():
    return {
        datetime.date(2017, 1, 1): "New year",
        datetime.date(2017, 12, 25): "Christmas Day",
    }

class TestVDI4655Profiles:
    def test_leap_year(self, example_houses, example_holidays):
        """Test generation of load curves for leap year."""
        climate = Climate().from_try_data(4)
        climate.temperature = pd.concat(
            [climate.temperature, climate.temperature.iloc[[-1]]]
        )
        climate.cloud_coverage = pd.concat(
            [climate.cloud_coverage, climate.cloud_coverage.iloc[[-1]]]
        )

        region = Region(
            2024,
            climate=climate,
            houses=example_houses,
            holidays=example_holidays,
            resample_rule="1h",
        )
        load_curves = region.get_load_curve_houses()
        assert len(load_curves) == 8784  # 366 days * 24 hours
