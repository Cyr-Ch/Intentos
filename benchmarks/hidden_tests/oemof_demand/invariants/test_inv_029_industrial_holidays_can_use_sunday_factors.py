"""Hidden invariant test for INV-029: Industrial holidays can use Sunday factors.

Lifted from tests/test_particular_profiles.py::test_simple_profile_holiday_is_sunday by intentos review. Hidden tests run from the verification snapshot and must check behaviour
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

    def test_simple_profile_holiday_is_sunday(self):
        """
        test with default values and holiday_is_sunday = True

        """
        profile_factors = {
            "week": {"day": 0.6, "night": 0.5},
            "weekend": {"day": 0.7, "night": 0.4},
            "holiday": {"day": 0.8, "night": 0.3},
        }
        df = self.ilp_holiday.simple_profile(
            1.0, profile_factors=profile_factors
        )

        # check factors in self.dataframe["ind"]
        # holiday - now treated as Sunday
        assert (
            self.ilp_holiday.dataframe.at[
                pd.Timestamp("2010-01-01 6:00"), "ind"
            ]
            == 0.4
        )
        assert (
            self.ilp_holiday.dataframe.at[
                pd.Timestamp("2010-01-01 7:00"), "ind"
            ]
            == 0.7
        )
        assert (
            self.ilp_holiday.dataframe.at[
                pd.Timestamp("2010-01-01 23:00"), "ind"
            ]
            == 0.7
        )
        # weekend day
        assert (
            self.ilp_holiday.dataframe.at[
                pd.Timestamp("2010-01-02 6:00"), "ind"
            ]
            == 0.4
        )
        assert (
            self.ilp_holiday.dataframe.at[
                pd.Timestamp("2010-01-02 7:00"), "ind"
            ]
            == 0.7
        )
        assert (
            self.ilp_holiday.dataframe.at[
                pd.Timestamp("2010-01-02 23:00"), "ind"
            ]
            == 0.7
        )
        # week day
        assert (
            self.ilp_holiday.dataframe.at[
                pd.Timestamp("2010-01-04 6:00"), "ind"
            ]
            == 0.5
        )
        assert (
            self.ilp_holiday.dataframe.at[
                pd.Timestamp("2010-01-04 7:00"), "ind"
            ]
            == 0.6
        )
        assert (
            self.ilp_holiday.dataframe.at[
                pd.Timestamp("2010-01-04 23:00"), "ind"
            ]
            == 0.6
        )

        # check sum of factors to make sure not only the tested factors are
        # correct - the factors don't add up to 100 but to some number that
        # depends on the given profile factors and time steps; as long as
        # these don't change the number checked here should not change either
        assert np.isclose(self.ilp_holiday.dataframe["ind"].sum(), 98.9)
        # check total demand
        assert np.isclose(df.sum(), 1.0)
