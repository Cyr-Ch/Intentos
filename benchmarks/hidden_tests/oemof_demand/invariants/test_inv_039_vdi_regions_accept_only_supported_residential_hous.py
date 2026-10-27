"""Hidden invariant test for INV-039: VDI regions accept only supported residential house types.

Lifted from tests/test_vdi4655.py::test_wrong_house_type by intentos review. Hidden tests run from the verification snapshot and must check behaviour
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
    def test_wrong_house_type(self, example_houses):
        houses = example_houses + [
            {
                "N_Pers": 3,
                "name": "Wrong_heouse_type",
                "N_WE": 1,
                "Q_Heiz_a": 6000,
                "house_type": "wrong",
                "Q_TWW_a": 1500,
                "W_a": 5250,
                "summer_temperature_limit": 15,
                "winter_temperature_limit": 5,
            }
        ]
        with pytest.raises(ValueError, match="The following house"):
            Region(2017, climate=Climate().from_try_data(4), houses=houses)
