"""Hidden invariant test for INV-001: Warning without holidays.

Lifted from tests/test_tools.py::test_warning_without_holidays by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import datetime
import warnings
import pandas as pd
import pytest
from oemof.demand import tools

class TestWeekdays:
    @classmethod
    def setup_class(cls):
        dt_index = pd.date_range(
            datetime.datetime(2010, 1, 1, 0), periods=8760 * 4, freq="15min"
        )
        cls.df = pd.DataFrame(index=dt_index)
        cls.holidays = {
            datetime.date(2010, 1, 1): "New year",
            datetime.date(2010, 12, 25): "Christmas Day",
        }

    def test_warning_without_holidays(self):
        with pytest.warns(UserWarning, match="No holidays given"):
            dt = tools.add_weekdays2df(self.df)
        assert (dt["weekday"] == 0).sum() == 0
