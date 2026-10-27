"""Hidden invariant test for INV-001: No warning with empty holidays.

Lifted from tests/test_tools.py::test_no_warning_with_empty_holidays by intentos review. Hidden tests run from the verification snapshot and must check behaviour
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

    def test_no_warning_with_empty_holidays(self):
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            dt = tools.add_weekdays2df(self.df, holidays=[])
        assert (dt["weekday"] == 0).sum() == 0
