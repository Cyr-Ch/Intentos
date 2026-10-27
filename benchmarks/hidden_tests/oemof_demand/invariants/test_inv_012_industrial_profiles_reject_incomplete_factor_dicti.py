"""Hidden invariant test for INV-012: Industrial profiles reject incomplete factor dictionaries.

Lifted from tests/test_particular_profiles.py::test_simple_profile_error_raising by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import datetime
import numpy as np
import pandas as pd
import pytest
from oemof.demand.bdew.heat_building import HeatBuilding
from oemof.demand.particular_profiles import IndustrialLoadProfile

class TestIndustrialLoadProfile:
    @classmethod
    def setup_class(cls):
        dt_index = pd.date_range(
            datetime.datetime(2010, 1, 1, 0), periods=24 * 7, freq="1h"
        )
        holidays = {
            datetime.date(2010, 1, 1): "New year",
        }
        cls.ilp = IndustrialLoadProfile(
            dt_index=dt_index,
            holidays=holidays,
            holiday_is_sunday=False,
        )
        cls.ilp_holiday = IndustrialLoadProfile(
            dt_index=dt_index,
            holidays=holidays,
            holiday_is_sunday=True,
        )

    def test_simple_profile_error_raising(self):
        """
        test error raising in case of missing profile factors

        """
        profile_factors = {
            "week": {"day": 0.6, "night": 0.5},
        }
        msg = "Missing entry for 'weekend' in profile_factors."
        with pytest.raises(ValueError, match=msg):
            self.ilp.simple_profile(
                1.0,
                profile_factors=profile_factors,
            )

        profile_factors = {
            "week": {"day": 0.6},
        }
        msg = "Missing entry for 'night' in profile_factors for 'week'."
        with pytest.raises(ValueError, match=msg):
            self.ilp.simple_profile(
                1.0,
                profile_factors=profile_factors,
            )
