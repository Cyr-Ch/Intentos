"""Hidden invariant test for INV-001: Frame without holidays.

Lifted from tests/test_elec_slp.py::test_frame_without_holidays by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import datetime
import pandas as pd
import pytest
from oemof.demand import bdew

class TestElecSLP:
    @classmethod
    def setup_class(cls):
        cls.slp = bdew.ElecSlp(2010)
        cls.dt_index = pd.date_range(
            datetime.datetime(2010, 1, 1, 0), periods=8760 * 4, freq="15Min"
        )
        cls.slp_types = [
            "h0",
            "g0",
            "g1",
            "g2",
            "g3",
            "g4",
            "g5",
            "g6",
            "l0",
            "l1",
            "l2",
        ]
        cls.holidays = {
            datetime.date(2010, 5, 24): "Whit Monday",
            datetime.date(2010, 4, 5): "Easter Monday",
            datetime.date(2010, 5, 13): "Ascension Thursday",
            datetime.date(2010, 1, 1): "New year",
            datetime.date(2010, 10, 3): "Day of German Unity",
            datetime.date(2010, 12, 25): "Christmas Day",
            datetime.date(2010, 5, 1): "Labour Day",
            datetime.date(2010, 4, 2): "Good Friday",
            datetime.date(2010, 12, 26): "Second Christmas Day",
        }

    def test_frame_without_holidays(self):
        with pytest.warns(UserWarning, match="No holidays given"):
            my_frame = self.slp.create_bdew_load_profiles(
                self.dt_index, self.slp_types, holidays=None
            )
        my_frame = pd.concat(
            [my_frame, self.slp.create_dynamic_h0_profile()], axis=1
        )
        pd.testing.assert_frame_equal(self.slp.slp_frame, my_frame)
