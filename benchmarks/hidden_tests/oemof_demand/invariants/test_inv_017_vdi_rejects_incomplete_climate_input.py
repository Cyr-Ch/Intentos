"""Hidden invariant test for INV-017: VDI rejects incomplete climate input.

Lifted from tests/test_vdi4655.py::test_custom_weather_data_wrong_parameter by intentos review. Hidden tests run from the verification snapshot and must check behaviour
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
    def test_custom_weather_data_wrong_parameter(self, example_houses):
        test_path = Path(Path(__file__).parent, "test_data")

        # Einlesen der CSV-Daten
        energy_factors = pd.read_csv(
            Path(test_path, "energy_factors_test.csv"),
            index_col=[0, 1],
            header=[0],
        )

        temperatur_test = pd.read_csv(
            Path(test_path, "temperature_test.csv"), index_col=0
        ).squeeze()

        my_climate = Climate(
            temperature=temperatur_test,
            cloud_coverage=None,
            energy_factors=energy_factors,
        )

        with pytest.raises(
            AttributeError, match="Climate object not complete."
        ):
            Region(
                2017,
                climate=my_climate,
                resample_rule="1h",
                zero_summer_heat_demand=True,
            )
